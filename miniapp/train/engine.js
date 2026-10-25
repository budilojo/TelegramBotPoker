/**
 * Движок упражнений «Тренировки» — ЧИСТЫЙ модуль (никакого DOM): его читают
 * экраны, сервер (только `skills.js`/`srs.js`) и тесты. Контракт и правила
 * добавления упражнений — `docs/poker-training.md`.
 *
 * Упражнение — описание + `make(seed, rng)`, которое строит задание. Задание
 * — чистые данные и функция `check(answer)`; экран только рисует.
 */
import { LEVELS, isTopic, isTrack, trackById } from './topics.js';
import { PASS_SCORE } from './skills.js';

export { PASS_SCORE };

/** Сколько заданий в одном подходе («3/10» в шапке). */
export const ROUND = 10;

/** Виды упражнений: чем игрок отвечает. Новый вид — строка здесь + виджет. */
export const KINDS = ['pick', 'cards', 'range', 'slider', 'bet', 'table', 'order'];

/** Детерминированный генератор по числу (mulberry32): тот же seed — те же числа. */
export function rngFromSeed(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = () => next();
  /** Целое от `lo` до `hi` включительно. */
  rng.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  /** Случайный элемент массива. */
  rng.pick = (arr) => arr[Math.floor(next() * arr.length)];
  /** Перемешанная копия (Фишер — Йейтс). */
  rng.shuffle = (arr) => {
    const a2 = arr.slice();
    for (let i = a2.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [a2[i], a2[j]] = [a2[j], a2[i]];
    }
    return a2;
  };
  return rng;
}

/** Новый случайный seed для нового задания (31 бит: безопасно для JSON и для сервера). */
export const newSeed = (rand = Math.random) => Math.floor(rand() * 0x7fffffff);

const REG = new Map();

/**
 * Зарегистрировать упражнения направления. Проверяет форму сразу — кривое
 * упражнение падает при загрузке, а не у игрока. Повторный id — ошибка.
 */
export function registerExercises(trackId, list) {
  if (!isTrack(trackId)) throw new Error(`train: неизвестное направление «${trackId}»`);
  const track = trackById(trackId);
  for (const ex of list) {
    const where = `train: упражнение «${ex?.id}» (${trackId})`;
    if (!ex || typeof ex.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(ex.id)) throw new Error(`${where}: id — латиница, цифры, . _ - (до 64)`);
    if (REG.has(ex.id)) throw new Error(`${where}: такой id уже есть`);
    if (ex.track != null && ex.track !== trackId) throw new Error(`${where}: track не совпадает с направлением`);
    if (!isTopic(ex.topic)) throw new Error(`${where}: тема «${ex.topic}» нет в реестре тем`);
    if (!Number.isInteger(ex.level) || ex.level < 1 || ex.level > LEVELS) throw new Error(`${where}: level — целое от 1 до ${LEVELS}`);
    if (!KINDS.includes(ex.kind)) throw new Error(`${where}: неизвестный kind «${ex.kind}»`);
    if (typeof ex.make !== 'function') throw new Error(`${where}: нет make(seed)`);
    REG.set(ex.id, Object.freeze({ ...ex, track: trackId, skill: track.skill }));
  }
}

/** Убрать упражнения (только для тестов движка). */
export const clearExercises = () => REG.clear();

export const exerciseById = (id) => REG.get(id) || null;
export const allExercises = () => [...REG.values()];

/** Выбрать упражнения: любой набор из `track`, `topic`, `level`, `skill` (все необязательны). */
export function exercisesOf({ track, topic, level, skill } = {}) {
  return allExercises().filter((e) => (track == null || e.track === track)
    && (topic == null || e.topic === topic)
    && (level == null || e.level === level)
    && (skill == null || e.skill === skill));
}

/** В каких направлениях и на каких уровнях уже есть упражнения: { track: [levels] }. */
export function coverage() {
  const out = {};
  for (const e of REG.values()) (out[e.track] ||= new Set()).add(e.level);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
}

/**
 * Собрать задание: то же `seed` — то же задание (на этом держится «Вернуться
 * к заданию» после урока). Возвращает { exercise, seed, task }.
 */
export function instantiate(exerciseId, seed) {
  const exercise = exerciseById(exerciseId);
  if (!exercise) throw new Error(`train: упражнения «${exerciseId}» нет`);
  const s = Number.isInteger(seed) ? seed : newSeed();
  const task = exercise.make(s, rngFromSeed(s));
  if (!task || typeof task.check !== 'function' || typeof task.prompt !== 'string') throw new Error(`train: «${exerciseId}» вернуло неполное задание`);
  return { exercise, seed: s, task };
}

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/**
 * Привести разбор к единой форме и проверить его. `ok` — оценка ≥ 0,7
 * (если игра не сказала иначе); темы ошибок обязаны быть из реестра.
 */
export function normalizeReview(r) {
  const score = clamp01(r?.score ?? (r?.ok ? 1 : 0));
  const ok = typeof r?.ok === 'boolean' ? r.ok : score >= PASS_SCORE;
  const mistakes = (Array.isArray(r?.mistakes) ? r.mistakes : [])
    .filter((m) => m && typeof m.code === 'string' && isTopic(m.topic))
    .map((m) => ({ code: m.code, topic: m.topic, text: String(m.text ?? '') }));
  return {
    ok,
    score,
    mistakes,
    why: String(r?.why ?? ''),
    alternatives: (Array.isArray(r?.alternatives) ? r.alternatives : []).map((a) => ({ label: String(a.label ?? ''), verdict: String(a.verdict ?? ''), text: String(a.text ?? '') })),
    solution: r?.solution ?? null,
  };
}

/** Проверить ответ: разбор в единой форме. Ловит исключения упражнения — экран не падает. */
export function grade(task, answer) {
  return normalizeReview(task.check(answer));
}

/**
 * Список проблем разбора (пустой — всё в порядке). Для тестов всех
 * зарегистрированных упражнений: числа в тексте и темы ошибок не выдумывать.
 */
export function reviewProblems(r) {
  const bad = [];
  if (typeof r?.ok !== 'boolean') bad.push('ok не булево');
  if (!(r?.score >= 0 && r.score <= 1)) bad.push('score вне 0…1');
  if (typeof r?.why !== 'string' || !r.why.trim()) bad.push('нет why (почему верно)');
  for (const m of r?.mistakes || []) if (!isTopic(m.topic)) bad.push(`ошибка «${m.code}»: темы «${m.topic}» нет в реестре`);
  return bad;
}

/**
 * Подобрать следующее упражнение.
 *   track, level — обязательны; topic — предпочесть тему (повторение);
 *   recent — id последних упражнений (не повторять подряд, если есть выбор);
 *   rand — источник случайного (в тестах подставляется).
 * Если на нужном уровне пусто — ближайший ниже, потом выше.
 * Вернёт { exercise, level } или null, если в направлении упражнений нет.
 */
export function pickExercise({ track, level, topic = null, recent = [], rand = Math.random }) {
  const all = exercisesOf({ track });
  if (!all.length) return null;
  const levels = [...new Set(all.map((e) => e.level))];
  levels.sort((a, b) => Math.abs(a - level) - Math.abs(b - level) || a - b);
  const useLevel = levels[0];
  let pool = all.filter((e) => e.level === useLevel);
  if (topic) {
    const onTopic = pool.filter((e) => e.topic === topic);
    if (onTopic.length) pool = onTopic;
  }
  const fresh = pool.filter((e) => !recent.includes(e.id));
  if (fresh.length) pool = fresh;
  return { exercise: pool[Math.floor(rand() * pool.length)], level: useLevel };
}

/**
 * Готовое задание-«выбор»: для простых `pick`-упражнений (W и X могут не
 * писать `check` вручную). `options` — [{ id, label, why }]; `why` у каждого
 * варианта — чем он верен/неверен (числа считайте кодом). Порядок вариантов
 * перемешивается по `rng` (тот же seed — тот же порядок).
 *
 *   makePick(rng, {
 *     prompt, setup, options, correct: 'id',
 *     why: 'почему верно (2–4 предложения)',
 *     mistake: { code, topic },       // что записать в историю ошибок при промахе
 *   })
 */
export function makePick(rng, { prompt, setup = {}, options, correct, why, mistake }) {
  if (!options.some((o) => o.id === correct)) throw new Error('makePick: верного варианта нет среди options');
  const shown = rng.shuffle(options);
  return {
    prompt,
    setup: { ...setup, options: shown.map(({ id, label }) => ({ id, label })) },
    solution: correct,
    check(answer) {
      const ok = answer === correct;
      return {
        ok,
        score: ok ? 1 : 0,
        mistakes: ok ? [] : [{ code: mistake.code, topic: mistake.topic, text: mistake.text || `Выбрано «${options.find((o) => o.id === answer)?.label ?? '—'}» — это не так.` }],
        why,
        alternatives: shown.map((o) => ({ label: o.label, verdict: o.id === correct ? 'верно' : 'неверно', text: o.why || '' })),
        solution: correct,
      };
    },
  };
}
