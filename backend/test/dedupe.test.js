import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { DedupeIndex, canonicalUid, hamming, textKey } from '../src/dedupe.js';
import { dHash } from '../src/vision/image.js';

describe('canonicalUid', () => {
  it('prefers platform id and ignores expiring query strings on hashed urls', () => {
    expect(canonicalUid('instagram', 'ABC123')).toBe('instagram:ABC123');
    expect(canonicalUid('meta', null, 'https://cdn/x.mp4?sig=1')).toBe(canonicalUid('meta', null, 'https://cdn/x.mp4?sig=2'));
  });
});

describe('hamming', () => {
  it('counts differing bits', () => {
    expect(hamming('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hamming('00000000000000ff', '0000000000000000')).toBe(8);
    expect(hamming('abc', undefined)).toBe(Infinity);
  });
});

describe('textKey', () => {
  it('matches same author + same copy regardless of case/punctuation, ignores short captions', () => {
    const a = textKey('Brand', 'Get 20% off our new oversized graphic tee today!! Limited stock.');
    const b = textKey('brand', 'get 20 off our new oversized graphic tee today limited stock');
    expect(a).toBe(b);
    expect(textKey('brand', 'nice')).toBeNull();
    expect(textKey('Allbirds Ireland', '{{product.name}} - {{product.brand}} shop the new collection now')).toBeNull();
  });
});

describe('DedupeIndex', () => {
  const mk = (uid, extra = {}) => ({ uid, ...extra });

  it('rejects the same id inside one result set', () => {
    const idx = new DedupeIndex();
    expect(idx.tryAdd(mk('a')).ok).toBe(true);
    expect(idx.tryAdd(mk('a'))).toEqual({ ok: false, reason: 'duplicate_id' });
  });

  it('flags videos from earlier searches as seen_before', () => {
    const idx = new DedupeIndex();
    idx.seed([{ uid: 'old', phash: '00000000000000ff', text_key: 'k1' }]);
    expect(idx.tryAdd(mk('old')).reason).toBe('seen_before');
    expect(idx.tryAdd(mk('new', { textKey: 'k1' })).reason).toBe('seen_before');
    expect(idx.tryAdd(mk('new2', { phash: '00000000000000fe' })).reason).toBe('seen_before');
  });

  it('treats same copy as a duplicate only when the creative also looks alike', () => {
    const idx = new DedupeIndex({ hashDistance: 2, textHashDistance: 16 });
    expect(idx.tryAdd(mk('ad1', { textKey: 'copy', phash: '0000000000000000' })).ok).toBe(true);
    // same copy, similar frame (10 bits off, beyond near-dup but within text tolerance) -> same ad
    expect(idx.tryAdd(mk('ad2', { textKey: 'copy', phash: '00000000000003ff' })).reason).toBe('duplicate_text');
    // same copy, completely different video -> distinct creative, kept
    expect(idx.tryAdd(mk('ad3', { textKey: 'copy', phash: 'ffffffffffffffff' })).ok).toBe(true);
  });

  it('catches the same ad under a different id via copy key, and reposts via near-identical hash', () => {
    const idx = new DedupeIndex({ hashDistance: 5 });
    expect(idx.tryAdd(mk('ad1', { textKey: 'same' })).ok).toBe(true);
    expect(idx.tryAdd(mk('ad2', { textKey: 'same' })).reason).toBe('duplicate_text');
    expect(idx.tryAdd(mk('r1', { phash: '0000000000000000' })).ok).toBe(true);
    expect(idx.tryAdd(mk('r2', { phash: '0000000000000007' })).reason).toBe('near_duplicate'); // 3 bits
    expect(idx.tryAdd(mk('r3', { phash: '00000000000000ff' })).ok).toBe(true); // 8 bits: different
  });

  it('dHash survives rescale + recompression (real repost simulation) but separates different images', async () => {
    const gradient = (w, h, flip) =>
      sharp(Buffer.from(Array.from({ length: w * h }, (_, i) => {
        const x = i % w, y = Math.floor(i / w);
        return flip ? 255 - Math.round((x / w) * 255) : Math.round(((x + y) / (w + h)) * 255);
      })), { raw: { width: w, height: h, channels: 1 } });
    const original = await gradient(200, 200, false).jpeg().toBuffer();
    const repost = await sharp(original).resize(120, 120).jpeg({ quality: 40 }).toBuffer();
    const other = await gradient(200, 200, true).jpeg().toBuffer();
    const [h1, h2, h3] = await Promise.all([dHash(original), dHash(repost), dHash(other)]);
    expect(hamming(h1, h2)).toBeLessThanOrEqual(5);
    expect(hamming(h1, h3)).toBeGreaterThan(5);
  });
});
