import { describe, expect, it } from 'vitest';
import { buildQueries, coreWords } from '../src/vision/brain.js';

describe('coreWords', () => {
  it('drops variant suffixes, possessives and stopwords', () => {
    expect(coreWords("Men's Tree Runner - Jet Black (White Sole)")).toEqual(['tree', 'runner']);
    expect(coreWords('Oversized Graphic Tee | Brand')).toEqual(['oversized', 'graphic', 'tee']);
  });
});

describe('buildQueries (heuristic path)', () => {
  const product = { title: "Men's Tree Runner - Jet Black (White Sole)", brand: 'allbirds' };
  const empty = {};

  it('leads with the branded phrase and keeps expansion queries for widening', () => {
    const { instagram, meta } = buildQueries(product, empty);
    expect(meta[0].value).toBe('allbirds tree runner');
    expect(meta.length).toBeGreaterThanOrEqual(4);
    expect(instagram[0]).toMatchObject({ type: 'hashtag', value: 'allbirdstreerunner' });
    expect(instagram.some((q) => q.value.endsWith('review'))).toBe(true);
  });

  it('never repeats a query', () => {
    const { instagram, meta } = buildQueries(product, empty);
    for (const list of [instagram, meta]) {
      const keys = list.map((q) => q.type + q.value);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('uses the corrected product name for fallback queries (no typos leak through)', () => {
    const { meta, instagram } = buildQueries({ title: 'whey protien' }, { correctedName: 'whey protein' });
    const all = [...meta, ...instagram].map((q) => q.value).join(' ');
    expect(all).toContain('whey protein');
    expect(all).not.toContain('protien');
  });

  it('keeps the exact branded name first, then the model\'s branded suggestions', () => {
    const { meta } = buildQueries(product, { metaQueries: ['allbirds tree runners black'], productType: 'sneakers', colors: ['black'] });
    expect(meta[0].value).toBe('allbirds tree runner');
    expect(meta[1].value).toBe('allbirds tree runners black');
  });
});
