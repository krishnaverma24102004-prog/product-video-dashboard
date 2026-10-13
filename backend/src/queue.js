import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { log } from './log.js';
import { store } from './db.js';
import { runSearch } from './pipeline.js';

/**
 * In-process job queue: searches run in the background (the POST returns immediately), at most
 * `queueConcurrency` at a time, with progress events buffered per search so SSE clients can
 * connect late and still replay everything. Swap for BullMQ/Redis to scale across processes.
 */
const bus = new EventEmitter();
bus.setMaxListeners(100);
const events = new Map(); // searchId -> event[]
const pending = [];
let running = 0;

export function emitFor(id) {
  return (stage, status, message, data) => {
    const ev = { t: Date.now(), stage, status, message, ...(data !== undefined ? { data } : {}) };
    const list = events.get(id) ?? [];
    list.push(ev);
    events.set(id, list);
    bus.emit(id, ev);
  };
}

export const eventsFor = (id) => events.get(id) ?? [];
export const subscribe = (id, fn) => {
  bus.on(id, fn);
  return () => bus.off(id, fn);
};
export const queueDepth = () => ({ running, waiting: pending.length });

export function enqueue(id, payload) {
  pending.push({ id, payload });
  pump();
}

function pump() {
  while (running < config.queueConcurrency && pending.length) {
    const job = pending.shift();
    running++;
    execute(job).finally(() => {
      running--;
      pump();
    });
  }
}

async function execute({ id, payload }) {
  const rawEmit = emitFor(id);
  const ctl = { cancelled: false };
  // once the watchdog has failed the search, a still-running pipeline must not add events after 'done'
  const emit = (...args) => !ctl.cancelled && rawEmit(...args);
  const started = Date.now();
  store.setStatus(id, 'running');
  // runSearch honours SEARCH_DEADLINE_MS itself; this is the backstop for anything that ignores it
  // (a hung browser page, a stuck thumbnail fetch) so a search can never stay 'running' forever
  const limitMs = config.searchDeadlineMs + config.searchWatchdogGraceMs;
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctl.cancelled = true;
      reject(Object.assign(new Error(`Search exceeded its ${Math.round(limitMs / 1000)}s time limit and was stopped; no results were saved`), { code: 'WATCHDOG' }));
    }, limitMs);
    timer.unref?.();
  });
  try {
    const { product, stats, threshold } = await Promise.race([runSearch(id, payload, emit, ctl), watchdog]);
    const shortfall = ['instagram', 'meta'].some((p) => stats[p]?.shortfall > 0);
    store.finishSearch(id, { status: 'done', product, stats: { ...stats, threshold, ms: Date.now() - started } });
    rawEmit('done', shortfall ? 'warn' : 'done', shortfall ? 'Finished with a shortfall on at least one source' : 'Search complete');
  } catch (e) {
    if (e.code === 'NEEDS_HINT') {
      // not a failure: the search stops early and asks the user what the product is
      log.info({ id, guesses: e.guesses }, 'search paused: product identity ambiguous');
      store.finishSearch(id, { status: 'needs_hint', error: e.message, product: e.product });
      rawEmit('done', 'warn', 'Need the product name: the photo alone could be several things', { needsHint: true, guesses: e.guesses });
      return;
    }
    if (e.code === 'WATCHDOG') log.error({ id, limitMs }, 'search watchdog fired; marking search failed');
    else log.error({ err: e, id }, 'search failed');
    store.finishSearch(id, { status: 'error', error: e.message, product: e.product });
    rawEmit('done', 'error', e.message);
  } finally {
    clearTimeout(timer);
  }
}

/** Searches left 'running' by a crash would hang the UI forever; fail them at boot. */
export function recoverOrphans(db) {
  db.prepare(`UPDATE searches SET status='error', error='Server restarted during search' WHERE status IN ('queued','running')`).run();
}
