// Runs products through the live API one at a time and records the evidence the assignment asks for.
// Usage (backend running on :4000):
//   node scripts/evaluate.js [--repeat] [--plan plan.json] [--json out.json] [--no-md]
// plan.json: [{ "label": "...", "input": "keyword or URL (may be empty)", "image": "path/to/photo.jpg" }]
// Without --plan the built-in product list is used. Unless --no-md, writes docs/test-results.md.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';

const API = process.env.API || `http://localhost:${config.port}`;
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const DEFAULT_PLAN = [
  'https://www.allbirds.com/products/mens-tree-runners',
  'protein dark chocolate',
  'oversized graphic tee',
  'stanley quencher tumbler',
  'https://www.amazon.in/dp/B0CHX1W1XY',
].map((input) => ({ label: input, input }));
const plan = arg('--plan') ? JSON.parse(fs.readFileSync(arg('--plan'), 'utf8')) : DEFAULT_PLAN;
const repeat = process.argv.includes('--repeat');

const inputType = (p) => (p.image && !p.input ? 'image' : /^https?:\/\//i.test(p.input || '') ? 'url' : p.image ? 'keyword+image' : 'keyword');

async function run(p) {
  const headers = { 'content-type': 'application/json', ...(config.apiToken ? { 'x-api-token': config.apiToken } : {}) };
  const body = { input: p.input || '' };
  if (p.image) body.imageBase64 = `data:image/jpeg;base64,${fs.readFileSync(p.image).toString('base64')}`;
  const res = await fetch(`${API}/api/search`, { method: 'POST', headers, body: JSON.stringify(body) });
  const { id, error } = await res.json();
  if (!id) throw new Error(`search not accepted (${res.status}): ${error}`);
  for (;;) {
    const s = await (await fetch(`${API}/api/search/${id}`)).json();
    if (['done', 'error', 'needs_hint'].includes(s.status)) return s;
    await new Promise((r) => setTimeout(r, 4000));
  }
}

const sum = (o = {}) => Object.values(o).reduce((a, b) => a + b, 0);
const records = [];
for (const p of plan) {
  for (const pass of repeat ? [1, 2] : [1]) {
    process.stdout.write(`> ${p.label} (pass ${pass}) ... `);
    const t = Date.now();
    let s;
    try {
      s = await run(p);
    } catch (e) {
      console.log('FAILED', e.message);
      records.push({ label: p.label, pass, type: inputType(p), status: 'not_accepted', error: e.message });
      continue;
    }
    const ig = s.stats?.instagram ?? {};
    const meta = s.stats?.meta ?? {};
    const rec = {
      label: p.label, pass, type: inputType(p), id: s.id, status: s.status, error: s.error ?? null,
      seconds: Math.round((Date.now() - t) / 1000), statsMs: s.stats?.ms ?? null,
      brain: s.product?.attributes?.source ?? null, name: s.product?.attributes?.correctedName ?? s.product?.title ?? null,
      vision: s.stats?.vision ?? null, deadlineReached: Boolean(s.stats?.deadlineReached),
      instagram: { usable: ig.usable ?? 0, below: ig.below ?? 0, seenBefore: ig.dropped?.seen_before ?? 0, duplicatesRemoved: sum(ig.dropped) - (ig.dropped?.seen_before ?? 0), dropped: ig.dropped ?? {}, queries: ig.queriesTried ?? [], error: ig.error ?? null, notes: ig.notes ?? [] },
      meta: { usable: meta.usable ?? 0, below: meta.below ?? 0, seenBefore: meta.dropped?.seen_before ?? 0, duplicatesRemoved: sum(meta.dropped) - (meta.dropped?.seen_before ?? 0), dropped: meta.dropped ?? {}, queries: meta.queriesTried ?? [], error: meta.error ?? null, notes: meta.notes ?? [] },
      guesses: s.product?.guesses ?? null,
    };
    records.push(rec);
    console.log(s.status, `IG ${rec.instagram.usable} / Meta ${rec.meta.usable} in ${rec.seconds}s, gemini ${rec.vision?.calls ?? '-'}/${rec.vision?.budget ?? '-'} (${rec.vision?.status ?? '-'})`);
  }
}

if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(records, null, 2));

if (!process.argv.includes('--no-md')) {
  const row = (r) => `| ${r.label} | ${r.type} | ${r.pass} | ${r.status} | ${r.instagram?.usable ?? 0}/20 | ${r.meta?.usable ?? 0}/20 | ${(r.instagram?.seenBefore ?? 0) + (r.meta?.seenBefore ?? 0)} | ${(r.instagram?.duplicatesRemoved ?? 0) + (r.meta?.duplicatesRemoved ?? 0)} | ${r.seconds ?? '-'}s | ${r.vision ? `${r.vision.calls}/${r.vision.budget} ${r.vision.status}` : '-'} |`;
  const md = `# Test results\n\nGenerated ${new Date().toISOString()} by \`backend/scripts/evaluate.js\`.\n\n| Product | Input | Pass | Status | Instagram usable | Meta usable | Seen before | Duplicates removed | Time | Gemini calls |\n|---|---|---|---|---|---|---|---|---|---|\n${records.map(row).join('\n')}\n`;
  const out = path.resolve(config.root, '..', 'docs', 'test-results.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md);
  console.log(`wrote ${out}`);
}
