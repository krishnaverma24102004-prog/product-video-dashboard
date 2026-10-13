import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { config } from './config.js';
import { log } from './log.js';
import { store } from './db.js';
import { safeGet, assertSafeUrl } from './urlSafety.js';
import { toJpeg } from './vision/image.js';

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
export const isUrl = (s) => /^https?:\/\//i.test(s.trim());

const PRODUCT_TYPES = ['Product', 'ProductGroup', 'IndividualProduct', 'ProductModel', 'SomeProducts'];
const typesOf = (n) => [].concat(n?.['@type'] || []).map((t) => String(t).replace(/^https?:\/\/schema\.org\//, ''));

/** All Product-like JSON-LD nodes, in document order (walks arrays, @graph and ProductGroup.hasVariant). */
export function pickProductLds($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const walk = (n, depth = 0) => {
        if (!n || depth > 6) return;
        if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));
        if (typeof n !== 'object') return;
        if (typesOf(n).some((t) => PRODUCT_TYPES.includes(t))) out.push(n);
        walk(n['@graph'], depth + 1);
        walk(n.hasVariant, depth + 1);
        walk(n.mainEntity, depth + 1);
      };
      // some themes emit raw control characters inside strings, which JSON.parse rejects
      walk(JSON.parse($(el).contents().text().replace(/[\u0000-\u001f]+/g, ' ')));
    } catch {
      /* malformed JSON-LD is common; ignore */
    }
  });
  return out;
}

/** Flattens a JSON-LD image value (string | array | {url} | ImageObject{contentUrl}) into URL strings. */
export function ldImages(img) {
  if (!img) return [];
  if (Array.isArray(img)) return img.flatMap(ldImages);
  if (typeof img === 'string') return [img];
  if (typeof img === 'object') return ldImages(img.url || img.contentUrl || img.src || img['@id']);
  return [];
}

/**
 * Normalises an image URL candidate: protocol-relative and relative URLs are resolved against the page,
 * Shopify-style size placeholders ({width}, _{size}) are filled in, and non-http(s) values are dropped.
 */
export function normalizeImageUrl(raw, base) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/&amp;/g, '&');
  if (!s || /^(data|blob|javascript):/i.test(s)) return null;
  s = s
    .replace(/_(\{|%7B)size(\}|%7D)/gi, '')
    .replace(/(\{|%7B)(width|height)(\}|%7D)/gi, '1024')
    .replace(/(\{|%7B)size(\}|%7D)/gi, '1024x');
  try {
    const u = new URL(s, base);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

const isShopify = (html, $) =>
  /cdn\.shopify\.com|window\.Shopify\b|Shopify\.shop\s*=|\/cdn\/shop\//.test(html) || $('meta[name="shopify-digital-wallet"]').length > 0;

/** /products/<handle>(.json) for a Shopify product page URL, or null. */
export function shopifyJsonUrl(pageUrl) {
  const u = new URL(pageUrl);
  const m = u.pathname.match(/^(.*\/products\/[^/]+?)(?:\.(?:json|js))?\/?$/);
  return m ? new URL(`${m[1]}.json`, u.origin).toString() : null;
}

/** Image URLs from Shopify's /products/<handle>.json ({product:{image,images}}) or .js ({featured_image,images}). */
export function shopifyImages(json) {
  const p = json?.product || json || {};
  return [p.image, p.featured_image, ...[].concat(p.images || []), p.media?.[0]?.src]
    .map((x) => (typeof x === 'string' ? x : x?.src))
    .filter(Boolean);
}

/** Pure HTML parse: title/description/brand plus an ordered, de-duplicated list of main-image candidates. */
export function parseProductHtml(html, finalUrl) {
  const $ = cheerio.load(html);
  const lds = pickProductLds($);
  // prefer a node with a name; a ProductGroup and its variants usually share the same picture anyway
  const ld = lds.find((n) => n.name) || lds[0];
  const meta = (p) => $(`meta[property="${p}"], meta[name="${p}"]`).attr('content');
  const title = (ld?.name || meta('og:title') || meta('twitter:title') || $('title').text() || '').trim();
  const description = (ld?.description || meta('og:description') || meta('description') || '').trim();

  const raw = [
    ...ldImages(ld?.image),
    ...lds.flatMap((n) => ldImages(n.image)),
    meta('og:image:secure_url'),
    meta('og:image'),
    meta('og:image:url'),
    meta('twitter:image'),
    meta('twitter:image:src'),
    $('meta[itemprop="image"]').attr('content'),
    $('link[rel="image_src"]').attr('href'),
    $('[itemprop="image"]').attr('src'),
    $('#landingImage').attr('data-old-hires'),
    $('#landingImage').attr('src'),
  ];
  const imageUrls = [...new Set(raw.map((r) => normalizeImageUrl(r, finalUrl)).filter(Boolean))];

  const host = new URL(finalUrl).hostname.replace(/^www\./, '').split('.');
  const brand = (typeof ld?.brand === 'string' ? ld.brand : ld?.brand?.name) || meta('og:site_name') ||
    (/amazon|flipkart|ebay|walmart|etsy/.test(host.join('.')) ? '' : host[0]);
  return {
    title: title.slice(0, 300),
    description: description.slice(0, 1000),
    imageUrls,
    brand: (brand || '').trim().slice(0, 60),
    shopify: isShopify(html, $),
  };
}

/** Opens a product page and extracts title, description and main image URL(s). Every fetch goes through safeGet. */
export async function extractFromPage(url) {
  const { body, url: finalUrl } = await safeGet(url, { maxBytes: 2_500_000 });
  const { shopify, ...page } = parseProductHtml(body.toString('utf8'), finalUrl);
  let { imageUrls } = page;
  const jsonUrl = shopify && shopifyJsonUrl(finalUrl);
  if (!imageUrls.length && jsonUrl) {
    try {
      const { body: jb } = await safeGet(jsonUrl, { maxBytes: 2_000_000, headers: { accept: 'application/json' } });
      imageUrls = [...new Set(shopifyImages(JSON.parse(jb.toString('utf8'))).map((r) => normalizeImageUrl(r, finalUrl)).filter(Boolean))];
    } catch (e) {
      log.warn({ err: e.message, jsonUrl }, 'shopify product json fallback failed');
    }
  }
  return { ...page, imageUrls, imageUrl: imageUrls[0] || null, pageUrl: finalUrl };
}

async function fetchImage(url) {
  const { body } = await safeGet(url, { maxBytes: 8_000_000 });
  return toJpeg(body);
}

/**
 * Resolves the user's input into a product context: {type, title, description, jpeg?, ...}.
 * Page extraction is cached so the same product link is only fetched/parsed once per TTL.
 */
export async function resolveProduct({ input, imageBase64 }, emit = () => {}) {
  const raw = input.trim();
  const product = { input: raw, type: !raw ? 'image' : isUrl(raw) ? 'url' : 'keyword', title: raw, description: '', url: null, imageUrl: null };

  if (product.type === 'url') {
    assertSafeUrl(raw);
    const key = `page:v2:${sha1(raw)}`; // v2: imageUrls candidate list
    let page = store.cacheGet(key, config.productCacheTtlMs);
    if (page) {
      emit('Using cached product page');
    } else {
      emit('Fetching product page');
      page = await extractFromPage(raw);
      store.cacheSet(key, page);
    }
    Object.assign(product, { title: page.title || raw, description: page.description, url: page.pageUrl, imageUrl: page.imageUrl, brand: page.brand });
    const candidates = (page.imageUrls || [page.imageUrl]).filter(Boolean).slice(0, 5);
    if (candidates.length && !imageBase64) {
      for (const imageUrl of candidates) {
        const ik = `img:${sha1(imageUrl)}`;
        const cached = store.cacheGet(ik, config.productCacheTtlMs);
        try {
          product.jpeg = cached ? Buffer.from(cached.b64, 'base64') : await fetchImage(imageUrl);
          if (!cached) store.cacheSet(ik, { b64: product.jpeg.toString('base64') });
          product.imageUrl = imageUrl;
          break;
        } catch (e) {
          log.warn({ err: e.message, imageUrl }, 'product image fetch failed; trying next candidate');
        }
      }
      if (!product.jpeg) emit('Could not download the product image; continuing with text only');
    }
  }

  if (imageBase64) {
    const buf = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    if (buf.length > 8_000_000) throw Object.assign(new Error('Image too large (max 8MB)'), { status: 400 });
    try {
      product.jpeg = await toJpeg(buf);
    } catch {
      throw Object.assign(new Error('Uploaded file is not a valid image'), { status: 400 });
    }
  }

  if (product.jpeg) {
    product.imageHash = sha1(product.jpeg);
    product.imageDataUrl = `data:image/jpeg;base64,${(await toJpeg(product.jpeg, 360, 75)).toString('base64')}`;
  }
  return product;
}
