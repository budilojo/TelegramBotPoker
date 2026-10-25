/**
 * Подключение курса к экрану «Обучение» (`miniapp/train/route.js`): при загрузке записывает
 * свою функцию в крючок. Одна строка `import './learn/hook.js'` в app.js.
 */
import { hooks, openRoute, activeRoute } from '../train/route.js';
import { exercisesOf } from '../train/engine.js';
import '../train/content/index.js';
import { net } from '../net.js';
import { renderLearn, prepareLesson } from './screens.js';

/** Маршруты, из которых урок уже выбран (экран перерисовывается часто — выбирать надо один раз). */
const consumed = new WeakSet();

const exerciseOfTopic = (topic) => exercisesOf({ topic })[0] || null;

hooks.renderLearn = (container, api) => {
  // «Изучить тему» из ошибки упражнения (агент Y): маршрут 'learn' приходит с { lesson, returnTo }.
  const route = activeRoute();
  if (route?.name === 'learn' && route.lesson && !consumed.has(route)) {
    consumed.add(route);
    prepareLesson(route.lesson, { returnTo: route.returnTo || null });
  }
  const poker = net.state?.games?.find?.((g) => g.id === 'poker');
  renderLearn(container, {
    back: api.close,
    // кнопка «Вернуться к заданию» — её рисует связка (Y), когда есть куда возвращаться
    returnButton: () => hooks.returnButton?.() || null,
    school: poker?.catalog?.school || null,
    // «Потренироваться»: кнопка есть, только когда по теме уже есть упражнения.
    hasTraining: (topic) => !!exerciseOfTopic(topic),
    openTraining: ({ topic }) => {
      const ex = exerciseOfTopic(topic);
      if (ex) openRoute('train-ex', { track: ex.track, topic });
    },
  });
};
