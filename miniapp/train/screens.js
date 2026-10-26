/**
 * Экраны «Тренировки»: направления → направление → задание с разбором →
 * итоги подхода; «Мой прогресс». Рисуются поверх хаба (route.js), сервер о них
 * не знает, кроме личного прогресса (`{t:'train'}`, bot/train.js).
 *
 * Правило против «прыжков» экрана: нажатие меняет классы и блоки НА МЕСТЕ,
 * контейнер прокрутки не пересоздаётся; приходящий прогресс обновляет только
 * блоки-«секции» внутри него. Полная перерисовка — лишь при смене экрана.
 */
import { $app, h, haptic, toast, showSheet, closeSheet } from '../ui.js';
import { bus, send } from '../net.js';
import { TRACKS, SKILLS, LEVELS, LEVEL_NAMES, topicById, trackById } from './topics.js';
import {
  ROUND, instantiate, grade, pickExercise, exercisesOf, exerciseById, coverage, newSeed,
} from './engine.js';
import { PASS_SCORE } from './skills.js';
import { activeRoute, openRoute, closeRoute, hooks } from './route.js';
import './content/index.js';
import * as choice from './widgets/choice.js';
import * as explain from './widgets/explain.js';
import * as bar from './widgets/progress-bar.js';

/**
 * Виджеты ответа по виду задания. Новый вид = модуль виджета + строка здесь
 * (`import * as rangeGrid from './widgets/range-grid.js'` и `range: rangeGrid`).
 */
import * as cardsW from './widgets/cards.js';
import * as sliderW from './widgets/odds-bar.js';
import * as betW from './widgets/bet-slider.js';
import * as tableW from './widgets/table-seat.js';
import * as rangeGrid from './widgets/range-grid.js';
export const ANSWER_WIDGETS = { pick: choice, cards: cardsW, slider: sliderW, bet: betW, table: tableW, range: rangeGrid };

const EMPTY = { started: false, total: 0, skills: [], tracks: [], weak: [], due: [], mistakes: [], masteredTopics: [] };
const M = {
  progress: null,
  /** Идёт подход: { track, level, i, results:[{score,topics}], recent:[], fixed:{exercise,seed}|null, passed:[] }. */
  run: null,
  /** Текущее задание: { exercise, seed, task, value, review, t0, saved }. */
  cur: null,
};
let sections = [];

export const P = () => M.progress || EMPTY;
const skillRow = (id) => P().skills.find((s) => s.id === id) || { id, level: 1, rating: 0, n: 0, mastered: false, suggest: null };
const trackRow = (id) => P().tracks.find((t) => t.id === id) || { id, passed: [], passedCount: 0, total: 0, accuracy: null };
const levelOfTrack = (t) => skillRow(trackById(t).skill).level;
const hasTasks = (t) => exercisesOf({ track: t }).length > 0;

/* ------------------------------------------------------------ связь с сервером */

bus.onTrain = (msg) => {
  if (msg.error) return void toast(msg.error.text || 'Не получилось');
  if (msg.progress) M.progress = msg.progress;
  if (msg.result && M.run) {
    if (msg.result.passedLevel) M.run.passed.push(msg.result.passedLevel);
  }
  const r = activeRoute();
  if (!r) return;
  if (r.name === 'train-sum') return void bus.render();
  if (r.name !== 'train-ex') patchSections();
};

const ask = (msg) => send({ t: 'train', ...msg }, { lock: false });

/* ------------------------------------------------------------ вход в экран */

export function render() {
  const r = activeRoute();
  if (r.name !== 'train') M.placing = false;
  sections = [];
  if (!M.progress) ask({ op: 'get' });
  const screens = { train: home, 'train-track': trackScreen, 'train-ex': exerciseScreen, 'train-sum': summary, 'train-stats': stats, learn: learnScreen };
  $app.append((screens[r.name] || home)(r));
}

/** Блок, который переживает приход нового прогресса: перерисовывается на месте. */
function section(build) {
  const el = h('div.tr-sec');
  const rec = { el, build };
  sections.push(rec);
  el.replaceChildren(...[].concat(build()).flat(Infinity).filter(Boolean));
  return el;
}
function patchSections() {
  for (const rec of sections) rec.el.replaceChildren(...[].concat(rec.build()).flat(Infinity).filter(Boolean));
}

const back = (text, fn) => h('button.back-link', { type: 'button', onclick: () => { haptic.soft(); fn(); } }, text);
const dots = (t) => {
  const row = trackRow(t);
  return h('span.tr-dots', { 'aria-hidden': 'true' }, Array.from({ length: LEVELS }, (_, i) => h(`i${row.passed.includes(i + 1) ? '.on' : ''}`)));
};
const levelText = (l) => `Уровень ${l} из ${LEVELS} · ${LEVEL_NAMES[l - 1]}`;

/* --------------------------------------------------------------- рекомендации */

/**
 * Что делать дальше (до 3), каждая — с объяснением одной строкой:
 * 1) тема, которой пора повторение; 2) следующий непройденный уровень в наименее
 * проработанном направлении; 3) «закрепить» — где точность ниже всего.
 */
export function recommend(p = P()) {
  const out = [];
  const used = new Set();
  const push = (r) => { if (!used.has(r.track)) { used.add(r.track); out.push(r); } };
  for (const w of p.weak.filter((x) => x.due)) {
    const ex = exercisesOf({ topic: w.topic })[0];
    if (ex) push({ kind: 'review', track: ex.track, topic: w.topic, level: skillRow(ex.skill).level, why: `Пора повторить «${topicById(w.topic)?.title}» — вы в ней ошибались.` });
    if (out.length) break;
  }
  const open = TRACKS.filter((t) => hasTasks(t.id)).map((t) => ({ t, row: trackRow(t.id), level: levelOfTrack(t.id) }))
    .filter((x) => !x.row.passed.includes(x.level)).sort((a, b) => a.row.total - b.row.total);
  if (open[0]) push({ kind: 'next', track: open[0].t.id, level: open[0].level, why: `Уровень ${open[0].level} в «${open[0].t.title}» ещё не пройден.` });
  const weakest = TRACKS.map((t) => ({ t, row: trackRow(t.id) })).filter((x) => x.row.passedCount > 0 && x.row.accuracy != null && hasTasks(x.t.id))
    .sort((a, b) => a.row.accuracy - b.row.accuracy)[0];
  if (weakest) push({ kind: 'consolidate', track: weakest.t.id, level: levelOfTrack(weakest.t.id), why: `Закрепить: точность в «${weakest.t.title}» — ${weakest.row.accuracy}%.` });
  return out.slice(0, 3);
}

const recCard = (r) => h('button.k-btn.k-btn--secondary.tr-rec', { type: 'button', onclick: () => startRun({ track: r.track, topic: r.topic || null }) },
  h('span.tr-rec-body', h('b', `${trackById(r.track).title}`), h('small', r.why)), h('span.gc-go', '▶'));

/* -------------------------------------------------------------------- главная */

function home() {
  // Первый запуск: определение уровня (агент Y) вместо списка направлений.
  if ((M.placing || hooks.needsPlacement?.(P())) && hooks.placement) {
    // Экран рисует себя сам, в своём корне (data-self: app.js не отдаёт его содержимое другому узлу).
    const box = h('div.lobby.hub.tr', { 'data-self': 'placement' });
    const leave = () => { M.placing = false; openRoute('train'); };
    hooks.placement(box, { done: leave, exit: leave });
    return box;
  }
  const root = h('div.lobby.hub.tr',
    back('← К покеру', closeRoute),
    h('div.hub-head', h('h1', 'Тренировка'), h('div.sub', 'Задания по картам и ставкам с разбором. Прогресс видите только вы.')),
    section(() => {
      const rec = recommend()[0];
      return [
        !P().started ? h('div.tr-note', 'Выберите направление и решите первый подход из 10 заданий — прогресс сохранится.') : null,
        rec ? h('div.tr-recbox', h('div.section-label', 'Рекомендуем сейчас'), recCard(rec)) : null,
        h('div.section-label', 'Направления'),
        h('div.game-cards', TRACKS.map((t) => h('button.game-card.tr-track' + (hasTasks(t.id) ? '' : '.soon'), {
          type: 'button', 'data-track': t.id,
          onclick: () => { if (!hasTasks(t.id)) return void toast('Задания этого направления появятся скоро.'); haptic.soft(); openRoute('train-track', { track: t.id }); },
        }, h('div.gc-body', h('div.gc-title', t.title), h('div.gc-blurb', t.blurb),
          h('div.tr-meta', hasTasks(t.id) ? levelText(levelOfTrack(t.id)) : 'Скоро')),
        hasTasks(t.id) ? dots(t.id) : null, h('span.gc-go', '›')))),
        h('button.k-btn.k-btn--secondary.k-btn--block', { type: 'button', 'data-go': 'stats', onclick: () => { haptic.soft(); openRoute('train-stats'); } }, 'Мой прогресс'),
        hooks.placement ? h('button.k-btn.k-btn--ghost.k-btn--block', { type: 'button', 'data-go': 'placement', onclick: () => { haptic.soft(); M.placing = true; openRoute('train'); } }, 'Определить уровень заново') : null,
      ];
    }));
  return root;
}

/* ---------------------------------------------------------------- направление */

function trackScreen({ track }) {
  const t = trackById(track);
  const skill = t.skill;
  const cov = coverage()[track] || [];
  return h('div.lobby.hub.tr',
    back('← Тренировка', () => openRoute('train')),
    h('div.hub-head', h('h1', t.title), h('div.sub', t.blurb)),
    section(() => {
      const s = skillRow(skill);
      const sk = SKILLS.find((x) => x.id === skill);
      const row = trackRow(track);
      return [
        h('div.section-label', `Сложность · навык «${sk.title}»`),
        h('div.seg.tr-levels', { role: 'group' }, Array.from({ length: LEVELS }, (_, i) => h(`button${s.level === i + 1 ? '.on' : ''}`, {
          type: 'button', 'data-level': i + 1, 'aria-pressed': String(s.level === i + 1),
          onclick: () => { if (s.level === i + 1) return; haptic.soft(); ask({ op: 'level', skill, level: i + 1 }); markLevel(i + 1); },
        }, String(i + 1)))),
        h('div.hint.tr-lvname', `${LEVEL_NAMES[s.level - 1]}. Уровень выбираете вы; программа только предлагает.`),
        s.suggest ? h('div.tr-suggest', h('div', s.suggest.text), h('div.tr-suggest-btns',
          h('button.k-btn.k-btn--primary.k-btn--compact', { type: 'button', onclick: () => { haptic.tap(); ask({ op: 'level', skill, level: s.suggest.to }); } }, `Перейти на ${s.suggest.to}-й`),
          h('button.k-btn.k-btn--ghost.k-btn--compact', { type: 'button', onclick: () => { haptic.soft(); ask({ op: 'level', skill, level: s.level }); } }, 'Остаться'))) : null,
        h('div.section-label', 'Уровни'),
        h('ul.tr-lv-list', Array.from({ length: LEVELS }, (_, i) => h(`li${s.level === i + 1 ? '.cur' : ''}`,
          h('span', `${row.passed.includes(i + 1) ? '✓ ' : ''}${i + 1}. ${LEVEL_NAMES[i]}`),
          h('small', cov.includes(i + 1) ? `${exercisesOf({ track, level: i + 1 }).length} заданий` : 'пока нет')))),
        row.accuracy != null ? h('div.hint', `Точность за 30 дней: ${row.accuracy}%`) : null,
        h('button.k-btn.k-btn--primary.k-btn--block.tr-start', { type: 'button', 'data-go': 'start', onclick: () => { haptic.tap(); startRun({ track }); } }, `▶ Начать подход (${ROUND} заданий)`),
      ];
    }));
}

/** Подсветить выбранный уровень сразу, не дожидаясь ответа сервера. */
function markLevel(level) {
  document.querySelectorAll('.tr-levels button').forEach((b) => {
    const on = Number(b.dataset.level) === level;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

/* --------------------------------------------------------------------- подход */

export function startRun({ track, topic = null, exercise = null, seed = null, level = null }) {
  const lvl = level || levelOfTrack(track);
  M.run = { track, level: lvl, topic, i: 0, results: [], recent: [], fixed: exercise ? { exercise, seed } : null, passed: [] };
  nextTask();
}

function nextTask() {
  const run = M.run;
  if (run.i >= ROUND) return void openRoute('train-sum');
  let exercise;
  let seed = newSeed();
  if (run.fixed && run.i === 0 && exerciseById(run.fixed.exercise)) {
    exercise = exerciseById(run.fixed.exercise);
    if (Number.isInteger(run.fixed.seed)) seed = run.fixed.seed;
  } else {
    exercise = pickExercise({ track: run.track, level: run.level, topic: run.topic, recent: run.recent })?.exercise;
  }
  if (!exercise) {
    toast('Для этого направления пока нет заданий.');
    return void openRoute('train');
  }
  loadTask(exercise, seed);
  openRoute('train-ex');
}

function loadTask(exercise, seed) {
  const { task } = instantiate(exercise.id, seed);
  M.cur = { exercise, seed, task, value: null, review: null, t0: Date.now() };
}

/* --------------------------------------------------------------------- задание */

function exerciseScreen() {
  if (!M.cur || !M.run) return home();
  const { run, cur } = M;
  const { exercise, task } = cur;
  const mod = ANSWER_WIDGETS[exercise.kind];
  const t = trackById(run.track);
  const host = h('div.tr-widget');
  const reviewHost = h('div.tr-review');
  const props = () => ({ setup: task.setup, value: cur.value, disabled: !!cur.review, result: cur.review, task, onChange });
  let wEl = null;

  function onChange(v) {
    if (cur.review) return;
    cur.value = v;
    if (wEl) mod.update?.(wEl, props());
    drawFoot();
  }
  if (mod) {
    wEl = mod.mount(props());
    host.append(wEl);
  } else {
    host.append(h('div.tr-note', 'Этот вид задания ещё не подключён.'));
  }
  if (cur.review) reviewHost.append(explain.mount({ review: cur.review }));

  /** Ответ готов к проверке: по умолчанию «что-то выбрано»; многошаговые задания говорят сами (task.isComplete). */
  const ready = () => (cur.value != null && (typeof task.isComplete !== 'function' || !!task.isComplete(cur.value)));
  const foot = h('div.tr-foot');
  function drawFoot() {
    const done = !!cur.review;
    const lastOne = run.i + 1 >= ROUND;
    const topic = cur.review?.mistakes[0]?.topic || exercise.topic;
    foot.replaceChildren(...[
      done ? h('button.k-btn.k-btn--primary.k-btn--block', { type: 'button', 'data-go': 'next', onclick: () => { haptic.tap(); run.i += 1; run.recent.push(exercise.id); nextTask(); } }, lastOne ? 'Итоги подхода' : 'Дальше')
        : h('button.k-btn.k-btn--primary.k-btn--block', { type: 'button', 'data-go': 'check', disabled: !ready() || !mod, onclick: check }, 'Проверить'),
      done ? h('div.tr-foot-row',
        h('button.k-btn.k-btn--secondary.k-btn--compact', { type: 'button', 'data-go': 'again', onclick: () => { haptic.soft(); loadTask(exercise, cur.seed); bus.render(); } }, 'Повторить это'),
        !cur.review.ok && hooks.openLesson ? h('button.k-btn.k-btn--secondary.k-btn--compact', { type: 'button', 'data-go': 'lesson', onclick: () => { haptic.soft(); hooks.openLesson(topic, { returnTo: { exercise: exercise.id, seed: cur.seed } }); } }, 'Изучить тему') : null) : null].filter(Boolean)); // null в replaceChildren стал бы словом «null» на экране
  }

  function check() {
    if (!ready() || cur.review) return;
    let review;
    try {
      review = grade(task, cur.value);
    } catch (err) {
      console.warn('train: check упал', err);
      return void toast('Не удалось проверить это задание.');
    }
    haptic.tap();
    cur.review = review;
    if (review.ok) hooks.endChain?.();
    run.results.push({ score: review.score, topics: review.mistakes.map((m) => m.topic) });
    // Сервер принимает коды ошибок строками (до 8); тема в журнале — тема задания.
    const codes = [...new Set(review.mistakes.map((m) => m.code))].filter((c) => /^[a-z0-9][a-z0-9._-]{0,39}$/i.test(c)).slice(0, 8);
    ask({ op: 'result', ex: exercise.id, track: run.track, topic: exercise.topic, level: exercise.level, score: review.score, ms: Math.min(3_600_000, Date.now() - cur.t0), mistakes: codes, seed: cur.seed });
    if (wEl) mod.update?.(wEl, props());
    reviewHost.replaceChildren(explain.mount({ review }));
    drawFoot();
    reviewHost.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }
  drawFoot();

  const leave = () => {
    hooks.endChain?.();
    if (cur.value != null && !cur.review) return void confirmLeave();
    openRoute('train-track', { track: run.track });
  };
  return h('div.tr-ex',
    h('div.tr-head',
      h('button.tr-back', { type: 'button', 'aria-label': 'Назад', onclick: () => { haptic.soft(); leave(); } }, '←'),
      h('div.tr-head-t', h('b', t.title), h('small', `Уровень ${exercise.level} · ${Math.min(run.i + 1, ROUND)}/${ROUND}`)),
      h('div.tr-head-bar', bar.mount({ value: run.i / ROUND, label: 'Прогресс подхода' }))),
    h('div.tr-body', h('h2.tr-prompt', task.prompt), host, reviewHost),
    foot);
}

function confirmLeave() {
  showSheet('train-leave', () => h('div',
    h('h3', 'Выйти из задания?'),
    h('div.sub', 'Ваш ответ ещё не проверен — он не сохранится.'),
    h('div.k-actions', { style: { marginTop: '16px' } },
      h('button.k-btn.k-btn--primary.k-btn--block', { type: 'button', onclick: closeSheet }, 'Остаться'),
      h('button.k-btn.k-btn--secondary.k-btn--block', { type: 'button', 'data-go': 'leave', onclick: () => { closeSheet(); openRoute('train-track', { track: M.run.track }); } }, 'Выйти'))));
}

/* --------------------------------------------------------------------- итоги */

function summary() {
  const run = M.run;
  if (!run) return home();
  const t = trackById(run.track);
  const good = run.results.filter((r) => r.score >= PASS_SCORE).length;
  const topics = [...new Set(run.results.flatMap((r) => r.topics))];
  return h('div.lobby.hub.tr',
    h('div.hub-head', h('h1', 'Подход закончен'), h('div.sub', t.title)),
    h('div.tr-total', h('b', `${good} из ${run.results.length}`), ' верно'),
    ...run.passed.map((p) => h('div.tr-suggest.ok', `Уровень ${p.level} в этом направлении пройден!`)),
    section(() => {
      const s = skillRow(t.skill);
      return s.suggest ? h('div.tr-suggest', h('div', s.suggest.text), h('div.tr-suggest-btns',
        h('button.k-btn.k-btn--primary.k-btn--compact', { type: 'button', onclick: () => { haptic.tap(); ask({ op: 'level', skill: t.skill, level: s.suggest.to }); run.level = s.suggest.to; } }, `Перейти на ${s.suggest.to}-й`),
        h('button.k-btn.k-btn--ghost.k-btn--compact', { type: 'button', onclick: () => ask({ op: 'level', skill: t.skill, level: s.level }) }, 'Остаться'))) : null;
    }),
    topics.length ? h('div.tr-block', h('div.section-label', 'Над чем стоит поработать'),
      h('ul.tr-list', topics.map((id) => h('li', topicById(id)?.title || id)))) : null,
    h('button.k-btn.k-btn--primary.k-btn--block', { type: 'button', 'data-go': 'more', onclick: () => { haptic.tap(); startRun({ track: run.track }); } }, 'Ещё подход'),
    h('button.k-btn.k-btn--secondary.k-btn--block', { type: 'button', onclick: () => openRoute('train-track', { track: run.track }) }, 'К направлению'),
    h('button.k-btn.k-btn--ghost.k-btn--block', { type: 'button', onclick: () => openRoute('train-stats') }, 'Мой прогресс'));
}

/* ----------------------------------------------------------------- статистика */

function stats() {
  return h('div.lobby.hub.tr',
    back('← Тренировка', () => openRoute('train')),
    h('div.hub-head', h('h1', 'Мой прогресс'), h('div.sub', 'Видите только вы. Победы и фишки здесь не считаются — только качество решений.')),
    section(() => {
      const p = P();
      if (!p.started) {
        return [h('div.tr-note', 'Пока нет ни одного решённого задания. Начните с любого направления — здесь появятся уровни, точность и ошибки.'),
          h('button.k-btn.k-btn--primary.k-btn--block', { type: 'button', onclick: () => openRoute('train') }, 'К направлениям')];
      }
      const rec = recommend(p);
      return [
        rec.length ? h('div.tr-recbox', h('div.section-label', 'Рекомендуем дальше'), rec.map(recCard)) : null,
        h('div.section-label', 'Навыки'),
        h('div.tr-skills', SKILLS.map((sk) => {
          const s = skillRow(sk.id);
          return h('div.tr-skill', h('div.tr-skill-top', h('b', sk.title), h('small', `${levelText(s.level)}${s.mastered ? ' · освоен' : ''}`)),
            bar.mount({ value: s.rating / 100, label: `${sk.title}: ${Math.round(s.rating)} из 100` }));
        })),
        h('div.section-label', 'Направления'),
        h('ul.tr-rows', TRACKS.map((t) => {
          const r = trackRow(t.id);
          return h('li', h('span', t.title), h('small', `пройдено уровней: ${r.passedCount} из ${LEVELS} · точность ${r.accuracy == null ? '—' : r.accuracy + '%'}`));
        })),
        p.weak.length ? [h('div.section-label', 'Повторение'), h('ul.tr-rows', p.weak.map((w) => h('li', h('span', topicById(w.topic)?.title || w.topic), h('small', w.due ? 'пора повторить' : `через ${Math.max(1, Math.ceil((w.dueAt - p.now) / 86_400_000))} дн.`))))] : null,
        p.mistakes.length ? [h('div.section-label', 'Последние ошибки'), h('ul.tr-rows', p.mistakes.map((m) => h('li', h('span', topicById(m.topic)?.title || m.topic), h('small', `ошибок: ${m.n}`),
          hooks.openLesson ? h('button.k-btn.k-btn--secondary.k-btn--compact', { type: 'button', onclick: () => hooks.openLesson(m.topic, { returnTo: null }) }, 'Изучить тему') : null)))] : null,
        hooks.decisionSettings ? (() => { const ds = h('div.tr-ds'); hooks.decisionSettings(ds); return ds; })() : null,
        h('button.k-btn.k-btn--ghost.k-btn--block.tr-reset', { type: 'button', 'data-go': 'reset', onclick: confirmReset }, 'Сбросить мой прогресс'),
      ];
    }));
}

function confirmReset() {
  showSheet('train-reset', () => h('div',
    h('h3', 'Сбросить прогресс?'),
    h('div.sub', 'Уровни, статистика и история ошибок в Тренировке будут стёрты. Вернуть их нельзя.'),
    h('div.k-actions', { style: { marginTop: '16px' } },
      h('button.k-btn.k-btn--primary.k-btn--block', { type: 'button', onclick: closeSheet }, 'Оставить'),
      h('button.k-btn.k-btn--secondary.k-btn--block', { type: 'button', 'data-go': 'reset-yes', onclick: () => { closeSheet(); ask({ op: 'reset' }); } }, 'Сбросить'))));
}

/* ------------------------------------------------------------------ Обучение */

/** Экран «Обучение» рисует агент U (hooks.renderLearn); пока его нет — честная заглушка. */
function learnScreen() {
  const root = h('div.lobby.hub.tr', { 'data-self': 'learn' }, back('← К покеру', closeRoute));
  if (hooks.renderLearn) hooks.renderLearn(root, { close: closeRoute });
  else root.append(h('div.hub-head', h('h1', 'Обучение')), h('div.tr-note', 'Курс скоро появится.'));
  return root;
}
