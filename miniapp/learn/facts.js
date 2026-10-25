/**
 * Числа курса «Обучение». Ни одно число-вероятность не пишется в текст урока
 * руками: урок ссылается на факт — `{{fact:flushDrawByRiver|percent}}` — а
 * значение считается здесь. Тест `bot/learn.facts.test.js` пересчитывает
 * каждый факт НЕЗАВИСИМО (перебором колод, `bot/eval.js`) и сверяет.
 *
 * Чистый модуль: ни DOM, ни импортов — его читают и страница, и тесты.
 * Формулы берём из `miniapp/train/poker-math.js` (агент X): урок и упражнения
 * считают одним кодом, а тест сверяет его с совсем другим (`bot/eval.js`, перебор колод).
 */

import {
  binom, hitProbability, requiredEquity, evCall as evCallMath, evBet, mdf, bluffShare, breakEvenFold, spr, equity, parseCards,
} from '../train/poker-math.js';

/** Шанс поймать хотя бы один из `outs` аутов за `draws` карт из `unseen` неизвестных. */
export const hitChance = (outs, draws, unseen) => hitProbability(outs, unseen, draws);
export { binom as comb, requiredEquity, evBet, mdf, bluffShare, spr };
export const bluffBreakeven = breakEvenFold;

/** Нужное эквити для колла: `toCall` / (банк, где уже лежит ставка соперника, + `toCall`). */
export const needEquity = (potNow, toCall) => toCall / (potNow + toCall);

/** Ожидаемый выигрыш колла: банк `pot` (без ставки), ставка соперника `bet`, эквити `eq`. */
export const evCall = (pot, bet, eq) => evCallMath(eq, pot, bet);

/** Эквити «рука против руки» на флопе — точный перебор тёрна и ривера (990 раскладок). */
const duel = (hero, villain, flop) => equity(parseCards(hero), parseCards(flop), parseCards(villain), { exact: true }).equity;
const comb = binom;

/* Значение факта — функция без аргументов. kind: 'p' вероятность (0…1), 'n' число. */
const F = {
  // --- комбо ---
  startHandCombos: { kind: 'n', v: () => comb(52, 2) },
  pairCombos: { kind: 'n', v: () => comb(4, 2) },
  suitedCombos: { kind: 'n', v: () => 4 },
  offsuitCombos: { kind: 'n', v: () => 12 },
  anyTwoRanksCombos: { kind: 'n', v: () => 16 },
  aaCombosBlocked: { kind: 'n', v: () => comb(3, 2) },
  akCombosBlocked: { kind: 'n', v: () => 12 },
  pocketPairChance: { kind: 'p', v: () => (13 * comb(4, 2)) / comb(52, 2) },
  acesChance: { kind: 'p', v: () => comb(4, 2) / comb(52, 2) },
  suitedChance: { kind: 'p', v: () => (78 * 4) / comb(52, 2) },
  // --- комбинации из пяти карт (всего 2.598.960 рук) ---
  straightFiveCard: { kind: 'p', v: () => (10 * (4 ** 5 - 4)) / comb(52, 5) },
  flushFiveCard: { kind: 'p', v: () => (4 * (comb(13, 5) - 10)) / comb(52, 5) },
  // --- ауты и дро: 47 неизвестных после флопа, 46 после тёрна ---
  setOnFlop: { kind: 'p', v: () => hitChance(2, 3, 50) },
  flushDrawNext: { kind: 'p', v: () => 9 / 47 },
  flushDrawByRiver: { kind: 'p', v: () => hitChance(9, 2, 47) },
  flushDrawTurnToRiver: { kind: 'p', v: () => 9 / 46 },
  oesdByRiver: { kind: 'p', v: () => hitChance(8, 2, 47) },
  gutshotByRiver: { kind: 'p', v: () => hitChance(4, 2, 47) },
  overcardsByRiver: { kind: 'p', v: () => hitChance(6, 2, 47) },
  comboDrawByRiver: { kind: 'p', v: () => hitChance(15, 2, 47) },
  flushDrawRule4: { kind: 'p', v: () => 9 * 4 / 100 },
  flushDrawRule2: { kind: 'p', v: () => 9 * 2 / 100 },
  flushDrawRule4Error: { kind: 'p', v: () => Math.abs(9 * 4 / 100 - hitChance(9, 2, 47)) },
  bigDrawRule4: { kind: 'p', v: () => 15 * 4 / 100 },
  // --- шансы банка ---
  potOddsHalf: { kind: 'p', v: () => requiredEquity(100, 50) },
  potOddsPot: { kind: 'p', v: () => requiredEquity(100, 100) },
  potOddsQuarter: { kind: 'p', v: () => requiredEquity(100, 25) },
  bbCallNeed: { kind: 'p', v: () => needEquity(4.5, 2) },
  impliedNeed: { kind: 'p', v: () => 50 / (100 + 50 + 50 + 100) },
  // --- ожидаемый выигрыш ---
  evCallGood: { kind: 'n', v: () => evCall(100, 50, 0.35) },
  evCallBad: { kind: 'n', v: () => evCall(100, 50, 0.2) },
  pureBluffEv: { kind: 'n', v: () => evBet(100, 100, 0.4, 0) },
  semiBluffEv: { kind: 'n', v: () => evBet(100, 100, 0.4, 0.35) },
  // --- безубыточный блеф, защита и баланс ---
  bluffBreakevenPot: { kind: 'p', v: () => bluffBreakeven(100, 100) },
  bluffBreakevenHalf: { kind: 'p', v: () => bluffBreakeven(100, 50) },
  mdfHalf: { kind: 'p', v: () => mdf(100, 50) },
  mdfPot: { kind: 'p', v: () => mdf(100, 100) },
  mdfDouble: { kind: 'p', v: () => mdf(100, 200) },
  bluffShareHalf: { kind: 'p', v: () => bluffShare(100, 50) },
  bluffSharePot: { kind: 'p', v: () => bluffShare(100, 100) },
  rpsEven: { kind: 'p', v: () => 1 / 3 },
  // --- эквити «рука против руки» (перебор) ---
  flushDrawVsTopPair: { kind: 'p', v: () => duel('9h 8h', 'Ac Kd', 'Ah 4h 2c') },
  pairVsFlushDraw: { kind: 'p', v: () => duel('Ks Kd', '9h 8h', 'Ah 4h 2c') },
};

export const FACT_IDS = Object.keys(F);

export function fact(id) {
  const f = F[id];
  if (!f) throw new Error(`нет факта «${id}»`);
  return f.v();
}

const fmtNum = (v, digits = 0) => {
  const r = Number(v.toFixed(digits));
  const [int, frac] = Math.abs(r).toFixed(digits).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (r < 0 ? '−' : '') + grouped + (frac ? `,${frac}` : '');
};

/** Форматы подстановки: percent — 35%, percent1 — 34,9%, percent2 — 0,45%, int, num1, ratio — «1 к 7». */
export const FORMATS = {
  percent: (v) => `${fmtNum(v * 100)}%`,
  percent1: (v) => `${fmtNum(v * 100, 1)}%`,
  percent2: (v) => `${fmtNum(v * 100, 2)}%`,
  int: (v) => fmtNum(v),
  num1: (v) => fmtNum(v, 1),
  signed: (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmtNum(Math.abs(v)),
  ratio: (v) => `1 к ${fmtNum(1 / v - 1)}`,
};

export const FACT_REF = /\{\{fact:([A-Za-z0-9]+)\|([a-z0-9]+)\}\}/g;

/** Значение факта в нужном формате. */
export function factText(id, format = 'percent') {
  const fn = FORMATS[format];
  if (!fn) throw new Error(`нет формата «${format}»`);
  return fn(fact(id));
}

/** `{{in:35%}}` — число из условия сценария («при шансе 35%»), а не расчётный факт; в тексте остаётся как есть. */
export const INPUT_REF = /\{\{in:([^}]+)\}\}/g;

/** Подставить все `{{fact:id|формат}}` и `{{in:…}}` в строке. */
export const fillFacts = (text) => String(text)
  .replace(FACT_REF, (_, id, format) => factText(id, format))
  .replace(INPUT_REF, (_, v) => v);

/** Все ссылки на факты в строке: [{id, format}]. */
export function factRefs(text) {
  return [...String(text).matchAll(FACT_REF)].map((m) => ({ id: m[1], format: m[2] }));
}
