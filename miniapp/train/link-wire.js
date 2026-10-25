/**
 * Подключение связки и определения уровня к экранам приложения (агент Y).
 * Один модуль на одну строку `import` в `miniapp/app.js`: при загрузке он
 * записывает крючки в `route.js` и маршрутизатор в `link.js`.
 *
 *   hooks.openLesson(topic, {returnTo})   — «Изучить тему» (V вызывает из разбора)
 *   hooks.placement(root, {done, exit})   — экраны «Определить уровень» (V зовёт с главной Тренировки, пока уровень не выбран)
 *   hooks.needsPlacement(progress)        — показывать ли их сейчас
 *   hooks.decisionSettings(el)            — строка про журнал решений и «Удалить историю решений»
 *   hooks.returnButton()                  — кнопка «Вернуться к заданию» для экрана урока (U) или null
 */
import { hooks, openRoute, openTrainingExercise } from './route.js';
import * as L from './link.js';
import * as E from './engine.js';
import { showPlacement, renderDecisionSettings } from './placement.js';
import { topicById } from './topics.js';
import { h, haptic } from '../ui.js';

const FLAG = 'train.placed';
const read = () => { try { return localStorage.getItem(FLAG) === '1'; } catch { return false; } };
const write = () => { try { localStorage.setItem(FLAG, '1'); } catch { /* приватный режим */ } };

L.setRouter({
  // Урок рисует U на маршруте 'learn'; параметры: lesson (тема) и returnTo.
  lesson: (topic, { returnTo }) => openRoute('learn', { lesson: topic, returnTo }),
  // «Вернуться к заданию»: тот же exercise и seed; маршрут один, поэтому экран урока заменяется, а не копится.
  exercise: (exercise, seed) => {
    const ex = E.exerciseById(exercise);
    if (!ex) return openRoute('train');
    openTrainingExercise({ track: ex.track, topic: ex.topic, exercise, seed });
  },
  training: ({ track, topic, exercise, seed }) => {
    if (exercise) return openTrainingExercise({ track: E.exerciseById(exercise)?.track || track, exercise, seed });
    const first = topic ? E.exercisesOf({ topic })[0] : null;
    if (first) return openTrainingExercise({ track: first.track, topic });
    if (track) return openRoute('train-track', { track });
    openRoute('train');
  },
  home: () => openRoute('train'),
});

hooks.openLesson = (topic, opts = {}) => {
  if (!topicById(topic)) return;
  L.openLesson(topic, opts);
};

hooks.needsPlacement = (progress) => !read() && !progress?.started;

hooks.placement = (root, { done, exit } = {}) => showPlacement(root, {
  bank: E,
  onDone: (progress) => { write(); done?.(progress); },
  onExit: exit ? () => { write(); exit(); } : null,
});

hooks.decisionSettings = (el) => renderDecisionSettings(el, {});

hooks.returnButton = () => (L.pending()
  ? h('button.k-btn.k-btn--primary.k-btn--block', { type: 'button', 'data-go': 'return-to-task', onclick: () => { haptic.soft(); L.returnToTask(); } }, 'Вернуться к заданию')
  : null);

/** Задание решено или игрок ушёл «домой» — цепочка кончается. */
hooks.endChain = () => L.endChain();
