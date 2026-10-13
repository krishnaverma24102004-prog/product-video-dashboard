/**
 * Product identity: which brand/model a search is about, where that knowledge came from, and
 * whether it is verified. Exact-product matching (queries and judging) keys off this.
 *
 * brandSource:
 *   page     - product page JSON-LD / site name (authoritative)
 *   named    - typed by the user (authoritative)
 *   visible  - logo or text readable on the product photo (authoritative)
 *   inferred - recognised from the design only (NOT verified: look-alikes are common)
 *   unknown  - no brand known; never invent one
 */
const VERIFIED_SOURCES = new Set(['page', 'named', 'visible']);
const UNKNOWN = /^(unknown|none|n\/a|unbranded|generic|-)?$/i;

const clean = (s) => (typeof s === 'string' && !UNKNOWN.test(s.trim()) ? s.trim() : null);

export function normalizeIdentity(product = {}, attrs = {}) {
  const pageBrand = clean(product.brand);
  const aiBrand = clean(attrs.brand);
  let brand = pageBrand || aiBrand;
  let brandSource = pageBrand ? 'page' : aiBrand ? attrs.brandSource || 'inferred' : 'unknown';
  if (!['page', 'named', 'visible', 'inferred'].includes(brandSource)) brandSource = brand ? 'inferred' : 'unknown';
  if (!brand) brandSource = 'unknown';
  const model = clean(attrs.model);
  const name = clean(attrs.correctedName) || clean(product.title) || [brand, model].filter(Boolean).join(' ') || null;
  return {
    brand,
    brandKnown: Boolean(brand),
    brandSource,
    model,
    name,
    verified: Boolean(brand) && VERIFIED_SOURCES.has(brandSource),
    features: (attrs.distinctiveFeatures || []).filter((f) => typeof f === 'string' && f.trim()).slice(0, 6),
  };
}

const norm = (s) => ` ${String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** "Ray-Ban" -> ["ray ban", "rayban"]; matching is on word boundaries of normalised text. */
export function brandVariants(brand) {
  if (!brand) return [];
  const spaced = norm(brand).trim();
  return [...new Set([spaced, spaced.replace(/ /g, '')])].filter((v) => v.length >= 2);
}

export function mentionsBrand(text, identity) {
  if (!identity?.brandKnown) return false;
  const hay = norm(text);
  const squashed = hay.replace(/ /g, '');
  return brandVariants(identity.brand).some((v) => hay.includes(` ${v} `) || (v.length >= 5 && squashed.includes(v)));
}

// Everyday product words that competitors use too: a caption saying "classic clog" proves nothing about Crocs.
export const GENERIC_MODEL_WORDS = new Set(('classic original new pro max mini plus lite ultra air one edition series model collection '
  + 'clog clogs shoe shoes sneaker sneakers runner runners boot boots sandal sandals slide slides tee shirt hoodie jacket bag '
  + 'bottle tumbler cup mug phone case watch earbuds headphones sunglasses glasses frame cream serum powder bar protein '
  + 'tree black white red blue green pink grey gray '
  // trademarks that sellers use generically for a style ("wayfarer sunglasses")
  + 'wayfarer aviator').split(' '));

/** Model tokens worth checking ("Airwrap", "Wayfarer", "15"), ignoring the brand itself. */
export function mentionsModel(text, identity) {
  if (!identity?.model) return false;
  const tokens = norm(identity.model).trim().split(' ').filter((t) => t.length >= 2 && !brandVariants(identity.brand).includes(t));
  if (!tokens.length) return false;
  const hay = norm(text);
  return tokens.every((t) => hay.includes(` ${t} `));
}

/**
 * A model name is evidence of the brand only when it is distinctive: "iPhone 15", "Airwrap", "Wayfarer" imply
 * their brand; "Classic Clog" or "Tree Runner" do not (every look-alike seller uses those words).
 */
export function mentionsDistinctiveModel(text, identity) {
  if (!mentionsModel(text, identity)) return false;
  return norm(identity.model).trim().split(' ').some((t) => t.length >= 4 && !/^\d+$/.test(t) && !GENERIC_MODEL_WORDS.has(t));
}

const MODEL_STOPWORDS = new Set(['the', 'and', 'with', 'for', 'of', 'by', 'in', 'an', 'oz', 'ml']);

/** Model words without the brand or filler: "The Quencher ProTour Flip Straw Tumbler" -> quencher protour flip straw tumbler. */
export function modelTokens(identity) {
  if (!identity?.model) return [];
  const brandWords = new Set(brandVariants(identity.brand).flatMap((v) => v.split(' ')));
  return norm(identity.model).trim().split(' ').filter((t) => t.length >= 2 && !brandWords.has(t) && !MODEL_STOPWORDS.has(t));
}

/** The model words that separate it from sibling lines (numbers kept: "15" matters for "iPhone 15"). */
export function distinctiveModelTokens(identity) {
  return modelTokens(identity).filter((t) => !GENERIC_MODEL_WORDS.has(t));
}

/**
 * Whether text names THIS model rather than just the brand: the full model name, or a strict majority of its
 * distinctive words ("Stanley ProTour flip straw" names "The Quencher ProTour Flip Straw Tumbler";
 * "Stanley Quencher H2.0" does not).
 */
export function confirmsModel(text, identity) {
  if (mentionsModel(text, identity) || mentionsDistinctiveModel(text, identity)) return true;
  const dist = distinctiveModelTokens(identity);
  if (!dist.length) return false;
  const hay = norm(text);
  const hits = dist.filter((t) => hay.includes(` ${t} `)).length;
  return hits * 2 > dist.length;
}
