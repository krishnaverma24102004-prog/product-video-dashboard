# Test results — live evaluation, 2026-10-13 (session 2)

18 live searches (17 products + 1 repeat), run one at a time against the live backend. Instagram used the owner's logged-in session; Meta used the public Ad Library. The code was improved **during** the session (judge v3, see `IMPLEMENTATION-REPORT.md`, Pass 4), so each row says which code version it ran on.

| Setting | Value |
|---|---|
| Machine | Windows, Node 24 |
| Match threshold | 50 (unchanged all day) |
| Per-search deadline | 240 s |
| Gemini budget | 24 calls per search |
| Instagram | owner's logged-in session |
| Meta | public Ad Library, no login |

**Gemini availability.** All day, `gemini-3.5-flash` returned 429/503 and `gemini-flash-latest` returned 503, so the judging was done by the lite fallback **`gemini-flash-lite-latest`**. From about 14:35 local time, **all** Gemini models returned 503 or timed out for long stretches (Google-side overload). The last batch of searches therefore ran mostly **CLIP-only**. Precision numbers from those rows say little about the judge and a lot about the CLIP-only fallback.

**How "correct" was counted.** "Usable" is the system's own count (above threshold, unique, not seen before). "Correct" was counted by hand from thumbnail contact sheets of the **top 20 accepted results per platform**, with browser spot checks (e.g. iPhone Meta #1 turned out to be a "Premium Matte Slim Case for iPhone" ad). It is a manual judgement, not ground truth. "-" means not reviewed.

## Code versions

| Label | Code |
|---|---|
| **A** | judge v2, old query order (state at the start of the session) |
| **B** | A + fix 1 (Meta query order, 8 rounds) + fix 2 (`accessory` relation) |
| **C** | B + fix 4 (Gemini failover timeout / bench) + fix 5 (Meta scrolls to 80 ads) |
| **D** | C + fix 3 (product must be visible) + fix 6 (ranked-out candidates not accepted) |
| **E** | all fixes, judge v3 (D + fix 7: CLIP-only fallback needs the caption to name the model) |
| **F** | E + five-model free Gemini chain (`gemini-3.5-flash` → `gemini-3.1-flash-lite` → `gemini-flash-latest` → `gemini-3.5-flash-lite` → `gemini-flash-lite-latest`) + optional TikTok source (off) |

## Results

| # | Product | Input | Code | IG usable | Meta usable | IG correct (top 20) | Meta correct (top 20) | Time | Judge |
|---|---|---|---|---|---|---|---|---|---|
| 1 | crocs classic clog | keyword | A | 40 | 14 | 20/20 | ≈11–12/14 | 210 s | lite |
| 2 | ray-ban wayfarer sunglasses | keyword | A | 24 | 23 | 20/20 | ≈14–15/20 (rest: Ray-Ban Meta smart glasses, packaging, product not visible) | 84 s | lite |
| 3 | dyson airwrap | keyword | A | 39 | 23 | 20/20 | 20/20 Airwrap ads; device visible in ≈11 thumbnails | 165 s | lite |
| 4 | stanley quencher tumbler | keyword | A | 40 | 13 | ≈19/20 | ≈10–11/13 | 120 s | lite |
| 5 | Apple iPhone 15 (amazon.in URL) | URL | A | 32 | 15 | ≈20/20 | ≈4–5/15 (cases, charger, lens protector) → fix 2 | 229 s | lite, budget hit |
| 6 | Apple AirPods Pro 2 | keyword | B | 28 | 4 | - | 4 (8 other AirPods models correctly rejected; ≈60 duplicates) | 241 s (deadline) | lite; `gemini-flash-latest` hung 62 s → fix 4 |
| 7 | Hydro Flask 32 oz wide mouth | keyword | B | 36 | 8 | - | 8 (10 other Hydro Flask products rejected) | 165 s | lite |
| 8 | Allbirds Tree Runner (allbirds.com URL) | URL | B | 25 | 5 | 4 exact + 21 colour variants (of 25) | 5 (Allbirds runs few video ads) | 185 s | lite |
| 9 | crocs classic clog (repeat of #1) | keyword | B | 32 | 17 | - | ≈10/17 (brand-only ads judged exact → fix 3) | 205 s | lite |
| 10 | Samsung Galaxy S24 Ultra | keyword | C | 40 | 26 | ≈19/20 | ≈11–12/20 (#12–20 CLIP-only: cases, repair → fix 6) | 117 s | lite |
| 11 | YETI Rambler 30 oz tumbler | keyword | C | 23 | 2 | - | 2 (YETI video ads are mostly coolers; 24 duplicate copies) | 213 s | lite |
| 12 | Birkenstock Arizona sandal | keyword | C | 31 | 20 | 20/20 | ≈11/20 (brand scenes without the product) | 80 s | lite |
| 13 | Nike Air Force 1 '07 | keyword | D | 40 | 20 | not counted | ≈9/20 (Gemini died mid-search; 54 CLIP-only, incl. Air Max 95, Salomon → fix 7) | 178 s | outage |
| 14 | **Adidas Samba OG** | keyword | **E** | **37** | **33** | **≈19/20** | **≈19–20/20** | 150 s | lite, healthy (13 calls) |
| 15 | Oakley Holbrook sunglasses | keyword | E | 38 | 3 | CLIP-only; captions name Holbrook | 3 (10 rejected by fix 7) | 169 s | all Gemini 503 (outage) |
| 16 | Dyson Supersonic hair dryer | keyword | E | 33 | 21 | - | ≈9/20 (CLIP-only: wall holders, Shark, product not visible) | 161 s | outage (7 judged) |
| 17 | Apple Watch Ultra 2 | keyword | E | 33 | 15 | - | - | 245 s | outage (7 calls) |
| 18 | Allbirds Dasher NZ (allbirds.com URL) | URL | E | 6 | 1 | - | - | 141 s | outage (5 calls); niche colourway, URL extraction worked |
| 19 | New Balance 550 | keyword | F | 38 | 3 | - | 3 (10 other New Balance models correctly rejected) | 244 s (deadline) | `3.1-flash-lite` + `3.5-flash-lite` (main models 429/503) |
| 20 | Ray-Ban Aviator Classic | keyword | F | 37 | 3 | - | 3 (10 more left "Not judged" by the per-round cutoff with 6 calls unused → fix 9) | 217 s | `3.5-flash-lite` |
| 21 | **Philips OneBlade** | keyword | **F** | **34** | **34** | **≈19/20** | **20/20** | 101 s | lite chain, healthy (11 calls) |
| 22 | Sony WH-1000XM5 headphones | keyword | F | 34 | 6 | - | 6 (7 other Sony models rejected; ≈130 duplicates) | 241 s (deadline) | lite chain |
| 23 | Stanley ProTour flip straw tumbler 30 oz (stanley1913.com URL) | URL | F | 36 | 16 | ≈6–8/20 ProTour (rest: other Stanley tumblers judged "variant") | ≈2–4/16 (brand ads, product grids, IceFlow) | 165 s | lite chain; page title/brand/model extracted but **no product image** |

**Docker runs (image built on Windows / Docker Desktop 29.8, container `healthy`):**

| # | Product | Code | IG | Meta | Notes |
|---|---|---|---|---|---|
| D1 | Nike Dunk Low Panda | F | 0 | 29 | Instagram session had expired (the API returned the login page as HTML; same result from the host). Meta, CLIP and the container itself worked. |
| D2 | Adidas Gazelle | F + judge v4 + image fix | 31 | 16 | New session works in the container. Gemini overloaded: 10 calls, 0 judged; walking the five-model chain took ~2 min per request, so Meta ran only 1 query → fix 10. |
| D3 | Converse Chuck 70 | + fix 10 | 24 | 8 | Gemini still overloaded (503/429/timeouts), but each request now gives up after 50 s, so Meta ran all 8 queries. The shortfall is duplication plus CLIP-only strictness. |

Fix 10: `GEMINI_CALL_BUDGET_MS` (50 s) caps one Gemini request across the whole model chain, after which the breaker opens and the search continues CLIP-only.

Fix 9 (after #20, not yet live-tested): candidates a round's judge cutoff held back are judged in a catch-up pass at the end while the source is short and Gemini budget/time remain (`judgeHeldBack` in `pipeline.js`, unit-tested).

**Counts:**
- **Instagram ≥20 usable:** 22 of 23 searches. The exception is the niche Allbirds Dasher NZ colourway (6), run during the Gemini outage.
- **Meta ≥20 usable:** 8 of 23 searches (Ray-Ban, Airwrap, S24 Ultra, Birkenstock, AF1, Samba, Supersonic, OneBlade).
- **Both ≥20 by count and ≈20/20 correct on both in the same search:** **Adidas Samba OG** and **Philips OneBlade** (healthy lite judge, all fixes). Ray-Ban and Airwrap reached 20+ on both by count, with lower Meta precision.
- **"Variant" is too broad for product lines with many similar models** (Stanley ProTour vs Quencher H2.0 / IceFlow): the judge accepts sibling models as variants. Not fixed.

## Match quality

**Typical good matches:**
- Instagram creator Reels that show and name the product, e.g. a Crocs reel captioned "Classic crocs in black", Samba outfit videos, Airwrap styling tutorials.
- Meta ads from the brand or authorised retailers showing the exact model (Samba OG, Airwrap, AirPods Pro 2, Hydro Flask 32 oz).
- Correct rejections: other AirPods models (8), other Hydro Flask products (10), Oakley ads whose caption does not name Holbrook (10).

**Typical bad matches (what fixes 2, 3, 6 and 7 target):**
- **Accessories for the product:** iPhone cases, chargers, lens protectors; S24 Ultra cases and repair ads.
- **Brand-only ads:** a logo or lifestyle scene without the product (Crocs, Birkenstock).
- **Related but different products:** Ray-Ban Meta smart glasses for Wayfarer; Supersonic wall holders.
- **CLIP-only look-alikes during the outage:** Air Max 95, Salomon, New Balance for AF1; a Shark dryer for Supersonic.

**Why Meta counts fall short:** mostly the source. For several exact models there are few active video ads (YETI Rambler 2, AirPods Pro 2 4, Allbirds 5, Hydro Flask 8), and reseller copies of the same ad are removed as duplicates. The system reports the shortfall instead of filling it with look-alikes.

## Repeat-search uniqueness (from DB records)

| Check | Result |
|---|---|
| crocs pass 1 accepted / pass 2 accepted | 54 / 49 |
| Accepted in **both** passes | **0** |
| Pass 2 candidates dropped as `seen_before` | 36 Instagram + 9 Meta |

## Earlier evaluation (session 1)

Five products, run ~00:44–01:05 the same day, before judge v3 and before the brand-anchored Meta queries of pass 3. Lite judge only (main models 429).

| Product | Input | IG usable | Meta usable | IG correct (top 20) | Meta correct (top 20) |
|---|---|---|---|---|---|
| crocs classic clog | keyword | 40 | 21 | 20/20 | ≈2–3/20 |
| ray-ban wayfarer sunglasses | keyword | 26 | 18 | 20/20 | ≈4/18 |
| dyson airwrap | keyword | 40 | 23 | 20/20 | ≈5–7/20 |
| Apple iPhone 15 (amazon.in URL) | URL | 30 | 22 | 20/20 (model level) | ≈2–3/20 |
| Allbirds Tree Runner | photo only | 12 | 1 | ≈1–2/12 | 0–1/1 |

- Meta precision was **≈10–35%**: brand-less Meta queries and a lenient lite judge. That led to pass 3 and, after this session's evaluation, to judge v3.
- A crocs repeat search then returned 0 videos already shown in pass 1.
- Full details: `FINAL-EVALUATION-REPORT.md`, section "Session 1".
