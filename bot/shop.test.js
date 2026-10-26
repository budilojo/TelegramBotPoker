import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Table, user } from './harness.js';
import { Store, NullStore } from './store.js';
import { Shop, variantFor, PER_MINUTE } from './shop.js';
import { ITEMS, SETS, itemById, itemsOfSet, isItem } from '../miniapp/cosmetics/catalog.js';

const alice = user(810001, 'Алиса'), bob = user(810002, 'Боб'), owner = user(810003, 'Владелец');
function setup(t, store = new Store()) {
  t.after(() => store.close());
  const table = new Table({ store, admins: [owner.id] });
  table.openSolo(alice); table.openSolo(bob); table.openAdmin(owner);
  return table;
}
const request = (u, item = 'nc-back-1', action = 'want') => ({ t: 'shop', op: 'interest', item, action, variant: variantFor(u.id) });
const last = (table, u) => table.page(u).inbox.at(-1);
const mark = (table, u, ...args) => table.send(u, request(u, ...args));

test('каталог: 10 вещей и набор, стабильные id, заглушки и цены', () => {
  assert.equal(ITEMS.length, 11);
  assert.equal(new Set(ITEMS.map((x) => x.id)).size, 11);
  assert.deepEqual(itemsOfSet(SETS[0].id), ITEMS);
  for (const x of ITEMS) {
    assert.equal(itemById(x.id), x);
    assert.equal(isItem(x.id), true);
    assert.match(fs.readFileSync(new URL('../miniapp' + x.placeholder, import.meta.url), 'utf8'), /TEMP/);
    assert.ok(x.stars.a > 0 && x.stars.b > x.stars.a);
  }
  for (const id of ['constructor', '__proto__', '', '../x', null, {}, ['nc-back-1']]) assert.equal(isItem(id), false);
  const bundle = itemById('nc-bundle');
  assert.deepEqual(bundle.items, ITEMS.filter((x) => x.kind !== 'bundle').map((x) => x.id));
  for (const v of ['a', 'b']) {
    const sum = bundle.items.reduce((n, id) => n + itemById(id).stars[v], 0);
    assert.ok(Math.abs(bundle.stars[v] / sum - 0.75) < 0.01);
  }
});

test('личность: initData, подставленные id игнорируются; без подписи нет сессии', async (t) => {
  const table = setup(t);
  assert.equal(table.open(user(999999, 'Чужой'), { initData: 'user=810001' }).error, 'AUTH');
  await table.send(bob, { ...request(bob), id: alice.id, user_id: alice.id, userId: alice.id, uid: alice.id, user: alice });
  assert.deepEqual(table.app.store.shopMine(alice.id), []);
  assert.deepEqual(table.app.store.shopMine(bob.id), ['nc-back-1']);
});

test('белый список, действие, операция и вариант: отказ словами, записей нет', async (t) => {
  const table = setup(t);
  for (const [patch, code] of [
    [{ item: '__proto__' }, 'SHOP_ITEM'], [{ item: ['nc-back-1'] }, 'SHOP_ITEM'], [{ item: 'unknown' }, 'SHOP_ITEM'],
    [{ action: 'buy' }, 'SHOP_ACTION'], [{ action: null }, 'SHOP_ACTION'],
    [{ variant: 'z' }, 'SHOP_VARIANT'], [{ variant: undefined }, 'SHOP_VARIANT'],
    [{ variant: variantFor(bob.id) }, 'SHOP_VARIANT'], [{ op: 'totals' }, 'SHOP_OP'],
  ]) {
    await table.send(alice, { ...request(alice), ...patch });
    assert.equal(last(table, alice).error?.code, code);
    assert.match(last(table, alice).error.text, /[а-яё]/i);
  }
  assert.deepEqual(table.app.store.shopTotals(), []);
});

test('вариант сервера стабилен после нового Hub/сброса; две равные группы', async (t) => {
  const table = setup(t);
  const variants = [];
  for (let id = 5000; id < 5100; id++) {
    const r = new Shop(table.app).handle(user(id, 'Гость'), { op: 'mine', variant: 'z' });
    assert.ok(['a', 'b'].includes(r.variant)); variants.push(r.variant);
  }
  assert.equal(variants.filter((x) => x === 'a').length, 50);
  for (const u of [alice, bob]) {
    await table.send(u, { t: 'shop', op: 'mine' });
    const v = last(table, u).variant;
    await table.send(u, { t: 'shop', op: 'reset', confirm: true });
    assert.equal(last(table, u).variant, v);
    assert.equal(new Shop(table.app).handle(u, { op: 'mine' }).variant, v);
  }
});

for (const Type of [Store, NullStore]) test(`${Type.name}: повторный просмотр/«Хочу» один раз, независимые вещи и люди`, async (t) => {
  const table = setup(t, new Type());
  for (const action of ['view', 'view', 'want', 'want', 'view']) await mark(table, alice, 'nc-back-1', action);
  await mark(table, bob, 'nc-back-1'); await mark(table, alice, 'nc-title-1');
  await table.send(owner, { t: 'refresh' });
  const totals = table.state(owner).shop;
  assert.deepEqual(totals.find((r) => r.item === 'nc-back-1' && r.variant === 'b'), { item: 'nc-back-1', variant: 'b', views: 1, wants: 1, percent: 100 });
  assert.equal(totals.reduce((n, r) => n + r.wants, 0), 3);
  assert.equal(totals.reduce((n, r) => n + r.views, 0), 3);
});

test('частота по FakeClock: общая на вкладки, чтение и сброс не обходят минуту', async (t) => {
  const table = setup(t);
  for (let i = 0; i < PER_MINUTE; i++) {
    await table.send(alice, { t: 'shop', op: 'mine' });
    assert.ok(!last(table, alice).error);
  }
  table.close(alice); table.openSolo(alice);
  await mark(table, alice);
  assert.equal(last(table, alice).error?.code, 'SHOP_FAST');
  await table.send(alice, { t: 'shop', op: 'reset', confirm: true });
  assert.equal(last(table, alice).error?.code, 'SHOP_FAST');
  await mark(table, bob); assert.ok(!last(table, bob).error);
  await table.clock.advance(59_999);
  await mark(table, alice); assert.equal(last(table, alice).error?.code, 'SHOP_FAST');
  await table.clock.advance(1);
  await mark(table, alice); assert.ok(!last(table, alice).error);
});

test('каждый телефон: только свои отметки; пульт получает только суммы и доступен владельцу', async (t) => {
  const table = setup(t);
  assert.equal(table.openAdmin(alice).error, 'NO_ROOM');
  await mark(table, alice, 'nc-title-1'); await mark(table, bob, 'nc-back-2', 'view');
  await mark(table, bob, 'nc-back-1');
  for (const u of [alice, bob]) await table.send(u, { t: 'shop', op: 'mine', user_id: u === alice ? bob.id : alice.id });
  await table.send(owner, { t: 'refresh' });
  for (const [u, allowed] of [[alice, ['nc-title-1']], [bob, ['nc-back-1']]]) {
    for (const msg of table.page(u).inbox.filter((m) => m.t === 'shop')) {
      assert.deepEqual(Object.keys(msg).sort(), ['t', 'variant', 'wanted']);
      assert.ok(msg.wanted.every((id) => allowed.includes(id)));
      assert.ok(!JSON.stringify(msg).includes(String(u === alice ? bob.id : alice.id)));
    }
  }
  for (const msg of table.page(owner).inbox) {
    assert.ok(!/user_id|userId|Алиса|Боб|810001|810002/.test(JSON.stringify(msg)));
    for (const row of msg.state?.shop || []) assert.deepEqual(Object.keys(row).sort(), ['item', 'percent', 'variant', 'views', 'wants']);
  }
  const seenOnly = table.state(owner).shop.find((r) => r.item === 'nc-back-2' && r.variant === 'a');
  assert.equal(seenOnly.views, 1); assert.equal(seenOnly.wants, 0); assert.equal(seenOnly.percent, 0);
});

test('сброс: подтверждение обязательно, чужие отметки не удаляются', async (t) => {
  const table = setup(t);
  await mark(table, alice); await mark(table, bob);
  await table.send(alice, { t: 'shop', op: 'reset' });
  assert.equal(last(table, alice).error?.code, 'SHOP_CONFIRM');
  assert.deepEqual(table.app.store.shopMine(alice.id), ['nc-back-1']);
  await table.send(alice, { t: 'shop', op: 'reset', confirm: true, user_id: bob.id });
  assert.deepEqual(last(table, alice).wanted, []);
  assert.deepEqual(table.app.store.shopMine(bob.id), ['nc-back-1']);
  assert.equal(table.app.store.shopTotals().length, 1);
});

test('база: повторное создание и открытие старым store.js 7afb285, схема 5 и отметки сохранены', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-compat-'));
  const file = path.join(dir, 'test.db');
  let store;
  try {
    store = new Store(file); store.shopInterest(alice.id, 'nc-back-1', 'b', 'want', 123); store.close(); store = null;
    const oldSource = execFileSync('git', ['show', '7afb285:bot/store.js'], { encoding: 'utf8' })
      .replace("'./fmt.js'", JSON.stringify(new URL('./fmt.js', import.meta.url).href));
    const oldFile = path.join(dir, 'old-store.mjs'); fs.writeFileSync(oldFile, oldSource);
    const OldStore = (await import(pathToFileURL(oldFile).href)).Store;
    store = new OldStore(file);
    assert.equal(store.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, '5');
    store.close(); store = new Store(file);
    assert.deepEqual(store.shopMine(alice.id), ['nc-back-1']);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM shop_interest').get().n, 1);
  } finally { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
