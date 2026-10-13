import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// config is read at import time: fake key, one primary + one lite model, no RPM spacing, throwaway DB
process.env.GEMINI_API_KEY = 'test-key-not-real';
process.env.GEMINI_MODEL = 'm-primary';
process.env.GEMINI_FALLBACK_MODELS = 'm-flash-lite';
process.env.GEMINI_RPM = '6000000';
process.env.DB_PATH = path.join(os.tmpdir(), `pvd-exact-test-${process.pid}-${Date.now()}.db`);
process.env.LOG_LEVEL = 'silent';

let g, brain, verdict, identityMod, scoring, store, db, jpeg;
beforeAll(async () => {
  g = await import('../src/vision/gemini.js');
  brain = await import('../src/vision/brain.js');
  verdict = await import('../src/vision/verdict.js');
  identityMod = await import('../src/vision/identity.js');
  scoring = await import('../src/scoring.js');
  ({ store, db } = await import('../src/db.js'));
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#888' } }).jpeg().toBuffer();
});
beforeEach(() => g.resetModelHealth());
afterEach(() => vi.unstubAllGlobals());

const resp = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const ok = (obj) => resp(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const modelOf = (url) => /models\/([^:]+):/.exec(url)[1];
function stubFetch(handler) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ model: modelOf(url), body: JSON.parse(init.body) });
    return handler(modelOf(url), calls.length);
  }));
  return calls;
}

// The attributes Gemini-text actually produced for "crocs classic clog" in the live evaluation (generic Meta queries)
const crocsAttrs = {
  correctedName: 'Crocs Classic Clog', brand: 'Crocs', brandSource: 'named', model: 'Classic Clog',
  productType: 'clog', colors: ['black'], distinctiveFeatures: ['ventilation holes', 'heel strap'],
  metaQueries: ['comfortable casual clogs', 'lightweight everyday footwear', 'crocs classic clog sale'],
  instagramQueries: ['crocs classic clog', 'comfy clogs'], hashtags: ['comfyshoes', 'crocs', 'crocsclassic'],
};
const crocsId = () => identityMod.normalizeIdentity({ title: 'crocs classic clog' }, crocsAttrs);
const final = (vlm, clip) => scoring.combineScores({ vlm, clip });

describe('branded Meta query generation', () => {
  it('keeps the brand in every Meta query and drops generic category phrases', () => {
    const { meta, identity } = brain.buildQueries({ title: 'crocs classic clog' }, crocsAttrs);
    expect(identity).toMatchObject({ brand: 'Crocs', model: 'Classic Clog', verified: true });
    expect(meta[0].value).toBe('Crocs Classic Clog');
    for (const q of meta) expect(q.value.toLowerCase()).toContain('crocs');
    const all = meta.map((q) => q.value.toLowerCase());
    expect(all).not.toContain('comfortable casual clogs');
    expect(all).not.toContain('lightweight everyday footwear');
    // controlled variants are present, and still branded
    expect(all).toContain('crocs classic clog black');
    expect(all).toContain('crocs classic clog review');
  });

  it('tries broad branded queries (brand + type, brand) before review/sale suffixes', () => {
    const all = brain.buildQueries({ title: 'crocs classic clog' }, crocsAttrs).meta.map((q) => q.value.toLowerCase());
    expect(all.indexOf('crocs clog')).toBeGreaterThan(0);
    expect(all.indexOf('crocs clog')).toBeLessThan(all.indexOf('crocs classic clog review'));
    expect(all.indexOf('crocs')).toBeLessThan(all.indexOf('crocs classic clog review'));
    expect(all.indexOf('crocs')).toBeLessThan(8); // reachable within the default 8 query rounds
  });

  it('adds the brand to a brand-less model name and handles hyphenated brands', () => {
    const { meta } = brain.buildQueries({ title: 'ray ban wayfarer' }, {
      correctedName: 'Ray-Ban Wayfarer Sunglasses', brand: 'Ray-Ban', brandSource: 'named', model: 'Wayfarer',
      metaQueries: ['designer sunglasses sale', 'rayban wayfarer classic'], productType: 'sunglasses',
    });
    expect(meta[0].value).toBe('Ray-Ban Wayfarer');
    expect(meta.map((q) => q.value)).toContain('rayban wayfarer classic'); // squashed spelling counts as branded
    expect(meta.map((q) => q.value)).not.toContain('designer sunglasses sale');
  });

  it('puts branded Instagram phrases and hashtags before unbranded ones', () => {
    const { instagram } = brain.buildQueries({ title: 'crocs classic clog' }, crocsAttrs);
    const values = instagram.map((q) => q.value);
    expect(values[0]).toBe('crocsclassicclog');
    expect(values.indexOf('crocs')).toBeLessThan(values.indexOf('comfyshoes'));
    expect(values.indexOf('comfy clogs')).toBeGreaterThan(values.indexOf('Crocs Classic Clog'));
  });
});

describe('unknown brand', () => {
  const genericAttrs = {
    correctedName: 'whey protein', brand: 'unknown', brandSource: 'unknown', model: 'unknown',
    productType: 'protein powder', colors: ['white'], distinctiveFeatures: [], metaQueries: ['whey protein isolate'],
  };
  it('never invents a brand and marks the identity unverified', () => {
    const id = identityMod.normalizeIdentity({ title: 'whey protien' }, genericAttrs);
    expect(id).toMatchObject({ brand: null, brandKnown: false, brandSource: 'unknown', verified: false });
    const { meta } = brain.buildQueries({ title: 'whey protien' }, genericAttrs);
    expect(meta[0].value).toBe('whey protein');
  });
  it('labels an exact visual verdict as resemblance only and caps it', () => {
    const id = identityMod.normalizeIdentity({ title: 'whey protein' }, genericAttrs);
    const r = verdict.interpretVerdict({ relation: 'exact', brandMatch: 'unknown', modelMatch: 'unknown', confidence: 100, reason: 'white powder tub' }, { identity: id, clip: 10 });
    expect(r.status).toBe('visual_only');
    expect(r.vlm).toBeLessThanOrEqual(72);
    expect(r.reason).toMatch(/^Visual match \(identity unverified\)/);
  });
  it('treats the page brand as authoritative and an AI "inferred" brand as unverified', () => {
    expect(identityMod.normalizeIdentity({ title: 'Tree Runner', brand: 'Allbirds' }, {})).toMatchObject({ brandSource: 'page', verified: true });
    expect(identityMod.normalizeIdentity({ title: '' }, { brand: 'Allbirds', brandSource: 'inferred' })).toMatchObject({ brandSource: 'inferred', verified: false });
  });
});

describe('exact-product judging', () => {
  const ctx = (over = {}) => ({ identity: crocsId(), caption: 'new drop', author: 'shop', clip: 40, judgeModel: 'm-primary', ...over });

  it('accepts an evidenced exact match even with low CLIP', () => {
    const r = verdict.interpretVerdict({ relation: 'exact', brandMatch: 'same', modelMatch: 'same', confidence: 95, reason: 'Crocs logo on strap, classic clog' }, ctx({ clip: 0 }));
    expect(r).toMatchObject({ status: 'ok', relation: 'exact' });
    expect(final(r.vlm, 0)).toBeGreaterThanOrEqual(80);
    expect(r.reason).toMatch(/^Exact match:/);
  });

  it('rejects a wrong-brand competitor however similar it looks', () => {
    const r = verdict.interpretVerdict({ relation: 'competitor', brandMatch: 'different', modelMatch: 'unknown', confidence: 90, reason: 'cloud clog from another brand' }, ctx({ clip: 95 }));
    expect(final(r.vlm, 95)).toBeLessThan(50);
    expect(r.reason).toMatch(/^Competitor brand:/);
  });

  it('rejects a same-category product of a different model (iPhone 15 Pro for iPhone 15)', () => {
    const iphone = identityMod.normalizeIdentity({ title: 'Apple iPhone 15', brand: 'Apple' }, { model: 'iPhone 15' });
    const r = verdict.interpretVerdict({ relation: 'same_brand_other_model', brandMatch: 'same', modelMatch: 'different', confidence: 90, reason: 'iPhone 15 Pro, triple camera' }, { identity: iphone, caption: 'apple iphone 15 pro', clip: 80 });
    expect(final(r.vlm, 80)).toBeLessThan(50);
  });

  it('rejects accessory ads for the product (live v2 eval: iPhone 15 cases/chargers passed)', () => {
    const iphone = identityMod.normalizeIdentity({ title: 'Apple iPhone 15', brand: 'Apple' }, { model: 'iPhone 15' });
    const ctx2 = { identity: iphone, caption: 'MagSafe case for iPhone 15', clip: 70 };
    const acc = verdict.interpretVerdict({ relation: 'accessory', brandMatch: 'same', modelMatch: 'same', confidence: 95, reason: 'phone case' }, ctx2);
    expect(acc.reason).toMatch(/^Accessory/);
    expect(final(acc.vlm, 70)).toBeLessThan(50);
    // judge says exact but its own reason describes an accessory -> uncertain, rejected
    const mis = verdict.interpretVerdict({ relation: 'exact', brandMatch: 'same', modelMatch: 'same', confidence: 95, reason: 'lens protector for iPhone 15' }, ctx2);
    expect(mis.status).toBe('uncertain');
    // a product shown WITH its own case is still the product
    const ok = verdict.interpretVerdict({ relation: 'exact', brandMatch: 'same', modelMatch: 'same', confidence: 95, reason: 'Ray-Ban Wayfarer with its case' }, { identity: identityMod.normalizeIdentity({ title: 'ray-ban wayfarer' }, { brand: 'Ray-Ban', brandSource: 'named', model: 'Wayfarer' }), caption: 'ray-ban', clip: 70 });
    expect(ok.status).toBe('ok');
  });

  it('treats a verdict that contradicts its explanation as uncertain and rejects it', () => {
    // the live Ray-Ban case: "Shows sunglasses from a different brand" with a high score
    const rayban = identityMod.normalizeIdentity({ title: 'ray-ban wayfarer' }, { brand: 'Ray-Ban', brandSource: 'named', model: 'Wayfarer' });
    for (const v of [
      { relation: 'exact', brandMatch: 'unknown', modelMatch: 'unknown', confidence: 80, reason: 'Shows sunglasses from a different brand.' },
      { relation: 'variant', brandMatch: 'unknown', modelMatch: 'unknown', confidence: 80, reason: 'Black foam clogs, similar to Crocs style.' },
      { relation: 'exact', brandMatch: 'different', modelMatch: 'same', confidence: 95, reason: 'wayfarer shape' },
      { score: 75, reason: 'Dyson dupe multi-styling tool shown in use.' }, // legacy verdict shape
    ]) {
      const r = verdict.interpretVerdict(v, { identity: rayban, caption: 'ray-ban wayfarer', clip: 90 });
      expect(r.status).toBe('uncertain');
      expect(final(r.vlm, 90)).toBeLessThan(50);
      expect(r.reason).toMatch(/^Uncertain/);
    }
  });

  it('keeps colour/size variants of the same model as variants, not contradictions', () => {
    const r = verdict.interpretVerdict({ relation: 'variant', brandMatch: 'same', modelMatch: 'same', confidence: 80, reason: 'Crocs Classic Clog in a different colour' }, ctx({ caption: 'crocs restock' }));
    expect(r.status).toBe('ok');
    expect(final(r.vlm, 40)).toBeGreaterThanOrEqual(50);
  });

  it('does not trust a lite model\'s "same brand" without caption or visual corroboration', () => {
    const v = { relation: 'exact', brandMatch: 'same', modelMatch: 'same', confidence: 95, reason: 'classic clog shown' };
    const lite = verdict.interpretVerdict(v, ctx({ judgeModel: 'gemini-flash-lite-latest', clip: 20 }));
    expect(lite.status).toBe('unverified');
    expect(final(lite.vlm, 20)).toBeLessThan(50);
    // the same verdict with the brand in the caption, or strong visual support, is accepted
    expect(verdict.interpretVerdict(v, ctx({ judgeModel: 'gemini-flash-lite-latest', caption: 'my new Crocs!' })).status).toBe('ok');
    expect(verdict.interpretVerdict(v, ctx({ judgeModel: 'gemini-flash-lite-latest', clip: 70 })).status).toBe('ok');
    // a full model's brandMatch 'same' is enough on its own
    expect(verdict.interpretVerdict(v, ctx({ judgeModel: 'gemini-3.5-flash', clip: 0 })).status).toBe('ok');
  });

  it('accepts a distinctive model name as brand evidence, but not generic model words', () => {
    const iphone = identityMod.normalizeIdentity({ title: 'Apple iPhone 15', brand: 'Apple' }, { model: 'iPhone 15' });
    const v = { relation: 'exact', brandMatch: 'unknown', modelMatch: 'same', confidence: 90, reason: 'same black phone, dual camera' };
    expect(verdict.interpretVerdict(v, { identity: iphone, caption: 'iphone 15 unboxing!', clip: 20, judgeModel: 'gemini-flash-lite-latest' }).status).toBe('ok');
    // "classic clog" is what every look-alike seller writes: not evidence of Crocs
    expect(verdict.interpretVerdict(v, { identity: crocsId(), caption: 'best classic clog for summer', clip: 20 }).status).toBe('unverified');
  });

  it('requires brand evidence when the judge could not see the brand', () => {
    const r = verdict.interpretVerdict({ relation: 'exact', brandMatch: 'unknown', modelMatch: 'unknown', confidence: 90, reason: 'black clog with holes' }, ctx({ caption: 'comfy shoes', clip: 80 }));
    expect(r.status).toBe('unverified');
    expect(final(r.vlm, 80)).toBeLessThan(50);
  });
});

describe('strict variants: sibling model lines are not variants (judge v4)', () => {
  // live eval: Stanley ProTour URL; the judge called Quencher H2.0 / IceFlow tumblers "variant" (~74)
  const protour = () => identityMod.normalizeIdentity(
    { title: 'Stanley The Quencher ProTour Flip Straw Tumbler 30 OZ', brand: 'Stanley 1913' },
    { model: 'The Quencher ProTour Flip Straw Tumbler' },
  );
  const variantClaim = (reason) => ({ relation: 'variant', brandMatch: 'same', modelMatch: 'unknown', confidence: 90, reason });

  it('rejects a "variant" of another Stanley line when the caption does not name the model', () => {
    const r = verdict.interpretVerdict(variantClaim('Stanley tumbler with handle and straw'), { identity: protour(), caption: 'Stanley Quencher H2.0 FlowState in the new spring colours', author: 'stanley1913', clip: 80, judgeModel: 'm-primary' });
    expect(r.status).toBe('unverified');
    expect(r.reason).toMatch(/^Unverified model/);
    expect(final(r.vlm, 80)).toBeLessThan(50);
    expect(verdict.JUDGE_VERSION).toBe(4);
  });

  it('rejects a variant whose own modelMatch is "different"', () => {
    const r = verdict.interpretVerdict({ ...variantClaim('Stanley IceFlow tumbler'), modelMatch: 'different' }, { identity: protour(), caption: 'Stanley ProTour flip straw', clip: 80 });
    expect(r.status).toBe('uncertain');
    expect(final(r.vlm, 80)).toBeLessThan(50);
  });

  it('accepts a ProTour variant when the caption names the model ("Stanley ProTour flip straw")', () => {
    const r = verdict.interpretVerdict(variantClaim('Stanley tumbler, flip straw lid, other colour'), { identity: protour(), caption: 'Stanley ProTour flip straw', author: 'shop', clip: 40, judgeModel: 'm-primary' });
    expect(r.status).toBe('ok');
    expect(final(r.vlm, 40)).toBeGreaterThanOrEqual(50);
  });

  it('accepts a genuine colourway variant with the model named in the caption', () => {
    const af1 = identityMod.normalizeIdentity({ title: 'Nike Air Force 1' }, { brand: 'Nike', brandSource: 'named', model: 'Air Force 1' });
    const r = verdict.interpretVerdict({ relation: 'variant', brandMatch: 'same', modelMatch: 'unknown', confidence: 85, reason: 'Nike Air Force 1 in triple black colourway' }, { identity: af1, caption: 'Nike Air Force 1 triple black restock', clip: 40 });
    expect(r.status).toBe('ok');
    expect(final(r.vlm, 40)).toBeGreaterThanOrEqual(50);
  });

  it('matches model words without the brand or filler, and needs a majority of the distinctive ones', () => {
    expect(identityMod.distinctiveModelTokens(protour())).toEqual(['quencher', 'protour', 'flip', 'straw']);
    expect(identityMod.confirmsModel('Stanley ProTour flip straw', protour())).toBe(true);
    expect(identityMod.confirmsModel('Stanley Quencher H2.0 FlowState', protour())).toBe(false);
    expect(identityMod.confirmsModel('Stanley IceFlow flip straw', protour())).toBe(false);
  });

  it('tells the judge what a variant is and which words identify the model', async () => {
    const calls = stubFetch(() => ok([{ index: 0, relation: 'category', brandMatch: 'same', modelMatch: 'unknown', confidence: 50, reason: 'tumbler' }]));
    const id = protour();
    await g.judgeCandidates({ reference: { text: 'tumbler', name: id.name, identity: id }, candidates: [{ index: 0, caption: 'x', jpeg }], session: g.createVisionSession() });
    const prompt = calls[0].body.contents[0].parts[0].text;
    expect(prompt).toContain('the SAME model name/line, differing ONLY in colour');
    expect(prompt).toContain('"iPhone 15 Plus"');
    expect(prompt).toContain('do NOT use exact or variant');
    expect(prompt).toContain('Model-identifying words: "quencher", "protour", "flip", "straw"');
  });
});

describe('photo-only discovery', () => {
  // what the image prompt returns for a shoe photo without a readable logo
  const shoeAttrs = {
    correctedName: 'Allbirds Tree Runner', brand: 'Allbirds', brandSource: 'inferred', model: 'Tree Runner',
    productType: 'sneaker', colors: ['black'], distinctiveFeatures: ['knit upper', 'white rounded sole'],
    identityConfidence: 75, metaQueries: [], instagramQueries: [],
  };

  it('carries image-derived features into the queries and keeps the identity unverified', () => {
    const { meta, instagram, identity } = brain.buildQueries({ title: 'Allbirds Tree Runner' }, shoeAttrs);
    expect(identity).toMatchObject({ brand: 'Allbirds', brandSource: 'inferred', verified: false, features: ['knit upper', 'white rounded sole'] });
    expect(meta.map((q) => q.value)).toContain('Allbirds Tree Runner knit upper');
    expect(instagram.some((q) => /knit upper/.test(q.value))).toBe(true);
  });

  it('rejects a look-alike without brand evidence and never calls an accepted match verified', () => {
    const id = identityMod.normalizeIdentity({ title: 'Allbirds Tree Runner' }, shoeAttrs);
    const lookalike = verdict.interpretVerdict({ relation: 'exact', brandMatch: 'unknown', modelMatch: 'unknown', confidence: 85, reason: 'very similar black knit sneaker with white sole' }, { identity: id, caption: 'luxury knit sneakers', clip: 70 });
    expect(['uncertain', 'unverified']).toContain(lookalike.status);
    expect(final(lookalike.vlm, 70)).toBeLessThan(50);
    const named = verdict.interpretVerdict({ relation: 'exact', brandMatch: 'unknown', modelMatch: 'unknown', confidence: 90, reason: 'black knit runner with white sole' }, { identity: id, caption: 'my Allbirds tree runners', clip: 30 });
    expect(named.status).toBe('visual_only');
    expect(named.reason).toMatch(/brand inferred, not verified/);
  });

  it('asks the image prompt to separate identity from resemblance', async () => {
    const calls = stubFetch(() => ok({ ...shoeAttrs, possibleIdentities: [], hashtags: [], summary: 's', colors: [], productType: 'sneaker' }));
    await g.analyseProductImage({ jpeg, title: '', session: g.createVisionSession() });
    const prompt = calls[0].body.contents[0].parts[0].text;
    expect(prompt).toContain('"inferred" if you only recognise the design');
    expect(prompt).toContain('distinctiveFeatures');
    expect(calls[0].body.generationConfig.responseSchema.required).toEqual(expect.arrayContaining(['brand', 'brandSource', 'model', 'distinctiveFeatures']));
  });
});

describe('judge pipeline end to end (stubbed Gemini)', () => {
  // scoreWithVlm sends candidates sorted by CLIP (desc), and verdict indices refer to that order
  const candidates = () => [
    { uid: 'a', caption: 'Crocs Classic Clog restock', author: 'crocs', clip: 85, jpeg },
    { uid: 'b', caption: 'best comfy clogs', author: 'shoeshop', clip: 60, jpeg },
    { uid: 'c', caption: 'ray-ban wayfarer', author: 'x', clip: 30, jpeg },
  ];
  const reference = () => ({ mode: 'text', name: 'Crocs Classic Clog', text: 'clog', attrs: crocsAttrs, identity: crocsId(), terms: ['crocs'] });

  it('maps structured verdicts through verdict.js and records the judging model', async () => {
    stubFetch(() => ok([
      { index: 0, relation: 'exact', brandMatch: 'same', modelMatch: 'same', confidence: 95, reason: 'Crocs logo, classic clog' },
      { index: 1, relation: 'exact', brandMatch: 'unknown', modelMatch: 'unknown', confidence: 90, reason: 'Cloud clogs, similar to Crocs style' },
      { index: 2, relation: 'unrelated', brandMatch: 'different', modelMatch: 'unknown', confidence: 99, reason: 'sunglasses' },
    ]));
    const cs = candidates();
    const session = g.createVisionSession();
    await brain.scoreWithVlm(reference(), cs, { session });
    brain.finalizeScores(cs, reference(), 50);
    expect(cs.map((c) => [c.matchStatus, c.below])).toEqual([['ok', false], ['uncertain', true], ['ok', true]]);
    expect(cs[0].judgeModel).toBe('m-primary');
  });

  it('does not accept candidates ranked out of the judge cutoff while the judge works', async () => {
    stubFetch(() => ok([{ index: 0, relation: 'exact', brandMatch: 'same', modelMatch: 'same', confidence: 95, reason: 'Crocs logo, classic clog' }]));
    const cs = candidates();
    await brain.scoreWithVlm(reference(), cs, { session: g.createVisionSession(), max: 1 });
    brain.finalizeScores(cs, reference(), 50);
    expect(cs[0].below).toBe(false);
    // 'b' has CLIP 60 and would pass CLIP-only; ranked out with Gemini healthy -> rejected and labelled
    expect(cs[1]).toMatchObject({ below: true, unjudgedByCap: true });
    expect(cs[1].reason).toMatch(/^Not judged/);
  });

  it('CLIP-only fallback needs the caption to name the model, not just the brand', () => {
    const af1 = identityMod.normalizeIdentity({ title: "nike air force 1 07" }, { brand: 'Nike', brandSource: 'named', model: "Air Force 1 '07" });
    expect(brain.captionNamesModel('Nike Air Force 1 white restock', af1)).toBe(true);
    expect(brain.captionNamesModel('new Nike Air Max 95 drop', af1)).toBe(false);
    expect(brain.captionNamesModel('Salomon XT-6', af1)).toBe(false);
    expect(brain.captionNamesModel('my crocs classic clog', crocsId())).toBe(true);
    expect(brain.captionNamesModel('crocs sale today', crocsId())).toBe(false);
    // brand unknown: nothing to check against
    expect(brain.captionNamesModel('anything', identityMod.normalizeIdentity({ title: 'tee' }, {}))).toBe(true);

    const ref = { mode: 'text', identity: af1, terms: ['nike', 'air', 'force'] };
    const cs = [
      { caption: 'Nike Air Force 1 restock', author: 'shop', clip: 60 },
      { caption: 'Nike Air Max 95 restock', author: 'shop', clip: 60 },
    ];
    brain.finalizeScores(cs, ref, 50);
    expect(cs.map((c) => c.below)).toEqual([false, true]);
    expect(cs[1].reason).toMatch(/^Unverified \(no vision verdict/);
  });

  it('falls back to CLIP-only when every model is out of quota (no verdicts, no extra calls)', async () => {
    const calls = stubFetch(() => resp(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }));
    const cs = candidates();
    const session = g.createVisionSession();
    await brain.scoreWithVlm(reference(), cs, { session });
    brain.finalizeScores(cs, reference(), 50);
    expect(calls).toHaveLength(2); // each configured model once
    expect(session).toMatchObject({ open: true, reason: 'quota' });
    expect(cs.every((c) => c.vlm == null && /no vision-model verdict/.test(c.reason))).toBe(true);
  });
});

describe('historical results are preserved', () => {
  it('saving a new search never rewrites an earlier search\'s match rows, even for the same video', () => {
    const v = (uid, score, reason) => ({ uid, platform: 'meta', videoId: uid, url: `https://x/${uid}`, thumb: 't', score, clip: 50, vlm: 60, reason });
    store.createSearch('old', 'old search', 'keyword', {});
    store.saveResults('old', [v('meta:1', 71, 'v1 reason'), v('meta:2', 40, 'v1 low')]);
    const before = db.prepare("SELECT * FROM search_videos WHERE search_id = 'old' ORDER BY uid").all();
    store.createSearch('new', 'new search', 'keyword', {});
    store.saveResults('new', [v('meta:1', 20, 'Competitor brand: re-judged under v2'), v('meta:3', 90, 'Exact match: x')]);
    const after = db.prepare("SELECT * FROM search_videos WHERE search_id = 'old' ORDER BY uid").all();
    expect(after).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) n FROM search_videos WHERE search_id = 'new'").get().n).toBe(2);
  });
});
