/**
 * Картинки коллекции. Контракт: docs/graphit-launch/contracts.md, раздел 7.
 * Адрес собирается только из списка видов и четырёх цветов каталога — пути извне не бывает.
 * Нет файла или он не открылся — вместо картинки рисуется нейтральный запасной вид
 * (базовая «Классика»: рамка и ромб, без цвета коллекции); экран от этого не прыгает,
 * потому что рамка с пропорцией стоит на месте до загрузки.
 *
 * Модуль без DOM при загрузке: `artImg` обращается к `document` только когда вызван.
 */
import { isColor, itemById, itemsOfBundle } from './catalog.js';
import { markFailed, isFailed } from './look-view.js';

/** Все виды, которые бывают в папке art/ (по одному на цвет). */
export const ART_KINDS = [
  'cardback-detail', 'cardback-small', 'table-ornament', 'table-diamond', 'frame-detail', 'frame-small', 'mark',
  'thumb-cardback', 'thumb-table', 'thumb-profile', 'bundle',
];
const KINDS = new Set(ART_KINDS);
/** Короткие имена → «подробный» и «малый» вид. */
const PAIRS = {
  cardback: ['cardback-detail', 'cardback-small'],
  table: ['table-ornament', 'table-diamond'],
  frame: ['frame-detail', 'frame-small'],
};

/**
 * `artUrl('cardback', 'sapphire', true)` → `/collections/art/cardback-detail-sapphire.svg`.
 * `kind` — короткое имя (cardback, table, frame) или полное из ART_KINDS; иначе null.
 */
export function artUrl(kind, color, detail = false) {
  if (typeof kind !== 'string' || !isColor(color)) return null;
  const name = Object.prototype.hasOwnProperty.call(PAIRS, kind) ? PAIRS[kind][detail ? 0 : 1] : kind;
  if (!KINDS.has(name)) return null;
  return `/collections/art/${name}-${color}.svg`;
}

/** Размер рамки-пропорции для вида (ширина:высота). */
export const RATIO = { 'cardback-detail': '200 / 280', 'cardback-small': '200 / 280', 'frame-detail': '1 / 1', 'frame-small': '1 / 1', mark: '1 / 1' };

/**
 * Картинка в рамке с запасным видом. `h` — построитель из ui.js (передаётся, чтобы модуль не тянул DOM).
 * `opts.alt` пуст — картинка декоративная (aria-hidden).
 */
export function artImg(h, kind, color, { detail = false, cls = '', alt = '' } = {}) {
  const url = artUrl(kind, color, detail);
  const name = url ? url.split('/').pop().replace(`-${color}.svg`, '') : '';
  const box = h(`span.col-art${cls ? '.' + cls : ''}`, { style: { '--ratio': RATIO[name] || '1 / 1' }, 'data-art': name || kind });
  const fallback = () => {
    box.classList.add('fallback');
    box.replaceChildren(h('span.col-art-base', { 'aria-hidden': 'true' }));
  };
  if (!url || isFailed(url)) { fallback(); return box; }
  const img = h('img', { src: url, alt, draggable: 'false', decoding: 'async' });
  if (!alt) { img.setAttribute('aria-hidden', 'true'); }
  img.addEventListener('error', () => { markFailed(url); fallback(); }, { once: true });
  box.append(img);
  return box;
}

/** Базовое оформление («Классика»): нейтральная рамка с ромбом, без файлов и без цвета коллекции. */
export function baseArt(h, ratio = '200 / 280') {
  return h('span.col-art.fallback.base', { style: { '--ratio': ratio }, 'data-art': 'base' }, h('span.col-art-base', { 'aria-hidden': 'true' }));
}

const SURFACE_SLOTS = new Set(['table', 'chess-board', 'checkers-board', 'nardy-board', 'battleship-panel']);
const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};
const checker = Array.from({ length: 32 }, (_, i) => {
  const row = Math.floor(i / 4);
  return `M${i % 4 * 2 + (1 - row % 2)} ${row}h1v1h-1z`;
}).join('');
const seaGrid = Array.from({ length: 11 }, (_, i) => `M${i} 0v10M0 ${i}h10`).join('');
const nardyPoints = offset => Array.from({ length: 6 }, (_, i) => {
  const col = i * 2 + (i >= 3 ? .5 : 0) + offset;
  return `M${col} 0h1l-.5 3zM${col} 8h1l-.5-3z`;
}).join('');

function surfacePreview(box, it) {
  box.classList.add('surface-preview');
  box.dataset.surface = it.collection;
  const svg = svgEl('svg', { 'aria-hidden': 'true', viewBox: '0 0 8 8', preserveAspectRatio: 'none' });
  const path = (d, fill, stroke = 'none', opacity = 1) => svgEl('path', { d, fill, stroke, opacity, 'stroke-width': '.05' });
  if (it.slot === 'chess-board' || it.slot === 'checkers-board') {
    svg.append(path('M0 0h8v8H0z' + checker, 'var(--surface-pale)', 'none', .93),
      path(checker, 'var(--surface-mid)', 'none', .88));
    svg.firstChild.setAttribute('fill-rule', 'evenodd');
  } else if (it.slot === 'battleship-panel') {
    svg.setAttribute('viewBox', '0 0 10 10');
    svg.append(path(seaGrid, 'none', 'var(--surface-line)'));
  } else if (it.slot === 'nardy-board') {
    svg.setAttribute('viewBox', '0 0 12.5 8');
    svg.append(path(nardyPoints(0), 'var(--surface-pale)'), path(nardyPoints(1), 'var(--surface-mid)'),
      path('M6.25 0v8', 'none', 'var(--surface-line)'));
  } else {
    svg.append(path('M.4 .4h7.2v7.2H.4zM.65 .65h6.7v6.7H.65z', 'none', 'var(--surface-line)'));
  }
  box.append(svg);
  return box;
}

/** Local catalog descriptor only. Detail is fetched on the item route, thumbnails stay small. */
export function itemArt(h, id, detail = false) {
  const it = itemById(id), src = detail || it?.kind === 'bundle' ? it?.assets?.preview : it?.assets?.game;
  const ratio = ['cardback', 'unoq-cardback'].includes(it?.slot) ? '5 / 7' : it?.slot === 'table' || it?.kind === 'bundle' ? '3 / 2' : it?.slot === 'nardy-board' ? '4 / 3' : '1 / 1';
  const box = h('span.col-art', { 'data-art': id, style: { '--ratio': ratio } });
  if (it?.collection && SURFACE_SLOTS.has(it.slot)) return surfacePreview(box, it);
  // Bundles have no game SVG. Compose their nine existing small assets instead
  // of downloading six detailed bundle previews on the catalog route.
  if (it?.collection && it.kind === 'bundle' && (!detail || it.assets.preview?.startsWith('/collections/raster/'))) {
    box.append(h('span.col-bundle-mini', itemsOfBundle(id).map(part => itemArt(h, part, false))));
    return box;
  }
  const fallback = () => { box.classList.add('fallback'); box.replaceChildren(h('span.col-art-base', { 'aria-hidden': 'true' })); box.setAttribute('aria-label', 'Изображение недоступно · классика'); box.setAttribute('role', 'img'); };
  if (!src || isFailed(src)) { fallback(); return box; }
  const img = h('img', { src, alt: '', 'aria-hidden': 'true', loading: 'lazy', decoding: 'async', draggable: 'false' });
  img.addEventListener('error', () => { markFailed(src); fallback(); }, { once: true });
  box.append(img); return box;
}
