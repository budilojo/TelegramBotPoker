/**
 * payments: таблицы покупок в той же SQLite. ДОБАВЛЕНЫ без смены версии схемы (как collection_*): старый код
 * их не замечает. Но старый код и не обрабатывает оплаты — порядок отката: payment-design.md, раздел 11.
 *
 * Никаких имён: только id Telegram (число строкой), суммы, время. Токен и initData сюда не попадают.
 * Все изменения, связанные с одной оплатой или возвратом, — в одной транзакции; сети внутри транзакции нет.
 */
export const PAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS pay_order (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  item       TEXT NOT NULL,
  items      TEXT NOT NULL,
  price      INTEGER NOT NULL CHECK (price > 0),
  currency   TEXT NOT NULL CHECK (currency = 'XTR'),
  terms      TEXT NOT NULL,
  mode       TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  state      TEXT NOT NULL,
  req        TEXT,
  link       TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pay_order_by_user ON pay_order (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS pay_payment (
  charge_id   TEXT PRIMARY KEY,
  order_id    TEXT,
  user_id     TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  currency    TEXT NOT NULL,
  payload     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('order', 'mismatch', 'duplicate', 'orphan')),
  source      TEXT NOT NULL,
  provider_id TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pay_payment_by_order ON pay_payment (order_id);
CREATE TABLE IF NOT EXISTS pay_entitlement (
  order_id   TEXT NOT NULL,
  item       TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (order_id, item)
);
CREATE INDEX IF NOT EXISTS pay_entitlement_by_user ON pay_entitlement (user_id);
CREATE TABLE IF NOT EXISTS pay_refund (
  charge_id  TEXT PRIMARY KEY,
  order_id   TEXT,
  user_id    TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  by         TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  done_at    INTEGER,
  note       TEXT
);
-- Магазин в админке (шаг H): цена и видимость поверх offers.json, выдача админом, журнал, повторы нажатий.
CREATE TABLE IF NOT EXISTS shop_offer (
  item       TEXT PRIMARY KEY,
  price      INTEGER CHECK (price IS NULL OR (price >= 1 AND price <= 10000)),
  hidden     INTEGER NOT NULL DEFAULT 0,
  by         TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shop_grant (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  item       TEXT NOT NULL,
  by         TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT
);
CREATE INDEX IF NOT EXISTS shop_grant_by_user ON shop_grant (user_id);
CREATE TABLE IF NOT EXISTS shop_admin_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  by      TEXT NOT NULL,
  event   TEXT NOT NULL,
  user_id TEXT,
  item    TEXT,
  before  TEXT,
  after   TEXT
);
CREATE TABLE IF NOT EXISTS shop_admin_req (
  admin TEXT NOT NULL,
  req   TEXT NOT NULL,
  at    INTEGER NOT NULL,
  PRIMARY KEY (admin, req)
);
CREATE TABLE IF NOT EXISTS pay_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  event    TEXT NOT NULL,
  order_id TEXT,
  user_id  TEXT,
  amount   INTEGER,
  note     TEXT
);
`;

const orderRow = (r) => r && ({
  id: r.id, userId: r.user_id, item: r.item, items: JSON.parse(r.items), price: r.price, currency: r.currency,
  terms: r.terms, mode: r.mode, state: r.state, req: r.req, link: r.link,
  createdAt: r.created_at, expiresAt: r.expires_at, updatedAt: r.updated_at,
});
const payRow = (r) => r && ({
  chargeId: r.charge_id, orderId: r.order_id, userId: r.user_id, amount: r.amount, currency: r.currency,
  payload: r.payload, kind: r.kind, source: r.source, at: r.at,
});
const refundRow = (r) => r && ({
  chargeId: r.charge_id, orderId: r.order_id, userId: r.user_id, amount: r.amount, state: r.state, by: r.by,
  attempts: r.attempts, createdAt: r.created_at, doneAt: r.done_at, note: r.note,
});

export class PayStore {
  /** @param db  DatabaseSync (та же база, что у Store; в тестах — своя в памяти) */
  constructor(db) {
    this.db = db;
    this.db.exec(PAY_SCHEMA);
    this.depth = 0;
  }

  /** Транзакция: всё или ничего. Внутри — только база, никакой сети. */
  tx(fn) {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* уже откатилась */ }
      throw err;
    } finally {
      this.depth--;
    }
  }

  /* ---------------------------------------------------------------- заказы */
  addOrder(o) {
    this.db.prepare(`INSERT INTO pay_order (id, user_id, item, items, price, currency, terms, mode, state, req, link, created_at, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'XTR', ?, ?, 'created', ?, NULL, ?, ?, ?)`)
      .run(o.id, String(o.userId), o.item, JSON.stringify(o.items), o.price, o.terms, o.mode, o.req ?? null, o.at, o.expiresAt, o.at);
    return this.order(o.id);
  }
  order(id) {
    return orderRow(this.db.prepare('SELECT * FROM pay_order WHERE id = ?').get(String(id)));
  }
  orderByReq(userId, req) {
    return orderRow(this.db.prepare('SELECT * FROM pay_order WHERE user_id = ? AND req = ?').get(String(userId), String(req)));
  }
  setOrderLink(id, link, at) {
    this.db.prepare('UPDATE pay_order SET link = ?, updated_at = ? WHERE id = ?').run(link, at, id);
  }
  /** Сменить состояние только из ожидаемого; вернуть, получилось ли. */
  moveOrder(id, from, to, at) {
    const r = this.db.prepare(`UPDATE pay_order SET state = ?, updated_at = ? WHERE id = ? AND state IN (${from.map(() => '?').join(',')})`)
      .run(to, at, id, ...from);
    return r.changes === 1;
  }
  /** Живые (неоплаченные, не истёкшие) заказы человека. */
  liveOrders(userId, now) {
    return this.db.prepare("SELECT * FROM pay_order WHERE user_id = ? AND state IN ('created', 'approved') AND expires_at > ?")
      .all(String(userId), now).map(orderRow);
  }
  ordersOf(userId, limit = 50) {
    return this.db.prepare('SELECT * FROM pay_order WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(String(userId), limit).map(orderRow);
  }
  recentOrders(limit = 20) {
    return this.db.prepare('SELECT * FROM pay_order ORDER BY created_at DESC LIMIT ?').all(limit).map(orderRow);
  }
  /** «В пути»: pre_checkout подтверждён, оплаты ещё нет. Перед откатом их должно быть 0. */
  inFlight(now) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM pay_order WHERE state = 'approved' AND expires_at > ?").get(now).n;
  }

  /* ---------------------------------------------------------------- платежи */
  payment(chargeId) {
    return payRow(this.db.prepare('SELECT * FROM pay_payment WHERE charge_id = ?').get(String(chargeId)));
  }
  paymentsOfOrder(orderId) {
    return this.db.prepare('SELECT * FROM pay_payment WHERE order_id = ? ORDER BY at').all(String(orderId)).map(payRow);
  }
  addPayment(p) {
    this.db.prepare(`INSERT INTO pay_payment (charge_id, order_id, user_id, amount, currency, payload, kind, source, provider_id, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.chargeId, p.orderId ?? null, String(p.userId), p.amount, p.currency, p.payload, p.kind, p.source, p.providerId ?? null, p.at);
  }
  paymentsToReview() {
    return this.db.prepare(`SELECT p.* FROM pay_payment p LEFT JOIN pay_refund r ON r.charge_id = p.charge_id
      WHERE p.kind != 'order' AND (r.state IS NULL OR r.state != 'done') ORDER BY p.at`).all().map(payRow);
  }

  /* -------------------------------------------------------------- права */
  grant(orderId, items, userId, at) {
    const q = this.db.prepare('INSERT OR IGNORE INTO pay_entitlement (order_id, item, user_id, granted_at) VALUES (?, ?, ?, ?)');
    for (const it of items) q.run(orderId, it, String(userId), at);
  }
  revokeOrder(orderId, at) {
    this.db.prepare('UPDATE pay_entitlement SET revoked_at = ? WHERE order_id = ? AND revoked_at IS NULL').run(at, orderId);
  }
  /** Купленные и не отозванные вещи человека. */
  ownedItems(userId) {
    return this.db.prepare('SELECT DISTINCT item FROM pay_entitlement WHERE user_id = ? AND revoked_at IS NULL ORDER BY item')
      .all(String(userId)).map((r) => r.item);
  }
  hasAnyOrder(userId) {
    return !!this.db.prepare("SELECT 1 FROM pay_order WHERE user_id = ? AND state IN ('paid', 'refunded') LIMIT 1").get(String(userId))
      || !!this.db.prepare('SELECT 1 FROM pay_payment WHERE user_id = ? LIMIT 1').get(String(userId));
  }

  /* ------------------------------------------------------------- возвраты */
  refund(chargeId) {
    return refundRow(this.db.prepare('SELECT * FROM pay_refund WHERE charge_id = ?').get(String(chargeId)));
  }
  addRefund(r) {
    this.db.prepare(`INSERT INTO pay_refund (charge_id, order_id, user_id, amount, state, by, attempts, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, 0, ?)`).run(r.chargeId, r.orderId ?? null, String(r.userId), r.amount, String(r.by), r.at);
  }
  refundAttempt(chargeId, note) {
    this.db.prepare('UPDATE pay_refund SET attempts = attempts + 1, note = ? WHERE charge_id = ?').run(note ?? null, chargeId);
  }
  refundDone(chargeId, at, note) {
    return this.db.prepare("UPDATE pay_refund SET state = 'done', done_at = ?, note = COALESCE(?, note) WHERE charge_id = ? AND state = 'pending'")
      .run(at, note ?? null, chargeId).changes === 1;
  }
  pendingRefunds() {
    return this.db.prepare("SELECT * FROM pay_refund WHERE state = 'pending' ORDER BY created_at").all().map(refundRow);
  }

  /* ---------------------------------------------------------------- журнал */
  log(at, event, { orderId = null, userId = null, amount = null, note = null } = {}) {
    this.db.prepare('INSERT INTO pay_log (at, event, order_id, user_id, amount, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(at, event, orderId, userId == null ? null : String(userId), amount, note == null ? null : String(note).slice(0, 300));
  }
  logs(limit = 50) {
    return this.db.prepare('SELECT * FROM pay_log ORDER BY id DESC LIMIT ?').all(limit);
  }

  /** Были ли вообще заказы — без них сверку при запуске не делаем (бот без продаж ведёт себя как раньше). */
  anyOrders() {
    return !!this.db.prepare('SELECT 1 FROM pay_order LIMIT 1').get();
  }

  /* ------------------------------------------------- магазин в админке (H) */

  /** Переопределения владельца: item → { price|null, hidden }. */
  offerOverrides() {
    const out = {};
    for (const r of this.db.prepare('SELECT * FROM shop_offer').all()) out[r.item] = { price: r.price, hidden: r.hidden === 1, by: r.by, at: r.updated_at };
    return out;
  }
  setOfferPrice(item, price, by, at) {
    this.db.prepare(`INSERT INTO shop_offer (item, price, hidden, by, updated_at) VALUES (?, ?, 0, ?, ?)
      ON CONFLICT(item) DO UPDATE SET price = excluded.price, by = excluded.by, updated_at = excluded.updated_at`).run(item, price, String(by), at);
  }
  setOfferHidden(item, hidden, by, at) {
    this.db.prepare(`INSERT INTO shop_offer (item, price, hidden, by, updated_at) VALUES (?, NULL, ?, ?, ?)
      ON CONFLICT(item) DO UPDATE SET hidden = excluded.hidden, by = excluded.by, updated_at = excluded.updated_at`).run(item, hidden ? 1 : 0, String(by), at);
  }
  /** Утверждение цен владельцем в админке: true / false / null (не трогали — как в offers.json). */
  approvedOverride() {
    const v = this.db.prepare("SELECT value FROM meta WHERE key = 'offers_approved'").get()?.value;
    return v === '1' ? true : v === '0' ? false : null;
  }
  setApproved(on) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('offers_approved', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? '1' : '0');
  }

  /** Выдать админом (если уже выдано и не забрано — ничего). Вернуть, выдано ли сейчас. */
  adminGrant(userId, item, by, at) {
    if (this.db.prepare('SELECT 1 FROM shop_grant WHERE user_id = ? AND item = ? AND revoked_at IS NULL').get(String(userId), item)) return false;
    this.db.prepare('INSERT INTO shop_grant (user_id, item, by, granted_at) VALUES (?, ?, ?, ?)').run(String(userId), item, String(by), at);
    return true;
  }
  /** Забрать выданное админом. Купленное не трогает. Вернуть, было ли что забирать. */
  adminRevoke(userId, item, by, at) {
    return this.db.prepare('UPDATE shop_grant SET revoked_at = ?, revoked_by = ? WHERE user_id = ? AND item = ? AND revoked_at IS NULL')
      .run(at, String(by), String(userId), item).changes > 0;
  }
  /** Выданные админом и не забранные вещи человека. */
  adminItems(userId) {
    return this.db.prepare('SELECT DISTINCT item FROM shop_grant WHERE user_id = ? AND revoked_at IS NULL ORDER BY item').all(String(userId)).map((r) => r.item);
  }
  adminGrantsOf(userId) {
    return this.db.prepare('SELECT * FROM shop_grant WHERE user_id = ? AND revoked_at IS NULL ORDER BY granted_at DESC').all(String(userId))
      .map((r) => ({ id: r.id, item: r.item, by: r.by, at: r.granted_at }));
  }
  hasAdminGrant(userId) {
    return !!this.db.prepare('SELECT 1 FROM shop_grant WHERE user_id = ? AND revoked_at IS NULL LIMIT 1').get(String(userId));
  }
  adminLog(at, by, event, { userId = null, item = null, before = null, after = null } = {}) {
    const s = (x) => (x == null ? null : String(x).slice(0, 120));
    this.db.prepare('INSERT INTO shop_admin_log (at, by, event, user_id, item, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(at, String(by), event, userId == null ? null : String(userId), item, s(before), s(after));
  }
  adminLogs(limit = 30) {
    return this.db.prepare('SELECT * FROM shop_admin_log ORDER BY id DESC LIMIT ?').all(limit)
      .map((r) => ({ at: r.at, by: r.by, event: r.event, userId: r.user_id, item: r.item, before: r.before, after: r.after }));
  }
  /** Запомнить нажатие; false — такое уже было (повтор). Старше суток — забываем. */
  adminReq(admin, req, at) {
    this.db.prepare('DELETE FROM shop_admin_req WHERE at < ?').run(at - 86_400_000);
    return this.db.prepare('INSERT OR IGNORE INTO shop_admin_req (admin, req, at) VALUES (?, ?, ?)').run(String(admin), String(req), at).changes === 1;
  }
  /** Поиск заказов: по id игрока или по началу номера заказа. */
  findOrders(q, limit = 30) {
    const s = String(q || '').trim();
    if (!s) return this.recentOrders(limit);
    const asUser = /^\d{1,20}$/.test(s) ? s : null;
    const asOrder = /^[0-9a-f]{3,16}$/.test(s) ? `${s}%` : null;
    if (!asUser && !asOrder) return [];
    return this.db.prepare('SELECT * FROM pay_order WHERE user_id = ? OR id LIKE ? ORDER BY created_at DESC LIMIT ?')
      .all(asUser ?? '', asOrder ?? '\u0000', limit).map(orderRow);
  }

  /* -------------------------------------------------------------- выключатель */
  stopped() {
    return this.db.prepare("SELECT value FROM meta WHERE key = 'sales_stop'").get()?.value === '1';
  }
  setStopped(on) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('sales_stop', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? '1' : '0');
  }
}
