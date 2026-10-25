/**
 * Общие части упражнений агента W: оценка набора, разбор с числами,
 * выбор руки под условие, случайные карты. Чистый модуль, без DOM.
 * Все числа в тексте разбора считаются здесь кодом, не пишутся руками.
 */
import {
  ALL_HANDS, combosOf, comboCount, rangePercent, freqOf, diff, handCombos, formatRange, handInfo,
} from './hands.js';
import { ORDER, ORDER_INDEX, midPercent, weightMap, classify, handName, SOURCE } from './data.js';
import { EQUITY169 } from './equity169.js';

/** 12,5 — запятая у десятичных, точка у тысяч. */
export function fmtNum(n) {
  const r = Math.round(n * 10) / 10;
  const [i, f] = String(r).split('.');
  const ip = i.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return f ? `${ip},${f}` : ip;
}
export const fmtPct = (p) => `${fmtNum(p)} %`;
export const fmtCombos = (n) => `${fmtNum(n)} комбо`;

/** Ответ упражнения (массив кодов или объект частот) → Map. */
export function asMap(answer) {
  if (!answer) return new Map();
  if (answer instanceof Map) return new Map([...answer].filter(([, f]) => f > 0));
  if (answer instanceof Set) return new Map([...answer].map((c) => [c, 1]));
  if (Array.isArray(answer)) return new Map(answer.filter((c) => ALL_HANDS.includes(c)).map((c) => [c, 1]));
  if (typeof answer === 'object') {
    const m = new Map();
    for (const [k, v] of Object.entries(answer)) if (ALL_HANDS.includes(k) && Number(v) > 0) m.set(k, Math.min(1, Number(v)));
    return m;
  }
  return new Map();
}
/** Эталон (Set или Map) → форма ответа: массив (все 1) или объект частот. */
export function answerForm(ref) {
  if (ref instanceof Map) return Object.fromEntries([...ref].filter(([, f]) => f > 0));
  return ORDER.filter((c) => ref.has(c));
}

/** Список рук для текста: «AKs, QQ, JTs и ещё 4». Сильные первыми (или слабые — `weakFirst`). */
export function listHands(codes, { max = 6, weakFirst = false } = {}) {
  const sorted = [...codes].sort((a, b) => (ORDER_INDEX.get(a) - ORDER_INDEX.get(b)) * (weakFirst ? -1 : 1));
  const head = sorted.slice(0, max).join(', ');
  return sorted.length > max ? `${head} и ещё ${sorted.length - max}` : head;
}

/**
 * Взвешенное совпадение: пограничные руки (рядом с порогом) весят 0,35 —
 * грубая ошибка на очевидной руке штрафуется сильнее. Пересечение / объединение
 * по комбинациям с весами, 0…1. Пустой ответ — 0.
 */
export function weightedMatch(user, ref, thresholds = []) {
  if (!user.size) return 0;
  const w = thresholds.length ? weightMap(thresholds) : () => 1;
  let inter = 0;
  let union = 0;
  for (const c of ALL_HANDS) {
    const u = freqOf(user, c);
    const r = freqOf(ref, c);
    const k = w(c) * combosOf(c);
    inter += k * Math.min(u, r);
    union += k * Math.max(u, r);
  }
  return union === 0 ? 1 : inter / union;
}

const WEAK_CLS = new Set(['offsuit-trash', 'suited-trash', 'ace-offsuit-weak', 'offsuit-connector']);

/**
 * Разбор набора рук. `user`/`ref` — ответ и эталон (массив/объект/Set/Map),
 * `thresholds` — пороги в % для веса, `topics` — { wide, tight, hands } темы
 * для ошибок, `what` — как называется набор («диапазон открытия с CO»).
 */
export function reviewRange({ user, ref, thresholds = [], topics, what, extraWhy = '', passScore = 0.8 }) {
  const u = asMap(user);
  const r = asMap(ref);
  const d = diff(u, r);
  const score = Math.round(weightedMatch(u, r, thresholds) * 100) / 100;
  const uc = comboCount(u);
  const rc = comboCount(r);
  const mistakes = [];
  if (!u.size) {
    mistakes.push({ code: 'range-empty', topic: topics.tight, text: 'На матрице ничего не выбрано.' });
  } else {
    if (d.extraCombos > rc * 0.25) mistakes.push({ code: 'range-too-wide', topic: topics.wide, text: `Диапазон шире эталона: лишних ${fmtCombos(d.extraCombos)} (${listHands(d.extra, { weakFirst: true, max: 4 })}).` });
    if (d.missedCombos > rc * 0.25) mistakes.push({ code: 'range-too-tight', topic: topics.tight, text: `Диапазон уже эталона: пропущено ${fmtCombos(d.missedCombos)} (${listHands(d.missed, { max: 4 })}).` });
    const weak = d.extra.filter((c) => WEAK_CLS.has(classify(c).cls));
    if (weak.length) mistakes.push({ code: 'range-weak-hands', topic: topics.hands, text: `Слабые руки в диапазоне: ${weak.slice(0, 3).map((c) => `${c} — ${classify(c).label}`).join('; ')}.` });
    const missedPairs = d.missed.filter((c) => handInfo(c).kind === 'pair');
    if (missedPairs.length) mistakes.push({ code: 'range-missed-pairs', topic: topics.hands, text: `Пропущены пары: ${listHands(missedPairs, { max: 5 })} — пара играется на сет.` });
    const missedSuited = d.missed.filter((c) => ['suited-connector', 'ace-suited-low', 'ace-suited-high', 'broadway-suited'].includes(classify(c).cls));
    if (missedSuited.length) mistakes.push({ code: 'range-missed-suited', topic: topics.hands, text: `Пропущены одномастные руки: ${listHands(missedSuited, { max: 5 })} — масть даёт шанс на флеш.` });
  }
  const why = `${what}: эталон — ${fmtPct(rangePercent(r))} (${fmtCombos(rc)}), у вас — ${fmtPct(rangePercent(u))} (${fmtCombos(uc)}). `
    + `Совпало ${fmtCombos(d.commonCombos)} из ${fmtCombos(d.commonCombos + d.missedCombos + d.extraCombos)}; оценка ${fmtNum(score * 100)} %. ${extraWhy} ${SOURCE}`;
  return {
    ok: score >= passScore,
    score,
    mistakes,
    why: why.replace(/\s+/g, ' ').trim(),
    alternatives: [
      { label: 'Пропущено', verdict: fmtCombos(d.missedCombos), text: d.missed.length ? listHands(d.missed, { max: 12 }) : 'ничего' },
      { label: 'Лишнее', verdict: fmtCombos(d.extraCombos), text: d.extra.length ? listHands(d.extra, { max: 12, weakFirst: true }) : 'ничего' },
    ],
    solution: answerForm(r instanceof Map && [...r.values()].some((f) => f < 1) ? r : new Set(r.keys())),
  };
}

/** Описание места руки в учебном порядке — для «почему». */
export function rankNote(code) {
  const i = ORDER_INDEX.get(code) + 1;
  return `${code} (${handName(code)}) — №${i} из 169 в учебном порядке, верхние ${fmtPct(midPercent(code))} рук; эквити против случайной руки ${fmtPct(EQUITY169[code] * 100)}`;
}

/**
 * Руки с серединой порядка в диапазоне [lo, hi] %, исключая полосы вокруг
 * `avoid` (границ) — чтобы вопрос «на зубок» не был спорным.
 */
export function handsBetween(lo, hi, avoid = [], pad = 2) {
  return ORDER.filter((c) => {
    const m = midPercent(c);
    return m >= lo && m <= hi && !avoid.some((a) => Math.abs(m - a) < pad);
  });
}

/** Случайная комбинация руки как пара карт. */
export const holeOf = (rng, code) => rng.pick(handCombos(code));
export { formatRange };
