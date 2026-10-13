import { config } from './config.js';
import { log } from './log.js';
import { store } from './db.js';
import { DedupeIndex } from './dedupe.js';
import { resolveProduct } from './product.js';
import { safeGet } from './urlSafety.js';
import { toJpeg, dHash } from './vision/image.js';
import { analyseProduct, buildQueries, buildReference, scoreWithClip, scoreWithVlm, finalizeScores } from './vision/brain.js';
import { createVisionSession, geminiEnabled } from './vision/gemini.js';
import { JUDGE_VERSION } from './vision/verdict.js';
import { instagramCollector } from './collectors/instagram.js';
import { metaCollector } from './collectors/meta.js';
import { tiktokCollector } from './collectors/tiktok.js';
import { withRetry, withTimeout, mapLimit } from './util.js';

const COLLECTORS = { instagram: instagramCollector, meta: metaCollector, tiktok: tiktokCollector };
const IDENTITY_MIN_CONFIDENCE = 60;

/** The photo alone is ambiguous (e.g. a scoop of powder): stop before searching and ask the user what it is. */
export class NeedsHintError extends Error {
  constructor(guesses, product) {
    super(`Not sure what this product is from the photo alone${guesses.length ? ` (could be: ${guesses.join(', ')})` : ''}. Type the product name next to the image and search again.`);
    this.code = 'NEEDS_HINT';
    this.guesses = guesses;
    this.product = { ...product, needsHint: true, guesses };
  }
}

/** The queue's watchdog gave up on this search: a late finish must not write anything. */
export class SearchCancelledError extends Error {
  constructor() {
    super('Search was cancelled after exceeding its time limit; late results discarded');
    this.code = 'CANCELLED';
  }
}

const LABEL = { instagram: 'Instagram', meta: 'Meta Ad Library', tiktok: 'TikTok' };

const VISION_REASON = {
  quota: 'Gemini quota exhausted',
  rate_limit: 'Gemini rate limit hit',
  server: 'Gemini servers unavailable',
  auth: 'Gemini API key / project rejected',
  budget: 'per-search Gemini call budget used up',
  deadline: 'search time limit reached',
  model_not_found: 'no configured Gemini model exists',
  error: 'some Gemini requests failed',
};

const deadlineError = (name) =>
  Object.assign(new Error(`${name} search stopped: search time limit reached`), { code: 'DEADLINE', fatal: true });

/** One progress line per search when vision goes away, so the UI log says why scores are CLIP-only. */
function emitVisionFallback(emit, session) {
  if (session.fallbackAnnounced) return;
  session.fallbackAnnounced = true;
  emit('scoring', 'warn', `Vision scoring unavailable (${VISION_REASON[session.reason] ?? session.reason}); remaining videos are scored CLIP-only`,
    { vision: { reason: session.reason, calls: session.calls, budget: session.budget } });
}

async function loadThumb(c) {
  const { body } = await safeGet(c.thumb, { timeoutMs: 8000, maxBytes: 3_000_000, headers: { referer: '' } });
  c.jpeg = await toJpeg(body, 512, 78);
  c.phash = await dHash(c.jpeg);
  return c;
}

/**
 * Collects, de-duplicates and scores videos for one platform until the target of *usable*
 * (above-threshold, unseen, non-duplicate) videos is met, the query list is exhausted or the
 * search deadline passes. Never throws: failures become notes + a shortfall flag so one source
 * cannot break the search. `collector` is injectable for tests.
 */
export async function runSource(platform, {
  queries, reference, dedupe, historyUids, options, target, emit,
  deadline = Date.now() + config.searchDeadlineMs, session = createVisionSession({ deadline }),
  collector = COLLECTORS[platform], ctl = {},
}) {
  const name = LABEL[platform] ?? platform;
  const pool = [];
  const stats = { platform, target, usable: 0, total: 0, below: 0, dropped: {}, queriesTried: [], notes: [], error: null, deadlineReached: false };
  const usable = () => pool.filter((c) => !c.below).length;
  const drop = (reason) => (stats.dropped[reason] = (stats.dropped[reason] || 0) + 1);
  const hitDeadline = () => {
    stats.deadlineReached = true;
    stats.notes.push(`Search time limit reached after ${stats.queriesTried.length} queries`);
    emit(platform, 'progress', `${name}: search time limit reached, keeping what was found`);
  };

  emit(platform, 'start', `Searching ${name}`);
  for (const [round, q] of queries.slice(0, config.maxQueryRounds).entries()) {
    if (usable() >= target || ctl.cancelled) break;
    if (Date.now() >= deadline) {
      hitDeadline();
      break;
    }
    stats.queriesTried.push(q.label);
    emit(platform, 'progress', `${name}: ${round ? 'expanding with' : 'searching'} "${q.label}" (${usable()}/${target} so far)`);

    let raw;
    try {
      raw = await withRetry(
        () => {
          // every attempt gets at most the time left before the search deadline
          const left = deadline - Date.now();
          if (left <= 0) throw deadlineError(name);
          const ms = Math.min(config.sourceTimeoutMs, left);
          return withTimeout(collector.search(q, { limit: 40 }), ms, `${name} search`).catch((e) => {
            throw e.code === 'TIMEOUT' && ms < config.sourceTimeoutMs ? deadlineError(name) : e;
          });
        },
        { tries: 2, onRetry: (e, n) => emit(platform, 'progress', `${name}: retry ${n} after "${e.message}"`) },
      );
    } catch (e) {
      if (e.code === 'DEADLINE') {
        stats.notes.push(`"${q.label}": cut off by the search time limit`);
        hitDeadline();
        break;
      }
      stats.notes.push(`"${q.label}": ${e.message}`);
      log.warn({ platform, q: q.label, err: e.message, code: e.code }, 'source query failed');
      if (e.fatal) {
        stats.error = e.message;
        break;
      }
      continue;
    }

    // 1. cheap id-level filtering before spending bandwidth on thumbnails
    const fresh = [];
    for (const c of raw) {
      if (!c.thumb) continue;
      if (dedupe.hasUid(c.uid)) drop(options.showSeen && historyUids.has(c.uid) ? 'duplicate_id' : historyUids.has(c.uid) ? 'seen_before' : 'duplicate_id');
      else fresh.push(c);
    }
    if (!fresh.length) {
      stats.notes.push(`"${q.label}": nothing new`);
      continue;
    }

    // 2. thumbnails -> perceptual hash -> near-duplicate / text-duplicate filtering
    const loaded = (await mapLimit(fresh, 6, loadThumb)).filter((r) => !r.__error);
    const kept = [];
    for (const c of loaded) {
      const verdict = dedupe.tryAdd(c);
      if (verdict.ok) kept.push(c);
      else drop(verdict.reason);
    }
    if (!kept.length) continue;

    // 3. score: CLIP for all, vision model for the plausible ones (until this search's vision session closes)
    emit(platform, 'progress', `${name}: scoring ${kept.length} new videos`);
    await scoreWithClip(reference, kept);
    await scoreWithVlm(reference, kept, { session });
    if (session.open && geminiEnabled()) emitVisionFallback(emit, session);
    finalizeScores(kept, reference, options.threshold);
    for (const c of kept) c.seenBefore = historyUids.has(c.uid);
    pool.push(...kept);
  }

  // 4. catch-up: candidates ranked out of a round's judge cutoff get a verdict while budget and time remain
  // (live: Ray-Ban Aviator ended 3/20 with 10 "Not judged" and 6 Gemini calls unused)
  await judgeHeldBack({
    pool, target, session, deadline, ctl, threshold: options.threshold, reference,
    onPass: (n) => emit(platform, 'progress', `${name}: judging ${n} videos held back earlier`),
  });

  pool.sort((a, b) => b.score - a.score);
  const good = pool.filter((c) => !c.below).slice(0, target * 2);
  const weak = pool.filter((c) => c.below).slice(0, 10);
  Object.assign(stats, {
    usable: good.length,
    below: weak.length,
    total: good.length + weak.length,
    shortfall: Math.max(0, target - good.length),
  });
  if (stats.shortfall && !stats.error) {
    stats.notes.push(
      `Only ${good.length}/${target} unique matching videos found after ${stats.queriesTried.length} queries. ` +
        (stats.deadlineReached
          ? 'The search time limit stopped further queries.'
          : 'The source may be rate-limiting, the product may be niche, or the match threshold may be strict.'),
    );
  }
  emit(platform, stats.shortfall ? 'warn' : 'done', `${name}: ${good.length}/${target} usable videos`, stats);
  return { stats, videos: [...good, ...weak] };
}

/** Re-judges pool candidates that a round's judge cutoff held back, while the source is short and budget/time remain. */
export async function judgeHeldBack({ pool, target, session, deadline, ctl = {}, threshold, reference, onPass = () => {}, score = scoreWithVlm, finalize = finalizeScores }) {
  const usable = () => pool.filter((c) => !c.below).length;
  for (let pass = 0; pass < 3 && usable() < target && session.available() && Date.now() < deadline && !ctl.cancelled; pass++) {
    const waiting = pool.filter((c) => c.unjudgedByCap && c.vlm == null);
    if (!waiting.length) break;
    onPass(waiting.length);
    for (const c of waiting) c.unjudgedByCap = false;
    await score(reference, waiting, { session });
    finalize(waiting, reference, threshold);
  }
}

/** Per-search vision summary stored in stats.vision (and shown by the dashboard when not 'ok'). */
export function visionStats(session, videos) {
  const judged = videos.filter((v) => v.vlm != null).length;
  const clipOnly = videos.length - judged;
  const count = (key) => videos.reduce((m, v) => (v[key] ? { ...m, [v[key]]: (m[v[key]] || 0) + 1 } : m), {});
  // relation/matchStatus come from verdict.js; judgeModel shows whether a lite fallback did the judging
  const base = {
    calls: session.calls, budget: session.budget, judged, clipOnly,
    judgeVersion: JUDGE_VERSION, judgeModels: count('judgeModel'), relations: count('relation'), matchStatus: count('matchStatus'),
  };
  if (!geminiEnabled()) return { status: 'disabled', reason: 'no_key', detail: 'GEMINI_API_KEY not set', ...base };
  if (session.open) return { status: 'fallback', reason: session.reason, detail: session.detail, ...base };
  if (session.batchErrors) return { status: 'fallback', reason: 'error', detail: `${session.batchErrors} vision batch(es) failed`, ...base };
  return { status: 'ok', reason: null, detail: null, ...base };
}

/** TikTok reuses the Instagram keyword phrases (hashtag search is noisier there), capped to a few rounds. */
export function tiktokQueries(igQueries = [], max = config.tiktokMaxQueries) {
  const seen = new Set();
  return igQueries
    .filter((q) => q.type === 'keyword' && !seen.has(q.value.toLowerCase()) && seen.add(q.value.toLowerCase()))
    .slice(0, max);
}

/**
 * Which sources a search runs, with their queries and targets. TikTok is an optional bonus source:
 * only when `opts.tiktok` is set, and its target is informational (no minimum).
 */
export function planSources(opts, queries) {
  const plan = [
    { platform: 'instagram', queries: queries.instagram, target: config.perSourceTarget },
    { platform: 'meta', queries: queries.meta, target: config.perSourceTarget },
  ];
  if (opts.tiktok) plan.push({ platform: 'tiktok', queries: tiktokQueries(queries.instagram), target: config.tiktokTarget, optional: true });
  return plan;
}

/**
 * `ctl` is owned by the queue: when its watchdog fires it sets ctl.cancelled, and this run then
 * stops early and, crucially, never writes results for a search already marked as failed.
 */
export async function runSearch(searchId, { input, imageBase64, options }, emit, ctl = {}, collectors = COLLECTORS) {
  const opts = { showSeen: Boolean(options?.showSeen), tiktok: Boolean(options?.tiktok), threshold: options?.threshold ?? config.matchThreshold };
  const deadline = Date.now() + config.searchDeadlineMs;
  const session = createVisionSession({ deadline });
  const checkCancelled = () => {
    if (ctl.cancelled) throw new SearchCancelledError();
  };

  emit('product', 'start', !input ? 'Reading uploaded image' : input.startsWith('http') ? 'Fetching product page' : 'Reading product keyword');
  const product = await resolveProduct({ input, imageBase64 }, (m) => emit('product', 'progress', m));
  emit('product', 'done', product.title ? `Product: ${product.title.slice(0, 80)}` : 'Image received', { title: product.title });
  checkCancelled();

  emit('brain', 'start', 'Analysing product image');
  const attrs = await analyseProduct(product, (m) => emit('brain', 'progress', m), session);
  if (session.open) emitVisionFallback(emit, session);
  if (!product.title) {
    // image-only search: the vision model names the product, but only if it is sure what it is
    if (attrs.source !== 'gemini') throw new Error('Could not identify the product from the image alone. Add a product name or link and retry.');
    const guesses = (attrs.possibleIdentities || []).filter(Boolean).slice(0, 4);
    if ((attrs.identityConfidence ?? 100) < IDENTITY_MIN_CONFIDENCE) {
      throw new NeedsHintError(guesses.length ? guesses : [attrs.correctedName || attrs.productType].filter(Boolean), {
        imageDataUrl: product.imageDataUrl, attributes: attrs, title: '', type: 'image',
      });
    }
    product.title = attrs.correctedName || attrs.summary || attrs.productType || 'Uploaded product';
  }
  const queries = buildQueries(product, attrs);
  const reference = await buildReference(product, attrs);
  const { identity } = queries;
  const publicProduct = {
    title: product.title, description: product.description, url: product.url, type: product.type,
    imageDataUrl: product.imageDataUrl ?? null, referenceMode: reference.mode, attributes: attrs, identity,
    queries: { instagram: queries.instagram.map((q) => q.label), meta: queries.meta.map((q) => q.label) },
    ...(opts.tiktok && { tiktokQueries: tiktokQueries(queries.instagram).map((q) => q.label) }),
  };
  const idNote = !identity.brandKnown ? ' (brand unknown: matching on visual resemblance only)'
    : !identity.verified ? ` (brand "${identity.brand}" inferred from the design, not verified)` : '';
  emit('brain', 'done', `Detected: ${attrs.correctedName || attrs.productType || product.title}${idNote}`, publicProduct);
  checkCancelled();

  const history = store.seen(searchId);
  const historyUids = new Set(history.map((h) => h.uid));
  // all sources run in parallel; runSource never throws and the .catch is a last resort, so one source
  // (in particular the optional TikTok one) can never fail the search or hold back the others' results
  const results = await Promise.all(
    planSources(opts, queries).map(({ platform, queries: qs, target, optional }) => {
      const dedupe = new DedupeIndex({ hashDistance: config.hashDistance });
      if (!opts.showSeen) dedupe.seed(history);
      return runSource(platform, {
        queries: qs, reference, dedupe, historyUids, options: opts, target, emit, deadline, session, ctl, collector: collectors[platform],
      }).then((r) => (optional ? { ...r, stats: { ...r.stats, optional: true } } : r)).catch((e) => {
        log.error({ err: e, platform }, 'source crashed');
        emit(platform, 'error', `${LABEL[platform]} failed: ${e.message}`);
        return { stats: { platform, target, optional: Boolean(optional), usable: 0, total: 0, shortfall: target, error: e.message, notes: [e.message], dropped: {}, queriesTried: [] }, videos: [] };
      });
    }),
  );

  // the watchdog may have failed this search while sources were finishing: do not resurrect it
  checkCancelled();
  emit('scoring', 'start', 'Saving results');
  const all = results.flatMap((r) => r.videos);
  store.saveResults(searchId, all); // one transaction: all rows or none
  const stats = Object.fromEntries(results.map((r) => [r.stats.platform, r.stats]));
  stats.vision = visionStats(session, all);
  stats.deadlineReached = results.some((r) => r.stats.deadlineReached);
  stats.deadlineMs = config.searchDeadlineMs;
  if (stats.vision.status === 'fallback') {
    emit('scoring', 'warn', `${stats.vision.clipOnly} of ${all.length} videos scored CLIP-only (${VISION_REASON[stats.vision.reason] ?? stats.vision.reason})`);
  }
  return { product: publicProduct, stats, threshold: opts.threshold };
}
