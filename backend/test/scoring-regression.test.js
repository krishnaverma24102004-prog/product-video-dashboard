import { describe, expect, it } from 'vitest';
import { clipToScore, combineScores, clipOnlyScore, isBelowThreshold } from '../src/scoring.js';

// Combinations taken from stored search_videos rows (see scripts/rescore-report.js).
const TH = 50;
const accepted = (clip, vlm, th = TH) => !isBelowThreshold(combineScores({ clip, vlm }), th);

describe('regression: Gemini-confirmed matches are not sunk by low CLIP', () => {
  it.each([
    [0, 85], // whey pouch, v1 -> 55
    [11, 95], // v1 -> 66
    [0, 75], // "Fuel One whey protein powder pouch and container", v1 -> 49 (rejected)
    [0, 70], // "woman holding an Own brand protein pouch and container", v1 -> 46 (rejected)
  ])('clip %i vlm %i is accepted at threshold 50', (clip, vlm) => {
    expect(accepted(clip, vlm)).toBe(true);
  });
  it('exact scores', () => {
    expect(combineScores({ clip: 0, vlm: 85 })).toBe(85);
    expect(combineScores({ clip: 11, vlm: 95 })).toBe(95);
    expect(combineScores({ clip: 0, vlm: 75 })).toBe(68);
    expect(combineScores({ clip: 0, vlm: 70 })).toBe(58);
  });
});

describe('regression: weak Gemini verdicts are not rescued by high CLIP', () => {
  it.each([
    [90, 30], // different product
    [60, 30], // "chocolate smoothie instead of ..."
    [100, 55], // "Homemade dark chocolate bar, similar category", v1 -> 71
    [100, 50], // "Different brand whey protein tub shown", v1 -> 68
    [100, 59],
    [100, 0],
  ])('clip %i vlm %i is rejected at threshold 50', (clip, vlm) => {
    expect(accepted(clip, vlm)).toBe(false);
  });
  it('a sub-60 verdict is capped at vlm-10 whatever CLIP says', () => {
    for (const vlm of [0, 10, 30, 39, 40, 45, 50, 55, 59]) {
      for (const clip of [0, 50, 100, null]) {
        expect(combineScores({ clip, vlm })).toBeLessThanOrEqual(Math.max(0, vlm - 10));
      }
    }
  });
});

describe('borderline: Gemini 60-69 ("similar / unclear") needs CLIP corroboration', () => {
  it('vlm 60 behaves like the v1 blend: CLIP decides', () => {
    expect(combineScores({ clip: 0, vlm: 60 })).toBe(39); // "same category ... different brand" -> rejected
    expect(combineScores({ clip: 31, vlm: 60 })).toBe(50); // just accepted
    expect(combineScores({ clip: 30, vlm: 60 })).toBe(50);
    expect(combineScores({ clip: 28, vlm: 60 })).toBe(49);
    expect(combineScores({ clip: 56, vlm: 60 })).toBe(59);
  });
  it('vlm 65 with no CLIP support stays below 50; CLIP weight shrinks as vlm rises', () => {
    expect(combineScores({ clip: 0, vlm: 65 })).toBe(48);
    expect(accepted(0, 65)).toBe(false);
    expect(accepted(10, 65)).toBe(true);
    expect(accepted(0, 67)).toBe(true); // crossover with zero CLIP is ~vlm 66-67
  });
  it('honours a stricter configurable threshold', () => {
    expect(accepted(0, 70, 60)).toBe(false);
    expect(accepted(0, 85, 60)).toBe(true);
    expect(accepted(100, 55, 45)).toBe(true); // threshold is the caller's choice, not hard-coded
  });
});

describe('CLIP-only fallback (no vlm) is unchanged', () => {
  it('uses clipOnlyScore semantics', () => {
    expect(clipOnlyScore(60, 0)).toBe(60);
    expect(clipOnlyScore(0, 100)).toBe(15);
    expect(clipOnlyScore(null, 100)).toBe(40);
    expect(clipOnlyScore(49, 100)).toBe(84);
  });
  it('combineScores with vlm null returns CLIP as-is', () => {
    expect(combineScores({ clip: 73, vlm: null })).toBe(73);
    expect(combineScores({ clip: 0, vlm: null })).toBe(0);
  });
});

describe('text-only reference (clipToScore text band) feeding the formula', () => {
  it('low text-to-frame CLIP does not sink a confident Gemini match', () => {
    const clip = clipToScore(0.2, 'text'); // 20
    expect(clip).toBe(20);
    expect(accepted(clip, 85)).toBe(true);
  });
  it('high text-to-frame CLIP does not lift a same-category verdict', () => {
    const clip = clipToScore(0.3, 'text'); // 87
    expect(accepted(clip, 50)).toBe(false);
    expect(accepted(clipToScore(0.32, 'text'), 75)).toBe(true);
  });
});

describe('missing model scores', () => {
  it('handles null/undefined combinations', () => {
    expect(combineScores({ clip: null, vlm: null })).toBe(0);
    expect(combineScores({ clip: undefined, vlm: undefined })).toBe(0);
    expect(combineScores({ clip: null, vlm: 95 })).toBe(95);
    expect(combineScores({ clip: null, vlm: 30 })).toBe(20);
    expect(combineScores({ clip: 44, vlm: undefined })).toBe(44);
  });
});

describe('invariants', () => {
  const vals = Array.from({ length: 101 }, (_, i) => i);
  it('output is always an integer in 0-100, including out-of-range inputs', () => {
    for (const clip of [...vals, null, -20, 140]) {
      for (const vlm of [...vals, null, -5, 120]) {
        const s = combineScores({ clip, vlm });
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(100);
      }
    }
  });
  it('is monotonic non-decreasing in vlm for every fixed clip', () => {
    for (const clip of [...vals, null]) {
      let prev = -1;
      for (const vlm of vals) {
        const s = combineScores({ clip, vlm });
        expect(s).toBeGreaterThanOrEqual(prev);
        prev = s;
      }
    }
  });
  it('is monotonic non-decreasing in clip for every fixed vlm', () => {
    for (const vlm of vals) {
      let prev = -1;
      for (const clip of vals) {
        const s = combineScores({ clip, vlm });
        expect(s).toBeGreaterThanOrEqual(prev);
        prev = s;
      }
    }
  });
});
