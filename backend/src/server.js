import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { log } from './log.js';
import { db, store } from './db.js';
import { assertSafeUrl, safeGet } from './urlSafety.js';
import { enqueue, eventsFor, subscribe, queueDepth, recoverOrphans } from './queue.js';
import { sessionStatus } from './collectors/instagram.js';
import { geminiEnabled } from './vision/gemini.js';
import { isUrl } from './product.js';

const SearchBody = z
  .object({
    input: z.string().trim().max(2000).default(''),
    imageBase64: z.string().max(12_000_000).optional(),
    options: z
      .object({
        showSeen: z.boolean().optional(),
        tiktok: z.boolean().default(false), // optional bonus source, off unless the user ticks it
        threshold: z.number().min(0).max(100).optional(),
      })
      .optional(),
  })
  .refine((b) => b.input.length >= 2 || b.imageBase64, 'Enter a product name or URL, or upload a product image');

const parseJson = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

function serializeVideo(r) {
  return {
    uid: r.uid, platform: r.platform, url: r.url, mediaUrl: r.media_url, thumb: r.thumb, caption: r.caption,
    author: r.author, postedAt: r.posted_at, score: Math.round(r.score ?? 0), clip: r.clip, vlm: r.vlm, reason: r.reason,
    below: Boolean(r.below), seenBefore: Boolean(r.seen_before), query: r.matched_query, starred: Boolean(r.starred),
  };
}

function serializeSearch(s, withResults = true) {
  const out = {
    id: s.id, input: s.input, type: s.input_type, status: s.status, error: s.error,
    createdAt: s.created_at, finishedAt: s.finished_at, product: parseJson(s.product), stats: parseJson(s.stats),
    options: parseJson(s.options),
  };
  if (withResults) out.results = store.results(s.id).map(serializeVideo);
  else out.count = s.n;
  return out;
}

// ---- network + API security --------------------------------------------------------------
// Threat: any web page in the user's browser can send requests to localhost, and a rebound DNS
// name can make a hostile site look same-origin. CORS only controls who may *read* responses,
// so state-changing requests are checked server-side (Origin / Sec-Fetch-Site / token).
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const normOrigin = (o) => {
  try {
    const u = new URL(o);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
};

// "localhost:4000" -> { name: 'localhost', port: '4000' }; "[::1]" -> { name: '[::1]' }
const parseHost = (h) => {
  const m = /^(\[[0-9a-f:.]+\]|[^:[\]\s]+)(?::(\d{1,5}))?$/i.exec(String(h || '').trim());
  return m ? { name: m[1].toLowerCase(), port: m[2] } : null;
};

// sha256 both sides so timingSafeEqual always gets equal lengths and the token length doesn't leak
const sameSecret = (a, b) =>
  crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());

export function securityPolicy({ allowedOrigins = config.allowedOrigins, allowedHosts = config.allowedHosts, apiToken = config.apiToken } = {}) {
  const origins = new Set(allowedOrigins.map(normOrigin).filter(Boolean));
  const hosts = allowedHosts.map(parseHost).filter(Boolean);
  const hostAllowed = (h) => {
    const p = parseHost(h);
    return Boolean(p) && hosts.some((a) => a.name === p.name && (!a.port || a.port === p.port));
  };
  const originAllowed = (o) => origins.has(normOrigin(o));

  // DNS-rebinding guard: the browser sends the attacker's hostname in Host even after rebinding.
  // Applied to every route (not only /api) so a rebound page can't read a bundle with VITE_API_TOKEN.
  const hostGuard = (req, res, next) =>
    hostAllowed(req.headers.host) ? next() : res.status(421).json({ error: 'Host not allowed' });

  // no ACAO header at all for untrusted origins; x-api-token is reflected via allowedHeaders default
  const corsMw = cors({ origin: (o, cb) => cb(null, Boolean(o) && originAllowed(o)) });

  const writeGuard = (req, res, next) => {
    if (!STATE_CHANGING.has(req.method)) return next();
    const origin = req.headers.origin;
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (origin !== undefined) {
      if (!originAllowed(origin)) return res.status(403).json({ error: 'Origin not allowed' });
    } else if (site === 'cross-site' || site === 'same-site') {
      // browsers always send Origin on POST/DELETE; a cross/same-site request without it can't be verified
      return res.status(403).json({ error: 'Cross-site request rejected' });
    }
    // no Origin and no/same-origin/none Sec-Fetch-Site = CLI tools (scripts/evaluate.js, curl) or direct navigation
    if (apiToken) {
      const got = req.headers['x-api-token'];
      if (typeof got !== 'string' || !got) return res.status(401).json({ error: 'API token required' });
      if (!sameSecret(got, apiToken)) return res.status(403).json({ error: 'Invalid API token' });
    }
    next();
  };

  return { hostGuard, corsMw, writeGuard, hostAllowed, originAllowed };
}

// Builds the Express app without listening or touching queued jobs (importable by tests).
export function createApp(opts = {}) {
  const sec = securityPolicy(opts);
  const app = express();
  app.disable('x-powered-by');
  // logs method/path/status only, never headers (x-api-token, cookies)
  app.use((req, res, next) => {
    const t = Date.now();
    res.on('finish', () => log.info({ method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - t }, 'req'));
    next();
  });
  app.use(sec.hostGuard);
  app.use(sec.corsMw);
  app.use(sec.writeGuard); // before the body parser so rejected requests aren't parsed
  app.use(express.json({ limit: '12mb' }));

  app.get('/api/health', (_req, res) =>
    res.json({ ok: true, vision: { gemini: geminiEnabled(), model: geminiEnabled() ? config.geminiModel : null, clip: config.clipModel },
      instagram: sessionStatus(), queue: queueDepth(), threshold: config.matchThreshold, target: config.perSourceTarget }),
  );

  app.post('/api/search', (req, res) => {
    const parsed = SearchBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues.map((i) => i.message) });
    const { input, imageBase64, options } = parsed.data;
    if (isUrl(input)) {
      try {
        assertSafeUrl(input);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }
    if (!input && !geminiEnabled()) {
      return res.status(400).json({ error: 'Image-only search needs GEMINI_API_KEY. Add a product name or link next to the image.' });
    }
    const id = crypto.randomUUID();
    store.createSearch(id, input || 'Image search', !input ? 'image' : isUrl(input) ? 'url' : 'keyword', options);
    enqueue(id, { input, imageBase64, options });
    res.status(202).json({ id });
  });

  app.get('/api/search/:id', (req, res) => {
    const s = store.getSearch(req.params.id);
    if (!s) return res.status(404).json({ error: 'Search not found' });
    res.json(serializeSearch(s));
  });

  // Server-Sent Events: replays buffered progress then streams live until the search finishes.
  app.get('/api/search/:id/events', (req, res) => {
    const s = store.getSearch(req.params.id);
    if (!s) return res.status(404).json({ error: 'Search not found' });
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders();
    const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const past = eventsFor(s.id);
    past.forEach(send);
    const finished = () => {
      const cur = store.getSearch(s.id);
      return cur && ['done', 'error', 'needs_hint'].includes(cur.status);
    };
    if (finished() && past.some((e) => e.stage === 'done')) return res.end();
    if (finished()) {
      send({ t: Date.now(), stage: 'done', status: s.status, message: s.error || 'Search complete' });
      return res.end();
    }
    const unsub = subscribe(s.id, (ev) => {
      send(ev);
      if (ev.stage === 'done') {
        unsub();
        res.end();
      }
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      unsub();
    });
  });

  app.get('/api/history', (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    res.json(store.history(limit).map((s) => serializeSearch(s, false)));
  });

  app.post('/api/videos/:uid/star', (req, res) => {
    store.star(req.params.uid);
    res.json({ ok: true });
  });
  app.delete('/api/videos/:uid/star', (req, res) => {
    store.unstar(req.params.uid);
    res.json({ ok: true });
  });

  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  app.get('/api/shortlist.csv', (_req, res) => {
    const rows = store.shortlist();
    const head = ['platform', 'url', 'author', 'caption', 'thumbnail'];
    const body = rows.map((r) => [r.platform, r.url, r.author, r.caption, r.thumb].map(csvCell).join(','));
    res.set({ 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="shortlist.csv"' });
    res.send([head.join(','), ...body].join('\n'));
  });
  app.get('/api/shortlist', (_req, res) => res.json(store.shortlist().map(serializeVideo)));

  // Thumbnail proxy: CDN URLs reject cross-site referrers and expire; only Meta/Instagram (and TikTok) CDNs are allowed.
  const IMG_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net|facebook\.com|fbsbx\.com|tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com)$/i;
  app.get('/api/img', async (req, res) => {
    try {
      const u = assertSafeUrl(String(req.query.u || ''));
      if (!IMG_HOSTS.test(u.hostname)) return res.status(400).json({ error: 'Host not allowed' });
      const { body, contentType } = await safeGet(u.toString(), { timeoutMs: 10000, maxBytes: 4_000_000 });
      if (!contentType.startsWith('image/')) return res.status(415).json({ error: 'Not an image' });
      res.set({ 'content-type': contentType, 'cache-control': 'public, max-age=3600' }).send(body);
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

  // Serve the built frontend when present (single-container / one-command deployment)
  const dist = path.resolve(config.root, '..', 'frontend', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err, _req, res, _next) => {
    log.error({ err }, 'unhandled');
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
  });
  return app;
}

export function startServer() {
  const server = createApp().listen(config.port, config.host, () => {
    // only the instance that owns the port may fail stale jobs; a second copy must not touch them
    recoverOrphans(db);
    log.info({ host: config.host, port: config.port, gemini: geminiEnabled(), instagram: sessionStatus().method, apiToken: Boolean(config.apiToken) }, 'backend listening');
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log.error(`Port ${config.port} is already in use: the backend is probably already running. Stop it first or set PORT.`);
      process.exit(1);
    }
    throw e;
  });
  return server;
}

// listen only when run directly (`node src/server.js`), not when imported by tests
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const self = fileURLToPath(import.meta.url);
if (process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self) startServer();
