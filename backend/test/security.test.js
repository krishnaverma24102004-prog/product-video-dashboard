import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Isolate from the real DB / session / keys BEFORE server code (config.js, db.js) is imported.
// Existing env vars (even empty) win over backend/.env in process.loadEnvFile.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvd-sec-'));
Object.assign(process.env, {
  DB_PATH: path.join(tmp, 'test.db'),
  IG_STATE_PATH: path.join(tmp, 'ig.json'),
  IG_SESSION_ID: '',
  GEMINI_API_KEY: '',
  HOST: '',
  ALLOWED_ORIGINS: '',
  ALLOWED_HOSTS: '',
  API_TOKEN: '',
  LOG_LEVEL: 'silent',
});

const GOOD = 'http://localhost:5173';
const EVIL = 'https://evil.example';
let mod, dbMod, servers = [];

async function listen(opts) {
  const server = mod.createApp(opts).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  servers.push(server);
  return server.address().port;
}

// raw node:http so Origin / Host / Sec-Fetch-Site can be set freely
function send(port, method, urlPath, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const h = { host: `localhost:${port}`, ...headers };
    if (data) Object.assign(h, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

let port, tokenPort;
beforeAll(async () => {
  mod = await import('../src/server.js');
  dbMod = await import('../src/db.js');
  port = await listen();
  tokenPort = await listen({ apiToken: 's3cret-token' });
});
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  try {
    dbMod.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* temp cleanup is best-effort on Windows */
  }
});

describe('config defaults', () => {
  it('binds loopback and allows only local dev/prod origins', async () => {
    const { config } = await import('../src/config.js');
    expect(config.host).toBe('127.0.0.1');
    expect(config.apiToken).toBe('');
    expect(config.allowedOrigins).toEqual(expect.arrayContaining(['http://localhost:5173', 'http://127.0.0.1:5173', `http://localhost:${config.port}`]));
    expect(config.allowedOrigins).not.toContain(EVIL);
  });
});

describe('CORS', () => {
  it('allowed origin gets ACAO on preflight and actual request', async () => {
    const pre = await send(port, 'OPTIONS', '/api/videos/x/star', {
      origin: GOOD, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-api-token',
    });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(GOOD);
    const get = await send(port, 'GET', '/api/health', { origin: GOOD });
    expect(get.status).toBe(200);
    expect(get.headers['access-control-allow-origin']).toBe(GOOD);
  });

  it('disallowed origin gets no ACAO', async () => {
    const pre = await send(port, 'OPTIONS', '/api/search', { origin: EVIL, 'access-control-request-method': 'POST' });
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    const get = await send(port, 'GET', '/api/health', { origin: EVIL });
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('state-changing requests', () => {
  it('allowed Origin -> 200', async () => {
    expect((await send(port, 'POST', '/api/videos/x/star', { origin: GOOD })).status).toBe(200);
    expect((await send(port, 'DELETE', '/api/videos/x/star', { origin: 'http://127.0.0.1:5173' })).status).toBe(200);
  });
  it('evil Origin -> 403 (also "null" origin)', async () => {
    const r = await send(port, 'POST', '/api/videos/x/star', { origin: EVIL });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).error).toMatch(/origin/i);
    expect((await send(port, 'DELETE', '/api/videos/x/star', { origin: 'null' })).status).toBe(403);
  });
  it('no Origin and no Sec-Fetch-Site (CLI) -> 200', async () => {
    expect((await send(port, 'POST', '/api/videos/x/star')).status).toBe(200);
  });
  it('no Origin with Sec-Fetch-Site cross-site / same-site -> 403', async () => {
    expect((await send(port, 'POST', '/api/videos/x/star', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await send(port, 'POST', '/api/videos/x/star', { 'sec-fetch-site': 'same-site' })).status).toBe(403);
  });
  it('allowed Origin with Sec-Fetch-Site same-origin (dashboard / Vite proxy) -> 200', async () => {
    expect((await send(port, 'POST', '/api/videos/x/star', { origin: GOOD, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  });
  it('POST /api/search with invalid body: allowed origin -> 400 (passed security), evil -> 403', async () => {
    expect((await send(port, 'POST', '/api/search', { origin: GOOD }, {})).status).toBe(400);
    expect((await send(port, 'POST', '/api/search', { origin: EVIL }, {})).status).toBe(403);
  });
});

describe('Host header (DNS rebinding)', () => {
  it('rejects a foreign Host on API and static routes', async () => {
    expect((await send(port, 'GET', '/api/health', { host: 'evil.example:4000' })).status).toBe(421);
    expect((await send(port, 'POST', '/api/videos/x/star', { host: 'evil.example', origin: GOOD })).status).toBe(421);
    expect((await send(port, 'GET', '/', { host: 'evil.example:4000' })).status).toBe(421);
    expect((await send(port, 'GET', '/api/health', { host: 'localhost.evil.example' })).status).toBe(421);
  });
  it('allows localhost / 127.0.0.1 / [::1] with any port', async () => {
    for (const host of ['localhost:4000', '127.0.0.1:4000', '[::1]:4000', 'localhost']) {
      expect((await send(port, 'GET', '/api/health', { host })).status).toBe(200);
    }
  });
});

describe('reads stay header-free (EventSource / <img>)', () => {
  it('SSE and image proxy routes are reached without token or Origin', async () => {
    expect((await send(tokenPort, 'GET', '/api/search/does-not-exist/events')).status).toBe(404);
    expect((await send(tokenPort, 'GET', '/api/img?u=')).status).toBe(400);
    expect((await send(tokenPort, 'GET', '/api/health')).status).toBe(200);
  });
});

describe('API token mode', () => {
  const T = 's3cret-token';
  it('missing token -> 401, wrong token -> 403, correct -> 200', async () => {
    expect((await send(tokenPort, 'POST', '/api/videos/x/star', { origin: GOOD })).status).toBe(401);
    expect((await send(tokenPort, 'POST', '/api/videos/x/star', { origin: GOOD, 'x-api-token': 'nope' })).status).toBe(403);
    expect((await send(tokenPort, 'POST', '/api/videos/x/star', { origin: GOOD, 'x-api-token': T + 'x' })).status).toBe(403);
    expect((await send(tokenPort, 'POST', '/api/videos/x/star', { origin: GOOD, 'x-api-token': T })).status).toBe(200);
    expect((await send(tokenPort, 'POST', '/api/videos/x/star', { 'x-api-token': T })).status).toBe(200);
  });
  it('correct token does not bypass the Origin check', async () => {
    expect((await send(tokenPort, 'POST', '/api/videos/x/star', { origin: EVIL, 'x-api-token': T })).status).toBe(403);
  });
  it('invalid search body with token -> 400, not a real search', async () => {
    expect((await send(tokenPort, 'POST', '/api/search', { origin: GOOD, 'x-api-token': T }, {})).status).toBe(400);
  });
});
