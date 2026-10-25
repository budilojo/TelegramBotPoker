/**
 * Маршрут «своих» экранов Обучения и Тренировки. Это экраны СТРАНИЦЫ поверх
 * состояния сервера (как «Настройки» в нижней навигации): сервер о них не
 * знает. Сменилось «место» состояния (другой стол, группа) — экран закрыт.
 *
 * Имена: 'train' (направления), 'train-track' {track}, 'train-ex' {track,
 * level?, exercise?, seed?, topic?}, 'train-stats', 'learn' (агент U).
 */
import { bus } from '../net.js';

let route = null;

export const activeRoute = () => route;

export function openRoute(name, params = {}) {
  route = { name, ...params };
  bus.render();
}

export function closeRoute() {
  if (!route) return;
  route = null;
  bus.render();
}

/** Состояние ушло на другое место — закрыть молча, без перерисовки (её сделает вызывающий). */
export function resetRoute() {
  route = null;
}

/**
 * Крючки для соседних модулей. Модуль подключается своей строкой `import` в
 * `miniapp/app.js` и при загрузке записывает свою функцию:
 *   hooks.openLesson  — агент Y (`link.js`): (topicId, {returnTo}) → открыть урок;
 *   hooks.renderLearn — агент U (`learn/`): (container, api) → нарисовать «Обучение».
 * Пока крючка нет, соответствующая кнопка просто не показывается.
 */
export const hooks = {
  openLesson: null,
  renderLearn: null,
  /** Агент Y (`link-wire.js`): нужно ли определение уровня; экран определения; настройки журнала решений; цепочка «ошибка → урок → задание». */
  needsPlacement: null,
  placement: null,
  decisionSettings: null,
  endChain: null,
};

/** Открыть упражнение (для Y: «Вернуться к заданию» — тот же exercise и seed). */
export function openTrainingExercise({ track, topic = null, exercise = null, seed = null, level = null }) {
  openRoute('train-ex', { track, topic, exercise, seed, level });
}
