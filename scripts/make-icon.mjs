/**
 * 生成应用图标 assets/icon.ico（由 src/index.html 里的 favicon SVG 光栅化而来）。
 *
 * 走 BMP（DIB）条目而不是 PNG 条目：rcedit / electron-builder 改写 exe 图标时对
 * 32 位 DIB 的支持最稳妥。256 的条目按 ICO 规范在目录里写 0。
 *
 *   node scripts/make-icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'assets', 'icon.ico');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const SS = 4; // 每像素超采样数（抗锯齿）

/* 与 favicon 同一套坐标：32×32 画布 */
const BG = [0x15, 0x18, 0x21];
const LINE = [0x7c, 0x9c, 0xff];
const DOTS = [
  { x: 10, y: 16, r: 3.5, c: [0xff, 0x6b, 0x8b] },
  { x: 18, y: 16, r: 3.5, c: [0x4d, 0xab, 0xf7] },
  { x: 25, y: 16, r: 2.5, c: [0x69, 0xdb, 0x7c] },
];
const LINE_A = { x: 5, y: 16 };
const LINE_B = { x: 27, y: 16 };
const LINE_W = 2.5;
const RADIUS = 8;

function inRoundedRect(x, y, size, radius) {
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const dx = Math.max(radius - x, 0, x - (size - radius));
  const dy = Math.max(radius - y, 0, y - (size - radius));
  return dx * dx + dy * dy <= radius * radius;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  return Math.hypot(dx, dy);
}

/** 单个采样点的颜色（图层自下而上覆盖） */
function sampleAt(x, y, size) {
  const s = size / 32;
  if (!inRoundedRect(x, y, size, RADIUS * s)) return null;
  let c = BG;
  if (distToSegment(x, y, LINE_A.x * s, LINE_A.y * s, LINE_B.x * s, LINE_B.y * s, s) <= (LINE_W / 2) * s) c = LINE;
  for (const d of DOTS) {
    if (Math.hypot(x - d.x * s, y - d.y * s) <= d.r * s) c = d.c;
  }
  return c;
}

/** 返回 RGBA 像素（自下而上排列，供 DIB 使用） */
function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const step = 1 / SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sampleAt(x + (sx + 0.5) * step, y + (sy + 0.5) * step, size);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          n++;
        }
      }
      const i = ((size - 1 - y) * size + x) * 4; // DIB 自下而上
      if (!n) {
        out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
        continue;
      }
      const cov = n / (SS * SS);
      out[i] = Math.round(b / n); // B
      out[i + 1] = Math.round(g / n); // G
      out[i + 2] = Math.round(r / n); // R
      out[i + 3] = Math.round(255 * cov); // A
    }
  }
  return out;
}

/** 一个 ICO 条目：BITMAPINFOHEADER + BGRA 像素 + AND 掩码 */
function dibEntry(size) {
  const pixels = render(size);
  const rowBytes = ((size * 32 + 31) >> 5) * 4; // 每行按 4 字节对齐
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size); // 32 位图标带 alpha，掩码全 0
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(pixels.length + mask.length, 20);
  return Buffer.concat([header, pixels, mask]);
}

const entries = SIZES.map((s) => ({ size: s, data: dibEntry(s) }));
const dir = Buffer.alloc(6 + 16 * entries.length);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(entries.length, 4);
let offset = dir.length;
entries.forEach((e, i) => {
  const at = 6 + i * 16;
  dir.writeUInt8(e.size >= 256 ? 0 : e.size, at);
  dir.writeUInt8(e.size >= 256 ? 0 : e.size, at + 1);
  dir.writeUInt8(0, at + 2);
  dir.writeUInt8(0, at + 3);
  dir.writeUInt16LE(1, at + 4);
  dir.writeUInt16LE(32, at + 6);
  dir.writeUInt32LE(e.data.length, at + 8);
  dir.writeUInt32LE(offset, at + 12);
  offset += e.data.length;
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([dir, ...entries.map((e) => e.data)]));
console.log(`icon: ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB, sizes ${SIZES.join(',')})`);
