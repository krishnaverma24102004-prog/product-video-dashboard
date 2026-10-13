// Explains one search step by step: what came back, how it was found, and why each video was kept or dropped.
// Read-only: it only calls GET endpoints of the running backend.
// Usage (backend running):
//   node scripts/explain-search.js                 # latest search
//   node scripts/explain-search.js <searchId>
//   node scripts/explain-search.js "adidas samba"  # latest search whose input contains this text
//   node scripts/explain-search.js latest --top 10 # show 10 accepted videos per source (default 5)
import { config } from '../src/config.js';

const API = process.env.API || `http://localhost:${config.port}`;
const args = process.argv.slice(2);
const topIdx = args.indexOf('--top');
const TOP = topIdx > -1 ? Number(args[topIdx + 1]) || 5 : 5;
const target = args.filter((a, i) => a !== '--top' && args[i - 1] !== '--top')[0] || 'latest';

const DROP = {
  seen_before: 'already shown in an earlier search (history filter; "Show previously seen" turns it off)',
  duplicate_id: 'same video ID twice in this search (one query found it again)',
  duplicate_text: 'same advertiser/author + same caption/ad copy (one ad running under several IDs, or a repost)',
  near_duplicate: 'thumbnail nearly identical (dHash) to one already kept (re-upload / repost)',
};
const RELATION = {
  exact: 'same brand and same model visible -> accepted (score 80-100)',
  variant: 'same model, other colour/size/edition -> accepted (62-75)',
  same_brand_other_model: 'right brand, different model -> rejected (35)',
  competitor: 'other brand / dupe / look-alike -> rejected (15)',
  category: 'same kind of product, brand/model unclear -> rejected (25)',
  accessory: 'case/charger/protector FOR the product -> rejected (20)',
  not_visible: 'product not visible (logo, text, scene) -> rejected (10)',
  unrelated: 'something else -> rejected (5)',
};
const STATUS = {
  ok: 'verdict accepted as given',
  uncertain: "judge's explanation contradicted its verdict (e.g. 'different brand') -> capped at 45, rejected",
  unverified: 'no brand evidence (no logo seen, brand/model not in caption) -> capped at 48, rejected',
  visual_only: 'brand unknown or only inferred: visual match, identity not verified',
};

const get = async (p) => {
  const r = await fetch(`${API}${p}`);
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
};
const line = (s = '') => console.log(s);
const h = (s) => line(`\n=== ${s} ${'='.repeat(Math.max(0, 70 - s.length))}`);
const count = (arr, key) => arr.reduce((m, x) => ((m[key(x)] = (m[key(x)] || 0) + 1), m), {});
const prefix = (reason = '') => reason.split(/[:(]/)[0].trim() || '(none)';

let history;
try {
  history = await get('/api/history');
} catch (e) {
  console.error(`Cannot reach the backend at ${API} (${e.message}). Start it first: cd backend && npm run dev`);
  process.exit(1);
}
const pick =
  target === 'latest' ? history[0]
  : history.find((s) => s.id === target) ?? history.find((s) => (s.input || '').toLowerCase().includes(target.toLowerCase()));
if (!pick) {
  console.error(`No search matches "${target}". Recent: ${history.slice(0, 5).map((s) => `"${s.input}"`).join(', ')}`);
  process.exit(1);
}
const s = await get(`/api/search/${pick.id}`);
const p = s.product || {};
const a = p.attributes || {};
const id = p.identity || {};
const secs = s.finishedAt && s.createdAt ? Math.round((s.finishedAt - s.createdAt) / 1000) : null;

h('1. INPUT');
line(`Search   : "${s.input || '(photo only)'}"  [${s.type}]  id ${s.id}`);
line(`Status   : ${s.status}${s.error ? ` - ${s.error}` : ''}${secs != null ? `  (${secs} s)` : ''}`);
line(`Options  : ${JSON.stringify(s.options || {})}`);

h('2. WHAT THE BRAIN UNDERSTOOD (product analysis)');
line(`Title    : ${p.title || '-'}`);
if (s.type === 'url') line(`Page     : ${p.url || s.input}  | main image ${p.imageUrl || p.imageDataUrl ? 'FOUND' : 'NOT found (name-only matching)'}`);
line(`Analysis : ${a.source || '-'}  (gemini = vision/text model, gemini-text = name only, heuristic = model unavailable)`);
line(`Identity : brand "${id.brand || 'unknown'}" (${id.brandSource || '-'}${id.verified ? ', verified' : ', NOT verified'}), model "${id.model || '-'}"`);
line(`           brandSource: page/named/visible = trusted; inferred = guessed from design; unknown = never invented`);
if (a.productType || a.colors) line(`Looks    : ${[a.productType, (a.colors || []).join('/'), a.material, a.shape].filter(Boolean).join(' | ')}`);
if (id.features?.length) line(`Distinct : ${id.features.join(', ')}`);
line(`Why it matters: queries are built from brand + model, and every video is judged against this identity.`);

const vis = s.stats?.vision;
if (vis) {
  h('3. VISION JUDGE (who scored the videos)');
  line(`Status   : ${vis.status}${vis.reason ? ` (${vis.reason}${vis.detail ? `: ${vis.detail}` : ''})` : ''}`);
  line(`Calls    : ${vis.calls}/${vis.budget} Gemini calls | ${vis.judged} videos judged, ${vis.clipOnly} scored CLIP-only`);
  if (vis.judgeModels) line(`Models   : ${Object.entries(vis.judgeModels).map(([m, n]) => `${m} x${n}`).join(', ')}`);
  if (vis.relations) {
    line('Verdicts : (judge classifies, code scores - judge v' + (vis.judgeVersion ?? '?') + ')');
    for (const [r, n] of Object.entries(vis.relations)) line(`   ${String(n).padStart(3)}  ${r.padEnd(23)} ${RELATION[r] || ''}`);
  }
  if (vis.matchStatus) for (const [r, n] of Object.entries(vis.matchStatus)) if (r !== 'ok') line(`   ${String(n).padStart(3)}  ${r.padEnd(23)} ${STATUS[r] || ''}`);
  if (vis.status !== 'ok') line('   -> Without a verdict, a video is kept only if CLIP is high AND the caption names the model.');
}

for (const platform of ['instagram', 'meta', 'tiktok']) {
  const st = s.stats?.[platform];
  if (!st) continue;
  const name = { instagram: 'INSTAGRAM REELS', meta: 'META AD LIBRARY', tiktok: 'TIKTOK (optional)' }[platform];
  const res = (s.results || []).filter((r) => r.platform === platform);
  const good = res.filter((r) => !r.below).sort((x, y) => y.score - x.score);
  const weak = res.filter((r) => r.below);
  h(`${platform === 'instagram' ? 4 : platform === 'meta' ? 5 : 6}. ${name}: ${st.usable}${platform === 'tiktok' ? '' : `/${st.target}`} usable`);
  line('How it searched (in order; stops once the target is met, the rounds run out, or the deadline hits):');
  (st.queriesTried || []).forEach((q, i) => line(`   ${i + 1}. ${q}`));
  const planned = p.queries?.[platform] || [];
  if (planned.length > (st.queriesTried || []).length) line(`   (${planned.length - st.queriesTried.length} more planned queries were not needed / not reached)`);
  const dropped = Object.entries(st.dropped || {});
  if (dropped.length) {
    line('Dropped before scoring (de-duplication):');
    for (const [r, n] of dropped) line(`   ${String(n).padStart(3)}  ${r.padEnd(15)} ${DROP[r] || ''}`);
  }
  line(`Kept     : ${st.usable} above the threshold (${s.stats?.threshold ?? 50}); ${st.below} best rejected ones are stored for "Show below-threshold"`);
  const why = count(good, (r) => prefix(r.reason));
  if (good.length) line(`Accepted because: ${Object.entries(why).map(([k, n]) => `${n}x ${k}`).join(', ')}`);
  const whyNot = count(weak, (r) => prefix(r.reason));
  if (weak.length) line(`Rejected examples: ${Object.entries(whyNot).map(([k, n]) => `${n}x ${k}`).join(', ')}`);
  if (good.length) {
    line(`Top ${Math.min(TOP, good.length)} (score = final 0-100, vlm = judge, clip = visual similarity):`);
    for (const r of good.slice(0, TOP)) {
      line(`   ${String(r.score).padStart(3)}  vlm ${r.vlm ?? '-'}  clip ${r.clip == null ? '-' : Math.round(r.clip)}  ${r.url}`);
      line(`        why: ${r.reason}`);
      if (r.query) line(`        found by: "${r.query}"`);
    }
  }
  if (weak.length) {
    line('Closest rejected:');
    for (const r of weak.slice(0, Math.min(3, TOP))) line(`   ${String(r.score).padStart(3)}  ${r.url}\n        why not: ${r.reason}`);
  }
  if (st.error) line(`ERROR    : ${st.error}`);
  for (const n of st.notes || []) line(`Note     : ${n}`);
  if (st.shortfall) {
    line(`SHORTFALL: ${st.shortfall} short of ${st.target}. Likely cause: ${
      st.deadlineReached ? 'the 240 s search deadline stopped further queries'
      : (st.dropped?.duplicate_text || 0) + (st.dropped?.near_duplicate || 0) > st.usable * 2 ? 'the source keeps returning the same ads/videos (heavy duplication)'
      : vis?.relations?.same_brand_other_model ? "the source's results are mostly OTHER models of the brand (correctly rejected)"
      : 'few matching videos exist for this exact product'
    }.`);
  }
}

h('SUMMARY');
const ig = s.stats?.instagram?.usable ?? 0;
const meta = s.stats?.meta?.usable ?? 0;
line(`Instagram ${ig}/20, Meta ${meta}/20 -> ${ig >= 20 && meta >= 20 ? '20+20 reached by count' : 'target not met on every source'}.`);
line('Counts are the system\'s own; correctness should be checked by looking at the thumbnails (docs/test-results.md).');
