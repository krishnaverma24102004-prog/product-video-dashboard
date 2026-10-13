import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.DB_PATH = path.join(os.tmpdir(), `pvd-tiktok-test-${process.pid}-${Date.now()}.db`);
process.env.GEMINI_API_KEY = '';
process.env.LOG_LEVEL = 'silent';

// runSearch without network: product resolution and the vision brain are stubbed, collectors are injected
vi.mock('../src/product.js', () => ({ resolveProduct: async ({ input }) => ({ title: input, type: 'keyword' }) }));
vi.mock('../src/vision/brain.js', () => ({
  analyseProduct: async () => ({ source: 'heuristic' }),
  buildQueries: () => ({
    identity: { brandKnown: true, verified: true, brand: 'acme' },
    instagram: [
      { type: 'hashtag', value: 'acmebottle', label: '#acmebottle' },
      { type: 'keyword', value: 'acme bottle', label: 'acme bottle' },
      { type: 'keyword', value: 'acme bottle review', label: 'acme bottle review' },
    ],
    meta: [{ type: 'keyword', value: 'acme bottle', label: 'acme bottle' }],
  }),
  buildReference: async () => ({ mode: 'text', terms: [] }),
  scoreWithClip: async () => {},
  scoreWithVlm: async () => {},
  finalizeScores: () => {},
}));

let extractTikTokVideos, classifyTikTokBlock, runSearch, planSources, tiktokQueries, store;
beforeAll(async () => {
  ({ extractTikTokVideos, classifyTikTokBlock } = await import('../src/collectors/tiktok.js'));
  ({ runSearch, planSources, tiktokQueries } = await import('../src/pipeline.js'));
  ({ store } = await import('../src/db.js'));
});

const fixture = {
  status_code: 0,
  has_more: 1,
  item_list: [
    {
      id: '7301234567890123456',
      desc: 'Unboxing the Acme insulated bottle, keeps ice for 24h #acme',
      createTime: 1700000000,
      author: { uniqueId: 'hydrohank', nickname: 'Hank' },
      video: { cover: 'https://p16-sign-va.tiktokcdn.com/obj/cover1.jpeg', playAddr: 'https://v16-webapp.tiktok.com/x.mp4' },
      stats: { playCount: 1234 },
    },
    { id: '7301234567890999999', desc: 'no cover', author: { uniqueId: 'x' }, video: {} },
    { id: 'abc', desc: 'not a video id', video: { cover: 'https://p16.tiktokcdn.com/c.jpeg' } },
  ],
  // general search shape nests items one level deeper
  data: [{ type: 1, item: { id: '7309999999999999999', desc: 'short', author: { uniqueId: 'b' }, video: { originCover: 'https://p16.tiktokcdn.com/o.jpeg' } } }],
};

describe('extractTikTokVideos', () => {
  it('parses item_list and general-search items into candidates', () => {
    const out = extractTikTokVideos(fixture);
    expect(out.map((v) => v.videoId).sort()).toEqual(['7301234567890123456', '7309999999999999999']);
    const v = out.find((x) => x.videoId === '7301234567890123456');
    expect(v).toMatchObject({
      platform: 'tiktok',
      uid: 'tiktok:7301234567890123456',
      url: 'https://www.tiktok.com/@hydrohank/video/7301234567890123456',
      thumb: 'https://p16-sign-va.tiktokcdn.com/obj/cover1.jpeg',
      mediaUrl: null,
      author: 'hydrohank',
      postedAt: 1700000000000,
      views: 1234,
    });
    expect(v.textKey).toMatch(/^[0-9a-f]{20}$/);
    expect(out.find((x) => x.videoId === '7309999999999999999').textKey).toBeNull(); // caption too short to key on
  });

  it('returns nothing for unrelated JSON', () => {
    expect(extractTikTokVideos({ statusCode: 0, extra: { now: 1 } })).toEqual([]);
    expect(extractTikTokVideos(null)).toEqual([]);
  });

  it('classifies captcha, login wall and geo-block pages', () => {
    expect(classifyTikTokBlock('https://www.tiktok.com/in/about', '')?.code).toBe('TIKTOK_GEO_BLOCKED');
    expect(classifyTikTokBlock('https://www.tiktok.com/search/video?q=x', 'Drag the slider to fit the puzzle')?.code).toBe('TIKTOK_CAPTCHA');
    expect(classifyTikTokBlock('https://www.tiktok.com/search/video?q=x', 'Log in to TikTok')?.code).toBe('TIKTOK_LOGIN_WALL');
    expect(classifyTikTokBlock('https://www.tiktok.com/search/video?q=x', 'Videos  Users')).toBeNull();
  });
});

describe('TikTok source wiring', () => {
  const spy = (impl = async () => []) => ({ calls: [], async search(q) { this.calls.push(q.label); return impl(q); } });
  const collectorsFor = (tiktok) => ({ instagram: spy(), meta: spy(), tiktok });
  const search = (id, options, collectors) => {
    store.createSearch(id, 'acme bottle', 'keyword', options);
    return runSearch(id, { input: 'acme bottle', options }, () => {}, {}, collectors);
  };

  it('plans TikTok only when the option is on, reusing Instagram keyword queries', () => {
    const queries = { instagram: [{ type: 'hashtag', value: 'a', label: '#a' }, { type: 'keyword', value: 'acme', label: 'acme' }], meta: [] };
    expect(planSources({ tiktok: false }, queries).map((p) => p.platform)).toEqual(['instagram', 'meta']);
    const tt = planSources({ tiktok: true }, queries).find((p) => p.platform === 'tiktok');
    expect(tt).toMatchObject({ optional: true, target: 10 });
    expect(tt.queries.map((q) => q.label)).toEqual(['acme']);
    expect(tiktokQueries(Array.from({ length: 9 }, (_, i) => ({ type: 'keyword', value: `q${i}`, label: `q${i}` }))).length).toBe(4);
  });

  it('never calls the TikTok collector when the option is off', async () => {
    const tiktok = spy();
    const c = collectorsFor(tiktok);
    const { stats } = await search('tt-off', { showSeen: false }, c);
    expect(tiktok.calls).toEqual([]);
    expect(stats.tiktok).toBeUndefined();
    expect(c.instagram.calls.length).toBeGreaterThan(0);
    expect(c.meta.calls.length).toBeGreaterThan(0);
  });

  it('runs TikTok when on, and a TikTok failure does not fail the search or the other sources', async () => {
    const tiktok = spy(async () => {
      throw Object.assign(new Error('TikTok showed a captcha'), { code: 'TIKTOK_CAPTCHA', fatal: true });
    });
    const c = collectorsFor(tiktok);
    const { stats, product } = await search('tt-on', { showSeen: false, tiktok: true }, c);
    expect(tiktok.calls).toEqual(['acme bottle']); // fatal error stops TikTok after the first query
    expect(stats.tiktok).toMatchObject({ platform: 'tiktok', optional: true, target: 10, error: 'TikTok showed a captcha' });
    expect(stats.instagram.error).toBeNull();
    expect(stats.meta.error).toBeNull();
    expect(c.instagram.calls.length).toBeGreaterThan(0);
    expect(product.tiktokQueries).toEqual(['acme bottle', 'acme bottle review']);
  });
});
