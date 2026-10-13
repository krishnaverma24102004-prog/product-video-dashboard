export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = (base, spread = 0.5) => base + Math.random() * base * spread;

export function withTimeout(promise, ms, label = 'operation') {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/** Retries `fn` with exponential backoff, except for errors flagged `fatal` (auth walls, bad input). */
export async function withRetry(fn, { tries = 2, baseMs = 1500, onRetry } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      if (e.fatal || i === tries - 1) break;
      onRetry?.(e, i + 1);
      await sleep(baseMs * 2 ** i);
    }
  }
  throw last;
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx).catch((e) => ({ __error: e }));
      }
    }),
  );
  return out;
}

export class SourceError extends Error {
  constructor(message, { code = 'SOURCE_ERROR', fatal = false } = {}) {
    super(message);
    this.code = code;
    this.fatal = fatal;
  }
}
