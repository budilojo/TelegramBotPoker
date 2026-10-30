'use strict';
/** Страницы каталога игр — чистая логика: 0 / 1 / много, позиция, размер экрана. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { perPage, paginate, clampPage, pageAt, pageLabel, rememberPage, recallPage, forgetPages } from '../miniapp/catalog-pager.js';
import { GAME_LIST } from './games/index.js';

test('ноль игр — ноль страниц, одна игра — одна страница', () => {
  assert.deepEqual(paginate([], 3), []);
  assert.deepEqual(paginate([1], 3), [[1]]);
  assert.deepEqual(paginate(null, 3), []);
});

test('много игр: страницы по N, последняя неполная, ничего не потеряно и не повторено', () => {
  const items = Array.from({ length: 7 }, (_, i) => i);
  const pages = paginate(items, 3);
  assert.deepEqual(pages, [[0, 1, 2], [3, 4, 5], [6]]);
  assert.deepEqual(pages.flat(), items);
});

test('число игр берётся из реестра, а не зашито', () => {
  const ids = GAME_LIST.map((g) => g.id);
  assert.ok(ids.length >= 1);
  assert.equal(paginate(ids, perPage(740)).flat().length, ids.length);
  // добавили игру в реестр — страниц стало столько, сколько нужно
  assert.equal(paginate([...ids, 'новая', 'ещё'], 3).flat().length, ids.length + 2);
});

test('размер страницы зависит от высоты экрана, но в пределах 2–4, мусор даёт 3', () => {
  assert.equal(perPage(568), 2);
  assert.ok(perPage(740) >= 2 && perPage(740) <= 4);
  assert.equal(perPage(5000), 4);
  assert.equal(perPage(0), 3);
  assert.equal(perPage('x'), 3);
});

test('позиция не вылетает за границы', () => {
  assert.equal(clampPage(5, 3), 2);
  assert.equal(clampPage(-1, 3), 0);
  assert.equal(clampPage(NaN, 3), 0);
  assert.equal(clampPage(2, 0), 0);
});

test('страница по прокрутке и подпись индикатора', () => {
  assert.equal(pageAt(0, 300, 3), 0);
  assert.equal(pageAt(310, 300, 3), 1);
  assert.equal(pageAt(9999, 300, 3), 2);
  assert.equal(pageAt(100, 0, 3), 0);
  assert.equal(pageLabel(0, 3), 'Страница 1 из 3');
});

test('позиция помнится по ключу и подрезается, если страниц стало меньше', () => {
  forgetPages();
  rememberPage('hub:A', 2);
  assert.equal(recallPage('hub:A', 3), 2);
  assert.equal(recallPage('hub:A', 2), 1, 'экран стал выше, страниц меньше');
  assert.equal(recallPage('hub:B', 3), 0, 'у другой группы свой лист');
});
