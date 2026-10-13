import crypto from 'node:crypto';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/** Stable ID: platform video id when we have one, else hash of the media URL without its (expiring) query string. */
export function canonicalUid(platform, videoId, mediaUrl = '') {
  if (videoId) return `${platform}:${videoId}`;
  const bare = String(mediaUrl).split('?')[0];
  return `${platform}:h:${sha1(bare).slice(0, 20)}`;
}

export function normalizeText(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same author + same copy = same ad/repost, even when the platform id differs. Short captions are too generic to key on. */
export function textKey(author, caption) {
  // catalog/dynamic ads share an unrendered template ("{{product.name}}") across different products
  if (/\{\{[^}]+\}\}/.test(caption)) return null;
  const t = normalizeText(caption).slice(0, 200);
  if (t.length < 25) return null;
  return sha1(`${normalizeText(author)}|${t}`).slice(0, 20);
}

const POP = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = (i & 1) + t[i >> 1];
  return t;
})();

/** Hamming distance between two equal-length hex hashes. Returns Infinity if either is missing. */
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i += 2) {
    d += POP[parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16)];
  }
  return d;
}

/**
 * Tracks everything already accepted (earlier searches + this one) and decides whether a candidate is new.
 * Checks, cheapest first: id -> author+copy key -> perceptual thumbnail hash within `hashDistance` bits.
 */
export class DedupeIndex {
  constructor({ hashDistance = 5, textHashDistance = 16 } = {}) {
    this.hashDistance = hashDistance;
    // Same copy only means "same ad" when the creative also looks alike: advertisers reuse one caption
    // across many different videos, and those are distinct results.
    this.textHashDistance = textHashDistance;
    this.uids = new Map(); // uid -> 'history' | 'current'
    this.textKeys = new Map(); // textKey -> {origin, hashes: []}
    this.hashes = []; // {hash, origin}
  }

  seed(rows) {
    for (const r of rows) this.#add(r.uid, r.textKey ?? r.text_key, r.phash, 'history');
  }

  hasUid(uid) {
    return this.uids.has(uid);
  }

  /** @returns {{ok:true}|{ok:false, reason:'seen_before'|'duplicate_id'|'duplicate_text'|'near_duplicate'}} */
  tryAdd(c) {
    const origin = this.uids.get(c.uid);
    if (origin) return { ok: false, reason: origin === 'history' ? 'seen_before' : 'duplicate_id' };
    const t = c.textKey && this.textKeys.get(c.textKey);
    if (t) {
      const looksAlike = !c.phash || !t.hashes.length || t.hashes.some((h) => hamming(c.phash, h) <= this.textHashDistance);
      if (looksAlike) return { ok: false, reason: t.origin === 'history' ? 'seen_before' : 'duplicate_text' };
    }
    if (c.phash) {
      for (const h of this.hashes) {
        if (hamming(c.phash, h.hash) <= this.hashDistance) {
          return { ok: false, reason: h.origin === 'history' ? 'seen_before' : 'near_duplicate' };
        }
      }
    }
    this.#add(c.uid, c.textKey, c.phash, 'current');
    return { ok: true };
  }

  #add(uid, tk, ph, origin) {
    this.uids.set(uid, origin);
    if (tk) {
      const entry = this.textKeys.get(tk) ?? { origin, hashes: [] };
      if (ph) entry.hashes.push(ph);
      this.textKeys.set(tk, entry);
    }
    if (ph) this.hashes.push({ hash: ph, origin });
  }
}
