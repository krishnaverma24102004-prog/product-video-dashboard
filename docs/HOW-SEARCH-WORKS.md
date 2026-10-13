# How a search works: what comes back, how, and why

This page walks through one search from input to result cards. To see the same explanation for any real search, run:

```bash
cd backend
node scripts/explain-search.js                    # the latest search
node scripts/explain-search.js "philips oneblade"  # latest search whose input contains this text
node scripts/explain-search.js <searchId> --top 10
```

The script is read-only. It calls the running backend's GET endpoints and prints the sections below for that search.

---

## The pipeline at a glance

```
input (name | product URL | photo)
   │
   ▼
1. Product extraction ──► 2. Brain: analyse product ──► identity (brand, model) + attributes + queries
                                                          │
                     ┌────────────────────────────────────┼─────────────────────────────┐
                     ▼                                    ▼                             ▼
          3a. Instagram collector             3b. Meta Ad Library collector     3c. TikTok (optional, off)
                     │  (in parallel, each with its own query list, retries and timeout)
                     ▼
4. De-duplication (history, same ID, same copy, near-identical thumbnail)
                     ▼
5. Scoring: CLIP for every video ──► Gemini judge for the top 40 per round ──► final score 0–100
                     ▼
6. Threshold 50: accept / reject (+ catch-up judging for held-back videos)
                     ▼
7. Not enough? next query (wider) ... until 20, 8 rounds, or the 240 s deadline
                     ▼
8. Save (one transaction) ──► dashboard: tabs, counts x/20, cards with score + reason
```

The progress panel in the dashboard shows each of these stages live over SSE ("Analysing product", "Instagram: expanding with …", "Meta: scoring 34 new videos", …).

---

## Step by step

### 1. Product extraction: what is the product?

| Input | What happens |
|---|---|
| **Name** ("adidas samba og") | Used as the product title. |
| **Product URL** | The URL is checked first: http(s) only, no internal/private addresses, DNS re-checked at connect time, every redirect re-validated. Then the page is fetched and the title, description, brand and main image are read (JSON-LD, Open Graph, page tags). Cached for 24 h. |
| **Photo** | Used directly as the reference image. |

**Why:** everything later (queries, judging) depends on knowing exactly which product this is.
**Seen in the evaluation:** stanley1913.com gave title, brand and model but no image, so that search ran in name-only mode.

### 2. The brain: brand, model, look, and queries

Gemini reads the photo (or only the name) and returns:
- **Identity:** brand, model, and *where the brand came from*. `page` / `named` (you typed it) / `visible` (logo readable in the photo) are trusted. `inferred` (recognised from the design) is marked "not verified". An unknown brand is never invented.
- **Attributes:** product type, colours, prints, logos, text on the product, material, shape, and distinctive features.
- **Queries per platform:** Instagram hashtags and keywords, plus ad-copy-style Meta queries. Brand + model are always kept.

**Why:** a search for "crocs classic clog" must not turn into "comfortable casual clogs". That phrase returns other brands' ads.

### 3. Collection: where the videos come from

| Source | How | Why this way |
|---|---|---|
| **Instagram Reels** | The owner's logged-in session (`IG_SESSION_ID` or `npm run ig:login`). Instagram's own web search API is called from inside a headless browser page, with a page-browsing fallback. Paced (≥3 s between pages), with a daily page cap of 250. | Reels search needs a login, and the web API returns captions, authors and thumbnails in one call. |
| **Meta Ad Library** | The public Ad Library website (no login), filtered to active **video** ads. The site's own GraphQL responses are read while scrolling, up to 80 ads per query. | No API key is needed, and the Ad Library is the official public source of running ads. |
| **TikTok (optional)** | Public web search, off by default ("Include TikTok (beta)"). | Assignment bonus. It can never block the two required sources. It is geo-blocked in India. |

**Query order for Meta (when the brand is known):** exact brand + model → the brain's best 2 branded queries → brand + product type → brand + model + colour → brand alone → the remaining variants ("… review", "… sale", feature). Broad branded queries come early because "X review" mostly returns the same ads as "X".

### 4. De-duplication: why some videos never show up

Every video gets a stable ID (`instagram:<shortcode>`, `meta:<ad id>`, or a hash of the media URL). Checks run cheapest first:

| Reason (in `explain-search` / tab footers) | Meaning |
|---|---|
| `seen_before` | Shown in an earlier search. Hidden so each search brings new videos. "Show previously seen" turns this off. |
| `duplicate_id` | The same video found twice by two queries in this search. |
| `duplicate_text` | Same advertiser/author + same caption. One ad running under many IDs, or a repost. Very common on Meta (resellers). |
| `near_duplicate` | Thumbnail almost identical (64-bit dHash within 5 bits). Re-uploads and reposts with a new caption. |

### 5. Scoring: how a video gets its 0–100

1. **CLIP** (local, free) compares every thumbnail with the reference photo, or with the product description when there is no photo. It ranks the candidates.
2. **Gemini judge** looks at the top 40 per round, 8 thumbnails per call, together with their captions, and **classifies** each one:

| Relation | Score | Result |
|---|---|---|
| `exact`: same brand and model visible | 80–100 | ✅ accepted |
| `variant`: same model line, only colour/size/pack/edition print differ (judge v4: a sibling line such as Quencher H2.0 vs ProTour is *not* a variant; a variant the judge can't confirm and whose caption doesn't name the model is rejected as "Unverified model") | 62–75 | ✅ accepted |
| `same_brand_other_model` (e.g. Air Max for Air Force 1) | 35 | ❌ |
| `category`: brand/model unclear | 25 | ❌ |
| `accessory`: case/charger/protector *for* the product | 20 | ❌ |
| `competitor`: other brand, dupe, look-alike | 15 | ❌ |
| `not_visible`: only a logo, text or scene | 10 | ❌ |
| `unrelated` | 5 | ❌ |

3. **Code checks** on top of the judge. The code sets the score, so it can't contradict the reason:
   - **Uncertain:** the judge says exact but its own reason says "different brand", "dupe", "case for …". Capped at 45 and rejected.
   - **Unverified:** no brand evidence (no logo seen, and neither brand nor model in the caption). Capped at 48 and rejected. Lite models also need caption or CLIP support.
4. **Final score:** a confident judge leads. CLIP adds at most +5, and it can never lift a "not the product" verdict.

**Free judge models.** Each model on the Gemini key has its own free quota, so the backend tries, in order: `gemini-3.5-flash` → `gemini-3.1-flash-lite` → `gemini-flash-latest` → `gemini-3.5-flash-lite` → `gemini-flash-lite-latest`. A busy model is skipped for 15 min. A hanging model is dropped after 25 s while another healthy one remains.

### 6. Accept or reject

- **Threshold 50.** Accepted videos count toward the 20. Rejected ones are hidden but can be shown with "Show below-threshold" (greyed out, with their reason).
- **Not judged:** while Gemini works, videos ranked below the per-round cutoff are *not* accepted on CLIP alone. At the end, a **catch-up pass** judges them if the source is still short and budget and time remain.
- **Gemini down (quota / outage):** the search still finishes, CLIP-only. A video is then kept only if CLIP is high **and** the caption names the model. "Nike" alone is not enough for an Air Force 1. The dashboard shows a notice with the reason.

### 7. Not enough videos? Widen, then report honestly

A source keeps running its next query until it has 20 accepted videos, runs 8 query rounds, or reaches the 240 s search deadline. If it is still short, the tab count turns amber, and a notice lists the queries tried and why it stopped. It never pads the results with look-alikes.

**Typical reasons for a shortfall** (from the 23-search evaluation, `docs/test-results.md`):
- **Few active video ads exist for that exact model:** YETI Rambler 2, AirPods Pro 2 4, Allbirds 5.
- **The brand's ads are mostly *other* models**, which are correctly rejected: New Balance 550 had 10 other NB models; Sony XM5 had XM4/XM6.
- **Heavy duplication:** one Sony XM5 search dropped about 130 copies of the same reseller ads.
- **The deadline:** judging on free models takes time; 240 s is the hard limit.

### 8. What you see on a card

| Field | Comes from |
|---|---|
| Thumbnail | The platform's CDN, via the backend's thumbnail proxy (allowlisted hosts only) |
| Platform badge | `instagram` / `meta` / `tiktok` |
| Score 0–100 | Step 5 |
| Reason | The judge's relation label + evidence, e.g. "Exact match: Philips OneBlade clearly visible with lime green handle", or why there was no verdict |
| Caption / ad copy, author | Collector |
| Link / inline video | The original Reel or Ad Library entry. Inline playback when the media URL is still valid. |
| ★ | Adds the video to the shortlist (export as CSV) |

---

## Worked example: "philips oneblade" (keyword)

Output of `node scripts/explain-search.js "philips oneblade" --top 3`, shortened:

```
2. Identity : brand "Philips" (named, verified), model "OneBlade"
3. Calls    : 11/24 Gemini calls | 68 judged | model gemini-3.5-flash-lite
             59 exact, 9 variant
4. INSTAGRAM 34/20: one query (#philipsoneblade) was enough; 31 exact + 3 variant
5. META 34/20: one query ("Philips OneBlade"); 13 duplicate_text + 10 near_duplicate dropped
   top: 100  "Exact match: Clear view of Philips OneBlade handheld and logo."
SUMMARY: Instagram 34/20, Meta 34/20 -> 20+20 reached by count (manually: ≈19/20 and 20/20 correct)
```

## Running it with Docker

```bash
# Windows (Docker Desktop running):
powershell -ExecutionPolicy Bypass -File scripts\docker-start.ps1
# macOS / Linux:
sh scripts/docker-start.sh
# or directly:
docker compose up --build
```

- One image builds the React app and serves it from the Node backend on **http://localhost:4000**. It is based on the Playwright image, so Chromium is included.
- `backend/.env` is passed in as environment variables, and is never copied into the image (`.dockerignore`). Instagram uses `IG_SESSION_ID` from `.env`, or `backend/.sessions/ig.json` mounted at `/sessions`.
- The SQLite DB and the CLIP model cache live in named volumes (`data`, `models`), so they survive rebuilds.
- The port is published on `127.0.0.1` only. A container healthcheck calls `/api/health`.
- Verified on Windows / Docker Desktop 29.8: the image builds, the container is `healthy`, and a live search inside it returned Meta results with Gemini judging.
