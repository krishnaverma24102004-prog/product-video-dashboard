import { config } from '../config.js';
import { log } from '../log.js';

let loading;
async function load() {
  loading ??= (async () => {
    const t = await import('@huggingface/transformers');
    if (process.env.MODEL_CACHE_DIR) t.env.cacheDir = process.env.MODEL_CACHE_DIR;
    log.info({ model: config.clipModel }, 'loading CLIP (first run downloads ~150MB)');
    const [processor, vision, tokenizer, text] = await Promise.all([
      t.AutoProcessor.from_pretrained(config.clipModel),
      t.CLIPVisionModelWithProjection.from_pretrained(config.clipModel),
      t.AutoTokenizer.from_pretrained(config.clipModel),
      t.CLIPTextModelWithProjection.from_pretrained(config.clipModel),
    ]);
    return { t, processor, vision, tokenizer, text };
  })();
  return loading;
}

function normalize(arr) {
  let n = 0;
  for (const v of arr) n += v * v;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(arr, (v) => v / n);
}

export async function embedImage(jpegBuf) {
  const { t, processor, vision } = await load();
  const image = await t.RawImage.fromBlob(new Blob([jpegBuf], { type: 'image/jpeg' }));
  const inputs = await processor(image);
  const { image_embeds } = await vision(inputs);
  return normalize(image_embeds.data);
}

export async function embedText(text) {
  const { tokenizer, text: model } = await load();
  const inputs = tokenizer([text], { padding: true, truncation: true });
  const { text_embeds } = await model(inputs);
  return normalize(text_embeds.data);
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export const clipReady = () => load().then(() => true);
