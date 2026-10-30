import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadManifest, validateManifest, nextStep, manifestOf, ROOT } from './release-run.mjs';

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
  for (const bad of ['partial', 'blocked', 'failed', 'gate-failed', 'publish-failed', 'limit']) {
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

test('второй пакет (next-release-2): манифест корректен, порядок F→G→H→I, отчёты и порт — свои', () => {
  const m2 = loadManifest(path.join(ROOT, manifestOf('next-release-2')));
  assert.deepEqual(validateManifest(m2), []);
  assert.deepEqual(m2.steps.map((s) => s.letter), ['F', 'G', 'H', 'I']);
  assert.notEqual(m2.stateDir, real.stateDir || '.release-run', 'своё состояние');
  assert.notEqual(m2.runBranch, real.runBranch, 'своя ветка');
  assert.notEqual(m2.worktree, real.worktree || 'release', 'своя рабочая копия');
  assert.notEqual(m2.portBase, 9300, 'свой диапазон портов');
  // номера решений не пересекаются с первым пакетом
  const all = [...real.steps, ...m2.steps].map((s) => s.decisions);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    assert.ok(all[i][1] < all[j][0] || all[j][1] < all[i][0], `решения ${all[i]} и ${all[j]} пересекаются`);
  }
});

test('третий пакет (next-release-3): манифест корректен, порядок J→K→L→M, своё состояние внутри .release-run, решения не пересекаются с первыми двумя', () => {
  const m2 = loadManifest(path.join(ROOT, manifestOf('next-release-2')));
  const m3 = loadManifest(path.join(ROOT, manifestOf('next-release-3')));
  assert.deepEqual(validateManifest(m3), []);
  assert.deepEqual(m3.steps.map((s) => s.letter), ['J', 'K', 'L', 'M']);
  assert.ok(m3.stateDir.startsWith('.release-run/'), 'состояние внутри уже игнорируемой папки');
  for (const k of ['runBranch', 'worktree', 'stateDir', 'portBase']) assert.notEqual(m3[k], m2[k], `${k} свой`);
  const all = [...real.steps, ...m2.steps, ...m3.steps].map((s) => s.decisions);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    assert.ok(all[i][1] < all[j][0] || all[j][1] < all[i][0], `решения ${all[i]} и ${all[j]} пересекаются`);
  }
});
