/**
 * payments: покупки косметики «Графит» за Telegram Stars — заказ, pre_checkout, выдача, возврат, сверка.
 * Контракт и состояния — docs/next-release/payment-design.md. Тексты — MESSAGES.md, раздел «Покупки».
 *
 * На чём держится:
 *  - кто — только из подписанного initData (страница) или `from` обновления Telegram; тело страницы цену,
 *    покупателя и валюту не задаёт;
 *  - право «покупка» появляется ТОЛЬКО в onSuccessfulPayment после сверки заказа; статус окна оплаты у
 *    страницы ничего не значит;
 *  - одна оплата = одна транзакция SQLite; сетевые вызовы (счёт, ответ pre_checkout, возврат, сверка) — вне её;
 *  - уникальность `telegram_payment_charge_id` и `pay_refund` на платёж — повтор события и второй возврат
 *    ничего не меняют;
 *  - новые продажи закрыты выключателем (`gate`), но выдача, история, сверка и возвраты работают всегда.
 */
import crypto from 'node:crypto';
import { itemById } from '../../miniapp/collections/catalog.js';
import { PAY_ERRORS, PRECHECKOUT, ORDER_TTL_MS, PAY_OPS } from '../../miniapp/collections/pay-protocol.js';
import { isReq } from '../../miniapp/collections/protocol.js';
import { gate, priceOf, itemsOf, SELLABLE } from './config.js';
import { DM, STATE_TEXT, supportText, termsText } from './texts.js';

export const PAYLOAD_PREFIX = 'g1:';
export const PER_MINUTE = 10;
const MINUTE = 60_000;
const CONFIRM_MS = 10 * MINUTE;
/** Сколько ждать Telegram, мс. pre_checkout надо успеть за 10 с — ответ уходит сразу после проверок. */
export const NET_MS = 8000;
export const RECONCILE_PAGES = 10;

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
/**
 * Payload счёта: `g1:<заказ>:<вещь>`. Вещь в payload нужна только для восстановления, если заказа в базе нет
 * (база восстановлена из копии, снятой до заказа): тогда сверка может выдать по сумме и текущей цене.
 */
export const payloadOf = (o) => `${PAYLOAD_PREFIX}${o.id}:${o.item}`;
export function parsePayload(p) {
  if (typeof p !== 'string' || !p.startsWith(PAYLOAD_PREFIX)) return null;
  const [id, item = null] = p.slice(PAYLOAD_PREFIX.length).split(':');
  return /^[0-9a-f]{16}$/.test(id) ? { id, item } : null;
}
const orderOfPayload = (p) => parsePayload(p)?.id ?? null;
const tail = (s) => String(s || '').slice(-6);

/** Ответ Telegram «уже возвращено» — возврат засчитан, повторять нельзя. */
export const alreadyRefunded = (err) => /CHARGE_ALREADY_REFUNDED|already refunded/i.test(String(err?.description ?? err?.message ?? ''));

export class Payments {
  /**
   * @param app  App (api, store, clock, isAdmin, cosmeticsUnlocked, down, hub, outbox)
   * @param cfg  salesConfig() — один раз при запуске
   */
  constructor(app, cfg) {
    this.app = app;
    this.cfg = cfg;
    this.limits = new Map();
    this.buying = new Map();
    /** Коды подтверждения возврата: `${admin}:${order}` → { code, until }. Только в памяти. */
    this.confirms = new Map();
    this.netMs = NET_MS;
    this.newId = () => crypto.randomBytes(8).toString('hex');
    this.newCode = () => crypto.randomBytes(3).toString('hex');
  }

  get db() { return this.app.store.pay; }
  get api() { return this.app.api; }
  now() { return this.app.clock.now(); }

  /** Можно ли сейчас выставлять новые счета. */
  gate() {
    return gate(this.cfg, { stopped: this.db.stopped(), down: this.app.down });
  }
  get open() { return this.gate().open; }

  /** Видит ли человек магазин (без демо): продажи открыты, или он тестер при включённом режиме, или у него есть покупки. */
  shopVisibleFor(uid) {
    if (this.open) return true;
    if (this.cfg.mode !== 'off' && this.app.cosmeticsUnlocked(uid)) return true;
    return this.db.hasAnyOrder(uid);
  }

  /** Доступ тестера/админа к «Графиту» — отдельно от покупки; при выключенном режиме его нет (прод без изменений). */
  staffOwns(uid) {
    return this.cfg.mode !== 'off' && this.app.cosmeticsUnlocked(uid);
  }

  /** Что видит страница в состоянии коллекций (поле `shop`). Цены — только сервера. */
  shopState(uid) {
    const g = this.gate();
    const offers = {};
    for (const id of SELLABLE) offers[id] = { price: g.open ? priceOf(this.cfg, id) : null };
    return {
      open: g.open,
      test: this.cfg.mode === 'test' && g.open,
      note: g.open ? '' : PAY_ERRORS.PAY_CLOSED,
      terms: this.cfg.terms,
      support: !!this.cfg.support,
      offers,
    };
  }

  /* --------------------------------------------------------------- сеть */

  async net(fn) {
    let timer;
    const late = new Promise((_, no) => { timer = setTimeout(() => no(Object.assign(new Error('timeout'), { timeout: true })), this.netMs); });
    try {
      return await Promise.race([fn(), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  log(event, extra) {
    try { this.db.log(this.now(), event, extra); } catch (err) { this.app.log(err); }
  }

  /* ---------------------------------------------------- страница: покупка */

  fail(op, code) {
    return { t: 'pay', op, error: { code, text: PAY_ERRORS[code] } };
  }

  tooFast(uid) {
    const now = this.now();
    for (const [id, times] of this.limits) if (!times.some((at) => now - at < MINUTE)) this.limits.delete(id);
    const times = (this.limits.get(uid) || []).filter((at) => now - at < MINUTE);
    if (times.length >= PER_MINUTE) return true;
    times.push(now);
    this.limits.set(uid, times);
    return false;
  }

  /**
   * Сообщение страницы `{ t:'pay', op, … }`.
   * @param user  session.user — единственный источник «кто»
   */
  async handle(user, msg) {
    const uid = String(user.id);
    const op = PAY_OPS.includes(msg?.op) ? msg.op : null;
    if (!op) return this.fail('buy', 'PAY_OP');
    if (this.tooFast(uid)) return this.fail(op, 'PAY_FAST');
    if (op === 'history') return { t: 'pay', op, orders: this.history(uid), support: !!this.cfg.support };
    if (op === 'terms') return { t: 'pay', op, terms: this.cfg.terms, docs: this.publicDocs() };
    // Кнопка «Поддержка»: тот же ответ, что на /paysupport, — в личку (номера заказов не светим на экране группы).
    if (op === 'support') {
      try {
        await this.app.outbox.post(uid, this.supportText(uid));
        return { t: 'pay', op, ok: true };
      } catch (err) {
        if (err?.error_code !== 403) this.app.log(err);
        return this.fail(op, 'PAY_DM');
      }
    }
    // buy
    if (!isReq(msg.req)) return this.fail(op, 'PAY_OP');
    const was = this.buying.get(uid);
    if (was) return was; // двойное нажатие: один и тот же ответ, один заказ
    const p = this.buy(uid, msg.item, msg.req).finally(() => this.buying.delete(uid));
    this.buying.set(uid, p);
    return p;
  }

  /** Тексты документов для показа до покупки (только шапка и текст, без путей). */
  publicDocs() {
    return Object.fromEntries(Object.entries(this.cfg.docs).map(([f, d]) => [f.replace(/\.md$/, ''), { version: d.version, status: d.status, text: d.text.slice(0, 40_000) }]));
  }

  /** Вещи, которые уже есть у человека из любого источника. */
  ownedAll(uid) {
    return new Set(this.app.collections.ownedItems(uid));
  }

  /** Почему эту вещь нельзя купить сейчас — код отказа или null. */
  whyNot(uid, id, { now = this.now(), except = null, approvedOnly = false } = {}) {
    const items = itemsOf(id);
    const owned = this.ownedAll(uid);
    const have = items.filter((x) => owned.has(x));
    if (have.length === items.length) return 'PAY_OWNED';
    if (have.length) return 'PAY_PARTIAL';
    for (const o of this.db.liveOrders(uid, now)) {
      if (o.id === except || (approvedOnly && o.state !== 'approved')) continue;
      if (o.items.some((x) => items.includes(x))) return 'PAY_PENDING';
    }
    return null;
  }

  async buy(uid, id, req) {
    const op = 'buy';
    const now = this.now();
    // Повтор того же запроса — тот же заказ (ответ мог потеряться).
    const same = this.db.orderByReq(uid, req);
    if (same) return same.link && ['created', 'approved'].includes(same.state) && same.expiresAt > now
      ? this.invoiceMsg(same) : this.fail(op, same.state === 'paid' ? 'PAY_OWNED' : 'PAY_TG');
    if (this.app.down) return this.fail(op, 'PAY_DOWN');
    if (!this.open) return this.fail(op, 'PAY_CLOSED');
    const it = itemById(id);
    const price = it ? priceOf(this.cfg, it.id) : null;
    if (!it || !SELLABLE.has(it.id) || !price) return this.fail(op, 'PAY_ITEM');
    // Тот же товар уже в живом заказе с тем же предложением — тот же счёт, второй не плодим.
    const live = this.db.liveOrders(uid, now).find((o) => o.item === it.id && o.price === price && o.terms === this.cfg.terms && o.link);
    // Мешает только заказ, по которому уже идёт оплата (pre_checkout подтверждён); брошенный счёт не мешает —
    // его потом не оплатить: pre_checkout сверит владение и пересечения заново.
    const why = this.whyNot(uid, it.id, { now, approvedOnly: true, except: live?.id ?? null });
    if (why) return this.fail(op, why);
    if (live) return this.invoiceMsg(live);
    const order = this.db.addOrder({
      id: this.newId(), userId: uid, item: it.id, items: itemsOf(it.id), price, terms: this.cfg.terms,
      mode: this.cfg.mode, req, at: now, expiresAt: now + ORDER_TTL_MS,
    });
    this.log('order', { orderId: order.id, userId: uid, amount: price, note: it.id });
    const test = this.cfg.mode === 'test';
    let link;
    try {
      link = await this.net(() => this.api.createInvoiceLink(
        `${test ? 'ТЕСТ · ' : ''}${it.title}`.slice(0, 32),
        `Оформление для игр: ${it.title}. Навсегда, все 4 цвета. Без игровых преимуществ. Условия ${order.terms}.`.slice(0, 255),
        payloadOf(order), '', 'XTR', [{ label: it.title.slice(0, 32), amount: price }],
      ));
    } catch (err) {
      this.db.moveOrder(order.id, ['created'], 'cancelled', this.now());
      this.log('order-fail', { orderId: order.id, userId: uid, note: err?.timeout ? 'timeout' : String(err?.description ?? err?.message ?? err) });
      return this.fail(op, 'PAY_TG');
    }
    if (typeof link !== 'string' || !/^https:\/\/t\.me\//.test(link)) {
      this.db.moveOrder(order.id, ['created'], 'cancelled', this.now());
      this.log('order-fail', { orderId: order.id, userId: uid, note: 'bad link' });
      return this.fail(op, 'PAY_TG');
    }
    this.db.setOrderLink(order.id, link, this.now());
    return this.invoiceMsg(this.db.order(order.id));
  }

  invoiceMsg(o) {
    return { t: 'pay', op: 'buy', order: o.id, item: o.item, price: o.price, link: o.link, test: o.mode === 'test' };
  }

  /* ------------------------------------------------ Telegram: pre_checkout */

  /** Проверки синхронные; сразу после — один ответ Telegram (успеть за 10 с). */
  check(q) {
    const now = this.now();
    const parsed = parsePayload(q?.invoice_payload);
    const o = parsed ? this.db.order(parsed.id) : null;
    if (!o || (parsed.item && parsed.item !== o.item)) return { ok: false, why: 'unknown' };
    if (String(q.from?.id ?? '') !== o.userId) return { ok: false, why: 'other', o };
    if (q.currency !== 'XTR' || q.total_amount !== o.price) return { ok: false, why: 'amount', o };
    if (!['created', 'approved'].includes(o.state)) return { ok: false, why: 'state', o };
    if (o.expiresAt <= now) return { ok: false, why: 'expired', o };
    const g = gate({ ...this.cfg, mode: o.mode === this.cfg.mode ? this.cfg.mode : 'off' }, { stopped: this.db.stopped(), down: this.app.down });
    if (!g.open) return { ok: false, why: 'closed', o };
    if (priceOf(this.cfg, o.item) !== o.price || this.cfg.terms !== o.terms) return { ok: false, why: 'changed', o };
    const why = this.whyNot(o.userId, o.item, { now, except: o.id, approvedOnly: true });
    if (why === 'PAY_OWNED' || why === 'PAY_PARTIAL') return { ok: false, why: 'owned', o };
    if (why === 'PAY_PENDING') return { ok: false, why: 'busy', o };
    return { ok: true, o };
  }

  async onPreCheckout(q) {
    const r = this.check(q);
    if (r.ok) this.db.moveOrder(r.o.id, ['created', 'approved'], 'approved', this.now());
    this.log(r.ok ? 'precheckout-ok' : 'precheckout-no', { orderId: r.o?.id ?? null, userId: q?.from?.id ?? null, amount: q?.total_amount ?? null, note: r.why ?? null });
    try {
      if (r.ok) await this.api.answerPreCheckoutQuery(q.id, true);
      else await this.api.answerPreCheckoutQuery(q.id, false, { error_message: PRECHECKOUT[r.why] });
    } catch (err) {
      // Не успели или Telegram не принял: он сам отменит оплату, звёзды не спишутся.
      this.app.log(err);
    }
  }

  /* ---------------------------------------------- Telegram: оплата пришла */

  /**
   * Записать оплату и выдать права — одной транзакцией. Повтор того же charge_id — ничего.
   * @returns {{ kind, order, fresh }}
   */
  record(sp, payerId, source) {
    const now = this.now();
    const chargeId = String(sp?.telegram_payment_charge_id ?? '');
    if (!chargeId) return { kind: 'invalid', fresh: false };
    return this.db.tx(() => {
      const known = this.db.payment(chargeId);
      if (known) return { kind: known.kind, order: known.orderId ? this.db.order(known.orderId) : null, fresh: false };
      const parsed = parsePayload(sp.invoice_payload);
      let o = parsed ? this.db.order(parsed.id) : null;
      // Заказа нет (база из ранней копии): восстановить, только если вещь продаётся, сумма = текущей цене
      // и у покупателя её ещё нет. Иначе — «orphan», владельцу на проверку.
      if (!o && parsed?.item && !this.ownedAll(payerId).has(parsed.item)) {
        const items = itemsOf(parsed.item);
        const price = priceOf(this.cfg, parsed.item);
        if (items.length && price && sp.currency === 'XTR' && sp.total_amount === price && !items.some((x) => this.ownedAll(payerId).has(x))) {
          this.db.addOrder({ id: parsed.id, userId: payerId, item: parsed.item, items, price, terms: this.cfg.terms, mode: this.cfg.mode === 'test' ? 'test' : 'live', req: null, at: now, expiresAt: now });
          this.db.log(now, 'order-restored', { orderId: parsed.id, userId: payerId, amount: price, note: parsed.item });
          o = this.db.order(parsed.id);
        }
      }
      let kind = 'order';
      if (!o) kind = 'orphan';
      else if (o.userId !== String(payerId) || sp.currency !== 'XTR' || sp.total_amount !== o.price) kind = 'mismatch';
      else if (o.state === 'paid' || o.state === 'refunded' || this.db.paymentsOfOrder(o.id).some((p) => p.kind === 'order')) kind = 'duplicate';
      this.db.addPayment({
        chargeId, orderId: o?.id ?? null, userId: payerId, amount: Number(sp.total_amount) || 0, currency: String(sp.currency ?? ''),
        payload: String(sp.invoice_payload ?? '').slice(0, 128), kind, source, providerId: sp.provider_payment_charge_id ?? null, at: now,
      });
      if (kind === 'order') {
        this.db.grant(o.id, o.items, o.userId, now);
        this.db.moveOrder(o.id, ['created', 'approved', 'cancelled'], 'paid', now);
      }
      this.db.log(now, `paid-${kind}`, { orderId: o?.id ?? null, userId: payerId, amount: Number(sp.total_amount) || 0, note: `${source} ${tail(chargeId)}` });
      return { kind, order: o ? this.db.order(o.id) : null, fresh: true };
    });
  }

  async onSuccessfulPayment(msg) {
    const payer = String(msg?.from?.id ?? '');
    const r = this.record(msg.successful_payment, payer, 'update');
    if (r.fresh) await this.afterPayment(r, payer);
  }

  async afterPayment(r, payer) {
    const o = r.order;
    if (r.kind === 'order') {
      this.app.collections.pushState(o.userId);
      const btn = this.app.webappUrl ? [[{ text: DM.button, web_app: { url: `${this.app.webappUrl}/?room=home` } }]] : null;
      await this.dm(o.userId, DM.paid(esc(itemById(o.item)?.title ?? o.item), o.id), btn);
      return;
    }
    if (r.kind === 'duplicate' && o) await this.dm(payer, DM.duplicate(o.id));
    else if (o) await this.dm(payer, DM.review(o.id));
    await this.notifyOwner(`⚠️ <b>Оплата на проверку</b>: ${r.kind}, заказ <code>${esc(o?.id ?? '—')}</code>, покупатель <code>${esc(payer)}</code>. Решение — /pays, возврат — /refund.`);
  }

  async dm(uid, text, keyboard = null) {
    // 403 — человек не открывал личку с ботом; покупка от этого не теряется, она в коллекции и в «Мои покупки».
    try { await this.app.outbox.post(String(uid), text, keyboard); } catch (err) { if (err?.error_code !== 403) this.app.log(err); }
  }

  /** Владельцу: через админ-бота, если он есть, иначе в личку игрового бота. */
  async notifyOwner(text) {
    try {
      if (this.app.notifyAdmins) return void (await this.app.notifyAdmins(text));
      for (const id of this.app.admins) await this.dm(id, text);
    } catch (err) { this.app.log(err); }
  }

  /* -------------------------------------------------------------- возврат */

  /** Снять права заказа и снять надетые вещи, которых больше нет ни из одного источника. Одной транзакцией. */
  closeRefund(chargeId, by, note) {
    const now = this.now();
    return this.db.tx(() => {
      const p = this.db.payment(chargeId);
      if (!p) return { ok: false, why: 'unknown' };
      let ref = this.db.refund(chargeId);
      if (!ref) { this.db.addRefund({ chargeId, orderId: p.orderId, userId: p.userId, amount: p.amount, by, at: now }); ref = this.db.refund(chargeId); }
      if (ref.state === 'done') return { ok: true, fresh: false, p };
      this.db.refundDone(chargeId, now, note);
      if (p.kind === 'order' && p.orderId) {
        this.db.revokeOrder(p.orderId, now);
        this.db.moveOrder(p.orderId, ['paid'], 'refunded', now);
        this.app.collections.dropUnowned(p.userId);
      }
      this.db.log(now, 'refund-done', { orderId: p.orderId, userId: p.userId, amount: p.amount, note: `${by} ${note ?? ''}`.trim() });
      return { ok: true, fresh: true, p };
    });
  }

  async afterRefund(r) {
    if (!r.fresh) return;
    const o = r.p.orderId ? this.db.order(r.p.orderId) : null;
    this.app.collections.pushState(r.p.userId);
    this.app.collections.changed(r.p.userId);
    if (o) await this.dm(r.p.userId, DM.refunded(esc(itemById(o.item)?.title ?? o.item), o.id));
  }

  /** Telegram сообщил о возврате (наш вызов, поддержка Telegram и т. п.). */
  async onRefundedPayment(msg) {
    const rp = msg.refunded_payment;
    const chargeId = String(rp?.telegram_payment_charge_id ?? '');
    if (!chargeId || !this.db.payment(chargeId)) {
      this.log('refund-unknown', { userId: msg?.from?.id ?? null, amount: rp?.total_amount ?? null, note: tail(chargeId) });
      return;
    }
    await this.afterRefund(this.closeRefund(chargeId, 'telegram', 'refunded_payment'));
  }

  /** Шаг 1: показать, что именно возвращаем, и выдать код подтверждения. */
  refundPreview(admin, orderId) {
    if (!this.app.isAdmin(admin)) return null;
    const o = this.db.order(orderId);
    if (!o) return 'Такого заказа нет. Номера — /pays.';
    const p = this.db.paymentsOfOrder(o.id).find((x) => x.kind === 'order') ?? this.db.paymentsOfOrder(o.id)[0];
    if (!p) return `Заказ <code>${esc(o.id)}</code> не оплачен — возвращать нечего.`;
    const ref = this.db.refund(p.chargeId);
    if (ref?.state === 'done') return `По заказу <code>${esc(o.id)}</code> возврат уже выполнен.`;
    const code = this.newCode();
    this.confirms.set(`${admin}:${o.id}`, { code, until: this.now() + CONFIRM_MS, chargeId: p.chargeId });
    return [
      `↩️ <b>Возврат по заказу</b> <code>${esc(o.id)}</code>`,
      `Покупатель: <code>${esc(p.userId)}</code> · вещь: ${esc(itemById(o.item)?.title ?? o.item)}`,
      `Сумма: ${p.amount} ⭐ (полностью) · платёж …${esc(tail(p.chargeId))} · ${p.kind}`,
      ref ? `Возврат начат раньше, попыток: ${ref.attempts}. Повтор сначала проверит сверкой.` : '',
      `Права на вещь будут сняты. Подтвердить (10 минут): <code>/refund ${esc(o.id)} ${code}</code>`,
    ].filter(Boolean).join('\n');
  }

  /** Шаг 2: выполнить. Возвращает текст для владельца. */
  async refundConfirm(admin, orderId, code) {
    if (!this.app.isAdmin(admin)) return null;
    const key = `${admin}:${orderId}`;
    const c = this.confirms.get(key);
    if (!c || c.code !== code || c.until < this.now()) return 'Код не подходит или устарел. Начните заново: <code>/refund &lt;заказ&gt;</code>.';
    this.confirms.delete(key);
    const p = this.db.payment(c.chargeId);
    if (!p) return 'Платёж не найден.';
    // Одна строка возврата на платёж: второй возврат невозможен.
    const ref = this.db.tx(() => {
      const was = this.db.refund(p.chargeId);
      if (!was) this.db.addRefund({ chargeId: p.chargeId, orderId: p.orderId, userId: p.userId, amount: p.amount, by: admin, at: this.now() });
      return this.db.refund(p.chargeId);
    });
    if (ref.state === 'done') return 'Возврат уже выполнен — повторять нельзя.';
    // Повтор после таймаута: сначала сверка — вдруг первый вызов дошёл.
    if (ref.attempts > 0) {
      const seen = await this.findRefundTx(p.chargeId, p.userId).catch(() => null);
      if (seen) { await this.afterRefund(this.closeRefund(p.chargeId, admin, 'сверка')); return 'Сверка: возврат уже прошёл в Telegram. Права сняты.'; }
    }
    this.db.refundAttempt(p.chargeId, 'вызов');
    this.log('refund-call', { orderId: p.orderId, userId: p.userId, amount: p.amount, note: `by ${admin}` });
    try {
      await this.net(() => this.api.refundStarPayment(Number(p.userId), p.chargeId));
    } catch (err) {
      if (!alreadyRefunded(err)) {
        const t = err?.timeout ? 'нет ответа' : String(err?.description ?? err?.message ?? err).slice(0, 200);
        this.db.refundAttempt(p.chargeId, t);
        this.db.log(this.now(), 'refund-fail', { orderId: p.orderId, userId: p.userId, note: t });
        return `Telegram не подтвердил возврат (${esc(t)}). Права пока не сняты. Повторите позже: <code>/refund ${esc(orderId)}</code> — повтор сначала проверит сверкой и не вернёт дважды.`;
      }
    }
    await this.afterRefund(this.closeRefund(p.chargeId, admin, 'refundStarPayment'));
    return `✅ Возврат ${p.amount} ⭐ выполнен, права сняты. Заказ <code>${esc(orderId)}</code>.`;
  }

  /* ---------------------------------------------------------------- сверка */

  async *transactions() {
    for (let page = 0; page < RECONCILE_PAGES; page++) {
      const r = await this.net(() => this.api.getStarTransactions({ offset: page * 100, limit: 100 }));
      const list = Array.isArray(r?.transactions) ? r.transactions : [];
      for (const t of list) yield t;
      if (list.length < 100) return;
    }
  }

  async findRefundTx(chargeId, userId) {
    for await (const t of this.transactions()) {
      if (t.id === chargeId && t.receiver?.type === 'user' && String(t.receiver.user?.id) === String(userId)) return t;
    }
    return null;
  }

  /** Пройти по транзакциям бота: пропущенные оплаты провести, исходящие по нашим платежам — засчитать возвратом. */
  async reconcile() {
    const out = { seen: 0, recovered: 0, refunds: 0, unknownOut: 0, review: 0 };
    for await (const t of this.transactions()) {
      out.seen++;
      const src = t.source;
      if (src?.type === 'user' && src.transaction_type === 'invoice_payment' && orderOfPayload(src.invoice_payload)) {
        if (this.db.payment(t.id)) continue;
        const r = this.record({ telegram_payment_charge_id: t.id, invoice_payload: src.invoice_payload, currency: 'XTR', total_amount: t.amount }, String(src.user?.id ?? ''), 'reconcile');
        if (r.fresh) { out.recovered++; if (r.kind !== 'order') out.review++; await this.afterPayment(r, String(src.user?.id ?? '')); }
      } else if (t.receiver?.type === 'user') {
        const p = this.db.payment(t.id);
        if (!p) { out.unknownOut++; continue; }
        const r = this.closeRefund(t.id, 'reconcile', 'исходящая транзакция');
        if (r.fresh) { out.refunds++; await this.afterRefund(r); }
      }
    }
    this.log('reconcile', { note: JSON.stringify(out) });
    return out;
  }

  /* --------------------------------------------------- история и поддержка */

  stateOfOrder(o) {
    const pays = this.db.paymentsOfOrder(o.id);
    if (pays.some((p) => p.kind !== 'order' && this.db.refund(p.chargeId)?.state !== 'done')) return 'review';
    const main = pays.find((p) => p.kind === 'order');
    if (!main) return null;
    const ref = this.db.refund(main.chargeId);
    if (ref?.state === 'done') return 'refunded';
    if (ref) return 'refund_pending';
    return 'paid';
  }

  /** Покупки человека (без незавершённых счетов). Только его собственные. */
  history(uid) {
    return this.db.ordersOf(uid).map((o) => ({ o, state: this.stateOfOrder(o) })).filter((x) => x.state)
      .map(({ o, state }) => ({ id: o.id, item: o.item, title: itemById(o.item)?.title ?? o.item, price: o.price, at: o.createdAt, state, test: o.mode === 'test' }));
  }

  /** /paysupport — работает всегда, даже при закрытых продажах (О-12). */
  supportText(uid) {
    const orders = this.history(uid).map((o) => ({ ...o, stateText: STATE_TEXT[o.state] ?? o.state }));
    return supportText({ contact: this.cfg.support, orders, esc });
  }

  termsText() {
    return termsText({ docs: this.cfg.docs, esc });
  }

  /* ------------------------------------------------------- пульт владельца */

  salesText() {
    const g = this.gate();
    const lines = [
      `🛒 <b>Продажи: ${g.open ? (this.cfg.mode === 'test' ? 'открыты (ТЕСТОВАЯ среда)' : 'ОТКРЫТЫ') : 'закрыты'}</b>`,
      `Режим: ${this.cfg.mode}${this.cfg.testEnv ? ' · тестовая среда Telegram' : ''} · остановка: ${this.db.stopped() ? 'да' : 'нет'}`,
      `В пути (pre_checkout без оплаты): ${this.db.inFlight(this.now())} · на проверке: ${this.db.paymentsToReview().length} · возвратов в обработке: ${this.db.pendingRefunds().length}`,
    ];
    if (g.reasons.length) lines.push('', '<b>Почему закрыто:</b>', ...g.reasons.map((r) => `• ${esc(r)}`));
    lines.push('', 'Команды: /salesstop · /salesresume · /pays · /refund &lt;заказ&gt; · /reconcile');
    return lines.join('\n');
  }

  paysText() {
    const rows = this.db.recentOrders(15);
    if (!rows.length) return 'Заказов нет.';
    return ['🧾 <b>Последние заказы</b>', ...rows.map((o) => {
      const st = this.stateOfOrder(o) ?? o.state;
      return `<code>${esc(o.id)}</code> · ${esc(o.item)} · ${o.price} ⭐ · ${esc(st)} · id ${esc(o.userId)}${o.mode === 'test' ? ' · тест' : ''}`;
    })].join('\n');
  }

  /** Команды владельца; null — не наша команда или не владелец. */
  async adminCommand(user, cmd, rest = '') {
    if (!this.app.isAdmin(user.id)) return null;
    const args = String(rest || '').trim().split(/\s+/).filter(Boolean);
    switch (cmd) {
      case 'sales': return this.salesText();
      case 'salesstop': this.db.setStopped(true); this.log('sales-stop', { userId: user.id }); this.app.collections.pushAll(); return '⏹ Новые продажи остановлены. Уже оплаченное выдаётся, возвраты и сверка работают.\n\n' + this.salesText();
      case 'salesresume': this.db.setStopped(false); this.log('sales-resume', { userId: user.id }); this.app.collections.pushAll(); return '▶️ Остановка снята.\n\n' + this.salesText();
      case 'pays': return this.paysText();
      case 'refund':
        if (!args[0]) return 'Нужен номер заказа: <code>/refund abcd…</code>. Номера — /pays.';
        return args[1] ? this.refundConfirm(String(user.id), args[0], args[1]) : this.refundPreview(String(user.id), args[0]);
      case 'reconcile': {
        try {
          const r = await this.reconcile();
          return `🔎 Сверка: просмотрено ${r.seen}, восстановлено оплат ${r.recovered} (на проверку ${r.review}), засчитано возвратов ${r.refunds}, незнакомых исходящих ${r.unknownOut}.`;
        } catch (err) {
          return `Сверка не удалась: ${esc(err?.timeout ? 'нет ответа Telegram' : String(err?.description ?? err?.message ?? err).slice(0, 200))}. Ничего не изменено.`;
        }
      }
      default: return null;
    }
  }
}

export const PAY_ADMIN_COMMANDS = ['sales', 'salesstop', 'salesresume', 'pays', 'refund', 'reconcile'];
