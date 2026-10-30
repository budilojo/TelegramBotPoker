/**
 * collections: коллекция «Графит», сервер. Протокол `{ t: 'col' }`, демосреда, снимок оформления
 * комнаты. Контракт — docs/graphit-launch/contracts.md (разделы 2–6).
 *
 * Правила, на которых всё держится:
 *  - кто — только из `session.user` (подписанный initData); поля тела `userId`, `demo`, `price`,
 *    `unlocked`, `item`-как-право и т. п. ничего не значат;
 *  - демосреда включается ТОЛЬКО опцией `collectionsDemo === true`, которую bot/index.js берёт из
 *    переменной окружения процесса; демо-строки в базе без неё не читаются;
 *  - оформление не меняет ходы, часы, рейтинг, шансы: оно только лежит в `room.look` и в виде.
 */
import { ERRORS, OPS, PER_MINUTE, isReq, REQ_KEEP } from '../../miniapp/collections/protocol.js';
import { ITEMS, SLOTS, isColor, itemById, itemsOfBundle, slotOf } from '../../miniapp/collections/catalog.js';

const GAMES = new Set(['poker', 'durak']);
const MINUTE = 60_000;

/** Номер раздачи (покер) / партии (дурак); у лобби — 0. */
export const dealNoOf = (room) => (room.game === 'durak' ? room.gameNo : room.handNo) || 0;

const emptySlots = () => Object.fromEntries(SLOTS.map((s) => [s, null]));

export class Collections {
  /**
   * @param app   App (часы `app.clock`, база `app.store`, комнаты `app.rooms`)
   * @param demo  включена ли демосреда. Только строгое `true`.
   */
  constructor(app, { demo = false } = {}) {
    this.app = app;
    this.demo = demo === true;
    this.limits = new Map();
  }

  /** Есть ли хоть что-то от коллекций в этом процессе (демо или магазин). Кому видно — `visibleFor`. */
  get enabled() {
    return this.demo || (this.app.payments?.cfg.mode ?? 'off') !== 'off';
  }

  get pay() {
    return this.app.payments ?? null;
  }

  /** Видит ли человек коллекции: демо — всем; без демо — магазин (открыт, тестер при включённом режиме, есть покупки). */
  visibleFor(uid) {
    if (this.demo) return true;
    return !!this.pay?.shopVisibleFor(String(uid));
  }

  /* ------------------------------------------------------------- права */

  /**
   * Какие предметы есть у человека — объединение независимых источников:
   *  покупка (pay_entitlement, всегда), выдача владельцем (shop_grant, всегда), доступ тестера/админа (только при включённом режиме продаж), демо (только в демосреде).
   */
  sourcesOf(uid) {
    const u = String(uid);
    const out = new Map();
    const add = (item, src) => {
      if (itemById(item)?.kind !== 'item') return;
      if (!out.has(item)) out.set(item, new Set());
      out.get(item).add(src);
    };
    for (const i of this.app.store.pay?.ownedItems(u) ?? []) add(i, 'purchase');
    // Выдано владельцем в админке — отдельный источник: не покупка и не доступ тестера, действует в любом режиме.
    for (const i of this.app.store.pay?.adminItems(u) ?? []) add(i, 'admin');
    if (this.pay?.staffOwns(u)) for (const it of ITEMS) add(it.id, 'staff');
    if (this.demo) for (const i of this.app.store.collDemoItems?.(u) ?? []) add(i, 'demo');
    return out;
  }

  ownedItems(uid) {
    return [...this.sourcesOf(uid).keys()];
  }

  owns(uid, item) {
    return this.sourcesOf(uid).has(item);
  }

  /** Выбор человека по слотам с проверкой права: нет права — null (база). */
  choiceOf(uid) {
    const out = emptySlots();
    const owned = new Set(this.ownedItems(uid));
    for (const r of this.app.store.collChoices?.(String(uid)) ?? []) {
      const it = itemById(r.item);
      if (!SLOTS.includes(r.slot) || !it || it.kind !== 'item' || it.slot !== r.slot) continue;
      if (!isColor(r.color) || !owned.has(r.item)) continue;
      out[r.slot] = { item: r.item, color: r.color };
    }
    return out;
  }

  /** После возврата: снять выбор вещей, которых больше нет ни из одного источника. */
  dropUnowned(uid) {
    const owned = new Set(this.ownedItems(uid));
    for (const r of this.app.store.collChoices?.(String(uid)) ?? []) {
      if (!owned.has(r.item)) this.app.store.collChoiceClear(String(uid), r.slot);
    }
  }

  /** Новое состояние — на все открытые страницы человека (после оплаты/возврата). */
  pushState(uid) {
    try { this.app.hub?.sendToUser?.(String(uid), () => this.stateOf(uid)); } catch (err) { this.app.log(err); }
  }

  /** Выключатель продаж сменился — всем открытым страницам их состояние. */
  pushAll() {
    try { this.app.hub?.sendToAll?.((uid) => this.stateOf(uid)); } catch (err) { this.app.log(err); }
  }

  /* --------------------------------------------------------- снимок */

  /** Подходит ли предмет к игре комнаты. */
  fits(slotItem, room) {
    const it = itemById(slotItem);
    return !!it && it.games.includes(room.game);
  }

  supported(room) {
    return !!room && GAMES.has(room.game) && room.status !== undefined;
  }

  /** Собрать снимок из текущего выбора. Стол — выбор хоста; рубашки — сидящих (покер); рамки — всех людей. */
  build(room, dealNo) {
    const people = room.players.filter((p) => !p.bot && !p.left && !p.kicked);
    const hostChoice = this.choiceOf(room.hostId);
    const table = hostChoice.table && this.fits(hostChoice.table.item, room) ? hostChoice.table : null;
    const backs = {};
    const frames = {};
    for (const p of people) {
      const c = this.choiceOf(p.id);
      if (room.game === 'poker' && c.cardback) backs[p.id] = c.cardback;
      if (c.profile) frames[p.id] = c.profile;
    }
    return { v: 1, table, backs, frames, dealNo };
  }

  /** Начало раздачи/партии: снимок собирается один раз и замораживается. */
  freeze(room) {
    if (!this.supported(room)) return;
    room.look = this.build(room, dealNoOf(room));
  }

  /**
   * Перед каждой рассылкой. Лобби — живое, пересборка. В раздаче снимок трогаем только если его нет
   * вовсе (старая комната) или он снят для другой раздачи (раздача началась не через afterDeal).
   */
  settle(room) {
    if (!this.supported(room)) return;
    if (room.status === 'lobby') {
      room.look = this.build(room, 0);
      return;
    }
    if (!room.look || room.look.v !== 1 || room.look.dealNo !== dealNoOf(room)) this.freeze(room);
  }

  /** Что у человека «применится со следующей раздачи»: выбор расходится со снимком идущей раздачи. */
  pendingOf(uid) {
    const out = emptySlots();
    if (!this.visibleFor(uid)) return out;
    const mine = this.choiceOf(uid);
    const same = (a, b) => (a?.item ?? null) === (b?.item ?? null) && (a?.color ?? null) === (b?.color ?? null);
    for (const room of this.app.rooms.values()) {
      if (!this.supported(room) || room.status === 'lobby' || room.status === 'finished' || !room.look) continue;
      const me = room.players.find((p) => p.id === String(uid) && !p.bot && !p.left && !p.kicked);
      if (!me) continue;
      if (room.game === 'poker' && !same(mine.cardback, room.look.backs?.[me.id])) out.cardback = 'next-deal';
      if (!same(mine.profile, room.look.frames?.[me.id])) out.profile = 'next-deal';
      if (room.hostId === me.id && !same(mine.table && this.fits(mine.table.item, room) ? mine.table : null, room.look.table)) out.table = 'next-deal';
    }
    return out;
  }

  /* --------------------------------------------------------- протокол */

  stateOf(uid) {
    if (!this.visibleFor(uid)) {
      return { t: 'col', op: 'state', v: 1, enabled: false, demo: false, owned: [], choice: emptySlots(), pending: emptySlots() };
    }
    const src = this.sourcesOf(uid);
    const s = {
      t: 'col', op: 'state', v: 1, enabled: true, demo: this.demo,
      // Демосреда — прежний контракт `{ item, demo }`; магазин — плюс источники права (покупка / тестер).
      owned: [...src].map(([item, from]) => (this.demo
        ? { item, demo: from.size === 1 && from.has('demo') }
        : { item, demo: false, source: [...from].sort() })),
      choice: this.choiceOf(uid),
      pending: this.pendingOf(uid),
    };
    // Магазин (без демо): цены и открытость — только сервера.
    if (!this.demo && this.pay) s.shop = this.pay.shopState(String(uid));
    return s;
  }

  fail(op, code) {
    return { t: 'col', op, error: { code, text: ERRORS[code] } };
  }

  /** Лимит 20/мин на человека по часам приложения; считаются и неверные запросы. */
  tooFast(uid) {
    const now = this.app.clock.now();
    for (const [id, times] of this.limits) if (!times.some((at) => now - at < MINUTE)) this.limits.delete(id);
    const times = (this.limits.get(uid) || []).filter((at) => now - at < MINUTE);
    if (times.length >= PER_MINUTE) return true;
    times.push(now);
    this.limits.set(uid, times);
    return false;
  }

  /**
   * @param user  `session.user` из подписанного initData — единственный источник «кто»
   * @param msg   тело: из него берутся только op, item, slot, color, req
   */
  handle(user, msg) {
    const uid = String(user.id);
    const op = typeof msg?.op === 'string' ? msg.op : '';
    const fail = (code) => this.fail(OPS.includes(op) ? op : 'state', code);
    if (this.tooFast(uid)) return fail('COL_FAST');
    if (!OPS.includes(op)) return fail('COL_OP');
    if (op === 'state') return this.stateOf(uid);
    if (op === 'grant' && !this.demo) return fail('COL_DEMO_OFF');
    if (!this.visibleFor(uid)) return fail('COL_OFF');
    if (!isReq(msg.req)) return fail('COL_OP');
    const store = this.app.store;
    const now = this.app.clock.now();
    // Повтор того же запроса: ничего не делаем, отвечаем тем, что есть сейчас.
    if (store.collReqSeen(uid, msg.req)) return this.answer(op, uid, msg.slot);

    if (op === 'grant') {
      const it = itemById(msg.item);
      if (!it) return fail('COL_ITEM');
      const items = it.kind === 'bundle' ? itemsOfBundle(it.id) : [it.id];
      for (const i of items) store.collDemoGrant(uid, i, now);
      store.collReqAdd(uid, msg.req, now, REQ_KEEP);
      return this.answer(op, uid, null);
    }

    if (!SLOTS.includes(msg.slot)) return fail('COL_SLOT');
    if (op === 'clear') {
      store.collChoiceClear(uid, msg.slot);
      store.collReqAdd(uid, msg.req, now, REQ_KEEP);
      this.changed(uid);
      return this.answer(op, uid, msg.slot);
    }
    // apply
    const it = itemById(msg.item);
    if (!it) return fail('COL_ITEM');
    if (slotOf(it.id) !== msg.slot) return fail('COL_SLOT');
    if (!isColor(msg.color)) return fail('COL_COLOR');
    if (!this.owns(uid, it.id)) return fail('COL_NOT_OWNED');
    store.collChoiceSet(uid, msg.slot, it.id, msg.color, now);
    store.collReqAdd(uid, msg.req, now, REQ_KEEP);
    this.changed(uid);
    return this.answer(op, uid, msg.slot);
  }

  answer(op, uid, slot) {
    const s = this.stateOf(uid);
    if (op === 'apply' || op === 'clear') s.when = SLOTS.includes(slot) && s.pending[slot] ? 'next-deal' : 'now';
    s.op = op;
    return s;
  }

  /**
   * Выбор сменился: лобби, где человек сидит, перерисовать сразу; идущие раздачи не трогаем
   * (снимок заморожен). Хозяйство лобби: стол — выбор хоста, рамки и рубашки — каждого.
   */
  changed(uid) {
    for (const room of this.app.rooms.values()) {
      if (!this.supported(room) || room.status !== 'lobby') continue;
      if (!room.players.some((p) => p.id === String(uid) && !p.bot && !p.left && !p.kicked)) continue;
      this.app.draw(room);
    }
  }
}
