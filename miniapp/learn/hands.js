/**
 * Чистая математика рук для уроков (без DOM): матрица 13×13, комбо, формула Чена,
 * текстура борда. Тесты (`bot/learn.facts.test.js`) сверяют это перебором.
 */

/** Ранги от старшего к младшему (так рисуется матрица). */
export const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
export const SUITS = ['S', 'H', 'D', 'C'];
/** Код картинки для ранга ('T' → '10'). */
export const rankCode = (r) => (r === 'T' ? '10' : r);
export const rankValue = (r) => 14 - RANKS.indexOf(r); // A=14 … 2=2

/**
 * Клетка матрицы (строка i, столбец j): i == j — пара, i < j — одномастные (выше диагонали),
 * i > j — разномастные (ниже). Старший ранг всегда первый.
 */
export function cellHand(i, j) {
  const hi = RANKS[Math.min(i, j)];
  const lo = RANKS[Math.max(i, j)];
  const kind = i === j ? 'p' : i < j ? 's' : 'o';
  return { hi, lo, kind, name: kind === 'p' ? hi + lo : hi + lo + kind, combos: kind === 'p' ? 6 : kind === 's' ? 4 : 12 };
}

/** Все 169 стартовых рук. */
export const ALL_HANDS = RANKS.flatMap((_, i) => RANKS.map((__, j) => cellHand(i, j)));

/** Сколько комбо всего в наборе клеток. */
export const comboSum = (hands) => hands.reduce((s, x) => s + x.combos, 0);

/**
 * Сколько комбо руки `hi``lo` (`kind`: p/s/o) остаётся, если карты из `dead` лежат у нас/на столе.
 * Перебирает масти — не формула, чтобы тест мог её сверить с формулой 6/4/12.
 */
export function combosLeft(hi, lo, kind, dead = []) {
  const out = new Set(dead);
  let n = 0;
  for (const s1 of SUITS) for (const s2 of SUITS) {
    if (hi === lo) { if (s1 >= s2) continue; } // пары: каждая пара мастей один раз
    else if (kind === 's' && s1 !== s2) continue;
    else if (kind === 'o' && s1 === s2) continue;
    if (out.has(hi + s1) || out.has(lo + s2)) continue;
    n += 1;
  }
  return n;
}

/**
 * Очки по формуле Чена (Билл Чен, «Mathematics of Poker») — известная простая оценка
 * стартовой руки. Это УЧЕБНЫЙ ориентир «насколько рука сильна», не солвер и не диапазон
 * открытия: используется только для подсветки схем.
 */
export function chen({ hi, lo, kind }) {
  const pts = (r) => ({ A: 10, K: 8, Q: 7, J: 6 }[r] ?? (r === 'T' ? 5 : Number(r) / 2));
  let s = pts(hi);
  if (kind === 'p') return Math.max(5, Math.ceil(s * 2));
  if (kind === 's') s += 2;
  const gap = rankValue(hi) - rankValue(lo) - 1;
  s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && rankValue(hi) < 12) s += 1; // обе карты ниже дамы и стоят рядом
  return Math.ceil(s);
}

/** Руки, у которых очки Чена не ниже порога. */
export const handsAtLeast = (min) => ALL_HANDS.filter((x) => chen(x) >= min);

/* ---------------------------------------------------------------- борд */

/** Разбор карты 'AS' / '10H' → { r: 'A'|…, v: 2…14, s: 'S' }. */
export function parseCode(code) {
  const s = code.slice(-1);
  const r = code.slice(0, -1) === '10' ? 'T' : code.slice(0, -1);
  return { r, v: rankValue(r), s };
}

/**
 * Текстура флопа/борда по трём простым признакам: масти (радуга / две / одна), пара на
 * столе, связность (ряд близких рангов). Возвращает { suits, paired, connected, wet, label }.
 */
export function boardTexture(codes) {
  const cs = codes.map(parseCode);
  const bySuit = {};
  for (const c of cs) bySuit[c.s] = (bySuit[c.s] || 0) + 1;
  const maxSuit = Math.max(...Object.values(bySuit));
  const suits = maxSuit >= 3 ? 'mono' : maxSuit === 2 ? 'two' : 'rainbow';
  const uniq = new Set(cs.map((c) => c.v));
  const paired = uniq.size < cs.length;
  const vals = [...uniq].sort((x, y) => x - y);
  if (uniq.has(14)) vals.unshift(1); // туз может быть младшим
  // связность: есть ли три карты в окне из 5 подряд идущих рангов
  let connected = false;
  for (let lo = 1; lo <= 10 && !connected; lo++) {
    if (vals.filter((v) => v >= lo && v <= lo + 4).length >= 3) connected = true;
  }
  const wet = suits !== 'rainbow' || connected;
  return {
    suits, paired, connected, wet,
    label: paired ? 'парный' : wet ? 'мокрый' : 'сухой',
  };
}
