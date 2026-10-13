import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DB_PATH = path.join(os.tmpdir(), `pvd-product-image-test-${process.pid}-${Date.now()}.db`);
process.env.LOG_LEVEL = 'silent';

// Network stub: safeGet is replaced, but assertSafeUrl stays real and is still run on every requested URL,
// so the tests also prove that every fetch (page, Shopify .json, image) goes through the SSRF-guarded path.
const routes = new Map();
const requested = [];
vi.mock('../src/urlSafety.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    safeGet: vi.fn(async (url) => {
      real.assertSafeUrl(url);
      requested.push(url);
      const r = routes.get(url);
      if (!r) throw Object.assign(new Error('HTTP 404'), { status: 404 });
      if (r instanceof Error) throw r;
      return { body: Buffer.from(r.body), url: r.finalUrl || url, contentType: '' };
    }),
  };
});
vi.mock('../src/vision/image.js', () => ({
  toJpeg: async (buf) => {
    if (String(buf).startsWith('BROKEN')) throw new Error('unsupported image format');
    return Buffer.from(`jpeg:${buf}`);
  },
}));

let parseProductHtml, extractFromPage, resolveProduct, normalizeImageUrl, shopifyJsonUrl;
beforeAll(async () => {
  ({ parseProductHtml, extractFromPage, resolveProduct, normalizeImageUrl, shopifyJsonUrl } = await import('../src/product.js'));
});
beforeEach(() => {
  routes.clear();
  requested.length = 0;
});

const PAGE = 'https://shop.example.com/products/tumbler-30-oz';
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const html = (head) => `<!doctype html><html><head><title>Fallback title</title>${head}</head><body></body></html>`;

describe('product image candidates', () => {
  it('resolves protocol-relative og:image against the page scheme', () => {
    const r = parseProductHtml(html('<meta property="og:image" content="//cdn.shopify.com/s/files/1/a/b.jpg?v=1">'), PAGE);
    expect(r.imageUrls[0]).toBe('https://cdn.shopify.com/s/files/1/a/b.jpg?v=1');
  });

  it('falls back to twitter:image, meta itemprop=image and link rel=image_src', () => {
    expect(parseProductHtml(html('<meta name="twitter:image" content="https://img.example.com/t.jpg">'), PAGE).imageUrls)
      .toEqual(['https://img.example.com/t.jpg']);
    expect(parseProductHtml(html('<meta itemprop="image" content="/img/i.jpg">'), PAGE).imageUrls)
      .toEqual(['https://shop.example.com/img/i.jpg']);
    expect(parseProductHtml(html('<link rel="image_src" href="img/rel.png">'), PAGE).imageUrls)
      .toEqual(['https://shop.example.com/products/img/rel.png']);
  });

  it('reads JSON-LD image arrays, {url} objects and ImageObject.contentUrl', () => {
    const arr = parseProductHtml(html(ld({ '@type': 'Product', name: 'A', image: ['https://x.com/1.jpg', 'https://x.com/2.jpg'] })), PAGE);
    expect(arr.imageUrls).toEqual(['https://x.com/1.jpg', 'https://x.com/2.jpg']);
    const obj = parseProductHtml(html(ld({ '@type': 'Product', name: 'B', image: { url: '//x.com/obj.jpg' } })), PAGE);
    expect(obj.imageUrls).toEqual(['https://x.com/obj.jpg']);
    const io = parseProductHtml(html(ld({ '@type': 'Product', name: 'C', image: [{ '@type': 'ImageObject', contentUrl: '/c.jpg' }] })), PAGE);
    expect(io.imageUrls).toEqual(['https://shop.example.com/c.jpg']);
  });

  it('finds the Product inside an @graph wrapper', () => {
    const r = parseProductHtml(html(ld({ '@context': 'https://schema.org', '@graph': [
      { '@type': 'WebPage', name: 'page' },
      { '@type': ['Product'], name: 'Graph tee', brand: { name: 'Acme' }, image: 'https://x.com/g.jpg' },
    ] })), PAGE);
    expect(r).toMatchObject({ title: 'Graph tee', brand: 'Acme', imageUrls: ['https://x.com/g.jpg'] });
  });

  it('handles a Shopify ProductGroup with hasVariant and no og:image (stanley1913 live shape)', () => {
    // hand-trimmed from the live stanley1913.com page: no og/twitter meta tags; Organization + ProductGroup JSON-LD
    const r = parseProductHtml(html(
      '<meta name="shopify-digital-wallet" content="/1/digital_wallets/dialog">' +
      ld({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Stanley 1913', logo: { '@type': 'ImageObject', url: 'https://www.stanley1913.com/logo.svg' } }) +
      ld({ '@context': 'https://schema.org/', '@type': 'ProductGroup', name: 'The Quencher® ProTour Flip Straw Tumbler | 30 OZ',
        image: 'https://www.stanley1913.com/cdn/shop/files/Front.png?v=1&width=800', brand: { '@type': 'Brand', name: 'Stanley' },
        hasVariant: [
          { '@type': 'Product', name: 'Tumbler - Green', image: 'https://www.stanley1913.com/cdn/shop/files/Green.png?v=1&width=800' },
          { '@type': 'Product', name: 'Tumbler - Pink', image: 'https://www.stanley1913.com/cdn/shop/files/Pink.png?v=1&width=800' },
        ] }),
    ), 'https://www.stanley1913.com/products/the-quencher%C2%AE-protour-flip-straw-tumbler-30-oz');
    expect(r.title).toBe('The Quencher® ProTour Flip Straw Tumbler | 30 OZ');
    expect(r.brand).toBe('Stanley');
    expect(r.shopify).toBe(true);
    expect(r.imageUrls).toEqual([
      'https://www.stanley1913.com/cdn/shop/files/Front.png?v=1&width=800',
      'https://www.stanley1913.com/cdn/shop/files/Green.png?v=1&width=800',
      'https://www.stanley1913.com/cdn/shop/files/Pink.png?v=1&width=800',
    ]);
    expect(r.imageUrls).not.toContain('https://www.stanley1913.com/logo.svg');
  });

  it('orders JSON-LD before og:image and de-duplicates', () => {
    const r = parseProductHtml(html(
      '<meta property="og:image" content="https://x.com/og.jpg"><meta name="twitter:image" content="https://x.com/1.jpg">' +
      ld({ '@type': 'Product', name: 'P', image: 'https://x.com/1.jpg' }),
    ), PAGE);
    expect(r.imageUrls).toEqual(['https://x.com/1.jpg', 'https://x.com/og.jpg']);
  });

  it('normalises relative URLs, size placeholders and drops non-http values', () => {
    expect(normalizeImageUrl('../img/a.jpg', 'https://s.com/products/x/y')).toBe('https://s.com/products/img/a.jpg');
    expect(normalizeImageUrl('//cdn.shopify.com/files/a_{width}x.jpg', PAGE)).toBe('https://cdn.shopify.com/files/a_1024x.jpg');
    expect(normalizeImageUrl('//cdn.shopify.com/products/a_{size}.jpg?v=2', PAGE)).toBe('https://cdn.shopify.com/products/a.jpg?v=2');
    expect(normalizeImageUrl('https://x.com/a.jpg?width=%7Bwidth%7D', PAGE)).toBe('https://x.com/a.jpg?width=1024');
    expect(normalizeImageUrl('https://x.com/a.jpg?v=1&amp;width=800', PAGE)).toBe('https://x.com/a.jpg?v=1&width=800');
    expect(normalizeImageUrl('data:image/png;base64,AAA', PAGE)).toBeNull();
    expect(normalizeImageUrl('javascript:alert(1)', PAGE)).toBeNull();
    expect(normalizeImageUrl('', PAGE)).toBeNull();
  });

  it('builds the Shopify .json URL from product paths only', () => {
    expect(shopifyJsonUrl('https://s.com/products/tee?variant=1')).toBe('https://s.com/products/tee.json');
    expect(shopifyJsonUrl('https://s.com/collections/new/products/tee/')).toBe('https://s.com/collections/new/products/tee.json');
    expect(shopifyJsonUrl('https://s.com/pages/about')).toBeNull();
  });
});

describe('extractFromPage', () => {
  it('uses the Shopify /products/<handle>.json fallback when the page has no image (through safeGet)', async () => {
    routes.set(PAGE, { body: html('<script>window.Shopify = {}; Shopify.shop = "x.myshopify.com";</script><meta property="og:title" content="Tumbler">') });
    routes.set(`${PAGE}.json`, { body: JSON.stringify({ product: { title: 'Tumbler',
      image: { src: 'https://cdn.shopify.com/s/files/1/main.png?v=1' },
      images: [{ src: 'https://cdn.shopify.com/s/files/1/main.png?v=1' }, { src: '//cdn.shopify.com/s/files/1/side.png' }] } }) });
    const page = await extractFromPage(PAGE);
    expect(requested).toEqual([PAGE, `${PAGE}.json`]);
    expect(page.title).toBe('Tumbler');
    expect(page.imageUrl).toBe('https://cdn.shopify.com/s/files/1/main.png?v=1');
    expect(page.imageUrls).toEqual(['https://cdn.shopify.com/s/files/1/main.png?v=1', 'https://cdn.shopify.com/s/files/1/side.png']);
  });

  it('accepts the .js endpoint shape (featured_image / images strings)', async () => {
    const { shopifyImages } = await import('../src/product.js');
    expect(shopifyImages({ featured_image: '//cdn.shopify.com/f.jpg', images: ['//cdn.shopify.com/f.jpg', '//cdn.shopify.com/g.jpg'] }))
      .toEqual(['//cdn.shopify.com/f.jpg', '//cdn.shopify.com/f.jpg', '//cdn.shopify.com/g.jpg']);
  });

  it('skips the .json fallback for non-Shopify pages and when the page already has an image', async () => {
    routes.set(PAGE, { body: html('<meta property="og:title" content="Plain">') });
    expect((await extractFromPage(PAGE)).imageUrl).toBeNull();
    expect(requested).toEqual([PAGE]);

    requested.length = 0;
    routes.set(PAGE, { body: html('<link href="https://cdn.shopify.com/s/x.css"><meta property="og:image" content="//cdn.shopify.com/a.jpg">') });
    expect((await extractFromPage(PAGE)).imageUrl).toBe('https://cdn.shopify.com/a.jpg');
    expect(requested).toEqual([PAGE]);
  });

  it('survives a failing .json fallback (e.g. 429) with no image', async () => {
    routes.set(PAGE, { body: html('<script src="https://cdn.shopify.com/s/app.js"></script><title>T</title>') });
    routes.set(`${PAGE}.json`, Object.assign(new Error('HTTP 429'), { status: 429 }));
    const page = await extractFromPage(PAGE);
    expect(page.imageUrl).toBeNull();
    expect(page.imageUrls).toEqual([]);
  });

  it('resolves relative images against the final (post-redirect) URL', async () => {
    routes.set('https://short.example.com/p', { body: html('<meta property="og:image" content="img/main.jpg">'), finalUrl: 'https://shop.example.com/products/tee/' });
    expect((await extractFromPage('https://short.example.com/p')).imageUrl).toBe('https://shop.example.com/products/tee/img/main.jpg');
  });

  it('never fetches a private-network URL even if it is the Shopify .json target', async () => {
    await expect(extractFromPage('http://127.0.0.1/products/x')).rejects.toThrow(/Private IP/);
    expect(requested).toEqual([]);
  });
});

describe('resolveProduct image download', () => {
  it('tries the next candidate when the first image fails to download or decode', async () => {
    const url = 'https://shop2.example.com/products/bottle';
    routes.set(url, { body: html(ld({ '@type': 'Product', name: 'Bottle', image: [
      'https://img.example.com/missing.jpg', 'https://img.example.com/broken.jpg', 'https://img.example.com/good.jpg'] })) });
    routes.set('https://img.example.com/broken.jpg', { body: 'BROKEN' });
    routes.set('https://img.example.com/good.jpg', { body: 'GOOD' });
    const emitted = [];
    const p = await resolveProduct({ input: url }, (m) => emitted.push(m));
    expect(p.title).toBe('Bottle');
    expect(p.imageUrl).toBe('https://img.example.com/good.jpg');
    expect(p.jpeg.toString()).toBe('jpeg:GOOD');
    expect(requested).toEqual([url, 'https://img.example.com/missing.jpg', 'https://img.example.com/broken.jpg', 'https://img.example.com/good.jpg']);
    expect(emitted).not.toContain('Could not download the product image; continuing with text only');
  });

  it('reports text-only when every candidate fails', async () => {
    const url = 'https://shop3.example.com/products/cup';
    routes.set(url, { body: html('<meta property="og:image" content="https://img.example.com/gone.jpg">') });
    const emitted = [];
    const p = await resolveProduct({ input: url }, (m) => emitted.push(m));
    expect(p.jpeg).toBeUndefined();
    expect(emitted).toContain('Could not download the product image; continuing with text only');
  });
});
