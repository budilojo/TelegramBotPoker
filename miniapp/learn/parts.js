/**
 * Общие кирпичики курса: SVG-строитель, ряд карт, ползунок, сегменты, строка «показатель».
 * Всё, что меняется при нажатии, обновляется ТОЧЕЧНО (меняется текст/класс узла):
 * экран курса не перерисовывается, поэтому не «прыгает» (задание владельца, пункт 7).
 */
import { h, cardImg, haptic } from '../ui.js';

const NS = 'http://www.w3.org/2000/svg';

/** svg('rect', {x:1}, ...дети) — узел SVG, строится через createElementNS. */
export function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** Ряд карт: 'AS KH' (коды как у картинок в /cards). */
export const cardsRow = (codes, cls = '') => h(`div.ln-cards${cls ? '.' + cls : ''}`,
  String(codes).split(' ').filter(Boolean).map((c) => cardImg(c)));

/**
 * Ползунок в стиле кита. Возвращает { el, set(v), value }. При движении
 * меняются только значение рядом с подписью и заливка дорожки.
 */
export function slider({ label, min, max, step = 1, value, show = (v) => String(v), onInput, ends }) {
  const out = h('span.ln-slider-val', show(value));
  const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
  const box = h('div.k-slider', input, h('div.k-slider-ends', h('span', ends ? ends[0] : show(min)), h('span', ends ? ends[1] : show(max))));
  const paint = () => box.style.setProperty('--k-fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
  paint();
  const api = {
    el: h('div.k-field.ln-slider', h('span.k-label', label, ': ', out), box),
    get value() { return Number(input.value); },
    set(v) { input.value = v; paint(); out.textContent = show(Number(input.value)); },
  };
  input.addEventListener('input', () => {
    paint();
    out.textContent = show(Number(input.value));
    onInput?.(Number(input.value));
  });
  return api;
}

/**
 * Переключатель из нескольких вариантов (сегменты кита). Возвращает { el, set(v), value }.
 * Меняет только aria-selected, не пересоздаёт кнопки.
 */
export function segs(options, value, onPick) {
  let cur = value;
  const buttons = options.map(([v, label]) => h('button.k-seg', {
    type: 'button', role: 'tab', 'aria-selected': String(v === cur),
    onclick: () => { if (v === cur) return; api.set(v); haptic.tap(); onPick?.(v); },
  }, label));
  const api = {
    el: h('div.k-segmented.ln-segs', { role: 'tablist' }, buttons),
    get value() { return cur; },
    set(v) { cur = v; options.forEach(([ov], i) => buttons[i].setAttribute('aria-selected', String(ov === cur))); },
  };
  return api;
}

/** Строка «подпись — значение», значение обновляется через .set(text). */
export function stat(label, text = '') {
  const val = h('b.ln-stat-val', text);
  return { el: h('div.ln-stat', h('span', label), val), set: (t) => { val.textContent = t; } };
}

/** Горизонтальная полоса 0…1. Возвращает { el, set(share) }. */
export function bar(label, share = 0, tone = '') {
  const fill = h('div.ln-bar-fill');
  const num = h('b');
  const api = {
    el: h(`div.ln-bar${tone ? '.' + tone : ''}`, h('div.ln-bar-top', h('span', label), num), h('div.ln-bar-track', fill)),
    set(s, text) {
      const v = Math.max(0, Math.min(1, s));
      fill.style.width = `${v * 100}%`;
      num.textContent = text ?? `${Math.round(v * 100)}%`;
    },
  };
  api.set(share);
  return api;
}

/** Плашка-вердикт: tone 'ok' | 'bad' | ''. */
export function verdict() {
  const el = h('div.ln-verdict');
  return { el, set(text, tone = '') { el.textContent = text; el.className = `ln-verdict${tone ? ' ' + tone : ''}`; } };
}

/** Подпись-пометка «правило порядка» и т.п. */
export const tag = (text) => h('span.ln-tag', text);
