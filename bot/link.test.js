'use strict';
/** Связка Обучение ↔ Тренировка (агент Y): возврат к тому же заданию, нет цикла; рекомендации. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../miniapp/train/link.js';
import { recommend } from '../miniapp/train/recommend.js';

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), raw: m };
}
function setup() {
  const calls = [];
  const st = fakeStorage();
  L.setStorage(st);
  L.clearLink();
  L.setRouter({
    lesson: (...a) => calls.push(['lesson', ...a]),
    exercise: (...a) => calls.push(['exercise', ...a]),
    training: (...a) => calls.push(['training', ...a]),
    home: (...a) => calls.push(['home', ...a]),
  });
  return { calls, st };
}

test('ошибка → урок → «Вернуться к заданию» открывает ТО ЖЕ упражнение с ТЕМ ЖЕ seed', () => {
  const { calls } = setup();
  L.openLesson('pot-odds', { returnTo: { exercise: 'potodds-3-a', seed: 424242 } });
  assert.deepEqual(calls[0], ['lesson', 'pot-odds', { returnTo: { exercise: 'potodds-3-a', seed: 424242 } }]);
  assert.ok(L.pending());
  assert.equal(L.returnToTask(), true);
  assert.deepEqual(calls[1], ['exercise', 'potodds-3-a', 424242, { repeat: true, replace: true }]);
});

test('контекст переживает перезагрузку WebView (sessionStorage), а не только память', () => {
  const { st } = setup();
  L.openLesson('ev', { returnTo: { exercise: 'ev-1', seed: 7 } });
  const saved = st.raw.get('train.link');
  assert.ok(saved);
  // «перезагрузка»: новая память, то же хранилище
  const calls = [];
  L.setStorage(fakeStorage()); // пустая память модуля не должна подменить хранилище
  L.setStorage(st);
  L.setRouter({ exercise: (...a) => calls.push(a) });
  assert.equal(L.pending().seed, 7);
  assert.equal(L.returnToTask(), true);
  assert.deepEqual(calls[0].slice(0, 2), ['ev-1', 7]);
});

test('без контекста вернуться некуда; мусор в хранилище не ломает', () => {
  const { st } = setup();
  assert.equal(L.returnToTask(), false);
  st.setItem('train.link', '{не json');
  assert.equal(L.pending(), null);
  st.setItem('train.link', JSON.stringify({ exercise: 5, seed: 'x' }));
  assert.equal(L.pending(), null);
});

test('урок без возврата (из «Обучения») контекст не создаёт', () => {
  const { calls } = setup();
  L.openLesson('pot-odds');
  assert.equal(L.pending(), null);
  assert.equal(calls[0][2].returnTo, null);
});

test('нет бесконечного цикла урок → задание → урок: после MAX_HOPS — «домой»', () => {
  const { calls } = setup();
  let reason = null;
  for (let i = 0; i < L.MAX_HOPS + 1; i++) {
    const r = L.openLesson('pot-odds', { returnTo: { exercise: 'x', seed: 1 } });
    if (!r.ok) reason = r.reason;
    else L.returnToTask();
  }
  assert.equal(reason, 'loop');
  assert.equal(calls.at(-1)[0], 'home');
  assert.equal(L.pending(), null);
});

test('endChain сбрасывает цепочку; новая ошибка начинает счёт заново', () => {
  setup();
  for (let i = 0; i < 2; i++) { L.openLesson('ev', { returnTo: { exercise: 'x', seed: 1 } }); L.returnToTask(); }
  L.endChain();
  for (let i = 0; i < L.MAX_HOPS; i++) assert.equal(L.openLesson('ev', { returnTo: { exercise: 'x', seed: 1 } }).ok, true);
});

test('другое задание — новая цепочка: старые заходы не мешают', () => {
  setup();
  for (let i = 0; i < L.MAX_HOPS; i++) { L.openLesson('ev', { returnTo: { exercise: 'a', seed: 1 } }); L.returnToTask(); }
  assert.equal(L.openLesson('ev', { returnTo: { exercise: 'b', seed: 2 } }).ok, true);
  assert.equal(L.pending().exercise, 'b');
});

test('«Потренироваться»: кнопка есть только если по теме есть упражнения', () => {
  const has = { exercisesOf: ({ topic }) => (topic === 'pot-odds' ? [{ id: 'a' }] : []) };
  assert.equal(L.canPractice('pot-odds', has), true);
  assert.equal(L.canPractice('blockers', has), false);
  assert.equal(L.canPractice('pot-odds', null), false);
  const { calls } = setup();
  L.openTraining({ topic: 'pot-odds' });
  assert.deepEqual(calls[0], ['training', { track: undefined, topic: 'pot-odds', exercise: undefined, seed: undefined }]);
});

test('topicAction: без урока кнопки нет; с уроком — «Изучить тему» с возвратом', () => {
  const { calls } = setup();
  assert.equal(L.topicAction('pot-odds', { exercise: 'e', seed: 1, hasLesson: () => false }), null);
  const a = L.topicAction('pot-odds', { exercise: 'e', seed: 9, title: 'Pot Odds' });
  assert.equal(a.label, 'Изучить тему: Pot Odds');
  a.run();
  assert.equal(calls[0][2].returnTo.seed, 9);
});

test('рекомендации: повторить → непройденный уровень → закрепить; без заданий в банке не предлагаем', () => {
  const progress = {
    skills: { preflop: { level: 2 }, math: { level: 3 } },
    tracks: { preflop: { passed: [1, 2], accuracy30: 0.5 }, potodds: { passed: [1], accuracy30: 0.9 } },
    due: [{ topic: 'pot-odds', track: 'potodds', dueAt: 5 }, { topic: 'мусор', track: 'potodds', dueAt: 1 }, { topic: 'ev', track: 'нет', dueAt: 1 }],
  };
  const r = recommend(progress, { limit: 10 });
  assert.equal(r[0].kind, 'review');
  assert.equal(r[0].topic, 'pot-odds');
  assert.equal(r.filter((x) => x.kind === 'review').length, 1, 'неизвестные темы и направления отброшены');
  const next = r.filter((x) => x.kind === 'next');
  assert.ok(next.some((x) => x.track === 'preflop' && x.level === 3), 'уровни 1–2 пройдены, ждёт 3');
  assert.ok(next.some((x) => x.track === 'outs' && x.level === 3));
  assert.ok(r.some((x) => x.kind === 'consolidate' && x.track === 'preflop' && x.level === 2), 'самая низкая точность — первой');
  assert.ok(recommend(progress, { limit: 2 }).length <= 2);
  assert.deepEqual(recommend(progress, { bank: { exercisesOf: () => [] } }), []);
  assert.deepEqual(recommend(null, { limit: 3 }).map((x) => x.kind), ['next', 'next', 'next']);
});
