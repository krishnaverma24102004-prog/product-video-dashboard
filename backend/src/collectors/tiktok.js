import { config } from '../config.js';
import { log } from '../log.js';
import { canonicalUid, textKey } from '../dedupe.js';
import { SourceError, jitter } from '../util.js';
import { newContext, walk, embeddedJson } from './browser.js';

/**
 * Optional bonus source. Off unless a search sets `options.tiktok`; pipeline.js treats every failure
 * here as a note on the TikTok tab only, so it can never block Instagram or the Meta Ad Library.
 */

const isVideoId = (v) => /^\d{15,22}$/.test(String(v ?? ''));
const pickUrl = (v) => (Array.isArray(v) ? v.find((x) => typeof x === 'string') : typeof v === 'string' ? v : null) || null;

/**
 * Extracts videos from TikTok web payloads: `api/search/item/full` (`item_list`), `api/search/general/full`
 * (`data[].item`) and the SSR rehydration blob. An item is any object with a numeric `id` and a `video`
 * object carrying a cover image.
 */
export function extractTikTokVideos(json) {
  return walk(json, (o) => {
    if (!isVideoId(o.id) || !o.video || typeof o.video !== 'object') return null;
    const v = o.video;
    const thumb = pickUrl(v.cover) ?? pickUrl(v.originCover) ?? pickUrl(v.dynamicCover) ?? pickUrl(v.cover?.url_list) ?? null;
    if (!thumb) return null;
    const id = String(o.id);
    const author = o.author?.uniqueId ?? o.author?.unique_id ?? (typeof o.author === 'string' ? o.author : '') ?? '';
    const caption = String(o.desc ?? '').slice(0, 600);
    const created = Number(o.createTime ?? o.create_time) || null;
    return {
      platform: 'tiktok',
      videoId: id,
      uid: canonicalUid('tiktok', id),
      url: author ? `https://www.tiktok.com/@${author}/video/${id}` : `https://www.tiktok.com/video/${id}`,
      // playAddr needs TikTok cookies + referer, so the dashboard opens the original instead of inline playback
      mediaUrl: null,
      thumb,
      caption,
      author,
      postedAt: created ? created * 1000 : null,
      textKey: textKey(author, caption),
      views: o.stats?.playCount ?? o.statsV2?.playCount ?? null,
    };
  });
}

/** Login modal / captcha / geo-block detection from the page URL and visible text. */
export function classifyTikTokBlock(url, text = '') {
  if (/\/about(\?|$)|tiktok\.com\/[a-z]{2}\/about/.test(url) || /Govt\.? of India|not available in your (country|region)/i.test(text)) {
    return { code: 'TIKTOK_GEO_BLOCKED', message: 'TikTok is not available from this network/region (geo-block)' };
  }
  if (/captcha|verify/i.test(url) || /drag the slider|verify to continue|captcha/i.test(text)) {
    return { code: 'TIKTOK_CAPTCHA', message: 'TikTok showed a captcha (bot check); skipping TikTok for now' };
  }
  if (/\/login/.test(url) || /log in to (tiktok|continue|search|see more)/i.test(text)) {
    return { code: 'TIKTOK_LOGIN_WALL', message: 'TikTok search asked for a login; skipping TikTok (no credentials are used)' };
  }
  return null;
}

const urlFor = (q) => `https://www.tiktok.com/search/video?q=${encodeURIComponent(q.type === 'hashtag' ? `#${q.value}` : q.value)}`;

export const tiktokCollector = {
  platform: 'tiktok',

  /** Public web search (no login). Harvests the api/search JSON the page loads while scrolling. */
  async search(query, { limit = 40 } = {}) {
    const ctx = await newContext({ locale: 'en-US' });
    const page = await ctx.newPage();
    const found = new Map();
    const ingest = (json) => {
      for (const m of extractTikTokVideos(json)) if (!found.has(m.uid)) found.set(m.uid, { ...m, query: query.label });
    };
    page.on('response', async (res) => {
      if (!/tiktok\.com\/api\/search\//.test(res.url())) return;
      try {
        ingest(JSON.parse(await res.text()));
      } catch {
        /* non-JSON, empty or aborted */
      }
    });
    const blocked = async () => classifyTikTokBlock(page.url(), (await page.innerText('body').catch(() => '')).slice(0, 4000));
    try {
      await page.goto(urlFor(query), { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3500);
      for (const j of await embeddedJson(page)) ingest(j);
      let block = found.size ? null : await blocked();
      if (block?.code === 'TIKTOK_GEO_BLOCKED') throw new SourceError(block.message, { code: block.code, fatal: true });

      let stalls = 0;
      for (let i = 0; i < config.tiktokMaxScrolls && found.size < limit && stalls < 3; i++) {
        const before = found.size;
        await page.mouse.wheel(0, 2500);
        await page.waitForTimeout(jitter(1500));
        stalls = found.size === before ? stalls + 1 : 0;
      }
      if (!found.size) {
        block = await blocked();
        // captcha / login wall / geo-block will not clear on the next query, so stop TikTok for this search
        if (block) throw new SourceError(block.message, { code: block.code, fatal: true });
      }
      log.info({ query: query.label, found: found.size }, 'tiktok page harvested');
      return [...found.values()].slice(0, limit);
    } finally {
      await ctx.close().catch(() => {});
    }
  },
};
