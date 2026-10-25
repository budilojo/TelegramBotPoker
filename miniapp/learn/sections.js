/**
 * Курс «Обучение»: разделы и уроки — ДАННЫЕ, не экран. Добавить урок = добавить объект
 * в файл раздела (`content/<раздел>.js`) и тему в `miniapp/train/topics.js`.
 *
 * Урок = {
 *   topic,            // id из реестра тем (одна тема — один урок)
 *   goal,             // «что вы узнаете» одной строкой
 *   needs: [topic],   // что полезно знать до этого (только темы того же или более раннего раздела)
 *   blocks: [         // короткие блоки; тексты могут содержать {{fact:id|формат}} и {{in:…}}
 *     ['p', 'текст'], ['h', 'подзаголовок'], ['list', ['пункт', …]],
 *     ['rule', 'пометка: правило порядка, не точный расчёт'],
 *     ['show', 'ladder' | 'tree'],               // готовая схема
 *     ['play', 'имя из play.js', {props}],       // интерактивный пример
 *   ],
 *   remember: [3 пункта],
 *   quiz: [{ q, options: [..], right: индекс, why }],
 * }
 */
import { LESSON_SECTIONS, TOPICS, topicById } from '../train/topics.js';
import { lessons as basics } from './content/basics.js';
import { lessons as preflop } from './content/preflop.js';
import { lessons as ranges } from './content/ranges.js';
import { lessons as math } from './content/math.js';
import { lessons as postflop } from './content/postflop.js';
import { lessons as gto } from './content/gto.js';

const BY_SECTION = { basics, preflop, ranges, math, postflop, gto };

/** Разделы в порядке «от простого к сложному» вместе с уроками. */
export const SECTIONS = LESSON_SECTIONS.map((s) => ({
  ...s,
  lessons: (BY_SECTION[s.id] || []).map((l) => ({ ...l, section: s.id, title: topicById(l.topic)?.title || l.topic })),
}));

export const allLessons = () => SECTIONS.flatMap((s) => s.lessons);

const BY_TOPIC = new Map(allLessons().map((l) => [l.topic, l]));

/** Урок по теме (для кнопки «Изучить тему» у агента Y) или null. */
export const lessonFor = (topicId) => BY_TOPIC.get(topicId) || null;

/** Следующий непрочитанный урок по порядку курса (с учётом `needs`), или null. */
export function nextLesson(readSet) {
  const list = allLessons();
  return list.find((l) => !readSet.has(l.topic) && l.needs.every((n) => readSet.has(n))) || list.find((l) => !readSet.has(l.topic)) || null;
}

export { TOPICS };
