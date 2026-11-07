/** Server-owned cosmetics: choices are private, room snapshots are public decorations only. */
import { ERRORS, OPS, PER_MINUTE, isReq, REQ_KEEP } from '../../miniapp/collections/protocol.js';
import { ITEMS, SLOTS, LEGACY_SLOTS, BASE, isItemColor, itemById, itemsOfBundle, slotOf, publicEntry } from '../../miniapp/collections/catalog.js';

const GAMES = new Set(['poker', 'durak', 'colors', 'chess', 'checkers', 'nardy', 'battleship']);
export const BOARD_SLOT = { chess: 'chess-board', checkers: 'checkers-board', nardy: 'nardy-board', battleship: 'battleship-panel' };
export const dealNoOf = (room) => (room.game === 'poker' ? room.handNo : room.gameNo) || 0;
const emptySlots = (v = 2) => Object.fromEntries((v === 2 ? SLOTS : LEGACY_SLOTS).map((s) => [s, null]));
const same = (a, b) => (a?.item ?? null) === (b?.item ?? null) && (a?.color ?? null) === (b?.color ?? null);

export class Collections {
  constructor(app, { demo = false, shopEnabled = true } = {}) { this.app = app; this.demo = demo === true; this.shopEnabled = shopEnabled; this.limits = new Map(); }
  get enabled() { return true; }
  get pay() { return this.app.payments ?? null; }
  visibleFor() { return true; }

  sourcesOf(uid) {
    const u = String(uid), out = new Map();
    const add = (id, source) => {
      if (itemById(id)?.kind !== 'item') return;
      if (!out.has(id)) out.set(id, new Set());
      out.get(id).add(source);
    };
    for (const i of this.app.store.pay?.ownedItems(u) ?? []) add(i, 'purchase');
    for (const i of this.app.store.pay?.adminItems(u) ?? []) add(i, 'admin');
    // Old staff access never expands to the new assortment. Owner is computed, never a purchase.
    if (this.pay?.staffOwns(u)) for (const it of ITEMS.filter((i) => !i.collection)) add(it.id, 'staff');
    if (this.app.isAdmin(u)) for (const it of ITEMS.filter((i) => i.collection)) add(it.id, 'owner');
    if (this.demo) for (const i of this.app.store.collDemoItems?.(u) ?? []) add(i, 'demo');
    return out;
  }
  ownedItems(uid) { return [...this.sourcesOf(uid).keys()]; }
  owns(uid, item) { return this.sourcesOf(uid).has(item); }
  choiceOf(uid) {
    const out = emptySlots(), owned = new Set(this.ownedItems(uid));
    for (const r of this.app.store.collChoices?.(String(uid)) ?? []) {
      if (!SLOTS.includes(r.slot)) continue;
      if (['frame', 'badge'].includes(r.slot) && r.item === BASE[r.slot].id && r.color === 'classic') {
        out[r.slot] = { item: r.item, color: r.color }; continue;
      }
      const e = publicEntry(r, r.slot);
      if (e && owned.has(e.item)) out[r.slot] = e;
    }
    return out;
  }
  personal(choice, slot) {
    return choice[slot] ? publicEntry(choice[slot], slot) : choice.profile;
  }
  dropUnowned(uid) {
    const owned = new Set(this.ownedItems(uid));
    for (const r of this.app.store.collChoices?.(String(uid)) ?? []) {
      // Unknown rows and explicit classic overrides survive rollback/new-version round trips.
      if (SLOTS.includes(r.slot) && itemById(r.item)?.slot === r.slot && !owned.has(r.item)) this.app.store.collChoiceClear(String(uid), r.slot);
    }
  }
  pushState(uid) {
    try { this.app.hub?.sendToUser?.(String(uid), () => this.stateOf(uid)); } catch (err) { this.app.log(err); }
  }
  pushAll() {
    try { this.app.hub?.sendToAll?.((uid) => this.stateOf(uid)); } catch (err) { this.app.log(err); }
  }
  fits(id, room) { return !!itemById(id)?.games.includes(room.game); }
  supported(room) { return !!room && GAMES.has(room.game) && room.status !== undefined; }
  build(room, dealNo) {
    const c = this.choiceOf(room.hostId), backs = {}, frames = {}, badges = {};
    const fit = (e) => e && this.fits(e.item, room) ? e : null;
    for (const p of room.players.filter((p) => !p.bot && !p.left && !p.kicked)) {
      const own = this.choiceOf(p.id);
      if (room.game === 'poker' && own.cardback) backs[p.id] = own.cardback;
      const frame = this.personal(own, 'frame'), badge = this.personal(own, 'badge');
      // The old paired Graphit profile keeps its original two-game scope.
      if (frame && (itemById(frame.item)?.collection || ['poker', 'durak'].includes(room.game))) frames[p.id] = frame;
      if (badge && itemById(badge.item)?.collection) badges[p.id] = badge;
    }
    return { v: 2, table: fit(c.table), board: fit(c[BOARD_SLOT[room.game]]), deckBack: fit(c['unoq-cardback']), backs, frames, badges, dealNo, hostId: room.hostId };
  }
  freeze(room) { if (this.supported(room)) room.look = this.build(room, dealNoOf(room)); }
  settle(room) {
    if (!this.supported(room)) return;
    if (room.status === 'lobby') { room.look = this.build(room, 0); return; }
    // Preserve unknown versions as classic. Never replace a v1 live hand mid-deal.
    if (!room.look || room.look.dealNo !== dealNoOf(room)) this.freeze(room);
    const l = room.look;
    if (![1, 2].includes(l?.v)) return;
    const valid = (uid, e) => e && this.owns(uid, e.item) ? e : null;
    const host = l.hostId ?? room.hostId;
    for (const key of ['table', 'board', 'deckBack']) if (l[key]) l[key] = valid(host, l[key]);
    for (const key of ['backs', 'frames', 'badges']) for (const uid of Object.keys(l[key] ?? {})) {
      if (!valid(uid, l[key][uid])) delete l[key][uid];
    }
  }
  pendingOf(uid) {
    const out = emptySlots(), mine = this.choiceOf(uid);
    for (const room of this.app.rooms.values()) {
      if (!this.supported(room) || ['lobby', 'finished'].includes(room.status) || !room.look) continue;
      const me = room.players.find((p) => p.id === String(uid) && !p.bot && !p.left && !p.kicked);
      if (!me) continue;
      const l = room.look;
      if (room.game === 'poker' && !same(mine.cardback, l.backs?.[me.id])) out.cardback = 'next-deal';
      for (const [slot, key] of [['frame', 'frames'], ['badge', 'badges']]) {
        if (!same(this.personal(mine, slot), l[key]?.[me.id])) out[slot] = 'next-deal';
      }
      if (!same(mine.profile, l.frames?.[me.id])) out.profile = 'next-deal';
      if (room.hostId === me.id) for (const [slot, key] of [['table', 'table'], [BOARD_SLOT[room.game], 'board'], ['unoq-cardback', 'deckBack']]) {
        if (slot && mine[slot] && !this.fits(mine[slot].item, room)) continue;
        if (slot && !same(mine[slot], l[key])) out[slot] = 'next-deal';
      }
    }
    return out;
  }
  stateOf(uid, v = 2) {
    const legacy = v !== 2, choice = this.choiceOf(uid), pending = this.pendingOf(uid);
    const s = { t: 'col', op: 'state', v: legacy ? 1 : 2, enabled: true, demo: this.demo, shopEnabled: this.shopEnabled,
      owned: [...this.sourcesOf(uid)].filter(([id]) => !legacy || !itemById(id).collection).map(([item, from]) => (this.demo && legacy ? { item, demo: from.size === 1 && from.has('demo') } : { item, demo: this.demo && from.size === 1 && from.has('demo'), source: [...from].sort() })),
      choice: emptySlots(v), pending: emptySlots(v) };
    for (const slot of Object.keys(s.choice)) {
      s.choice[slot] = choice[slot]?.color === 'classic' || (legacy && itemById(choice[slot]?.item)?.collection) ? null : choice[slot];
      s.pending[slot] = pending[slot];
    }
    if (!legacy) s.appearance = { frame: this.personal(choice, 'frame'), badge: publicEntry(choice.badge, 'badge') };
    if (!this.demo && this.pay) {
      s.shop = this.pay.shopState(String(uid));
      if (legacy) s.shop.offers = Object.fromEntries(Object.entries(s.shop.offers).filter(([id]) => !itemById(id)?.collection));
    }
    return s;
  }
  fail(op, code) { return { t: 'col', op, error: { code, text: ERRORS[code] } }; }
  tooFast(uid) {
    const now = this.app.clock.now();
    for (const [id, ts] of this.limits) if (!ts.some((at) => now - at < 60_000)) this.limits.delete(id);
    const ts = (this.limits.get(uid) || []).filter((at) => now - at < 60_000);
    if (ts.length >= PER_MINUTE) return true;
    ts.push(now); this.limits.set(uid, ts); return false;
  }
  handle(user, msg) {
    const uid = String(user.id), op = typeof msg?.op === 'string' ? msg.op : '', v = msg.v === 2 ? 2 : 1;
    const fail = (code) => this.fail(OPS.includes(op) ? op : 'state', code);
    if (this.tooFast(uid)) return fail('COL_FAST');
    if (!OPS.includes(op)) return fail('COL_OP');
    if (op === 'state') return this.stateOf(uid, v);
    if (op === 'grant' && !this.demo) return fail('COL_DEMO_OFF');
    if (!isReq(msg.req)) return fail('COL_OP');
    if (v === 1 && (op === 'apply-bundle' || itemById(msg.item)?.collection || (SLOTS.includes(msg.slot) && !LEGACY_SLOTS.includes(msg.slot)))) return fail('COL_STALE');
    // Addressed room updates are never authorized through a personal-choice packet.
    if (msg.room || msg.code) return fail('COL_OP');
    const store = this.app.store, now = this.app.clock.now();
    if (store.collReqSeen(uid, msg.req)) return this.answer(op, uid, msg.slot, v);
    if (op === 'grant') {
      const it = itemById(msg.item);
      if (!it) return fail('COL_ITEM');
      for (const id of it.kind === 'bundle' ? itemsOfBundle(it.id) : [it.id]) store.collDemoGrant(uid, id, now);
      store.collReqAdd(uid, msg.req, now, REQ_KEEP);
      return this.answer(op, uid, null, v);
    }
    if (op === 'apply-bundle') {
      const ids = itemsOfBundle(msg.item);
      if (!ids.length) return fail('COL_ITEM');
      const rows = ids.map((id) => ({ slot: slotOf(id), item: id, color: itemById(id).collection ? 'default' : msg.color }));
      if (rows.some((r) => !isItemColor(r.item, r.color))) return fail('COL_COLOR');
      if (rows.some((r) => !this.owns(uid, r.item))) return fail('COL_NOT_OWNED');
      store.collApply(uid, rows, msg.req, now, REQ_KEEP);
    } else {
      if (!SLOTS.includes(msg.slot)) return fail('COL_SLOT');
      if (op === 'clear') {
        const rows = ['frame', 'badge'].includes(msg.slot) ? [{ slot: msg.slot, item: BASE[msg.slot].id, color: 'classic' }] : [{ slot: msg.slot, clear: true }];
        store.collApply(uid, rows, msg.req, now, REQ_KEEP);
      } else {
        const it = itemById(msg.item);
        if (!it) return fail('COL_ITEM');
        if (slotOf(it.id) !== msg.slot) return fail('COL_SLOT');
        if (!isItemColor(it.id, msg.color)) return fail('COL_COLOR');
        if (msg.game && !it.games.includes(msg.game)) return fail('COL_SLOT');
        if (!this.owns(uid, it.id)) return fail('COL_NOT_OWNED');
        store.collApply(uid, [{ slot: msg.slot, item: it.id, color: msg.color }], msg.req, now, REQ_KEEP);
      }
    }
    this.changed(uid);
    return this.answer(op, uid, msg.slot, v);
  }
  answer(op, uid, slot, v = 2) {
    const s = this.stateOf(uid, v);
    if (['apply', 'clear', 'apply-bundle'].includes(op)) s.when = (op === 'apply-bundle' ? Object.values(s.pending).some(Boolean) : s.pending[slot]) ? 'next-deal' : 'now';
    s.op = op; return s;
  }
  changed(uid) {
    for (const room of this.app.rooms.values()) {
      if (this.supported(room) && room.players.some((p) => p.id === String(uid))) this.app.draw(room);
    }
  }
}
