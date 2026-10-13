import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../log.js';
import { store } from '../db.js';
import { canonicalUid, textKey } from '../dedupe.js';
import { SourceError, sleep, jitter } from '../util.js';
import { newInstagramContext, walk } from './browser.js';

/**
 * Pulls Reel-shaped media out of any Instagram JSON payload (private web API `/api/v1/*` and `graphql` responses).
 * Handles both the "v1" shape (code, video_versions, image_versions2) and the legacy GraphQL shape
 * (shortcode, is_video, video_url, display_url).
 */
export function extractIgMedia(json) {
  return walk(json, (o) => {
    const code = typeof o.code === 'string' ? o.code : typeof o.shortcode === 'string' ? o.shortcode : null;
    if (!code || !/^[\w-]{5,20}$/.test(code)) return null;
    const isV1Video = Array.isArray(o.video_versions) || o.media_type === 2 || o.product_type === 'clips';
    const isLegacyVideo = o.is_video === true || typeof o.video_url === 'string';
    if (!isV1Video && !isLegacyVideo) return null;
    const isReel = o.product_type === 'clips' || o.product_type === 'reels' || o.media_type === 2 || isLegacyVideo;
    if (!isReel) return null;

    const caption =
      o.caption?.text ?? o.edge_media_to_caption?.edges?.[0]?.node?.text ?? (typeof o.caption === 'string' ? o.caption : '');
    const thumb = o.image_versions2?.candidates?.[0]?.url ?? o.display_url ?? o.thumbnail_src ?? o.thumbnail_url ?? null;
    const mediaUrl = o.video_versions?.[0]?.url ?? o.video_url ?? null;
    const author = o.user?.username ?? o.owner?.username ?? '';
    const taken = o.taken_at ?? o.taken_at_timestamp ?? null;
    if (!thumb) return null;
    return {
      platform: 'instagram',
      videoId: String(o.pk ?? o.id ?? code),
      uid: canonicalUid('instagram', code),
      url: `https://www.instagram.com/reel/${code}/`,
      mediaUrl,
      thumb,
      caption: caption || '',
      author,
      postedAt: taken ? Number(taken) * 1000 : null,
      textKey: textKey(author, caption || ''),
      views: o.play_count ?? o.video_view_count ?? o.view_count ?? null,
    };
  });
}

/* ---------- politeness: one navigation at a time, spaced out, with a daily cap ---------- */
let gate = Promise.resolve();
let lastNav = 0;
const dayKey = () => `ig:pages:${new Date().toISOString().slice(0, 10)}`;

function takeTurn(fn) {
  const run = gate.then(async () => {
    const used = store.cacheGet(dayKey())?.n ?? 0;
    if (used >= config.igDailyPageCap) {
      throw new SourceError(`Daily Instagram page cap reached (${config.igDailyPageCap}). Raise IG_DAILY_PAGE_CAP or wait until tomorrow.`, {
        code: 'IG_CAP', fatal: true,
      });
    }
    store.cacheSet(dayKey(), { n: used + 1 });
    const wait = lastNav + jitter(config.igMinDelayMs) - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastNav = Date.now();
    }
  });
  gate = run.catch(() => {});
  return run;
}

// /explore/tags/<tag>/ now redirects to keyword search for "#tag", so both go straight there.
const urlFor = (q) =>
  `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q.type === 'hashtag' ? `#${q.value}` : q.value)}`;

/** GraphQL bodies are often served as text/javascript, may carry a for(;;); guard and hold several documents. */
export function parseBodies(text) {
  const out = [];
  for (const line of String(text).replace(/^for \(;;\);/, '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* partial chunk */
    }
  }
  return out;
}

/**
 * Only harvest search/explore/hashtag results. The same page also loads the user's home feed,
 * stories and suggestions (e.g. PolarisFeedTimelineRootV2Query), which are unrelated to the query.
 */
const SEARCH_OPS = /Search|Hashtag|Explore|Clips|Reels/i;
const NOISE_OPS = /Feed|Timeline|Stories|Story|Badge|Chat|Notification|Inbox|Suggest/i;
export function isSearchOperation(friendlyName, url = '') {
  if (/\/api\/v1\/(fbsearch|tags|clips|discover)\//.test(url)) return true;
  if (!friendlyName) return false;
  return SEARCH_OPS.test(friendlyName) && !NOISE_OPS.test(friendlyName);
}

function isSearchResponse(res) {
  const req = res.request();
  const post = req.postData() || '';
  const name = post.match(/fb_api_req_friendly_name=([^&]+)/)?.[1] || req.headers()['x-fb-friendly-name'] || '';
  return isSearchOperation(decodeURIComponent(name), res.url());
}

const isAuthWall = (page) => /\/accounts\/login|\/challenge|\/accounts\/suspended/.test(page.url());

export function sessionStatus() {
  return {
    configured: fs.existsSync(config.igStatePath) || Boolean(config.igSessionId),
    method: fs.existsSync(config.igStatePath) ? 'saved-login' : config.igSessionId ? 'session-id' : 'none',
    pagesUsedToday: store.cacheGet(dayKey())?.n ?? 0,
    dailyCap: config.igDailyPageCap,
  };
}

/* ---------- primary: same-origin XHR to the web search API inside one long-lived logged-in page ---------- */
const IG_APP_ID = '936619743392459'; // public id of the instagram.com web client
let live; // { ctx, page }

async function sessionPage() {
  if (live && !live.page.isClosed()) return live.page;
  const ctx = await newInstagramContext();
  const page = await ctx.newPage();
  // a lightweight logged-in page: gives us a same-origin document carrying the session cookies
  await page.goto('https://www.instagram.com/accounts/edit/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (isAuthWall(page)) {
    await ctx.close().catch(() => {});
    throw new SourceError('Instagram session expired or challenged. Re-run `npm run ig:login`.', { code: 'IG_AUTH', fatal: true });
  }
  live = { ctx, page };
  return page;
}

export async function closeInstagramSession() {
  if (!live) return;
  if (fs.existsSync(config.igStatePath)) await live.ctx.storageState({ path: config.igStatePath }).catch(() => {});
  await live.ctx.close().catch(() => {});
  live = undefined;
}

async function apiGet(page, path, params) {
  const r = await page.evaluate(
    async ({ path, params, appId }) => {
      const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
      const res = await fetch(`${path}?${new URLSearchParams(params)}`, {
        credentials: 'include',
        headers: { 'x-ig-app-id': appId, 'x-csrftoken': csrf, 'x-requested-with': 'XMLHttpRequest' },
      });
      return { status: res.status, text: await res.text() };
    },
    { path, params, appId: IG_APP_ID },
  );
  let json = null;
  try {
    json = JSON.parse(r.text);
  } catch {
    /* html / empty */
  }
  if (r.status === 401 || r.status === 403 || /login_required|checkpoint_required|challenge_required/.test(json?.message || '')) {
    throw new SourceError(`Instagram rejected the session (${json?.message || r.status}). Re-run \`npm run ig:login\`.`, {
      code: 'IG_AUTH', fatal: true,
    });
  }
  if (r.status === 429 || /wait a few minutes|rate/i.test(json?.message || '')) {
    throw new SourceError('Instagram is rate-limiting this account; slowing down', { code: 'IG_RATE' });
  }
  if (r.status !== 200 || !json) {
    throw new SourceError(`Instagram API ${path} returned ${r.status}${json ? '' : ' (not JSON)'}`, { code: 'IG_API_CHANGED' });
  }
  return json;
}

/** Paginated top_serp search. Each page is its own paced, capped turn. */
async function xhrSearch(query, limit) {
  const q = query.type === 'hashtag' ? `#${query.value}` : query.value;
  const found = new Map();
  let cursor = null;
  let rankToken = null;
  const maxPages = Math.min(6, Math.ceil(limit / 15) + 1);
  for (let p = 0; p < maxPages && found.size < limit; p++) {
    const json = await takeTurn(async () => {
      const page = await sessionPage();
      const params = { enable_metadata: 'true', query: q, search_session_id: '' };
      if (cursor) params.next_max_id = cursor;
      if (rankToken) params.rank_token = rankToken;
      return apiGet(page, '/api/v1/fbsearch/web/top_serp/', params);
    });
    for (const m of extractIgMedia(json)) if (!found.has(m.uid)) found.set(m.uid, { ...m, query: query.label });
    rankToken = json.rank_token ?? rankToken;
    cursor = json.media_grid?.next_max_id ?? json.next_max_id ?? null;
    if (!cursor || json.media_grid?.has_more === false) break;
  }
  log.info({ query: query.label, found: found.size, mode: 'xhr' }, 'instagram search harvested');
  return [...found.values()];
}

export const instagramCollector = {
  platform: 'instagram',

  /** XHR search first (fast, no rendering); if Instagram changes that endpoint, fall back to browsing the page. */
  async search(query, { limit = 40 } = {}) {
    if (!sessionStatus().configured) {
      throw new SourceError('No Instagram session. Run `npm run ig:login` in backend/ (or set IG_SESSION_ID).', {
        code: 'IG_NO_SESSION', fatal: true,
      });
    }
    try {
      return await xhrSearch(query, limit);
    } catch (e) {
      if (e.code !== 'IG_API_CHANGED') throw e;
      log.warn({ err: e.message }, 'instagram xhr search unavailable, falling back to page browsing');
      return browseSearch(query, limit);
    }
  },
};

/** Fallback: open the keyword search page, scroll, and harvest the GraphQL search responses the page receives. */
async function browseSearch(query, limit) {
    return takeTurn(async () => {
      const ctx = await newInstagramContext();
      const page = await ctx.newPage();
      const found = new Map();
      const ingest = (json) => {
        for (const m of extractIgMedia(json)) if (!found.has(m.uid)) found.set(m.uid, { ...m, query: query.label });
      };
      page.on('response', async (res) => {
        if (!/instagram\.com\/(api\/v1|api\/graphql|graphql)/.test(res.url())) return;
        if (!isSearchResponse(res)) return;
        try {
          for (const doc of parseBodies(await res.text())) ingest(doc);
        } catch {
          /* body unavailable (redirect/aborted) */
        }
      });
      try {
        await page.goto(urlFor(query), { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2500);
        if (isAuthWall(page)) {
          throw new SourceError('Instagram session expired or challenged. Re-run `npm run ig:login`.', {
            code: 'IG_AUTH', fatal: true,
          });
        }
        let stalls = 0;
        for (let i = 0; i < config.igMaxScrolls && found.size < limit && stalls < 3; i++) {
          const before = found.size;
          await page.mouse.wheel(0, 2200 + Math.random() * 800);
          await page.waitForTimeout(jitter(1400));
          if (isAuthWall(page)) throw new SourceError('Instagram asked for login mid-scroll', { code: 'IG_AUTH', fatal: true });
          stalls = found.size === before ? stalls + 1 : 0;
        }
        log.info({ query: query.label, found: found.size }, 'instagram page harvested');
        // keep rotating cookies fresh so the login lasts
        if (fs.existsSync(config.igStatePath)) await ctx.storageState({ path: config.igStatePath }).catch(() => {});
        return [...found.values()].slice(0, limit * 2);
      } finally {
        await ctx.close().catch(() => {});
      }
    });
}
