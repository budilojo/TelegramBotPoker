import test from 'node:test';
import assert from 'node:assert/strict';
import { ITEMS } from '../miniapp/collections/catalog.js';
import { filteredItems, GAMES, gamesOf, sourceText } from '../miniapp/collections/shop-model.js';
import { stateOf } from '../miniapp/collections/item.js';

test('shop: all 64 stable positions reachable, game scope preserves legacy profile', () => {
  assert.equal(filteredItems().length, 64);
  assert.deepEqual(['cards', 'tables', 'boards', 'profile', 'bundles'].map(category => filteredItems({ category }).length), [13, 7, 24, 13, 7]);
  for (const [game] of GAMES) for (const collection of ['sever', 'obsidian', 'chertezh', 'terracotta', 'orbita', 'porcelain']) {
    const positions = filteredItems({ game, collection });
    assert.ok(positions.some(it => it.slot === 'frame'));
    assert.ok(positions.some(it => it.slot === 'badge'));
    assert.ok(positions.some(it => it.kind === 'bundle'));
    assert.ok(positions.some(it => !['frame', 'badge'].includes(it.slot) && it.kind === 'item'));
  }
  assert.deepEqual(gamesOf(ITEMS.find(it => it.id === 'graphit-profile')), ['poker', 'durak']);
  assert.equal(filteredItems({ game: 'chess', collection: 'graphit' }).length, 0);
  assert.ok(filteredItems().every(it => GAMES.some(([game]) => gamesOf(it).includes(game))));
});

test('shop: stale choice is not proof of ownership or successful equip', () => {
  const snap = { demo: false, shop: { open: false }, choice: { frame: { item: 'sever-frame', color: 'default' } }, pending: {}, owned: [] };
  assert.equal(stateOf(null, snap, 'sever-frame').key, 'free');
  snap.owned = ['sever-frame'];
  assert.equal(stateOf(null, snap, 'sever-frame').key, 'applied');
  snap.pending.frame = 'next-deal';
  assert.equal(stateOf(null, snap, 'sever-frame').text, 'Применится со следующей партии');
  snap.choice = {};
  assert.equal(stateOf(null, snap, 'sever-frame').key, 'owned');
});

test('shop: owner access and gifts have separate, honest source names', () => {
  assert.equal(sourceText(['owner']), 'Доступ владельца · бесплатно');
  assert.equal(sourceText(['purchase', 'admin']), 'Покупка · Подарок владельца');
  assert.equal(sourceText(['invented', '__proto__']), '');
});
