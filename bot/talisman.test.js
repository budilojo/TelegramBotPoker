import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Table, user } from './harness.js';
import { Store } from './store.js';
import { ITEMS } from '../miniapp/collections/catalog.js';
import { productMetrics } from './product-metrics.js';

test('all approved item art has local WebP alpha, and each series offers two talismans', () => {
  for (const collection of ['sever', 'obsidian', 'chertezh']) {
    const items = ITEMS.filter(i => i.collection === collection);
    assert.equal(items.filter(i => i.slot === 'talisman').length, 2);
    for (const source of new Set(items.flatMap(i => [i.assets.preview, i.assets.game]).filter(Boolean))) {
      assert.match(source, /^\/collections\/raster\/[a-z-]+\.webp$/);
      const data = fs.readFileSync(new URL('../miniapp' + source, import.meta.url));
      assert.equal(data.subarray(8, 12).toString(), 'WEBP');
      assert.equal(data.subarray(12, 16).toString(), 'VP8X');
      assert.ok(data[20] & 0x10, 'the WebP declares alpha');
      assert.ok(data.length < 90_000, source);
    }
  }
});

test('personal talisman is owned, only sent to its owner, and hidden usage is excluded', async () => {
  const host = user(9101, 'Нина'), guest = user(9102, 'Коля');
  const store = new Store();
  const t = new Table({ store });
  const id = 'sever-talisman-alt';
  try {
    await t.seat([host, guest]);
    const equip = (req) => ({ t: 'col', op: 'apply', v: 2, slot: 'talisman', item: id, color: 'default', req });
    await t.send(guest, equip('talisman-no-rights'));
    assert.equal(t.page(guest).inbox.at(-1).error?.code, 'COL_NOT_OWNED');
    store.pay.adminGrant(String(host.id), id, '100', t.clock.now());
    await t.send(host, equip('talisman-real-rights'));
    await t.send(host, { t: 'col', op: 'hide-talisman', v: 2, hidden: 'true', req: 'talisman-bad-type' });
    assert.equal(t.page(host).inbox.at(-1).error?.code, 'COL_OP');
    await t.send(host, { t: 'col', op: 'hide-talisman', v: 2, hidden: true, req: 'talisman-hide' });
    await t.send(host, { t: 'start' });
    assert.equal(t.state(host).talisman, undefined);
    assert.equal(productMetrics(store.db, t.clock.now(), []).activity.nsm, 0);
    await t.send(host, { t: 'col', op: 'hide-talisman', v: 2, hidden: false, req: 'talisman-show', user: guest.id });
    assert.equal(t.state(host).talisman.item, id);
    const views = t.page(guest).inbox.filter(msg => msg.t === 'state').map(msg => msg.state);
    assert.ok(views.every(view => !view.talisman && !JSON.stringify(view.look).includes(id)), 'no other view exposes the equipped talisman');
    assert.equal(t.app.collections.talismanHidden(guest.id), false);
  } finally { store.close(); }
});
