/**
 * Навыки, уровни, оценка и «освоено» — ЧИСТЫЙ модуль: одни и те же правила
 * считает сервер (`bot/train.js`) и читают экраны и тесты.
 * Что значит «уровень пройден», «предложить уровень», «освоено» — решения
 * `docs/brain/decisions/058`; всё ниже — числа оттуда.
 */
import { LEVELS, LEVEL_NAMES } from './topics.js';

/** Оценка задания не ниже этого — «верно» (тот же порог у движка). */
export const PASS_SCORE = 0.7;
/** Уровень направления пройден: из последних 10 заданий этого уровня верно не меньше 8. */
export const PASS_WINDOW = 10;
export const PASS_NEED = 8;
/** Предложение сменить уровень навыка: смотрим последние 8 заданий на текущем уровне. */
export const SUGGEST_WINDOW = 8;
export const SUGGEST_UP = 7; // верно ≥ 7 из 8 → предложить выше
export const SUGGEST_DOWN = 2; // верно ≤ 2 из 8 → предложить ниже
/** Навык «освоен»: уровень не ниже 3, оценка не ниже 80 по не менее чем 20 заданиям. */
export const MASTER_LEVEL = 3;
export const MASTER_RATING = 80;
export const MASTER_MIN_N = 20;

export const isGood = (score) => score >= PASS_SCORE;

/**
 * Скользящая оценка навыка 0…100: свежие ответы весят больше. Вес нового
 * ответа — не меньше 0,2 (первые ответы — среднее, дальше — «память» около
 * пяти заданий).
 */
export function nextRating(rating, n, score) {
  const w = Math.max(0.2, 1 / (n + 1));
  return Math.round((rating + (score * 100 - rating) * w) * 100) / 100;
}

/** Уровень направления пройден? `scores` — оценки последних заданий этого уровня, новые последними. */
export function levelPassed(scores) {
  const last = scores.slice(-PASS_WINDOW);
  return last.length >= PASS_WINDOW && last.filter(isGood).length >= PASS_NEED;
}

/**
 * Предложение сменить уровень навыка — с объяснением, а не молчаливый скачок.
 * `scores` — оценки последних заданий навыка НА ТЕКУЩЕМ уровне (после его
 * последней смены), новые последними. Нечего предлагать — null.
 */
export function suggestLevel(level, scores) {
  const last = scores.slice(-SUGGEST_WINDOW);
  if (last.length < SUGGEST_WINDOW) return null;
  const good = last.filter(isGood).length;
  if (good >= SUGGEST_UP && level < LEVELS) {
    const to = level + 1;
    return { dir: 'up', to, text: `${good} из ${SUGGEST_WINDOW} верно — предлагаем перейти на ${to}-й уровень («${LEVEL_NAMES[to - 1]}»).` };
  }
  if (good <= SUGGEST_DOWN && level > 1) {
    const to = level - 1;
    return { dir: 'down', to, text: `Верно только ${good} из ${SUGGEST_WINDOW} — предлагаем вернуться на ${to}-й уровень («${LEVEL_NAMES[to - 1]}») и закрепить основу.` };
  }
  return null;
}

/** Навык освоен? `row` = { level, rating, n }. */
export const isMastered = (row) => !!row && row.level >= MASTER_LEVEL && row.rating >= MASTER_RATING && row.n >= MASTER_MIN_N;

export const levelName = (level) => LEVEL_NAMES[level - 1] || '';
