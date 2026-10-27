import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  COLLECTION, COLORS, DEFAULT_COLOR, SLOTS, ITEMS, BASE, itemById, isColor, slotOf, itemsOfBundle, missingForBundle,
} from '../miniapp/collections/catalog.js';
import { OPS, ERRORS, isReq } from '../miniapp/collections/protocol.js';
import { settingsRows, ROWS } from '../miniapp/settings-rows.js';

test('цвета: ровно четыре, HEX из SPEC, id уникальны', () => {
  assert.deepEqual(COLORS.map((c) => c.id), ['graphite', 'sapphire', 'bordeaux', 'petrol']);
  assert.deepEqual(COLORS.map((c) => [c.bg, c.ink]), [
    ['#20292E', '#B6BEC2'], ['#15263E', '#A6B5C8'], ['#3B202B', '#C2A8B2'], ['#153538', '#9FBFC0'],
  ]);
  for (const c of COLORS) assert.match(c.bg + c.ink, /^#[0-9A-F]{6}#[0-9A-F]{6}$/);
  assert.equal(isColor(DEFAULT_COLOR), true);
  assert.equal(isColor('red'), false);
  assert.equal(isColor('graph'), false);
  assert.equal(isColor(undefined), false);
});

test('SPEC и каталог в design/collections не разошлись по цветам', () => {
  const spec = fs.readFileSync(new URL('../design/collections/SPEC.md', import.meta.url), 'utf8');
  for (const c of COLORS) assert.ok(spec.includes(c.bg) && spec.includes(c.ink), c.id);
});

test('предметы: id уникальны и стабильны, комплект — три предмета', () => {
  assert.equal(COLLECTION.id, 'graphit');
  assert.deepEqual(ITEMS.map((x) => x.id), ['graphit-cardback', 'graphit-table', 'graphit-profile', 'graphit-bundle']);
  assert.equal(new Set(ITEMS.map((x) => x.id)).size, ITEMS.length);
  assert.deepEqual(SLOTS, ['cardback', 'table', 'profile']);
  const bundle = itemById('graphit-bundle');
  assert.equal(bundle.includes.length, 3);
  assert.deepEqual(itemsOfBundle('graphit-bundle'), ['graphit-cardback', 'graphit-table', 'graphit-profile']);
  for (const id of bundle.includes) assert.equal(itemById(id).kind, 'item');
  assert.deepEqual(ITEMS.filter((x) => x.kind === 'item').map((x) => x.slot).sort(), [...SLOTS].sort());
});

test('цены помечены как демонстрационные: число и комментарий в каталоге', () => {
  assert.deepEqual(ITEMS.map((x) => x.price), [99, 199, 79, 249]);
  const src = fs.readFileSync(new URL('../miniapp/collections/catalog.js', import.meta.url), 'utf8');
  assert.match(src, /ДЕМОНСТРАЦИОННЫ/);
});

test('itemById не принимает префиксы, регистр и чужое', () => {
  for (const bad of ['graphit', 'graphit-', 'graphit-cardback ', 'GRAPHIT-CARDBACK', 'graphit-cardback-x', '__proto__', 'constructor', 'toString', '', null, undefined, 5, {}, ['graphit-table']]) {
    assert.equal(itemById(bad), null, String(bad));
  }
  assert.equal(itemById('graphit-table').slot, 'table');
});

test('slotOf, itemsOfBundle, missingForBundle', () => {
  assert.equal(slotOf('graphit-cardback'), 'cardback');
  assert.equal(slotOf('graphit-bundle'), null);
  assert.equal(slotOf('nc-back-1'), null);
  assert.deepEqual(itemsOfBundle('graphit-table'), []);
  assert.deepEqual(itemsOfBundle('nope'), []);
  assert.deepEqual(missingForBundle([]), ['graphit-cardback', 'graphit-table', 'graphit-profile']);
  assert.deepEqual(missingForBundle(['graphit-table', 'x']), ['graphit-cardback', 'graphit-profile']);
  assert.deepEqual(missingForBundle(['graphit-cardback', 'graphit-table', 'graphit-profile']), []);
  assert.deepEqual(missingForBundle(null), ['graphit-cardback', 'graphit-table', 'graphit-profile']);
  // возвращаемый список — копия
  itemsOfBundle('graphit-bundle').pop();
  assert.equal(itemsOfBundle('graphit-bundle').length, 3);
});

test('база не конфликтует с id предметов и цветов', () => {
  const ids = new Set(ITEMS.map((x) => x.id));
  for (const [slot, b] of Object.entries(BASE)) {
    assert.ok(SLOTS.includes(slot));
    assert.ok(!ids.has(b.id), b.id);
    assert.equal(itemById(b.id), null);
    assert.ok(!isColor(b.id));
    assert.match(b.id, /^base-/);
  }
  assert.deepEqual(Object.keys(BASE).sort(), [...SLOTS].sort());
  assert.equal(new Set(Object.values(BASE).map((b) => b.id)).size, 3);
});

test('протокол: операции, коды отказов и req', () => {
  assert.deepEqual(OPS, ['state', 'grant', 'apply', 'clear']);
  assert.deepEqual(Object.keys(ERRORS), ['COL_OFF', 'COL_DEMO_OFF', 'COL_OP', 'COL_ITEM', 'COL_COLOR', 'COL_SLOT', 'COL_NOT_OWNED', 'COL_FAST', 'COL_STALE', 'COL_BUSY']);
  for (const t of Object.values(ERRORS)) assert.match(t, /[а-яё]/i);
  assert.equal(isReq('abcdefgh'), true);
  assert.equal(isReq('abcdefg'), false);
  assert.equal(isReq('a'.repeat(65)), false);
  assert.equal(isReq('abc def gh'), false);
  assert.equal(isReq(12345678), false);
});

test('модули каталога и протокола чистые: нет DOM, импортов и сети', () => {
  for (const f of ['catalog.js', 'protocol.js']) {
    const src = fs.readFileSync(new URL(`../miniapp/collections/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /^\s*import\s/m, f);
    assert.doesNotMatch(src, /\b(document|window|localStorage|fetch)\b/, f);
  }
});

test('реестр строк «Настроек»: заготовки молчат, null не рисуется', () => {
  assert.equal(ROWS.length, 2);
  assert.deepEqual(settingsRows({}), []);
  const el = { tag: 'row' };
  assert.deepEqual(settingsRows({}, [() => null, () => el, () => undefined, () => false, () => { throw new Error('x'); }]), [el]);
  assert.deepEqual(settingsRows({ a: 1 }, [(s) => (s.a ? 'ok' : null)]), ['ok']);
});

test('заготовки строк и стили подключены', async () => {
  for (const f of ['collections/settings-row.js', 'homescreen-row.js']) {
    const m = await import(pathToFileURL(new URL(`../miniapp/${f}`, import.meta.url).pathname));
    assert.equal(typeof m.default, 'function');
  }
  const html = fs.readFileSync(new URL('../miniapp/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="\/collections\.css"/);
  assert.match(html, /href="\/collections-look\.css"/);
  assert.ok(fs.existsSync(new URL('../miniapp/collections.css', import.meta.url)));
  assert.ok(fs.existsSync(new URL('../miniapp/collections-look.css', import.meta.url)));
});
