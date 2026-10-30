/**
 * payments: магазин в админке владельца (вкладка «Магазин», шаг H). Протокол страницы `{ t: 'ashop', op, … }`.
 * Контракт — docs/next-release/payment-design.md, раздел «Цены и выдача админом»; тексты — MESSAGES.md, «Магазин в админке».
 *
 * На чём держится:
 *  - кто — только `session.user` админской страницы (подписанный initData), и КАЖДАЯ операция ещё раз сверяется
 *    с `ADMINS` (`app.isAdmin`): не-владельцу — null, хаб отвечает «Не понял запрос.», как на несуществующее;
 *  - выдача владельцем — отдельный источник права `admin` (таблица shop_grant): не покупка, не тестер, без платежа;
 *    «Забрать» снимает только его, купленное не трогает; надетое снимается, лишь если права не осталось ни откуда;
 *  - деньги — только существующими путями: возврат — `refundPrepare` + `refundConfirm` (тот же код, что /refund),
 *    остановка — `setStopped` (то же, что /salesstop). Новых путей к звёздам здесь нет;
 *  - цена и «утвердить цены» — двумя шагами с кодом от сервера; смена цены действует на новые заказы,
 *    уже выставленный счёт со старой ценой Telegram не даст оплатить (pre_checkout → «changed»);
 *  - повтор нажатия (`req`) — ничего второй раз; частота — 30 операций в минуту на владельца; журнал без секретов;
 *  - в игры не заглядываем: здесь нет карт, ходов и комнат.
 */
import crypto from 'node:crypto';
import { itemById, itemsOfBundle } from '../../miniapp/collections/catalog.js';
import { isReq } from '../../miniapp/collections/protocol.js';
import { SELLABLE, isPrice, isHidden, priceOf, MAX_PRICE } from './config.js';

export const ASHOP_OPS = ['price', 'hide', 'approve', 'confirm', 'grant', 'revoke', 'user', 'orders', 'refund', 'refundConfirm', 'sales'];
export const ASHOP_PER_MINUTE = 30;
const MINUTE = 60_000;
const ASK_MS = 10 * MINUTE;

/** Отказы словами. */
export const ASHOP_ERRORS = {
  OP: 'Не понял запрос.',
  FAST: 'Слишком часто. Подождите минуту.',
  ITEM: 'Такой вещи в магазине нет.',
  PRICE: `Цена — целое число звёзд от 1 до ${String(MAX_PRICE).replace(/\B(?=(\d{3})+$)/g, '.')}.`,
  SAME: 'Цена и так такая.',
  USER: 'Нужен Telegram id — только цифры.',
  CODE: 'Подтверждение устарело или уже использовано. Начните заново.',
  STALE: 'Пока вы подтверждали, цена уже изменилась. Начните заново.',
  REQ: 'Не понял запрос.',
};

/** Ответы владельцу. */
export const ASHOP_TEXT = {
  repeat: 'Это нажатие уже выполнено — второй раз ничего не делаю.',
  priceAsk: (title, from, to) => `${title}: ${from == null ? 'нет цены' : `${from} ⭐`} → ${to} ⭐. Действует на новые заказы; уже выставленный счёт со старой ценой оплатить будет нельзя — человек откроет вещь заново.`,
  priceDone: (title, to) => `Цена «${title}» — ${to} ⭐. Для новых заказов.`,
  hidden: (title) => `«${title}» скрыта: новые заказы на неё не выставляются. Купленное и выданное остаётся у людей.`,
  shown: (title) => `«${title}» снова в продаже (если продажи открыты).`,
  approveAsk: (on) => (on ? 'Утвердить текущие цены? Это одно из условий открытия продаж; остальные (режим, документы, поддержка) останутся как есть.'
    : 'Снять утверждение цен? Новые счета перестанут выставляться, пока не утвердите снова.'),
  approveDone: (on) => (on ? 'Цены утверждены.' : 'Утверждение цен снято — новые продажи закрыты.'),
  granted: (title, uid) => `Выдано: ${title} → ${uid}. Это подарок от администратора, не покупка: платежа нет.`,
  grantedAlready: (title, uid) => `У ${uid} «${title}» уже выдана вами — ничего не изменено.`,
  revoked: (title, uid) => `Забрано: ${title} у ${uid}. Купленное, если было, осталось.`,
  revokedNone: (title, uid) => `У ${uid} нет вашей выдачи «${title}». Купленное из админки не забирается — только возвратом.`,
  stopped: 'Новые продажи остановлены. Уже оплаченное выдаётся, возвраты и сверка работают.',
  resumed: 'Остановка снята. Продажи откроются, только если выполнены остальные условия.',
  refundAsk: (r) => `Возврат ${r.amount} ⭐ (полностью) по заказу ${r.order}: ${r.title}, покупатель ${r.userId}, платёж …${r.chargeTail}. Права на вещь будут сняты.${r.attempts != null ? ` Возврат начинали раньше (попыток: ${r.attempts}) — повтор сначала проверит сверкой.` : ''}`,
};

/** HTML бота → простой текст для страницы. */
const plain = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const isUid = (x) => typeof x === 'string' && /^[1-9]\d{0,19}$/.test(x);
const titleOf = (id) => itemById(id)?.title ?? id;
/** Вещи, которых касается операция: предмет — он сам, комплект — его предметы. */
const partsOf = (id) => (itemById(id)?.kind === 'bundle' ? itemsOfBundle(id) : [id]);

export class AdminShop {
  /** @param pay  Payments */
  constructor(pay) {
    this.pay = pay;
    this.limits = new Map();
    /** Ожидающие подтверждения: `${admin}:${code}` → { action, until }. Только в памяти. */
    this.asks = new Map();
    this.newCode = () => crypto.randomBytes(4).toString('hex');
  }

  get app() { return this.pay.app; }
  get db() { return this.pay.db; }
  now() { return this.pay.now(); }

  fail(op, code) {
    return { t: 'ashop', op, error: { code, text: ASHOP_ERRORS[code] } };
  }
  ok(op, text, extra = {}) {
    return { t: 'ashop', op, ok: true, text, changed: true, ...extra };
  }

  tooFast(uid) {
    const now = this.now();
    for (const [id, times] of this.limits) if (!times.some((at) => now - at < MINUTE)) this.limits.delete(id);
    const times = (this.limits.get(uid) || []).filter((at) => now - at < MINUTE);
    if (times.length >= ASHOP_PER_MINUTE) return true;
    times.push(now);
    this.limits.set(uid, times);
    return false;
  }

  ask(admin, action, text) {
    const now = this.now();
    for (const [k, a] of this.asks) if (a.until < now) this.asks.delete(k);
    const code = this.newCode();
    this.asks.set(`${admin}:${code}`, { action, until: now + ASK_MS });
    return { t: 'ashop', op: 'ask', ask: { kind: action.kind, code, text, ...action.show } };
  }

  /**
   * @param user  session.user админской страницы — единственный источник «кто»
   * @returns ответ странице или null (не владелец: хаб ответит как на неизвестный запрос)
   */
  async handle(user, msg) {
    const admin = String(user?.id ?? '');
    if (!this.app.isAdmin(admin)) return null;
    const op = ASHOP_OPS.includes(msg?.op) ? msg.op : null;
    if (!op) return this.fail('state', 'OP');
    if (this.tooFast(admin)) return this.fail(op, 'FAST');
    // Всё, что меняет, — только с `req`: повтор того же нажатия ничего не делает второй раз.
    if (['hide', 'confirm', 'grant', 'revoke', 'sales', 'refundConfirm'].includes(op)) {
      if (!isReq(msg.req)) return this.fail(op, 'REQ');
      if (!this.db.adminReq(admin, msg.req, this.now())) return { t: 'ashop', op, ok: true, repeat: true, text: ASHOP_TEXT.repeat };
    }
    switch (op) {
      case 'price': return this.priceAsk(admin, msg);
      case 'approve': return this.ask(admin, { kind: 'approve', on: msg.on === true, show: { on: msg.on === true } }, ASHOP_TEXT.approveAsk(msg.on === true));
      case 'confirm': return this.confirm(admin, msg);
      case 'hide': return this.hide(admin, msg);
      case 'grant': return this.grant(admin, msg);
      case 'revoke': return this.revoke(admin, msg);
      case 'user': return this.user(msg);
      case 'orders': return { t: 'ashop', op, orders: this.db.findOrders(String(msg.q ?? '').slice(0, 40)).map((o) => this.orderRow(o)) };
      case 'refund': return this.refundAsk(admin, msg);
      case 'refundConfirm': return this.refundConfirm(admin, msg);
      case 'sales': {
        const stop = msg.stop === true;
        this.pay.setStopped(admin, stop);
        this.db.adminLog(this.now(), admin, stop ? 'sales-stop' : 'sales-resume');
        return this.ok(op, stop ? ASHOP_TEXT.stopped : ASHOP_TEXT.resumed);
      }
      default: return this.fail(op, 'OP');
    }
  }

  /* ----------------------------------------------------------------- цены */

  priceAsk(admin, msg) {
    const id = String(msg.item ?? '');
    if (!SELLABLE.has(id)) return this.fail('price', 'ITEM');
    const to = msg.price; // только число от страницы: «50» строкой — не цена
    if (!isPrice(to)) return this.fail('price', 'PRICE');
    const from = this.pay.offers().items[id];
    if (from === to) return this.fail('price', 'SAME');
    return this.ask(admin, { kind: 'price', item: id, from, to, show: { item: id, title: titleOf(id), from, to } }, ASHOP_TEXT.priceAsk(titleOf(id), from, to));
  }

  confirm(admin, msg) {
    const key = `${admin}:${String(msg.code ?? '')}`;
    const a = this.asks.get(key);
    if (!a || a.until < this.now()) return this.fail('confirm', 'CODE');
    this.asks.delete(key);
    const { action } = a;
    const now = this.now();
    if (action.kind === 'price') {
      // Подтверждали «было → стало»: если за это время цену сменил кто-то ещё — не перетираем молча.
      if (this.pay.offers().items[action.item] !== action.from) return this.fail('confirm', 'STALE');
      this.db.setOfferPrice(action.item, action.to, admin, now);
      this.db.adminLog(now, admin, 'price', { item: action.item, before: action.from, after: action.to });
      this.pay.log('price', { userId: admin, amount: action.to, note: `${action.item} ${action.from ?? '—'}→${action.to}` });
      this.app.collections.pushAll();
      return this.ok('confirm', ASHOP_TEXT.priceDone(titleOf(action.item), action.to));
    }
    if (action.kind === 'approve') {
      const before = this.pay.offers().approved;
      this.db.setApproved(action.on);
      this.db.adminLog(now, admin, 'approve', { before, after: action.on });
      this.pay.log(action.on ? 'prices-approved' : 'prices-unapproved', { userId: admin });
      this.app.collections.pushAll();
      return this.ok('confirm', ASHOP_TEXT.approveDone(action.on));
    }
    return this.fail('confirm', 'CODE');
  }

  hide(admin, msg) {
    const id = String(msg.item ?? '');
    if (!SELLABLE.has(id)) return this.fail('hide', 'ITEM');
    const on = msg.hidden === true;
    const before = isHidden(this.pay.eff(), id);
    this.db.setOfferHidden(id, on, admin, this.now());
    this.db.adminLog(this.now(), admin, on ? 'hide' : 'show', { item: id, before, after: on });
    this.app.collections.pushAll();
    return this.ok('hide', on ? ASHOP_TEXT.hidden(titleOf(id)) : ASHOP_TEXT.shown(titleOf(id)));
  }

  /* ------------------------------------------------------- выдать / забрать */

  target(op, msg) {
    const uid = String(msg.user ?? '').trim();
    if (!isUid(uid)) return { error: this.fail(op, 'USER') };
    const id = String(msg.item ?? '');
    if (!SELLABLE.has(id)) return { error: this.fail(op, 'ITEM') };
    return { uid, id };
  }

  grant(admin, msg) {
    const t = this.target('grant', msg);
    if (t.error) return t.error;
    const now = this.now();
    const fresh = this.db.tx(() => partsOf(t.id).filter((it) => this.db.adminGrant(t.uid, it, admin, now)));
    if (!fresh.length) return this.ok('grant', ASHOP_TEXT.grantedAlready(titleOf(t.id), t.uid), { changed: false, user: this.holdings(t.uid) });
    this.db.adminLog(now, admin, 'grant', { userId: t.uid, item: t.id, after: fresh.join(',') });
    this.pay.log('admin-grant', { userId: t.uid, note: `${t.id} by ${admin}` });
    this.app.collections.pushState(t.uid);
    return this.ok('grant', ASHOP_TEXT.granted(titleOf(t.id), t.uid), { user: this.holdings(t.uid) });
  }

  revoke(admin, msg) {
    const t = this.target('revoke', msg);
    if (t.error) return t.error;
    const now = this.now();
    const gone = this.db.tx(() => {
      const out = partsOf(t.id).filter((it) => this.db.adminRevoke(t.uid, it, admin, now));
      // Надетое снимаем, только если права не осталось ни из одного источника (купленное держит вещь).
      if (out.length) this.app.collections.dropUnowned(t.uid);
      return out;
    });
    if (!gone.length) return this.ok('revoke', ASHOP_TEXT.revokedNone(titleOf(t.id), t.uid), { changed: false, user: this.holdings(t.uid) });
    this.db.adminLog(now, admin, 'revoke', { userId: t.uid, item: t.id, before: gone.join(',') });
    this.pay.log('admin-revoke', { userId: t.uid, note: `${t.id} by ${admin}` });
    this.app.collections.pushState(t.uid);
    this.app.collections.changed(t.uid);
    return this.ok('revoke', ASHOP_TEXT.revoked(titleOf(t.id), t.uid), { user: this.holdings(t.uid) });
  }

  /** Что у человека есть и откуда: по каждой вещи — источники (purchase, admin, staff). */
  holdings(uid) {
    const src = this.app.collections.sourcesOf(uid);
    const nick = this.app.store.getProfile?.(uid)?.nickname ?? null;
    return {
      id: uid,
      nick,
      items: [...src].map(([item, from]) => ({ item, title: titleOf(item), source: [...from].sort() })),
      orders: this.db.ordersOf(uid, 20).map((o) => this.orderRow(o)),
    };
  }

  /** Поиск человека: цифры — это id; иначе — по нику из профиля (без учёта регистра). */
  user(msg) {
    const q = String(msg.q ?? '').trim().slice(0, 40);
    if (isUid(q)) return { t: 'ashop', op: 'user', user: this.holdings(q) };
    if (q.length < 2) return this.fail('user', 'USER');
    const found = (this.app.store.findProfiles?.(q, 10) ?? []).map((p) => ({ id: p.id, nick: p.nick }));
    return { t: 'ashop', op: 'user', found };
  }

  /* ----------------------------------------------------- заказы и возвраты */

  orderRow(o) {
    return { id: o.id, item: o.item, title: titleOf(o.item), price: o.price, userId: o.userId, at: o.createdAt, state: this.pay.stateOfOrder(o) ?? o.state, test: o.mode === 'test' };
  }

  /** Шаг 1 — тот же, что /refund: код подтверждения живёт в Payments и один на двоих с ботом. */
  refundAsk(admin, msg) {
    const r = this.pay.refundPrepare(admin, String(msg.order ?? '').slice(0, 32));
    if (!r) return null;
    if (r.error) return { t: 'ashop', op: 'refund', error: { code: 'REFUND', text: plain(r.error) } };
    return { t: 'ashop', op: 'ask', ask: { kind: 'refund', code: r.code, order: r.order, amount: r.amount, title: r.title, userId: r.userId, text: ASHOP_TEXT.refundAsk(r) } };
  }

  /** Шаг 2 — ровно refundConfirm(admin, order, code), как `/refund <заказ> <код>`. */
  async refundConfirm(admin, msg) {
    const text = await this.pay.refundConfirm(admin, String(msg.order ?? '').slice(0, 32), String(msg.code ?? '').slice(0, 16));
    if (text == null) return null;
    const done = /^(✅|Сверка)/.test(text);
    this.db.adminLog(this.now(), admin, done ? 'refund' : 'refund-no', { after: String(msg.order ?? '').slice(0, 32) });
    // Не вышло (код устарел, Telegram не ответил) — это отказ, а не «готово»: текст тот же, что у бота.
    if (!done) return { t: 'ashop', op: 'refundConfirm', error: { code: 'REFUND', text: plain(text) }, changed: true };
    return this.ok('refundConfirm', plain(text));
  }

  /* -------------------------------------------------------- вид вкладки */

  /** Состояние вкладки «Магазин» (часть adminView). Без имён — только id, суммы, время. */
  view() {
    const eff = this.pay.eff();
    const base = this.pay.cfg.offers;
    const g = this.pay.gate();
    const now = this.now();
    return {
      mode: this.pay.cfg.mode,
      open: g.open,
      reasons: g.reasons,
      stopped: this.db.stopped(),
      approved: eff.offers.approved,
      items: [...SELLABLE].map((id) => ({
        id, title: titleOf(id), kind: itemById(id)?.kind ?? 'item',
        base: base.items[id] ?? null, price: eff.offers.items[id] ?? null,
        hidden: isHidden(eff, id), sells: g.open ? priceOf(eff, id) : null,
      })),
      orders: this.db.recentOrders(15).map((o) => this.orderRow(o)),
      log: this.db.adminLogs(20),
      inFlight: this.db.inFlight(now),
      review: this.db.paymentsToReview().length,
      refunds: this.db.pendingRefunds().length,
    };
  }
}
