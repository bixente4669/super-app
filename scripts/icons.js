// Generates app icons as PNG without dependencies: node scripts/icons.js
// PNG is written by hand (IHDR/IDAT/IEND + CRC32) so the project keeps zero packages.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1)
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const BACKDROP = [0x0d, 0x0b, 0x0c];
const CARD = [0xff, 0x2d, 0x87];
const INK = [0x0d, 0x0b, 0x0c];
// Bar edges across the card, as fractions of the barcode block width.
const BARS = [
  [0.0, 0.06],
  [0.1, 0.14],
  [0.19, 0.3],
  [0.34, 0.38],
  [0.43, 0.54],
  [0.58, 0.62],
  [0.67, 0.71],
  [0.75, 0.86],
  [0.9, 1.0],
];

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

// `scale` shrinks the artwork so maskable icons keep their content in the safe zone.
function sample(u, v, scale) {
  const x = (u - 0.5) / scale + 0.5;
  const y = (v - 0.5) / scale + 0.5;
  if (!insideRoundedRect(x, y, 0.11, 0.21, 0.89, 0.79, 0)) return BACKDROP;
  if (x >= 0.2 && x <= 0.8 && y >= 0.335 && y <= 0.665) {
    const t = (x - 0.2) / 0.6;
    for (const [from, to] of BARS) if (t >= from && t < to) return INK;
  }
  return CARD;
}

// 4x4 supersampling keeps the rounded corners and bar edges smooth at every size.
function render(size, scale) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const total = [0, 0, 0];
      for (let sy = 0; sy < 4; sy += 1) {
        for (let sx = 0; sx < 4; sx += 1) {
          const color = sample((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size, scale);
          for (let i = 0; i < 3; i += 1) total[i] += color[i];
        }
      }
      const at = (y * size + x) * 4;
      for (let i = 0; i < 3; i += 1) rgba[at + i] = Math.round(total[i] / 16);
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}

/**
 * The favicon is drawn from the same constants as the PNGs, so the two cannot drift.
 * SVG rather than .ico: one file, crisp at any size, and a fraction of the bytes.
 */
function favicon() {
  const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  const bars = BARS.map(
    ([from, to]) =>
      `<rect x="${(20 + 60 * from).toFixed(2)}" y="33.5" ` +
      `width="${(60 * (to - from)).toFixed(2)}" height="33" fill="${hex(INK)}"/>`,
  ).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" fill="${hex(BACKDROP)}"/>` +
    `<rect x="11" y="21" width="78" height="58" fill="${hex(CARD)}"/>` +
    `${bars}</svg>\n`
  );
}

const directory = new URL("../public/icons/", import.meta.url);
mkdirSync(directory, { recursive: true });
const targets = [
  ["icon-192.png", 192, 1],
  ["icon-512.png", 512, 1],
  ["icon-maskable-192.png", 192, 0.72],
  ["icon-maskable-512.png", 512, 0.72],
  ["apple-touch-icon.png", 180, 1],
];
for (const [name, size, scale] of targets) {
  writeFileSync(new URL(name, directory), png(size, render(size, scale)));
  console.log(`${name} (${size}px)`);
}
writeFileSync(new URL("../public/favicon.svg", import.meta.url), favicon());
console.log("favicon.svg");
console.log(`Written to ${fileURLToPath(directory)}`);
