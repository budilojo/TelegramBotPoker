import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadManifest, validateManifest, nextStep } from './release-run.mjs';

const real = loadManifest();
const clone = () => JSON.parse(JSON.stringify(real));
const all = () => true;
const st = (o) => ({ steps: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { status: v }])) });

test('манифест релиза: корректен, порядок A→B→C→D→E, файлы на месте', () => {
  assert.deepEqual(validateManifest(real), []);
  assert.deepEqual(real.steps.map((s) => s.letter), ['A', 'B', 'C', 'D', 'E']);
});

test('валидатор ловит пропавшее задание, агента, повтор id и пересечение номеров решений', () => {
  const a = clone();
  a.steps[1].task = 'docs/next-release/нет-такого.md';
  assert.ok(validateManifest(a).some((p) => p.includes('нет задания')));
  const b = clone();
  b.steps[2].agent = 'нет-такого-агента';
  assert.ok(validateManifest(b).some((p) => p.includes('нет определения агента')));
  const c = clone();
  c.steps[1].id = 'law';
  assert.ok(validateManifest(c, { exists: all }).some((p) => p.includes('повтор')));
  const d = clone();
  d.steps[1].decisions = [135, 140];
  assert.ok(validateManifest(d, { exists: all }).some((p) => p.includes('пересекаются')));
});

test('очередь: строго по порядку, следующий шаг ждёт предыдущий', () => {
  assert.equal(nextStep(real, st({})).step.id, 'law');
  assert.equal(nextStep(real, st({ law: 'done' })).step.id, 'payments');
  assert.equal(nextStep(real, st({ law: 'done', payments: 'done', navigation: 'done', rating: 'done' })).step.id, 'check');
  assert.equal(nextStep(real, st({ law: 'done', payments: 'done', navigation: 'done', rating: 'done', check: 'done' })).done, true);
});

test('очередь: частично, заблокировано и красные тесты останавливают; --continue-partial пропускает только partial', () => {
  for (const bad of ['partial', 'blocked', 'failed', 'gate-failed', 'limit']) {
    const r = nextStep(real, st({ law: bad }));
    // сам шаг повторяется, но следующие за ним не стартуют
    assert.equal(r.step.id, 'law', bad);
  }
  assert.ok(nextStep(real, st({ law: 'done', payments: 'partial' }), { only: ['navigation'] }).stop, 'only не обходит порядок');
  assert.equal(nextStep(real, st({ law: 'partial' }), { continuePartial: true }).step.id, 'payments');
  assert.equal(nextStep(real, st({ law: 'blocked' }), { continuePartial: true }).step.id, 'law', 'blocked не пропускается');
});

test('--only запускает один шаг и не перепрыгивает через невыполненные', () => {
  assert.equal(nextStep(real, st({}), { only: ['law'] }).step.id, 'law');
  assert.ok(nextStep(real, st({}), { only: ['rating'] }).stop);
  assert.equal(nextStep(real, st({ law: 'done', payments: 'done', navigation: 'done' }), { only: ['rating'] }).step.id, 'rating');
  assert.equal(nextStep(real, st({ law: 'done' }), { only: ['law'] }).done, true);
});
