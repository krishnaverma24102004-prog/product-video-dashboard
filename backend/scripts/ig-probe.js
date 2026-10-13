// Debug helper: shows which Instagram endpoints a page calls and how many Reels we extract.
// Usage: node scripts/ig-probe.js hashtag proteinbar   |   node scripts/ig-probe.js keyword "protein bar"
import { newInstagramContext, embeddedJson, closeBrowser } from '../src/collectors/browser.js';
import { extractIgMedia } from '../src/collectors/instagram.js';

const [type = 'hashtag', value = 'proteinbar'] = process.argv.slice(2);
const url = type === 'hashtag'
  ? `https://www.instagram.com/explore/tags/${encodeURIComponent(value)}/`
  : `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(value)}`;

function parseBodies(text) {
  const out = [];
  for (const line of text.replace(/^for \(;;\);/, '').split('\n')) {
    const t = line.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { out.push(JSON.parse(t)); } catch { /* partial */ }
    }
  }
  return out;
}

const ctx = await newInstagramContext();
const page = await ctx.newPage();
const hits = new Map();
const reels = new Map();
page.on('response', async (res) => {
  const u = res.url();
  if (!/instagram\.com\/(api|graphql)/.test(u)) return;
  const ct = res.headers()['content-type'] || '';
  let n = 0;
  let bytes = 0;
  try {
    const text = await res.text();
    bytes = text.length;
    for (const doc of parseBodies(text)) for (const m of extractIgMedia(doc)) { reels.set(m.uid, m); n++; }
  } catch { /* ignore */ }
  const post = res.request().postData() || '';
  const op = post.match(/fb_api_req_friendly_name=([^&]+)/)?.[1] || post.match(/doc_id=(\d+)/)?.[0] || '';
  const key = u.split('?')[0].replace(/\d{6,}/g, ':id') + (op ? `  [${op}] ${Math.round(bytes / 1024)}KB` : '');
  const h = hits.get(key) ?? { count: 0, reels: 0, ct: ct.split(';')[0] };
  h.count++; h.reels += n;
  hits.set(key, h);
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(4000);
console.log('landed on:', page.url());
let embedded = 0;
for (const j of await embeddedJson(page)) for (const m of extractIgMedia(j)) { reels.set(m.uid, m); embedded++; }
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(1800); }

console.log('embedded reels:', embedded);
console.log('endpoints:');
for (const [k, v] of hits) console.log(`  ${v.count}x ${v.ct} reels=${v.reels}  ${k}`);
console.log('total unique reels:', reels.size);
for (const r of [...reels.values()].slice(0, 3)) console.log('  -', r.url, '|', r.author, '|', r.caption.slice(0, 60).replace(/\n/g, ' '));
await ctx.close();
await closeBrowser();
