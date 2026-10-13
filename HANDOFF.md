# HANDOFF â€” read this first

> For the next coding agent. Snapshot: **2026-10-13**. This zip is the whole project **without secrets or local state**:
> - no `backend/.env` (API key)
> - no `backend/.sessions/` (Instagram login)
> - no `backend/data/` (SQLite DB)
> - no `node_modules`, no `frontend/dist`, no `.git`
>
> Everything you need to understand the current state is in this file. The other reports go deeper (see "Documents" below).

---

## 1. What this project is

A take-home assignment: **Product Video Discovery Dashboard**. The user types a product name, pastes a product URL, or drops a photo, and gets **â‰¥20 Instagram Reels + â‰¥20 Meta Ad Library video ads** showing **the exact product**. Each video gets a 0â€“100 match score with a reason, and repeat searches return new videos only.

- **Backend:** Node.js 24 + Express 5, ESM. SQLite via built-in `node:sqlite`. Playwright for Instagram and Meta. Gemini (REST) + local CLIP (`@huggingface/transformers`) for vision.
- **Frontend:** React 19 + Vite. A single page with SSE progress.
- **Instagram:** uses the **owner's own logged-in session**. It calls Instagram's private web search API (`/api/v1/fbsearch/web/top_serp/`) via same-origin `fetch` inside a Playwright page, with a page-browsing fallback.
- **Meta:** the public Ad Library web UI (no login), intercepting its internal GraphQL.

## 2. Current status (honest)

| Area | Status |
|---|---|
| End-to-end search (name / URL / photo-only) | Working, live-tested |
| Instagram â‰¥20 usable | Yes in 22 of 23 searches of the session-2 evaluation; â‰ˆ19â€“20/20 correct in the top 20 when Gemini works. Photo-only is weak (not re-tested in session 2). |
| Meta â‰¥20 usable | **8 of 23** searches. Shortfalls are mostly source-side (few active video ads for the exact model, reseller duplicates). Precision with a healthy judge and all fixes: Adidas Samba OG â‰ˆ19â€“20/20, Philips OneBlade 20/20. **Collapses when Gemini is down** (â‰ˆ9/20 CLIP-only). |
| 20+20 requirement | **NOT claimed for all products.** Shown in two searches (Adidas Samba OG, Philips OneBlade). See `FINAL-EVALUATION-REPORT.md`, Session 2. |
| Search time | Bounded: 240 s deadline, Gemini call budget, circuit breaker. Session 2: 80â€“245 s. |
| Dedupe / repeat-search uniqueness | Verified in the DB: crocs repeat had 0 overlap with the first pass |
| API security | Loopback bind, Origin/Host checks, CORS allowlist, optional token |
| Tests | **167 passing** (`cd backend && npm test`), incl. TikTok and the held-back catch-up pass |
| Docker | Files exist; **image never built**. Docker is not installed on this machine. |
| Git | Repository **initialised, files staged, not committed yet** (waiting for the owner's git identity). |
| Demo video | Not recorded. A script for it is in `docs/demo-script.md`. |

## 3. The LAST change (pass 4): judge v3, made during the session-2 live evaluation

Each fix answers a failure seen live. Details and reasons: `IMPLEMENTATION-REPORT.md`, Pass 4. Results: `docs/test-results.md`.

| # | Change | Files |
|---|---|---|
| 1 | Meta query order: broad branded queries (brand + type, brand) before "review"/"sale" variants; AI branded suggestions capped at 2; `MAX_QUERY_ROUNDS` 6 â†’ 8 | `backend/src/vision/brain.js` (`buildQueries`), `backend/src/config.js` |
| 2 | New `accessory` relation (cases, chargers, protectors *for* the product score 20); exact/variant reasons mentioning "case for"/"accessory" â†’ Uncertain. `JUDGE_VERSION = 3` | `backend/src/vision/verdict.js`, `backend/src/vision/gemini.js` |
| 3 | Product must be visible; a caption or logo naming it is not enough | `backend/src/vision/gemini.js` (judge rules) |
| 4 | Gemini failover timeout 25 s while a healthy fallback remains (60 s otherwise); bench 5 â†’ 15 min | `backend/src/vision/gemini.js` |
| 5 | Meta collector scrolls to 2Ã— the limit (80 ads) per query | `backend/src/collectors/meta.js` |
| 6 | Judge cap per round 32 â†’ 40; candidates ranked out of the cap while the judge works are not accepted ("Not judged â€¦") | `backend/src/vision/brain.js` |
| 7 | CLIP-only fallback during a vision outage requires the caption to name the model (`captionNamesModel`) | `backend/src/vision/brain.js` (`captionNamesModel`) |
| 8 | UI error hint depends on the input type | `frontend/src/App.jsx` |

Tests: 129 â†’ **133** (query order, accessory, cutoff, CLIP-only model naming).

**Docs updated for pass 4:** `README.md` (brain, rate limits, test evidence, limitations), `docs/test-results.md` (rewritten for session 2), `FINAL-EVALUATION-REPORT.md` (new Session 2 section), `IMPLEMENTATION-REPORT.md` (Pass 4), this file.

## 3a. The change before that (pass 3): Meta exact-product precision

**Problem found in the live 5-product evaluation** (`FINAL-EVALUATION-REPORT.md`):
1. **Brand-less Meta queries.** Gemini-text produced Meta queries like "comfortable casual clogs" for "crocs classic clog", so the Ad Library returned other brands' ads.
2. **Lenient judging.** The Gemini judge (often the *lite* fallback model, because the main models were out of free quota) gave high scores to other brands and models, even when its own reason said "different brand".
3. **Photo-only searches accepted look-alikes.**

**What was changed:**

| File | What |
|---|---|
| `backend/src/vision/identity.js` (**new**) | `normalizeIdentity(product, attrs)` gives `{brand, brandKnown, brandSource, model, name, verified, features}`. `brandSource`: `page` / `named` / `visible` = verified; `inferred` (recognised from the design) = **not verified**; `unknown` = never invent a brand. Plus `brandVariants`, `mentionsBrand`, `mentionsDistinctiveModel`; `GENERIC_MODEL_WORDS` holds words like "classic clog" and "wayfarer", which are NOT brand evidence. |
| `backend/src/vision/verdict.js` (**new**) | `interpretVerdict(verdict, ctx)`: **Gemini classifies, code scores.** See below the table. Defines `JUDGE_VERSION = 2`. |
| `backend/src/vision/gemini.js` | Analysis schemas add `brand`, `brandSource`, `model`, `distinctiveFeatures`. Shared `QUERY_RULES`: every Meta query contains the brand when known. The judge returns structured relations, and captions are declared untrusted. `session.lastModel` records which model answered. |
| `backend/src/vision/brain.js` | `buildQueries()` builds Meta queries as exact brand+model â†’ the model's *branded* suggestions â†’ branded variants (colour / feature / review / sale) â†’ brand + type â†’ brand; **generic phrases are dropped**. Brand unknown â†’ name/type + distinctive features. `scoreWithVlm()` routes verdicts through `interpretVerdict`. Cache keys bumped (`attrs:v3`, `textattrs:v2`). |
| `backend/src/pipeline.js` | `publicProduct.identity`; `stats.vision` adds `judgeVersion`, `judgeModels`, `relations`, `matchStatus` |
| `frontend/src/components.jsx`, `App.css` | `IdentityLine` (verified / inferred / unknown), a "Distinctive" row, and reason prefixes ("Exact match:", "Variant:", "Competitor brand:", "Uncertain â€¦") |
| `backend/scripts/verdict-replay.js` (**new**) | Read-only replay of stored verdicts through the new rules |
| `backend/test/exact-product.test.js` (**new**) | 20 tests: branded queries, competitor, other model, contradiction, unknown brand, image-only expansion, lite distrust, quota fallback, history preservation |

**`interpretVerdict` steps:**
1. **Relation â†’ score:**

   | Relation | Score | Passes threshold 50? |
   |---|---|---|
   | `exact` | 80â€“100 | yes |
   | `variant` | 62â€“75 | yes |
   | `same_brand_other_model` | 35 | no |
   | `category` | 25 | no |
   | `competitor` | 15 | no |
   | `not_visible` | 10 | no |
   | `unrelated` | 5 | no |

2. **Contradiction:** a reason or field that contradicts exact/variant ("different brand", "dupe", "similar to", "-style", `brandMatch: different`) makes it **Uncertain**, capped at 45 (rejected).
3. **Brand evidence:** exact/variant needs a logo the judge saw, or the brand or a distinctive model name in the caption. A lite model also needs caption or CLIP â‰¥55 support. Otherwise it is **Unverified**, capped at 48.
4. **Brand unknown:** "Visual match (identity unverified)", capped at 72.

**Results of the last change:**
- **Offline replay** of the old evaluation (read-only): wrong-brand Meta accepts are mostly removed (crocs Meta: â‰ˆ2â€“3 correct â†’ 1 kept; crocs repeat: â‰ˆ16â€“18 correct â†’ 16 kept). Cost: some correct Instagram videos are now "Unverified" when the caption names neither the brand nor the model (iPhone Instagram: 13/20 kept).
- **Live test, 2 fresh products, lite judge only:**

  | Product | Instagram count | Meta count | Manually verified top 20 (IG / Meta) |
  |---|---|---|---|
  | Nike Air Force 1 | 36 | 21 | 20/20 / 20/20 AF1 (â‰ˆ8 exact white, rest variants) |
  | Owala FreeSip | 25 | 26 | â‰ˆ19/20 / 20/20 Owala (â‰ˆ18â€“19 FreeSip) |

**Not changed in that pass:** collectors, `scoring.js` (formula v2), dedupe, DB schema, circuit breaker, deadline, CLIP fallback, threshold (50).

## 4. Earlier passes (short)

- **Pass 1, build:** the full app.
- **Pass 2, stabilization** (`IMPLEMENTATION-REPORT.md`, lower section):
  - **Gemini circuit breaker:** each model tried once per call; on quota/5xx for all models it opens for the rest of the search; auth/400 errors are not retried.
  - **Limits:** a per-search **deadline** of 240 s and a **budget** of 24 calls; a watchdog; transactional result save.
  - **Scoring v2** (`scoring.js`): Gemini's verdict leads, CLIP gives a +5 bonus only when Gemini is confident, and CLIP can't lift a Gemini score below 60.
  - **API security:** `HOST=127.0.0.1`, an `ALLOWED_ORIGINS` / `ALLOWED_HOSTS` allowlist, Origin / `Sec-Fetch-Site` check on writes, and an optional `API_TOKEN`.
- **5-product live evaluation** (`FINAL-EVALUATION-REPORT.md`, `docs/test-results.md`): IG strong; Meta precision poor, which led to pass 3.

## 5. What to do next (priority order)

1. **Re-run the evaluation when the full Gemini model is available** (in session 2, `gemini-3.5-flash` and `gemini-flash-latest` returned 429/503 all day, and from about 14:35 every model was overloaded). Two searches with a working judge on the all-fixes code reached 20+20 exact (Samba, OneBlade); Stanley ProTour showed that "variant" is too broad for sibling models, and the held-back catch-up pass (fix 9) is unit-tested but not yet live-tested. Use **fresh products**, because repeat products are filtered as `seen_before`, and include a photo-only search.

   ```bash
   cd backend && node scripts/evaluate.js --plan plan.json --json results.json --no-md
   # plan.json: [{"label":"...","input":"keyword or URL"},{"label":"photo","input":"","image":"path.jpg"}]
   ```

   **Acceptance:** for each product, â‰¥20 usable **and** â‰¥18/20 manually verified correct on **both** Instagram and Meta in the same search. Review the top-20 thumbnails by hand; counts alone are not proof. Then update `docs/test-results.md` and `FINAL-EVALUATION-REPORT.md`.
2. **Consider a second free judge model chain** (another free vision model provider behind the same `interpretVerdict` rules), so a Gemini outage doesn't drop the search to CLIP-only, where Meta precision collapses (â‰ˆ9/20 seen).
3. **Frame sampling** (3â€“4 frames per video) instead of thumbnail-only scoring. Fix 3 now rejects ads whose thumbnail shows only the logo, and some of those show the product later in the video.
4. **TikTok** (bonus), if it is not done yet (a `backend/src/collectors/tiktok.js` file now exists; check its state first).
5. **Check whether "Unverified" rejections hurt Instagram counts** (`stats.vision.matchStatus`), and whether "Variant" is too broad (colourways, editions, collabs). Don't relax the rules without evidence.
6. Nice-to-have, from earlier audits:
   - Incremental result persistence (results are saved only at the end of a search).
   - SSE auto-reconnect (`App.jsx` `follow()`).
   - Persisting Instagram cookies in XHR mode (`closeInstagramSession` is never called).
7. **Owner tasks:** set a git identity and make the first commit (the repo is initialised and staged); build the Docker image on a machine with Docker (`docker compose up --build`); record the demo following `docs/demo-script.md`.

## 6. Setup on a new machine

```bash
cd backend
cp .env.example .env              # set GEMINI_API_KEY (free key: https://aistudio.google.com/apikey)
npm install
npx playwright install chromium
npm run ig:login                  # opens Edge/Chrome; the OWNER logs in to Instagram; saved to backend/.sessions/ig.json
npm run dev                       # API on http://127.0.0.1:4000
cd ../frontend && npm install && npm run dev   # dashboard on http://localhost:5173
cd ../backend && npm test         # 167 tests, temp DBs, stubbed fetch, no live calls
```

The database (`backend/data/app.db`) is created automatically and is empty on a fresh machine: the searches from development and evaluation are **not** in this zip. The CLIP model (~580 MB) downloads on the first search.

## 7. Gotchas (Windows machine this was built on)

- **npm blocked:** PowerShell blocks `npm.ps1`, so use `npm.cmd` (e.g. `npm.cmd run ig:login`).
- **Login browser:** Playwright's bundled headed Chromium is blocked by Windows Smart App Control ("side-by-side configuration"). `ig:login` therefore uses the installed **Edge/Chrome** (`LOGIN_BROWSER=msedge|chrome`), and collection uses the headless shell. `HEADLESS=false` fails there.
- **Blank page after an edit:** Vite HMR sometimes misses the second of two rapid edits to `components.jsx`, leaving a blank page ("X is not defined"). Restart `npm run dev`. The production build is unaffected.
- **Gemini model names change.** `gemini-2.5-flash` was retired (404). Defaults: `GEMINI_MODEL=gemini-3.5-flash`, `GEMINI_FALLBACK_MODELS=gemini-3.1-flash-lite,gemini-flash-latest,gemini-3.5-flash-lite,gemini-flash-lite-latest` (each model has its own free quota; `gemini-3.1-flash-lite` scored 9/9 on the judge bench and is fastest). `gemini-2.5-flash(-lite)` return 404 for new users. Gemma 4 is available on the same key but gave malformed JSON.
- **Instagram daily cap:** `IG_DAILY_PAGE_CAP=250`, counted per API page. One search uses about 5â€“10 pages.
- **Restarting the backend kills an in-flight search** (marked "Server restarted during search").

## 8. Rules the owner set (keep following them)

- Never print or commit API keys, Instagram cookies or session data. Refer to env-var names only.
- Don't rebuild the app or change the DB schema unnecessarily. Don't rewrite working collectors.
- Don't overwrite historical scores. Re-scoring is done only through read-only reports (`scripts/rescore-report.js`, `scripts/verdict-replay.js`).
- Don't relax the match threshold to hit the target. Report counts and manually verified accuracy **separately**. Never claim 20+20 from one search or from card counts alone.
- Don't deliberately exhaust live API quotas; use mocked tests for routine checks.
- Don't push to a remote or publish anything without the owner's approval.

## 9. Documents in this zip

| File | What it is | Note |
|---|---|---|
| `HANDOFF.md` | This file: current state, the last change, and the next steps | **Start here** |
| `IMPLEMENTATION-REPORT.md` | Pass 4 (top), pass 3, pass 2: changed files, reasons, tests, results, limitations | Current |
| `FINAL-EVALUATION-REPORT.md` | Session 2 (23 searches, judge v3) on top; session 1 (the 5-product evaluation that found the Meta precision problem) below | Current |
| `docs/test-results.md` | Per-search counts, manual precision and code version for session 2; short session-1 summary | Current |
| `docs/demo-script.md` | Script for the demo video | For the owner |
| `TECHNICAL_HANDOVER.md` | Full code audit / architecture map | **Before passes 2â€“4**: its bug list and plan are partly fixed now. Use it for architecture and file map. |
| `README.md` | Setup, architecture, collection methods, scoring, security, limitations | Current |
| `backend/.env.example` | Every config variable with its default (no values for secrets) | Current |
