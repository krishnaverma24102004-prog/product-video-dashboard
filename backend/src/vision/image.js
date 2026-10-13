import sharp from 'sharp';

/** 64-bit difference hash (dHash) as 16 hex chars. Robust to rescaling/recompression, so reposts land within a few bits. */
export async function dHash(buf) {
  const { data } = await sharp(buf, { failOn: 'none' })
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? '1' : '0';
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** Normalise to a bounded JPEG (also strips odd formats like webp/avif that vision APIs reject). */
export async function toJpeg(buf, maxSide = 768, quality = 82) {
  return sharp(buf, { failOn: 'none' })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality })
    .toBuffer();
}
