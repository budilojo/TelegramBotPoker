/** payments: помощники тестов (не тест сам по себе). Платёжный API здесь — только заглушка (bot/tg-stub.js). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Table, user } from '../harness.js';
import { salesConfig, normalizeOffers } from './config.js';
import { payloadOf } from './index.js';

export { Table, user };
let n = 0;
export const req = (tag = 'p') => `${tag}-${String(++n).padStart(6, '0')}`;

export const ALICE = user(710001001, 'Алиса');
export const BOB = user(710001002, 'Боб');
export const OWNER = user(710009999, 'Владелец');

export const PRICES = { 'graphit-cardback': 30, 'graphit-table': 50, 'graphit-profile': 20, 'graphit-bundle': 80 };

/** Готовые («действующие») документы во временной папке — для проверки режима live. */
export function readyLegal({ blanks = false, status = 'Действует', version = '1.0' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-'));
  for (const f of ['terms-of-purchase.md', 'refund-rules.md', 'privacy-policy.md']) {
    fs.writeFileSync(path.join(dir, f), `# Документ\n\n- **Версия:** ${version}\n- **Дата:** 2026-11-01\n- **Статус:** ${status}\n\nТекст.${blanks ? ' [НЕ ЗАПОЛНЕНО: ИНН]' : ''}\n`);
  }
  return dir;
}

/** Настройки продаж для тестов. По умолчанию — тестовая среда Telegram с ценами. */
export function cfgOf({ mode = 'test', testEnv = mode === 'test', approved = true, prices = PRICES, support = '@help_test', legal = readyLegal(), terms = '1.0' } = {}) {
  return salesConfig(
    { SALES_MODE: mode, TG_TEST_ENV: testEnv ? '1' : '', PAY_SUPPORT: support },
    { offers: normalizeOffers({ approved, terms, items: prices }), legalDir: legal },
  );
}

/** Стол со включёнными (в заглушке) продажами. */
export function shop(opts = {}, tableOpts = {}) {
  const t = new Table({ admins: [String(OWNER.id)], ...tableOpts });
  t.app.payments.cfg = cfgOf(opts);
  t.app.payments.netMs = opts.netMs ?? 200;
  for (const u of [ALICE, BOB, OWNER]) t.tg.dmOpen.add(String(u.id));
  return t;
}

export const pays = (t, u) => t.page(u).inbox.filter((m) => m.t === 'pay');
export const cols = (t, u) => t.page(u).inbox.filter((m) => m.t === 'col');
export const lastCol = (t, u) => cols(t, u).at(-1) ?? null;

/** Нажать «Купить»: ответ сервера (счёт или отказ). */
export async function buy(t, u, item, r = req('b')) {
  t.openSolo(u);
  await t.send(u, { t: 'pay', op: 'buy', item, req: r });
  return pays(t, u).at(-1);
}

let updates = 1;
let charges = 1;
export const charge = () => `stxTEST${String(charges++).padStart(8, '0')}`;

/** Telegram прислал pre_checkout_query от `from`. Возвращает ответ бота. */
export async function preCheckout(t, from, { payload, amount, currency = 'XTR' }) {
  const id = `pcq${updates++}`;
  await t.app.handleUpdate({ update_id: updates++, pre_checkout_query: { id, from, currency, total_amount: amount, invoice_payload: payload } });
  return (t.tg.preAnswers ?? []).find((a) => a.id === id) ?? null;
}

/** Telegram прислал successful_payment (и записал входящую транзакцию, как настоящий). */
export async function paid(t, from, { payload, amount, currency = 'XTR', chargeId = charge(), record = true, deliver = true }) {
  if (record) {
    t.tg.stars ??= [];
    t.tg.stars.push({ id: chargeId, amount, date: 0, source: { type: 'user', transaction_type: 'invoice_payment', user: from, invoice_payload: payload } });
  }
  if (deliver) {
    await t.app.handleUpdate({
      update_id: updates++,
      message: { message_id: updates, date: 0, chat: { id: from.id, type: 'private' }, from, successful_payment: { currency, total_amount: amount, invoice_payload: payload, telegram_payment_charge_id: chargeId, provider_payment_charge_id: '' } },
    });
    await t.app.settle();
  }
  return chargeId;
}

/** Полный путь «Купить → окно оплаты → оплачено» как у Telegram. */
export async function purchase(t, u, item) {
  const inv = await buy(t, u, item);
  if (!inv?.link) return { inv, ok: false };
  const order = t.app.store.pay.order(inv.order);
  const payload = payloadOf(order);
  const ans = await preCheckout(t, u, { payload, amount: order.price });
  if (!ans?.ok) return { inv, ans, ok: false };
  const chargeId = await paid(t, u, { payload, amount: order.price });
  return { inv, ans, ok: true, chargeId, order: t.app.store.pay.order(order.id), payload };
}

/** Владелец пишет игровому боту в личку. */
export async function owner(t, text) {
  await t.dm(OWNER, text);
  await t.app.settle();
  return t.lastDm(OWNER);
}

/** Владелец: возврат с подтверждением (два шага). */
export async function refund(t, orderId) {
  const preview = await owner(t, `/refund ${orderId}`);
  const code = /\/refund \S+ ([0-9a-f]{6})/.exec(preview ?? '')?.[1];
  if (!code) return { preview, done: null };
  const done = await owner(t, `/refund ${orderId} ${code}`);
  return { preview, done, code };
}
