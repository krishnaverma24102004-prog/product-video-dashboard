import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  /* .env is optional; real env vars still apply */
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v));

export const config = {
  root,
  port: num(process.env.PORT, 4000),
  logLevel: process.env.LOG_LEVEL || 'info',
  dbPath: process.env.DB_PATH || path.join(root, 'data', 'app.db'),

  // vision
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  geminiFallbackModels: (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.1-flash-lite,gemini-flash-latest,gemini-3.5-flash-lite,gemini-flash-lite-latest')
    .split(',').map((s) => s.trim()).filter(Boolean),
  geminiRpm: num(process.env.GEMINI_RPM, 10),
  geminiCallBudgetMs: num(process.env.GEMINI_CALL_BUDGET_MS, 50000),
  clipModel: process.env.CLIP_MODEL || 'Xenova/clip-vit-base-patch32',

  // matching
  matchThreshold: num(process.env.MATCH_THRESHOLD, 50),
  perSourceTarget: num(process.env.PER_SOURCE_TARGET, 20),
  maxQueryRounds: num(process.env.MAX_QUERY_ROUNDS, 8),
  hashDistance: num(process.env.PHASH_DISTANCE, 5),

  // instagram (logged-in session)
  igStatePath: process.env.IG_STATE_PATH || path.join(root, '.sessions', 'ig.json'),
  igSessionId: process.env.IG_SESSION_ID || '',
  igMinDelayMs: num(process.env.IG_MIN_DELAY_MS, 3000),
  igDailyPageCap: num(process.env.IG_DAILY_PAGE_CAP, 250),
  igMaxScrolls: num(process.env.IG_MAX_SCROLLS, 14),

  // meta ad library
  metaCountry: process.env.META_COUNTRY || 'ALL',
  metaMaxScrolls: num(process.env.META_MAX_SCROLLS, 14),

  // tiktok (optional bonus source, public web search, only when a search sets options.tiktok)
  tiktokTarget: num(process.env.TIKTOK_TARGET, 10),
  tiktokMaxQueries: num(process.env.TIKTOK_MAX_QUERIES, 4),
  tiktokMaxScrolls: num(process.env.TIKTOK_MAX_SCROLLS, 8),

  headless: bool(process.env.HEADLESS, true),
  sourceTimeoutMs: num(process.env.SOURCE_TIMEOUT_MS, 120000),
  queueConcurrency: num(process.env.QUEUE_CONCURRENCY, 1),
  productCacheTtlMs: num(process.env.PRODUCT_CACHE_TTL_HOURS, 24) * 3600 * 1000,

  // search deadline + vision budget: one search may not run (or spend Gemini calls) without bound
  searchDeadlineMs: num(process.env.SEARCH_DEADLINE_MS, 240000),
  geminiMaxCallsPerSearch: num(process.env.GEMINI_MAX_CALLS_PER_SEARCH, 24),
  searchWatchdogGraceMs: num(process.env.SEARCH_WATCHDOG_GRACE_MS, 90000), // queue.js fails the search at deadline + grace

  // network + API security (enforced in server.js; see README "Security")
  host: process.env.HOST || '127.0.0.1', // loopback only; Docker sets 0.0.0.0 inside the container
  allowedOrigins: csvList(process.env.ALLOWED_ORIGINS, () => {
    const p = num(process.env.PORT, 4000);
    return ['http://localhost:5173', 'http://127.0.0.1:5173', `http://localhost:${p}`, `http://127.0.0.1:${p}`];
  }),
  allowedHosts: csvList(process.env.ALLOWED_HOSTS, () => ['localhost', '127.0.0.1', '[::1]']), // "name" = any port
  apiToken: process.env.API_TOKEN || '', // empty = disabled; never log this
};

// network + API security: comma-separated env list, or the default when unset/empty
function csvList(v, dflt) {
  const items = (v || '').split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : dflt();
}
