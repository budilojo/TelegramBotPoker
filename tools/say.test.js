'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { frame } from './say.js';

test('the rule is as wide as the longest line, and every line is indented', () => {
  const out = frame(['Стол открыт.', 'Адрес:', '  https://x.example']);
  const rule = out[1];
  assert.match(rule, /^─+$/);
  assert.equal(rule.length, '  https://x.example'.length + 2, 'по самой длинной строке');
  assert.equal(out.at(-2), rule, 'снизу такая же черта');
  assert.equal(out[2], ' Стол открыт.');
  assert.equal(out.at(0), '', 'пустая строка до и после — рамка не липнет к логу');
  assert.equal(out.at(-1), '');
});

test('a blank line stays blank — no trailing space to select by accident', () => {
  assert.deepEqual(frame(['a', '', 'b']).slice(2, 5), [' a', '', ' b']);
});

test('an emoji line does not make the rule ragged: there is no right edge to align', () => {
  const out = frame(['✅ Готово', '🎮 Играем']);
  assert.ok(out.every((l) => !l.endsWith('│')), 'правой стенки нет вовсе');
  assert.equal(out[1], out.at(-2), 'обе черты одинаковой длины');
});

test('a very long line does not make the rule wider than the terminal', () => {
  const out = frame(['x'.repeat(200)]);
  assert.equal(out[1].length, 76);
});

test('no lines at all: a rule that is still a rule', () => {
  const out = frame([]);
  assert.equal(out[1], '──');
  assert.equal(out.length, 4);
});
