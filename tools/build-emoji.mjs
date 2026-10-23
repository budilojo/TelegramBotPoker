// Сборка набора эмодзи: node tools/build-emoji.mjs "<папка владельца>"
// Читает tools/emoji-map.json, берёт большие PNG владельца и делает
// miniapp/emoji/<набор>/<id>.png (128x128, палитра PNG-8 с прозрачностью) и
// miniapp/emoji/manifest.json. Без зависимостей; повторный запуск даёт те же файлы.
// Картинки владельца не перекрашиваются и не правятся: только обрезка по контуру,
// масштаб с полями и сжатие цветов (плоская графика — ≤ 48 цветов почти без потерь).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'miniapp', 'emoji');
const SIZE = 128, PAD = 8, COLORS = 48, MAX_BYTES = 12 * 1024;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};

/** Читает PNG 8 бит RGBA без чересстрочности → {w,h,px:Uint8Array RGBA}. */
export function decodePng(buf) {
  let p = 8, w, h, idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); if (d[8] !== 8 || d[9] !== 6 || d[12] !== 0) throw new Error('нужен PNG 8 бит RGBA без чересстрочности'); }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * 4, px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? px[y * stride + i - 4] : 0, b = y ? px[(y - 1) * stride + i] : 0, c = i >= 4 && y ? px[(y - 1) * stride + i - 4] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + i] = v & 255;
    }
  }
  return { w, h, px };
}

/** Обрезка по непрозрачному контуру и масштаб «вписать» в SIZE-2*PAD (усреднение по площади, с альфой). */
function fit({ w, h, px }) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, box = SIZE - 2 * PAD, k = Math.min(box / cw, box / ch);
  const tw = Math.max(1, Math.round(cw * k)), th = Math.max(1, Math.round(ch * k));
  const ox = Math.floor((SIZE - tw) / 2), oy = Math.floor((SIZE - th) / 2);
  const out = new Float64Array(SIZE * SIZE * 4); // премультиплицированные
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
    const sx0 = x0 + tx * cw / tw, sx1 = x0 + (tx + 1) * cw / tw, sy0 = y0 + ty * ch / th, sy1 = y0 + (ty + 1) * ch / th;
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
      const wgt = (Math.min(x + 1, sx1) - Math.max(x, sx0)) * (Math.min(y + 1, sy1) - Math.max(y, sy0));
      const i = (y * w + x) * 4, al = px[i + 3] / 255;
      r += px[i] * al * wgt; g += px[i + 1] * al * wgt; b += px[i + 2] * al * wgt; a += al * wgt; n += wgt;
    }
    const o = ((oy + ty) * SIZE + ox + tx) * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
  }
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const a = out[i * 4 + 3];
    rgba[i * 4 + 3] = Math.round(a * 255);
    if (a > 0) for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.min(255, Math.round(out[i * 4 + c] / a));
  }
  return rgba;
}

/** Медианное сечение по RGBA → палитра; индексы ближайших цветов. Детерминированно. */
function quantize(rgba, nColors) {
  const pts = new Map();
  for (let i = 0; i < rgba.length; i += 4) { const a = rgba[i + 3], key = a === 0 ? 0 : (a << 24 | rgba[i] << 16 | rgba[i + 1] << 8 | rgba[i + 2]) >>> 0; pts.set(key, (pts.get(key) || 0) + 1); }
  const colors = [...pts].map(([k, n]) => ({ c: [(k >>> 16) & 255, (k >>> 8) & 255, k & 255, k >>> 24], n }));
  let boxes = [colors];
  const range = (bx, ch) => { let lo = 255, hi = 0; for (const { c } of bx) { lo = Math.min(lo, c[ch]); hi = Math.max(hi, c[ch]); } return hi - lo; };
  while (boxes.length < nColors) {
    let bi = -1, best = 0, bch = 0;
    boxes.forEach((bx, i) => { if (bx.length < 2) return; for (let ch = 0; ch < 4; ch++) { const s = range(bx, ch) * Math.sqrt(bx.reduce((t, e) => t + e.n, 0)); if (s > best) { best = s; bi = i; bch = ch; } } });
    if (bi < 0) break;
    const bx = boxes[bi].sort((p, q) => p.c[bch] - q.c[bch] || p.c[0] - q.c[0] || p.c[1] - q.c[1] || p.c[2] - q.c[2]);
    const half = bx.reduce((t, e) => t + e.n, 0) / 2; let acc = 0, cut = 1;
    for (let i = 0; i < bx.length - 1; i++) { acc += bx[i].n; cut = i + 1; if (acc >= half) break; }
    boxes.splice(bi, 1, bx.slice(0, cut), bx.slice(cut));
  }
  const pal = boxes.map((bx) => { const n = bx.reduce((t, e) => t + e.n, 0); return [0, 1, 2, 3].map((ch) => Math.round(bx.reduce((t, e) => t + e.c[ch] * e.n, 0) / n)); });
  const ti = pal.findIndex((c) => c[3] === 0);
  const idx = new Uint8Array(SIZE * SIZE), cache = new Map();
  for (let i = 0; i < SIZE * SIZE; i++) {
    const a = rgba[i * 4 + 3], key = a === 0 ? 0 : (a << 24 | rgba[i * 4] << 16 | rgba[i * 4 + 1] << 8 | rgba[i * 4 + 2]) >>> 0;
    let v = cache.get(key);
    if (v === undefined) {
      let bd = Infinity; v = 0;
      pal.forEach((c, j) => { const d = (c[0] - rgba[i * 4]) ** 2 + (c[1] - rgba[i * 4 + 1]) ** 2 + (c[2] - rgba[i * 4 + 2]) ** 2 + 2 * (c[3] - a) ** 2; if (d < bd) { bd = d; v = j; } });
      if (a === 0 && ti >= 0) v = ti;
      cache.set(key, v);
    }
    idx[i] = v;
  }
  return { pal, idx };
}

function encodePng8({ pal, idx }) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 3;
  const raw = Buffer.alloc(SIZE * (SIZE + 1));
  for (let y = 0; y < SIZE; y++) { raw[y * (SIZE + 1)] = 0; for (let x = 0; x < SIZE; x++) raw[y * (SIZE + 1) + 1 + x] = idx[y * SIZE + x]; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('PLTE', Buffer.from(pal.flatMap((c) => c.slice(0, 3)))), chunk('tRNS', Buffer.from(pal.map((c) => c[3]))),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error('Укажите папку владельца: node tools/build-emoji.mjs "<папка>"'); process.exit(1); }
const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'emoji-map.json'), 'utf8'));
fs.rmSync(OUT, { recursive: true, force: true });
const manifest = { version: 1, sets: [] };
let total = 0;
for (const set of map.sets) {
  fs.mkdirSync(path.join(OUT, set.id), { recursive: true });
  const items = [];
  for (const it of set.items) {
    const file = path.join(src, it.src);
    if (!fs.existsSync(file)) { console.error(`Нет файла ${it.src} в папке владельца`); process.exit(1); }
    const png = encodePng8(quantize(fit(decodePng(fs.readFileSync(file))), COLORS));
    if (png.length > MAX_BYTES) { console.error(`${it.id}: ${png.length} байт > ${MAX_BYTES}`); process.exit(1); }
    fs.writeFileSync(path.join(OUT, set.id, `${it.id}.png`), png);
    total += png.length;
    items.push({ id: it.id, file: `${set.id}/${it.id}.png`, label: it.label, ...(it.quick ? { quick: true } : {}) });
    console.log(`${set.id}/${it.id}.png  ${(png.length / 1024).toFixed(1)} КБ`);
  }
  manifest.sets.push({ id: set.id, title: set.title, games: set.games, items });
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Всего ${(total / 1024).toFixed(1)} КБ`);
