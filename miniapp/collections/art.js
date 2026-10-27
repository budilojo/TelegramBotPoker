/**
 * Картинки коллекции. Контракт: docs/graphit-launch/contracts.md, раздел 7.
 * Адрес собирается только из списка видов и четырёх цветов каталога — пути извне не бывает.
 * Нет файла или он не открылся — вместо картинки рисуется нейтральный запасной вид
 * (базовая «Классика»: рамка и ромб, без цвета коллекции); экран от этого не прыгает,
 * потому что рамка с пропорцией стоит на месте до загрузки.
 *
 * Модуль без DOM при загрузке: `artImg` обращается к `document` только когда вызван.
 */
import { isColor } from './catalog.js';

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
  if (!url) { fallback(); return box; }
  const img = h('img', { src: url, alt, draggable: 'false', decoding: 'async' });
  if (!alt) { img.setAttribute('aria-hidden', 'true'); }
  img.addEventListener('error', fallback, { once: true });
  box.append(img);
  return box;
}

/** Базовое оформление («Классика»): нейтральная рамка с ромбом, без файлов и без цвета коллекции. */
export function baseArt(h, ratio = '200 / 280') {
  return h('span.col-art.fallback.base', { style: { '--ratio': ratio }, 'data-art': 'base' }, h('span.col-art-base', { 'aria-hidden': 'true' }));
}
