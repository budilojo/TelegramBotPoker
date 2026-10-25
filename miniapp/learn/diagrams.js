/**
 * Схемы курса — рисуются кодом из токенов (классы в learn.css), без картинок и без
 * внешних доменов. У каждой схемы есть точечное обновление (`set…`), чтобы интерактивные
 * примеры меняли только нужный узел.
 */
import { h } from '../ui.js';
import { svg, cardsRow } from './parts.js';
import { RANKS, ALL_HANDS, cellHand, rankCode } from './hands.js';

/* ------------------------------------------------------ стол и позиции */

/** Шесть мест по часовой стрелке от кнопки. `desc` — что значит место. */
export const SEATS = [
  { id: 'BTN', name: 'Кнопка', deg: 60 },
  { id: 'SB', name: 'Малый блайнд', deg: 120 },
  { id: 'BB', name: 'Большой блайнд', deg: 180 },
  { id: 'UTG', name: 'Ранняя позиция', deg: 240 },
  { id: 'HJ', name: 'Средняя позиция', deg: 300 },
  { id: 'CO', name: 'Хайджек/катофф', deg: 360 },
];

/**
 * Стол сверху: места по кругу, кнопка дилера, подсветка выбранного места.
 * Нажатие на место — `onPick(id)`; подсветка переключается без пересоздания стола.
 */
export function positionsTable({ on = null, onPick, label = (id) => id } = {}) {
  const W = 320; const H = 200; const cx = W / 2; const cy = H / 2; const rx = 118; const ry = 66;
  const root = svg('svg', { class: 'ln-table', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Стол: места по кругу' },
    svg('ellipse', { class: 'ln-felt', cx, cy, rx: rx + 6, ry: ry + 4 }));
  const nodes = new Map();
  for (const s of SEATS) {
    const a = (s.deg * Math.PI) / 180;
    const x = cx + rx * Math.cos(a); const y = cy + ry * Math.sin(a);
    const g = svg('g', { class: 'ln-seat', role: onPick ? 'button' : null, tabindex: onPick ? 0 : null, 'aria-label': s.name },
      svg('circle', { cx: x, cy: y, r: 22 }),
      svg('text', { x, y: y + 4, 'text-anchor': 'middle' }, label(s.id)));
    if (onPick) {
      g.addEventListener('click', () => onPick(s.id));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(s.id); } });
    }
    root.append(g);
    nodes.set(s.id, g);
  }
  const btn = SEATS[0]; const ba = (btn.deg * Math.PI) / 180;
  root.append(svg('g', { class: 'ln-dealer' },
    svg('circle', { cx: cx + (rx - 34) * Math.cos(ba), cy: cy + (ry - 22) * Math.sin(ba), r: 9 }),
    svg('text', { x: cx + (rx - 34) * Math.cos(ba), y: cy + (ry - 22) * Math.sin(ba) + 4, 'text-anchor': 'middle' }, 'D')));
  const api = {
    el: root,
    set(id) { for (const [k, g] of nodes) g.classList.toggle('on', k === id); },
  };
  api.set(on);
  return api;
}

/* ---------------------------------------------------------- улицы */

export const STREETS = [
  { id: 'preflop', name: 'Префлоп', board: 0, text: 'Каждому раздают по две закрытые карты. Первый круг ставок.' },
  { id: 'flop', name: 'Флоп', board: 3, text: 'На стол — три общие карты, открытые всем. Второй круг ставок.' },
  { id: 'turn', name: 'Тёрн', board: 4, text: 'Четвёртая общая карта. Третий круг ставок.' },
  { id: 'river', name: 'Ривер', board: 5, text: 'Пятая, последняя общая карта. Последний круг ставок, потом вскрытие.' },
];

/** Лента из четырёх улиц; `on` — номер подсвеченной. */
export function streetsStrip(on = 0) {
  const items = STREETS.map((s, i) => h('div.ln-street', { 'data-i': i }, h('b', s.name), h('span', s.board ? `на столе ${s.board}` : 'карты в руке')));
  const api = { el: h('div.ln-streets', items), set(i) { items.forEach((el, k) => el.classList.toggle('on', k === i)); } };
  api.set(on);
  return api;
}

/* -------------------------------------------------- лесенка комбинаций */

export const COMBOS = [
  ['Флеш-рояль', 'A–K–Q–J–10 одной масти', 'AS KS QS JS 10S'],
  ['Стрит-флеш', 'пять подряд одной масти', '9H 8H 7H 6H 5H'],
  ['Каре', 'четыре одинаковых', 'QC QD QH QS 3D'],
  ['Фулл-хаус', 'тройка и пара', 'KH KD KS 7C 7H'],
  ['Флеш', 'пять одной масти', 'AD JD 8D 6D 2D'],
  ['Стрит', 'пять подряд', '10C 9D 8S 7H 6C'],
  ['Тройка', 'три одинаковых', '8S 8H 8D KC 4S'],
  ['Две пары', 'две разные пары', 'JH JC 5S 5D AH'],
  ['Пара', 'две одинаковых', '10S 10D AC 7H 3S'],
  ['Старшая карта', 'ничего не собрано', 'AH QC 9S 6D 3C'],
];

/** Лесенка: сверху сильная, снизу слабая. */
export function ladder() {
  return h('ol.ln-ladder', COMBOS.map(([name, what, codes], i) => h('li',
    h('span.ln-ladder-n', String(i + 1)),
    h('div.ln-ladder-txt', h('b', name), h('small', what)),
    cardsRow(codes, 'mini'))));
}

/* ------------------------------------------------- дерево решений */

/** Простое «дерево» ходов: два столбца «ставки не было» / «ставка есть». */
export function actionTree() {
  const col = (title, items) => h('div.ln-tree-col', h('div.ln-tree-head', title),
    items.map(([name, what]) => h('div.ln-tree-leaf', h('b', name), h('span', what))));
  return h('div.ln-tree',
    col('Ставки ещё не было', [['Check', 'пропустить ход бесплатно'], ['Bet', 'поставить первым']]),
    col('Соперник поставил', [['Fold', 'выйти, потеряв то, что уже в банке'], ['Call', 'уравнять'], ['Raise', 'поставить больше']]));
}

/* ----------------------------------------------- матрица 13×13 (схема) */

/**
 * Матрица стартовых рук для показа (не для нажатия — зоны нажатия 44 px тут нет,
 * поэтому это картинка, а выбор делается кнопками рядом). `pick(hand)` → true
 * подсвечивает клетку. Возвращает { el, set(pick) }.
 */
export function rangeMatrix(pick = () => false) {
  const cells = [];
  const grid = h('div.ln-matrix', { role: 'img', 'aria-label': 'Матрица стартовых рук 13 на 13' },
    h('span.ln-mh'),
    RANKS.map((r) => h('span.ln-mh', r)),
    RANKS.flatMap((r, i) => [
      h('span.ln-mh', r),
      ...RANKS.map((_, j) => {
        const hand = cellHand(i, j);
        const c = h(`span.ln-cell.k-${hand.kind}`);
        cells.push([c, hand]);
        return c;
      }),
    ]));
  const api = {
    el: grid,
    set(fn) { for (const [c, hand] of cells) c.classList.toggle('on', !!fn(hand)); },
  };
  api.set(pick);
  return api;
}

/* ------------------------------------------------------ колода ауты */

const SUIT_MARK = { S: '♠', H: '♥', D: '♦', C: '♣' };

/**
 * Вся колода четырьмя рядами по мастям. `known` — карты, которые вы видите (серые), `outs` —
 * карты, которые вам помогут (зелёные). Возвращает { el, set(known, outs) }.
 */
export function deckMap() {
  const SU = ['S', 'H', 'D', 'C'];
  const map = new Map();
  const rows = SU.map((s) => h('div.ln-deck-row',
    h(`span.ln-deck-suit.${s === 'H' || s === 'D' ? 'red' : 'blk'}`, SUIT_MARK[s]),
    RANKS.map((r) => { const c = h('span.ln-deck-card', r); map.set(rankCode(r) + s, c); return c; })));
  const api = {
    el: h('div.ln-deck', { role: 'img', 'aria-label': 'Колода: известные карты и ауты' }, rows),
    set(known = [], outs = []) {
      const k = new Set(known); const o = new Set(outs);
      for (const [code, el] of map) {
        el.classList.toggle('dead', k.has(code));
        el.classList.toggle('out', o.has(code));
      }
    },
  };
  return api;
}

/* -------------------------------------------------- прочее для схем */

/** Две колонки «вес»: стек и банк в виде полос, для SPR. */
export function sprBars() {
  const pot = h('div.ln-spr-fill.pot'); const stack = h('div.ln-spr-fill.stack');
  const api = {
    el: h('div.ln-spr', h('div.ln-spr-row', h('span', 'Банк'), h('div.ln-spr-track', pot)), h('div.ln-spr-row', h('span', 'Стек'), h('div.ln-spr-track', stack))),
    set(potV, stackV) {
      const m = Math.max(potV, stackV) || 1;
      pot.style.width = `${(potV / m) * 100}%`;
      stack.style.width = `${(stackV / m) * 100}%`;
    },
  };
  return api;
}

export { ALL_HANDS };
