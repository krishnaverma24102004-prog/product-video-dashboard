#!/usr/bin/env node
/**
 * READ-ONLY re-scoring report.
 *
 * Recomputes every stored search_videos row with the OLD (v1) combine formula and with candidate
 * replacement formulas, and prints how accept/reject decisions would change. It never writes to the
 * database: the file is opened with { readOnly: true } and only SELECT statements are run.
 * Historical scores are intentionally left untouched; new searches use the current scoring.js.
 *
 * Usage:  node scripts/rescore-report.js [path/to/app.db]      (default: config.dbPath)
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { config } from '../src/config.js';
import { combineScores, clipOnlyScore, SCORING_VERSION } from '../src/scoring.js';

const dbPath = process.argv[2] || config.dbPath;
if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/** v1, exactly as shipped before SCORING_VERSION 2. */
function oldCombine({ clip, vlm }) {
  if (vlm == null && clip == null) return 0;
  if (vlm == null) return Math.round(clip);
  if (clip == null) return Math.round(vlm);
  return Math.round(0.65 * vlm + 0.35 * clip);
}

/** Candidate A: the brief's suggestion (confidence-weighted Gemini, CLIP bonus, vlm<40 capped at vlm+10). */
function candA({ clip, vlm }) {
  if (vlm == null || clip == null) return oldCombine({ clip, vlm });
  const s = clamp((vlm - 60) / 20, 0, 1);
  const w = 0.65 + 0.35 * s;
  let score = w * vlm + (1 - w) * clip + s * Math.min(5, Math.max(0, (clip - 60) / 8));
  if (vlm < 40) score = Math.min(score, vlm + 10);
  return Math.round(clamp(score));
}

/** Candidate B: A, but any non-exact Gemini verdict (vlm<60) is capped at vlm-10: CLIP can never lift it. */
function candB({ clip, vlm }) {
  if (vlm == null || clip == null) return oldCombine({ clip, vlm });
  const s = clamp((vlm - 60) / 20, 0, 1);
  const w = 0.65 + 0.35 * s;
  let score = w * vlm + (1 - w) * clip + s * Math.min(5, Math.max(0, (clip - 60) / 8));
  if (vlm < 60) score = Math.min(score, vlm - 10);
  return Math.round(clamp(score));
}

/** Candidate C: keep v1 blend, floor at vlm when Gemini is confident (>=70), cap vlm-10 when vlm<60. */
function candC({ clip, vlm }) {
  if (vlm == null || clip == null) return oldCombine({ clip, vlm });
  let score = 0.65 * vlm + 0.35 * clip;
  if (vlm >= 70) score = Math.max(score, vlm);
  if (vlm < 60) score = Math.min(score, vlm - 10);
  return Math.round(clamp(score));
}

const CANDIDATES = { A: candA, B: candB, C: candC };

const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

const searches = new Map();
for (const s of db.prepare('SELECT id, input, options, stats FROM searches').all()) {
  const stats = parse(s.stats);
  const opts = parse(s.options);
  const threshold = stats?.threshold ?? opts?.threshold ?? config.matchThreshold ?? 50;
  searches.set(s.id, { input: s.input, threshold });
}

const rows = db
  .prepare(
    `SELECT sv.search_id, sv.uid, sv.score, sv.clip, sv.vlm, sv.reason, sv.below, v.platform
       FROM search_videos sv LEFT JOIN videos v ON v.uid = sv.uid`,
  )
  .all();
db.close();

const band = (vlm) =>
  vlm == null ? 'clip-only' : vlm >= 80 ? '80+' : vlm >= 70 ? '70-79' : vlm >= 60 ? '60-69' : vlm >= 40 ? '40-59' : '<40';

const out = (...a) => console.log(...a);
out(`Rescore report (read-only)  db=${dbPath}  current SCORING_VERSION=${SCORING_VERSION}`);
out(`Total rows: ${rows.length}`);
const withVlm = rows.filter((r) => r.vlm != null);
out(`Rows with Gemini verdict (vlm): ${withVlm.length}`);
out(`CLIP-only rows: ${rows.length - withVlm.length}  (CLIP-only path is unchanged by v2)`);

// ---- sanity: stored scores vs OLD recomputation ----
let ok = 0;
const bad = [];
let clipOnlyOk = 0;
const clipOnlyBad = [];
for (const r of rows) {
  const th = searches.get(r.search_id)?.threshold ?? 50;
  if (r.vlm != null) {
    if (oldCombine(r) === r.score) ok++;
    else bad.push(r);
  } else {
    // caption terms are not stored, so check the clipOnlyScore envelope: clip <= score <= clipOnlyScore(clip, 100)
    const lo = r.clip == null ? 0 : Math.round(r.clip);
    const hi = clipOnlyScore(r.clip, 100);
    if (r.score >= lo && r.score <= hi) clipOnlyOk++;
    else clipOnlyBad.push(r);
  }
  if (Boolean(r.below) !== r.score < th) bad.push({ ...r, why: 'below flag mismatch' });
}
out(`\nSanity: Gemini rows whose stored score == OLD formula: ${ok}/${withVlm.length}` +
  (bad.length ? `  MISMATCHES: ${bad.length}` : '  (all match)'));
for (const r of bad.slice(0, 5)) out('   mismatch', JSON.stringify({ uid: r.uid, score: r.score, clip: r.clip, vlm: r.vlm, below: r.below, why: r.why }));
out(`Sanity: CLIP-only rows within clipOnlyScore envelope [clip, clipOnlyScore(clip,100)]: ${clipOnlyOk}/${rows.length - withVlm.length}`);
for (const r of clipOnlyBad.slice(0, 5)) out('   out-of-envelope', JSON.stringify({ uid: r.uid, score: r.score, clip: r.clip }));

// ---- per-formula accept counts ----
function evaluate(fn) {
  return rows.map((r) => {
    const th = searches.get(r.search_id)?.threshold ?? 50;
    const oldScore = r.vlm != null ? oldCombine(r) : r.score; // CLIP-only rows: stored score (formula unchanged)
    const newScore = r.vlm != null ? fn(r) : r.score;
    return { ...r, th, oldScore, newScore, oldAcc: oldScore >= th, newAcc: newScore >= th };
  });
}

function tally(res, keyFn) {
  const m = new Map();
  for (const r of res) {
    const k = keyFn(r);
    const t = m.get(k) || { n: 0, old: 0, new: 0 };
    t.n++;
    if (r.oldAcc) t.old++;
    if (r.newAcc) t.new++;
    m.set(k, t);
  }
  return m;
}

const fmt = (m) => [...m.entries()].map(([k, t]) => `    ${String(k).padEnd(56)} n=${String(t.n).padStart(3)}  old=${String(t.old).padStart(3)}  new=${String(t.new).padStart(3)}`).join('\n');

// current scoring.js must equal candidate B (the chosen one)
let currentEqB = 0;
for (const r of withVlm) if (combineScores({ clip: r.clip, vlm: r.vlm }) === candB(r)) currentEqB++;
out(`\nscoring.js combineScores == candidate B on ${currentEqB}/${withVlm.length} Gemini rows`);

const summary = [];
for (const [name, fn] of Object.entries(CANDIDATES)) {
  const res = evaluate(fn);
  const toRej = res.filter((r) => r.oldAcc && !r.newAcc);
  const toAcc = res.filter((r) => !r.oldAcc && r.newAcc);
  summary.push({ name, old: res.filter((r) => r.oldAcc).length, new: res.filter((r) => r.newAcc).length, toRej: toRej.length, toAcc: toAcc.length });

  out(`\n================ Candidate ${name} ================`);
  out(`Above threshold overall: old=${res.filter((r) => r.oldAcc).length}  new=${res.filter((r) => r.newAcc).length}  (of ${res.length})`);
  out('  per platform:\n' + fmt(tally(res, (r) => r.platform || '?')));
  out('  per search input:\n' + fmt(tally(res, (r) => `${(searches.get(r.search_id)?.input || '?').slice(0, 40)} [${r.search_id.slice(0, 8)}]`)));
  const bands = tally(res, (r) => band(r.vlm));
  const order = ['80+', '70-79', '60-69', '40-59', '<40', 'clip-only'];
  out('  per vlm band:\n' + fmt(new Map(order.filter((b) => bands.has(b)).map((b) => [b, bands.get(b)]))));
  const ex = (r) => `    vlm ${String(r.vlm).padStart(3)} clip ${String(r.clip).padStart(3)}  old ${String(r.oldScore).padStart(3)} -> new ${String(r.newScore).padStart(3)} (th ${r.th}) [${r.platform}] "${(r.reason || '').slice(0, 90)}"`;
  out(`  flips accept->reject: ${toRej.length}`);
  for (const r of toRej.slice(0, 8)) out(ex(r));
  out(`  flips reject->accept: ${toAcc.length}`);
  for (const r of toAcc.slice(0, 8)) out(ex(r));
}

out('\n================ Summary ================');
for (const s of summary) out(`  ${s.name}: accepted old=${s.old} new=${s.new}  accept->reject=${s.toRej}  reject->accept=${s.toAcc}`);
out('\n(No rows were modified. This report is the documented re-scoring operation; historical scores stay as stored.)');
