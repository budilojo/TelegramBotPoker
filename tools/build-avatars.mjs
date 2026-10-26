// Сборка готовых аватарок из папки владельца: исходник (квадрат, 1254×1254, RGB)
// → miniapp/avatars/<id>.png (128×128, палитровый PNG, ≤ 20 КБ).
// Без внешних программ и библиотек: читает PNG сам, уменьшает усреднением по площади,
// сводит цвета «медианным сечением» (детерминированно: тот же исходник → те же байты).
// Картинки не перекрашиваются и не дорисовываются — только уменьшаются и сжимаются.
// Запуск: node tools/build-avatars.mjs [папка-с-исходниками]
//   (иначе ~/Desktop/аватарки, ~/Desktop/Аватарки, assets-incoming/аватарки/)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'miniapp', 'avatars');
export const SIZE = 128;
export const MAX_BYTES = 20 * 1024;

function crc32(buf) {
  let c, crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
const chunk = (type, data) => {
  const t = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};

/** Читает PNG 8 бит, RGB или RGBA, без чересстрочности → { w, h, rgb } */
export function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('не PNG');
  let p = 8, w, h, bpp, idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = d.readUInt32BE(0); h = d.readUInt32BE(4);
      if (d[8] !== 8 || (d[9] !== 2 && d[9] !== 6) || d[12] !== 0) throw new Error('нужен PNG 8 бит RGB/RGBA без чересстрочности');
      bpp = d[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0, b = y ? px[dst - stride + x] : 0, c = x >= bpp && y ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = px[i * bpp]; rgb[i * 3 + 1] = px[i * bpp + 1]; rgb[i * 3 + 2] = px[i * bpp + 2]; }
  return { w, h, rgb };
}

/** Уменьшение усреднением по площади (квадрат → SIZE×SIZE). */
function shrink({ w, h, rgb }) {
  if (w !== h) throw new Error(`исходник не квадратный: ${w}×${h}`);
  const out = new Uint8Array(SIZE * SIZE * 3), k = w / SIZE;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const x0 = x * k, x1 = x0 + k, y0 = y * k, y1 = y0 + k;
    let r = 0, g = 0, b = 0, sum = 0;
    for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
      const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
      for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
        const wt = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0)), i = (yy * w + xx) * 3;
        r += rgb[i] * wt; g += rgb[i + 1] * wt; b += rgb[i + 2] * wt; sum += wt;
      }
    }
    const o = (y * SIZE + x) * 3;
    out[o] = Math.round(r / sum); out[o + 1] = Math.round(g / sum); out[o + 2] = Math.round(b / sum);
  }
  return out;
}

/** Медианное сечение до n цветов → { palette: [[r,g,b]…], index: Uint8Array } */
function quantize(rgb, n) {
  const count = rgb.length / 3;
  let boxes = [Array.from({ length: count }, (_, i) => i)];
  const range = (ids) => {
    const lo = [255, 255, 255], hi = [0, 0, 0];
    for (const i of ids) for (let c = 0; c < 3; c++) { const v = rgb[i * 3 + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
    return [0, 1, 2].map((c) => hi[c] - lo[c]);
  };
  while (boxes.length < n) {
    let bi = -1, best = 0;
    boxes.forEach((ids, i) => { if (ids.length < 2) return; const r = Math.max(...range(ids)) * Math.sqrt(ids.length); if (r > best) { best = r; bi = i; } });
    if (bi < 0) break;
    const ids = boxes[bi], rg = range(ids), ch = rg.indexOf(Math.max(...rg));
    ids.sort((a, b) => rgb[a * 3 + ch] - rgb[b * 3 + ch] || a - b);
    const mid = ids.length >> 1;
    boxes.splice(bi, 1, ids.slice(0, mid), ids.slice(mid));
  }
  const palette = [], index = new Uint8Array(count);
  boxes.forEach((ids, bi) => {
    let r = 0, g = 0, b = 0;
    for (const i of ids) { r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2]; index[i] = bi; }
    palette.push([Math.round(r / ids.length), Math.round(g / ids.length), Math.round(b / ids.length)]);
  });
  return { palette, index };
}

function encodeIndexed({ palette, index }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 3;
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    const row = index.subarray(y * SIZE, (y + 1) * SIZE), prev = y ? index.subarray((y - 1) * SIZE, y * SIZE) : new Uint8Array(SIZE);
    let bestRow = null, bestScore = Infinity;
    for (let f = 0; f <= 4; f++) {
      const o = Buffer.alloc(SIZE + 1); o[0] = f; let s = 0;
      for (let x = 0; x < SIZE; x++) {
        const a = x ? row[x - 1] : 0, b = prev[x], c = x ? prev[x - 1] : 0;
        let pr = 0;
        if (f === 1) pr = a; else if (f === 2) pr = b; else if (f === 3) pr = (a + b) >> 1;
        else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        const v = (row[x] - pr) & 255; o[x + 1] = v; s += v < 128 ? v : 256 - v;
      }
      if (s < bestScore) { bestScore = s; bestRow = o; }
    }
    rows.push(bestRow);
  }
  const plte = Buffer.from(palette.flat());
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('PLTE', plte),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Самая богатая палитра (из лестницы), при которой файл ≤ MAX_BYTES. */
export function build(srcBuf) {
  const small = shrink(readPng(srcBuf));
  for (const n of [256, 192, 160, 128, 112, 96, 80, 64, 48, 32]) {
    const png = encodeIndexed(quantize(small, n));
    if (png.length <= MAX_BYTES - 512) return { png, colors: n };
  }
  throw new Error('не удалось уложиться в вес');
}

function findSrc() {
  const cands = [process.argv[2], path.join(os.homedir(), 'Desktop', 'аватарки'), path.join(os.homedir(), 'Desktop', 'Аватарки'), path.join(ROOT, 'assets-incoming', 'аватарки')].filter(Boolean);
  const dir = cands.find((d) => fs.existsSync(d));
  if (!dir) throw new Error(`папка с исходниками не найдена: ${cands.join(', ')}`);
  return dir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = findSrc();
  const map = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'avatar-map.json'), 'utf8'));
  fs.mkdirSync(OUT, { recursive: true });
  for (const [id, file] of Object.entries(map)) {
    if (id.startsWith('_')) continue;
    const { png, colors } = build(fs.readFileSync(path.join(dir, file)));
    fs.writeFileSync(path.join(OUT, `${id}.png`), png);
    console.log(`${id}.png ← ${file}: ${png.length} байт, ${colors} цветов`);
  }
}
