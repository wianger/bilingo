// 生成扩展图标 PNG（无依赖）：node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outDir = fileURLToPath(new URL('../public/icon/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = clamp(x, x0 + r, x1 - r);
  const cy = clamp(y, y0 + r, y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function draw(size) {
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  const from = [79, 107, 255];
  const to = [138, 92, 255];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!inRoundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) continue;
          const t = (x + y) / 2;
          let c = from.map((v, i) => v + (to[i] - v) * t);
          if (inRoundRect(x, y, 0.2, 0.28, 0.8, 0.43, 0.075)) c = [255, 255, 255];
          else if (inRoundRect(x, y, 0.2, 0.57, 0.64, 0.72, 0.075)) c = c.map((v) => v + (255 - v) * 0.7);
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (a) {
        buf[i] = Math.round(r / a);
        buf[i + 1] = Math.round(g / a);
        buf[i + 2] = Math.round(b / a);
      }
      buf[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return encodePng(size, buf);
}

for (const size of [16, 32, 48, 96, 128]) writeFileSync(`${outDir}${size}.png`, draw(size));
console.log('icons written to', outDir);
