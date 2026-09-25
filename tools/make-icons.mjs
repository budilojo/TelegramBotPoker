/**
 * Generates the PWA / home-screen icons as real PNGs — no image dependencies,
 * just zlib and a little bit of maths. Run: node tools/make-icons.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

/* ------------------------------------------------------------- png writer */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------- drawing */

const lerp = (a, b, t) => a + (b - a) * t;
const hex = (s) => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
];

/**
 * Coverage of a shape at (x,y) via 4x4 supersampling — cheap anti-aliasing.
 */
function coverage(x, y, test) {
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      if (test(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits++;
    }
  }
  return hits / 16;
}

function makeIcon(size, { maskable = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const S = size;
  const top = hex('#1f8459');
  const bot = hex('#0a2418');
  const chipCol = hex('#eafff4');

  const pad = maskable ? S * 0.14 : 0;
  const radius = maskable ? S * 0.5 : S * 0.225;
  const boxMin = pad;
  const boxMax = S - pad;

  const inBox = (x, y) => {
    if (maskable) {
      // Full-bleed circle-safe square for Android adaptive icons.
      return x >= 0 && y >= 0 && x <= S && y <= S;
    }
    const rx = Math.max(boxMin + radius - x, 0, x - (boxMax - radius));
    const ry = Math.max(boxMin + radius - y, 0, y - (boxMax - radius));
    if (x < boxMin || x > boxMax || y < boxMin || y > boxMax) return false;
    return rx * rx + ry * ry <= radius * radius;
  };

  const cx = S / 2;
  const cy = S / 2;
  const R = S * 0.29; // ring radius
  const ringW = S * 0.052;
  const coreR = S * 0.105;
  const notchW = S * 0.042;
  const notchIn = R - ringW * 0.2;
  const notchOut = R + ringW * 0.95;

  const inChip = (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.hypot(dx, dy);
    if (Math.abs(d - R) <= ringW / 2) return true;
    if (d <= coreR) return true;
    if (d >= notchIn && d <= notchOut) {
      const a = Math.atan2(dy, dx);
      for (let i = 0; i < 8; i++) {
        const ang = (i * Math.PI) / 4 + Math.PI / 8;
        let diff = Math.abs(((a - ang + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (diff * d <= notchW / 2) return true;
      }
    }
    return false;
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const bgA = coverage(x, y, inBox);
      if (bgA <= 0) continue;
      const t = y / S;
      let r = lerp(top[0], bot[0], t);
      let g = lerp(top[1], bot[1], t);
      let b = lerp(top[2], bot[2], t);

      const chipA = coverage(x, y, inChip);
      if (chipA > 0) {
        r = lerp(r, chipCol[0], chipA);
        g = lerp(g, chipCol[1], chipA);
        b = lerp(b, chipCol[2], chipA);
      }
      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(bgA * 255);
    }
  }
  return png(S, S, buf);
}

fs.mkdirSync(OUT, { recursive: true });
const targets = [
  ['apple-touch-icon.png', 180, {}],
  ['icon-192.png', 192, { maskable: true }],
  ['icon-512.png', 512, { maskable: true }],
];
for (const [name, size, opts] of targets) {
  fs.writeFileSync(path.join(OUT, name), makeIcon(size, opts));
  console.log('wrote', name, size + 'px');
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#1f8459"/><stop offset="1" stop-color="#0a2418"/>
  </linearGradient></defs>
  <rect width="100" height="100" rx="22" fill="url(#g)"/>
  <g fill="none" stroke="#eafff4" stroke-width="5.2" stroke-linecap="round">
    <circle cx="50" cy="50" r="29"/>
    <path d="M50 17v7M50 76v7M17 50h7M76 50h7M26.7 26.7l5 5M68.3 68.3l5 5M73.3 26.7l-5 5M31.7 68.3l-5 5"/>
  </g>
  <circle cx="50" cy="50" r="10.5" fill="#eafff4"/>
</svg>`;
fs.writeFileSync(path.join(OUT, 'icon.svg'), svg);
console.log('wrote icon.svg');
