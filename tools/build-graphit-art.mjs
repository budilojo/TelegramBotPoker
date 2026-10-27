/**
 * Генератор графики коллекции «Графит» (контракт: docs/graphit-launch/contracts.md, раздел 7).
 *
 * Одна геометрия — четыре палитры. Каждый предмет описан один раз списком фигур, где цвет —
 * только роль ('bg' — фон предмета, 'ink' — линия). Палитра подставляется при записи файла,
 * поэтому у четырёх цветов совпадают viewBox, пути, толщины и порядок элементов — отличаются
 * только HEX. Чистый Node без зависимостей, детерминированный: повторный запуск = те же байты.
 *
 *   node tools/build-graphit-art.mjs                 → miniapp/collections/art/*
 *   node tools/build-graphit-art.mjs --out <папка>   → в другую папку (для тестов и «зубов»)
 *   node tools/build-graphit-art.mjs --report        → контрасты и вес (числа для отчёта)
 *   node tools/build-graphit-art.mjs --sheet <папка> → контрольные листы PNG (нужен Playwright)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { COLORS } from '../miniapp/collections/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ART_DIR = path.join(ROOT, 'miniapp/collections/art');

/** Бюджет веса (байты) из контракта. */
export const BUDGET = { detail: 24 * 1024, small: 8 * 1024 };

// ------------------------------------------------------------------ числа и фигуры

const n = (v) => {
  const s = (Math.round(v * 100) / 100).toString();
  return s === '-0' ? '0' : s;
};
const pt = (x, y) => `${n(x)} ${n(y)}`;
const seg = (a, b) => `M${pt(a[0], a[1])}L${pt(b[0], b[1])}`;

/** Фигура: [тег, атрибуты]. Значения 'bg'/'ink' в fill/stroke заменяются на HEX палитры. */
const P = (d, o = {}) => ['path', { d, fill: 'none', ...o }];
const R = (x, y, w, h, rx, o = {}) => ['rect', { x: n(x), y: n(y), width: n(w), height: n(h), rx: n(rx), ...o }];
const E = (cx, cy, rx, ry, o = {}) => ['ellipse', { cx: n(cx), cy: n(cy), rx: n(rx), ry: n(ry), ...o }];
const C = (cx, cy, r, o = {}) => ['circle', { cx: n(cx), cy: n(cy), r: n(r), ...o }];
const G = (transform, kids) => ['g', { transform }, kids];

const diamondD = (cx, cy, r) => `M${pt(cx, cy - r)}L${pt(cx + r, cy)}L${pt(cx, cy + r)}L${pt(cx - r, cy)}Z`;
/** Ромб: заливка фоном предмета, контур линией. */
const diamond = (cx, cy, r, sw) => P(diamondD(cx, cy, r), { fill: 'bg', stroke: 'ink', 'stroke-width': n(sw), 'stroke-linejoin': 'miter' });
const solidDiamond = (cx, cy, r) => P(diamondD(cx, cy, r), { fill: 'ink' });

const lines = (d, sw, extra = {}) => P(d, { stroke: 'ink', 'stroke-width': n(sw), 'stroke-linecap': 'butt', ...extra });

// ------------------------------------------------------------------ плетёная решётка

/**
 * Две семьи диагоналей в прямоугольнике [-hw,hw]×[-hh,hh] вокруг центра; на пересечениях
 * поочерёдно «сверху»/«снизу» (у нижней линии разрыв) — получается плетение.
 * Возвращает [путь семьи A, путь семьи B] в локальных координатах (сдвиг cx,cy).
 */
function weave(cx, cy, hw, hh, d, gap) {
  const kmax = Math.ceil((hw + hh) / d);
  const out = [[], []];
  for (let fam = 0; fam < 2; fam++) {
    for (let k = -kmax; k <= kmax; k++) {
      // Семья 0: u - v = k·d  (v = u - kd);  семья 1: u + v = k·d  (v = kd - u).
      const vAt = (u) => (fam === 0 ? u - k * d : k * d - u);
      let u0 = Math.max(-hw, fam === 0 ? k * d - hh : k * d - hh);
      let u1 = Math.min(hw, fam === 0 ? k * d + hh : k * d + hh);
      if (u1 - u0 < 1e-6) continue;
      // Пересечения с линиями другой семьи.
      const cuts = [];
      for (let m = -kmax; m <= kmax; m++) {
        const u = (k * d + m * d) / 2;
        if (u <= u0 + 1e-6 || u >= u1 - 1e-6) continue;
        const under = fam === 0 ? (k + m) % 2 === 0 : (k + m) % 2 !== 0;
        if (under) cuts.push(u);
      }
      cuts.sort((a, b) => a - b);
      let from = u0;
      for (const u of cuts) {
        if (u - gap > from) out[fam].push(seg([cx + from, cy + vAt(from)], [cx + u - gap, cy + vAt(u - gap)]));
        from = u + gap;
      }
      if (u1 > from) out[fam].push(seg([cx + from, cy + vAt(from)], [cx + u1, cy + vAt(u1)]));
    }
  }
  return out.map((a) => a.join(''));
}

// ------------------------------------------------------------------ рубашка (200×280)

function cardback(detail) {
  const els = [R(0, 0, 200, 280, 12, { fill: 'bg' })];
  if (detail) {
    els.push(R(6, 6, 188, 268, 8, { fill: 'none', stroke: 'ink', 'stroke-width': '3' }));
    els.push(R(14, 14, 172, 252, 4, { fill: 'none', stroke: 'ink', 'stroke-width': '1.5' }));
    const [a, b] = weave(100, 140, 80, 120, 40, 5);
    els.push(lines(a, 1.5), lines(b, 1.5));
    for (const [x, y] of [[34, 34], [166, 34], [34, 246], [166, 246]]) els.push(diamond(x, y, 9, 1.5));
    els.push(diamond(100, 140, 52, 3));
    els.push(P(diamondD(100, 140, 38), { stroke: 'ink', 'stroke-width': '1.5' }));
    els.push(P(diamondD(100, 140, 24), { stroke: 'ink', 'stroke-width': '2' }));
    els.push(solidDiamond(100, 140, 10));
  } else {
    els.push(R(9, 9, 182, 262, 8, { fill: 'none', stroke: 'ink', 'stroke-width': '8' }));
    const [a, b] = weave(100, 140, 78, 118, 70, 8);
    els.push(lines(a, 5), lines(b, 5));
    els.push(diamond(100, 140, 52, 8));
    els.push(P(diamondD(100, 140, 30), { stroke: 'ink', 'stroke-width': '6' }));
    els.push(solidDiamond(100, 140, 12));
  }
  return { viewBox: [200, 280], els };
}

// ------------------------------------------------------------------ стол (320×400, овал)

const TB = { w: 320, h: 400, cx: 160, cy: 200 };
const ell = (rx, ry, a) => [TB.cx + rx * Math.cos(a), TB.cy + ry * Math.sin(a)];

/**
 * Полоса по краю овала: две линии кромки и плетение между ними, ромбы по кругу.
 * Центр свободен (внутренняя линия — на 15% от края). Линии не масштабируются
 * вместе с овалом (`vector-effect`), ромбы мягко растягиваются вместе с ним.
 */
function tableOrnament(detail) {
  const out = { rx: 156, ry: 196 };
  const inn = { rx: 134, ry: 170 };
  const nSeg = detail ? 28 : 16;
  const els = [];
  const ne = { 'vector-effect': 'non-scaling-stroke' };
  const sw = detail ? 1.5 : 3;
  els.push(E(TB.cx, TB.cy, out.rx, out.ry, { fill: 'none', stroke: 'ink', 'stroke-width': n(detail ? 2 : 4), ...ne }));
  els.push(E(TB.cx, TB.cy, inn.rx, inn.ry, { fill: 'none', stroke: 'ink', 'stroke-width': n(sw), ...ne }));
  const da = [];
  const db = [];
  for (let i = 0; i < nSeg; i++) {
    const a0 = (i * 2 * Math.PI) / nSeg;
    const a1 = ((i + 1) * 2 * Math.PI) / nSeg;
    const o0 = ell(out.rx - 2, out.ry - 2, a0);
    const o1 = ell(out.rx - 2, out.ry - 2, a1);
    const i0 = ell(inn.rx + 1, inn.ry + 1, a0);
    const i1 = ell(inn.rx + 1, inn.ry + 1, a1);
    // Плетение: у чётных звеньев «сверху» одна диагональ, у нечётных — другая.
    if (i % 2 === 0) { da.push(seg(o0, i1)); db.push(seg(i0, o1)); }
    else { db.push(seg(i0, o1)); da.push(seg(o0, i1)); }
  }
  // Диагонали с разрывом: каждая вторая из «B» укорочена в середине — плетение.
  els.push(lines(da.join(''), sw, ne));
  els.push(lines(db.filter((_, i) => i % 2 === 0).join(''), sw, ne));
  const mid = { rx: (out.rx + inn.rx) / 2, ry: (out.ry + inn.ry) / 2 };
  const nd = detail ? 12 : 8;
  for (let i = 0; i < nd; i++) {
    const [x, y] = ell(mid.rx, mid.ry, (i * 2 * Math.PI) / nd - Math.PI / 2);
    els.push(diamond(x, y, detail ? 9 : 12, detail ? 1.5 : 3));
  }
  return { viewBox: [TB.w, TB.h], els };
}

function tableDiamond() {
  return {
    viewBox: [48, 48],
    els: [
      diamond(24, 24, 20, 2.5),
      P(diamondD(24, 24, 11), { stroke: 'ink', 'stroke-width': '2' }),
      solidDiamond(24, 24, 4),
    ],
  };
}

// ------------------------------------------------------------------ рамка (120×120, центр прозрачный)

const FR = { c: 60, rIn: 46, rOut: 58 };

function frame(detail) {
  const { c, rIn, rOut } = FR;
  const ring = `M${pt(c - rOut, c)}A${rOut} ${rOut} 0 1 0 ${pt(c + rOut, c)}A${rOut} ${rOut} 0 1 0 ${pt(c - rOut, c)}Z` +
    `M${pt(c - rIn, c)}A${rIn} ${rIn} 0 1 0 ${pt(c + rIn, c)}A${rIn} ${rIn} 0 1 0 ${pt(c - rIn, c)}Z`;
  const els = [P(ring, { fill: 'bg', 'fill-rule': 'evenodd' })];
  const sw = detail ? 1.6 : 3.5;
  els.push(C(c, c, rOut - sw / 2, { fill: 'none', stroke: 'ink', 'stroke-width': n(sw) }));
  els.push(C(c, c, rIn + sw / 2, { fill: 'none', stroke: 'ink', 'stroke-width': n(sw) }));
  if (detail) {
    const N = 24;
    const pa = [];
    const pb = [];
    for (let i = 0; i < N; i++) {
      const a0 = (i * 2 * Math.PI) / N;
      const a1 = ((i + 1) * 2 * Math.PI) / N;
      const at = (r, a) => [c + r * Math.cos(a), c + r * Math.sin(a)];
      const rO = rOut - sw;
      const rI = rIn + sw;
      pa.push(seg(at(rO, a0), at(rI, a1)));
      if (i % 2 === 0) pb.push(seg(at(rI, a0), at(rO, a1)));
    }
    els.push(lines(pa.join(''), 1.2), lines(pb.join(''), 1.2));
  }
  const rm = (rIn + rOut) / 2;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 - Math.PI / 2;
    els.push(diamond(c + rm * Math.cos(a), c + rm * Math.sin(a), 7.5, detail ? 1.5 : 3));
  }
  return { viewBox: [120, 120], els };
}

// ------------------------------------------------------------------ знак (24×24)

function mark() {
  return { viewBox: [24, 24], els: [diamond(12, 12, 10, 2.2), P(diamondD(12, 12, 4.4), { fill: 'none', stroke: 'ink', 'stroke-width': '2' })] };
}

// ------------------------------------------------------------------ миниатюры и комплект (упрощённая геометрия)

const sub = (g) => g.els;
const scaleG = (g, x, y, k, rot = 0) => G(`translate(${n(x)} ${n(y)})${rot ? ` rotate(${n(rot)})` : ''} scale(${n(k)})`, sub(g));

function thumbCardback() {
  const cb = cardback(false);
  return { viewBox: [96, 96], els: [scaleG(cb, 48 - 100 * 0.3, 48 - 140 * 0.3, 0.3)] };
}

function thumbTable() {
  return {
    viewBox: [96, 96],
    els: [
      E(48, 48, 44, 30, { fill: 'bg', stroke: 'ink', 'stroke-width': '4' }),
      E(48, 48, 33, 20, { fill: 'none', stroke: 'ink', 'stroke-width': '3' }),
      diamond(48, 48, 8, 3),
    ],
  };
}

function thumbProfile() {
  const fr = frame(false);
  return { viewBox: [96, 96], els: [scaleG(fr, 0, 11, 0.62), scaleG(mark(), 72, 36, 1)] };
}

function bundle() {
  const cb = cardback(false);
  const fr = frame(false);
  return {
    viewBox: [240, 160],
    els: [
      scaleG(cb, 36, 20, 0.42, -12),
      scaleG(cb, 112, 14, 0.42, 12),
      scaleG(cb, 74, 12, 0.42, 0),
      scaleG(fr, 176, 4, 0.5),
      E(202, 118, 32, 22, { fill: 'bg', stroke: 'ink', 'stroke-width': '3' }),
      scaleG(mark(), 192, 108, 0.8),
    ],
  };
}

// ------------------------------------------------------------------ список файлов

/** Имя без цвета → описание. `detail` — подробный (бюджет 24 КБ), иначе 8 КБ. */
export const KINDS = [
  { name: 'cardback-detail', detail: true, make: () => cardback(true) },
  { name: 'cardback-small', detail: false, make: () => cardback(false) },
  { name: 'table-ornament', detail: true, par: 'none', make: () => tableOrnament(true) },
  { name: 'table-diamond', detail: false, make: tableDiamond },
  { name: 'frame-detail', detail: true, make: () => frame(true) },
  { name: 'frame-small', detail: false, make: () => frame(false) },
  { name: 'mark', detail: false, make: mark },
  { name: 'thumb-cardback', detail: false, make: thumbCardback },
  { name: 'thumb-table', detail: false, make: thumbTable },
  { name: 'thumb-profile', detail: false, make: thumbProfile },
  { name: 'bundle', detail: false, make: bundle },
];
export const FILE_NAMES = KINDS.flatMap((k) => COLORS.map((c) => `${k.name}-${c.id}.svg`));

// ------------------------------------------------------------------ запись SVG

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function render(els, pal) {
  return els.map(([tag, attrs, kids]) => {
    const a = Object.entries(attrs).map(([k, v]) => {
      const val = (k === 'fill' || k === 'stroke') && (v === 'bg' || v === 'ink') ? pal[v] : v;
      return ` ${k}="${esc(val)}"`;
    }).join('');
    return kids ? `<${tag}${a}>${render(kids, pal)}</${tag}>` : `<${tag}${a}/>`;
  }).join('');
}

export function svgFor(kind, color) {
  const g = kind.make();
  const [w, h] = g.viewBox;
  const pal = { bg: color.bg, ink: color.ink };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"${kind.par ? ` preserveAspectRatio="${kind.par}"` : ''} aria-hidden="true" focusable="false">${render(g.els, pal)}</svg>\n`;
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Собирает всё в память: { files: Map(имя → строка), manifest }. Детерминированно. */
export function buildAll() {
  const files = new Map();
  const items = [];
  for (const kind of KINDS) {
    for (const color of COLORS) {
      const file = `${kind.name}-${color.id}.svg`;
      const text = svgFor(kind, color);
      files.set(file, text);
      const [w, h] = kind.make().viewBox;
      items.push({ file, kind: kind.name, color: color.id, detail: kind.detail, viewBox: `0 0 ${w} ${h}`, width: w, height: h, bytes: Buffer.byteLength(text), sha256: sha(Buffer.from(text)) });
    }
  }
  const manifest = {
    collection: 'graphit',
    generator: 'tools/build-graphit-art.mjs',
    colors: COLORS.map((c) => ({ id: c.id, bg: c.bg, ink: c.ink })),
    budget: { detailBytes: BUDGET.detail, smallBytes: BUDGET.small },
    files: items,
  };
  return { files, manifest };
}

export function writeAll(outDir = ART_DIR) {
  const { files, manifest } = buildAll();
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, text] of files) fs.writeFileSync(path.join(outDir, name), text);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { files, manifest };
}

// ------------------------------------------------------------------ контраст

const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const luminance = (hex) => { const [r, g, b] = rgb(hex).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** CIE Lab (D65) → ΔE76: «насколько разные» цвета по восприятию, не только по яркости. */
export function lab(hex) {
  const [r, g, b] = rgb(hex).map(lin);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
export const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
export const GREEN = '#137A43';
export const SURFACES = ['#0A1216', '#13212A', '#1D2D35'];

function report() {
  const { files } = buildAll();
  console.log('Контраст линии к фону предмета, линии к подложкам и отличие от зелёного хода #137A43:');
  for (const c of COLORS) {
    const row = [`${c.id}: ink/bg ${contrast(c.ink, c.bg).toFixed(2)}`];
    for (const s of SURFACES) row.push(`ink/${s} ${contrast(c.ink, s).toFixed(2)}`);
    row.push(`bg/${SURFACES[1]} ${contrast(c.bg, SURFACES[1]).toFixed(2)}`);
    row.push(`ink~green ${contrast(c.ink, GREEN).toFixed(2)} ΔE ${deltaE(c.ink, GREEN).toFixed(1)}`);
    row.push(`bg~green ΔE ${deltaE(c.bg, GREEN).toFixed(1)}`);
    console.log(' ', row.join(' · '));
  }
  console.log('Вес (байт):');
  for (const [name, text] of files) if (name.endsWith('-graphite.svg')) console.log(' ', name.replace('-graphite', ''), Buffer.byteLength(text));
}

// ------------------------------------------------------------------ контрольные листы

async function sheets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');
  const { files } = buildAll();
  const url = (name) => `data:image/svg+xml;utf8,${encodeURIComponent(files.get(name))}`;
  const row = (label, name, w, h, bg) => `<div class="c" style="background:${bg}"><img src="${url(name)}" width="${w}" height="${h}"><i>${label}</i></div>`;
  const pages = {
    // Закрытые карты в реальных ширинах на трёх подложках.
    cardbacks: () => SURFACES.map((bg) => `<div class="r" style="background:${bg}">${COLORS.map((c) => [18, 24, 32, 44, 60].map((w) => row(`${c.id} ${w}`, `cardback-small-${c.id}.svg`, w, Math.round(w * 1.4), bg)).join('')).join('')}</div>`).join(''),
    // Подробная рубашка крупно — для сравнения цветов.
    detail: () => `<div class="r" style="background:#13212A">${COLORS.map((c) => row(c.id, `cardback-detail-${c.id}.svg`, 200, 280, '#13212A')).join('')}</div>`,
    // Рамка на круглом аватаре 32–56 и знак 14–24, рядом плашка «Ваш ход» (#137A43).
    frames: () => SURFACES.map((bg) => `<div class="r" style="background:${bg}">${COLORS.map((c) => [32, 40, 48, 56].map((a) => { const f = Math.round(a / 0.733); return `<div class="c" style="background:${bg}"><span style="position:relative;display:inline-block;width:${f}px;height:${f}px"><span class="av" style="width:${a}px;height:${a}px;left:${(f - a) / 2}px;top:${(f - a) / 2}px">ИВ</span><img style="position:absolute;left:0;top:0" src="${url(`frame-small-${c.id}.svg`)}" width="${f}" height="${f}"></span><i>${c.id} ${a}</i></div>`; }).join('') + [14, 18, 24].map((m) => row(`${c.id} знак ${m}`, `mark-${c.id}.svg`, m, m, bg)).join('') + `<span class="go">Ваш ход</span>`).join('')}</div>`).join(''),
    frameBig: () => `<div class="r" style="background:#13212A">${COLORS.map((c) => row(c.id, `frame-detail-${c.id}.svg`, 240, 240, '#13212A')).join('')}</div>`,
    // Стол: орнамент поверх овала 320×? разных пропорций, на сукне проекта.
    tables: () => `<div class="r" style="background:#0A1216">${COLORS.map((c) => [[320, 400], [360, 420], [300, 300], [380, 280]].map(([w, h]) => `<div class="c"><div style="position:relative;width:${w}px;height:${h}px"><div style="position:absolute;inset:0;border-radius:50%;background:#0F3D2C"></div><img style="position:absolute;inset:0" src="${url(`table-ornament-${c.id}.svg`)}" width="${w}" height="${h}" preserveAspectRatio="none"><img style="position:absolute;left:${w / 2 - 12}px;top:${h / 2 - 12}px" src="${url(`table-diamond-${c.id}.svg`)}" width="24" height="24"></div><i>${c.id} ${w}×${h}</i></div>`).join('')).join('')}</div>`,
    thumbs: () => `<div class="r" style="background:#13212A">${COLORS.map((c) => ['thumb-cardback', 'thumb-table', 'thumb-profile', 'bundle'].map((k) => row(c.id, `${k}-${c.id}.svg`, k === 'bundle' ? 240 : 96, k === 'bundle' ? 160 : 96, '#13212A')).join('')).join('')}</div>`,
  };
  const browser = await chromium.launch();
  for (const [name, body] of Object.entries(pages)) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
    await page.setContent(`<style>body{margin:0;background:#0A1216;color:#9aa;font:11px sans-serif}.r{display:flex;flex-wrap:wrap;padding:8px;gap:8px}.c{display:inline-block;padding:4px;text-align:center}.c i{display:block;font-style:normal;font-size:9px}.av{position:absolute;border-radius:50%;background:#1D2D35;color:#fff;font:600 12px sans-serif;display:flex;align-items:center;justify-content:center}.go{background:#137A43;color:#fff;padding:4px 8px;border-radius:999px;margin:8px}</style>${body()}`);
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
    await page.close();
  }
  await browser.close();
  console.log(`листы: ${dir}`);
}

// ------------------------------------------------------------------ запуск

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  if (args.includes('--report')) report();
  else if (opt('--sheet')) await sheets(path.resolve(opt('--sheet')));
  else {
    const { files } = writeAll(opt('--out') ? path.resolve(opt('--out')) : ART_DIR);
    console.log(`записано файлов: ${files.size} + manifest.json`);
  }
}
