/**
 * Учебные ориентиры префлопа: порядок рук и диапазоны по позициям (6-max,
 * стеки ≈ 100 BB). ЧЕСТНО: это НЕ солвер и не «настоящие GTO-диапазоны».
 *
 * Откуда:
 *  1. ПОРЯДОК 169 рук — очки формулы Билла Чена (открытая эвристика:
 *     старшая карта, пара, масть, зазор) плюс небольшая поправка за эквити
 *     против случайной руки и +0,5 очка парам (они играются на сет) — ключ ORDER_KEY (equity169.js, считает tools/build-range-data.mjs).
 *     Формула учитывает то, чего не видит чистое эквити: одномастные и
 *     связанные руки играются лучше, чем их шанс «против случайной».
 *  2. ПОРОГИ — доли от 1326 комбинаций («открываем с UTG ≈ 15 % рук»). Это
 *     общеупотребительные округлённые ориентиры для 6-max, а не таблица
 *     какого-либо сайта: мы взяли идею «чем позже позиция, тем шире» и
 *     круглые проценты, диапазоны построили сами как «верхушка порядка».
 *  3. Поэтому диапазоны ВЛОЖЕНЫ: UTG ⊂ MP ⊂ CO ⊂ BTN (по построению).
 *
 * Каждый набор несёт метаданные { scenario, position, source, approx: true }.
 * Настоящие GTO-диапазоны — это платные данные солвера; в приложение их
 * положить нельзя без источника и лицензии.
 */
import { ALL_HANDS, combosOf, handInfo, TOTAL_COMBOS } from './hands.js';
import { EQUITY169 } from './equity169.js';

export const SOURCE = 'Учебный ориентир: порядок рук по формуле Чена и эквити, пороги — округлённые проценты для 6-max, 100 BB. Не солвер.';
export const STACK_BB = 100;
export const POSITIONS = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
export const POSITION_NAMES = {
  UTG: 'UTG (первый за столом)',
  MP: 'MP (средняя позиция)',
  CO: 'CO (за одну до кнопки)',
  BTN: 'BTN (кнопка)',
  SB: 'SB (малый блайнд)',
  BB: 'BB (большой блайнд)',
};

const HI_POINTS = { A: 10, K: 8, Q: 7, J: 6, T: 5, 9: 4.5, 8: 4, 7: 3.5, 6: 3, 5: 2.5, 4: 2, 3: 1.5, 2: 1 };

/** Очки руки по формуле Чена (округление вверх до целого). */
export function chenScore(code) {
  const i = handInfo(code);
  const a = code[0];
  const b = code[1];
  let pts = HI_POINTS[a];
  if (i.kind === 'pair') return Math.max(5, Math.ceil(pts * 2));
  if (i.kind === 'suited') pts += 2;
  const gap = i.lo - i.hi - 1;
  pts -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && i.hi >= 3) pts += 1; // обе карты ниже дамы
  void b;
  return Math.ceil(pts);
}

/** Те же очки без округления (для порядка рук). */
function chenRaw(code) {
  const i = handInfo(code);
  let pts = HI_POINTS[code[0]];
  if (i.kind === 'pair') return Math.max(5, pts * 2);
  if (i.kind === 'suited') pts += 2;
  const gap = i.lo - i.hi - 1;
  pts -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && i.hi >= 3) pts += 1;
  return pts;
}

/** Ключ порядка: очки Чена + поправка за эквити против случайной руки (4 очка на 100 п.п.). */
export const ORDER_KEY = (code) => chenRaw(code) + 4 * (EQUITY169[code] - 0.5) + (handInfo(code).kind === 'pair' ? 0.5 : 0);

/** Все 169 рук от сильной к слабой: очки Чена, затем эквити, затем код (детерминировано). */
export const ORDER = [...ALL_HANDS].sort((x, y) => ORDER_KEY(y) - ORDER_KEY(x) || (x < y ? -1 : 1));
export const ORDER_INDEX = new Map(ORDER.map((c, i) => [c, i]));

/** Середина руки в порядке, в % от 1326 (для порогов и «пограничных» рук). */
const MID = new Map();
{
  let cum = 0;
  for (const c of ORDER) {
    MID.set(c, ((cum + combosOf(c) / 2) / TOTAL_COMBOS) * 100);
    cum += combosOf(c);
  }
}
export const midPercent = (code) => MID.get(code);

/** «Верхушка» порядка: руки, чья середина не дальше `pct` % от начала. */
export function topShare(pct) {
  const s = new Set();
  for (const c of ORDER) if (MID.get(c) <= pct) s.add(c);
  return s;
}

/** Топ-N % для кнопки «Топ 10 %» и тому подобного. */
export const presetTop = topShare;

/* --------------------------------------------------------------- пороги */

export const OPEN_PCT = { UTG: 15, MP: 19, CO: 27, BTN: 45, SB: 40 };
/** Защита большого блайнда от открытия: всего продолжаем / из них 3-бет. */
export const BB_DEFEND = { UTG: { total: 25, threebet: 4 }, MP: { total: 28, threebet: 5 }, CO: { total: 33, threebet: 6 }, BTN: { total: 45, threebet: 8 }, SB: { total: 50, threebet: 10 } };
/** Против открытия, когда мы не в блайндах (позже по кругу): 3-бет / всего. */
export const VS_OPEN = { UTG: { threebet: 3, total: 8 }, MP: { threebet: 4, total: 10 }, CO: { threebet: 5, total: 13 }, BTN: { threebet: 7, total: 17 } };
/** Против 3-бета, когда мы открывали: 4-бет / всего (остальное — колл). */
export const VS_3BET = { UTG: { fourbet: 2.5, total: 7 }, MP: { fourbet: 2.7, total: 8 }, CO: { fourbet: 3, total: 10 }, BTN: { fourbet: 4, total: 14 }, SB: { fourbet: 4, total: 12 } };
/** Полублеф-3-беты: одномастные тузы-«колёсики» (блокируют туза, есть шанс на стрит-флеш). */
const BLUFF_3BET = ['A5s', 'A4s'];
/** Рейз-размеры открытия (в BB) — учебное правило порядка. */
export const OPEN_SIZE = { UTG: 2.5, MP: 2.5, CO: 2.5, BTN: 2.5, SB: 3 };
/** Полуширина полосы «иногда» вокруг границы, в п.п. от 1326. */
export const MIX_BAND = 1.5;
/** «Пограничные» руки — на них штраф за ошибку меньше. */
export const BORDER_BAND = 3;

const meta = (scenario, position, extra = {}) => ({ scenario, position, source: SOURCE, approx: true, stackBB: STACK_BB, ...extra });

/** Диапазон открытия рейзом (как множество); метаданные — в `.meta`. */
export function openRange(pos) {
  const pct = OPEN_PCT[pos];
  if (pct == null) throw new Error(`openRange: нет позиции «${pos}»`);
  const s = topShare(pct);
  s.meta = meta('open', pos, { pct });
  return s;
}

/** Защита BB/SB или позиции против открытия: { threebet, call, meta }. */
export function defendRange(hero, opener) {
  if (POSITIONS.indexOf(hero) <= POSITIONS.indexOf(opener) || POSITIONS.indexOf(opener) < 0) throw new Error(`defendRange: ${hero} ходит не после ${opener}`);
  let t;
  let total;
  if (hero === 'BB') ({ threebet: t, total } = BB_DEFEND[opener] || {});
  else if (hero === 'SB') { const v = VS_OPEN[opener]; if (v) { t = v.threebet + 3; total = t; } else if (opener === 'BTN') { t = 10; total = 10; } }
  else ({ threebet: t, total } = VS_OPEN[opener] || {});
  if (t == null) throw new Error(`defendRange: нет сценария ${hero} против ${opener}`);
  const threebet = topShare(t);
  const cont = topShare(total);
  const call = new Set([...cont].filter((c) => !threebet.has(c)));
  if (['CO', 'BTN', 'SB'].includes(opener)) {
    for (const b of BLUFF_3BET) { call.delete(b); threebet.add(b); }
  }
  return { threebet, call, meta: meta('defend', hero, { opener, threebetPct: t, totalPct: total }) };
}

/** Против 3-бета после нашего открытия с `hero`: { fourbet, call }. */
export function vs3betRange(hero) {
  const v = VS_3BET[hero];
  if (!v) throw new Error(`vs3betRange: нет позиции «${hero}»`);
  const fourbet = topShare(v.fourbet);
  const cont = topShare(v.total);
  const call = new Set([...cont].filter((c) => !fourbet.has(c)));
  return { fourbet, call, meta: meta('vs3bet', hero, { fourbetPct: v.fourbet, totalPct: v.total }) };
}

/**
 * Слоёная стратегия «действие по порядку»: на каждую руку — частоты действий
 * (сумма 1). Руки в пределах MIX_BAND от границы делятся пополам между двумя
 * соседними действиями: «иногда колл, иногда 3-бет». `layers` — список
 * { action, upTo } по возрастанию upTo (в %), остальное — `rest`.
 */
export function layeredFreq(layers, rest = 'fold') {
  const out = new Map();
  for (const c of ORDER) {
    const mid = MID.get(c);
    const names = [...layers.map((l) => l.action), rest];
    let idx = layers.findIndex((l) => mid <= l.upTo);
    if (idx < 0) idx = layers.length;
    const f = Object.fromEntries(names.map((n) => [n, 0]));
    f[names[idx]] = 1;
    // у границы между idx-1 и idx / idx и idx+1
    const edgeUp = idx < layers.length ? layers[idx].upTo : null; // граница сверху
    const edgeDown = idx > 0 ? layers[idx - 1].upTo : null;
    if (edgeUp != null && edgeUp - mid < MIX_BAND) { f[names[idx]] = 0.5; f[names[idx + 1]] += 0.5; }
    else if (edgeDown != null && mid - edgeDown < MIX_BAND) { f[names[idx]] = 0.5; f[names[idx - 1]] += 0.5; }
    out.set(c, f);
  }
  return out;
}

/** Открытие с частотами: у границы руки открываются «иногда» (0.5). Map код → частота. */
export function openMixed(pos) {
  const lf = layeredFreq([{ action: 'raise', upTo: OPEN_PCT[pos] }]);
  const m = new Map();
  for (const [c, f] of lf) if (f.raise > 0) m.set(c, f.raise);
  return m;
}

/** Руки, лежащие у границы (±BORDER_BAND п.п.) любого из порогов — «спорные». */
export function borderHands(thresholds) {
  const s = new Set();
  for (const c of ORDER) for (const t of thresholds) if (Math.abs(MID.get(c) - t) <= BORDER_BAND) s.add(c);
  return s;
}

/** Правильное действие по слоям: самое частое. Ничья — более агрессивное (первое). */
export function mainAction(freqs) {
  let best = null;
  for (const [a, f] of Object.entries(freqs)) if (best == null || f > freqs[best]) best = a;
  return best;
}

/* ------------------------------------------------ объяснения (по правилам) */

const NAMES = { A: 'туз', K: 'король', Q: 'дама', J: 'валет', T: 'десятка', 9: 'девятка', 8: 'восьмёрка', 7: 'семёрка', 6: 'шестёрка', 5: 'пятёрка', 4: 'четвёрка', 3: 'тройка', 2: 'двойка' };
const NAMES_PL = { A: 'тузов', K: 'королей', Q: 'дам', J: 'валетов', T: 'десяток', 9: 'девяток', 8: 'восьмёрок', 7: 'семёрок', 6: 'шестёрок', 5: 'пятёрок', 4: 'четвёрок', 3: 'троек', 2: 'двоек' };

/** Название руки по-русски: «пара тузов», «туз-король одной масти». */
export function handName(code) {
  const i = handInfo(code);
  if (i.kind === 'pair') return `пара ${NAMES_PL[code[0]]}`;
  return `${NAMES[code[0]]}-${NAMES[code[1]]} ${i.kind === 'suited' ? 'одной масти' : 'разных мастей'}`;
}

/**
 * Класс руки для разбора: { cls, label, topic }. Классы — по простым правилам
 * («слабый туз без масти»), а не по солверу.
 */
export function classify(code) {
  const i = handInfo(code);
  const hi = i.hi;
  const lo = i.lo;
  const gap = lo - hi - 1;
  if (i.kind === 'pair') {
    if (hi <= 3) return { cls: 'pair-high', label: 'старшая пара', topic: 'starting-hands' };
    if (hi <= 7) return { cls: 'pair-mid', label: 'средняя пара', topic: 'starting-hands' };
    return { cls: 'pair-low', label: 'малая пара (играется на сет)', topic: 'starting-hands' };
  }
  if (hi === 0 && i.kind === 'suited') return lo <= 3 ? { cls: 'ace-suited-high', label: 'туз с высокой картой одной масти', topic: 'starting-hands' } : { cls: 'ace-suited-low', label: 'туз с малой картой одной масти (запас на флеш)', topic: 'starting-hands' };
  if (hi === 0) return lo <= 4 ? { cls: 'ace-offsuit-high', label: 'сильный туз разных мастей', topic: 'starting-hands' } : { cls: 'ace-offsuit-weak', label: 'слабый туз разных мастей — часто доминируется', topic: 'starting-hands' };
  if (lo <= 4) return { cls: i.kind === 'suited' ? 'broadway-suited' : 'broadway-offsuit', label: i.kind === 'suited' ? 'две старшие карты одной масти' : 'две старшие карты разных мастей', topic: 'starting-hands' };
  if (i.kind === 'suited' && gap <= 1) return { cls: 'suited-connector', label: 'одномастный коннектор (стрит и флеш)', topic: 'starting-hands' };
  if (i.kind === 'suited' && gap <= 3) return { cls: 'suited-gapper', label: 'одномастная рука с зазором', topic: 'starting-hands' };
  if (i.kind === 'suited') return { cls: 'suited-trash', label: 'слабая одномастная рука', topic: 'starting-hands' };
  if (gap <= 1 && lo <= 8) return { cls: 'offsuit-connector', label: 'разномастный коннектор', topic: 'starting-hands' };
  return { cls: 'offsuit-trash', label: 'слабая разномастная рука', topic: 'starting-hands' };
}

/**
 * Вес руки при оценке ошибки: пограничные (рядом с порогом) весят 0,35,
 * остальные — 1. Грубая ошибка на очевидной руке штрафуется сильнее.
 */
export function weightMap(thresholds) {
  const b = borderHands(thresholds);
  return (code) => (b.has(code) ? 0.35 : 1);
}
