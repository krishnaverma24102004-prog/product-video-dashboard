// Debug helper: calls Instagram's web search API directly from inside the logged-in page (same-origin XHR).
// Usage: node scripts/ig-xhr-probe.js "protein bar"
import { newInstagramContext, closeBrowser } from '../src/collectors/browser.js';
import { extractIgMedia } from '../src/collectors/instagram.js';

const q = process.argv[2] || 'protein bar';
const ctx = await newInstagramContext();
const page = await ctx.newPage();
// a light page just to get a same-origin document with the session cookies
await page.goto('https://www.instagram.com/accounts/edit/', { waitUntil: 'domcontentloaded', timeout: 45000 });
console.log('landed:', page.url());

const t0 = Date.now();
let cursor = null;
const all = new Map();
for (let p = 0; p < 4; p++) {
  const r = await page.evaluate(async ({ q, cursor }) => {
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
    const params = new URLSearchParams({ enable_metadata: 'true', query: q, search_session_id: '' });
    if (cursor) params.set('next_max_id', cursor);
    const res = await fetch(`/api/v1/fbsearch/web/top_serp/?${params}`, {
      credentials: 'include',
      headers: { 'x-ig-app-id': '936619743392459', 'x-csrftoken': csrf, 'x-requested-with': 'XMLHttpRequest' },
    });
    return { status: res.status, text: await res.text() };
  }, { q, cursor });
  let json;
  try { json = JSON.parse(r.text); } catch { console.log('page', p, 'status', r.status, 'non-json', r.text.slice(0, 150)); break; }
  const reels = extractIgMedia(json);
  reels.forEach((m) => all.set(m.uid, m));
  const next = json.media_grid?.next_max_id ?? json.next_max_id ?? null;
  console.log(`page ${p}: status ${r.status}, reels ${reels.length}, keys ${Object.keys(json).slice(0, 8).join(',')}, next ${next ? 'yes' : 'no'}`);
  if (!next) break;
  cursor = next;
}
console.log(`total unique reels: ${all.size} in ${Date.now() - t0}ms`);
for (const r of [...all.values()].slice(0, 3)) console.log('  -', r.url, '|', r.author, '|', r.caption.slice(0, 60).replace(/\n/g, ' '));
await ctx.close();
await closeBrowser();
