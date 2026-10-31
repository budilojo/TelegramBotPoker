/** M: независимая проверка состава payload и подтверждённых цен. Только TelegramStub. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readOffers } from './payments/config.js';
import { payloadOf } from './payments/index.js';
import { shop, ALICE, OWNER, buy, preCheckout, paid, purchase, refund, req } from './payments/testkit.js';

for (const source of ['update', 'reconcile']) {
  test(`M: ${source} не выдаёт вещь при подмене товара в payload существующего заказа`, async (ctx) => {
    const t = shop();
    ctx.after(() => { t.app.stop(); t.app.store.close(); });
    const inv = await buy(t, ALICE, 'graphit-table');
    const order = t.app.store.pay.order(inv.order);
    assert.equal((await preCheckout(t, ALICE, { payload: payloadOf(order), amount: order.price })).ok, true);
    // Инъекция противоречивого события на доверенной границе Telegram, не запрос страницы.
    const bad = `g1:${order.id}:graphit-bundle`;
    const id = await paid(t, ALICE, { payload: bad, amount: order.price, deliver: source === 'update' });
    if (source === 'reconcile') await t.app.payments.reconcile();
    assert.equal(t.app.store.pay.payment(id).kind, 'mismatch', 'товар payload должен совпадать с заказом');
    assert.deepEqual(t.app.collections.ownedItems(ALICE.id), [], 'противоречивое событие не даёт прав');
    assert.equal(t.app.store.pay.order(order.id).state, 'approved');
    assert.ok(t.app.store.pay.paymentsToReview().some((p) => p.chargeId === id));
    assert.ok(t.tg.calls.some((c) => c.method === 'sendMessage' && String(c.chatId) === String(OWNER.id)), 'владелец уведомлён');
    // Новый корректный платёж того же заказа после отказа обрабатывается; повтор идемпотентен.
    const valid = await paid(t, ALICE, { payload: payloadOf(order), amount: order.price });
    assert.equal(t.app.store.pay.payment(valid).kind, 'order');
    assert.equal(t.app.collections.owns(ALICE.id, order.item), true);
    await paid(t, ALICE, { payload: payloadOf(order), amount: order.price, chargeId: valid, record: false });
    assert.equal(t.app.store.pay.db.prepare('SELECT COUNT(*) n FROM pay_entitlement').get().n, 1);
  });
}

test('M: возврат покупки не обещает удалить вещь, доступную по независимой выдаче', async (ctx) => {
  const t = shop();
  ctx.after(() => { t.app.stop(); t.app.store.close(); });
  const p = await purchase(t, ALICE, 'graphit-table');
  assert.ok(p.ok);
  t.openAdmin(OWNER);
  await t.send(OWNER, { t: 'ashop', op: 'grant', user: String(ALICE.id), item: 'graphit-table', req: req('m-grant') });
  const r = await refund(t, p.order.id);
  assert.match(r.done, /Возврат .* выполнен/);
  assert.equal(t.app.collections.owns(ALICE.id, 'graphit-table'), true, 'подарок остаётся');
  assert.match(t.lastDm(ALICE), /Право от этой покупки прекращено/);
  assert.doesNotMatch(t.lastDm(ALICE), /Вещь убрана из коллекции/);
});

for (const padding of [0, 100]) test(`M: ранняя копия до заказа — сверка оплаты и её возврата за один проход без ложной выдачи (${padding})`, async (ctx) => {
  const original = shop();
  const restored = shop();
  ctx.after(() => { for (const t of [original, restored]) { t.app.stop(); t.app.store.close(); } });
  const p = await purchase(original, ALICE, 'graphit-table');
  assert.ok(p.ok);
  for (let i = 0; i < padding; i++) original.tg.stars.push({ id: `unrelated-${i}`, amount: 1, date: 0 });
  await refund(original, p.order.id);
  // Копия ничего не знает ни о заказе, ни о платеже. API выдаёт свежие первыми.
  restored.tg.stars = structuredClone(original.tg.stars);
  const networkDepths = [];
  for (const method of ['getStarTransactions', 'sendMessage']) {
    const real = restored.tg[method].bind(restored.tg);
    restored.tg[method] = (...args) => { networkDepths.push(restored.app.store.pay.depth); return real(...args); };
  }
  restored.openSolo(ALICE);
  const start = restored.page(ALICE).inbox.length;
  const r = await restored.app.payments.reconcile();
  assert.equal(r.refunds, 1, 'возврат найден в этом же проходе');
  assert.equal(r.unknownOut, 0, 'исходящий платёж не потерян из-за порядка списка');
  assert.equal(restored.app.store.pay.order(p.order.id).state, 'refunded');
  assert.deepEqual(restored.app.collections.ownedItems(ALICE.id), []);
  const all = restored.page(ALICE).inbox.slice(start).filter((m) => m.t === 'col');
  assert.ok(all.length > 0);
  assert.ok(all.every((m) => m.owned.length === 0), 'ни один отправленный кадр не выдаёт возвращённую вещь');
  assert.ok(restored.tg.dms(ALICE.id).every((text) => !text.includes('✅ <b>Куплено:')), 'нет ложного сообщения о покупке');
  assert.equal(restored.tg.calls.filter((c) => c.method === 'refundStarPayment').length, 0);
  const again = await restored.app.payments.reconcile();
  assert.equal(again.refunds, 0);
  assert.equal(again.recovered, 0);
  assert.ok(networkDepths.length > 0);
  assert.ok(networkDepths.every((depth) => depth === 0), 'сеть и уведомления вне транзакции базы');
});

test('M: сбой записи возврата при сверке откатывает также восстановленную оплату', async (ctx) => {
  const original = shop(), restored = shop();
  ctx.after(() => { for (const t of [original, restored]) { t.app.stop(); t.app.store.close(); } });
  const p = await purchase(original, ALICE, 'graphit-table');
  await refund(original, p.order.id);
  restored.tg.stars = structuredClone(original.tg.stars);
  const db = restored.app.store.pay;
  const done = db.refundDone;
  db.refundDone = () => { throw new Error('M: injected refund write failure'); };
  try {
    await assert.rejects(restored.app.payments.reconcile(), /M: injected refund write failure/);
    assert.equal(db.order(p.order.id), undefined, 'сбой сверки не оставляет половину восстановленной пары');
    assert.equal(db.payment(p.chargeId), undefined);
    assert.deepEqual(restored.app.collections.ownedItems(ALICE.id), []);
  } finally { db.refundDone = done; }
  assert.equal((await restored.app.payments.reconcile()).refunds, 1);
  assert.equal(db.order(p.order.id).state, 'refunded');
});

test('M: подтверждённые цены одинаковы в файле, пульте, карточках и счёте TelegramStub', async (ctx) => {
  const offers = readOffers();
  const expected = { 'graphit-cardback': 75, 'graphit-profile': 50, 'graphit-table': 100, 'graphit-bundle': 175 };
  assert.equal(offers.approved, true);
  assert.deepEqual(offers.items, expected);
  for (const [item, price] of Object.entries(expected)) {
    // Проекты рабочего репозитория остаются проектами; готовая конфигурация только в фикстуре.
    const t = shop({ prices: offers.items });
    ctx.after(() => { t.app.stop(); t.app.store.close(); });
    t.openAdmin(OWNER);
    assert.equal(t.state(OWNER).shop.items.find((o) => o.id === item).price, price);
    assert.equal(t.app.payments.shopState(ALICE.id).offers[item].price, price);
    const inv = await buy(t, ALICE, item);
    assert.equal(inv.price, price);
    assert.equal(t.app.store.pay.order(inv.order).price, price);
    const call = t.tg.calls.findLast((c) => c.method === 'createInvoiceLink');
    assert.deepEqual(call.prices.map((p) => p.amount), [price]);
    assert.equal(call.currency, 'XTR');
  }
});
