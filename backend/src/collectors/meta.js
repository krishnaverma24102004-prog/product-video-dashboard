import { config } from '../config.js';
import { log } from '../log.js';
import { canonicalUid, textKey } from '../dedupe.js';
import { SourceError, jitter } from '../util.js';
import { newContext, walk, embeddedJson } from './browser.js';

const toMs = (v) => (v ? (v > 1e11 ? v : v * 1000) : null);

/**
 * Extracts video ads from Ad Library payloads. An ad is any object carrying `ad_archive_id` and a
 * `snapshot` that contains at least one video (top-level or inside carousel cards).
 */
export function extractMetaAds(json) {
  return walk(json, (o) => {
    if (!o.ad_archive_id || !o.snapshot || typeof o.snapshot !== 'object') return null;
    const s = o.snapshot;
    const vid = s.videos?.[0] ?? s.cards?.find((c) => c.video_hd_url || c.video_sd_url);
    if (!vid) return null;
    const mediaUrl = vid.video_hd_url ?? vid.video_sd_url ?? null;
    const thumb = vid.video_preview_image_url ?? vid.preview_image_url ?? s.images?.[0]?.original_image_url ?? null;
    if (!thumb && !mediaUrl) return null;
    const id = String(o.ad_archive_id);
    const body = s.body?.text ?? s.cards?.[0]?.body ?? '';
    const author = s.page_name ?? o.page_name ?? '';
    return {
      platform: 'meta',
      videoId: id,
      uid: canonicalUid('meta', id),
      url: `https://www.facebook.com/ads/library/?id=${id}`,
      mediaUrl,
      thumb,
      caption: [s.title, body].filter(Boolean).join(' - ').slice(0, 600),
      author,
      postedAt: toMs(o.start_date),
      textKey: textKey(author, body || s.title || ''), // same advertiser + same copy = same ad under another ID
      link: s.link_url ?? null,
      active: o.is_active ?? null,
    };
  });
}

const urlFor = (q) => {
  const p = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country: config.metaCountry,
    media_type: 'video',
    q: q.value,
    search_type: 'keyword_unordered',
  });
  return `https://www.facebook.com/ads/library/?${p}`;
};

export const metaCollector = {
  platform: 'meta',

  /** Public Ad Library web UI (no login). Reads the GraphQL pagination responses while scrolling. */
  async search(query, { limit = 40 } = {}) {
    const ctx = await newContext({ locale: 'en-US' });
    const page = await ctx.newPage();
    const found = new Map();
    const ingest = (json) => {
      for (const m of extractMetaAds(json)) if (!found.has(m.uid)) found.set(m.uid, { ...m, query: query.label });
    };
    page.on('response', async (res) => {
      if (!/facebook\.com\/api\/graphql|facebook\.com\/ads\/library\/async/.test(res.url())) return;
      try {
        const text = await res.text();
        // graphql responses can be several newline-delimited JSON documents
        for (const line of text.replace(/^for \(;;\);/, '').split('\n')) {
          if (line.trim().startsWith('{')) ingest(JSON.parse(line));
        }
      } catch {
        /* non-JSON or aborted */
      }
    });
    try {
      await page.goto(urlFor(query), { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3500);
      // cookie banner (EU) - decline optional cookies
      await page.getByRole('button', { name: /decline optional cookies|only allow essential/i }).click({ timeout: 1500 }).catch(() => {});
      if (/\/login|checkpoint/.test(page.url())) {
        throw new SourceError('Meta Ad Library redirected to a login wall (try again later or from another network)', {
          code: 'META_LOGIN_WALL',
        });
      }
      for (const j of await embeddedJson(page)) ingest(j);

      // Collect up to 2x the limit: resellers run the same creative under many IDs, so in live runs
      // more than half of a page was dropped as duplicate_text / near_duplicate.
      let stalls = 0;
      for (let i = 0; i < config.metaMaxScrolls && found.size < limit * 2 && stalls < 3; i++) {
        const before = found.size;
        await page.mouse.wheel(0, 3000);
        await page.waitForTimeout(jitter(1600));
        stalls = found.size === before ? stalls + 1 : 0;
      }
      if (found.size === 0) {
        const txt = (await page.innerText('body').catch(() => '')).slice(0, 4000);
        if (/no ads match|no results/i.test(txt)) log.info({ q: query.label }, 'meta: no ads for query');
      }
      log.info({ query: query.label, found: found.size }, 'meta page harvested');
      return [...found.values()].slice(0, limit * 2);
    } finally {
      await ctx.close().catch(() => {});
    }
  },
};
