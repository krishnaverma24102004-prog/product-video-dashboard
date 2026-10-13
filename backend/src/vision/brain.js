import { store } from '../db.js';
import { log } from '../log.js';
import { config } from '../config.js';
import { analyseProductImage, analyseProductText, judgeCandidates, geminiEnabled, createVisionSession, VisionUnavailableError } from './gemini.js';
import { embedImage, embedText, cosine } from './clip.js';
import { toJpeg } from './image.js';
import { clipToScore, combineScores, isBelowThreshold, fallbackReason, textRelevance, clipOnlyScore } from '../scoring.js';
import { normalizeIdentity, mentionsBrand, brandVariants, mentionsModel, mentionsDistinctiveModel, GENERIC_MODEL_WORDS } from './identity.js';
import { interpretVerdict } from './verdict.js';

const STOP = new Set('the a an and or for with of in on to by from new best sale buy online shop free shipping official store men women mens womens'.split(' '));

const uniq = (arr) => [...new Set(arr.filter((s) => typeof s === 'string').map((s) => s.trim()).filter(Boolean))];
const tag = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Heuristic attributes + queries when no vision key is configured (or the call fails). */
/** "Men's Tree Runner - Jet Black (White Sole) | Brand" -> ['tree', 'runner'] */
export function coreWords(title) {
  const main = title.split(/\s[-–|:]\s/)[0].replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  return main
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** Heuristic attributes + queries when no vision key is configured (or the call fails). */
function heuristicAttrs(product) {
  const brand = (product.brand || '').toLowerCase();
  const head = coreWords(product.title).filter((w) => w !== brand).slice(0, 5);
  const core = head.join(' ') || product.title.toLowerCase();
  const short = head.slice(0, 3).join(' ');
  const branded = brand ? `${brand} ${short}` : '';
  return {
    // only the product page can name a brand here; never guess one from the title words
    brand: brand || 'unknown', brandSource: brand ? 'page' : 'unknown', model: 'unknown', distinctiveFeatures: [],
    productType: head.slice(-2).join(' ') || product.title,
    colors: [], prints: [], logos: brand ? [brand] : [], textOnProduct: [], material: '', shape: '',
    summary: [brand, core].filter(Boolean).join(' '),
    instagramQueries: uniq([branded, core, short, brand]),
    metaQueries: uniq([branded, brand, core, short]),
    hashtags: uniq([tag(branded), tag(short), brand && tag(brand), tag(head.slice(-2).join(''))].filter(Boolean)),
    source: 'heuristic',
  };
}

/** Image -> attributes. Cached by image hash so the same product is never re-analysed. */
export async function analyseProduct(product, emit = () => {}, session = undefined) {
  if (!geminiEnabled()) {
    emit('No GEMINI_API_KEY: using keyword heuristics (CLIP still scores frames)');
    return heuristicAttrs(product);
  }
  if (!product.jpeg) {
    const key = `textattrs:v2:${product.title.toLowerCase().trim()}`; // v2: brand/model/features fields
    const cached = store.cacheGet(key);
    if (cached) {
      emit('No product image: using cached text analysis');
      return cached;
    }
    emit('No product image: Gemini is reading the product name instead (add a photo for exact-product matching)');
    try {
      const attrs = { ...(await analyseProductText({ title: product.title, session })), source: 'gemini-text' };
      store.cacheSet(key, attrs);
      if (attrs.correctedName && attrs.correctedName.toLowerCase() !== product.title.toLowerCase()) {
        emit(`Interpreted "${product.title}" as "${attrs.correctedName}"`);
      }
      return attrs;
    } catch (e) {
      log.warn({ err: e.message }, 'text analysis failed, falling back to heuristics');
      emit(`Text analysis failed (${e.message}); using keyword heuristics`);
      return heuristicAttrs(product);
    }
  }
  // the typed name changes the analysis (it is ground truth for identity), so it is part of the key
  const key = `attrs:v3:${product.imageHash}:${product.title.toLowerCase().trim()}`; // v3: brand/model/features fields
  const cached = store.cacheGet(key);
  if (cached) {
    emit('Using cached image analysis');
    return cached;
  }
  try {
    const attrs = { ...(await analyseProductImage({ jpeg: product.jpeg, title: product.title, description: product.description, session })), source: 'gemini' };
    store.cacheSet(key, attrs);
    return attrs;
  } catch (e) {
    log.warn({ err: e.message }, 'image analysis failed, falling back to heuristics');
    emit(`Vision analysis failed (${e.message}); using heuristics`);
    return heuristicAttrs(product);
  }
}

/**
 * Ordered, de-duplicated query lists per platform. Later entries are the "expansion" queries
 * used when earlier ones do not yield enough unique, matching videos.
 */
const withCorrectedName = (product, attrs) => (attrs.correctedName ? { ...product, title: attrs.correctedName } : product);

/**
 * Builds the ordered query lists. Brand + model are kept explicitly whenever known:
 *   Meta (ad copy): exact name -> brand+model -> the model's *branded* suggestions -> controlled branded
 *     variants (colour, distinctive feature, review/sale) -> brand + type -> brand. Unbranded category
 *     phrases ("comfortable casual clogs") are dropped: in the Ad Library they return competitors' ads.
 *   Instagram: the same exact/branded phrases first; unbranded suggestions only as late widening.
 *   Brand unknown: never invent one; use the name/type plus distinctive visual features (photo searches).
 */
export function buildQueries(product, attrs) {
  product = withCorrectedName(product, attrs);
  const identity = normalizeIdentity(product, attrs);
  const h = heuristicAttrs(product);
  const isBranded = (q) => mentionsBrand(q, identity);
  const withBrand = (q) => (identity.brandKnown && q && !isBranded(q) ? `${identity.brand} ${q}` : q);
  const exactName = identity.model
    ? withBrand(identity.model)
    : attrs.correctedName ? withBrand(attrs.correctedName) : h.metaQueries[0] || product.title;
  const color = attrs.colors?.[0];
  const type = attrs.productType && attrs.productType !== product.title ? attrs.productType : '';
  const featureQs = identity.features.slice(0, 2).map((f) => (identity.brandKnown ? `${exactName} ${f}` : `${f} ${type}`.trim()));
  const aiMeta = attrs.metaQueries || [];
  const aiIg = attrs.instagramQueries || [];

  // Broad branded queries (brand + type, brand alone) come before suffix variants: in the Ad Library
  // "X review" / "X sale" mostly return the same ads as "X" (live eval: rounds ran out on them while
  // "Crocs clog" / "Stanley" were never tried). Other-model ads they bring in are rejected by the judge.
  const aiBranded = aiMeta.filter(isBranded);
  const meta = identity.brandKnown
    ? [
        exactName,
        ...aiBranded.slice(0, 2),
        type && withBrand(type),
        color && `${exactName} ${color}`,
        identity.brand,
        ...aiBranded.slice(2),
        ...featureQs.slice(0, 1),
        `${exactName} review`,
        `${exactName} sale`,
      ]
    : [exactName, ...aiMeta, ...featureQs, ...h.metaQueries, type && color ? `${color} ${type}` : ''];

  const igPhrases = identity.brandKnown
    ? [exactName, ...aiIg.filter(isBranded), ...h.instagramQueries.filter(isBranded), ...featureQs, ...aiIg.filter((q) => !isBranded(q))]
    : [exactName, ...aiIg, ...featureQs, ...h.instagramQueries];
  const ig = [];
  for (const q of uniq(igPhrases)) {
    ig.push({ type: 'hashtag', value: tag(q), label: `#${tag(q)}` });
    ig.push({ type: 'keyword', value: q, label: q });
  }
  const brandTags = brandVariants(identity.brand).map((v) => v.replace(/ /g, ''));
  const hashtags = (attrs.hashtags || []).map(tag);
  const sortedTags = identity.brandKnown ? [...hashtags.filter((t) => brandTags.some((b) => t.includes(b))), ...hashtags.filter((t) => !brandTags.some((b) => t.includes(b)))] : hashtags;
  for (const t of sortedTags) ig.push({ type: 'hashtag', value: t, label: `#${t}` });
  // widening: creator-style variants of the exact phrase, used only when earlier queries fall short
  for (const m of ['review', 'haul', 'unboxing']) {
    const q = `${exactName} ${m}`.toLowerCase();
    ig.push({ type: 'keyword', value: q, label: q });
    ig.push({ type: 'hashtag', value: tag(q), label: `#${tag(q)}` });
  }

  const dedupeQ = (list) => {
    const seen = new Set();
    return list.filter((q) => q.value.length >= 3 && !seen.has(q.type + q.value.toLowerCase()) && seen.add(q.type + q.value.toLowerCase()));
  };
  return {
    identity,
    instagram: dedupeQ(ig),
    meta: dedupeQ(uniq(meta).map((q) => ({ type: 'keyword', value: q, label: q }))),
  };
}

/** Builds the comparison reference: image embedding when we have a photo, else a text embedding. */
export async function buildReference(product, attrs) {
  product = withCorrectedName(product, attrs);
  const identity = normalizeIdentity(product, attrs);
  const text = [attrs.summary || product.title, attrs.colors?.join(' '), attrs.productType].filter(Boolean).join(', ');
  const brand = (identity.brand || '').toLowerCase();
  const terms = uniq([brand, ...coreWords(product.title).filter((w) => w !== brand)]).slice(0, 5);
  const name = product.title;
  if (product.jpeg) {
    return { mode: 'image', jpeg: product.jpeg, attrs, text, name, terms, identity, embedding: await embedImage(product.jpeg) };
  }
  return { mode: 'text', attrs, text, name, terms, identity, embedding: await embedText(`a photo of ${text}`) };
}

/** CLIP score for every candidate thumbnail (cheap, local). Mutates candidates: sets .clip */
export async function scoreWithClip(reference, candidates) {
  for (const c of candidates) {
    try {
      const emb = await embedImage(c.jpeg);
      c.clip = clipToScore(cosine(reference.embedding, emb), reference.mode);
    } catch (e) {
      log.debug({ uid: c.uid, err: e.message }, 'clip failed');
      c.clip = null;
    }
  }
}

/**
 * Vision-model verdicts in small batches (one API call per batch to respect free-tier limits).
 * Only candidates whose CLIP score clears `floor` are sent; the rest keep a CLIP-only score.
 */
export async function scoreWithVlm(reference, candidates, { batch = 8, max = 40, session = createVisionSession() } = {}) {
  if (!geminiEnabled()) return;
  // Free-tier quota is the bottleneck, so only the top `max` by CLIP get a vision verdict each round.
  // No absolute CLIP floor: for visually generic products (powders, liquids) CLIP scores everything low,
  // and the vision model (which reads packaging and captions) is exactly what is needed there.
  const ranked = candidates.filter((c) => c.clip != null).sort((a, b) => b.clip - a.clip);
  const eligible = ranked.slice(0, max);
  // Ranked out while the judge was working: not a vision outage, so don't let CLIP + caption alone accept
  // them (live: S24 Ultra case/repair ads scored 69-86 this way). Cleared if the judge later scores them.
  if (session.available()) for (const c of ranked.slice(max)) c.unjudgedByCap = true;
  for (let i = 0; i < eligible.length; i += batch) {
    // breaker open / budget spent / deadline passed: the rest stay CLIP-only without touching the network
    if (!session.available()) break;
    const slice = eligible.slice(i, i + batch);
    try {
      const small = await Promise.all(slice.map((c) => toJpeg(c.jpeg, 384, 70)));
      const verdicts = await judgeCandidates({
        reference: {
          jpeg: reference.jpeg ? await toJpeg(reference.jpeg, 512, 80) : null,
          attrs: reference.attrs, text: reference.text, name: reference.name, identity: reference.identity,
        },
        candidates: slice.map((c, k) => ({ index: k, caption: c.caption, jpeg: small[k] })),
        session,
      });
      for (const v of Array.isArray(verdicts) ? verdicts : []) {
        const c = slice[v?.index];
        if (!c) continue;
        // the judge classifies; verdict.js scores, checks for self-contradiction and requires brand evidence
        const r = interpretVerdict(v, { identity: reference.identity, caption: c.caption, author: c.author, clip: c.clip, judgeModel: session.lastModel });
        Object.assign(c, { vlm: r.vlm, vlmReason: r.reason, relation: r.relation, matchStatus: r.status, judgeModel: session.lastModel ?? null });
      }
    } catch (e) {
      if (e instanceof VisionUnavailableError) {
        log.warn({ reason: e.reason }, 'vision unavailable; remaining candidates scored CLIP-only');
        break;
      }
      session.batchErrors++;
      log.warn({ err: e.message }, 'vlm batch failed; falling back to CLIP-only for this batch');
    }
  }
}

/**
 * True unless the brand AND model are known and the text fails to name the model. The model counts as named when
 * all its tokens appear, or all of its distinctive ones (>= 3 chars, not generic: "force" in "Air Force 1 '07").
 */
export function captionNamesModel(text, identity) {
  if (!identity?.brandKnown || !identity.model) return true;
  if (!mentionsBrand(text, identity) && !mentionsDistinctiveModel(text, identity)) return false;
  if (mentionsModel(text, identity)) return true;
  const distinctive = identity.model.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 && !GENERIC_MODEL_WORDS.has(t) && !brandVariants(identity.brand).includes(t));
  const hay = ` ${String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return distinctive.length > 0 && distinctive.every((t) => hay.includes(` ${t} `));
}

export function finalizeScores(candidates, reference, threshold) {
  for (const c of candidates) {
    if (c.vlm != null) {
      c.score = combineScores({ clip: c.clip, vlm: c.vlm });
      c.reason = c.vlmReason;
    } else {
      const text = textRelevance(`${c.author} ${c.caption}`, reference.terms);
      c.score = clipOnlyScore(c.clip, text);
      c.reason = fallbackReason({ clip: c.clip ?? 0, mode: reference.mode, text });
      if (c.unjudgedByCap) {
        c.score = Math.min(c.score, threshold - 1);
        c.reason = `Not judged (ranked below the vision-model cutoff for this round): ${c.reason}`;
      } else if (!captionNamesModel(`${c.author} ${c.caption}`, reference.identity)) {
        // No verdict (vision outage): CLIP can't tell an Air Max from an Air Force 1, and a brand-only caption
        // ("Nike") proves nothing about the model. Live: Gemini 503'd mid-search and Air Max / Salomon passed.
        c.score = Math.min(c.score, threshold - 1);
        c.reason = `Unverified (no vision verdict and the caption doesn't name the ${reference.identity.model}): ${c.reason}`;
      }
    }
    c.below = isBelowThreshold(c.score, threshold);
  }
}
