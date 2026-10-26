// Упражнения агента X: детерминизм, верный ответ проходит, пустой — нет, числа в разборе сверены с poker-math.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../miniapp/train/content/index.js';
import { allExercises, instantiate, grade, reviewProblems } from '../miniapp/train/engine.js';
import * as M from '../miniapp/train/poker-math.js';

const XTRACKS = ['outs', 'potodds', 'postflop', 'hands', 'advanced'];
const mine = () => allExercises().filter((e) => XTRACKS.includes(e.track) && e.id.startsWith('x-'));
const SEEDS = [11, 222, 3333, 44444, 555555, 6666666];

test('X: на каждом уровне каждого направления есть упражнения', () => {
  for (const t of XTRACKS) for (let l = 1; l <= 5; l++) {
    assert.ok(mine().some((e) => e.track === t && e.level === l), `${t} L${l}`);
  }
});

test('X: make(seed) детерминирован, solution проходит check, разбор полный', () => {
  for (const e of mine()) for (const s of (e.track === 'hands' ? SEEDS.slice(0, 2) : SEEDS)) {
    const a = instantiate(e.id, s).task, b = instantiate(e.id, s).task;
    assert.equal(a.prompt, b.prompt, e.id);
    assert.deepEqual(a.setup, b.setup, e.id);
    assert.deepEqual(a.solution, b.solution, e.id);
    const r = grade(a, a.solution);
    assert.equal(r.ok, true, `${e.id} seed ${s}`);
    assert.deepEqual(reviewProblems(r), [], e.id);
    if (a.isComplete) assert.equal(a.isComplete(a.solution), true, e.id);
  }
});

test('X: пустой ответ не проходит', () => {
  for (const e of mine()) {
    const t = instantiate(e.id, 7).task;
    assert.equal(grade(t, null).ok, false, e.id);
  }
});

test('X: числа в разборе совпадают с poker-math (pot odds, MDF, SPR, ауты)', () => {
  const cases = [
    ['x-potodds-need', (t) => { const { pot, bet } = t.setup; return M.requiredEquity(pot, bet) * 100; }],
    ['x-adv-mdf', (t) => M.mdf(t.setup.pot, t.setup.bet) * 100],
    ['x-adv-spr', (t) => M.spr(t.setup.stack, t.setup.pot)],
  ];
  for (const [id, f] of cases) for (const s of SEEDS) {
    const t = instantiate(id, s).task;
    assert.ok(Math.abs(t.solution - f(t)) < 0.06, `${id} ${s}: ${t.solution} vs ${f(t)}`);
  }
  for (const s of SEEDS) {
    const t = instantiate('x-outs-count', s).task;
    assert.equal(t.solution, M.drawOuts(t.setup.hero, t.setup.board).length);
  }
});

test('X: «на зубы» — неверное число не проходит', () => {
  const t = instantiate('x-potodds-need', 5).task;
  assert.equal(grade(t, t.solution + 10).ok, false);
  assert.equal(grade(instantiate('x-outs-count', 5).task, 99).ok, false);
});
