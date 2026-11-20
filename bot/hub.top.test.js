import test from 'node:test';
import assert from 'node:assert/strict';
import { topKind } from '../miniapp/hub-top.js';

test('верх главной: свой стол — «вернуться», он важнее стола группы', () => {
  const r = topKind([{ status: 'lobby', inside: false }, { status: 'playing', inside: true }]);
  assert.equal(r.kind, 'back');
});
test('верх главной: открытый чужой стол — «Стол группы», лобби раньше идущей игры', () => {
  const r = topKind([{ code: 'a', status: 'playing' }, { code: 'b', status: 'lobby' }]);
  assert.equal(r.kind, 'table');
  assert.equal(r.lobby.code, 'b');
  assert.equal(topKind([{ code: 'a', status: 'playing' }]).lobby.code, 'a');
});
test('верх главной: ничего не открыто, на паузе или мусор — подсказка', () => {
  assert.equal(topKind([]).kind, 'hint');
  assert.equal(topKind([{ status: 'paused' }]).kind, 'hint');
  assert.equal(topKind(undefined).kind, 'hint');
});
