import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DB_PATH = path.join(os.tmpdir(), `pvd-heldback-test-${process.pid}-${Date.now()}.db`);
process.env.GEMINI_API_KEY = '';
process.env.LOG_LEVEL = 'silent';

let judgeHeldBack;
beforeAll(async () => {
  ({ judgeHeldBack } = await import('../src/pipeline.js'));
});

const session = (ok = true) => ({ available: () => ok });
const later = () => Date.now() + 60_000;
// fake judge: marks every candidate it sees as judged; fake finalize: accept judged ones
const score = async (_ref, cs) => cs.forEach((c) => (c.vlm = 90));
const finalize = (cs) => cs.forEach((c) => (c.below = c.vlm == null));

describe('judgeHeldBack (candidates ranked out of a round\'s judge cutoff)', () => {
  const pool = () => [
    { uid: 'a', below: false, vlm: 95 },
    { uid: 'b', below: true, unjudgedByCap: true, vlm: null },
    { uid: 'c', below: true, unjudgedByCap: true, vlm: null },
  ];

  it('judges held-back candidates when the source is short and budget remains', async () => {
    const p = pool();
    const passes = [];
    await judgeHeldBack({ pool: p, target: 20, session: session(), deadline: later(), score, finalize, onPass: (n) => passes.push(n) });
    expect(passes).toEqual([2]);
    expect(p.filter((c) => !c.below).map((c) => c.uid)).toEqual(['a', 'b', 'c']);
  });

  it('does nothing when the target is met, the judge is unavailable or the deadline passed', async () => {
    for (const args of [
      { target: 1, session: session(), deadline: later() },
      { target: 20, session: session(false), deadline: later() },
      { target: 20, session: session(), deadline: Date.now() - 1 },
    ]) {
      const p = pool();
      let called = false;
      await judgeHeldBack({ pool: p, ...args, score: async () => (called = true), finalize });
      expect(called).toBe(false);
      expect(p[1].below).toBe(true);
    }
  });
});
