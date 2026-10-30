'use strict';
/**
 * Поддержка внутри бота: игрок пишет боту в личку — обращение уходит владельцу (ADMINS);
 * владелец отвечает ответом на сообщение (reply) или `/reply <№> текст` — игроку приходит «Поддержка: …».
 *
 * Правила:
 *  - личность — только из Telegram (`from.id` самого сообщения); id и номера из текста игрока ничего не значат;
 *  - отвечать и управлять может только тот, кто в ADMINS; остальным эти команды неизвестны (бот молчит о них);
 *  - игрок видит только свою переписку: ответ уходит тому, чей это номер обращения, и больше никому;
 *  - личные данные игрока не подтягиваются: владельцу уходит номер, id и текст;
 *  - таблицы свои (`CREATE TABLE IF NOT EXISTS`) в той же базе — старый код их не трогает.
 */
import { esc } from './fmt.js';

export const SUPPORT_LIMITS = Object.freeze({ perMinute: 5, perDay: 20, maxLen: 2000, retentionMonths: 12, modeMs: 30 * 60_000 });
const MINUTE = 60_000;
const DAY = 86_400_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS support_ticket (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS support_ticket_user ON support_ticket (user_id, state);
CREATE TABLE IF NOT EXISTS support_msg (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  dir       TEXT NOT NULL,
  text      TEXT NOT NULL,
  flagged   INTEGER NOT NULL DEFAULT 0,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS support_msg_ticket ON support_msg (ticket_id);
CREATE TABLE IF NOT EXISTS support_user (
  user_id    TEXT PRIMARY KEY,
  blocked    INTEGER NOT NULL DEFAULT 0,
  mode_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS support_reply (
  owner_id   TEXT NOT NULL,
  owner_msg  TEXT NOT NULL,
  ticket_id  INTEGER NOT NULL,
  state      TEXT NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (owner_id, owner_msg)
);
`;

/** Хранилище: только база, без сети. */
export class SupportStore {
  constructor(db) {
    this.db = db;
    db.exec(SCHEMA);
  }
  userRow(uid) {
    return this.db.prepare('SELECT * FROM support_user WHERE user_id = ?').get(String(uid)) || { user_id: String(uid), blocked: 0, mode_until: 0 };
  }
  isBlocked(uid) { return !!this.userRow(uid).blocked; }
  setBlocked(uid, on) {
    this.db.prepare('INSERT INTO support_user (user_id, blocked) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET blocked = excluded.blocked')
      .run(String(uid), on ? 1 : 0);
  }
  setMode(uid, until) {
    this.db.prepare('INSERT INTO support_user (user_id, mode_until) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET mode_until = excluded.mode_until')
      .run(String(uid), until);
  }
  modeUntil(uid) { return this.userRow(uid).mode_until; }
  ticket(id) { return this.db.prepare('SELECT * FROM support_ticket WHERE id = ?').get(Number(id)) || null; }
  openOf(uid) {
    return this.db.prepare("SELECT * FROM support_ticket WHERE user_id = ? AND state = 'open' ORDER BY id DESC LIMIT 1").get(String(uid)) || null;
  }
  open(uid, at) {
    return Number(this.db.prepare("INSERT INTO support_ticket (user_id, state, created_at, updated_at) VALUES (?, 'open', ?, ?)").run(String(uid), at, at).lastInsertRowid);
  }
  touch(id, at) { this.db.prepare('UPDATE support_ticket SET updated_at = ? WHERE id = ?').run(at, Number(id)); }
  close(id, at) {
    return this.db.prepare("UPDATE support_ticket SET state = 'closed', updated_at = ? WHERE id = ? AND state = 'open'").run(at, Number(id)).changes === 1;
  }
  addMsg(ticketId, dir, text, flagged, at) {
    this.db.prepare('INSERT INTO support_msg (ticket_id, dir, text, flagged, at) VALUES (?, ?, ?, ?, ?)').run(Number(ticketId), dir, text, flagged ? 1 : 0, at);
  }
  msgs(ticketId) { return this.db.prepare('SELECT * FROM support_msg WHERE ticket_id = ? ORDER BY id').all(Number(ticketId)); }
  /** Сколько обращений человек прислал за последние `ms`. */
  countIn(uid, since) {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM support_msg m JOIN support_ticket t ON t.id = m.ticket_id
      WHERE t.user_id = ? AND m.dir = 'in' AND m.at > ?`).get(String(uid), since).n;
  }
  openList(limit = 30) {
    return this.db.prepare("SELECT * FROM support_ticket WHERE state = 'open' ORDER BY id LIMIT ?").all(limit);
  }
  /** Отметка «этот ответ владельца уже обработан»: второй раз тот же reply ничего не отправит. */
  claimReply(ownerId, ownerMsg, ticketId, at) {
    return this.db.prepare("INSERT OR IGNORE INTO support_reply (owner_id, owner_msg, ticket_id, state, at) VALUES (?, ?, ?, 'sending', ?)")
      .run(String(ownerId), String(ownerMsg), Number(ticketId), at).changes === 1;
  }
  finishReply(ownerId, ownerMsg, state) {
    this.db.prepare('UPDATE support_reply SET state = ? WHERE owner_id = ? AND owner_msg = ?').run(state, String(ownerId), String(ownerMsg));
  }
  /** Срок хранения: старше `months` месяцев закрытые обращения стираются вместе с текстами. */
  purge(now, months = SUPPORT_LIMITS.retentionMonths) {
    const cut = now - months * 30 * DAY;
    const old = this.db.prepare("SELECT id FROM support_ticket WHERE state = 'closed' AND updated_at < ?").all(cut).map((r) => r.id);
    for (const id of old) this.eraseTicket(id);
    return old.length;
  }
  eraseTicket(id) {
    this.db.prepare('DELETE FROM support_msg WHERE ticket_id = ?').run(Number(id));
    this.db.prepare('DELETE FROM support_reply WHERE ticket_id = ?').run(Number(id));
    this.db.prepare('DELETE FROM support_ticket WHERE id = ?').run(Number(id));
  }
  /** «Удалить по запросу»: все обращения одного человека. */
  eraseUser(uid) {
    const ids = this.db.prepare('SELECT id FROM support_ticket WHERE user_id = ?').all(String(uid)).map((r) => r.id);
    for (const id of ids) this.eraseTicket(id);
    return ids.length;
  }
}

/* ---------------------------------------------------------------- тексты */

export const SUP = {
  greet: '🛟 <b>Поддержка</b>\nНапишите вопрос одним сообщением. Пароли, коды из СМС и данные карты не присылайте — они нам не нужны.',
  accepted: (n) => `✅ Обращение №${n} передано. Ответ придёт сюда, от имени бота.`,
  added: (n) => `✅ Дополнение к обращению №${n} передано.`,
  textOnly: 'Пока только текст: фото, файлы и голосовые сюда не принимаются. Опишите словами.',
  tooLong: (max) => `Слишком длинно: не больше ${max} знаков. Сократите и отправьте ещё раз.`,
  empty: 'Пустое сообщение. Напишите вопрос текстом.',
  fast: 'Слишком часто: не больше 5 сообщений в минуту. Подождите немного.',
  daily: 'На сегодня лимит обращений исчерпан (20 в сутки). Напишите завтра или дополните уже отправленное.',
  blocked: 'Сообщения в поддержку от вас сейчас не принимаются.',
  secret: '⚠️ В сообщении похоже на пароль, код или токен. Я скрыл это место: поддержка никогда не просит такие данные, и присылать их не нужно. Если это был настоящий пароль или код — смените его.',
  reply: (text) => `💬 <b>Поддержка:</b> ${esc(text)}`,
  closeBtn: '✖ Закрыть обращение',
  openBtn: '✍️ Написать в поддержку',
  closed: (n) => `Обращение №${n} закрыто. Если вопрос появится снова — просто напишите.`,
  closedByOwner: (n) => `Обращение №${n} закрыто поддержкой. Если вопрос остался — напишите, откроется новое.`,
  notYours: 'Это не ваше обращение.',
  off: 'Поддержка сейчас недоступна: некому ответить. Попробуйте позже.',
};

/** Кнопка под приветствием и ответом: закрыть своё обращение. */
export const closeKb = (n) => [[{ text: SUP.closeBtn, callback_data: `sup:c:${n}` }]];
export const OPEN_KB = [[{ text: SUP.openBtn, callback_data: 'sup:open' }]];
export const SUPPORT_LINK = (bot) => `https://t.me/${bot}?start=support`;

/**
 * Похоже ли на секрет: токен бота, «пароль: …», «код: 123456», длинная случайная строка, номер карты.
 * Совпавшее место заменяется на «••••» — в базу и владельцу уходит уже скрытый текст.
 */
const SECRET_RES = [
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, // токен бота
  /(?:пароль|парол[июе]|password|passwd|pwd|pass|пин|pin|cvv|cvc|секрет\w*|seed|токен|token)\s*(?:[:=\-—]|это|is)?\s*\S+/giu,
  /(?:код(?:\s+(?:из|входа|подтверждения|смс|sms))*|code|otp)\s*(?:[:=\-—]|это|is)?\s*\d[\d\s-]{3,10}\d/giu,
  /\b(?:\d[ -]?){13,19}\b/g, // номер карты
  /\b[A-Za-z0-9+/_-]{40,}\b/g, // длинная случайная строка (ключи)
];
export function scrub(text) {
  let out = String(text);
  let flagged = false;
  for (const re of SECRET_RES) {
    out = out.replace(re, () => { flagged = true; return '••••'; });
  }
  return { text: out, flagged };
}

/* ----------------------------------------------------------------- логика */

export class Support {
  /** @param app  App: хранилище, часы, outbox, список ADMINS */
  constructor(app) {
    this.app = app;
  }
  get store() { return this.app.store.support; }
  get enabled() { return this.app.admins.size > 0; }
  now() { return this.app.clock.now(); }

  /* ------------------------------------------------------------- игрок */

  /** Игрок открыл режим обращения (ссылка ?start=support, кнопка, /support). */
  async enter(user) {
    if (this.store.isBlocked(user.id)) return void (await this.app.outbox.post(user.tgId, SUP.blocked));
    if (!this.enabled) return void (await this.app.outbox.post(user.tgId, SUP.off));
    this.store.setMode(user.id, this.now() + SUPPORT_LIMITS.modeMs);
    const open = this.store.openOf(user.id);
    await this.app.outbox.post(user.tgId, SUP.greet, open ? closeKb(open.id) : null);
  }

  /** Находится ли человек в режиме обращения: ссылка нажата недавно или есть открытое обращение. */
  inMode(uid) {
    return this.store.modeUntil(uid) > this.now() || !!this.store.openOf(uid);
  }

  /** Сообщение игрока в личку (не команда). Возвращает true, если это было обращение. */
  async intake(user, msg) {
    if (!this.enabled) return false;
    if (this.store.isBlocked(user.id)) {
      await this.app.outbox.post(user.tgId, SUP.blocked);
      return true;
    }
    const refuse = async (t) => { await this.app.outbox.post(user.tgId, t); return true; };
    if (typeof msg.text !== 'string') return refuse(SUP.textOnly);
    const raw = msg.text.trim();
    if (!raw) return refuse(SUP.empty);
    if (raw.length > SUPPORT_LIMITS.maxLen) return refuse(SUP.tooLong(SUPPORT_LIMITS.maxLen));
    const now = this.now();
    if (this.store.countIn(user.id, now - MINUTE) >= SUPPORT_LIMITS.perMinute) return refuse(SUP.fast);
    if (this.store.countIn(user.id, now - DAY) >= SUPPORT_LIMITS.perDay) return refuse(SUP.daily);

    const { text, flagged } = scrub(raw);
    this.store.purge(now);
    let t = this.store.openOf(user.id);
    const fresh = !t;
    const id = t ? t.id : this.store.open(user.id, now);
    this.store.touch(id, now);
    this.store.addMsg(id, 'in', text, flagged, now);
    this.store.setMode(user.id, now + SUPPORT_LIMITS.modeMs);

    const head = `📩 <b>Обращение №${id}</b>${fresh ? '' : ' (дополнение)'} · id <code>${esc(user.id)}</code>`;
    const warn = flagged ? '\n⚠️ <i>Похоже на пароль/код/токен — место скрыто.</i>' : '';
    const tail = `\n\n<i>Ответьте на это сообщение (reply) или /reply ${id} текст · /close ${id} · /support_block ${esc(user.id)}</i>`;
    await this.toOwners(`${head}${warn}\n\n${esc(text)}${tail}`);
    await this.app.outbox.post(user.tgId, (fresh ? SUP.accepted(id) : SUP.added(id)) + (flagged ? `\n\n${SUP.secret}` : ''), closeKb(id));
    return true;
  }

  /** Нажатие «Закрыть обращение»: только владелец обращения, личность — из Telegram. */
  async closeByPlayer(user, n) {
    const t = this.store.ticket(n);
    if (!t || t.user_id !== user.id) return { ok: false, text: SUP.notYours };
    if (!this.store.close(t.id, this.now())) return { ok: true, text: SUP.closed(t.id) };
    await this.toOwners(`📪 Игрок закрыл обращение №${t.id}.`);
    return { ok: true, text: SUP.closed(t.id) };
  }

  /* ---------------------------------------------------------- владелец */

  /** Доставка владельцам: админ-бот, если он настроен, иначе основной. */
  async toOwners(text) {
    if (this.app.notifyAdmins) return void (await this.app.notifyAdmins(text));
    for (const id of this.app.admins) {
      try { await this.app.outbox.post(id, text); } catch (err) { if (err?.error_code !== 403) this.app.log(err); }
    }
  }

  /** Номер обращения из сообщения бота, на которое ответил владелец: первая строка «📩 Обращение №N». */
  ticketOfReply(msg) {
    const r = msg.reply_to_message;
    if (!r || !r.from?.is_bot || typeof r.text !== 'string') return null;
    const m = /^📩 Обращение №(\d+)/.exec(r.text);
    return m ? Number(m[1]) : null;
  }

  /**
   * Команды и ответы владельца. `owner` — результат identify() из самого сообщения.
   * Возвращает текст для владельца (пустая строка — обработано молча) или null, если сообщение — не про поддержку.
   * Неадмин сюда не доходит: проверка тут же, повторно.
   */
  async ownerInput(owner, msg, cmd) {
    if (!this.app.isAdmin(owner.id)) return null;
    const ownerMsg = `${msg.chat?.id ?? owner.id}:${msg.message_id ?? ''}`;
    const keyOf = () => (msg.message_id == null ? null : ownerMsg);
    switch (cmd?.cmd) {
      case 'tickets': return this.listText();
      case 'close': return this.closeByOwner(cmd.args[0]);
      case 'support_block': return this.block(cmd.args[0], true);
      case 'support_unblock': return this.block(cmd.args[0], false);
      case 'reply': {
        const m = /^#?(\d+)\s+([\s\S]+)$/.exec(cmd.rest);
        if (!m) return 'Формат: /reply <№ обращения> текст. Проще — ответить (reply) на сообщение с обращением.';
        return this.answer(owner, Number(m[1]), m[2], keyOf());
      }
      default:
    }
    if (!cmd && typeof msg.text === 'string' && msg.reply_to_message) {
      const n = this.ticketOfReply(msg);
      if (n == null) return null;
      return this.answer(owner, n, msg.text, keyOf());
    }
    return null;
  }

  listText() {
    const list = this.store.openList();
    if (!list.length) return '📭 Открытых обращений нет.';
    const lines = ['📬 <b>Открытые обращения</b>'];
    for (const t of list) {
      const last = this.store.msgs(t.id).at(-1);
      const mark = last?.dir === 'in' ? '❗ ждёт ответа' : 'ответ дан';
      lines.push(`№${t.id} · id <code>${esc(t.user_id)}</code> · ${mark}`);
    }
    lines.push('', 'Ответ: reply на сообщение с обращением или /reply № текст · закрыть: /close №');
    return lines.join('\n');
  }

  async closeByOwner(arg) {
    const n = Number(arg);
    const t = Number.isInteger(n) ? this.store.ticket(n) : null;
    if (!t) return 'Нет такого обращения. Список — /tickets.';
    if (!this.store.close(t.id, this.now())) return `Обращение №${t.id} уже закрыто.`;
    try { await this.app.outbox.post(t.user_id, SUP.closedByOwner(t.id)); } catch { /* не доставлено — не страшно */ }
    return `Обращение №${t.id} закрыто.`;
  }

  block(arg, on) {
    const id = String(arg || '').trim();
    if (!/^\d{1,15}$/.test(id)) return `Формат: /${on ? 'support_block' : 'support_unblock'} <id игрока>.`;
    this.store.setBlocked(id, on);
    return on ? `Игрок ${id} заблокирован в поддержке: его сообщения не принимаются.` : `Игрок ${id} разблокирован.`;
  }

  /**
   * Отправить ответ игроку. `key` — отметка этого сообщения владельца: тот же reply, пришедший второй раз
   * (повторная доставка апдейта), второй раз игроку не уходит.
   */
  async answer(owner, n, text, key) {
    const t = this.store.ticket(n);
    if (!t) return 'Нет такого обращения. Список — /tickets.';
    const body = String(text).trim();
    if (!body) return 'Пустой ответ не отправляю.';
    if (body.length > SUPPORT_LIMITS.maxLen) return `Слишком длинно: не больше ${SUPPORT_LIMITS.maxLen} знаков.`;
    const now = this.now();
    if (key && !this.store.claimReply(owner.id, key, t.id, now)) return ''; // уже обработано: молча
    this.store.addMsg(t.id, 'out', body, false, now);
    this.store.touch(t.id, now);
    try {
      await this.app.outbox.post(t.user_id, SUP.reply(body), t.state === 'open' ? closeKb(t.id) : null);
    } catch (err) {
      if (key) this.store.finishReply(owner.id, key, 'failed');
      if (err?.error_code === 403) {
        this.app.setDm?.(t.user_id, 'fail');
        return `⚠️ Ответ по обращению №${t.id} не доставлен: игрок заблокировал бота или не нажимал Start.`;
      }
      this.app.log(err);
      return `⚠️ Ответ по обращению №${t.id} не доставлен (ошибка Telegram). Повторите: /reply ${t.id} текст.`;
    }
    if (key) this.store.finishReply(owner.id, key, 'sent');
    return `✅ Ответ по обращению №${t.id} отправлен.`;
  }
}
