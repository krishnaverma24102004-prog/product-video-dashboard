import fs from 'node:fs';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { log } from '../log.js';

let browserP;
export function getBrowser() {
  browserP ??= chromium.launch({ headless: config.headless, args: ['--disable-blink-features=AutomationControlled'] });
  browserP.catch(() => (browserP = undefined));
  return browserP;
}

export async function closeBrowser() {
  if (!browserP) return;
  const b = await browserP.catch(() => null);
  browserP = undefined;
  await b?.close().catch(() => {});
}

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export async function newContext(opts = {}) {
  const browser = await getBrowser();
  return browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: 'en-US', ...opts });
}

/** Instagram context from the saved login (storageState) or an IG_SESSION_ID cookie. */
export async function newInstagramContext() {
  if (fs.existsSync(config.igStatePath)) {
    log.debug('using saved Instagram session');
    return newContext({ storageState: config.igStatePath });
  }
  if (config.igSessionId) {
    const ctx = await newContext();
    await ctx.addCookies([
      { name: 'sessionid', value: config.igSessionId, domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
    ]);
    return ctx;
  }
  return null;
}

/**
 * Recursively walks parsed JSON and returns every object for which `pick(obj)` returns something truthy.
 * Shape-agnostic on purpose: both Instagram and Meta reshuffle their payloads regularly.
 */
export function walk(root, pick, out = [], seen = new Set(), depth = 0) {
  if (!root || typeof root !== 'object' || depth > 40 || seen.has(root)) return out;
  seen.add(root);
  const hit = Array.isArray(root) ? null : pick(root);
  if (hit) out.push(hit);
  for (const v of Array.isArray(root) ? root : Object.values(root)) {
    if (v && typeof v === 'object') walk(v, pick, out, seen, depth + 1);
  }
  return out;
}

/** JSON embedded in the initial HTML (<script type="application/json"> blobs) - first page of results often lives here. */
export async function embeddedJson(page) {
  const texts = await page.$$eval('script[type="application/json"]', (els) => els.map((e) => e.textContent || ''));
  const out = [];
  for (const t of texts) {
    if (t.length < 50) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* not JSON we care about */
    }
  }
  return out;
}
