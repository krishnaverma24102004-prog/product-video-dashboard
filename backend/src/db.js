import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS searches(
  id TEXT PRIMARY KEY, input TEXT, input_type TEXT, status TEXT,
  options TEXT, product TEXT, stats TEXT, error TEXT, created_at INTEGER, finished_at INTEGER);
CREATE TABLE IF NOT EXISTS videos(
  uid TEXT PRIMARY KEY, platform TEXT, video_id TEXT, url TEXT, media_url TEXT, thumb TEXT,
  caption TEXT, author TEXT, posted_at INTEGER, phash TEXT, text_key TEXT, first_seen INTEGER);
CREATE TABLE IF NOT EXISTS search_videos(
  search_id TEXT, uid TEXT, score REAL, clip REAL, vlm REAL, reason TEXT,
  below INTEGER, seen_before INTEGER, matched_query TEXT,
  PRIMARY KEY(search_id, uid));
CREATE INDEX IF NOT EXISTS idx_sv_uid ON search_videos(uid);
CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, value TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS shortlist(uid TEXT PRIMARY KEY, created_at INTEGER);
`);

const q = (sql) => db.prepare(sql);
const stmts = {
  insSearch: q(`INSERT INTO searches(id,input,input_type,status,options,created_at) VALUES(?,?,?,?,?,?)`),
  updSearch: q(`UPDATE searches SET status=?, product=?, stats=?, error=?, finished_at=? WHERE id=?`),
  setStatus: q(`UPDATE searches SET status=? WHERE id=?`),
  getSearch: q(`SELECT * FROM searches WHERE id=?`),
  history: q(`SELECT s.*, (SELECT COUNT(*) FROM search_videos sv WHERE sv.search_id=s.id) AS n
              FROM searches s ORDER BY created_at DESC LIMIT ?`),
  upsertVideo: q(`INSERT INTO videos(uid,platform,video_id,url,media_url,thumb,caption,author,posted_at,phash,text_key,first_seen)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                  ON CONFLICT(uid) DO UPDATE SET thumb=excluded.thumb, media_url=excluded.media_url,
                  phash=COALESCE(excluded.phash, videos.phash)`),
  insSV: q(`INSERT OR REPLACE INTO search_videos(search_id,uid,score,clip,vlm,reason,below,seen_before,matched_query)
            VALUES(?,?,?,?,?,?,?,?,?)`),
  resultsFor: q(`SELECT v.*, sv.score, sv.clip, sv.vlm, sv.reason, sv.below, sv.seen_before, sv.matched_query,
                 EXISTS(SELECT 1 FROM shortlist s WHERE s.uid=v.uid) AS starred
                 FROM search_videos sv JOIN videos v ON v.uid=sv.uid WHERE sv.search_id=? ORDER BY sv.score DESC`),
  // videos returned by any *other* search -> "seen"
  seenRows: q(`SELECT DISTINCT v.uid, v.phash, v.text_key FROM videos v
               JOIN search_videos sv ON sv.uid=v.uid WHERE sv.search_id<>? AND sv.below=0`),
  getCache: q(`SELECT value, created_at FROM cache WHERE key=?`),
  setCache: q(`INSERT OR REPLACE INTO cache(key,value,created_at) VALUES(?,?,?)`),
  star: q(`INSERT OR IGNORE INTO shortlist(uid,created_at) VALUES(?,?)`),
  unstar: q(`DELETE FROM shortlist WHERE uid=?`),
  shortlist: q(`SELECT v.*, 1 AS starred FROM shortlist s JOIN videos v ON v.uid=s.uid ORDER BY s.created_at DESC`),
};

export const store = {
  createSearch: (id, input, type, options) =>
    stmts.insSearch.run(id, input, type, 'queued', JSON.stringify(options || {}), Date.now()),
  setStatus: (id, status) => stmts.setStatus.run(status, id),
  finishSearch: (id, { status, product, stats, error }) =>
    stmts.updSearch.run(status, JSON.stringify(product ?? null), JSON.stringify(stats ?? null), error ?? null, Date.now(), id),
  getSearch: (id) => stmts.getSearch.get(id),
  history: (limit = 50) => stmts.history.all(limit),
  results: (id) => stmts.resultsFor.all(id),
  seen: (excludeSearchId) => stmts.seenRows.all(excludeSearchId),
  saveVideo: (v) =>
    stmts.upsertVideo.run(v.uid, v.platform, v.videoId, v.url, v.mediaUrl ?? null, v.thumb ?? null,
      v.caption ?? '', v.author ?? '', v.postedAt ?? null, v.phash ?? null, v.textKey ?? null, Date.now()),
  saveMatch: (searchId, v) =>
    stmts.insSV.run(searchId, v.uid, v.score, v.clip ?? null, v.vlm ?? null, v.reason ?? '', v.below ? 1 : 0,
      v.seenBefore ? 1 : 0, v.query ?? null),
  /** All of a search's videos + match rows in one transaction, so a crash mid-save leaves none rather than half. */
  saveResults(searchId, videos) {
    db.exec('BEGIN');
    try {
      for (const v of videos) {
        store.saveVideo(v);
        store.saveMatch(searchId, v);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
  cacheGet(key, ttlMs) {
    const r = stmts.getCache.get(key);
    if (!r || (ttlMs && Date.now() - r.created_at > ttlMs)) return null;
    return JSON.parse(r.value);
  },
  cacheSet: (key, value) => stmts.setCache.run(key, JSON.stringify(value), Date.now()),
  star: (uid) => stmts.star.run(uid, Date.now()),
  unstar: (uid) => stmts.unstar.run(uid),
  shortlist: () => stmts.shortlist.all(),
};
