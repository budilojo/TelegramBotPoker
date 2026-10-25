/**
 * Повторение слабых тем с интервалами — ЧИСТЫЙ модуль, считает сервер по
 * СВОИМ часам (`app.clock.now()`), а не по времени с телефона.
 *
 * Правило простое и объяснимое (не чужой алгоритм):
 *   ошибка по теме → тема «слабая», вернуться к ней через 1 день;
 *   верный ответ, когда срок пришёл → следующий интервал 3, потом 7, потом 14 дней;
 *   после 14-дневного круга тема «закреплена» — из повторения уходит;
 *   новая ошибка в любой момент → начинаем с 1 дня заново (интервал сброшен).
 * Верные ответы ДО срока шаг не двигают — нельзя «прокликать» повторение подряд.
 */
export const DAY = 86_400_000;
export const LADDER = [1, 3, 7, 14];

/** Строка темы: { step (0…3), dueAt (мс), lapses, done }. Ошибка: тема (снова) слабая. */
export function afterMistake(row, now) {
  return { step: 0, dueAt: now + LADDER[0] * DAY, lapses: (row?.lapses || 0) + 1, done: false };
}

/** Верный ответ по теме из повторения. Не по сроку — без изменений. */
export function afterCorrect(row, now) {
  if (!row || row.done || now < row.dueAt) return row;
  const step = row.step + 1;
  if (step >= LADDER.length) return { ...row, step: LADDER.length, dueAt: Infinity, done: true };
  return { ...row, step, dueAt: now + LADDER[step] * DAY };
}

/** Пора повторять? */
export const isDue = (row, now) => !!row && !row.done && now >= row.dueAt;

/** Через сколько дней вернёмся к теме (для подписи на экране). */
export const nextIntervalDays = (row) => (row && !row.done ? LADDER[row.step] : null);
