import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.DB_PATH = path.join(os.tmpdir(), `pvd-watchdog-test-${process.pid}-${Date.now()}.db`);
process.env.SEARCH_DEADLINE_MS = '50';
process.env.SEARCH_WATCHDOG_GRACE_MS = '50';
process.env.QUEUE_CONCURRENCY = '1';
process.env.LOG_LEVEL = 'silent';

// a pipeline that ignores its deadline and finishes late; it must not be able to resurrect the search
const late = { finishedWhileCancelled: null };
vi.mock('../src/pipeline.js', () => ({
  runSearch: (_id, _payload, emit, ctl) =>
    new Promise((resolve) =>
      setTimeout(() => {
        late.finishedWhileCancelled = ctl.cancelled;
        emit('meta', 'progress', 'late event');
        resolve({ product: { title: 'late' }, stats: { instagram: { shortfall: 0 }, meta: { shortfall: 0 } }, threshold: 50 });
      }, 300),
    ),
}));

let queue;
let store;
beforeAll(async () => {
  queue = await import('../src/queue.js');
  ({ store } = await import('../src/db.js'));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('queue watchdog', () => {
  it('marks an overrunning search error and ignores its late result', async () => {
    store.createSearch('s-late', 'thing', 'keyword', {});
    queue.enqueue('s-late', { input: 'thing' });
    await sleep(200);
    let row = store.getSearch('s-late');
    expect(row.status).toBe('error');
    expect(row.error).toMatch(/time limit/);
    expect(queue.queueDepth().running).toBe(0); // slot freed for the next search

    await sleep(250); // the pipeline finishes now
    expect(late.finishedWhileCancelled).toBe(true);
    row = store.getSearch('s-late');
    expect(row.status).toBe('error');
    expect(JSON.parse(row.product)).toBeNull();
    const evs = queue.eventsFor('s-late');
    expect(evs.at(-1)).toMatchObject({ stage: 'done', status: 'error' });
    expect(evs.some((e) => e.message === 'late event')).toBe(false);
  });
});

describe('store.saveResults', () => {
  const video = (uid) => ({ uid, platform: 'meta', videoId: uid, url: `https://x/${uid}`, score: 70, clip: 60, reason: 'r' });

  it('writes all rows in one transaction', () => {
    store.createSearch('s-tx', 'thing', 'keyword', {});
    store.saveResults('s-tx', [video('a:1'), video('a:2')]);
    expect(store.results('s-tx')).toHaveLength(2);
  });

  it('rolls back everything when one row fails', () => {
    store.createSearch('s-tx2', 'thing', 'keyword', {});
    const bad = { ...video('a:3'), score: Symbol('not bindable') };
    expect(() => store.saveResults('s-tx2', [video('a:4'), bad])).toThrow();
    expect(store.results('s-tx2')).toHaveLength(0);
    // and the connection is usable afterwards (no dangling transaction)
    store.saveResults('s-tx2', [video('a:5')]);
    expect(store.results('s-tx2')).toHaveLength(1);
  });
});
