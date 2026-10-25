/**
 * Определение уровня — чистая логика без DOM (агент Y). Проверяется тестами в
 * `bot/placement.test.js`; экраны — в `placement.js`.
 *
 * Диагностика адаптивна: верно → следующее задание сложнее, неверно (и «Не знаю») →
 * проще. Уровень навыка = самый высокий уровень, на котором ответили верно
 * (нет верных — 1). Это грубая оценка «с чего начать», а не экзамен.
 */
import { SKILLS, LEVELS } from './topics.js';

export const START_LEVEL = 2; // с чего начинаем спрашивать каждый навык
export const ROUNDS = 2; // по два вопроса на навык, третий — если ответы разошлись
export const MAX_TASKS = 12;

const clamp = (v) => Math.max(1, Math.min(LEVELS, v));

/** Следующий уровень вопроса после ответа. */
export const nextLevel = (level, ok) => clamp(ok ? level + 1 : level - 1);

/** Новое состояние диагностики. */
export function startQuiz(skills = SKILLS.map((s) => s.id)) {
  return { skills: [...skills], answers: Object.fromEntries(skills.map((s) => [s, []])), asked: new Set(), cursor: 0 };
}

/** Оценка уровня навыка по ответам [{level, ok}]. */
export function estimate(answers) {
  const right = (answers || []).filter((a) => a.ok).map((a) => a.level);
  return right.length ? Math.max(...right) : 1;
}

/** Сколько вопросов нужно по навыку: 2, а при расхождении (верно+неверно) — 3. */
function wanted(answers) {
  if (answers.length < ROUNDS) return ROUNDS;
  const oks = new Set(answers.slice(0, ROUNDS).map((a) => a.ok));
  return oks.size > 1 ? ROUNDS + 1 : ROUNDS;
}

/** Целевой уровень следующего вопроса по навыку. */
export function targetLevel(answers) {
  if (!answers.length) return START_LEVEL;
  const last = answers[answers.length - 1];
  return nextLevel(last.level, last.ok);
}

/** Какой навык спрашивать сейчас: по кругу среди тех, кому ещё нужны вопросы. */
export function nextSkill(state, available) {
  const open = state.skills.filter((s) => available(s) && state.answers[s].length < wanted(state.answers[s]));
  if (!open.length || totalAnswers(state) >= MAX_TASKS) return null;
  // Сначала те, кого спрашивали реже: так навыки чередуются.
  return open.slice().sort((a, b) => state.answers[a].length - state.answers[b].length || state.skills.indexOf(a) - state.skills.indexOf(b))[0];
}

export const totalAnswers = (state) => state.skills.reduce((n, s) => n + state.answers[s].length, 0);

/**
 * Выбрать упражнение. `bank.exercisesOf({skill, level})` → список {id, skill, level, …}.
 * Берём ближайший к цели уровень, ещё не заданный. Нет упражнений → null.
 * Детерминированно (по id) — тесты не зависят от случайности.
 */
export function pickExercise(state, skill, bank) {
  const want = targetLevel(state.answers[skill]);
  const all = bank.exercisesOf({ skill }).filter((e) => !state.asked.has(e.id));
  if (!all.length) return null;
  const best = all.slice().sort((a, b) => Math.abs(a.level - want) - Math.abs(b.level - want) || a.level - b.level || (a.id < b.id ? -1 : 1))[0];
  return best;
}

/** Следующее задание: { skill, ex, seed } или null — диагностика закончена. */
export function nextTask(state, bank, seedOf = (n) => 1000 + n) {
  const tried = new Set();
  for (;;) {
    const skill = nextSkill(state, (s) => !tried.has(s));
    if (!skill) return null;
    const ex = pickExercise(state, skill, bank);
    if (ex) return { skill, ex, seed: seedOf(totalAnswers(state)) };
    tried.add(skill); // по навыку нет заданий — не спрашиваем его
  }
}

/** Записать ответ. «Не знаю» (`skipped`) считается неверным. */
export function answer(state, task, ok, skipped = false) {
  state.asked.add(task.ex.id);
  state.answers[task.skill].push({ level: task.ex.level, ok: !!ok && !skipped, skipped: !!skipped });
}

/** Итог: уровни по навыкам, где был хоть один ответ; остальные null. */
export function quizResult(state) {
  const out = {};
  for (const s of state.skills) out[s] = state.answers[s].length ? estimate(state.answers[s]) : null;
  return out;
}

/** Ручное изменение на экране итога: − / +, в пределах 1…LEVELS. */
export const adjust = (level, delta) => clamp((level ?? 1) + delta);

/** Слова про уровень на шкале итога. */
export const levelWord = (n) => ['Новичок', 'Любитель', 'Уверенный', 'Продвинутый', 'Эксперт'][clamp(n) - 1];

/**
 * Что отправить серверу: только известные навыки с уровнями 1…5.
 * `via` — 'zero' | 'quiz' | 'history'.
 */
export function placementMessage(levels, via) {
  const skills = {};
  for (const s of SKILLS) if (Number.isInteger(levels?.[s.id])) skills[s.id] = clamp(levels[s.id]);
  return { t: 'train', op: 'placement', skills, via };
}

/** «С нуля»: все навыки на первом уровне. */
export const zeroLevels = () => Object.fromEntries(SKILLS.map((s) => [s.id, 1]));

/** «По истории» → стартовые уровни по тем навыкам, где данных хватает. */
export function levelsFromHistory(history) {
  const out = {};
  for (const s of SKILLS) {
    const k = history?.skills?.[s.id];
    out[s.id] = k && k.enough && Number.isInteger(k.level) ? k.level : null;
  }
  return out;
}
