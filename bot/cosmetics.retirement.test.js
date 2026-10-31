/** Архивный nc-* не становится живым оформлением и не удаляет старые данные/права. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.js';
import { App } from './app.js';
import { itemById as legacyItem } from '../miniapp/cosmetics/catalog.js';
import { readOffers, priceOf, salesConfig } from './payments/config.js';
import { tableOf, backOf, frameOf } from '../miniapp/collections/look-view.js';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('живые экраны не читают архивный выбор, сукно ограничено отдельной примерочной', () => {
  for (const f of ['miniapp/ui.js', 'miniapp/profile.js', 'miniapp/games/poker.js', 'miniapp/games/durak.js']) {
    assert.doesNotMatch(read(f), /from ['"].*cosmetics\//, `${f}: нет пути архивного оформления в живую игру`);
  }
  assert.doesNotMatch(read('miniapp/reactions.js'), /getLook|night-club/, 'архив не расширяет живой чат');
  const css = read('miniapp/cosmetics.css');
  assert.doesNotMatch(css, /html\[data-cos-felt\]/, 'даже старый атрибут html не меняет живое сукно');
  assert.match(css, /\.cos-fit\[data-cos-felt\] \.cf-felt/);
  const apply = read('miniapp/cosmetics/apply.js');
  assert.doesNotMatch(apply, /onLook\(|^applyFelt\(\)/m, 'нет глобальной подписки/применения архивного вида');
});

test('старые id узнаются, но не подменяют предметы Графита и не продаются', () => {
  for (const id of ['nc-back-1', 'nc-back-2', 'nc-felt-1', 'nc-frame-1', 'nc-frame-2', 'nc-react-1', 'nc-react-2', 'nc-react-3', 'nc-fx-win', 'nc-title-1', 'nc-bundle']) {
    assert.equal(legacyItem(id)?.id, id);
    assert.equal(priceOf(salesConfig(), id), null);
    const entry = { item: id, color: 'graphite' };
    assert.equal(tableOf({ table: entry }), null);
    assert.equal(backOf({ backs: [{ ...entry, seat: 0 }] }, 0), null);
    assert.equal(frameOf(entry), null);
  }
  assert.deepEqual(readOffers().items, { 'graphit-cardback': 75, 'graphit-table': 100, 'graphit-profile': 50, 'graphit-bundle': 175 });
});

test('файловая SQLite: покупка, admin, demo, архивный и неизвестный id сохраняются после чтения/restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmetics-a-'));
  const file = path.join(dir, 'fixture.db');
  let store;
  const uid = '700001001';
  const tables = ['pay_order', 'pay_payment', 'pay_entitlement', 'shop_grant', 'collection_demo_grant', 'collection_choice'];
  const dump = () => Object.fromEntries(tables.map((t) => [t, store.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  try {
    store = new Store(file);
    // Синтетические старые записи, без API счетов/оплаты/возврата и без настоящей базы.
    const items = ['graphit-table', 'nc-frame-2', 'unknown-kept-item'];
    store.pay.addOrder({ id: 'fixture-old', userId: uid, item: 'graphit-table', items, price: 100, terms: 'fixture', mode: 'test', at: 1, expiresAt: 2 });
    store.pay.moveOrder('fixture-old', ['created'], 'paid', 2);
    store.pay.addPayment({ chargeId: 'fixture-charge', orderId: 'fixture-old', userId: uid, amount: 100, currency: 'XTR', payload: 'fixture', kind: 'order', source: 'fixture', at: 2 });
    store.pay.grant('fixture-old', items, uid, 2);
    store.pay.adminGrant(uid, 'graphit-table', '9000', 3);
    store.pay.adminGrant(uid, 'unknown-kept-item', '9000', 3);
    store.collDemoGrant(uid, 'graphit-profile', 4);
    store.collChoiceSet(uid, 'table', 'graphit-table', 'petrol', 5);
    store.collChoiceSet(uid, 'frame', 'nc-frame-2', 'graphite', 5);
    store.collChoiceSet(uid, 'unknown-slot', 'unknown-kept-item', 'graphite', 5);
    const before = dump();
    for (let i = 0; i < 2; i++) {
      const app = new App({ api: {}, store });
      assert.deepEqual([...app.collections.sourcesOf(uid).get('graphit-table')].sort(), ['admin', 'purchase']);
      assert.deepEqual(app.collections.choiceOf(uid).table, { item: 'graphit-table', color: 'petrol' });
      assert.equal(app.collections.owns(uid, 'nc-frame-2'), false, 'архивная запись не превращается в Графит');
      assert.equal(app.collections.owns(uid, 'unknown-kept-item'), false, 'неизвестное не выдаётся');
      assert.equal(app.collections.owns(uid, 'graphit-profile'), false, 'демо не действует при off');
      app.collections.stateOf(uid);
      assert.deepEqual(dump(), before, 'чтение не мигрирует и не удаляет права/выбор');
      assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='schema'").get().value, '5');
      assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      app.stop(); store.close(); store = new Store(file);
    }
    assert.deepEqual(dump(), before);
  } finally { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
