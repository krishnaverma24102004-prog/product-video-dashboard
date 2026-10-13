import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DB_PATH = path.join(os.tmpdir(), `pvd-deadline-test-${process.pid}-${Date.now()}.db`);
process.env.GEMINI_API_KEY = '';
process.env.MAX_QUERY_ROUNDS = '6';
process.env.SOURCE_TIMEOUT_MS = '120000';
process.env.LOG_LEVEL = 'silent';

let runSource;
let DedupeIndex;
beforeAll(async () => {
  ({ runSource } = await import('../src/pipeline.js'));
  ({ DedupeIndex } = await import('../src/dedupe.js'));
});

const queries = Array.from({ length: 6 }, (_, i) => ({ type: 'keyword', value: `q${i}`, label: `q${i}` }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake collector: results without `thumb` are skipped before any network/thumbnail work. */
function fakeCollector(delayMs) {
  const seen = [];
  return {
    seen,
    async search(q) {
      seen.push(q.label);
      if (delayMs === Infinity) return new Promise(() => {});
      await sleep(delayMs);
      return [{ uid: `x:${q.value}`, caption: 'no thumb' }];
    },
  };
}

const run = (collector, deadline) =>
  runSource('meta', {
    queries, reference: { mode: 'text', terms: [] }, dedupe: new DedupeIndex({ hashDistance: 5 }), historyUids: new Set(),
    options: { showSeen: false, threshold: 50 }, target: 20, emit: () => {}, deadline, collector,
  });

describe('runSource deadline', () => {
  it('stops starting new query rounds once the deadline passes', async () => {
    const collector = fakeCollector(60);
    const { stats } = await run(collector, Date.now() + 150);
    expect(collector.seen.length).toBeGreaterThan(0);
    expect(collector.seen.length).toBeLessThan(queries.length);
    expect(stats.queriesTried).toEqual(collector.seen);
    expect(stats.deadlineReached).toBe(true);
    expect(stats.notes).toContain(`Search time limit reached after ${collector.seen.length} queries`);
    expect(stats.error).toBeNull();
  });

  it('runs no queries when the deadline has already passed', async () => {
    const collector = fakeCollector(0);
    const { stats, videos } = await run(collector, Date.now() - 1);
    expect(collector.seen).toEqual([]);
    expect(stats.deadlineReached).toBe(true);
    expect(videos).toEqual([]);
  });

  it('cuts a hanging collector off at the deadline without a retry', async () => {
    const collector = fakeCollector(Infinity);
    const t0 = Date.now();
    const { stats } = await run(collector, Date.now() + 120);
    expect(Date.now() - t0).toBeLessThan(1000); // withRetry would otherwise sleep 1.5s and try again
    expect(collector.seen).toEqual(['q0']);
    expect(stats.deadlineReached).toBe(true);
    expect(stats.notes.some((n) => n.includes('cut off by the search time limit'))).toBe(true);
  });

  it('without a deadline problem all rounds run as before', async () => {
    const collector = fakeCollector(0);
    const { stats } = await run(collector, Date.now() + 60_000);
    expect(collector.seen).toHaveLength(6);
    expect(stats.deadlineReached).toBe(false);
  });
});
