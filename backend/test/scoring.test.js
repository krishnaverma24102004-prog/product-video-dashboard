import { describe, expect, it } from 'vitest';
import { clipToScore, combineScores, isBelowThreshold, fallbackReason, textRelevance, clipOnlyScore, SCORING_VERSION } from '../src/scoring.js';

describe('clipToScore', () => {
  it('stretches the useful cosine band to 0-100 and clamps', () => {
    expect(clipToScore(0.4)).toBe(0);
    expect(clipToScore(0.95)).toBe(100);
    expect(clipToScore(0.725)).toBe(50);
    expect(clipToScore(0.32, 'text')).toBe(100);
    expect(clipToScore(0.1, 'text')).toBe(0);
  });
  it('is monotonic', () => {
    const xs = [0.5, 0.6, 0.7, 0.8, 0.9].map((c) => clipToScore(c));
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });
});

describe('combineScores (SCORING_VERSION 2)', () => {
  it('is version 2', () => {
    expect(SCORING_VERSION).toBe(2);
  });
  it('lets a confident vision verdict own the score (v1 gave round(0.65*90+0.35*40)=73)', () => {
    expect(combineScores({ clip: 40, vlm: 90 })).toBe(90);
    // CLIP corroboration adds at most +5 once Gemini is confident
    expect(combineScores({ clip: 100, vlm: 90 })).toBe(95);
  });
  it('keeps the v1 blend at the bottom of Gemini\'s "unclear" band (vlm 60)', () => {
    expect(combineScores({ clip: 40, vlm: 60 })).toBe(Math.round(0.65 * 60 + 0.35 * 40));
  });
  it('falls back to whichever signal exists', () => {
    expect(combineScores({ clip: 62, vlm: null })).toBe(62);
    expect(combineScores({ clip: null, vlm: 80 })).toBe(80);
    expect(combineScores({ clip: null, vlm: null })).toBe(0);
    // a non-exact verdict stays capped even without CLIP
    expect(combineScores({ clip: null, vlm: 50 })).toBe(40);
  });
});

describe('textRelevance + clipOnlyScore', () => {
  const terms = ['allbirds', 'tree', 'runner'];
  it('weights the brand double and accepts plurals', () => {
    expect(textRelevance('Allbirds Ireland - New Tree Runners are here', terms)).toBe(100);
    expect(textRelevance('Allbirds Canada - Better than leather', terms)).toBe(50);
    expect(textRelevance('random sneaker sale', terms)).toBe(0);
    expect(textRelevance('anything', [])).toBe(0);
  });
  it('text lifts a visual match but cannot create one alone', () => {
    expect(clipOnlyScore(49, 100)).toBeGreaterThanOrEqual(80);
    expect(clipOnlyScore(0, 100)).toBe(15);
    expect(clipOnlyScore(60, 0)).toBe(60);
    expect(clipOnlyScore(null, 100)).toBe(40);
  });
});

describe('threshold + reasons', () => {
  it('marks scores under the threshold', () => {
    expect(isBelowThreshold(49, 50)).toBe(true);
    expect(isBelowThreshold(50, 50)).toBe(false);
  });
  it('explains CLIP-only scores', () => {
    expect(fallbackReason({ clip: 80, mode: 'image' })).toMatch(/strong visual similarity/);
    expect(fallbackReason({ clip: 20, mode: 'text' })).toMatch(/weak text-to-frame/);
  });
});
