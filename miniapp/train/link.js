/**
 * Связка «Обучение ↔ Тренировка» (агент Y, контракт 5). Чистая логика без DOM:
 * экраны подключаются через `setRouter`, хранилище — через `setStorage`
 * (по умолчанию sessionStorage: переживает перезагрузку WebView, но не
 * закрытие приложения).
 *
 *   openLesson(topicId, {returnTo})  — урок по теме; returnTo = {exercise, seed}
 *   returnToTask()                   — «Вернуться к заданию»: ТО ЖЕ упражнение, ТОТ ЖЕ seed
 *   openTraining({track, topic, exercise, seed})
 *
 * Бесконечных циклов нет: «упражнение → урок → упражнение → урок…» разрешено
 * не больше MAX_HOPS раз подряд, дальше — «домой» (решение 075).
 */
export const MAX_HOPS = 3;
const KEY = 'train.link';

let router = { lesson: null, exercise: null, training: null, home: null };
let storage = null;
let memory = null; // запасной вариант, если sessionStorage недоступен

export function setRouter(r) {
  router = { ...router, ...r };
}

export function setStorage(s) {
  storage = s;
}

function store() {
  if (storage) return storage;
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

function read() {
  try {
    const s = store();
    if (s) {
      const raw = s.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    }
  } catch {
    /* повреждённая запись — как будто её нет */
  }
  return memory;
}

function write(ctx) {
  memory = ctx;
  try {
    const s = store();
    if (s) {
      if (ctx) s.setItem(KEY, JSON.stringify(ctx));
      else s.removeItem(KEY);
    }
  } catch {
    /* приватный режим — останется в памяти приложения */
  }
}

/** Контекст возврата или null (для кнопки «Вернуться к заданию» и Telegram «Назад»). */
export function pending() {
  const c = read();
  return c && typeof c.exercise === 'string' && Number.isInteger(c.seed) ? c : null;
}

export function clearLink() {
  write(null);
}

/** «Изучить тему»: из ошибки в упражнении — в урок, запомнив, куда вернуться. */
export function openLesson(topicId, { returnTo = null } = {}) {
  const prev = read();
  // Считаем только повторные заходы в урок из ТОГО ЖЕ задания: другое задание — новая цепочка.
  const same = prev && returnTo && prev.exercise === String(returnTo.exercise) && prev.seed === returnTo.seed;
  const hops = returnTo ? (same ? prev.hops || 0 : 0) + 1 : 0;
  if (returnTo && hops > MAX_HOPS) {
    clearLink();
    router.home?.({ reason: 'loop' });
    return { ok: false, reason: 'loop' };
  }
  if (returnTo) write({ exercise: String(returnTo.exercise), seed: returnTo.seed, topic: topicId, hops });
  else write(null);
  router.lesson?.(topicId, { returnTo: returnTo ? { exercise: String(returnTo.exercise), seed: returnTo.seed } : null });
  return { ok: true };
}

/** «Вернуться к заданию»: то же упражнение с тем же seed; экран урока заменяется, а не копится. */
export function returnToTask() {
  const c = pending();
  if (!c) return false;
  // hops остаётся: если снова ошибётся и снова пойдёт в урок, цикл посчитается.
  write({ ...c, back: true });
  router.exercise?.(c.exercise, c.seed, { repeat: true, replace: true });
  return true;
}

/** Задание открыто и закрыто нормально (решено, или игрок ушёл «домой») — цепочка кончается. */
export function endChain() {
  clearLink();
}

/** Из урока: упражнения по теме. */
export function openTraining(opts = {}) {
  router.training?.({ track: opts.track, topic: opts.topic, exercise: opts.exercise, seed: opts.seed });
}

/** Есть ли по теме упражнения (иначе кнопку «Потренироваться» не показываем). */
export function canPractice(topicId, bank) {
  return !!bank && bank.exercisesOf({ topic: topicId }).length > 0;
}

/**
 * Для кнопки «Изучить тему» в разборе: даём только если у темы есть урок
 * (`hasLesson(topicId)` — от U) и она известна реестру.
 */
export function topicAction(topicId, { exercise, seed, hasLesson = () => true, title = null }) {
  if (!topicId || !hasLesson(topicId)) return null;
  return {
    label: `Изучить тему: ${title || topicId}`,
    run: () => openLesson(topicId, { returnTo: exercise ? { exercise, seed } : null }),
  };
}
