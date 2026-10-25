'use strict';
/**
 * «Тренировка», движок упражнений (miniapp/train/engine.js, docs/poker-training.md):
 * каждое зарегистрированное упражнение детерминировано, его верный ответ
 * проходит проверку, тема — из реестра. Ловит неверные упражнения W и X.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../miniapp/train/content/index.js';
import {
  allExercises, exerciseById, instantiate, grade, reviewProblems, rngFromSeed, registerExercises,
  exercisesOf, pickExercise, coverage, makePick, ROUND,
} from '../miniapp/train/engine.js';
import { isTopic, TRACKS } from '../miniapp/train/topics.js';

test('движок: упражнения зарегистрированы, у каждого тема из реестра и направление-навык', () => {
  const all = allExercises();
  assert.ok(all.length >= 3);
  for (const e of all) {
    assert.ok(isTopic(e.topic), `${e.id}: тема ${e.topic}`);
    assert.ok(TRACKS.some((t) => t.id === e.track && t.skill === e.skill), `${e.id}: направление и навык`);
    assert.ok(Number.isInteger(e.level) && e.level >= 1 && e.level <= 5, `${e.id}: уровень`);
  }
  assert.equal(ROUND, 10);
});

test('движок: make(seed) детерминирован, а верный ответ проходит check (все упражнения, много seed)', () => {
  for (const e of allExercises()) {
    for (const seed of [0, 1, 2, 7, 99, 12345, 2147483646]) {
      const a = instantiate(e.id, seed);
      const b = instantiate(e.id, seed);
      const shape = (x) => JSON.stringify({ p: x.task.prompt, s: x.task.setup, sol: x.task.solution });
      assert.equal(shape(a), shape(b), `${e.id} seed ${seed}: два вызова разные`);
      assert.notEqual(a.task.solution, undefined, `${e.id}: у задания нет solution`);
      const r = grade(a.task, a.task.solution);
      assert.equal(r.ok, true, `${e.id} seed ${seed}: верный ответ не принят`);
      assert.equal(r.score, 1);
      assert.deepEqual(reviewProblems(r), [], `${e.id} seed ${seed}`);
    }
  }
});

test('движок: неверный ответ — не ok, с ошибкой из реестра тем и альтернативами', () => {
  for (const e of allExercises().filter((x) => x.kind === 'pick')) {
    const { task } = instantiate(e.id, 3);
    const wrong = task.setup.options.find((o) => o.id !== task.solution).id;
    const r = grade(task, wrong);
    assert.equal(r.ok, false, e.id);
    assert.equal(r.score, 0);
    assert.ok(r.mistakes.length >= 1 && r.mistakes.every((m) => isTopic(m.topic)), e.id);
    assert.ok(r.alternatives.some((a) => a.verdict === 'верно'), e.id);
  }
});

test('движок: rng по seed повторяется и перемешивает без потерь', () => {
  const a = rngFromSeed(5); const b = rngFromSeed(5);
  assert.deepEqual([a(), a(), a.int(1, 6)], [b(), b(), b.int(1, 6)]);
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(rngFromSeed(9).shuffle(arr).slice().sort(), arr);
  assert.deepEqual(rngFromSeed(9).shuffle(arr), rngFromSeed(9).shuffle(arr));
  assert.notDeepEqual(rngFromSeed(1)(), rngFromSeed(2)());
});

test('движок: кривое упражнение отвергается при регистрации', () => {
  const ok = { id: 'zz-test-ok', topic: 'outs', level: 1, kind: 'pick', make: () => ({}) };
  assert.throws(() => registerExercises('nope', [ok]), /направление/);
  assert.throws(() => registerExercises('outs', [{ ...ok, id: 'Bad Id' }]), /id/);
  assert.throws(() => registerExercises('outs', [{ ...ok, topic: 'нет-такой' }]), /реестре/);
  assert.throws(() => registerExercises('outs', [{ ...ok, level: 6 }]), /level/);
  assert.throws(() => registerExercises('outs', [{ ...ok, kind: 'telepathy' }]), /kind/);
  assert.throws(() => registerExercises('outs', [{ ...ok, make: null }]), /make/);
  assert.throws(() => registerExercises('outs', [{ ...ok, id: 'v-outs-count-1' }]), /уже есть/);
  assert.throws(() => registerExercises('outs', [{ ...ok, track: 'potodds' }]), /track/);
  assert.equal(exerciseById('zz-test-ok'), null);
});

test('движок: подбор — ближайший уровень, тема, без повтора подряд', () => {
  const cov = coverage();
  const tr = Object.keys(cov)[0];
  const lv = cov[tr];
  assert.equal(pickExercise({ track: tr, level: 5 }).level, lv[lv.length - 1], 'берётся ближайший имеющийся уровень');
  const empty = TRACKS.find((t) => !cov[t.id]);
  if (empty) assert.equal(pickExercise({ track: empty.id, level: 1 }), null);
  assert.ok(exercisesOf({ track: tr }).length >= 1);
  const many = Object.keys(cov).find((k) => exercisesOf({ track: k, level: cov[k][0] }).length > 1);
  if (many) {
    const first = exercisesOf({ track: many, level: cov[many][0] })[0];
    for (let i = 0; i < 20; i++) assert.notEqual(pickExercise({ track: many, level: first.level, recent: [first.id] }).exercise.id, first.id);
  }
});

test('makePick: нет верного варианта — ошибка, порядок вариантов от seed', () => {
  const opts = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }];
  assert.throws(() => makePick(rngFromSeed(1), { prompt: 'x', options: opts, correct: 'z', why: 'w', mistake: { code: 'x', topic: 'outs' } }), /верного/);
  const mk = (s) => makePick(rngFromSeed(s), { prompt: 'x', options: opts, correct: 'a', why: 'w', mistake: { code: 'x', topic: 'outs' } }).setup.options.map((o) => o.id).join();
  assert.equal(mk(4), mk(4));
});
