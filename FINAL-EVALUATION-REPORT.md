# Final Evaluation Report â€” Product Video Discovery Dashboard

> Date: 2026-10-13. Evaluator: the coding agent, with every check run directly in this session.
> Evidence types are labelled throughout:
> - **[LIVE]** a real search against Instagram, Meta and Gemini
> - **[MOCK]** unit or integration tests with stubbed `fetch` / temp DB
> - **[INSPECT]** code or DB inspection
> - **[UI]** checked in the browser
>
> The threshold was not relaxed (50). No historical data was modified or deleted. Nothing was pushed to a remote. No demo was recorded.
>
> This file has two sessions. The newest is first:
> 1. **Session 2 (after judge v3):** 18 live searches, with fixes made during the run.
> 2. **Session 1 (before judge v3):** the original five-product evaluation that found the Meta precision problem.

---

# Session 2 (after judge v3)

> Date: 2026-10-13, later the same day. Windows, Node 24. Instagram via the owner's logged-in session; Meta via the public Ad Library. Threshold 50 throughout. Per-search detail: [`docs/test-results.md`](docs/test-results.md). Code changes: `IMPLEMENTATION-REPORT.md`, Pass 4.

## S2.1 Conditions [LIVE]

| Item | State |
|---|---|
| Gemini | `gemini-3.5-flash` 429/503 and `gemini-flash-latest` 503 all day, so **`gemini-flash-lite-latest` did the judging**. From about 14:35 local, **all** Gemini models returned 503 or timed out for long stretches (Google-side overload); the last searches ran mostly CLIP-only. |
| Code | Improved **during** the run (fixes 1â€“7, judge v3). Each search is labelled Aâ€“E by the code it ran on (see `docs/test-results.md`). Only the last 5 searches ran on all fixes, and 4 of those hit the Gemini outage. |
| Precision method | Manual count from thumbnail contact sheets of the top 20 accepted per platform, plus browser spot checks. Manual judgement, not ground truth. |

## S2.2 Summary [LIVE + visual review]

| | Result |
|---|---|
| Searches | 18 (17 products + 1 crocs repeat): 14 keyword, 3 product URLs, 0 photo-only |
| Instagram â‰¥20 usable | **22 of 23** (the exception: Allbirds Dasher NZ, a niche colourway, 6, during the outage) |
| Instagram precision (top 20, reviewed searches) | â‰ˆ19â€“20/20 when the judge was working |
| Meta â‰¥20 usable | **8 of 23** |
| Meta precision, healthy judge + all fixes | Adidas Samba OG: 33 usable, **â‰ˆ19â€“20/20** correct; Philips OneBlade: 34 usable, **20/20** |
| Meta precision before the fixes / during the outage | â‰ˆ4â€“5/15 (iPhone 15, accessories) to â‰ˆ11â€“15/20 typical; â‰ˆ9/20 CLIP-only (AF1, Supersonic) |
| Repeat search (crocs) | 54 / 49 accepted, **0 overlap**; pass 2 dropped 36 Instagram + 9 Meta as `seen_before` |
| Search time | 80â€“245 s; two searches reached the 240 s deadline (AirPods Pro 2, Apple Watch Ultra 2) |
| Tests | 167 passing (129 before the session) [MOCK] |

## S2.3 What went wrong, and the fix made for it

| Observation [LIVE] | Fix |
|---|---|
| Crocs/Stanley Meta used up 6 rounds on "review/sale" queries that returned the same ads | 1. Broad branded Meta queries first; `MAX_QUERY_ROUNDS` 6 â†’ 8 |
| iPhone 15 Meta: â‰ˆ10 of 15 accepted ads were cases, chargers, lens protectors | 2. `accessory` relation (rejected) |
| Crocs/Birkenstock ads with only a logo or lifestyle scene judged exact | 3. Product must be visible; a caption or logo naming it is not enough |
| `gemini-flash-latest` hung 62 s of a 240 s search | 4. 25 s failover timeout while a healthy fallback remains; 15 min bench |
| More than half of a Meta page was reseller duplicates | 5. Meta collects up to 80 ads per query |
| S24 Ultra Meta: case and repair ads passed CLIP-only at 69â€“86 because they were ranked out of the judge's cap | 6. Judge cap 32 â†’ 40; ranked-out candidates not accepted while the judge works |
| AF1: Gemini died mid-search, and Air Max 95 / Salomon / New Balance passed CLIP-only | 7. CLIP-only fallback needs the caption to name the model |

## S2.4 Conclusions

1. **Instagram meets the target** on every product with normal availability, with â‰ˆ19â€“20/20 correct in the top 20 when Gemini works.
2. **Meta counts often stay below 20, and that is mostly the source.** For several exact models there are few active video ads (YETI Rambler 2, AirPods Pro 2 4, Allbirds 5, Hydro Flask 8), plus heavy reseller duplication. The system reports the shortfall instead of padding it with look-alikes.
3. **With a healthy judge and all fixes, Meta precision is high.** Adidas Samba OG: 37 Instagram / 33 Meta, â‰ˆ19/20 and â‰ˆ19â€“20/20 correct.
4. **Precision collapses when Gemini is down.** CLIP can't separate models of the same brand. Fix 7 limits the damage (10 Oakley ads rejected), but Dyson Supersonic Meta was still â‰ˆ9/20.
5. **Was 20+20 demonstrated across all products? No.** 20+20 exact in one search was shown for **Adidas Samba OG** and **Philips OneBlade** only (searches 19â€“23, on the five-model free Gemini chain, are in `docs/test-results.md`). Stanley ProTour (URL) showed the judge accepts sibling models as "variant". Ray-Ban Wayfarer and Dyson Airwrap reached 20+ on both sources by count, with lower Meta precision. Free-tier Gemini availability is the main external risk.
6. **The all-fixes code has only one search with a healthy judge.** The evaluation should be re-run when the full Gemini model is available (see `HANDOFF.md`).

---

# Session 1 (before judge v3)

## 0. Pre-run state [INSPECT]

| Check | Result |
|---|---|
| Servers on latest code | Backend started 00:10:03, after the last backend source edit at 00:06:39. Frontend Vite started 00:10:06 (HMR). |
| Gemini config (names only) | `GEMINI_MODEL=gemini-3.5-flash`, fallbacks `gemini-flash-latest,gemini-flash-lite-latest`, `GEMINI_RPM=10`, budget 24 per search, deadline 240 s. Key present (value not printed). |
| Gemini availability (1 tiny request per model) | `gemini-3.5-flash` **429**, `gemini-flash-latest` **429**, `gemini-flash-lite-latest` **200**. **The live evaluation was therefore judged mostly by the lite model.** |
| Instagram daily usage | 53/250 pages before the run (`/api/health`) |
| Queue | idle |

## 1. Five-product results [LIVE]

The products were chosen to differ visually: footwear (plastic clog), eyewear, beauty appliance, electronics (URL input), and a knit sneaker (photo-only input). None of them had been searched before, except the deliberate repeat.

| # | Product | Input | **Instagram usable** | **Meta usable** | Both â‰¥20 | Time | Gemini calls | Fallback | Seen before (IG/Meta) | Duplicates removed (IG/Meta) | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | crocs classic clog | keyword | **40** | **21** | âœ… | 116 s | 18/24 | none | 0/0 | 2/13 | none |
| 2 | ray-ban wayfarer sunglasses | keyword | **26** | **18** | âŒ (Meta âˆ’2) | 120 s | 14/24 | none | 0/0 | 0/15 | Meta queries "buy ray ban wayfarer" and "authentic ray ban shades" returned 0 ads |
| 3 | dyson airwrap | keyword | **40** | **23** | âœ… | 116 s | 16/24 | none | 0/0 | 0/30 | none |
| 4 | Apple iPhone 15 (amazon.in URL) | URL | **30** | **22** | âœ… | 197 s | 21/24 | none | 0/0 | 0/37 | none |
| 5 | Allbirds Tree Runner (photo only) | image | **12** | **1** | âŒ | 180 s | 21/24 | none | 0/0 | 0/15 | Query list exhausted (6 rounds) on both sources |
| R | crocs classic clog (repeat of #1) | keyword | **29** | **34** | âœ… | 188 s | 24/24 (budget reached) | none | 32/29 | 0/90 | none |

- No search reached the deadline or tripped the circuit breaker.
- There were no login walls, checkpoints or rate-limit responses from Instagram or Meta.
- Instagram usage after the run: 100/250 pages (`/api/health`), so the 6 searches used 47 Instagram API pages.

## 2. Instagram and Meta counts versus the 20+20 target

| | Instagram â‰¥20 | Meta â‰¥20 | Both in the same search |
|---|---|---|---|
| By the system's "usable" count (5 products) | **4/5** (fails: photo-only, 12) | **3/5** (fails: Ray-Ban 18, photo-only 1) | **3/5** (crocs, dyson, iPhone) |
| By visually verified **exact-product** matches in the top 20 | **4/5** | **0/5** on first-pass searches | **0/5** |

## 3. Match-quality findings [LIVE + visual review]

**Method.** For each search, read-only thumbnail contact sheets were built from the DB for the top 20 accepted results per platform, each tile labelled with its score, Gemini (v) and CLIP (c). The coordinator counted the tiles that show the named or pictured product. This is a manual judgement, not labelled ground truth. The sheets are kept outside the repo because they contain third-party thumbnails.

| # | Instagram (correct / shown) | Meta (correct / shown) | Typical wrong Meta matches |
|---|---|---|---|
| 1 crocs | **20/20** Crocs Classic | **â‰ˆ2â€“3/20** | Other brands' "cloud clogs" scored 72â€“82; sandals (61); other clog brands (51â€“55) |
| 2 Ray-Ban | **20/20** Wayfarer | **â‰ˆ4/18** | Other-brand sunglasses; one reason says "sunglasses from a different brand" with score 75 |
| 3 Dyson | **20/20** Airwrap | **â‰ˆ5â€“7/20** | Storage box only; giveaway graphics; **Dyson Supersonic** (85); "Dyson dupe" (80); another brand (59) |
| 4 iPhone 15 | **20/20** iPhone 15 model (â‰ˆ7 exact black colour; others "same model, different colour", 85) | **â‰ˆ2â€“3/20** | **iPhone 15 Pro / Pro Max** (triple camera) scored 72â€“95, e.g. "iPhone 15 Pro being repaired" (90) |
| 5 Allbirds photo | **â‰ˆ1â€“2/12** | 0â€“1/1 | Look-alike black knit sneakers judged "very similar" (85) |
| R crocs repeat | **â‰ˆ19/20** Crocs (â‰ˆ12 exact Classic) | **â‰ˆ16â€“18/20** Crocs | Mostly correct |

**Root causes:**
1. **Generic Meta queries for keyword searches** [LIVE + INSPECT].
   - `analyseProductText` (gemini.js) produced Meta queries without the brand: "comfortable casual clogs", "lightweight everyday footwear", "best hair styler".
   - The image-analysis prompt requires every query to name the product; **the text prompt does not**.
   - The crocs repeat search reached the branded query "crocs classic clog" and Meta precision rose to â‰ˆ16â€“18/20. That is direct evidence for this cause.
2. **Lenient judging by the lite fallback model** [LIVE]. It assigns "very close" scores (70â€“89) to same-type, different-brand or different-model products, sometimes contradicting its own reason. The keyword-mode rubric ("same product type and matching described attributes" â†’ 70â€“89) also invites this.
3. **CLIP no longer vetoes confident verdicts** (scoring v2, by design). A confident wrong verdict passes, e.g. "iPhone 15 Pro Max back glass repair" (vlm 85, clip 0, accepted).

**Gemini-confirmed matches with low CLIP are not rejected** [LIVE DB + MOCK]:
- Across the 6 evaluation searches (390 match rows), **36 rows had Gemini â‰¥70 and CLIP <30, and 0 were rejected**.
- No row with Gemini â‰¥70 was rejected at all, and **no row with Gemini <60 was accepted**.
- Mocked regression tests pin the same behaviour (vlm 85 / clip 0 â†’ 85; vlm 55 / clip 100 â†’ 45).

## 4. Search durations and AI usage [LIVE]

| Metric | Value |
|---|---|
| Durations | 116 s, 120 s, 116 s, 197 s, 180 s, 188 s (mean â‰ˆ153 s). All under the 240 s deadline. |
| Gemini calls | 18, 14, 16, 21, 21, 24 of 24. The repeat search hit the budget exactly; remaining videos would have been CLIP-only, but none were left unjudged (clipOnly 0). |
| CLIP-only videos | 7, 0, 10, 8, 1, 0 per search. These are candidates outside the top 32 by CLIP in a round, or with failed batches. |
| Models | The two primary models returned 429 at the first call of each search and were benched; `gemini-flash-lite-latest` did the judging (backend logs: `"kind":"quota"` for `gemini-3.5-flash` and `gemini-flash-latest`). |
| Before vs after the stabilization pass | Before: one search took 643 s with all models failing. After: no search exceeded 197 s even with two of three models out of quota. |

## 5. Fallback and repeat-search evidence

**Gemini quota-exhaustion fallback [MOCK]** (`npx vitest run test/vision-budget.test.js test/deadline.test.js test/queue-watchdog.test.js --reporter=verbose`, 21 tests, PASS):
- 429 on all 3 models gives 3 fetches, then **0**, in under 1 s.
- `scoreWithVlm` on 20 candidates makes 3 fetches in total, then everything is CLIP-only.
- 400 gives 1 fetch with no retry; 401 / 403 / `API_KEY_INVALID` give 1 fetch and open the breaker.
- A transient error moves to the next model; a 404 benches only that model.
- Budget exhausted or deadline passed means no fetch; a deadline-capped timeout reports `deadline`.
- The deadline stops new rounds; a hanging collector is cut off without a retry.
- The watchdog marks a runaway search as error and its late result is ignored.
- `saveResults` commits or rolls back atomically.

Not tested live, deliberately: the quota was not exhausted on purpose.

**UI representation [UI]:**
- **Vision fallback, time limit and shortfall:** a debug-only `fetch` override in the browser rewrote one real search response to `vision.status='fallback'` (quota), `deadlineReached=true` and a Meta shortfall. The UI showed:
  - "Vision scoring fell back to CLIP-only. Because the Gemini API quota is exhausted (429) after 3/24 Gemini calls. 75 of 75 videos were scored by CLIPâ€¦"
  - "Search time limit reached"
  - "Shortfall: 12/20 matching videos â€¦"
- **Interrupted search:** the real "protein dark chocolate" search marked "Server restarted during search" shows the red "Search failed" notice, and history shows status `error`.
- **Ambiguous photo:** `needs_hint` shows the "What is this product?" card. Verified live in the earlier session.
- **Live shortfall:** the Ray-Ban and photo-only searches show amber `x/20` counts and the shortfall notice, which uses the same component as the mock.
- **Cosmetic issue:** the error notice always appends "If this was a product linkâ€¦", even for keyword searches.

**Repeat-search uniqueness [LIVE DB]:**
- crocs pass 1 accepted 61 and pass 2 accepted 63, with **0 accepted in both**.
- Pass 2 dropped 32 Instagram and 29 Meta candidates as `seen_before`.
- Across all 21 searches in the DB, **0** above-threshold videos appear in more than one search, and there are 0 duplicate (search, video) rows.

**Historical data integrity [INSPECT]:** the 14 searches and 297 match rows that existed before the stabilization pass hash identically to the baseline (`searches` `ee427987883630d1`, `search_videos` `0e894f7067b18f35`). The DB now holds 21 searches, 737 videos and 762 match rows.

## 6. Commands executed

| Command | Result |
|---|---|
| `Invoke-RestMethod http://localhost:4000/api/health` | PASS: Gemini on, IG `saved-login`, 53/250 pages, queue idle |
| One `generateContent` "Reply OK" per Gemini model | 3.5-flash 429, flash-latest 429, flash-lite 200 |
| `node scripts/evaluate.js --plan eval-plan.json --json eval-results.json --no-md` (6 live searches) | PASS: completed, results in Â§1 |
| `node contact-sheet.mjs <db> <id> <out> instagram\|meta\|sample` (read-only, 11 sheets) | PASS: used for Â§3 |
| `node repeat-check.cjs`, `lowclip-check.cjs`, `db-original-rows.cjs` (read-only) | PASS: Â§3, Â§5 |
| `cd backend; npx vitest run` | **PASS: 9 files, 109 tests** |
| `npx vitest run test/vision-budgetâ€¦ test/deadlineâ€¦ test/queue-watchdogâ€¦ test/scoring-regressionâ€¦ --reporter=verbose` | PASS: 44 tests |
| `node --check` on 24 backend source and script files | PASS |
| `cd frontend; npx oxlint` | PASS: 0 errors, 3 pre-existing warnings |
| `npx vite build --outDir <scratchpad>/dist-eval --emptyOutDir` | PASS |
| `docker build -t pvd-dashboard:eval .` | **BLOCKED**: Docker Desktop engine not running (`dockerDesktopLinuxEngine` pipe not found). `docker compose config` passed earlier. |
| Secret scan of 60 git-visible files (API-key, session-cookie and csrftoken patterns) | PASS: 0 hits |
| `git check-ignore` on `.env`, `.sessions/ig.json`, `app.db`, `app.db-wal`, `dist`, `node_modules` | PASS: all ignored |
| `git status` | 50 staged + 10 new files; no secrets, nothing over 1 MB |
| `git commit` | **NOT RUN**: no git `user.name`/`user.email` configured; awaiting the owner's choice of identity |

## 7. Remaining defects and limitations

**Confirmed defects (from this evaluation):**
1. **Meta precision on first searches is â‰ˆ10â€“35%.**
   - Generic, brand-less Meta queries from `analyseProductText`.
   - Lenient judging (lite model plus the keyword-mode 70â€“89 "same type" band).
2. **Photo-only search accepts look-alikes** (â‰ˆ1â€“2 of 12 Instagram results were the actual product).
3. **Model-level vs exact-variant matching.** The iPhone 15 in another colour scores 85, and iPhone 15 Pro is often accepted. The rubric doesn't define how variants are treated.
4. **Cosmetic:** the generic "If this was a product linkâ€¦" hint appears on every error.

**Limitations (carried over):**
- Gemini free-tier quota: during this run the primary models were exhausted, and precision depends on which model is available.
- Collectors aren't truly cancelled on deadline; results are saved only at the end.
- SSE doesn't auto-reconnect.
- Thumbnail-only scoring (no frame sampling).
- Unofficial Instagram endpoints; Instagram's terms of service.
- Docker image never built.
- TikTok not implemented.

## 8. Was 20+20 demonstrated across all five products?

**No.**
- **By the system's own counts,** both sources reached 20 in the same search for **3 of 5** products (crocs, Dyson, iPhone), plus the crocs repeat. Ray-Ban was 2 short on Meta, and the photo-only search was far short (12 / 1).
- **By visual verification of exact-product matches,** Instagram meets the target for 4 of 5 products, but **Meta does not meet it for any first-pass search**.

The assignment's 20+20 exact-product requirement is **not yet satisfied**.

## 9. Exact next steps for the failed requirements

1. **Brand-anchored Meta queries** (highest impact; evidence: the repeat search went from â‰ˆ2â€“3 to â‰ˆ16â€“18 out of 20).
   - In `backend/src/vision/gemini.js` `analyseProductText`, require every `metaQueries` and `instagramQueries` entry to contain the brand or product name, as the image prompt already does.
   - In `backend/src/vision/brain.js` `buildQueries`, put `correctedName` itself as the first Meta query and drop queries that contain neither the brand nor the core product words.
   - **Acceptance:** first-pass Meta precision â‰¥15/20 on crocs, Ray-Ban, Dyson and iPhone.
2. **Stricter judging rubric** in `judgeCandidates`.
   - In both modes: a different brand or a different model/variant must score <60 regardless of type similarity.
   - Ask for a structured verdict (`sameBrand`, `sameModel`, `productVisible`) and derive the score from it, so the score can't contradict the reason.
   - Add a test with a stubbed response.
   - **Acceptance:** the Ray-Ban "different brand" and iPhone "15 Pro" cases are rejected.
3. **Use the full Gemini model for judging when available.** Re-run the evaluation after the quota resets (or on a billed key) to separate model quality from prompt quality. Record which model judged each video (e.g. in `stats.vision`) so precision can be attributed.
4. **Photo-only look-alikes.** When Gemini identifies a brand from the photo, require brand evidence (logo or caption) for scores â‰¥70. Consider CLIP as a veto only when Gemini <90 and CLIP is very low (re-evaluate with `scripts/rescore-report.js`).
5. **Re-run** `node backend/scripts/evaluate.js --plan â€¦ --json â€¦` on 5 new products and update `docs/test-results.md` with visual precision. Only then claim 20+20.
6. Start Docker Desktop and run `docker build`. Commit once the owner confirms the git identity. The owner should record and review the demo.
