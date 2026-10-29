/**
 * Покупка на странице — чистая логика (miniapp/collections/pay.js) и разбор магазина в состоянии коллекций.
 * Главное: «оплачено» в окне Telegram — не покупка; вещь «куплена» только когда сервер прислал её в owned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPay, PAY_TEXT } from '../miniapp/collections/pay.js';
import { createStore, normalizeState, noteOf, SHOP_NOTE } from '../miniapp/collections/state.js';
import { PAY_ERRORS } from '../miniapp/collections/pay-protocol.js';

function rig() {
  const sent = [];
  const timers = [];
  let cb = null;
  let invoiceOk = true;
  const pay = createPay({
    send: (m) => { sent.push(m); return true; },
    openInvoice: (url, f) => { if (!invoiceOk) return false; cb = f; return true; },
    setTimer: (f, ms) => { timers.push({ f, ms }); return timers.length - 1; },
    clearTimer: (i) => { if (timers[i]) timers[i].dead = true; },
    now: () => 0,
    genReq: () => 'req-000001',
  });
  return {
    pay, sent, status: (s) => cb(s), get cb() { return cb; }, noInvoice: () => { invoiceOk = false; },
    fire: () => { const t = timers.filter((x) => !x.dead).pop(); t.dead = true; t.f(); },
  };
}
const INV = (o = {}) => ({ t: 'pay', op: 'buy', order: 'ord1', item: 'graphit-table', price: 50, link: 'https://t.me/$inv1', ...o });

test('запрос покупки — только вещь и req, без цены и покупателя', () => {
  const r = rig();
  assert.equal(r.pay.buy('graphit-table'), true);
  assert.deepEqual(r.sent, [{ t: 'pay', op: 'buy', item: 'graphit-table', req: 'req-000001' }]);
});

test('двойное нажатие: пока идёт покупка, второй запрос не уходит', () => {
  const r = rig();
  r.pay.buy('graphit-table');
  assert.equal(r.pay.buy('graphit-table'), false);
  assert.equal(r.pay.buy('graphit-cardback'), false);
  r.pay.handle(INV());
  assert.equal(r.pay.buy('graphit-table'), false, 'окно оплаты открыто — тоже занято');
  assert.equal(r.sent.length, 1);
});

test('«оплачено» в окне — ещё не покупка: ждём сервер; вещь пришла — «Куплено»', () => {
  const r = rig();
  r.pay.buy('graphit-table');
  r.pay.handle(INV());
  assert.equal(r.pay.phase.name, 'invoice');
  r.status('paid');
  assert.equal(r.pay.phase.name, 'confirming');
  r.pay.sawOwned(['graphit-cardback']);
  assert.equal(r.pay.phase.name, 'confirming', 'другая вещь — не наша покупка');
  r.fire();
  assert.equal(r.pay.phase.slow, true);
  r.pay.sawOwned(['graphit-table']);
  assert.equal(r.pay.phase.name, 'done');
});

test('сервер прислал вещь раньше, чем окно закрылось — сразу «Куплено»; комплект — когда есть все три', () => {
  const r = rig();
  r.pay.buy('graphit-bundle');
  r.pay.handle(INV({ item: 'graphit-bundle' }));
  r.pay.sawOwned(['graphit-table', 'graphit-cardback']);
  assert.equal(r.pay.phase.name, 'invoice');
  r.pay.sawOwned(['graphit-table', 'graphit-cardback', 'graphit-profile']);
  assert.equal(r.pay.phase.name, 'done');
});

test('отмена и ошибка окна: «звёзды не списаны», можно снова', () => {
  const r = rig();
  r.pay.buy('graphit-table');
  r.pay.handle(INV());
  r.status('cancelled');
  assert.equal(r.pay.phase.text, PAY_TEXT.cancelled);
  assert.equal(r.pay.buy('graphit-table'), true);
  r.pay.handle(INV({ order: 'ord2' }));
  r.status('failed');
  assert.equal(r.pay.phase.text, PAY_TEXT.failed);
  assert.match(PAY_TEXT.failed, /не хватает/);
});

test('отказ сервера — его текст; нет ответа — «ничего не списано»; нет окна Telegram — честно', () => {
  const r = rig();
  r.pay.buy('graphit-table');
  r.pay.handle({ t: 'pay', op: 'buy', error: { code: 'PAY_OWNED', text: PAY_ERRORS.PAY_OWNED } });
  assert.equal(r.pay.phase.text, PAY_ERRORS.PAY_OWNED);
  r.pay.buy('graphit-table');
  r.fire();
  assert.equal(r.pay.phase.text, PAY_TEXT.timeout);
  r.pay.handle(INV());
  assert.equal(r.pay.phase.name, 'error', 'поздний ответ на брошенный запрос не открывает окно');
  const q = rig();
  q.noInvoice();
  q.pay.buy('graphit-table');
  q.pay.handle(INV());
  assert.equal(q.pay.phase.text, PAY_TEXT.noInvoice);
});

test('ответ не на ту вещь или без ссылки — не открываем окно', () => {
  const r = rig();
  r.pay.buy('graphit-table');
  r.pay.handle(INV({ item: 'graphit-bundle' }));
  assert.equal(r.pay.phase.name, 'error');
});

test('статус окна старого счёта не трогает новую покупку', () => {
  const r = rig();
  r.pay.buy('graphit-table');
  r.pay.handle(INV());
  const old = r.cb;
  r.status('cancelled');
  r.pay.buy('graphit-table');
  r.pay.handle(INV({ order: 'ord2' }));
  old('paid');
  assert.equal(r.pay.phase.name, 'invoice');
});

test('состояние: магазин виден только с `shop`; цены — только целые от сервера; грант вне демо не уходит', () => {
  const base = { t: 'col', op: 'state', enabled: true, demo: false, owned: [], choice: {}, pending: {} };
  const s = normalizeState({ ...base, shop: { open: true, test: true, terms: '1.0', offers: { 'graphit-table': { price: 50 }, 'graphit-cardback': { price: '1' }, 'night-x': { price: 1 } } } });
  assert.equal(s.shop.offers['graphit-table'].price, 50);
  assert.equal(s.shop.offers['graphit-cardback'].price, null);
  assert.equal('night-x' in s.shop.offers, false);
  assert.equal(normalizeState({ ...base, demo: true, shop: { open: true } }).shop, null, 'в демо магазина нет');
  const sent = [];
  const store = createStore({ send: (m) => { sent.push(m); return true; }, setTimer: () => 0, clearTimer: () => {} });
  store.handle({ ...base, shop: { open: false } });
  assert.equal(store.visible, true);
  assert.equal(store.grant('graphit-table'), false);
  assert.deepEqual(sent, []);
  assert.equal(noteOf(store.snapshot()), SHOP_NOTE.closed);
});

test('исходники: окно оплаты — только Telegram.WebApp.openInvoice; localStorage не участвует в покупке', () => {
  const idx = fs.readFileSync('miniapp/collections/index.js', 'utf8');
  assert.match(idx, /wa\.openInvoice\(url, cb\)/);
  for (const f of ['pay.js', 'purchase.js', 'state.js', 'pay-protocol.js']) {
    assert.doesNotMatch(fs.readFileSync(`miniapp/collections/${f}`, 'utf8'), /localStorage|sessionStorage/, f);
  }
});
