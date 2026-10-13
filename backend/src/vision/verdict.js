import { confirmsModel, mentionsBrand, mentionsDistinctiveModel, modelTokens } from './identity.js';

/**
 * Turns one structured judge verdict into the 0-100 `vlm` score that scoring.js combines with CLIP.
 *
 * The judge classifies; this code scores. The model never sets the number directly, so a reason
 * like "different brand" can't ride along with a 90. JUDGE_VERSION is recorded in search stats.
 *
 *   relation                 vlm (by judge confidence 0-100)    accepted at threshold 50?
 *   exact                    80 .. 100                          yes
 *   variant (colour/size)    62 .. 75                           usually (CLIP can tip the low end)
 *   same_brand_other_model   35                                 no   (iPhone 15 Pro for iPhone 15)
 *   competitor               15                                 no   (other brand, however similar)
 *   category                 25                                 no
 *   accessory                20                                 no   (a case/charger FOR the product)
 *   not_visible / unrelated  10 / 5                             no
 *
 * Then, in order:
 *   1. Contradiction: an exact/variant relation whose own fields or explanation say otherwise
 *      (brandMatch 'different', modelMatch 'different', "different brand", "dupe", "-style" ...)
 *      becomes UNCERTAIN, capped at 45 (rejected).
 *   2. Evidence (brand known): exact/variant needs the brand confirmed. Either the judge saw it
 *      (brandMatch 'same') or the caption/advertiser names the brand or a distinctive model name
 *      ("iPhone 15", "Airwrap"; not generic ones like "Classic Clog"). Lite models must also have that
 *      textual or visual corroboration (caption mention or CLIP >= 55); a valid JSON "same" from
 *      a lite model is not enough on its own. Without evidence: UNVERIFIED, capped at 48 (rejected).
 *   3. Brand unknown: exact means visually identical only, capped at 72 and labelled
 *      "identity unverified" so the UI never claims a verified brand/model.
 *   4. Model evidence for variants (multi-word model known): a 'variant' whose modelMatch is only
 *      'unknown' needs the caption/advertiser to name the model (full name, or a majority of its
 *      distinctive words: identity.confirmsModel). Otherwise UNVERIFIED, capped at 48 (rejected):
 *      a same-brand tumbler is not a ProTour "variant" just because it is a Stanley.
 */
// v3: 'accessory' relation (iPhone cases/chargers passed as exact in the v2 live eval)
// v4: strict 'variant' (same model line only) + model-evidence guard; variant with modelMatch 'different' is
//     uncertain (live Stanley ProTour eval: Quencher H2.0 / IceFlow accepted as ProTour variants)
export const JUDGE_VERSION = 4;

export const RELATIONS = ['exact', 'variant', 'same_brand_other_model', 'competitor', 'category', 'accessory', 'unrelated', 'not_visible'];

const LABEL = {
  exact: 'Exact match',
  variant: 'Variant',
  same_brand_other_model: 'Different model',
  competitor: 'Competitor brand',
  category: 'Same category only',
  accessory: 'Accessory, not the product',
  unrelated: 'Unrelated',
  not_visible: 'Product not visible',
};

// Phrases that contradict an exact/variant claim. Colour/size differences are NOT here: those are variants.
const CONTRADICTS = /\b(different|another|other|competing)\s+(brand|maker|manufacturer|model|product|design|style|shoe|phone|device)\b|\bnot\s+(the\s+)?(same|exact|actual|genuine|original)\b|\bnot\s+(a\s+)?[\w-]+\s+(brand|product)\b|\b(dupe|knock-?off|look-?alike|lookalike|imitation|replica|copy of|generic|unbranded|similar to|resembles|inspired)\b|[\w)]-style\b|\bstyle of\b|\binstead of\b|\bcompetitor\b|\baccessor(y|ies)\b|\b(case|cover|protector|charger|cable|strap|skin)s?\s+for\b/i;

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/** Older/partial verdicts ({index, score, reason}) are mapped onto relations so they go through the same checks. */
function relationFromLegacy(score) {
  if (score >= 90) return 'exact';
  if (score >= 70) return 'variant';
  if (score >= 40) return 'category';
  return 'unrelated';
}

export function contradicts(reason) {
  return CONTRADICTS.test(String(reason || ''));
}

/**
 * @param v    judge verdict: {relation, brandMatch, modelMatch, confidence, reason} (or legacy {score, reason})
 * @param ctx  {identity, caption, author, clip, judgeModel}
 * @returns    {vlm, reason, relation, status: 'ok'|'uncertain'|'unverified'|'visual_only'}
 */
export function interpretVerdict(v = {}, ctx = {}) {
  const legacy = !RELATIONS.includes(v.relation);
  const relation = legacy ? relationFromLegacy(Number(v.score) || 0) : v.relation;
  const confidence = clamp(Number(v.confidence ?? v.score ?? 50) || 0);
  const brandMatch = ['same', 'different', 'unknown'].includes(v.brandMatch) ? v.brandMatch : 'unknown';
  const modelMatch = ['same', 'different', 'unknown'].includes(v.modelMatch) ? v.modelMatch : 'unknown';
  const why = String(v.reason || '').trim().slice(0, 160);
  const identity = ctx.identity || {};
  const positive = relation === 'exact' || relation === 'variant';

  let vlm = {
    exact: 80 + 0.2 * confidence,
    variant: 62 + 0.13 * confidence,
    same_brand_other_model: 35,
    competitor: 15,
    category: 25,
    accessory: 20,
    not_visible: 10,
    unrelated: 5,
  }[relation];
  let status = 'ok';
  let label = LABEL[relation];

  if (positive) {
    // a different model is never an exact match nor a variant (colour/size/pack/edition of the SAME model)
    const fieldConflict = brandMatch === 'different' || modelMatch === 'different';
    if (fieldConflict || contradicts(why)) {
      return { vlm: Math.min(vlm, 45), relation, status: 'uncertain', reason: `Uncertain (verdict contradicts explanation): ${why}` };
    }
    if (identity.brandKnown) {
      const text = `${ctx.author || ''} ${ctx.caption || ''}`;
      const textEvidence = mentionsBrand(text, identity) || mentionsDistinctiveModel(text, identity);
      const lite = /lite/i.test(ctx.judgeModel || '');
      const visualSupport = (ctx.clip ?? 0) >= 55;
      const evidence = textEvidence || (brandMatch === 'same' && (!lite || visualSupport));
      if (!evidence) {
        return { vlm: Math.min(vlm, 48), relation, status: 'unverified', reason: `Unverified brand (no ${identity.brand} logo/caption evidence): ${why}` };
      }
      if (relation === 'variant' && modelMatch === 'unknown' && modelTokens(identity).length >= 2 && !confirmsModel(text, identity)) {
        return { vlm: Math.min(vlm, 48), relation, status: 'unverified', reason: `Unverified model (judge could not confirm ${identity.model}; caption does not name it): ${why}` };
      }
      // the brand itself was only inferred from the photo: present as a match, never as verified identity
      if (!identity.verified) {
        status = 'visual_only';
        label = `${label} (brand inferred, not verified)`;
      }
    } else {
      vlm = Math.min(vlm, 72);
      status = 'visual_only';
      label = 'Visual match (identity unverified)';
    }
  }
  return { vlm: Math.round(clamp(vlm)), relation, status, reason: `${label}: ${why}` };
}
