/** Проверка I: временная SQLite → sqlite .backup + gzip → старый App 3a7fcc8
 * → новый App → сверка пропущенных оплат/возвратов. Только TelegramStub.
 * node --disable-warning=ExperimentalWarning tools/check2-recovery.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Store } from '../bot/store.js';
import { shop, ALICE, BOB, OWNER, buy, purchase, paid, preCheckout, refund, owner } from '../bot/payments/testkit.js';
import { payloadOf } from '../bot/payments/index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check2-recovery-'));
const live = path.join(dir, 'test.db'), backup = path.join(dir, 'backup.db'), restored = path.join(dir, 'restored.db');
const opened = [];
const rig = (file) => { const t = shop({}, { store: new Store(file) }); opened.push(t); return t; };
const close = (t) => { t.app.stop(); t.app.store.close(); opened.splice(opened.indexOf(t), 1); };
const extraDump = (db) => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'pay_%' OR name LIKE 'shop_%' OR name LIKE 'support_%') ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
};
try {
  const t = rig(live);
  const a = await purchase(t, ALICE, 'graphit-table');
  assert.ok(a.ok);
  await t.dm(ALICE, '/support'); await t.dm(ALICE, 'Проверка восстановления');
  const ticket = t.app.store.support.openOf(String(ALICE.id));
  assert.ok(ticket);
  // Админка: реальный протокол цен/выдачи, журнал и дедуп запроса попадают в копию.
  t.openAdmin(OWNER);
  await t.send(OWNER, { t: 'ashop', op: 'price', item: 'graphit-cardback', price: 31 });
  const ask = t.page(OWNER).inbox.findLast((m) => m.t === 'ashop' && m.op === 'ask');
  assert.ok(ask?.ask.code);
  await t.send(OWNER, { t: 'ashop', op: 'confirm', code: ask.ask.code, req: 'recovery-price-0001' });
  await t.send(OWNER, { t: 'ashop', op: 'grant', user: String(BOB.id), item: 'graphit-cardback', req: 'recovery-grant-0001' });
  assert.equal(t.app.payments.offers().items['graphit-cardback'], 31);
  assert.ok(t.app.store.pay.adminLogs().length >= 2);
  const inv = await buy(t, BOB, 'graphit-profile');
  const pending = t.app.store.pay.order(inv.order);
  assert.equal((await preCheckout(t, BOB, { payload: payloadOf(pending), amount: pending.price })).ok, true);
  assert.equal(t.app.store.pay.order(pending.id).state, 'approved');
  // Та же команда SQLite, что backup.sh; полный снимок, не копирование открытого WAL-файла.
  execFileSync('sqlite3', [live, `.backup '${backup}'`]);
  fs.writeFileSync(`${backup}.gz`, gzipSync(fs.readFileSync(backup)));
  const before = extraDump(t.app.store.db);
  // Эти события случились ПОСЛЕ копии; старый код их обрабатывать не умеет.
  await paid(t, BOB, { payload: payloadOf(pending), amount: pending.price, deliver: false });
  await refund(t, a.order.id);
  const stars = structuredClone(t.tg.stars);
  close(t);
  fs.writeFileSync(restored, gunzipSync(fs.readFileSync(`${backup}.gz`)));
  // Старый код берём из Git только для локальной проверки. Исходное дерево не меняется.
  const oldDir = path.join(dir, 'old'); fs.mkdirSync(oldDir);
  const archive = execFileSync('git', ['archive', '3a7fcc8', 'bot', 'miniapp', 'server'], { maxBuffer: 50 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', oldDir], { input: archive });
  fs.writeFileSync(path.join(oldDir, 'package.json'), '{"type":"module"}');
  fs.symlinkSync(path.resolve('node_modules'), path.join(oldDir, 'node_modules'));
  const { Store: OldStore } = await import(pathToFileURL(path.join(oldDir, 'bot/store.js')));
  const { App: OldApp } = await import(pathToFileURL(path.join(oldDir, 'bot/app.js')));
  const { TelegramStub } = await import(pathToFileURL(path.join(oldDir, 'bot/tg-stub.js')));
  const oldStore = new OldStore(restored);
  const api = new TelegramStub(); api.dmOpen.add(String(BOB.id));
  const old = new OldApp({ api, store: oldStore, minIntervalMs: 0 });
  try {
    assert.deepEqual(extraDump(oldStore.db), before, 'старое открытие не меняет новые данные');
    const r = old.createGame('durak', { chatId: '-9900001', title: 'Откат', host: { id: '901', tgId: 901, name: 'Проверка' } });
    assert.ok(r.code);
    await old.handleUpdate({ update_id: 91000, message: { message_id: 91000, date: 0, chat: { id: BOB.id, type: 'private' }, from: BOB, successful_payment: { currency: 'XTR', total_amount: pending.price, invoice_payload: payloadOf(pending), telegram_payment_charge_id: 'old-ignored', provider_payment_charge_id: '' } } });
    await old.settle();
    assert.deepEqual(extraDump(oldStore.db), before, 'новые таблицы сохранены после работы старой версии');
  } finally { old.stop(); oldStore.close(); }
  const restoredTable = rig(restored);
  assert.equal(restoredTable.app.store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(restoredTable.app.store.db.prepare("SELECT value FROM meta WHERE key='schema'").get().value, '5');
  assert.deepEqual(extraDump(restoredTable.app.store.db), before);
  restoredTable.tg.stars = stars;
  const result = await owner(restoredTable, '/reconcile');
  assert.match(result, /восстановлено оплат 1.*засчитано возвратов 1/);
  assert.equal(restoredTable.app.store.pay.order(pending.id).state, 'paid');
  assert.equal(restoredTable.app.collections.owns(BOB.id, 'graphit-profile'), true);
  assert.equal(restoredTable.app.collections.owns(ALICE.id, 'graphit-table'), false);
  assert.equal(restoredTable.app.collections.owns(BOB.id, 'graphit-cardback'), true, 'независимая выдача сохранилась');
  assert.ok(restoredTable.app.store.support.ticket(ticket.id));
  assert.equal(restoredTable.app.payments.offers().items['graphit-cardback'], 31);
  assert.match(await owner(restoredTable, '/reconcile'), /восстановлено оплат 0.*засчитано возвратов 0/);
  assert.equal(restoredTable.tg.calls.filter((c) => c.method === 'refundStarPayment').length, 0);
  close(restoredTable);
  console.log('check2 recovery: SQLite .backup → gzip → 3a7fcc8 App/Store → новый код: все новые таблицы неизменны; approved заказ, пропущенная оплата и возврат сверены ровно один раз; integrity_check=ok, schema=5. Только заглушка.');
} finally {
  for (const t of opened) { t.app.stop(); t.app.store.close(); }
  fs.rmSync(dir, { recursive: true, force: true });
}
