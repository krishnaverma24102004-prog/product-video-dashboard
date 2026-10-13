// Read-only: replays STORED judge verdicts through the current verdict.js rules (judge v2) to estimate how
// many previously accepted videos would still be accepted. Never writes to the database.
//
// Usage: node scripts/verdict-replay.js <searchId>=<Brand>|<Model>|<brandSource> [...] [--db path] [--judge model]
//   e.g. 6be0b98c-...=Crocs|Classic Clog|named
// Stored rows only have {vlm score, reason}, so they go through verdict.js's legacy mapping (score -> relation,
// contradiction check on the reason, brand evidence from the caption/advertiser). The real v2 judge also returns
// brandMatch/modelMatch, so treat this as an estimate.
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/config.js';
import { combineScores, isBelowThreshold } from '../src/scoring.js';
import { normalizeIdentity } from '../src/vision/identity.js';
import { interpretVerdict } from '../src/vision/verdict.js';

const args = process.argv.slice(2);
const opt = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);
const dbPath = opt('--db', config.dbPath);
const judgeModel = opt('--judge', 'gemini-flash-lite-latest');
const specs = args.filter((a) => a.includes('=') && !a.startsWith('--'));
const db = new DatabaseSync(dbPath, { readOnly: true });

const rowsFor = db.prepare(`SELECT v.platform, v.caption, v.author, v.url, sv.clip, sv.vlm, sv.score, sv.below, sv.reason
  FROM search_videos sv JOIN videos v ON v.uid = sv.uid WHERE sv.search_id = ? ORDER BY sv.score DESC`);

for (const spec of specs) {
  const [id, rest] = spec.split('=');
  const [brand, model, brandSource = 'named'] = rest.split('|');
  const s = db.prepare('SELECT input, stats FROM searches WHERE id = ?').get(id);
  if (!s) {
    console.log(`\n${id}: not found`);
    continue;
  }
  const threshold = JSON.parse(s.stats || '{}').threshold ?? config.matchThreshold;
  const identity = normalizeIdentity({ title: s.input }, { brand, model, brandSource, correctedName: `${brand} ${model}` });
  console.log(`\n=== ${s.input}  [${id.slice(0, 8)}]  identity=${identity.brand} / ${identity.model} (${identity.brandSource}, verified=${identity.verified})  judge=${judgeModel}`);
  for (const platform of ['instagram', 'meta']) {
    const rows = rowsFor.all(id).filter((r) => r.platform === platform);
    let oldAcc = 0;
    let newAcc = 0;
    const statuses = {};
    const top20Old = rows.filter((r) => !r.below).slice(0, 20);
    let top20Kept = 0;
    for (const r of rows) {
      const wasAccepted = !r.below;
      let accepted = wasAccepted;
      let status = 'clip_only';
      if (r.vlm != null) {
        // strip a previous label ("Exact match: ...") if this row was already judged by v2
        const v = interpretVerdict({ score: r.vlm, reason: String(r.reason).replace(/^[^:]{3,60}:\s/, '') }, { identity, caption: r.caption, author: r.author, clip: r.clip, judgeModel });
        accepted = !isBelowThreshold(combineScores({ vlm: v.vlm, clip: r.clip }), threshold);
        status = v.status;
      }
      statuses[status] = (statuses[status] || 0) + 1;
      if (wasAccepted) oldAcc++;
      if (accepted) newAcc++;
      if (wasAccepted && top20Old.includes(r) && accepted) top20Kept++;
    }
    console.log(`  ${platform.padEnd(9)} accepted old=${String(oldAcc).padStart(3)}  replayed=${String(newAcc).padStart(3)}  | of the old top-20 accepted, still accepted: ${top20Kept}/${top20Old.length}  | statuses ${JSON.stringify(statuses)}`);
  }
}
