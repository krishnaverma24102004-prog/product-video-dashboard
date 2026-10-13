import { describe, expect, it } from 'vitest';
import { assertSafeUrl, isPrivateIp, UnsafeUrlError } from '../src/urlSafety.js';
import { extractIgMedia, isSearchOperation, parseBodies } from '../src/collectors/instagram.js';
import { extractMetaAds } from '../src/collectors/meta.js';

describe('SSRF protection', () => {
  it.each(['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1'])(
    'treats %s as private', (ip) => expect(isPrivateIp(ip)).toBe(true));
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('treats %s as public', (ip) => expect(isPrivateIp(ip)).toBe(false));

  it.each([
    'file:///etc/passwd', 'ftp://example.com', 'http://localhost:4000', 'http://127.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://user:pw@example.com', 'http://db.internal/', 'not a url',
  ])('rejects %s', (u) => expect(() => assertSafeUrl(u)).toThrow(UnsafeUrlError));

  it('allows ordinary public product links', () => {
    expect(() => assertSafeUrl('https://www.example-store.com/products/tee')).not.toThrow();
  });
});

describe('extractIgMedia', () => {
  const reel = {
    pk: '111', code: 'Cabc123xyz', media_type: 2, product_type: 'clips',
    caption: { text: 'Love this tee' }, user: { username: 'shopper' }, taken_at: 1700000000,
    image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/t.jpg' }] },
    video_versions: [{ url: 'https://scontent.cdninstagram.com/v.mp4' }],
  };
  it('finds reels nested anywhere in v1 payloads and ignores photos', () => {
    const photo = { pk: '2', code: 'Pphoto12345', media_type: 1, image_versions2: { candidates: [{ url: 'x' }] } };
    const out = extractIgMedia({ data: { sections: [{ layout_content: { medias: [{ media: reel }, { media: photo }] } }] } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ uid: 'instagram:Cabc123xyz', url: 'https://www.instagram.com/reel/Cabc123xyz/', author: 'shopper', caption: 'Love this tee' });
    expect(out[0].postedAt).toBe(1700000000 * 1000);
  });
  it('understands the legacy graphql shape', () => {
    const out = extractIgMedia({ edges: [{ node: { shortcode: 'Legacy12345', is_video: true, video_url: 'v', display_url: 't',
      edge_media_to_caption: { edges: [{ node: { text: 'hello' } }] }, owner: { username: 'o' } } }] });
    expect(out[0]).toMatchObject({ uid: 'instagram:Legacy12345', caption: 'hello', author: 'o' });
  });
});

describe('instagram response filtering', () => {
  it('keeps search/explore operations and drops the home feed and stories', () => {
    expect(isSearchOperation('PolarisKeywordSearchExplorePageRelayQuery')).toBe(true);
    expect(isSearchOperation('PolarisKeywordSearchExplorePageRelayPaginationQuery')).toBe(true);
    expect(isSearchOperation('PolarisFeedTimelineRootV2Query')).toBe(false);
    expect(isSearchOperation('PolarisStoriesV3TrayContainerQuery')).toBe(false);
    expect(isSearchOperation('', 'https://www.instagram.com/api/v1/fbsearch/web/top_serp/')).toBe(true);
    expect(isSearchOperation('')).toBe(false);
  });
  it('parses guarded, multi-document text/javascript bodies', () => {
    const docs = parseBodies('for (;;);{"a":1}\n{"b":2}\nnot json\n{"c":');
    expect(docs).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('extractMetaAds', () => {
  it('extracts video ads, including carousel-card videos, and skips image-only ads', () => {
    const json = { results: [
      { ad_archive_id: '900', start_date: 1700000000, snapshot: { page_name: 'Brand', body: { text: 'Buy now' },
        videos: [{ video_hd_url: 'https://video.fbcdn.net/a.mp4', video_preview_image_url: 'https://scontent.fbcdn.net/a.jpg' }] } },
      { ad_archive_id: '901', snapshot: { cards: [{ video_sd_url: 'https://video.fbcdn.net/b.mp4', body: 'card copy' }], page_name: 'B2',
        images: [{ original_image_url: 'https://scontent.fbcdn.net/b.jpg' }] } },
      { ad_archive_id: '902', snapshot: { images: [{ original_image_url: 'x' }] } },
    ] };
    const out = extractMetaAds(json);
    expect(out.map((a) => a.uid)).toEqual(['meta:900', 'meta:901']);
    expect(out[0]).toMatchObject({ author: 'Brand', caption: 'Buy now', url: 'https://www.facebook.com/ads/library/?id=900' });
  });
});
