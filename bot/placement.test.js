'use strict';
/** Определение уровня (агент Y): сервер (границы, «по истории») и чистая логика диагностики. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NullStore } from './store.js';
import { handleY, cleanPlacement } from './placement.js';
import * as Q from '../miniapp/train/placement-core.js';

const base = { street: 'flop', position: 'BTN', hole: '20 1', board: '', pot: 100, toCall: 100, stack: 2000, opps: 1, bb: 50, action: 'call', equity: 0.7 };
const fill = (store, uid, n, o = {}) => { for (let i = 0; i < n; i++) store.addDecision(uid, { ...base, handKey: 'k' + i, at: i, ...o }); };
const mkDeps = (store, userId = '1') => {
  const saved = [];
  return { saved, deps: { userId, store, saveSkills: (u, s, via) => { saved.push({ u, s, via }); return { skills: s }; } } };
};

test('сервер: границы уровней и неизвестные навыки', () => {
  const ok = { op: 'placement', via: 'quiz', skills: { preflop: 1, ranges: 5, math: 3, postflop: 2 } };
  assert.deepEqual(cleanPlacement(ok), ok.skills);
  for (const bad of [
    { ...ok, skills: { preflop: 0 } }, { ...ok, skills: { preflop: 6 } }, { ...ok, skills: { preflop: 2.5 } },
    { ...ok, skills: { preflop: '3' } }, { ...ok, skills: { chess: 3 } }, { ...ok, skills: {} }, { ...ok, via: 'hack' }, { ...ok, skills: null },
  ]) assert.equal(cleanPlacement(bad), null, JSON.stringify(bad));
});

test('сервер: личность только из initData; тело «чей» не читается', () => {
  const s = new NullStore();
  const { saved, deps } = mkDeps(s, '42');
  const r = handleY({ op: 'placement', via: 'zero', userId: '999', uid: '999', skills: { preflop: 1 } }, deps);
  assert.ok(r.progress);
  assert.equal(saved[0].u, '42');
  assert.equal(handleY({ op: 'placement', via: 'zero', skills: { preflop: 1 } }, { ...deps, userId: null }).error, 'BAD_PLACEMENT');
  assert.equal(saved.length, 1);
});

test('сервер: «по истории» при малом числе решений отклоняется словами', () => {
  const s = new NullStore();
  fill(s, '1', 10);
  const { saved, deps } = mkDeps(s);
  const r = handleY({ op: 'placement', via: 'history', skills: { math: 3 } }, deps);
  assert.equal(r.error, 'FEW_DECISIONS');
  assert.match(r.text, /мало решений/);
  assert.equal(saved.length, 0);
  const h = handleY({ op: 'history' }, deps);
  assert.equal(h.history.available, false);
});

test('сервер: «по истории» принимается по навыку с данными, чужой навык — нет; решения чужих не считаются', () => {
  const s = new NullStore();
  fill(s, '1', 45); // 45 хороших коллов: навык math оценён
  fill(s, '2', 100, { equity: 0.05 });
  const { saved, deps } = mkDeps(s);
  const h = handleY({ op: 'history' }, deps).history;
  assert.equal(h.available, true);
  assert.equal(h.skills.math.level, 4);
  assert.equal(handleY({ op: 'placement', via: 'history', skills: { math: 4 } }, deps).progress.skills.math, 4);
  assert.equal(handleY({ op: 'placement', via: 'history', skills: { ranges: 3 } }, deps).error, 'BAD_PLACEMENT', 'по диапазонам данных нет');
  assert.equal(saved.length, 1);
});

test('сервер: «Удалить историю решений» — только свою', () => {
  const s = new NullStore();
  fill(s, '1', 5); fill(s, '2', 5);
  const { deps } = mkDeps(s);
  assert.equal(handleY({ op: 'decisions-clear' }, deps).cleared, 5);
  assert.equal(s.decisionsOf('1').length, 0);
  assert.equal(s.decisionsOf('2').length, 5);
});

/* ------------------------------------------------ диагностика (чистая) */

const bank = (levels = [1, 2, 3, 4, 5], skills = ['preflop', 'ranges', 'math', 'postflop']) => ({
  exercisesOf: ({ skill }) => skills.filter((s) => !skill || s === skill).flatMap((s) => levels.flatMap((l) => ['a', 'b'].map((k) => ({ id: `${s}-${l}${k}`, skill: s, level: l })))),
});

test('диагностика адаптивна: верно → сложнее, неверно → проще', () => {
  assert.equal(Q.nextLevel(2, true), 3);
  assert.equal(Q.nextLevel(2, false), 1);
  assert.equal(Q.nextLevel(5, true), 5);
  assert.equal(Q.nextLevel(1, false), 1);
  const st = Q.startQuiz(['math']);
  const b = bank();
  let t = Q.nextTask(st, b);
  assert.equal(t.ex.level, Q.START_LEVEL);
  Q.answer(st, t, true);
  t = Q.nextTask(st, b);
  assert.equal(t.ex.level, 3, 'после верного — сложнее');
  Q.answer(st, t, false);
  t = Q.nextTask(st, b);
  assert.equal(t.ex.level, 2, 'после неверного — проще (расхождение даёт третий вопрос)');
  Q.answer(st, t, false);
  assert.equal(Q.nextTask(st, b), null);
  assert.equal(Q.quizResult(st).math, 2 + 0, 'самый высокий верный: 2');
});

test('диагностика: 8–12 заданий, навыки чередуются, «Не знаю» = неверно, нет банка = навык пропущен', () => {
  const st = Q.startQuiz();
  const b = bank();
  const order = [];
  for (let t = Q.nextTask(st, b); t; t = Q.nextTask(st, b)) {
    order.push(t.skill);
    Q.answer(st, t, true);
  }
  assert.ok(order.length >= 8 && order.length <= 12, String(order.length));
  assert.deepEqual(order.slice(0, 4), ['preflop', 'ranges', 'math', 'postflop']);
  // всё верно: уровни растут 2,3 → оценка 3
  assert.equal(Q.quizResult(st).math, 3);

  const st2 = Q.startQuiz();
  const b2 = bank([1, 2, 3], ['preflop', 'math']);
  const seen = new Set();
  for (let t = Q.nextTask(st2, b2); t; t = Q.nextTask(st2, b2)) { seen.add(t.skill); Q.answer(st2, t, true, true); }
  assert.deepEqual([...seen].sort(), ['math', 'preflop']);
  const res = Q.quizResult(st2);
  assert.equal(res.ranges, null, 'нет заданий — навык не оценён');
  assert.equal(res.math, 1, 'все «Не знаю» — первый уровень');
});

test('итог можно поменять руками, граница 1…5; сообщение серверу содержит только известное', () => {
  assert.equal(Q.adjust(5, 1), 5);
  assert.equal(Q.adjust(1, -1), 1);
  assert.equal(Q.adjust(3, 1), 4);
  const m = Q.placementMessage({ preflop: 9, math: 3, ranges: null, шахматы: 3 }, 'quiz');
  assert.deepEqual(m, { t: 'train', op: 'placement', skills: { preflop: 5, math: 3 }, via: 'quiz' });
  assert.deepEqual(cleanPlacement(Q.placementMessage(Q.zeroLevels(), 'zero')), Q.zeroLevels());
  assert.deepEqual(Q.levelsFromHistory({ skills: { math: { enough: true, level: 3 }, preflop: { enough: false, level: null } } }), { preflop: null, ranges: null, math: 3, postflop: null });
});
