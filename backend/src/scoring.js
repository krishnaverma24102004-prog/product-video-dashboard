const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/**
 * Map a CLIP cosine similarity to 0-100. Unrelated images sit around 0.45-0.60 with
 * clip-vit-base-patch32, near-identical products above ~0.90, so we stretch that band.
 * Text->image cosines are much lower (~0.15-0.35), hence the separate band.
 */
export function clipToScore(cos, mode = 'image') {
  const [lo, hi] = mode === 'text' ? [0.17, 0.32] : [0.55, 0.9];
  return Math.round(clamp(((cos - lo) / (hi - lo)) * 100));
}

/** Bumped whenever combineScores changes meaning. v1 = round(0.65*vlm + 0.35*clip). */
export const SCORING_VERSION = 2;

/**
 * Gemini judge rubric anchors (vision/gemini.js judgeCandidates): 90-100 same product clearly
 * visible; 70-89 very close match; 40-69 same category / details differ or unclear; 0-39 different
 * product. These are properties of the VLM's scale, not of the acceptance threshold.
 */
export const VLM_EXACT_FROM = 60; // below this Gemini is saying "not (verifiably) the exact product"
export const VLM_CONFIDENT_AT = 80; // at/above this Gemini fully owns the score

/**
 * Final 0-100 integer score (SCORING_VERSION 2).
 *
 *   s     = clamp((vlm - 60) / 20, 0, 1)                      Gemini confidence: 0 at vlm<=60, 1 at vlm>=80
 *   w     = 0.65 + 0.35 * s                                   weight on Gemini: 0.65 .. 1.0
 *   base  = w * vlm + (1 - w) * clip
 *   bonus = s * min(5, max(0, (clip - 60) / 8))               CLIP corroboration, up to +5, only for Gemini-positive
 *   score = base + bonus
 *   if vlm < 60: score = min(score, vlm - 10)                 "same category"/"different product" verdicts can
 *                                                             never be lifted by CLIP (cap below the verdict)
 *   score = clamp(round(score), 0, 100)
 *
 * Why: CLIP compares one thumbnail with a packshot and is near 0 for generic products (powder, pouch)
 * even when Gemini confirms the exact product, so a fixed 35% CLIP weight rejected real matches
 * (vlm 85 clip 0 -> 55 in v1, now 85). As Gemini's confidence drops into its "unclear" band (60-79)
 * CLIP regains up to a 35% say and can tip borderline verdicts either way. Below 60 Gemini is not
 * claiming the exact product, so high CLIP (which only measures look-alike-ness) cannot create an
 * exact match (vlm 55 clip 100 -> 71 in v1, now 45).
 *
 * Missing signals: both null -> 0; vlm null -> clip (callers normally use clipOnlyScore instead);
 * clip null -> vlm, still capped at vlm-10 when vlm < 60.
 */
export function combineScores({ clip, vlm }) {
  if (vlm == null && clip == null) return 0;
  if (vlm == null) return Math.round(clamp(clip));
  const v = clamp(vlm);
  let score;
  if (clip == null) {
    score = v;
  } else {
    const c = clamp(clip);
    const s = clamp((v - VLM_EXACT_FROM) / (VLM_CONFIDENT_AT - VLM_EXACT_FROM), 0, 1);
    const w = 0.65 + 0.35 * s;
    score = w * v + (1 - w) * c + s * Math.min(5, Math.max(0, (c - 60) / 8));
  }
  if (v < VLM_EXACT_FROM) score = Math.min(score, v - 10);
  return Math.round(clamp(score));
}

/**
 * 0-100: how many product terms appear in the caption/advertiser name. The brand (first term) counts double.
 * Only used when there is no vision-model verdict, to rescue lifestyle frames CLIP undervalues.
 */
export function textRelevance(text, terms = []) {
  if (!terms.length) return 0;
  const hay = ` ${String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  let got = 0;
  let total = 0;
  terms.forEach((t, i) => {
    const w = i === 0 ? 2 : 1;
    total += w;
    if (hay.includes(` ${t.toLowerCase()} `) || hay.includes(` ${t.toLowerCase()}s `)) got += w;
  });
  return Math.round((got / total) * 100);
}

/** CLIP-only score with a bounded text boost: text can lift a visual match, never create one from nothing. */
export function clipOnlyScore(clip, text) {
  if (clip == null) return Math.round(text * 0.4);
  return Math.round(Math.min(100, clip + (text / 100) * Math.min(35, 15 + clip)));
}

export function isBelowThreshold(score, threshold) {
  return score < threshold;
}

export function fallbackReason({ clip, mode, text = 0 }) {
  const kind = mode === 'text' ? 'text-to-frame' : 'visual';
  const band = clip >= 75 ? 'strong' : clip >= 50 ? 'moderate' : 'weak';
  const cap = text >= 60 ? '; caption names the product' : text > 0 ? '; caption partly matches' : '';
  return `${band} ${kind} similarity (CLIP ${clip}/100)${cap}; no vision-model verdict`;
}
