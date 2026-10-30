/**
 * Магазин в админке владельца (шаг H): цены, скрыть/показать, выдать/забрать, заказы, возврат, остановка продаж.
 * Платёжный API — только заглушка (bot/tg-stub.js): реальных счетов и денег нет. Контракт —
 * docs/next-release/payment-design.md, «Цены и выдача админом». «На зубы» — node tools/adminshop-teeth.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { Store } from './store.js';
import { PAYLOAD_PREFIX } from './payments/index.js';
import { ASHOP_OPS, ASHOP_PER_MINUTE } from './payments/admin.js';
import { PRECHECKOUT } from '../miniapp/collections/pay-protocol.js';
import {
  shop, cfgOf, ALICE, BOB, OWNER, PRICES, buy, preCheckout, paid, purchase, owner, req, pays, lastCol,
} from './payments/testkit.js';

const P = (o) => PAYLOAD_PREFIX + o;
const calls = (t, m) => t.tg.calls.filter((c) => c.method === m);
const sources = (t, u, item) => [...(t.app.collections.sourcesOf(u.id).get(item) ?? [])].sort();

/** Стол с продажами в заглушке и открытой админкой владельца. */
function adminShop(opts = {}, tableOpts = {}) {
  const t = shop(opts, tableOpts);
  assert.ok(t.openAdmin(OWNER).session, 'владелец входит в админку');
  return t;
}
const answers = (t, u = OWNER) => t.page(u).inbox.filter((m) => m.t === 'ashop');
/** Одно действие на вкладке «Магазин»: ответ сервера. */
async function ash(t, msg, u = OWNER) {
  const from = t.page(u).inbox.length;
  await t.send(u, { t: 'ashop', ...msg });
  // Ответ на это действие (после него хаб ещё досылает свежее состояние вкладки).
  return t.page(u).inbox.slice(from).find((m) => m.t === 'ashop' || m.t === 'error') ?? null;
}
/** Цена двумя шагами: «было → стало» с кодом, затем «Подтвердить». */
async function setPrice(t, item, price) {
  const a = await ash(t, { op: 'price', item, price });
  assert.equal(a.op, 'ask', JSON.stringify(a));
  return { ask: a.ask, done: await ash(t, { op: 'confirm', code: a.ask.code, req: req('c') }) };
}
const grant = (t, u, item, r = req('g')) => ash(t, { op: 'grant', user: String(u.id), item, req: r });
const revoke = (t, u, item, r = req('r')) => ash(t, { op: 'revoke', user: String(u.id), item, req: r });
/** Состояние вкладки «Магазин», как после «Обновить». */
async function shopView(t) {
  await t.send(OWNER, { t: 'refresh' });
  return t.state(OWNER).shop;
}

/* ----------------------------------------------------------------- доступ */

test('не-владелец: каждая операция «Магазина» — отказ, как на непонятный запрос; ничего не меняется', async () => {
  const t = adminShop();
  const inv = await purchase(t, ALICE, 'graphit-table');
  t.openSolo(BOB);
  const tries = {
    price: { item: 'graphit-table', price: 1 }, hide: { item: 'graphit-table', hidden: true }, approve: { on: false },
    confirm: { code: 'deadbeef' }, grant: { user: String(BOB.id), item: 'graphit-bundle' }, revoke: { user: String(ALICE.id), item: 'graphit-table' },
    user: { q: String(ALICE.id) }, orders: { q: '' }, refund: { order: inv.order.id }, refundConfirm: { order: inv.order.id, code: '000000' }, sales: { stop: true },
  };
  assert.deepEqual(Object.keys(tries).sort(), [...ASHOP_OPS].sort(), 'проверены все операции');
  for (const [op, body] of Object.entries(tries)) {
    await t.send(BOB, { t: 'ashop', op, ...body, req: req('x') });
    const last = t.page(BOB).inbox.at(-1);
    assert.deepEqual({ t: last.t, code: last.code, text: last.text }, { t: 'error', code: 'BAD_REQUEST', text: 'Не понял запрос.' }, op);
    // Тот же отказ, что на выдуманный тип: о существовании вкладки он не узнаёт.
    await t.send(BOB, { t: 'nosuchthing' });
    assert.equal(t.page(BOB).inbox.at(-1).text, last.text);
  }
  // С экрана стола в группе — тоже отказ (не уходит в игру).
  await t.seat([ALICE, BOB]);
  t.openRoom(ALICE, t.room);
  await t.send(ALICE, { t: 'ashop', op: 'grant', user: String(ALICE.id), item: 'graphit-bundle', req: req('x') });
  assert.equal(t.page(ALICE).inbox.at(-1).code, 'BAD_REQUEST');
  assert.equal(t.received(BOB).includes(inv.order.id), false, 'ни одного номера чужого заказа');
  assert.deepEqual(t.app.collections.ownedItems(BOB.id), [], 'ничего не выдано');
  assert.equal(t.app.store.pay.stopped(), false, 'продажи не остановлены');
  assert.equal(t.app.payments.offers().items['graphit-table'], PRICES['graphit-table'], 'цена прежняя');
  assert.equal(t.app.payments.offers().hidden.length, 0);
  assert.equal(calls(t, 'refundStarPayment').length, 0, 'возврата не было');
  assert.deepEqual(t.app.store.pay.adminLogs(), [], 'журнал пуст');
});

test('владельца убрали из ADMINS при открытой вкладке — следующее действие уже отказ', async () => {
  const t = adminShop();
  assert.equal((await grant(t, ALICE, 'graphit-profile')).ok, true);
  t.app.admins.delete(String(OWNER.id));
  const r = await grant(t, BOB, 'graphit-profile');
  assert.equal(r.code, 'BAD_REQUEST');
  assert.deepEqual(t.app.collections.ownedItems(BOB.id), []);
});

test('поля страницы «кто» ничего не значат: выдаёт и пишет в журнал тот, чья подпись', async () => {
  const t = adminShop();
  await ash(t, { op: 'grant', user: String(ALICE.id), item: 'graphit-profile', req: req('g'), by: '1', admin: '1', from: { id: 1 } });
  assert.equal(t.app.store.pay.adminLogs()[0].by, String(OWNER.id));
});

/* ------------------------------------------------------- выдать / забрать */

test('выдача — отдельный источник: не платёж, не покупка; в «Мои покупки» — «подарок», в /paysupport — нет', async () => {
  const t = adminShop();
  const r = await grant(t, ALICE, 'graphit-bundle');
  assert.equal(r.ok, true);
  assert.match(r.text, /подарок от администратора, не покупка/);
  assert.deepEqual(t.app.collections.ownedItems(ALICE.id).sort(), ['graphit-cardback', 'graphit-profile', 'graphit-table'], 'комплект — его три вещи');
  for (const it of ['graphit-cardback', 'graphit-profile', 'graphit-table']) assert.deepEqual(sources(t, ALICE, it), ['admin']);
  const db = t.app.store.pay.db;
  for (const tbl of ['pay_order', 'pay_payment', 'pay_entitlement', 'pay_refund']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${tbl}`).get().n, 0, `${tbl} пуст`);
  assert.equal(calls(t, 'createInvoiceLink').length, 0, 'счёта не было');
  t.openSolo(ALICE);
  await t.send(ALICE, { t: 'pay', op: 'history' });
  const h = pays(t, ALICE).at(-1).orders;
  assert.equal(h.length, 3);
  assert.ok(h.every((o) => o.state === 'gift' && o.price === 0 && o.id.startsWith('gift-')), JSON.stringify(h));
  await t.dm(ALICE, '/paysupport');
  assert.match(t.lastDm(ALICE), /Покупок у вас нет/, 'подарок не выдаётся за покупку');
  assert.ok(lastCol(t, ALICE).owned.every((o) => o.source.includes('admin')));
  // Купить выданное нельзя — платить за то, что есть, незачем.
  assert.equal((await buy(t, ALICE, 'graphit-table')).error.code, 'PAY_OWNED');
});

test('купил + выдан → забрали выдачу → осталось купленное и надетый вид', async () => {
  const t = adminShop();
  const p = await purchase(t, ALICE, 'graphit-cardback');
  assert.ok(p.ok);
  await t.send(ALICE, { t: 'col', op: 'apply', slot: 'cardback', item: 'graphit-cardback', color: 'petrol', req: req('a') });
  await grant(t, ALICE, 'graphit-cardback');
  assert.deepEqual(sources(t, ALICE, 'graphit-cardback'), ['admin', 'purchase']);
  const r = await revoke(t, ALICE, 'graphit-cardback');
  assert.match(r.text, /Купленное, если было, осталось/);
  assert.deepEqual(sources(t, ALICE, 'graphit-cardback'), ['purchase']);
  assert.equal(t.app.collections.choiceOf(ALICE.id).cardback?.color, 'petrol', 'вид не снят: право осталось');
  assert.equal(t.app.store.pay.order(p.order.id).state, 'paid', 'заказ не тронут');
  // Повторное «Забрать»: забирать нечего, купленное админка не трогает.
  assert.match((await revoke(t, ALICE, 'graphit-cardback')).text, /нет вашей выдачи/);
  assert.deepEqual(sources(t, ALICE, 'graphit-cardback'), ['purchase']);
});

test('обратное: купил + выдан → возврат покупки → осталась выдача и вид', async () => {
  const t = adminShop();
  const p = await purchase(t, ALICE, 'graphit-table');
  await t.send(ALICE, { t: 'col', op: 'apply', slot: 'table', item: 'graphit-table', color: 'sapphire', req: req('a') });
  await grant(t, ALICE, 'graphit-table');
  const ask = await ash(t, { op: 'refund', order: p.order.id });
  const done = await ash(t, { op: 'refundConfirm', order: p.order.id, code: ask.ask.code, req: req('f') });
  assert.match(done.text, /Возврат .* выполнен/);
  assert.deepEqual(sources(t, ALICE, 'graphit-table'), ['admin']);
  assert.equal(t.app.collections.choiceOf(ALICE.id).table?.color, 'sapphire');
});

test('только выдано и надето → забрали → вид снят и в базе, страница узнала', async () => {
  const t = adminShop({ mode: 'off' });
  await grant(t, ALICE, 'graphit-profile');
  t.openSolo(ALICE);
  await t.send(ALICE, { t: 'col', op: 'apply', slot: 'profile', item: 'graphit-profile', color: 'bordeaux', req: req('a') });
  assert.equal(t.app.collections.choiceOf(ALICE.id).profile?.item, 'graphit-profile');
  await revoke(t, ALICE, 'graphit-profile');
  assert.equal(t.app.collections.choiceOf(ALICE.id).profile, null);
  assert.deepEqual(t.app.store.collChoices(ALICE.id), []);
  assert.deepEqual(lastCol(t, ALICE).owned, []);
});

test('продажи выключены (прод по умолчанию): подарок всё равно виден и надевается; тестерского доступа нет', async () => {
  const t = new Table({ admins: [String(OWNER.id)] });
  assert.equal(t.app.payments.cfg.mode, 'off');
  t.openAdmin(OWNER);
  t.app.cosmeticsTesters.add(String(BOB.id));
  assert.equal(t.app.collections.visibleFor(ALICE.id), false);
  await grant(t, ALICE, 'graphit-table');
  assert.equal(t.app.collections.visibleFor(ALICE.id), true);
  assert.deepEqual(t.app.collections.ownedItems(ALICE.id), ['graphit-table']);
  assert.equal(t.app.collections.visibleFor(BOB.id), false, 'тестер при выключенных продажах по-прежнему ничего не видит');
  assert.equal(t.app.payments.open, false, 'продажи не открылись');
});

test('повторное нажатие (тот же req): выдача и забор — один раз, одна строка журнала', async () => {
  const t = adminShop();
  const r = req('g');
  assert.equal((await grant(t, ALICE, 'graphit-profile', r)).ok, true);
  await revoke(t, ALICE, 'graphit-profile');
  const again = await grant(t, ALICE, 'graphit-profile', r);
  assert.equal(again.repeat, true);
  assert.deepEqual(t.app.collections.ownedItems(ALICE.id), [], 'повтор старого нажатия не выдал заново');
  assert.equal(t.app.store.pay.adminLogs().filter((l) => l.event === 'grant').length, 1);
  // Без req менять нельзя.
  const bare = await ash(t, { op: 'grant', user: String(ALICE.id), item: 'graphit-profile' });
  assert.equal(bare.error?.code, 'REQ');
  assert.deepEqual(t.app.collections.ownedItems(ALICE.id), []);
});

test('выдать: неверный id и выдуманная вещь — отказ словами; «Ночной казино-клуб» не выдаётся', async () => {
  const t = adminShop();
  for (const u of ['', 'abc', '-5', '0', '1'.repeat(25)]) assert.equal((await ash(t, { op: 'grant', user: u, item: 'graphit-table', req: req('g') })).error.code, 'USER', u);
  for (const it of ['night-cardback', 'graphit-nope', '', null]) assert.equal((await ash(t, { op: 'grant', user: String(ALICE.id), item: it, req: req('g') })).error.code, 'ITEM', String(it));
  assert.equal(t.app.store.pay.db.prepare('SELECT COUNT(*) n FROM shop_grant').get().n, 0);
});

test('поиск человека по id и по нику из профиля; показ — откуда вещь', async () => {
  const t = adminShop({}, { store: new Store(':memory:') });
  t.app.store.putProfile(String(ALICE.id), { nickname: 'Лиса', avatar: null });
  await grant(t, ALICE, 'graphit-cardback');
  const byNick = await ash(t, { op: 'user', q: 'лис' });
  assert.deepEqual(byNick.found, [{ id: String(ALICE.id), nick: 'Лиса' }]);
  const byId = await ash(t, { op: 'user', q: String(ALICE.id) });
  assert.equal(byId.user.nick, 'Лиса');
  assert.deepEqual(byId.user.items, [{ item: 'graphit-cardback', title: 'Рубашка «Графит»', source: ['admin'] }]);
  assert.equal((await ash(t, { op: 'user', q: 'x' })).error.code, 'USER', 'одна буква — слишком широко');
  // Имена в общем состоянии вкладки не появляются — только по запросу на поиск.
  assert.equal(JSON.stringify(t.state(OWNER)).includes('Лиса'), false);
});

/* ------------------------------------------------------------------ цены */

test('цена — двумя шагами; действует на новые заказы, выставленный счёт со старой ценой не оплатить', async () => {
  const t = adminShop();
  const old = await buy(t, ALICE, 'graphit-table');
  assert.equal(old.price, PRICES['graphit-table']);
  const first = await ash(t, { op: 'price', item: 'graphit-table', price: 120 });
  assert.equal(first.op, 'ask');
  assert.match(first.ask.text, new RegExp(`${PRICES['graphit-table']} ⭐ → 120 ⭐`));
  assert.match(first.ask.text, /уже выставленный счёт со старой ценой оплатить будет нельзя/);
  assert.equal(t.app.payments.offers().items['graphit-table'], PRICES['graphit-table'], 'до подтверждения цена прежняя');
  const done = await ash(t, { op: 'confirm', code: first.ask.code, req: req('c') });
  assert.equal(done.ok, true);
  assert.equal(t.app.payments.offers().items['graphit-table'], 120);
  assert.equal(t.app.store.pay.order(old.order).price, PRICES['graphit-table'], 'цена заказа задним числом не меняется');
  assert.equal((await preCheckout(t, ALICE, { payload: P(old.order), amount: old.price })).error, PRECHECKOUT.changed);
  // Подменить сумму в pre_checkout на новую — тоже нет: сумма должна совпасть с заказом.
  assert.equal((await preCheckout(t, ALICE, { payload: P(old.order), amount: 120 })).ok, false);
  const fresh = await buy(t, BOB, 'graphit-table');
  assert.equal(fresh.price, 120, 'новый заказ — по новой цене');
  const log = t.app.store.pay.adminLogs().find((l) => l.event === 'price');
  assert.deepEqual({ by: log.by, item: log.item, before: log.before, after: log.after }, { by: String(OWNER.id), item: 'graphit-table', before: String(PRICES['graphit-table']), after: '120' });
  // Код одноразовый.
  assert.equal((await ash(t, { op: 'confirm', code: first.ask.code, req: req('c') })).error.code, 'CODE');
});

test('цена: диапазон 1…10.000, та же цена, чужой и устаревший код, перехват устаревшего «было»', async () => {
  const t = adminShop();
  for (const p of [0, -1, 10_001, 1.5, '50', null]) assert.equal((await ash(t, { op: 'price', item: 'graphit-table', price: p })).error.code, 'PRICE', String(p));
  assert.equal((await ash(t, { op: 'price', item: 'night-table', price: 50 })).error.code, 'ITEM');
  assert.equal((await ash(t, { op: 'price', item: 'graphit-table', price: PRICES['graphit-table'] })).error.code, 'SAME');
  assert.equal((await ash(t, { op: 'confirm', code: 'deadbeef', req: req('c') })).error.code, 'CODE');
  const late = await ash(t, { op: 'price', item: 'graphit-table', price: 60 });
  await t.advance(11 * 60_000);
  assert.equal((await ash(t, { op: 'confirm', code: late.ask.code, req: req('c') })).error.code, 'CODE', 'старше 10 минут — нет');
  // Два окна: первое подтвердили, второе («было» уже другое) не перетирает молча.
  const a = await ash(t, { op: 'price', item: 'graphit-table', price: 60 });
  const b = await ash(t, { op: 'price', item: 'graphit-table', price: 70 });
  await ash(t, { op: 'confirm', code: a.ask.code, req: req('c') });
  assert.equal((await ash(t, { op: 'confirm', code: b.ask.code, req: req('c') })).error.code, 'STALE');
  assert.equal(t.app.payments.offers().items['graphit-table'], 60);
  assert.equal((await setPrice(t, 'graphit-table', 10_000)).done.ok, true, 'верхняя граница — можно');
  assert.equal((await setPrice(t, 'graphit-table', 1)).done.ok, true, 'нижняя граница — можно');
});

test('цена переживает перезапуск (в базе); offers.json — значения по умолчанию', async () => {
  const store = new Store(':memory:');
  const t = adminShop({}, { store });
  await setPrice(t, 'graphit-profile', 42);
  const t2 = shop({}, { store });
  assert.equal(t2.app.payments.offers().items['graphit-profile'], 42);
  assert.equal(t2.app.payments.offers().items['graphit-table'], PRICES['graphit-table']);
  assert.equal((await buy(t2, ALICE, 'graphit-profile')).price, 42);
});

test('скрыть/показать: скрытую не купить и старый счёт не оплатить; купленное и выданное остаются', async () => {
  const t = adminShop();
  const p = await purchase(t, BOB, 'graphit-table');
  await grant(t, BOB, 'graphit-profile');
  const old = await buy(t, ALICE, 'graphit-table');
  const r = await ash(t, { op: 'hide', item: 'graphit-table', hidden: true, req: req('h') });
  assert.match(r.text, /скрыта/);
  assert.equal((await buy(t, ALICE, 'graphit-table')).error.code, 'PAY_ITEM');
  assert.equal((await preCheckout(t, ALICE, { payload: P(old.order), amount: old.price })).error, PRECHECKOUT.changed);
  assert.equal((await shopView(t)).items.find((x) => x.id === 'graphit-table').hidden, true);
  assert.equal(lastCol(t, ALICE).shop.offers['graphit-table'].price, null, 'страница цену скрытой не видит');
  assert.deepEqual(t.app.collections.ownedItems(BOB.id).sort(), ['graphit-profile', 'graphit-table']);
  assert.equal(t.app.store.pay.order(p.order.id).state, 'paid');
  // В тестовом режиме скрытая не продаётся даже за 1 ⭐.
  assert.equal((await buy(t, ALICE, 'graphit-table')).error.code, 'PAY_ITEM');
  await ash(t, { op: 'hide', item: 'graphit-table', hidden: false, req: req('h') });
  assert.ok((await buy(t, ALICE, 'graphit-table')).link);
});

test('утвердить цены — двумя шагами; утверждение снимает только свою причину в «Готовности»', async () => {
  const t = adminShop({ mode: 'live', approved: false });
  assert.ok((await shopView(t)).reasons.some((x) => /не утверждены/.test(x)));
  const a = await ash(t, { op: 'approve', on: true });
  assert.equal(a.op, 'ask');
  assert.equal(t.app.payments.open, false, 'до подтверждения — закрыто');
  await ash(t, { op: 'confirm', code: a.ask.code, req: req('c') });
  assert.equal((await shopView(t)).approved, true);
  assert.equal(t.app.payments.open, true, 'в тестовой заглушке остальное выполнено');
  const b = await ash(t, { op: 'approve', on: false });
  await ash(t, { op: 'confirm', code: b.ask.code, req: req('c') });
  assert.equal(t.app.payments.open, false);
  assert.ok((await shopView(t)).reasons.some((x) => /не утверждены/.test(x)));
});

test('«Готовность к продаже» — причины из gate() словами; цены и утверждение в прод-режиме продаж не открывают', async () => {
  const t = new Table({ admins: [String(OWNER.id)] });
  t.openAdmin(OWNER);
  const v = (await shopView(t));
  assert.equal(v.mode, 'off');
  assert.equal(v.open, false);
  assert.deepEqual(v.reasons, t.app.payments.gate().reasons);
  assert.ok(v.reasons.some((x) => /SALES_MODE/.test(x)));
  assert.deepEqual(Object.fromEntries(v.items.map((x) => [x.id, x.price])), { 'graphit-cardback': 75, 'graphit-table': 100, 'graphit-profile': 50, 'graphit-bundle': 175 });
  const a = await ash(t, { op: 'approve', on: true });
  await ash(t, { op: 'confirm', code: a.ask.code, req: req('c') });
  assert.equal(t.app.payments.open, false, 'режим off остаётся закрытым');
});

/* ------------------------------------------------------ заказы и возвраты */

test('заказы: список и поиск по id игрока и началу номера', async () => {
  const t = adminShop();
  const a = await purchase(t, ALICE, 'graphit-table');
  await purchase(t, BOB, 'graphit-profile');
  assert.equal((await shopView(t)).orders.length, 2);
  const mine = await ash(t, { op: 'orders', q: String(ALICE.id) });
  assert.deepEqual(mine.orders.map((o) => o.id), [a.order.id]);
  assert.equal(mine.orders[0].state, 'paid');
  const byNo = await ash(t, { op: 'orders', q: a.order.id.slice(0, 6) });
  assert.deepEqual(byNo.orders.map((o) => o.id), [a.order.id]);
  assert.deepEqual((await ash(t, { op: 'orders', q: '%' })).orders, [], 'шаблоны SQL — не поиск');
});

test('возврат — только тем же двухшаговым кодом, что /refund; без кода, с чужим и старым кодом — ничего', async () => {
  const t = adminShop();
  const p = await purchase(t, ALICE, 'graphit-cardback');
  // Без шага 1.
  const bare = await ash(t, { op: 'refundConfirm', order: p.order.id, code: '123456', req: req('f') });
  assert.equal(bare.error.code, 'REFUND');
  assert.match(bare.error.text, /Код не подходит/);
  assert.equal(calls(t, 'refundStarPayment').length, 0);
  // Шаг 1 — те же слова и сумма, что у бота.
  const ask = await ash(t, { op: 'refund', order: p.order.id });
  assert.equal(ask.ask.kind, 'refund');
  assert.equal(ask.ask.amount, PRICES['graphit-cardback']);
  assert.match(ask.ask.text, /Права на вещь будут сняты/);
  assert.equal((await ash(t, { op: 'refundConfirm', order: p.order.id, code: 'ffffff', req: req('f') })).error.code, 'REFUND');
  assert.equal(calls(t, 'refundStarPayment').length, 0, 'неверный код — денег не трогаем');
  // Неверный код не сжигает верный (как у бота: проверка до удаления), но верный — одноразовый.
  const ask2 = await ash(t, { op: 'refund', order: p.order.id });
  const done = await ash(t, { op: 'refundConfirm', order: p.order.id, code: ask2.ask.code, req: req('f') });
  assert.equal(done.ok, true);
  assert.equal(calls(t, 'refundStarPayment').length, 1);
  assert.equal((await ash(t, { op: 'refundConfirm', order: p.order.id, code: ask2.ask.code, req: req('f') })).error.code, 'REFUND');
  const again = await ash(t, { op: 'refund', order: p.order.id });
  assert.match(again.error.text, /уже выполнен/);
  assert.equal(calls(t, 'refundStarPayment').length, 1, 'второго возврата нет');
  assert.equal(t.app.store.pay.order(p.order.id).state, 'refunded');
});

test('код из админки и из бота — один и тот же механизм: шаг 1 на странице, шаг 2 командой /refund', async () => {
  const t = adminShop();
  const p = await purchase(t, ALICE, 'graphit-profile');
  const ask = await ash(t, { op: 'refund', order: p.order.id });
  assert.match(await owner(t, `/refund ${p.order.id} ${ask.ask.code}`), /выполнен/);
  assert.equal(calls(t, 'refundStarPayment').length, 1);
});

test('возврат неоплаченного и несуществующего заказа — отказ словами, денег не трогаем', async () => {
  const t = adminShop();
  const inv = await buy(t, ALICE, 'graphit-table');
  assert.match((await ash(t, { op: 'refund', order: inv.order })).error.text, /не оплачен/);
  assert.match((await ash(t, { op: 'refund', order: 'ffffffffffffffff' })).error.text, /Такого заказа нет/);
  assert.equal(calls(t, 'refundStarPayment').length, 0);
});

/* ---------------------------------------------------------------- продажи */

test('«Остановить новые продажи» — то же, что /salesstop: оплаченное выдаётся; «Возобновить» снимает', async () => {
  const t = adminShop();
  const inv = await buy(t, BOB, 'graphit-table');
  await preCheckout(t, BOB, { payload: P(inv.order), amount: inv.price });
  const left = await buy(t, ALICE, 'graphit-table');
  const r = await ash(t, { op: 'sales', stop: true, req: req('s') });
  assert.match(r.text, /остановлены/);
  assert.equal((await shopView(t)).stopped, true, 'вкладка показывает остановку');
  assert.ok((await shopView(t)).reasons.some((x) => /остановлены владельцем/.test(x)));
  assert.match(await owner(t, '/sales'), /остановка: да/, 'бот видит ту же остановку');
  assert.equal((await buy(t, ALICE, 'graphit-cardback')).error.code, 'PAY_CLOSED');
  assert.equal((await preCheckout(t, ALICE, { payload: P(left.order), amount: left.price })).error, PRECHECKOUT.closed);
  await paid(t, BOB, { payload: P(inv.order), amount: inv.price });
  assert.deepEqual(t.app.collections.ownedItems(BOB.id), ['graphit-table'], 'уже подтверждённая оплата выдаётся');
  assert.equal(lastCol(t, BOB).shop.open, false, 'страницы игроков узнали сразу');
  await ash(t, { op: 'sales', stop: false, req: req('s') });
  assert.equal(t.app.store.pay.stopped(), false);
  assert.ok((await buy(t, ALICE, 'graphit-cardback')).link);
  const ev = t.app.store.pay.logs().map((l) => l.event);
  assert.ok(ev.includes('sales-stop') && ev.includes('sales-resume'), 'в платёжном журнале, как у /salesstop');
});

/* ---------------------------------------------------- частота и журнал */

test(`лимит частоты: ${ASHOP_PER_MINUTE} действий в минуту на владельца, потом отказ словами; через минуту — снова`, async () => {
  const t = adminShop();
  for (let i = 0; i < ASHOP_PER_MINUTE; i++) assert.ok(!(await ash(t, { op: 'orders', q: '' })).error, `#${i}`);
  const r = await grant(t, ALICE, 'graphit-profile');
  assert.equal(r.error.code, 'FAST');
  assert.equal(r.error.text, 'Слишком часто. Подождите минуту.');
  assert.deepEqual(t.app.collections.ownedItems(ALICE.id), []);
  await t.advance(61_000);
  assert.equal((await grant(t, ALICE, 'graphit-profile')).ok, true);
});

test('журнал и состояние вкладки: без имён, initData, токена и карт; открытые админки получают новое состояние', async () => {
  const t = adminShop();
  const before = t.page(OWNER).inbox.filter((m) => m.t === 'state').length;
  await grant(t, ALICE, 'graphit-table');
  await setPrice(t, 'graphit-cardback', 80);
  assert.ok(t.page(OWNER).inbox.filter((m) => m.t === 'state').length > before, 'после действия — свежее состояние');
  const all = t.received(OWNER);
  for (const bad of ['Алиса', 'Боб', 'hash=', 'auth_date', 'test-token']) assert.equal(all.includes(bad), false, bad);
  const log = t.app.store.pay.adminLogs();
  assert.deepEqual(log.map((l) => l.event), ['price', 'grant']);
  assert.ok(log.every((l) => l.by === String(OWNER.id)));
  assert.equal((await shopView(t)).log.length, 2);
});

test('во время обслуживания вкладка работает (владелец — не игрок), покупки игроков — нет', async () => {
  const t = adminShop();
  t.app.setMaintenance(true, 'тест');
  assert.equal((await grant(t, ALICE, 'graphit-profile')).ok, true);
  assert.ok((await shopView(t)).reasons.some((x) => /обслуживание/.test(x)));
  t.app.setMaintenance(false);
});

test('второй владелец из ADMINS: действует сам, в журнале — его id', async () => {
  const t = adminShop();
  const other = user(710009998, 'Второй');
  t.app.admins.add(String(other.id));
  t.openAdmin(other);
  assert.equal((await ash(t, { op: 'grant', user: String(ALICE.id), item: 'graphit-profile', req: req('g') }, other)).ok, true);
  assert.equal(t.app.store.pay.adminLogs()[0].by, String(other.id));
});
