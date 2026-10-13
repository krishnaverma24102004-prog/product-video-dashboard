# Demo video script (3–5 min)

Record the screen at 1080p. Before recording: backend (`cd backend && npm run dev`) and frontend (`cd frontend && npm run dev`) running, dashboard open at http://localhost:5173, and **no `.env` or terminal with secrets on screen**.

Use products that have **not** been searched before on this machine, otherwise their videos are filtered as "seen before".

| Time | Show | Say (roughly) |
|---|---|---|
| 0:00–0:20 | Dashboard home: status bar (Instagram session ready, Gemini + CLIP, threshold 50) | "Product Video Discovery: type a product, paste a link or drop a photo, get 20 Instagram Reels and 20 Meta Ad Library videos that show the exact product." |
| 0:20–1:30 | **Search by name**, e.g. `birkenstock boston clog`. Let the progress panel run (analysing, Instagram, Meta, scoring) | "The brain reads the product first: brand, model, colours, distinctive features. It builds branded queries per platform and runs both sources in parallel, with a 240 s deadline." |
| 1:30–2:10 | Results: the two tabs with live counts against 20, a few cards (thumbnail, platform badge, score, reason), sort by score, open one original link | "Every video gets a 0–100 score with a reason. The judge classifies (exact, variant, other model, competitor, accessory, not visible) and the code turns that into the score, so a score can't contradict its reason." |
| 2:10–2:30 | Toggle "Show below-threshold" to show rejected cards and their reasons | "Rejected: other models, accessories, ads where the product isn't visible." |
| 2:30–3:20 | **Search by product link**, e.g. an allbirds.com or amazon product URL. Point at the product panel: extracted title, image, detected attributes | "For a link, the backend fetches the page safely (SSRF checks), extracts title, description and main image, and analyses the photo." |
| 3:20–4:10 | **Repeat search**: run the first product again. Point at the "seen before" drop counts and that the cards are new | "Every video ID is stored with its search. A repeat search filters everything already shown, plus duplicates and near-duplicates (same ad copy, dHash of thumbnails), and widens queries to refill." |
| 4:10–4:40 | History sidebar, star two videos, "Export shortlist (CSV)" | "History, shortlist and CSV export." |
| 4:40–5:00 | (Optional) a source shortfall notice, amber count | "If a source can't reach 20 exact matches, the UI says so and lists what was tried, instead of padding with look-alikes." |

**Don't show:** the `.env` file, the Instagram account name/avatar if you'd rather keep it private, or any terminal output containing keys.
