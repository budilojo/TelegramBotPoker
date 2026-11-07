import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.js';
import { productMetrics } from './product-metrics.js';

test('cohorts, first gift, installed and hidden, and a deduplicated weekly NSM', () => {
  const store = new Store();
  const now = Date.UTC(2026, 10, 7, 12);
  const daysAgo = (n) => now - n * 86_400_000;
  try {
    for (const [id, days] of [['1', [7, 0]], ['2', [1, 0]], ['3', [1]], ['4', [0]], ['5', [8]]]) {
      for (const offset of days) store.noteSeen(id, daysAgo(offset));
    }
    store.pay.adminGrant('2', 'sever-talisman', '100', daysAgo(1));
    store.collApply('2', [{ slot: 'talisman', item: 'sever-talisman', color: 'default' }], 'product-test', now, 20);
    store.setSetting('cosmetic:talisman-hidden:2', true);
    store.noteProductUse('1', 'cosmetic', 'sever-talisman', now);
    store.noteProductUse('1', 'cosmetic', 'sever-talisman', now);
    store.noteProductUse('1', 'tournament', 'some-id', now);
    store.noteProductUse('2', 'tournament', 'some-id', daysAgo(1));
    store.noteProductUse('2', 'cosmetic', 'porcelain-frame', now);
    store.noteProductUse('3', 'cosmetic', 'chertezh-frame', daysAgo(7));
    store.noteProductUse('5', 'cosmetic', 'chertezh-frame', now);
    const { activity: a } = productMetrics(store.db, now, []);
    assert.deepEqual([a.dau, a.wau, a.total, a.nsm, a.converted], [3, 4, 5, 2, 1]);
    assert.deepEqual(a.d1, { cohort: 2, returned: 1 });
    assert.deepEqual(a.d7, { cohort: 1, returned: 1 });
    assert.deepEqual(a.installed, { installed: 1, hidden: 1 });
    assert.equal(a.collections[0].top[0].players, 1);
    assert.deepEqual(a.collections.map(c => c.collection), ['sever', 'obsidian', 'chertezh', 'terracotta', 'orbita', 'porcelain']);
    assert.equal(a.collections.find(c => c.collection === 'porcelain').top[0].players, 1);
  } finally { store.close(); }
});
