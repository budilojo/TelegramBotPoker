/**
 * Дурак: один жест на всё — тап поднимает карту, второй тап играет. Решение
 * тапа — чистая функция (miniapp/durak-tap.js), а что можно, берётся из
 * настоящих правил: те же `legalFor`, что уходят на телефон.
 * Сам экран (мышь, касание, клавиатура) проверяет tools/e2e-durak.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { handTap, coverTargets, defendHint } from '../miniapp/durak-tap.js';

const SCREEN = fs.readFileSync(new URL('../miniapp/games/durak.js', import.meta.url), 'utf8');

/** Два тапа подряд по одной карте: что сделал второй. */
function twice(legal, card, iDefend = true) {
  const first = handTap({ legal, picked: null, card, iDefend });
  assert.equal(first.do, 'pick', 'первый тап только поднимает');
  return handTap({ legal, picked: card, card, iDefend });
}

test('атака и подкидывание: второй тап ходит', () => {
  assert.deepEqual(twice({ attack: ['6D'] }, '6D', false), { do: 'attack' });
});

test('защита: второй тап покрывает единственную подходящую карту', () => {
  const legal = { defend: { '7D': [0], '8C': [2] }, transfer: [] };
  assert.deepEqual(twice(legal, '7D'), { do: 'defend', target: 0 });
  assert.deepEqual(twice(legal, '8C'), { do: 'defend', target: 2 }, 'цель — та, что назвал сервер, а не первая на столе');
});

test('защита: целей несколько — второй тап не угадывает, выбирает игрок', () => {
  const legal = { defend: { '7C': [0, 1] }, transfer: [] };
  assert.deepEqual(twice(legal, '7C'), { do: 'choose' });
  assert.deepEqual(coverTargets(legal, '7C'), [0, 1], 'обе подсвечены');
  assert.match(defendHint({ legal, picked: '7C' }), /на столе/);
});

test('переводной: козырь того же достоинства не играется сам — покрыть или перевести решает игрок', () => {
  const legal = { defend: { '9C': [0] }, transfer: ['9C'] };
  assert.deepEqual(twice(legal, '9C'), { do: 'choose' });
  assert.match(defendHint({ legal, picked: '9C' }), /перевести — кнопка/);
});

test('переводной: карта только для перевода поднимается, второй тап отсылает к кнопке', () => {
  const legal = { defend: {}, transfer: ['9S'] };
  assert.deepEqual(twice(legal, '9S'), { do: 'transfer-button' });
});

test('защита неподходящей картой: не поднимается и не играется', () => {
  const legal = { defend: { '7D': [0] }, transfer: [] };
  for (const picked of [null, '10S']) assert.deepEqual(handTap({ legal, picked, card: '10S', iDefend: true }), { do: 'cannot' });
});

test('подсказки отбивающемуся не требуют перетаскивания', () => {
  const legal = { defend: { '7D': [0], '7C': [0, 1] }, transfer: [], take: true };
  const lines = [null, '7D', '7C'].map((picked) => defendHint({ legal, picked }));
  assert.deepEqual(lines, ['Покрыть: тап по своей карте и ещё тап', 'Ещё тап по карте — покрыть ею', 'Нажмите на столе карту, которую кроете']);
  assert.equal(defendHint({ legal: { defend: {}, transfer: [] }, picked: null }), 'Крыть нечем — «Взять»');
  assert.ok(!/[Пп]еретащите карту/.test(SCREEN), 'на экране нет «перетащите» как единственного способа');
});

test('стол дурака решает тапы этой функцией, а карты на столе нажимаются не только с клавиатуры', () => {
  assert.match(SCREEN, /handTap\(\{ legal: L, picked, card: c, iDefend \}\)/);
  assert.match(SCREEN, /onclick: \(\) => onTableTap\(i\)/);
});
