/**
 * Покупки косметики за Stars: заказ, pre_checkout, выдача, возврат, сверка, выключатель продаж.
 * Платёжный API — только заглушка (bot/tg-stub.js): реальных счетов и денег здесь нет.
 * Контракт — docs/next-release/payment-design.md. «На зубы» — node tools/payments-teeth.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Table, FakeClock } from './harness.js';
import { Store, SCHEMA_VERSION } from './store.js';
import { App } from './app.js';
import { PAYLOAD_PREFIX } from './payments/index.js';
import { salesConfig, gate, readOffers, normalizeOffers, SELLABLE, priceOf } from './payments/config.js';
import { PRECHECKOUT, PAY_ERRORS } from '../miniapp/collections/pay-protocol.js';
import {
  shop, cfgOf, readyLegal, ALICE, BOB, OWNER, PRICES, buy, preCheckout, paid, purchase, owner, refund, req,
  pays, lastCol, charge,
} from './payments/testkit.js';

const P = (o) => PAYLOAD_PREFIX + o;
const owned = (t, u) => t.app.collections.ownedItems(u.id).sort();
const entRows = (t) => t.app.store.pay.db.prepare('SELECT * FROM pay_entitlement').all();
const payRows = (t) => t.app.store.pay.db.prepare('SELECT * FROM pay_payment').all();
const calls = (t, m) => t.tg.calls.filter((c) => c.method === m);

/* ------------------------------------------------------------ выключатель */

test('по умолчанию продажи закрыты: режим off, счёта нет, коллекции никому не видны', async () => {
  const t = new Table({ admins: [String(OWNER.id)] });
  t.tg.dmOpen.add(String(ALICE.id));
  assert.equal(t.app.payments.cfg.mode, 'off');
  assert.equal(t.app.payments.open, false);
  t.openSolo(ALICE);
  await t.send(ALICE, { t: 'pay', op: 'buy', item: 'graphit-table', req: req() });
  assert.equal(pays(t, ALICE).at(-1).error.code, 'PAY_CLOSED');
  assert.equal(calls(t, 'createInvoiceLink').length, 0);
  // Прод без изменений: ни игроку, ни админу коллекции не показываются, тестерского доступа нет.
  for (const u of [ALICE, OWNER]) {
    assert.equal(t.app.collections.visibleFor(u.id), false);
    assert.deepEqual(t.app.collections.ownedItems(u.id), []);
  }
  t.openSolo(OWNER);
  assert.equal(t.page(OWNER).inbox.some((m) => m.t === 'col'), false, 'страница не получает состояния коллекций');
});

test('offers.json в репозитории: цены не утверждены — настоящие продажи не откроются', () => {
  const offers = readOffers();
  assert.equal(offers.approved, false);
  for (const id of SELLABLE) assert.equal(offers.items[id], null, `цена ${id} не задана`);
  const g = gate(salesConfig({ SALES_MODE: 'live', PAY_SUPPORT: '@x' }));
  assert.equal(g.open, false);
  assert.ok(g.reasons.some((r) => /не утверждены/.test(r)));
  assert.ok(g.reasons.some((r) => /terms-of-purchase\.md не готов/.test(r)), 'проекты документов не пускают в продажу');
});

test('live открывается только при всех условиях; каждое по отдельности закрывает', () => {
  assert.equal(gate(cfgOf({ mode: 'live' })).open, true, 'всё заполнено — открыто');
  const closed = {
    'цены не утверждены': cfgOf({ mode: 'live', approved: false }),
    'нет ни одной цены': cfgOf({ mode: 'live', prices: {} }),
    'нет контакта поддержки': cfgOf({ mode: 'live', support: '' }),
    'документ — проект': cfgOf({ mode: 'live', legal: readyLegal({ status: 'ПРОЕКТ' }) }),
    'незаполненные поля': cfgOf({ mode: 'live', legal: readyLegal({ blanks: true }) }),
    'версия условий не та': cfgOf({ mode: 'live', terms: '0.9' }),
    'тестовая среда': cfgOf({ mode: 'live', testEnv: true }),
  };
  for (const [why, cfg] of Object.entries(closed)) assert.equal(gate(cfg).open, false, why);
  assert.equal(gate(cfgOf({ mode: 'live' }), { stopped: true }).open, false, 'остановка владельцем');
  assert.equal(gate(cfgOf({ mode: 'live' }), { down: true }).open, false, 'обслуживание');
  assert.equal(gate(cfgOf({ mode: 'test', testEnv: false })).open, false, 'test без тестовой среды');
  // Строгие значения: «LIVE», «1», пробелы — это off.
  for (const v of ['LIVE', ' live', '1', 'true', 'yes']) assert.equal(salesConfig({ SALES_MODE: v }).mode, 'off', v);
});

test('продаётся только «Графит»: «Ночной казино-клуб» и выдуманные id в предложения не попадают', () => {
  const o = normalizeOffers({ approved: true, items: { 'night-cardback': 10, 'graphit-table': 5, 'chips-1000': 1, __proto__: 1 } });
  assert.deepEqual(Object.keys(o.items).sort(), [...SELLABLE].sort());
  assert.ok([...SELLABLE].every((id) => id.startsWith('graphit-')));
  const cfg = cfgOf({ mode: 'live' });
  assert.equal(priceOf(cfg, 'night-cardback'), null);
  assert.equal(priceOf(cfg, 'graphit-table'), PRICES['graphit-table']);
});

/* --------------------------------------------------------------- успех */

test('успех: вещь → счёт → pre_checkout → оплата → вещь в коллекции, личка, история, надеть', async () => {
  const t = shop();
  const r = await purchase(t, ALICE, 'graphit-table');
  assert.ok(r.ok);
  assert.equal(r.order.state, 'paid');
  assert.equal(r.order.price, PRICES['graphit-table']);
  assert.equal(r.order.currency, 'XTR');
  assert.equal(r.order.terms, '1.0', 'заказ помнит версию условий');
  assert.deepEqual(owned(t, ALICE), ['graphit-table']);
  const inv = calls(t, 'createInvoiceLink')[0];
  assert.equal(inv.currency, 'XTR');
  assert.equal(inv.prices.length, 1);
  assert.match(inv.title, /^ТЕСТ · /, 'в тестовом режиме счёт помечен');
  assert.match(t.lastDm(ALICE), /Куплено: Стол «Графит»/);
  // Страница получила новое состояние сама — без «обновить».
  const st = lastCol(t, ALICE);
  assert.deepEqual(st.owned, [{ item: 'graphit-table', demo: false, source: ['purchase'] }]);
  // Надеть — через обычный протокол коллекций.
  await t.send(ALICE, { t: 'col', op: 'apply', slot: 'table', item: 'graphit-table', color: 'sapphire', req: req('a') });
  assert.equal(t.app.collections.choiceOf(ALICE.id).table.color, 'sapphire');
  // История — только своя.
  await t.send(ALICE, { t: 'pay', op: 'history' });
  const h = pays(t, ALICE).at(-1);
  assert.equal(h.orders.length, 1);
  assert.equal(h.orders[0].state, 'paid');
  t.openSolo(BOB);
  await t.send(BOB, { t: 'pay', op: 'history' });
  assert.deepEqual(pays(t, BOB).at(-1).orders, []);
  assert.deepEqual(t.errors, []);
});

test('pre_checkout: единственный вызов Telegram — сам ответ, без других запросов перед ним', async () => {
  const t = shop();
  const inv = await buy(t, ALICE, 'graphit-profile');
  const before = t.tg.calls.length;
  const ans = await preCheckout(t, ALICE, { payload: P(inv.order), amount: inv.price });
  assert.equal(ans.ok, true);
  assert.deepEqual(t.tg.calls.slice(before).map((c) => c.method), ['answerPreCheckoutQuery']);
});

test('отмена окна оплаты и нехватка Stars: оплаты нет — вещи нет, в истории пусто', async () => {
  const t = shop();
  const inv = await buy(t, ALICE, 'graphit-table');
  assert.ok(inv.link);
  // Telegram сам предлагает пополнить Stars; боту не приходит ничего, кроме, может быть, pre_checkout.
  await preCheckout(t, ALICE, { payload: P(inv.order), amount: inv.price });
  assert.deepEqual(owned(t, ALICE), []);
  await t.send(ALICE, { t: 'pay', op: 'history' });
  assert.deepEqual(pays(t, ALICE).at(-1).orders, []);
});

/* --------------------------------------------------------- повторы */

test('двойное нажатие «Купить»: один заказ и один счёт', async () => {
  const t = shop();
  t.openSolo(ALICE);
  const s = t.page(ALICE).session;
  await Promise.all([
    t.hub.handle(s, { t: 'pay', op: 'buy', item: 'graphit-table', req: req() }),
    t.hub.handle(s, { t: 'pay', op: 'buy', item: 'graphit-table', req: req() }),
  ]);
  const got = pays(t, ALICE).filter((m) => m.op === 'buy');
  assert.equal(got.length, 2);
  assert.equal(got[0].order, got[1].order);
  assert.equal(calls(t, 'createInvoiceLink').length, 1);
  // И позже — тот же счёт, пока он жив.
  const again = await buy(t, ALICE, 'graphit-table');
  assert.equal(again.order, got[0].order);
  assert.equal(calls(t, 'createInvoiceLink').length, 1);
});

test('повтор события оплаты: одна запись, одно право, одно письмо', async () => {
  const t = shop();
  const inv = await buy(t, ALICE, 'graphit-cardback');
  await preCheckout(t, ALICE, { payload: P(inv.order), amount: inv.price });
  await preCheckout(t, ALICE, { payload: P(inv.order), amount: inv.price });
  const id = charge();
  await paid(t, ALICE, { payload: P(inv.order), amount: inv.price, chargeId: id });
  await paid(t, ALICE, { payload: P(inv.order), amount: inv.price, chargeId: id, record: false });
  assert.equal(payRows(t).length, 1);
  assert.equal(entRows(t).length, 1);
  assert.equal(t.tg.dms(ALICE.id).filter((x) => /Куплено/.test(x)).length, 1);
});

test('та же вещь оплачена вторым платежом (тот же счёт) — права не удваиваются, владельцу на возврат', async () => {
  const t = shop();
  const inv = await buy(t, ALICE, 'graphit-cardback');
  await preCheckout(t, ALICE, { payload: P(inv.order), amount: inv.price });
  await paid(t, ALICE, { payload: P(inv.order), amount: inv.price });
  // Второе окно того же счёта: pre_checkout откажет…
  const ans = await preCheckout(t, ALICE, { payload: P(inv.order), amount: inv.price });
  assert.equal(ans.ok, false);
  assert.equal(ans.error, PRECHECKOUT.state);
  // …а если Telegram всё же провёл — это «duplicate», без новой выдачи.
  await paid(t, ALICE, { payload: P(inv.order), amount: inv.price });
  assert.deepEqual(payRows(t).map((p) => p.kind).sort(), ['duplicate', 'order']);
  assert.equal(entRows(t).length, 1);
  assert.match(t.lastDm(ALICE), /уже был оплачен/);
  assert.match(t.lastDm(OWNER), /на проверку/);
});

test('повторная покупка той же вещи: отказ «уже есть», счёта нет', async () => {
  const t = shop();
  await purchase(t, ALICE, 'graphit-table');
  const n = calls(t, 'createInvoiceLink').length;
  const r = await buy(t, ALICE, 'graphit-table');
  assert.equal(r.error.code, 'PAY_OWNED');
  assert.equal(calls(t, 'createInvoiceLink').length, n);
});

/* ------------------------------------------------------------- подмены */

test('подмена в теле страницы: цена, покупатель, валюта игнорируются', async () => {
  const t = shop();
  t.openSolo(ALICE);
  await t.send(ALICE, { t: 'pay', op: 'buy', item: 'graphit-table', req: req(), price: 1, userId: BOB.id, user: { id: BOB.id }, currency: 'USD', amount: 1 });
  const inv = pays(t, ALICE).at(-1);
  const o = t.app.store.pay.order(inv.order);
  assert.equal(o.userId, String(ALICE.id));
  assert.equal(o.price, PRICES['graphit-table']);
  assert.equal(o.currency, 'XTR');
  assert.equal(calls(t, 'createInvoiceLink')[0].prices[0].amount, PRICES['graphit-table']);
});

test('pre_checkout: чужой (пересланный) счёт, не та сумма, валюта, чужой payload — отказ', async () => {
  const t = shop();
  const inv = await buy(t, ALICE, 'graphit-table');
  const cases = [
    [BOB, { payload: P(inv.order), amount: inv.price }, PRECHECKOUT.other],
    [ALICE, { payload: P(inv.order), amount: 1 }, PRECHECKOUT.amount],
    [ALICE, { payload: P(inv.order), amount: inv.price, currency: 'USD' }, PRECHECKOUT.amount],
    [ALICE, { payload: P('0000000000000000'), amount: inv.price }, PRECHECKOUT.unknown],
    [ALICE, { payload: inv.order, amount: inv.price }, PRECHECKOUT.unknown],
  ];
  for (const [u, q, why] of cases) {
    const ans = await preCheckout(t, u, q);
    assert.equal(ans.ok, false, why);
    assert.equal(ans.error, why);
  }
  assert.equal(t.app.store.pay.order(inv.order).state, 'created', 'отказы ничего не подтвердили');
});

test('оплата с несовпадением (сумма/покупатель/чужой payload) — права не выдаются, владельцу на проверку', async () => {
  const t = shop();
  const inv = await buy(t, ALICE, 'graphit-table');
  await paid(t, ALICE, { payload: P(inv.order), amount: 1 });
  await paid(t, BOB, { payload: P(inv.order), amount: inv.price });
  await paid(t, BOB, { payload: 'чужое', amount: 5 });
  assert.deepEqual(payRows(t).map((p) => p.kind).sort(), ['mismatch', 'mismatch', 'orphan']);
  assert.deepEqual(owned(t, ALICE), []);
  assert.deepEqual(owned(t, BOB), []);
  assert.equal(t.app.store.pay.order(inv.order).state, 'created');
});

test('устаревший счёт и сменившаяся цена — pre_checkout отказывает', async () => {
  const t = shop();
  const a = await buy(t, ALICE, 'graphit-table');
  await t.advance(16 * 60_000);
  assert.equal((await preCheckout(t, ALICE, { payload: P(a.order), amount: a.price })).error, PRECHECKOUT.expired);
  const b = await buy(t, ALICE, 'graphit-table');
  assert.notEqual(b.order, a.order, 'после истечения — новый заказ');
  t.app.payments.cfg = cfgOf({ prices: { ...PRICES, 'graphit-table': 70 } });
  assert.equal((await preCheckout(t, ALICE, { payload: P(b.order), amount: b.price })).error, PRECHECKOUT.changed);
  assert.equal(t.app.store.pay.order(b.order).price, PRICES['graphit-table'], 'цена заказа не меняется задним числом');
});

test('вещь скрыли: новый счёт не выставить, неподтверждённый — не оплатить; уже подтверждённый — выдаётся', async () => {
  const t = shop();
  const a = await buy(t, ALICE, 'graphit-table');
  const b = await buy(t, BOB, 'graphit-table');
  await preCheckout(t, BOB, { payload: P(b.order), amount: b.price });
  // Скрыть: продажи переводим в live без цены этой вещи — она больше не продаётся.
  t.app.payments.cfg = cfgOf({ mode: 'live', prices: { ...PRICES, 'graphit-table': null } });
  assert.equal((await buy(t, ALICE, 'graphit-cardback')).order != null, true);
  assert.equal((await buy(t, ALICE, 'graphit-table')).error?.code, 'PAY_ITEM', 'скрытую вещь не купить');
  assert.equal((await preCheckout(t, ALICE, { payload: P(a.order), amount: a.price })).ok, false);
  await paid(t, BOB, { payload: P(b.order), amount: b.price });
  assert.deepEqual(owned(t, BOB), ['graphit-table'], 'заплатил — получил');
});

/* ------------------------------------------------------------- набор */

test('набор с пересечениями: при частичном владении не продаётся, конкурирующие счета не оплатить дважды', async () => {
  const t = shop();
  await purchase(t, ALICE, 'graphit-cardback');
  assert.equal((await buy(t, ALICE, 'graphit-bundle')).error.code, 'PAY_PARTIAL');
  // Боб: два живых счёта — рубашка и комплект (в нём та же рубашка).
  const c = await buy(t, BOB, 'graphit-cardback');
  const k = await buy(t, BOB, 'graphit-bundle');
  assert.ok(c.link && k.link);
  assert.equal((await preCheckout(t, BOB, { payload: P(c.order), amount: c.price })).ok, true);
  const second = await preCheckout(t, BOB, { payload: P(k.order), amount: k.price });
  assert.equal(second.error, PRECHECKOUT.busy, 'пока рубашка в оплате, комплект не оплатить');
  assert.equal((await buy(t, BOB, 'graphit-profile')).order != null, true, 'непересекающаяся вещь — можно');
  assert.equal((await buy(t, BOB, 'graphit-bundle')).error.code, 'PAY_PENDING');
  await paid(t, BOB, { payload: P(c.order), amount: c.price });
  assert.equal((await preCheckout(t, BOB, { payload: P(k.order), amount: k.price })).error, PRECHECKOUT.owned);
  // Полный набор у Кати: три права одним заказом.
  const CAROL = { id: 710001003, is_bot: false, first_name: 'Катя' };
  t.tg.dmOpen.add(String(CAROL.id));
  const r = await purchase(t, CAROL, 'graphit-bundle');
  assert.ok(r.ok);
  assert.deepEqual(owned(t, CAROL), ['graphit-cardback', 'graphit-profile', 'graphit-table']);
  assert.equal((await buy(t, CAROL, 'graphit-table')).error.code, 'PAY_OWNED');
});

test('тестер/админ уже владеет — купить нельзя (не платить за то, что было)', async () => {
  const t = shop();
  t.app.cosmeticsTesters.add(String(BOB.id));
  assert.equal((await buy(t, BOB, 'graphit-table')).error.code, 'PAY_OWNED');
  assert.equal((await buy(t, OWNER, 'graphit-bundle')).error.code, 'PAY_OWNED');
  assert.deepEqual(lastCol(t, BOB).owned.find((o) => o.item === 'graphit-table').source, ['staff']);
});

/* ------------------------------------------------- обрывы и восстановление */

test('связь оборвалась до/после оплаты: выдача по событию Telegram, страница при новом открытии видит вещь', async () => {
  const t = shop();
  const inv = await buy(t, ALICE, 'graphit-profile');
  t.close(ALICE); // страница закрылась (обрыв) до оплаты
  await preCheckout(t, ALICE, { payload: P(inv.order), amount: inv.price });
  await paid(t, ALICE, { payload: P(inv.order), amount: inv.price });
  assert.deepEqual(owned(t, ALICE), ['graphit-profile']);
  t.openSolo(ALICE);
  assert.ok(lastCol(t, ALICE).owned.some((o) => o.item === 'graphit-profile'));
});

test('падение во время выдачи: транзакция откатилась целиком, повтор события выдаёт ровно один раз', async () => {
  const t = shop();
  const inv = await buy(t, ALICE, 'graphit-bundle');
  await preCheckout(t, ALICE, { payload: P(inv.order), amount: inv.price });
  const pay = t.app.store.pay;
  const real = pay.grant.bind(pay);
  pay.grant = (...a) => { real(...a); throw new Error('диск отвалился'); };
  const id = charge();
  await paid(t, ALICE, { payload: P(inv.order), amount: inv.price, chargeId: id });
  assert.equal(payRows(t).length, 0, 'платёж не записан — Telegram пришлёт снова (обновление не подтверждено)');
  assert.equal(entRows(t).length, 0, 'ни одного права из половины транзакции');
  assert.equal(pay.order(inv.order).state, 'approved');
  pay.grant = real;
  await paid(t, ALICE, { payload: P(inv.order), amount: inv.price, chargeId: id, record: false });
  assert.equal(entRows(t).length, 3);
  assert.equal(payRows(t).length, 1);
});

test('перезапуск: права и надетый вид из базы, повтор события после выдачи ничего не удваивает', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-'));
  const file = path.join(dir, 'bot.db');
  let store = new Store(file);
  const t = shop({}, { store });
  const r = await purchase(t, ALICE, 'graphit-table');
  await t.send(ALICE, { t: 'col', op: 'apply', slot: 'table', item: 'graphit-table', color: 'petrol', req: req('a') });
  store.close();
  store = new Store(file);
  const t2 = shop({}, { store });
  assert.deepEqual(owned(t2, ALICE), ['graphit-table']);
  assert.equal(t2.app.collections.choiceOf(ALICE.id).table.color, 'petrol', 'вид между устройствами и перезапусками');
  await paid(t2, ALICE, { payload: r.payload, amount: r.order.price, chargeId: r.chargeId, record: false });
  assert.equal(entRows(t2).length, 1);
  assert.equal(store.getMeta?.('schema') ?? store.db.prepare("SELECT value FROM meta WHERE key='schema'").get().value, SCHEMA_VERSION, 'версия схемы не менялась');
  store.close();
});

test('пропущенная оплата (бот лежал/откат): сверка находит, выдаёт один раз; повторная сверка — ничего', async () => {
  const t = shop();
  const inv = await buy(t, ALICE, 'graphit-table');
  await preCheckout(t, ALICE, { payload: P(inv.order), amount: inv.price });
  await paid(t, ALICE, { payload: P(inv.order), amount: inv.price, deliver: false });
  assert.deepEqual(owned(t, ALICE), []);
  const text = await owner(t, '/reconcile');
  assert.match(text, /восстановлено оплат 1/);
  assert.deepEqual(owned(t, ALICE), ['graphit-table']);
  assert.match(await owner(t, '/reconcile'), /восстановлено оплат 0/);
  assert.equal(entRows(t).length, 1);
});

test('сверка не верит чужим транзакциям: неверная сумма из сверки — на проверку, не выдача', async () => {
  const t = shop();
  const inv = await buy(t, ALICE, 'graphit-table');
  t.tg.stars = [{ id: 'stxEVIL', amount: 1, date: 0, source: { type: 'user', transaction_type: 'invoice_payment', user: ALICE, invoice_payload: P(inv.order) } }];
  await owner(t, '/reconcile');
  assert.deepEqual(owned(t, ALICE), []);
  assert.equal(payRows(t)[0].kind, 'mismatch');
});

/* ------------------------------------------------------------- возвраты */

test('возврат надетой вещи: полный, права сняты, вид снят, письмо; повторный возврат невозможен', async () => {
  const t = shop();
  const r = await purchase(t, ALICE, 'graphit-cardback');
  await t.send(ALICE, { t: 'col', op: 'apply', slot: 'cardback', item: 'graphit-cardback', color: 'bordeaux', req: req('a') });
  const { preview, done, code } = await refund(t, r.order.id);
  assert.match(preview, new RegExp(`${PRICES['graphit-cardback']} ⭐ \\(полностью\\)`));
  assert.match(done, /Возврат .* выполнен/);
  const call = calls(t, 'refundStarPayment');
  assert.equal(call.length, 1);
  assert.equal(call[0].userId, ALICE.id);
  assert.equal(call[0].chargeId, r.chargeId);
  assert.deepEqual(owned(t, ALICE), []);
  assert.equal(t.app.collections.choiceOf(ALICE.id).cardback, null);
  assert.deepEqual(t.app.store.collChoices(ALICE.id), [], 'надетая вещь снята и в базе');
  assert.ok(lastCol(t, ALICE).owned.length === 0, 'страница узнала сразу');
  assert.match(t.lastDm(ALICE), /Возврат по заказу/);
  // Повтор: тот же код не работает, новый предпросмотр говорит «уже выполнен».
  assert.match(await owner(t, `/refund ${r.order.id} ${code}`), /Код не подходит/);
  assert.match(await owner(t, `/refund ${r.order.id}`), /уже выполнен/);
  assert.equal(calls(t, 'refundStarPayment').length, 1);
  await t.send(ALICE, { t: 'pay', op: 'history' });
  assert.equal(pays(t, ALICE).at(-1).orders[0].state, 'refunded');
});

test('возврат не трогает независимый источник: тестер после возврата покупки сохраняет вещь и вид', async () => {
  const t = shop();
  const r = await purchase(t, ALICE, 'graphit-table');
  t.app.cosmeticsTesters.add(String(ALICE.id));
  await t.send(ALICE, { t: 'col', op: 'apply', slot: 'table', item: 'graphit-table', color: 'sapphire', req: req('a') });
  await refund(t, r.order.id);
  assert.ok(owned(t, ALICE).includes('graphit-table'));
  assert.equal(t.app.collections.choiceOf(ALICE.id).table.color, 'sapphire');
  assert.equal(t.app.store.collChoices(ALICE.id).length, 1, 'выбор в базе не тронут');
});

test('возврат комплекта снимает только его вещи; отдельно купленная остаётся', async () => {
  const t = shop();
  const p = await purchase(t, ALICE, 'graphit-profile');
  assert.ok(p.ok);
  // Комплект при частичном владении не продаётся — поэтому другой человек: проверяем по заказам.
  const k = await purchase(t, BOB, 'graphit-bundle');
  await refund(t, k.order.id);
  assert.deepEqual(owned(t, BOB), []);
  assert.deepEqual(owned(t, ALICE), ['graphit-profile']);
});

test('таймаут возврата: права на месте, повтор сначала сверяет и не возвращает дважды; поздний refunded_payment закрывает', async () => {
  const t = shop({ netMs: 20 });
  const r = await purchase(t, ALICE, 'graphit-table');
  const realRefund = t.tg.refundStarPayment.bind(t.tg);
  // Первый вызов «дошёл», но ответ потерялся: Telegram вернул звёзды, мы — не знаем.
  t.tg.refundStarPayment = async (...a) => { await realRefund(...a); return new Promise(() => {}); };
  const first = await refund(t, r.order.id);
  assert.match(first.done, /не подтвердил возврат/);
  assert.deepEqual(owned(t, ALICE), ['graphit-table'], 'без подтверждения права не сняты');
  assert.match(await owner(t, '/sales'), /возвратов в обработке: 1/);
  t.tg.refundStarPayment = realRefund;
  const again = await refund(t, r.order.id);
  assert.match(again.done, /Сверка: возврат уже прошёл/);
  assert.equal(t.tg.stars.filter((x) => x.receiver).length, 1, 'звёзды вернулись один раз');
  assert.deepEqual(owned(t, ALICE), []);
  // Поздний refunded_payment — идемпотентен.
  await t.app.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: ALICE.id, type: 'private' }, from: ALICE, refunded_payment: { currency: 'XTR', total_amount: r.order.price, invoice_payload: r.payload, telegram_payment_charge_id: r.chargeId } } });
  assert.equal(t.tg.dms(ALICE.id).filter((x) => /Возврат по заказу/.test(x)).length, 1);
});

test('таймаут без дошедшего вызова: повтор вызывает возврат снова; «уже возвращено» от Telegram засчитывается', async () => {
  const t = shop({ netMs: 20 });
  const r = await purchase(t, ALICE, 'graphit-table');
  const realRefund = t.tg.refundStarPayment.bind(t.tg);
  t.tg.refundStarPayment = () => new Promise(() => {});
  await refund(t, r.order.id);
  t.tg.refundStarPayment = realRefund;
  const again = await refund(t, r.order.id);
  assert.match(again.done, /выполнен/);
  assert.deepEqual(owned(t, ALICE), []);
  // Telegram отвечает «уже возвращено» на другой путь — тоже без двойного счёта.
  const r2 = await purchase(t, BOB, 'graphit-table');
  await realRefund(BOB.id, r2.chargeId);
  const third = await refund(t, r2.order.id);
  assert.match(third.done, /выполнен/);
  assert.deepEqual(owned(t, BOB), []);
});

test('refunded_payment от Telegram (возврат не через нас) — права сняты; сверка исходящих тоже снимает', async () => {
  const t = shop();
  const a = await purchase(t, ALICE, 'graphit-table');
  await t.app.handleUpdate({ update_id: 2, message: { message_id: 2, chat: { id: ALICE.id, type: 'private' }, from: ALICE, refunded_payment: { currency: 'XTR', total_amount: a.order.price, invoice_payload: a.payload, telegram_payment_charge_id: a.chargeId } } });
  assert.deepEqual(owned(t, ALICE), []);
  const b = await purchase(t, BOB, 'graphit-profile');
  t.tg.stars.push({ id: b.chargeId, amount: b.order.price, date: 0, receiver: { type: 'user', user: BOB } });
  assert.match(await owner(t, '/reconcile'), /засчитано возвратов 1/);
  assert.deepEqual(owned(t, BOB), []);
});

test('возврат — только владелец: игроку команды не отвечают, код привязан к админу и заказу', async () => {
  const t = shop();
  const r = await purchase(t, ALICE, 'graphit-table');
  await t.dm(ALICE, `/refund ${r.order.id}`);
  assert.doesNotMatch(t.lastDm(ALICE), /Возврат по заказу/);
  await t.dm(ALICE, '/pays');
  assert.doesNotMatch(t.lastDm(ALICE), /Последние заказы/);
  const preview = await owner(t, `/refund ${r.order.id}`);
  const code = /\/refund \S+ ([0-9a-f]{6})/.exec(preview)[1];
  await t.dm(ALICE, `/refund ${r.order.id} ${code}`);
  assert.equal(calls(t, 'refundStarPayment').length, 0);
  assert.deepEqual(owned(t, ALICE), ['graphit-table']);
  // Код просрочен — не работает.
  await t.advance(11 * 60_000);
  assert.match(await owner(t, `/refund ${r.order.id} ${code}`), /Код не подходит/);
  assert.equal(calls(t, 'refundStarPayment').length, 0);
});

/* ---------------------------------------------- остановка и обслуживание */

test('остановка новых продаж: счета и pre_checkout закрыты, но оплата, история, поддержка и возврат работают', async () => {
  const t = shop();
  const done = await purchase(t, ALICE, 'graphit-profile');
  const inv = await buy(t, BOB, 'graphit-table');
  await preCheckout(t, BOB, { payload: P(inv.order), amount: inv.price });
  const left = await buy(t, ALICE, 'graphit-table');
  assert.match(await owner(t, '/salesstop'), /остановлены/);
  assert.equal((await buy(t, ALICE, 'graphit-cardback')).error.code, 'PAY_CLOSED');
  assert.equal((await preCheckout(t, ALICE, { payload: P(left.order), amount: left.price })).error, PRECHECKOUT.closed);
  await paid(t, BOB, { payload: P(inv.order), amount: inv.price });
  assert.deepEqual(owned(t, BOB), ['graphit-table'], 'уже подтверждённая оплата выдаётся');
  await t.send(ALICE, { t: 'pay', op: 'history' });
  assert.equal(pays(t, ALICE).at(-1).orders.length, 1);
  await t.dm(ALICE, '/paysupport');
  assert.match(t.lastDm(ALICE), new RegExp(done.order.id));
  assert.match((await refund(t, done.order.id)).done, /выполнен/);
  assert.match(await owner(t, '/sales'), /остановка: да/);
  // Остановка переживает перезапуск (в базе).
  assert.equal(t.app.store.pay.stopped(), true);
  await owner(t, '/salesresume');
  assert.ok((await buy(t, ALICE, 'graphit-cardback')).link);
});

test('обслуживание: новый счёт и pre_checkout — нет, пришедшая оплата — выдаётся', async () => {
  const t = shop();
  const inv = await buy(t, ALICE, 'graphit-table');
  await preCheckout(t, ALICE, { payload: P(inv.order), amount: inv.price });
  const other = await buy(t, BOB, 'graphit-table');
  t.app.setMaintenance(true, 'тест');
  assert.equal((await preCheckout(t, BOB, { payload: P(other.order), amount: other.price })).ok, false);
  await paid(t, ALICE, { payload: P(inv.order), amount: inv.price });
  assert.deepEqual(owned(t, ALICE), ['graphit-table']);
  t.openSolo(BOB);
  await t.send(BOB, { t: 'pay', op: 'buy', item: 'graphit-cardback', req: req() });
  assert.equal(pays(t, BOB).at(-1).error.code, 'PAY_DOWN');
  await t.dm(BOB, '/paysupport');
  assert.match(t.lastDm(BOB), /Поддержка покупок/);
});

test('/paysupport при закрытых продажах и без контакта — честный ответ; в группе — только направление в личку', async () => {
  const t = new Table();
  t.tg.dmOpen.add(String(ALICE.id));
  await t.dm(ALICE, '/paysupport');
  assert.match(t.lastDm(ALICE), /Продажи ещё не открыты/);
  assert.match(t.lastDm(ALICE), /Покупок у вас нет/);
  await t.dm(ALICE, '/terms');
  assert.match(t.lastDm(ALICE), /проект, ещё не действует/);
  await t.cmd(ALICE, '/paysupport');
  assert.match(t.lastPost(), /в личке/);
});

/* ---------------------------------------------------- сбои Telegram, мелочи */

test('Telegram не выставил счёт: отказ словами, заказ отменён и не оплачивается', async () => {
  const t = shop();
  t.tg.failNext = { method: 'createInvoiceLink', error: Object.assign(new Error('x'), { description: 'Bad Request: oops', error_code: 400 }) };
  const r = await buy(t, ALICE, 'graphit-table');
  assert.equal(r.error.code, 'PAY_TG');
  assert.equal(r.error.text, PAY_ERRORS.PAY_TG);
  const o = t.app.store.pay.recentOrders(1)[0];
  assert.equal(o.state, 'cancelled');
  assert.equal((await preCheckout(t, ALICE, { payload: P(o.id), amount: o.price })).error, PRECHECKOUT.state);
  assert.ok((await buy(t, ALICE, 'graphit-table')).link, 'следующая попытка — новый счёт');
});

test('лимит запросов и неизвестные операции — отказ словами; админская страница не покупает', async () => {
  const t = shop();
  t.openSolo(ALICE);
  await t.send(ALICE, { t: 'pay', op: 'steal' });
  assert.equal(pays(t, ALICE).at(-1).error.code, 'PAY_OP');
  await t.send(ALICE, { t: 'pay', op: 'buy', item: 'graphit-table', req: 'x' });
  assert.equal(pays(t, ALICE).at(-1).error.code, 'PAY_OP');
  for (let i = 0; i < 12; i++) await t.send(ALICE, { t: 'pay', op: 'history' });
  assert.equal(pays(t, ALICE).at(-1).error.code, 'PAY_FAST');
  t.openAdmin(OWNER);
  await t.send(OWNER, { t: 'pay', op: 'buy', item: 'graphit-table', req: req() });
  assert.equal(pays(t, OWNER).at(-1).error.code, 'PAY_OP');
});

test('журнал без имён и без initData; история не показывает чужого', async () => {
  const t = shop();
  await purchase(t, ALICE, 'graphit-table');
  const dump = JSON.stringify(t.app.store.pay.db.prepare('SELECT * FROM pay_log').all())
    + JSON.stringify(t.app.store.pay.db.prepare('SELECT * FROM pay_payment').all())
    + JSON.stringify(t.app.store.pay.db.prepare('SELECT * FROM pay_order').all());
  assert.doesNotMatch(dump, /Алиса|first_name|hash=|auth_date/);
  t.openSolo(BOB);
  await t.send(BOB, { t: 'pay', op: 'history' });
  const inbox = JSON.stringify(t.page(BOB).inbox);
  assert.deepEqual(pays(t, BOB).at(-1).orders, []);
  assert.doesNotMatch(inbox, new RegExp(String(ALICE.id)), 'id Алисы Бобу не уходит');
  assert.deepEqual(lastCol(t, BOB).owned, []);
});

test('магазин в тестовом режиме видят все; при закрытых продажах — только тестер и тот, кто уже покупал', async () => {
  const t = shop();
  assert.equal(t.app.collections.visibleFor(BOB.id), true);
  t.app.payments.cfg = cfgOf({ mode: 'live', approved: false });
  assert.equal(t.app.collections.visibleFor(BOB.id), false);
  assert.equal(t.app.collections.visibleFor(OWNER.id), true, 'админ видит, чтобы проверить');
  const st = t.app.collections.stateOf(OWNER.id);
  assert.equal(st.shop.open, false);
  assert.ok(Object.values(st.shop.offers).every((o) => o.price === null), 'при закрытых продажах цен не показываем');
});

test('бесплатных путей к платной вещи нет: демо-выдача вне демо и apply без права — отказ', async () => {
  const t = shop();
  t.openSolo(ALICE);
  await t.send(ALICE, { t: 'col', op: 'grant', item: 'graphit-table', req: req('g') });
  assert.equal(lastCol(t, ALICE).error.code, 'COL_DEMO_OFF');
  await t.send(ALICE, { t: 'col', op: 'apply', slot: 'table', item: 'graphit-table', color: 'sapphire', req: req('a') });
  assert.equal(lastCol(t, ALICE).error.code, 'COL_NOT_OWNED');
  assert.deepEqual(owned(t, ALICE), []);
});

test('App без настроек — продажи закрыты (index.js не передал sales)', () => {
  const app = new App({ api: {}, clock: new FakeClock() });
  assert.equal(app.payments.cfg.mode, 'off');
  assert.equal(app.payments.open, false);
});

test('резервная копия и восстановление: копия до оплаты → после восстановления сверка возвращает покупку; возврат из копии не повторяется', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-bak-'));
  const file = path.join(dir, 'bot.db');
  const early = path.join(dir, 'early.db');
  const late = path.join(dir, 'late.db');
  const store = new Store(file);
  const t = shop({}, { store });
  const a = await purchase(t, ALICE, 'graphit-table');
  // Копия как у deploy/backup.sh (sqlite .backup) — снимок всей базы, вместе с таблицами pay_*.
  store.db.exec(`VACUUM INTO '${early}'`);
  const b = await purchase(t, BOB, 'graphit-profile');
  await refund(t, a.order.id);
  store.db.exec(`VACUUM INTO '${late}'`);
  store.close();

  // Восстановили позднюю копию: всё на месте, повтор старых событий ничего не удваивает.
  const s2 = new Store(late);
  const t2 = shop({}, { store: s2 });
  t2.tg.stars = t.tg.stars;
  assert.deepEqual(owned(t2, ALICE), []);
  assert.deepEqual(owned(t2, BOB), ['graphit-profile']);
  assert.match(await owner(t2, '/reconcile'), /восстановлено оплат 0.*засчитано возвратов 0/);
  s2.close();

  // Восстановили РАННЮЮ копию (до покупки Боба и до возврата Алисы): сверка догоняет и то и другое.
  const s3 = new Store(early);
  const t3 = shop({}, { store: s3 });
  t3.tg.stars = t.tg.stars;
  assert.deepEqual(owned(t3, BOB), [], 'в копии покупки Боба ещё нет');
  assert.match(await owner(t3, '/reconcile'), /восстановлено оплат 1.*засчитано возвратов 1/);
  assert.deepEqual(owned(t3, BOB), ['graphit-profile']);
  assert.deepEqual(owned(t3, ALICE), [], 'возврат, сделанный после копии, засчитан сверкой');
  assert.equal(t3.tg.calls.filter((c) => c.method === 'refundStarPayment').length, 0, 'повторного возврата нет');
  s3.close();
  void b;
});

test('заказа нет в базе: восстановление только по текущей цене и для того, чего у покупателя нет', async () => {
  const t = shop();
  const gone = 'abcdefabcdef0001';
  await paid(t, ALICE, { payload: `g1:${gone}:graphit-table`, amount: 1 });
  assert.deepEqual(owned(t, ALICE), [], 'сумма не равна цене — не выдаём');
  await paid(t, ALICE, { payload: `g1:${gone}:night-cardback`, amount: 10 });
  assert.deepEqual(owned(t, ALICE), [], 'чужой каталог — не выдаём');
  assert.deepEqual(payRows(t).map((p) => p.kind), ['orphan', 'orphan']);
  await paid(t, ALICE, { payload: `g1:abcdefabcdef0002:graphit-table`, amount: PRICES['graphit-table'] });
  assert.deepEqual(owned(t, ALICE), ['graphit-table'], 'сумма = цене, вещи не было — восстановлено');
  // Подмена вещи в payload живого заказа: pre_checkout отказывает.
  const inv = await buy(t, ALICE, 'graphit-profile');
  assert.equal((await preCheckout(t, ALICE, { payload: `g1:${inv.order}:graphit-bundle`, amount: inv.price })).error, PRECHECKOUT.unknown);
});
