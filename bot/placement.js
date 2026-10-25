'use strict';
/**
 * Серверная часть «определения уровня» (агент Y). Три операции сообщения
 * {t:'train'}, которые агент V передаёт сюда: 'placement', 'history',
 * 'decisions-clear'. Личность — только из подписанного initData (`userId`
 * приходит от хаба, в теле сообщения «чей» не читается).
 *
 * Уровни — 1…5. «Не доверять клиенту, что диагностика пройдена» нечего
 * охранять: прогресс личный и ничего не открывает; важно только, чтобы в
 * хранилище не попало что попало (решение 074). Ручной выбор — всегда можно.
 */
import { SKILLS, LEVELS } from '../miniapp/train/topics.js';
import { assessHistory } from './decisions.js';

const VIAS = new Set(['zero', 'quiz', 'history']);
export const ERRORS = {
  BAD_PLACEMENT: 'Не получилось сохранить уровень: проверьте значения (от 1 до 5).',
  FEW_DECISIONS: 'Пока мало решений в играх — сыграйте ещё или пройдите диагностику.',
};

/** Чистая проверка: {skills, via} → нормализованные уровни или null. */
export function cleanPlacement(msg) {
  const raw = msg?.skills;
  if (!raw || typeof raw !== 'object' || !VIAS.has(msg.via)) return null;
  const out = {};
  for (const s of SKILLS) {
    const v = raw[s.id];
    if (v == null) continue;
    if (!Number.isInteger(v) || v < 1 || v > LEVELS) return null;
    out[s.id] = v;
  }
  for (const k of Object.keys(raw)) if (!SKILLS.some((s) => s.id === k)) return null;
  return Object.keys(out).length ? out : null;
}

/**
 * @param msg   сообщение страницы
 * @param deps  { userId, store, now, saveSkills(userId, skills, via) → progress }
 * @returns объект-ответ для страницы или { error, text }
 */
export function handleY(msg, { userId, store, saveSkills }) {
  if (!userId) return { error: 'BAD_PLACEMENT', text: ERRORS.BAD_PLACEMENT };
  if (msg.op === 'history') {
    return { t: 'train', history: assessHistory(store.decisionsOf(userId)) };
  }
  if (msg.op === 'decisions-clear') {
    return { t: 'train', cleared: store.deleteDecisions(userId) };
  }
  if (msg.op === 'placement') {
    const skills = cleanPlacement(msg);
    if (!skills) return { error: 'BAD_PLACEMENT', text: ERRORS.BAD_PLACEMENT };
    if (msg.via === 'history') {
      // «По истории» принимается только если журнал действительно что-то оценил,
      // и только по тем навыкам, где данных хватает.
      const a = assessHistory(store.decisionsOf(userId));
      if (!a.available) return { error: 'FEW_DECISIONS', text: ERRORS.FEW_DECISIONS };
      for (const id of Object.keys(skills)) if (!a.skills[id]?.enough) return { error: 'BAD_PLACEMENT', text: ERRORS.BAD_PLACEMENT };
    }
    return { t: 'train', progress: saveSkills(userId, skills, msg.via) };
  }
  return { error: 'BAD_PLACEMENT', text: ERRORS.BAD_PLACEMENT };
}
