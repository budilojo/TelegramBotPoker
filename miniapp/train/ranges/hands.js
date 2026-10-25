/**
 * 169 стартовых рук Техасского холдема: коды, положение в матрице 13×13,
 * число комбинаций, процент диапазона, разбор и запись строки вида
 * «77+, ATs+, KQo», сравнение диапазонов по КОМБИНАЦИЯМ и блокеры.
 *
 * Чистый модуль (никакого DOM и импортов) — его читают клиент, тесты и скрипт
 * сборки данных. Агент W, волна 3 (docs/next-wave-3/agent-W-ranges.md).
 *
 * Код руки: «AA» (пара), «AKs» (одной масти), «AKo» (разных мастей). Старшая
 * карта всегда первая. Матрица — стандарт: ряды и столбцы A…2, пары по
 * диагонали, одномастные выше диагонали, разномастные ниже.
 *
 * Карта — число 0…51, как в bot/deck.js: ранг*4 + масть, ранг 0…12 = 2…A,
 * масть 0…3 = ♠♥♦♣.
 */

/** Ранги от старшего к младшему: индекс 0 = туз. Он же номер ряда/столбца матрицы. */
export const RANK_CHARS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
export const SUIT_CHARS = ['♠', '♥', '♦', '♣'];
const SUIT_LETTERS = ['s', 'h', 'd', 'c'];

/** Полное число комбинаций колоды из двух карт. */
export const TOTAL_COMBOS = 1326;

/** Код руки в клетке (ряд, столбец). Выше диагонали — одномастные. */
export function handAt(row, col) {
  if (row === col) return RANK_CHARS[row] + RANK_CHARS[col];
  if (row < col) return RANK_CHARS[row] + RANK_CHARS[col] + 's';
  return RANK_CHARS[col] + RANK_CHARS[row] + 'o';
}

/** Все 169 кодов в порядке матрицы (ряд за рядом). */
export const ALL_HANDS = [];
for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) ALL_HANDS.push(handAt(r, c));

const INFO = new Map();
ALL_HANDS.forEach((code, i) => {
  const row = Math.floor(i / 13);
  const col = i % 13;
  const kind = row === col ? 'pair' : row < col ? 'suited' : 'offsuit';
  // hi — индекс старшей карты (0 = туз), lo — младшей
  INFO.set(code, { code, row, col, kind, hi: Math.min(row, col), lo: Math.max(row, col), combos: kind === 'pair' ? 6 : kind === 'suited' ? 4 : 12 });
});

export const isHand = (code) => INFO.has(code);
export const handInfo = (code) => INFO.get(code) || null;
/** Положение руки в матрице: { row, col }. */
export const cellOf = (code) => { const i = INFO.get(code); return i ? { row: i.row, col: i.col } : null; };
/** Число комбинаций: 6 / 4 / 12. */
export const combosOf = (code) => (INFO.get(code) ? INFO.get(code).combos : 0);

/** Ранг (0 = туз … 12 = двойка) → число-ранг колоды (12 = туз … 0 = двойка). */
const deckRank = (idx) => 12 - idx;

/** Конкретные комбинации руки как пары карт-чисел. */
export function handCombos(code) {
  const i = INFO.get(code);
  if (!i) return [];
  const a = deckRank(i.hi);
  const b = deckRank(i.lo);
  const out = [];
  if (i.kind === 'pair') {
    for (let s1 = 0; s1 < 4; s1++) for (let s2 = s1 + 1; s2 < 4; s2++) out.push([a * 4 + s1, a * 4 + s2]);
  } else if (i.kind === 'suited') {
    for (let s = 0; s < 4; s++) out.push([a * 4 + s, b * 4 + s]);
  } else {
    for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) if (s1 !== s2) out.push([a * 4 + s1, b * 4 + s2]);
  }
  return out;
}

/** Код руки по двум картам-числам. */
export function handOfCards(c1, c2) {
  let a = c1 >> 2;
  let b = c2 >> 2;
  const same = (c1 & 3) === (c2 & 3);
  if (a < b) [a, b] = [b, a];
  const ra = 12 - a;
  const rb = 12 - b;
  if (a === b) return RANK_CHARS[ra] + RANK_CHARS[rb];
  return RANK_CHARS[ra] + RANK_CHARS[rb] + (same ? 's' : 'o');
}

/** «A♠» из числа-карты. */
export const cardLabel = (c) => RANK_CHARS[12 - (c >> 2)] + SUIT_CHARS[c & 3];
/** Число-карта из «As», «Td», «7c» (буква масти латиницей) — для тестов и условий. */
export function parseCard(s) {
  const r = RANK_CHARS.indexOf(String(s)[0]);
  const su = SUIT_LETTERS.indexOf(String(s)[1]);
  if (r < 0 || su < 0) return -1;
  return deckRank(r) * 4 + su;
}

/**
 * Сколько комбинаций руки осталось у соперника, если часть карт «мертва»
 * (лежит у нас на руках или на борде). Блокеры: на руке туз — у соперника
 * пара тузов не 6 комбо, а 3… а при двух тузах на руках — одна.
 * `dead` — массив карт-чисел.
 */
export function combosGiven(code, dead = []) {
  const d = new Set(dead);
  let n = 0;
  for (const [x, y] of handCombos(code)) if (!d.has(x) && !d.has(y)) n++;
  return n;
}

/* ------------------------------------------------------- наборы и вес */

/**
 * Набор рук — это `Set` кодов (все руки с весом 1) или `Map` код → частота
 * 0…1 (смешанные стратегии). Функции ниже принимают оба вида.
 */
export function freqOf(set, code) {
  if (!set) return 0;
  if (set instanceof Map) return set.get(code) || 0;
  return set.has(code) ? 1 : 0;
}
const codesOf = (set) => (set instanceof Map ? [...set.keys()].filter((k) => set.get(k) > 0) : [...set]);

/** Число комбинаций набора (с учётом частот: пара тузов на 50 % — это 3). */
export function comboCount(set) {
  let n = 0;
  for (const code of codesOf(set)) n += combosOf(code) * freqOf(set, code);
  return n;
}

/** Доля от всех 1326 комбинаций, 0…1. */
export const rangeShare = (set) => comboCount(set) / TOTAL_COMBOS;
/** Процент диапазона (0…100) с одним знаком. */
export const rangePercent = (set) => Math.round(rangeShare(set) * 1000) / 10;

/* -------------------------------------------------------- строка ↔ набор */

export class RangeSyntaxError extends Error {
  constructor(message, token) {
    super(message);
    this.name = 'RangeSyntaxError';
    this.token = token;
  }
}

const rankIdx = (ch) => RANK_CHARS.indexOf(ch);
const SEP = /[\s,;]+/;

function oneToken(tok) {
  const m = /^([AKQJT98765432])([AKQJT98765432])([so]?)(\+?)$/i.exec(tok);
  if (!m) return null;
  return { a: rankIdx(m[1].toUpperCase()), b: rankIdx(m[2].toUpperCase()), suf: m[3].toLowerCase(), plus: m[4] === '+' };
}

function handsFor(a, b, suf, tok) {
  // a, b — индексы рангов (0 = туз); приводим к старший-первый
  if (a === b) {
    if (suf) throw new RangeSyntaxError(`У пары «${tok}» не бывает «s» или «o»: пара — всегда разных мастей.`, tok);
    return [RANK_CHARS[a] + RANK_CHARS[a]];
  }
  const hi = Math.min(a, b);
  const lo = Math.max(a, b);
  const base = RANK_CHARS[hi] + RANK_CHARS[lo];
  if (suf === 's') return [base + 's'];
  if (suf === 'o') return [base + 'o'];
  return [base + 's', base + 'o'];
}

/**
 * Разбор строки: «77+, ATs+, KQo», «JJ-88», «A5s-A2s», «T9s-65s», «AK».
 * Плюс у пары — вверх до тузов; у непарной руки — старшая карта та же,
 * младшая растёт до «на одну ниже старшей» (ATs+ = ATs, AJs, AQs, AKs).
 * Тире: диапазон пар (JJ-88), кикеров при одной старшей (A5s-A2s) или
 * «лесенка» одинакового зазора (T9s-65s). Запятая, пробел и «;» — разделители.
 * Неверный ввод — `RangeSyntaxError` с понятным русским текстом.
 */
export function parseRange(text) {
  const set = new Set();
  const src = String(text ?? '').trim();
  if (!src) return set;
  for (const raw of src.split(SEP).filter(Boolean)) {
    const tok = raw.trim();
    if (tok.includes('-')) {
      const parts = tok.split('-');
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new RangeSyntaxError(`«${tok}» — после тире нужна вторая рука, например «A5s-A2s».`, tok);
      const x = oneToken(parts[0]);
      const y = oneToken(parts[1]);
      if (!x || !y || x.plus || y.plus) throw new RangeSyntaxError(`Не понимаю «${tok}». Пример диапазона: «JJ-88» или «A5s-A2s».`, tok);
      if (x.suf !== y.suf) throw new RangeSyntaxError(`В «${tok}» у концов разная масть (s/o): напишите «s» или «o» одинаково у обоих.`, tok);
      const xPair = x.a === x.b;
      const yPair = y.a === y.b;
      if (xPair !== yPair) throw new RangeSyntaxError(`«${tok}»: нельзя смешивать пары и непарные руки.`, tok);
      if (xPair) {
        const from = Math.min(x.a, y.a);
        const to = Math.max(x.a, y.a);
        for (let r = from; r <= to; r++) set.add(RANK_CHARS[r] + RANK_CHARS[r]);
        continue;
      }
      const xh = Math.min(x.a, x.b);
      const xl = Math.max(x.a, x.b);
      const yh = Math.min(y.a, y.b);
      const yl = Math.max(y.a, y.b);
      if (xh === yh) {
        for (let l = Math.min(xl, yl); l <= Math.max(xl, yl); l++) for (const h of handsFor(xh, l, x.suf, tok)) set.add(h);
      } else if (xl - xh === yl - yh) {
        const gap = xl - xh;
        for (let h = Math.min(xh, yh); h <= Math.max(xh, yh); h++) for (const c of handsFor(h, h + gap, x.suf, tok)) set.add(c);
      } else {
        throw new RangeSyntaxError(`«${tok}»: у концов должна быть одна старшая карта (A5s-A2s) или одинаковый зазор (T9s-65s).`, tok);
      }
      continue;
    }
    const t = oneToken(tok);
    if (!t) throw new RangeSyntaxError(`Не понимаю «${tok}». Руки пишут так: AA, AKs, KQo, 77+, ATs+.`, tok);
    if (t.a === t.b) {
      if (t.suf) throw new RangeSyntaxError(`У пары «${tok}» не бывает «s» или «o».`, tok);
      if (t.plus) for (let r = 0; r <= t.a; r++) set.add(RANK_CHARS[r] + RANK_CHARS[r]);
      else set.add(RANK_CHARS[t.a] + RANK_CHARS[t.a]);
      continue;
    }
    const hi = Math.min(t.a, t.b);
    const lo = Math.max(t.a, t.b);
    if (t.plus) {
      for (let l = lo; l > hi; l--) for (const h of handsFor(hi, l, t.suf, tok)) set.add(h);
    } else {
      for (const h of handsFor(hi, lo, t.suf, tok)) set.add(h);
    }
  }
  return set;
}

/** То же без исключения: { ok: true, set } или { ok: false, error }. */
export function tryParseRange(text) {
  try {
    return { ok: true, set: parseRange(text) };
  } catch (e) {
    if (e instanceof RangeSyntaxError) return { ok: false, error: e.message };
    throw e;
  }
}

const KIND_ORDER = ['suited', 'offsuit'];

/** Набор → короткая строка. parseRange(formatRange(s)) даёт тот же набор. */
export function formatRange(setLike) {
  const set = new Set(codesOf(setLike));
  const out = [];
  // пары: серии подряд
  const pairs = [];
  for (let r = 0; r < 13; r++) if (set.has(RANK_CHARS[r] + RANK_CHARS[r])) pairs.push(r);
  for (const run of runs(pairs)) {
    const [from, to] = [run[0], run[run.length - 1]]; // from старше (меньше индекс)
    const P = (i) => RANK_CHARS[i] + RANK_CHARS[i];
    if (run.length === 1) out.push(P(from));
    else if (from === 0) out.push(`${P(to)}+`);
    else out.push(`${P(from)}-${P(to)}`);
  }
  for (let hi = 0; hi < 12; hi++) {
    for (const kind of KIND_ORDER) {
      const suf = kind === 'suited' ? 's' : 'o';
      const los = [];
      for (let lo = hi + 1; lo < 13; lo++) if (set.has(RANK_CHARS[hi] + RANK_CHARS[lo] + suf)) los.push(lo);
      for (const run of runs(los)) {
        const name = (l) => RANK_CHARS[hi] + RANK_CHARS[l] + suf;
        const first = run[0]; // старший кикер
        const last = run[run.length - 1];
        if (run.length === 1) out.push(name(first));
        else if (first === hi + 1) out.push(`${name(last)}+`);
        else out.push(`${name(first)}-${name(last)}`);
      }
    }
  }
  return out.join(', ');
}

/** Серии подряд идущих чисел (массив по возрастанию). */
function runs(arr) {
  const res = [];
  let cur = [];
  for (const v of arr) {
    if (cur.length && v === cur[cur.length - 1] + 1) cur.push(v);
    else { if (cur.length) res.push(cur); cur = [v]; }
  }
  if (cur.length) res.push(cur);
  return res;
}

/* ----------------------------------------------------------- сравнение */

/**
 * Сравнение набора игрока с эталоном (оба — Set или Map частот).
 * Возвращает:
 *  - missed — есть в эталоне, у игрока нет;
 *  - extra — у игрока есть, в эталоне нет;
 *  - off — есть и там и там, но частоты расходятся на 0,25 и более
 *    ({ hand, user, ref });
 *  - ok — совпавшие;
 *  - commonCombos / missedCombos / extraCombos — в комбинациях (с частотами);
 *  - match — доля совпадения по КОМБИНАЦИЯМ (пересечение / объединение), 0…1.
 *    Пара тузов весит 6, KQo — 12, а не по клетке.
 */
export function diff(user, ref) {
  const missed = [];
  const extra = [];
  const off = [];
  const ok = [];
  let inter = 0;
  let union = 0;
  let missedCombos = 0;
  let extraCombos = 0;
  for (const code of ALL_HANDS) {
    const u = freqOf(user, code);
    const r = freqOf(ref, code);
    const n = combosOf(code);
    inter += n * Math.min(u, r);
    union += n * Math.max(u, r);
    if (r > 0 && u === 0) { missed.push(code); missedCombos += n * r; }
    else if (u > 0 && r === 0) { extra.push(code); extraCombos += n * u; }
    else if (u > 0 && r > 0) {
      if (Math.abs(u - r) >= 0.25) { off.push({ hand: code, user: u, ref: r }); missedCombos += n * Math.max(0, r - u); extraCombos += n * Math.max(0, u - r); }
      else ok.push(code);
    }
  }
  return { missed, extra, off, ok, commonCombos: inter, missedCombos, extraCombos, match: union === 0 ? 1 : inter / union };
}
