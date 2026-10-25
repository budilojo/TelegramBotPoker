/**
 * Экраны курса «Обучение»: список разделов и урок. Чужому коду (форме покера, «Тренировке»)
 * нужны две функции:
 *
 *   renderLearn(container, { back, school, openTraining })
 *   openLesson(topicId, { returnTo, container, back, openTraining })
 *
 * `container` — пустой элемент экрана; курс рисует внутри него и сам переключает «список»
 * и «урок», не трогая остальное приложение. Внутри урока все интерактивные примеры меняют
 * только свои узлы (см. parts.js) — экран не «прыгает».
 *
 * `returnButton()` — элемент «Вернуться к заданию» от связки (или null).
 * `hasTraining(topic)` — есть ли упражнения по теме (иначе кнопки «Потренироваться» нет).
 * `school` — список уроков «Школы покера» (`catalog.school` от сервера): если передан,
 * в курсе есть «Практика с наставником». `openTraining({topic})` — вход в Тренировку по теме
 * (отдаёт агент Y); пока его нет, кнопки «Потренироваться» просто нет.
 * `returnTo = { go() }` — куда вернуть после урока, открытого из ошибки упражнения.
 */
import { h, haptic } from '../ui.js';
import { schoolItems } from '../school.js';
import { SECTIONS, allLessons, lessonFor, nextLesson } from './sections.js';
import { readTopics, markRead, quizBest, saveQuiz } from './progress.js';
import { fillFacts } from './facts.js';
import { ladder, actionTree } from './diagrams.js';
import { PLAY } from './play.js';
import { tag } from './parts.js';

let host = null;
let hostOpts = {};
/**
 * Что сейчас на экране курса. Страница перерисовывает экран при каждом новом состоянии
 * сервера, а курс не должен при этом «забывать», где вы: урок остаётся уроком.
 */
let view = { kind: 'course' };

/**
 * Заранее выбрать урок, который покажет следующий `renderLearn` (так «Изучить тему» из ошибки
 * упражнения открывает полный экран курса сразу на нужном уроке).
 */
export function prepareLesson(topicId, { returnTo = null } = {}) {
  if (!lessonFor(topicId)) return false;
  view = { kind: 'lesson', topic: topicId, returnTo };
  return true;
}

/* ---------------------------------------------------------- блоки */

const txt = (s) => fillFacts(s);

function renderBlock([kind, a, b]) {
  switch (kind) {
    case 'p': return h('p.ln-p', txt(a));
    case 'h': return h('h3.ln-h', txt(a));
    case 'list': return h('ul.ln-list', a.map((x) => h('li', txt(x))));
    case 'rule': return h('div.ln-rule', tag('Правило порядка'), h('p.ln-p', txt(a)));
    case 'show': return a === 'ladder' ? ladder() : actionTree();
    case 'play': return PLAY[a](b || {});
    default: throw new Error(`неизвестный блок «${kind}»`);
  }
}

function renderQuiz(lesson) {
  const qs = lesson.quiz;
  let right = 0; let answered = 0;
  const cards = qs.map((q) => {
    const why = h('p.ln-p.ln-why', { hidden: true });
    const buttons = q.options.map((o, i) => h('button.ln-option', { type: 'button' }, o));
    buttons.forEach((b, i) => b.addEventListener('click', () => {
      if (why.hidden === false) return;
      const ok = i === q.right;
      right += ok ? 1 : 0; answered += 1;
      buttons.forEach((x, k) => { x.disabled = true; x.classList.toggle('right', k === q.right); x.classList.toggle('wrong', k === i && !ok); });
      why.hidden = false;
      why.textContent = `${ok ? '✓ Верно. ' : '✗ Не совсем. '}${txt(q.why)}`;
      haptic.tap();
      if (answered === qs.length) saveQuiz(lesson.topic, right, qs.length);
    }));
    return h('div.ln-q', h('b', txt(q.q)), h('div.ln-options', buttons), why);
  });
  return h('div.ln-quiz', h('h3.ln-h', 'Проверьте себя'), cards);
}

/* ------------------------------------------------------- экран урока */

export function openLesson(topicId, opts = {}) {
  const box = opts.container || host;
  if (!box) return false;
  const o = { ...hostOpts, ...opts };
  const lesson = lessonFor(topicId);
  if (!lesson) return false;
  host = box; hostOpts = { ...hostOpts, ...o };
  view = { kind: 'lesson', topic: topicId, returnTo: o.returnTo || null };
  const sec = SECTIONS.find((s) => s.id === lesson.section);
  const list = allLessons(); const idx = list.indexOf(lesson);
  const backToCourse = () => { view = { kind: 'course' }; renderLearn(box, o); };
  const backFn = o.returnTo?.go ? () => o.returnTo.go() : backToCourse;
  const finish = () => { markRead(lesson.topic); haptic.tap(); };
  const next = list[idx + 1];

  box.replaceChildren(h('div.learn.hub.ln-lesson',
    h('button.back-link', { type: 'button', onclick: backFn }, o.returnTo?.go ? '← Вернуться к заданию' : '← К курсу'),
    h('div.hub-head', h('div.sub', `${sec.title} · урок ${sec.lessons.indexOf(lesson) + 1} из ${sec.lessons.length}`), h('h1', lesson.title)),
    h('div.ln-goal', h('b', 'Что вы узнаете'), h('p.ln-p', lesson.goal)),
    lesson.blocks.map(renderBlock),
    h('div.ln-remember', h('h3.ln-h', 'Запомните'), h('ul.ln-list', lesson.remember.map((x) => h('li', txt(x))))),
    renderQuiz(lesson),
    h('div.ln-actions',
      o.openTraining && (o.hasTraining ? o.hasTraining(lesson.topic) : true) ? h('button.k-btn.k-btn--secondary.k-btn--block', { type: 'button', onclick: () => { finish(); o.openTraining({ topic: lesson.topic }); } }, 'Потренироваться') : null,
      o.returnButton?.(),
      o.returnTo?.go ? h('button.k-btn.k-btn--primary.k-btn--block', { type: 'button', onclick: () => { finish(); o.returnTo.go(); } }, 'Вернуться к заданию') : null,
      h('button.k-btn.k-btn--block' + (o.returnTo?.go ? '.k-btn--ghost' : '.k-btn--primary'), {
        type: 'button',
        onclick: () => { finish(); if (next && !o.returnTo) openLesson(next.topic, { container: box }); else backToCourse(); },
      }, next && !o.returnTo ? `Урок пройден · дальше: ${next.title}` : 'Урок пройден'))));
  box.scrollIntoView?.({ block: 'start' });
  return true;
}

/* ------------------------------------------------------ экран курса */

export function renderLearn(container, opts = {}) {
  host = container; hostOpts = { ...opts };
  if (view.kind === 'lesson' && lessonFor(view.topic)) return void openLesson(view.topic, { container, returnTo: view.returnTo, ...opts });
  if (view.kind === 'mentor' && opts.school?.length) return showMentor(container, opts);
  view = { kind: 'course' };
  const done = readTopics();
  const total = allLessons().length;
  const rec = nextLesson(done);
  const lessonBtn = (l, i) => {
    const best = quizBest(l.topic);
    return h('button.menu-item.ln-lesson-item', { type: 'button', onclick: () => { haptic.soft(); openLesson(l.topic, { container, back: opts.back }); } },
      `${done.has(l.topic) ? '✓' : `${i + 1}.`} ${l.title}`,
      h('small', l.goal),
      best ? h('small.ln-best', `Проверка: ${best.right} из ${best.total}`) : null);
  };
  container.replaceChildren(h('div.learn.hub',
    opts.back ? h('button.back-link', { type: 'button', onclick: opts.back }, '← Назад') : null,
    h('div.hub-head', h('h1', 'Обучение'), h('div.sub', `От простого к сложному: ${done.size} из ${total} уроков прочитано. Можно идти по порядку или открыть любой.`)),
    rec ? h('button.k-btn.k-btn--primary.k-btn--block', { type: 'button', onclick: () => openLesson(rec.topic, { container, back: opts.back }) },
      done.size ? `▶ Продолжить: ${rec.title}` : `▶ Начать: ${rec.title}`) : h('div.hint', 'Все уроки прочитаны. Можно вернуться к любому.'),
    SECTIONS.map((s) => {
      const n = s.lessons.filter((l) => done.has(l.topic)).length;
      return h('div.ln-section',
        h('div.section-label', s.title),
        h('div.sub', `${n} из ${s.lessons.length}`),
        h('div.menu-list', s.lessons.map(lessonBtn)));
    }),
    opts.school?.length ? h('div.ln-section', h('div.section-label', 'Практика'),
      h('div.menu-list', h('button.menu-item', { type: 'button', onclick: () => showMentor(container, opts) }, 'Практика с наставником', h('small', 'настоящие раздачи с разбором и подсказками наставника'))))
      : null));
}

/** Существующая «Школа покера» — азбука и уроки-раздачи; кнопка «назад» возвращает в курс. */
function showMentor(container, opts) {
  view = { kind: 'mentor' };
  container.replaceChildren(h('div.learn.hub',
    h('button.back-link', { type: 'button', onclick: () => { view = { kind: 'course' }; renderLearn(container, opts); } }, '← К курсу'),
    h('div.hub-head', h('h1', 'Практика с наставником')),
    ...schoolItems(opts.school, () => showMentor(container, opts))));
}
