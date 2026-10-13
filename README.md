# Product Video Discovery Dashboard

> **Picking this project up? Read [`HANDOFF.md`](HANDOFF.md) first.** It has the current status, the last change, the open tasks and the rules to follow.

Type a product name, paste a product link, or upload a photo, and get 20+ Instagram Reels and 20+ Meta Ad Library video ads back. The image "brain" reads the product photo, writes the search queries, and gives every video a match score with a reason.

```
backend/   Node.js 24 + Express: pipeline, collectors, vision, SQLite
frontend/  React 19 + Vite: single-page dashboard
docs/      test results, demo script, HOW-SEARCH-WORKS (step-by-step: what a search returns, how and why)
scripts/   docker-start.ps1 / docker-start.sh (one-command Docker run)
```

**Why did a search return what it did?** `cd backend && node scripts/explain-search.js "<product>"` prints the whole story of one search: what the brain understood, which queries ran, what was de-duplicated, which judge model scored the videos, and why each video was accepted or rejected. The walkthrough is in [`docs/HOW-SEARCH-WORKS.md`](docs/HOW-SEARCH-WORKS.md).

## Quick start

```bash
# 1. backend
cd backend
cp .env.example .env              # add GEMINI_API_KEY (free: https://aistudio.google.com/apikey)
npm install
npx playwright install chromium   # headless browser used for collection
npm run ig:login                  # opens Edge/Chrome: log in to Instagram yourself; session saved locally
npm run dev                       # http://localhost:4000

# 2. frontend (second terminal)
cd frontend
npm install
npm run dev                       # http://localhost:5173
```

The first search downloads the CLIP model once: about **580 MB** (`vision_model.onnx` 335 MB + `text_model.onnx` 242 MB). It is cached under `backend/node_modules/@huggingface/transformers/.cache`, or `MODEL_CACHE_DIR`. The model loads into memory lazily on the first search, which takes about 10–20 s, and the backend then uses about 0.9 GB of RAM.

**Windows / PowerShell:** if `npm` is blocked by the execution policy, use `npm.cmd` (e.g. `npm.cmd run ig:login`). `ig:login` opens your installed **Edge or Chrome** (set `LOGIN_BROWSER=msedge|chrome` to choose). Playwright's bundled Chromium can be blocked by Windows Smart App Control, so `HEADLESS=false` may not work on such machines; collection itself uses Playwright's headless shell.

**Docker (one command):** put `GEMINI_API_KEY` and `IG_SESSION_ID` in `backend/.env` (or run `npm run ig:login` on the host first, because it needs a visible browser). Then:

```bash
docker compose up --build         # dashboard + API on http://localhost:4000
# or: powershell -ExecutionPolicy Bypass -File scripts\docker-start.ps1   (Windows)
#     sh scripts/docker-start.sh                                           (macOS/Linux)
```

The start scripts check that Docker is running and `backend/.env` exists, build and start the container, wait for `/api/health`, and open the dashboard. The image includes a healthcheck. **Verified on Windows / Docker Desktop 29.8:** the image builds, the container reports `healthy`, the dashboard is served on :4000, and a live search inside the container returned 29 Meta videos (Meta collection, Gemini judging and CLIP all work in the container).

**Network access.** The backend listens on `127.0.0.1` only (`HOST`), so other machines on your network can't reach it. In Docker the server listens on `0.0.0.0` *inside* the container (set in `docker-compose.yml`), and the port is published on the host's loopback only (`127.0.0.1:4000:4000`). If you change the published port or open the dashboard under another hostname (a LAN IP, a custom name), add it to `ALLOWED_ORIGINS` and `ALLOWED_HOSTS` in `backend/.env`, or the API will answer 403/421. See [Security](#security) and the `Network / API security` block in `backend/.env.example`.

**Optional API token.** Set `API_TOKEN=<random>` in `backend/.env` and the same value as `VITE_API_TOKEN` in `frontend/.env`, then restart both (for Docker, `frontend/.env` is copied into the build stage, so rebuild the image after changing it). `backend/scripts/*` and curl callers must then send `x-api-token: <token>` on POST/DELETE.

Tests: `cd backend && npm test`. The unit tests cover de-duplication, scoring, query building, SSRF guards, payload extractors, and the API security layer (`test/security.test.js`, which runs on a temp DB and never starts a real search).

## Architecture

```
POST /api/search ──► job queue (in-process, concurrency 1) ──► pipeline
                                                                │
   1. product   resolve input: keyword | URL (SSRF-safe fetch, JSON-LD/OG parse, cached 24h) | uploaded image
   2. brain     Gemini reads the image → attributes + per-platform queries (cached by image hash)
                CLIP embeds the reference (image, or text when there is no photo)
   3. collect   Instagram ║ Meta  run in parallel; each has its own timeout, retries and error isolation
                per source: query → harvest → id dedupe → thumbnail + pHash → near-dup filter
                            → CLIP score all → Gemini judge plausible ones → repeat with next query until 20 usable
   4. save      videos + per-search matches in SQLite (feeds the "seen before" filter next time)

GET /api/search/:id/events   SSE progress (replayed if the client connects late)
GET /api/search/:id          product, attributes, per-source stats, results
GET /api/history             earlier searches
POST|DELETE /api/videos/:uid/star, GET /api/shortlist.csv   shortlist + export
GET /api/img?u=              thumbnail proxy (Instagram/Meta CDN hosts only)
GET /api/health              session/vision status shown in the UI header
```

**Choices and why**

| Concern | Choice | Why |
|---|---|---|
| API style | REST + SSE | Progress only flows server→client, and SSE is simpler than WebSockets. (The client currently closes the stream on an error and reloads the final state over REST; it does not auto-reconnect.) |
| Queue | In-process, with buffered events | One user, one machine, no Redis needed. The `enqueue/emit` boundary is where BullMQ would slot in. Orphaned jobs are failed on boot. |
| Store | SQLite (`node:sqlite`, built into Node 24) | No server, no native build. History, dedupe index, caches and shortlist live in one file. |
| Browser automation | Playwright | Needed for Instagram (logged-in web app) and the Meta Ad Library (JS-rendered). |
| Vision | Gemini Flash (free tier) + local CLIP | See below. |

## How each video source is collected

### Instagram Reels: your logged-in session plus Instagram's internal web API

- **Session:** `npm run ig:login` opens Edge, Chrome or Chromium; you log in yourself (2FA works); the script saves Playwright `storageState` to `backend/.sessions/ig.json`. The file is gitignored and holds no password, but treat it like one. Pasting a `sessionid` cookie into `IG_SESSION_ID` is an alternative (untested).
- **Search, primary path: same-origin XHR.** One logged-in page (`/accounts/edit/`) is opened and **reused**. Each query calls Instagram's private web search API from inside that page: `GET /api/v1/fbsearch/web/top_serp/?query=<q or #tag>`, paginated with `next_max_id` / `rank_token`, up to 4 pages per query. There is no rendering or scrolling, so it takes about 10 s per query.
- **Fallback path: page browsing.** If that endpoint stops returning JSON, the collector opens `/explore/search/keyword/?q=` (hashtag URLs now redirect there) and captures only the GraphQL *search* responses the page receives (`PolarisKeywordSearchExplorePage…`), ignoring the home feed and stories.
- **Parsing:** `extractIgMedia` walks any JSON and keeps objects shaped like a Reel (`code` + `video_versions`/`media_type 2`/`product_type clips`, or the legacy `shortcode`/`is_video` shape). Because it doesn't depend on exact response paths, it survives Instagram reshuffling its payloads.
- **Why not the official API:** the Graph API cannot search other people's Reels by keyword. Hashtag search is Business-account only, limited to 30 hashtags per week, and doesn't return Reels reliably.

### Meta Ad Library: the public web UI and its GraphQL

- The collector opens `facebook.com/ads/library/?q=…&media_type=video&active_status=active` with no login and reads the `/api/graphql/` pagination responses while scrolling. `extractMetaAds` keeps any object with `ad_archive_id` and a `snapshot` containing a video, including carousel cards.
- **Why not the official Ad Library API:** outside the EU/UK it only returns political and issue ads, so commercial product ads are unreachable through it.

### Rate limits, blocks, login walls, missing data

| Situation | Handling |
|---|---|
| Instagram pacing | One request at a time, at least 3 s apart with jitter (`IG_MIN_DELAY_MS`), plus a daily cap counted per API page (`IG_DAILY_PAGE_CAP`, default 250, shown in `/api/health`). |
| Login wall / checkpoint / expired session | Detected from the URL or the API's `login_required` / `checkpoint_required` message (or 401/403) and raised as a fatal error for that source only. The UI shows "re-run `npm run ig:login`". Meta continues. |
| Timeouts / transient errors | Each collector call is bounded by min(`SOURCE_TIMEOUT_MS`, time left before the search deadline), with 2 tries. A failing query is noted and the next one runs. |
| Search duration | Every search has a deadline (`SEARCH_DEADLINE_MS`, default 240 s). After it passes, no new query rounds start and the search finishes with what it has (shown as "time limit reached"). A watchdog at deadline + `SEARCH_WATCHDOG_GRACE_MS` (90 s) fails a runaway search without saving partial results. |
| Gemini quota / overload | Calls are spaced to `GEMINI_RPM` and capped per search (`GEMINI_MAX_CALLS_PER_SEARCH`, 24). Each call tries each model in `GEMINI_MODEL` + `GEMINI_FALLBACK_MODELS` **at most once**, with no long backoff. A model that hangs is abandoned after **25 s while a healthy fallback model remains** (60 s, or the time left, otherwise), one request may spend at most **50 s across the whole chain** (`GEMINI_CALL_BUDGET_MS`; in a Docker test with Gemini overloaded, walking all five models took ~2 min per request and starved Meta collection), and a failing model is benched for **15 min**. Each Gemini model has its own free-tier quota, so the default chain is five models on one key: `gemini-3.5-flash` → `gemini-3.1-flash-lite` → `gemini-flash-latest` → `gemini-3.5-flash-lite` → `gemini-flash-lite-latest`. On a 9-ad hand-labelled judge bench (right model, other model, competitor, logo-only, accessories), `gemini-3.1-flash-lite` and `gemini-flash-lite-latest` scored 9/9; Gemma 4 (26B/31B) was dropped (slow, malformed JSON). If every model is out of quota or failing, a **circuit breaker** stops all Gemini calls for the rest of that search and the remaining videos are scored CLIP-only. Auth errors (401/403, invalid key) and invalid requests are never retried. The results page shows a notice with the reason, calls used and how many videos were CLIP-only. |
| Missing thumbnail / expired CDN URL | Candidate skipped (it can't be scored). The UI falls back to the thumbnail proxy, and to "Open original" when inline video expires. |
| Fewer than 20 usable videos | The source walks an ordered query list: model queries, hashtags, then widening variants (up to `MAX_QUERY_ROUNDS`, default 8; the deadline still bounds it). For Meta, the broad branded queries (brand + product type, then the brand) come **before** the "… review" / "… sale" variants, because those variants mostly returned the same ads again. Meta scrolls until it has collected up to 80 ads per query (2× the limit), because more than half of a page is often reseller copies removed as duplicates. If it still falls short, the tab count turns amber and a notice lists what was tried and why. It never fails silently. |

### TikTok (optional, off by default)

- Enabled per search with the **Include TikTok (beta)** checkbox (`options.tiktok: true` on `POST /api/search`). When it is off, the TikTok collector is never called.
- `collectors/tiktok.js` opens the public web search `tiktok.com/search/video?q=…` with no login and reads the `api/search/…` JSON (plus the SSR blob) while scrolling. `extractTikTokVideos` keeps any object with a numeric `id` and a `video` cover. Queries reuse the Instagram keyword phrases (first `TIKTOK_MAX_QUERIES`, default 4).
- It runs in parallel with Instagram and Meta through the same dedupe and scoring. There is no minimum: the tab shows the count found (`TIKTOK_TARGET`, default 10, only bounds collection). A captcha, login wall or geo-block (`TIKTOK_CAPTCHA` / `TIKTOK_LOGIN_WALL` / `TIKTOK_GEO_BLOCKED`) stops TikTok for that search with a notice on its tab. It never fails the search or affects the other two sources. TikTok is blocked in some countries (e.g. India), so there the tab just reports the geo-block.

## The image-analysis brain

1. **Product analysis (Gemini, free tier; models rotate as described above):**
   - **Photo:** product type, colours, prints/graphics, logos, text on the product, material, shape, a one-line summary, plus 4–6 Instagram queries, 6–10 hashtags and 4–6 ad-copy-style Meta queries. A name typed next to the photo (or the product-page title) is treated as **ground truth for what the product is**; the photo only describes how it looks.
   - **Name only:** Gemini reads the text, fixes spelling ("whey protien" → "whey protein") and writes the same queries.
   - **Photo only:** Gemini identifies the product and reports how sure it is. Below 60% (e.g. a bare scoop of powder) the search stops **before** collecting and asks "What is this product?" with 2–4 guesses. One click re-runs it with the same photo.
   - Results are cached by image hash + name.
2. **Reference embedding (CLIP ViT-B/32, run locally with transformers.js):** an image embedding of the product photo, or a CLIP *text* embedding of the description when there is no photo.
3. **Scoring every candidate:**
   - **CLIP:** cosine between the reference and the video **thumbnail**, mapped to 0–100. It is cheap, local and covers every candidate.
   - **Gemini judge:** each round, the top 40 candidates by CLIP go to Gemini in batches of 8. There is no minimum CLIP score, because generic products such as powders score low on CLIP even when correct. Candidates ranked **out** of those 40 while the judge is working are not accepted: their score is capped just below the threshold with the reason "Not judged …".
     - With a photo, Gemini scores how likely the video shows **the exact product** (90–100 same product, 70–89 very close, 40–69 same category / unclear, 0–39 different).
     - With a name only, it judges against **the named product** and is told not to mark down for the missing photo.
     - **The judge classifies; the code scores** (`backend/src/vision/verdict.js`, judge v4). Gemini returns a relation: `exact`, `variant` (the same model line differing only in colour, size/capacity, pack or a limited-edition print; a sibling line of the same brand is *not* a variant), `same_brand_other_model`, `accessory` (a case, charger, protector or other add-on *for* the product; scores 20), `competitor`, `category`, `not_visible` or `unrelated`, plus `brandMatch`, `modelMatch`, a confidence and a reason. Only exact and variant can pass.
     - **The product must be visible.** A caption or logo that names the product is not enough; an ad showing only the brand logo or a lifestyle scene is `not_visible` and rejected.
     - A verdict whose reason contradicts it ("different brand", "dupe", "similar to …", or "case for …" / "accessory" on an exact or variant verdict) becomes **Uncertain** and is rejected.
     - An exact or variant verdict needs **brand evidence**: a logo the judge saw, or the brand or a distinctive model name in the caption. A lite fallback model also needs caption or CLIP support. Without evidence it is **Unverified** and rejected.
     - The card reason starts with the match type.
   - **Identity** (`identity.js`): brand and model come from the product page, from what you typed, or from a logo readable in the photo. A brand only *recognised from the design* is marked "inferred, not verified", and an unknown brand is never invented. The product panel shows which. Meta queries always keep the brand + model when known and never fall back to generic category phrases.
   - **Final score (`SCORING_VERSION = 2`, `backend/src/scoring.js`):** Gemini's verdict leads and its weight grows with its confidence. At ≥80, CLIP can only add a +5 corroboration bonus. At 60–79, CLIP keeps up to a 35% say. Below 60 ("not the exact product"), CLIP can never lift the score above the verdict. So vlm 85 + CLIP 0 scores 85, while vlm 55 + CLIP 100 scores 45.
   - **Without a Gemini verdict** (no key, quota exhausted, outage, budget or deadline reached): CLIP plus a bounded caption boost. When vision is unavailable, a CLIP-only candidate can pass only if the caption **names the model** (e.g. "Holbrook", "Air Force 1"), not just the brand, because CLIP alone can't tell one model of a brand from another.
   - Historical rows keep the score they were saved with. `node backend/scripts/rescore-report.js` shows, read-only, how they would score under v2.
4. **Threshold: 50** (`MATCH_THRESHOLD`). Below-threshold videos are hidden by default, don't count toward the 20, and can be shown with "Show below-threshold" (greyed out and labelled).

**Why this hybrid:** a vision-language model is the only thing that reliably tells *the same print* from *a similar tee*, but free tiers can't afford a call per thumbnail. CLIP is free, fast and offline, so it pre-filters and ranks, and Gemini spends its quota only on plausible candidates. With no key at all, the app still works in CLIP-only mode, with lower accuracy.

## Unique results on every search

Each video gets a **uid**: `platform:videoId` (Reel shortcode or `ad_archive_id`), or a SHA-1 of the media URL without its expiring query string. It is stored with the search that returned it (`search_videos`).

Before results are shown, a `DedupeIndex` is seeded with every video earlier searches *showed* (above threshold). Each candidate is checked cheapest first:

1. **Same uid** → `seen_before` (earlier search) or `duplicate_id` (this search).
2. **Same advertiser/author + same normalised copy** (lowercased, punctuation/URLs stripped, first 200 chars, at least 25 chars) → `duplicate_text`. This catches the same ad running under several IDs, and reposts that keep the caption.
3. **Near-identical thumbnail:** a 64-bit dHash of the thumbnail within 5 bits (`PHASH_DISTANCE`) of any accepted or historical video → `near_duplicate`. This catches re-uploads and reposts with a different caption. dHash survives rescaling and recompression, and a unit test checks a resized, quality-40 copy against a different image.

Drop counts per reason are shown under each tab. If dedupe pushes a source under 20, the query-expansion loop simply continues. **"Show previously seen"** (next to the search bar) skips the history filter for that search and labels those cards "seen before". Every past search also stays viewable in the history sidebar.

## Security

- Every product URL is validated before fetching: http(s) only, no credentials in the URL, no localhost/`.internal`/`.local`, no private, loopback, link-local, CGNAT or metadata IPs (v4 and v6, including v4-mapped).
- DNS is checked again **at connect time** through a custom `lookup`, which closes the DNS-rebinding gap.
- Redirects are followed manually and each hop is re-validated. There is a size cap and a timeout.
- The thumbnail proxy only serves Instagram/Meta CDN hosts.
- Inputs are validated with zod, and uploads are capped at 8 MB.
- All keys and sessions come from `.env` or `.sessions/`, both gitignored. Logs redact cookie and API-key fields.

### The local API

The API drives a logged-in Instagram session, so the main risk is **another website open in your browser** sending requests to `http://localhost:4000` (CSRF), or a hostile domain that re-points its DNS to 127.0.0.1 (DNS rebinding). `server.js` applies these checks, in this order:

1. **Loopback bind.** `HOST` defaults to `127.0.0.1`, so the API isn't reachable from the LAN. Docker binds `0.0.0.0` inside the container but publishes `127.0.0.1:4000` only.
2. **Host allowlist, every request (API and static files).** The `Host` header must be one of `ALLOWED_HOSTS` (default `localhost`, `127.0.0.1`, `[::1]`, any port); otherwise **421**. After DNS rebinding the browser still sends the attacker's hostname, so this blocks it. It covers the static bundle too, so a rebound page can't read a bundled token.
3. **CORS** only for `ALLOWED_ORIGINS` (default `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:$PORT`, `http://127.0.0.1:$PORT`). Other origins get no `Access-Control-Allow-Origin`, so their scripts can't *read* responses. CORS does **not** stop a cross-site form or `fetch(..., {mode:'no-cors'})` from being *sent*, which is why step 4 exists.
4. **Server-side Origin check on POST/PUT/PATCH/DELETE.** An `Origin` header that isn't allowed (including `null`) gets **403** before the body is parsed. With no `Origin`, a `Sec-Fetch-Site` of `cross-site` or `same-site` gets **403** (browsers always send `Origin` on these methods, so it can't be verified). With no `Origin` and no `Sec-Fetch-Site` (or `same-origin`/`none`), the request is allowed: that's curl and `scripts/evaluate.js`.
5. **Optional `API_TOKEN`** on the same methods, in the `x-api-token` header, compared in constant time: missing → **401**, wrong → **403**. It's never logged (the request log has method, path, status and time only), and startup logs only whether it's enabled.

GET routes (`/events` SSE, `/api/img`, history, shortlist) don't need the token, because `EventSource` and `<img>` can't send custom headers. They're protected by the loopback bind, the Host check, and CORS (other sites can trigger them but can't read the response). A cross-site page could still make the backend fetch an allowlisted Meta CDN image or start a CSV download. Neither changes state.

**What this does not protect against:**
- **Malware or any other local process.** It can call the API like curl: no `Origin`, any `Host` it likes. Only `API_TOKEN` raises the bar, and only if that process doesn't have the token.
- **Anyone who can load the dashboard can read the token.** `VITE_API_TOKEN` is embedded in the JS bundle. It keeps out other sites and tools that never loaded the dashboard; it is not a user login.
- **LAN or remote exposure.** If you set `HOST=0.0.0.0` (outside Docker) or widen `ALLOWED_HOSTS`/`ALLOWED_ORIGINS`, you're responsible for who can reach the port. There's no TLS and no per-user auth.
- **Browser extensions** that use your browser's privileges, and browsers too old to send `Origin`/`Sec-Fetch-Site`.

## Test evidence

- **Unit and integration tests:** `cd backend && npm test`, 141 tests. They cover dedupe, scoring v2 regressions, query building and order, SSRF, extractors, the Gemini circuit breaker, error classification, the deadline, the watchdog and transactional save, the exact-product judge rules (including `accessory`, the ranked-out cutoff, the held-back catch-up pass and CLIP-only model naming), the optional TikTok source, and the API security layer. They run on temp DBs with a stubbed `fetch`.
- **Live evaluation, 23 searches (2026-10-13, session 2):** see [`docs/test-results.md`](docs/test-results.md). The code was improved during the session, so rows ran on different versions. In summary:
  - **Instagram:** ≥20 usable in 22 of 23 searches (the exception: a niche Allbirds colourway, 6). About 19–20/20 correct in the top 20 when the judge was working.
  - **Meta:** ≥20 usable in 8 of 23 searches. Shortfalls are mostly the source: few active video ads for the exact model (e.g. YETI Rambler 2, AirPods Pro 2 4, Allbirds 5, New Balance 550 3), and the judge correctly rejects other models of the same brand.
  - **Best case, healthy judge and all fixes:** **Adidas Samba OG** (37 Instagram / 33 Meta, ≈19/20 and ≈19–20/20 correct) and **Philips OneBlade** (34 / 34, ≈19/20 and 20/20). These are the two searches where 20+20 exact was shown on both sources; **it is not claimed for all products.**
  - **During the Gemini outage** (late in the day, CLIP-only) Meta precision dropped to ≈9/20 (Dyson Supersonic).
  - **Repeat search:** 0 overlap with the first pass.
  - **AI during the run:** the main Gemini models were unavailable (429/503), so the lite model did the judging, and from mid-afternoon no Gemini model answered reliably.
  - The earlier five-product evaluation (session 1, Meta ≈10–35% correct) is summarised at the end of the same file.
- **Re-run it:** `node backend/scripts/evaluate.js [--repeat] [--plan plan.json] [--json out.json]`. `plan.json` is `[{label, input, image?}]`, so image-only searches can be included.

## Known limitations

- **Meta often returns fewer than 20.** This is mostly source-side: for many exact models there are only a few active video ads, and reseller copies of the same ad are removed as duplicates. The app reports the shortfall instead of padding it with look-alikes.
- **"Variant" is now strict, but not live-verified.** After a Stanley ProTour eval accepted Quencher H2.0 / IceFlow tumblers as "variants", judge v4 tells Gemini that a variant is the same model line differing only in colour/size/pack/edition (sibling lines are `same_brand_other_model`), and the code rejects a variant with `modelMatch` "different", or "unknown" when the caption does not name the model. Covered by unit tests only; a judge that wrongly says `modelMatch: "same"` still gets through, and a caption like "iPhone 15 Plus" still counts as naming "iPhone 15".
- **Some product pages don't expose a main image** to a plain fetch (stanley1913.com: title, brand and model were extracted, the image wasn't), so that search runs in name-only mode.
- **Meta precision depends on Gemini being available.** With a working judge, accepted Meta ads are mostly the right product (Samba ≈19–20/20, OneBlade 20/20). When Gemini is down the app falls back to CLIP-only, and precision collapses (≈9/20 seen), because CLIP can't separate models of the same brand. Requiring the caption to name the model limits the damage but makes counts drop. See `docs/test-results.md`.
- **Thumbnails only.** Both the judge and CLIP see one thumbnail per video, so a product that appears only mid-video is missed, and an ad whose thumbnail shows only the logo is rejected.
- **Look-alike products:** photo-only searches identify the product but don't reliably separate it from look-alikes. Confident Gemini verdicts are no longer vetoed by CLIP (scoring v2), so a confident wrong verdict passes.
- **Gemini free-tier quota** runs out under repeated testing. Searches then complete on the lite model, or CLIP-only, within the deadline, with lower accuracy.
- **Instagram automation breaks Instagram's terms.** Use a secondary account. Heavy use can trigger checkpoints or a temporary block, and the pacing and daily cap reduce but don't remove that risk.
- **The Instagram endpoints are unofficial** (`/api/v1/fbsearch/web/top_serp/`, the web app id, and GraphQL operation names). Instagram can change them at any time; the browse fallback and the shape-agnostic parser reduce the impact.
- **Reels search depth is limited** to what the web search returns per query (about 4 pages). Niche products, and products searched repeatedly (fresh results get used up), can fall short of 20; the UI flags it.
- **Not truly cancelled:** the deadline and watchdog stop *waiting* for a slow collector but don't kill in-flight Playwright work. Results are saved only when a search finishes (in one transaction).
- **Meta Ad Library** can show a login wall from some IPs/regions and only lists ads that are currently active.
- **CLIP-only mode** (no Gemini key) undervalues lifestyle shots of a product photographed on white.
- **The in-process queue** doesn't survive restarts (orphans are marked failed) and doesn't scale across processes.
- **TikTok** (optional, off by default) is implemented but **untested against live data**: TikTok is geo-blocked in India, where this was built, so the collector reports `TIKTOK_GEO_BLOCKED` there. The parser is tested on a fixture of TikTok's response shapes only.

## What I'd build next

- Sample 3–4 frames per video (ffmpeg on `mediaUrl`) and score the best frame.
- Store CLIP embeddings in SQLite so near-duplicate detection can use embedding distance as well as dHash.
- BullMQ + Redis queue, Postgres, and multiple Instagram sessions rotated per worker.
- TikTok collector behind its own toggle, reusing the same harvest-JSON pattern.
- A small labelled set per product to tune the threshold and CLIP band from data instead of rules of thumb.
