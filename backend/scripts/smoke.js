// Manual smoke test of the live parts: `node scripts/smoke.js "protein bar"`
import { metaCollector } from '../src/collectors/meta.js';
import { closeBrowser } from '../src/collectors/browser.js';
import { embedText, embedImage, cosine } from '../src/vision/clip.js';
import { safeGet } from '../src/urlSafety.js';
import { toJpeg } from '../src/vision/image.js';

const q = process.argv[2] || 'protein bar';
console.time('meta');
const ads = await metaCollector.search({ type: 'keyword', value: q, label: q }, { limit: 25 });
console.timeEnd('meta');
console.log(`meta: ${ads.length} video ads for "${q}"`);
for (const a of ads.slice(0, 3)) console.log(' -', a.author, '|', a.caption.slice(0, 70), '|', a.thumb?.slice(0, 60));

if (ads[0]?.thumb) {
  console.time('clip');
  const ref = await embedText(`a photo of ${q}`);
  const img = await toJpeg((await safeGet(ads[0].thumb)).body, 512);
  console.log('clip text->thumb cosine', cosine(ref, await embedImage(img)).toFixed(3));
  console.timeEnd('clip');
}
await closeBrowser();
