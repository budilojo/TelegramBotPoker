'use strict';
/**
 * Persistence. The bot lives for weeks, not for one evening, and a restart in
 * the middle of a hand must not wipe the table.
 *
 * SQLite rather than the web app's JSON snapshot: writes are atomic and
 * synchronous, so a crash one millisecond after an action loses nothing,
 * and there is no "the file was half-written" failure mode. `node:sqlite` is
 * built into Node, so this costs zero dependencies — same spirit as the rest
 * of the project.
 *
 * Rooms are stored whole, as one JSON blob per game. A table is a few
 * kilobytes and is always read and written as a unit; splitting it across
 * tables would buy nothing and cost consistency.
 *
 * A group can have several games at once (the hub), so a room is keyed by
 * its own code, and the chat is just a column. The first version keyed rooms
 * by chat — one poker table per group — and a database from it is carried
 * over on open, row by row, without anybody doing anything.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ym, ymd, ymdBack } from './fmt.js';
import { PayStore } from './payments/store.js';

// A row without a code (only a hand-written INSERT can make one) still gets a
// unique key, so it can never collide with — or overwrite — a real table.
const ROOMS = `
CREATE TABLE IF NOT EXISTS rooms (
  code       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  chat_id    TEXT NOT NULL,
  game       TEXT NOT NULL DEFAULT 'poker',
  data       TEXT NOT NULL,
  status     TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_by_chat ON rooms (chat_id);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- Столбец ads: 'off' — человек нажал «не присылать такое». Пусто — согласен.
-- Игровые сообщения («ваш ход», итоги) он получает всё равно: это его игра,
-- а не реклама.
CREATE TABLE IF NOT EXISTS users (
  user_id    TEXT PRIMARY KEY,
  dm         TEXT NOT NULL,
  ads        TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  chat_id    TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Кто в какой день открывал приложение. Одна строка на человека в день, а не
-- на каждое открытие: для «сколько людей» и «вернулись ли» этого хватает, а
-- база не растёт от того, что кто-то весь вечер сворачивает и разворачивает.
CREATE TABLE IF NOT EXISTS seen (
  user_id TEXT NOT NULL,
  day     TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- Что происходило с играми. Ни имён, ни карт, ни текста — только «когда,
-- какая игра, в какой группе, сколько человек». По этим строкам считается
-- всё, что видно в админке.
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  day     TEXT NOT NULL,
  kind    TEXT NOT NULL,
  game    TEXT,
  chat_id TEXT,
  code    TEXT,
  n       INTEGER
);
CREATE INDEX IF NOT EXISTS events_by_day ON events (day);

-- Рассылки: текст, кому, когда и что из этого получилось. Столбец cursor —
-- последний получатель, которому письмо уже ушло: по нему рассылка
-- продолжается после перезапуска, и никто не получает письмо дважды.
CREATE TABLE IF NOT EXISTS broadcasts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  text       TEXT NOT NULL,
  btn_text   TEXT,
  btn_url    TEXT,
  audience   TEXT NOT NULL,
  status     TEXT NOT NULL,
  total      INTEGER NOT NULL DEFAULT 0,
  sent       INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  cursor     TEXT,
  started_at INTEGER,
  done_at    INTEGER,
  note       TEXT
);
CREATE INDEX IF NOT EXISTS broadcasts_by_at ON broadcasts (status, at);

-- Рейтинг: у каждой игры свой. Хороший дурак и хороший покерист — разные
-- умения, складывать их в одно число нечестно.
--   points       — за всё время; не обнуляется никогда;
--   month_points — за месяц; столбец month хранит, за какой ('2026-09'),
--                  и очки обнуляются при первой же записи нового месяца:
--                  ночная задача для этого не нужна.
CREATE TABLE IF NOT EXISTS ratings (
  user_id      TEXT NOT NULL,
  game         TEXT NOT NULL,
  name         TEXT,
  points       INTEGER NOT NULL DEFAULT 0,
  month        TEXT,
  month_points INTEGER NOT NULL DEFAULT 0,
  played       INTEGER NOT NULL DEFAULT 0,
  wins         INTEGER NOT NULL DEFAULT 0,
  fools        INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, game)
);
CREATE INDEX IF NOT EXISTS ratings_by_points ON ratings (game, points DESC);

-- То же самое, но внутри одной группы. Отдельной таблицей, а не суммой по
-- журналу: правило «ниже нуля не падает» применяется к бегущему счёту, и
-- сумма за всё время дала бы другое число, чем то, что человек видел после
-- каждой партии.
CREATE TABLE IF NOT EXISTS ratings_group (
  chat_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  game         TEXT NOT NULL,
  name         TEXT,
  points       INTEGER NOT NULL DEFAULT 0,
  month        TEXT,
  month_points INTEGER NOT NULL DEFAULT 0,
  played       INTEGER NOT NULL DEFAULT 0,
  wins         INTEGER NOT NULL DEFAULT 0,
  fools        INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id, game)
);
CREATE INDEX IF NOT EXISTS ratings_group_by_points ON ratings_group (chat_id, game, points DESC);

-- Откуда у человека очки. Без этого нельзя ни показать «последние партии»,
-- ни ответить, если он спросит, за что ему столько.
CREATE TABLE IF NOT EXISTS rating_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  chat_id TEXT,
  game    TEXT NOT NULL,
  round   TEXT NOT NULL,
  place   INTEGER NOT NULL,
  of      INTEGER NOT NULL,
  delta   INTEGER NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rating_log_by_user ON rating_log (user_id, game, at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS rating_log_once ON rating_log (user_id, game, round);

-- Профиль игрока (ник и аватар для показа). Только отображение: личность и
-- права определяет Telegram. Таблица ДОБАВЛЕНА без смены версии схемы —
-- старый код открывает такую базу и просто не знает про эту таблицу.
-- Спрос: уникальные зрители и «Хочу», без имён и платежей; схема остаётся 5.
CREATE TABLE IF NOT EXISTS shop_interest (
  user_id TEXT NOT NULL,
  item TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('a', 'b')),
  viewed_at INTEGER NOT NULL,
  wanted_at INTEGER,
  PRIMARY KEY (user_id, item)
);

-- Вкладка «Магазин»: кто хоть раз нажал и сколько раз. Без имён наружу;
-- таблица ДОБАВЛЕНА без смены версии схемы (старый код её не замечает).
CREATE TABLE IF NOT EXISTS shop_tab (
  user_id  TEXT PRIMARY KEY,
  first_at INTEGER NOT NULL,
  last_at  INTEGER NOT NULL,
  taps     INTEGER NOT NULL
);

-- collections: коллекция «Графит». Демо-права, выбранное оформление и недавние
-- идентификаторы запросов. Таблицы ДОБАВЛЕНЫ без смены версии схемы (старый код
-- их не замечает). Реальных прав здесь нет; демо-строки читаются только при
-- включённой демосреде (COLLECTIONS_DEMO=1).
CREATE TABLE IF NOT EXISTS collection_demo_grant (
  user_id    TEXT NOT NULL,
  item       TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item)
);
CREATE TABLE IF NOT EXISTS collection_choice (
  user_id    TEXT NOT NULL,
  slot       TEXT NOT NULL,
  item       TEXT NOT NULL,
  color      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, slot)
);
CREATE TABLE IF NOT EXISTS collection_req (
  user_id TEXT NOT NULL,
  req     TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, req)
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id    TEXT PRIMARY KEY,
  nickname   TEXT,
  avatar     TEXT,
  updated_at INTEGER
);

-- «Тренировка» (покер): личный прогресс игрока. Таблицы ДОБАВЛЕНЫ без смены
-- версии схемы — старый код открывает такую базу и просто не знает про них.
CREATE TABLE IF NOT EXISTS train_skill (
  user_id    TEXT NOT NULL,
  skill      TEXT NOT NULL,
  level      INTEGER NOT NULL,
  rating     REAL NOT NULL DEFAULT 0,
  n          INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (user_id, skill)
);
CREATE TABLE IF NOT EXISTS train_result (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ex      TEXT NOT NULL,
  track   TEXT NOT NULL,
  topic   TEXT NOT NULL,
  level   INTEGER NOT NULL,
  score   REAL NOT NULL,
  ms      INTEGER NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS train_result_by_user ON train_result (user_id, id DESC);
CREATE TABLE IF NOT EXISTS train_topic (
  user_id       TEXT NOT NULL,
  topic         TEXT NOT NULL,
  mastery       INTEGER NOT NULL DEFAULT 0,
  interval_days INTEGER NOT NULL DEFAULT 0,
  due_at        INTEGER,
  lapses        INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER,
  PRIMARY KEY (user_id, topic)
);
CREATE TABLE IF NOT EXISTS train_mistake (
  user_id TEXT NOT NULL,
  topic   TEXT NOT NULL,
  code    TEXT NOT NULL,
  n       INTEGER NOT NULL DEFAULT 1,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, topic, code)
);
CREATE TABLE IF NOT EXISTS train_pass (
  user_id   TEXT NOT NULL,
  track     TEXT NOT NULL,
  level     INTEGER NOT NULL,
  passed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track, level)
);

-- Журнал решений игрока за покерным столом (агент Y, решение 071). ТОЛЬКО то,
-- что видел сам игрок: его карты, общий борд, банк, ставки, позиция. Чужих карт
-- здесь нет и быть не может. Последние DECISION_KEEP на игрока; игрок может
-- удалить всё. Таблица ДОБАВЛЕНА без смены версии схемы (как profiles).
CREATE TABLE IF NOT EXISTS decision_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  TEXT NOT NULL,
  hand_key TEXT,
  street   TEXT,
  position TEXT,
  hole     TEXT,
  board    TEXT,
  pot      INTEGER,
  to_call  INTEGER,
  stack    INTEGER,
  opps     INTEGER,
  bb       INTEGER,
  action   TEXT,
  amount   INTEGER,
  strength REAL,
  equity   REAL,
  kind     TEXT,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS decision_log_by_user ON decision_log (user_id, id DESC);

-- Сколько зачётных партий у этого состава сегодня. Вдвоём за час можно
-- нарисовать любое число — вот это и не даёт.
CREATE TABLE IF NOT EXISTS party_day (
  fingerprint TEXT NOT NULL,
  day         TEXT NOT NULL,
  n           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (fingerprint, day)
);
`;

export const SCHEMA_VERSION = '5';

const decisionFromRow = (r) => ({
  id: r.id, handKey: r.hand_key, street: r.street, position: r.position, hole: r.hole, board: r.board,
  pot: r.pot, toCall: r.to_call, stack: r.stack, opps: r.opps, bb: r.bb, action: r.action, amount: r.amount,
  strength: r.strength, equity: r.equity, kind: r.kind, at: r.at,
});

export class Store {
  /** @param file path, or ':memory:' for tests */
  constructor(file = ':memory:') {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.upgrade();
    this.db.exec(ROOMS);
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema', SCHEMA_VERSION);
    // payments: покупки — в той же базе, свои таблицы (bot/payments/store.js).
    this.pay = new PayStore(this.db);
    this.q = {
      put: this.db.prepare(
        'INSERT INTO rooms (code, chat_id, game, data, status, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(code) DO UPDATE SET chat_id = excluded.chat_id, game = excluded.game, ' +
          'data = excluded.data, status = excluded.status, updated_at = excluded.updated_at'
      ),
      all: this.db.prepare('SELECT code, chat_id, game, data FROM rooms ORDER BY updated_at DESC'),
      del: this.db.prepare('DELETE FROM rooms WHERE code = ?'),
      delChat: this.db.prepare('DELETE FROM rooms WHERE chat_id = ?'),
      rekey: this.db.prepare('UPDATE rooms SET chat_id = ? WHERE chat_id = ?'),
      getUser: this.db.prepare('SELECT dm, ads FROM users WHERE user_id = ?'),
      putDm: this.db.prepare(
        'INSERT INTO users (user_id, dm, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(user_id) DO UPDATE SET dm = excluded.dm, updated_at = excluded.updated_at'
      ),
      putAds: this.db.prepare(
        "INSERT INTO users (user_id, dm, ads, updated_at) VALUES (?, 'ok', ?, ?) " +
          'ON CONFLICT(user_id) DO UPDATE SET ads = excluded.ads, updated_at = excluded.updated_at'
      ),
      getProfile: this.db.prepare('SELECT nickname, avatar FROM profiles WHERE user_id = ?'),
      putProfile: this.db.prepare(
        'INSERT INTO profiles (user_id, nickname, avatar, updated_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(user_id) DO UPDATE SET nickname = excluded.nickname, avatar = excluded.avatar, updated_at = excluded.updated_at'
      ),
      trSkills: this.db.prepare('SELECT skill, level, rating, n, updated_at FROM train_skill WHERE user_id = ?'),
      trResults: this.db.prepare('SELECT ex, track, topic, level, score, ms, at FROM train_result WHERE user_id = ? ORDER BY id DESC'),
      trTopics: this.db.prepare('SELECT topic, mastery, interval_days, due_at, lapses, updated_at FROM train_topic WHERE user_id = ?'),
      trMistakes: this.db.prepare('SELECT topic, code, n, last_at FROM train_mistake WHERE user_id = ? ORDER BY last_at DESC'),
      trPasses: this.db.prepare('SELECT track, level, passed_at FROM train_pass WHERE user_id = ?'),
      trPutSkill: this.db.prepare(
        'INSERT INTO train_skill (user_id, skill, level, rating, n, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(user_id, skill) DO UPDATE SET level = excluded.level, rating = excluded.rating, n = excluded.n, updated_at = excluded.updated_at'
      ),
      trAddResult: this.db.prepare('INSERT INTO train_result (user_id, ex, track, topic, level, score, ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      trTrim: this.db.prepare(
        'DELETE FROM train_result WHERE user_id = ? AND id NOT IN (SELECT id FROM train_result WHERE user_id = ? ORDER BY id DESC LIMIT ?)'
      ),
      trPutTopic: this.db.prepare(
        'INSERT INTO train_topic (user_id, topic, mastery, interval_days, due_at, lapses, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(user_id, topic) DO UPDATE SET mastery = excluded.mastery, interval_days = excluded.interval_days, ' +
          'due_at = excluded.due_at, lapses = excluded.lapses, updated_at = excluded.updated_at'
      ),
      trAddMistake: this.db.prepare(
        'INSERT INTO train_mistake (user_id, topic, code, n, last_at) VALUES (?, ?, ?, 1, ?) ' +
          'ON CONFLICT(user_id, topic, code) DO UPDATE SET n = n + 1, last_at = excluded.last_at'
      ),
      trPutPass: this.db.prepare('INSERT OR IGNORE INTO train_pass (user_id, track, level, passed_at) VALUES (?, ?, ?, ?)'),
      addDecision: this.db.prepare(
        'INSERT INTO decision_log (user_id, hand_key, street, position, hole, board, pot, to_call, stack, opps, bb, action, amount, strength, equity, kind, at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ),
      trimDecisions: this.db.prepare(
        'DELETE FROM decision_log WHERE user_id = ? AND id NOT IN (SELECT id FROM decision_log WHERE user_id = ? ORDER BY id DESC LIMIT ?)'
      ),
      getDecisions: this.db.prepare('SELECT * FROM decision_log WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
      delDecisions: this.db.prepare('DELETE FROM decision_log WHERE user_id = ?'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      putMeta: this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      addCast: this.db.prepare(
        'INSERT INTO broadcasts (created_at, at, text, btn_text, btn_url, audience, status, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ),
      getCast: this.db.prepare('SELECT * FROM broadcasts WHERE id = ?'),
      allCasts: this.db.prepare('SELECT * FROM broadcasts ORDER BY at DESC LIMIT ?'),
      dueCasts: this.db.prepare("SELECT * FROM broadcasts WHERE status IN ('scheduled', 'sending') ORDER BY at"),
      patchCast: this.db.prepare(
        'UPDATE broadcasts SET status = ?, total = ?, sent = ?, failed = ?, cursor = ?, started_at = ?, done_at = ?, note = ? WHERE id = ?'
      ),
      addEvent: this.db.prepare('INSERT INTO events (at, day, kind, game, chat_id, code, n) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      addSeen: this.db.prepare('INSERT OR IGNORE INTO seen (user_id, day) VALUES (?, ?)'),
      putGroup: this.db.prepare(
        'INSERT INTO groups (chat_id, code, data, updated_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(chat_id) DO UPDATE SET code = excluded.code, data = excluded.data, updated_at = excluded.updated_at'
      ),
      allGroups: this.db.prepare('SELECT chat_id, code, data FROM groups'),
      roomChats: this.db.prepare('SELECT DISTINCT chat_id FROM rooms'),
      delGroup: this.db.prepare('DELETE FROM groups WHERE chat_id = ?'),
      rekeyGroup: this.db.prepare('UPDATE groups SET chat_id = ? WHERE chat_id = ?'),
    };
  }

  /**
   * Schema 1 keyed `rooms` by chat. Move every row to the new shape, keyed by
   * the room's own code (it is inside the JSON), as a poker game. A row whose
   * JSON is broken is carried over too — the loader skips it, as it always
   * did, and nothing is thrown away on the way.
   */
  upgrade() {
    // v2 → v3: отписка от рассылок. Столбец добавляется на месте, строки не
    // трогаются — «нажал Start» и «отписался» это разные вещи, и первое при
    // обновлении не должно потеряться.
    const userCols = this.db.prepare("SELECT name FROM pragma_table_info('users')").all().map((c) => c.name);
    if (userCols.length && !userCols.includes('ads')) this.db.exec('ALTER TABLE users ADD COLUMN ads TEXT');

    // v4 → v5: рейтинг в разрезе группы. Таблицу создаёт схема; журналу
    // нужен столбец. Уже начисленные очки в группы не раскидываются — было
    // бы враньём: до этой версии бот не знал, в какой группе шла партия.
    const logCols = this.db.prepare("SELECT name FROM pragma_table_info('rating_log')").all().map((c) => c.name);
    if (logCols.length && !logCols.includes('chat_id')) this.db.exec('ALTER TABLE rating_log ADD COLUMN chat_id TEXT');

    const cols = this.db.prepare("SELECT name FROM pragma_table_info('rooms')").all().map((c) => c.name);
    if (!cols.length || cols.includes('code')) return;
    const rows = this.db.prepare('SELECT chat_id, data, status, updated_at FROM rooms').all();
    this.db.exec('BEGIN');
    try {
      this.db.exec('ALTER TABLE rooms RENAME TO rooms_v1');
      this.db.exec(ROOMS);
      const put = this.db.prepare('INSERT OR IGNORE INTO rooms (code, chat_id, game, data, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const r of rows) {
        let code = null;
        try {
          code = JSON.parse(r.data)?.code || null;
        } catch {
          /* broken JSON: keep the row under a fresh key */
        }
        put.run(code ?? `v1-${r.chat_id}`, String(r.chat_id), 'poker', r.data, r.status, r.updated_at);
      }
      this.db.exec('DROP TABLE rooms_v1');
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Can the bot write to this person privately? Telegram forbids a bot to
   * start a conversation, so the only way to know is that they pressed Start
   * ('ok') or that a delivery bounced ('fail'). Unknown is `null`.
   */
  getDm(userId) {
    return this.q.getUser.get(String(userId))?.dm ?? null;
  }

  /** Согласен ли человек получать рассылки. Отписка сильнее всего остального. */
  adsAllowed(userId) {
    return this.q.getUser.get(String(userId))?.ads !== 'off';
  }

  /** «Не присылать такое» — один тап, и больше ни одной рассылки. */
  setAds(userId, value) {
    this.q.putAds.run(String(userId), value, Date.now());
  }

  setDm(userId, status) {
    this.q.putDm.run(String(userId), status, Date.now());
  }

  save(room, serialized) {
    this.q.put.run(String(room.code), String(room.chatId), room.game || 'poker', JSON.stringify(serialized), room.status, Date.now());
  }

  /** @returns {Array<{chatId:string, code:string, game:string, data:object}>} */
  loadAll() {
    const out = [];
    for (const row of this.q.all.all()) {
      try {
        out.push({ chatId: String(row.chat_id), code: String(row.code), game: row.game || 'poker', data: JSON.parse(row.data) });
      } catch {
        // A corrupt row must not stop the other tables from coming back.
      }
    }
    return out;
  }

  /** One game gone (by its code). */
  remove(code) {
    this.q.del.run(String(code));
  }

  /** Every game of a chat — the bot was removed from the group. */
  removeChat(chatId) {
    this.q.delChat.run(String(chatId));
    this.q.delGroup.run(String(chatId));
  }

  /** Чаты, где когда-либо были столы, — для рассылки по группам. */
  roomChats() {
    return this.q.roomChats.all().map((r) => String(r.chat_id));
  }

  /**
   * A group promoted to a supergroup gets a brand new chat.id. Telegram sends
   * `migrate_to_chat_id` once; if the rows are not re-keyed here, the tables
   * are lost the moment the group is upgraded.
   */
  migrate(oldChatId, newChatId) {
    this.q.rekey.run(String(newChatId), String(oldChatId));
    this.q.delGroup.run(String(newChatId));
    this.q.rekeyGroup.run(String(newChatId), String(oldChatId));
  }

  // «Хочу» подразумевает просмотр; повторный просмотр/«Хочу» не раздувает доли.
  shopInterest(userId, item, variant, action, at) {
    this.db.prepare(`INSERT INTO shop_interest (user_id, item, variant, viewed_at, wanted_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, item) DO UPDATE SET
      wanted_at = COALESCE(shop_interest.wanted_at, excluded.wanted_at)`)
      .run(String(userId), item, variant, at, action === 'want' ? at : null);
  }
  shopMine(userId) {
    return this.db.prepare('SELECT item FROM shop_interest WHERE user_id = ? AND wanted_at IS NOT NULL ORDER BY item')
      .all(String(userId)).map((r) => r.item);
  }
  shopReset(userId) {
    this.db.prepare('DELETE FROM shop_interest WHERE user_id = ?').run(String(userId));
  }
  shopTotals() {
    return this.db.prepare(`SELECT item, variant, COUNT(*) AS views, COUNT(wanted_at) AS wants
      FROM shop_interest GROUP BY item, variant ORDER BY item, variant`).all();
  }

  /** Нажатие на вкладку «Магазин»: строка человека + событие дня (без имени). */
  shopTabTap(userId, at) {
    this.db.prepare(`INSERT INTO shop_tab (user_id, first_at, last_at, taps) VALUES (?, ?, ?, 1)
      ON CONFLICT(user_id) DO UPDATE SET taps = taps + 1, last_at = excluded.last_at`).run(String(userId), at, at);
    this.addEvent({ at, kind: 'shop-tab' });
  }
  /** Только суммы: людей, нажатий и нажатия по дням за последние `days` дней. */
  shopTabTotals(now, days = 14) {
    const t = this.db.prepare('SELECT COUNT(*) AS people, COALESCE(SUM(taps), 0) AS taps FROM shop_tab').get();
    const since = ymdBack(now, days - 1);
    const perDay = new Map(this.db.prepare("SELECT day, COUNT(*) AS n FROM events WHERE kind = 'shop-tab' AND day >= ? GROUP BY day").all(since).map((r) => [r.day, r.n]));
    return {
      people: t.people, taps: t.taps,
      days: Array.from({ length: days }, (_, i) => { const day = ymdBack(now, days - 1 - i); return { day, taps: perDay.get(day) || 0 }; }),
    };
  }

  // collections: демо-права, выбор оформления и идемпотентность запросов
  collDemoGrant(userId, item, at) {
    this.db.prepare('INSERT OR IGNORE INTO collection_demo_grant (user_id, item, granted_at) VALUES (?, ?, ?)')
      .run(String(userId), String(item), at);
  }
  collDemoItems(userId) {
    return this.db.prepare('SELECT item FROM collection_demo_grant WHERE user_id = ? ORDER BY granted_at, item')
      .all(String(userId)).map((r) => r.item);
  }
  collChoices(userId) {
    return this.db.prepare('SELECT slot, item, color FROM collection_choice WHERE user_id = ?').all(String(userId))
      .map((r) => ({ slot: r.slot, item: r.item, color: r.color }));
  }
  collChoiceSet(userId, slot, item, color, at) {
    this.db.prepare(`INSERT INTO collection_choice (user_id, slot, item, color, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, slot) DO UPDATE SET item = excluded.item, color = excluded.color, updated_at = excluded.updated_at`)
      .run(String(userId), String(slot), String(item), String(color), at);
  }
  collChoiceClear(userId, slot) {
    this.db.prepare('DELETE FROM collection_choice WHERE user_id = ? AND slot = ?').run(String(userId), String(slot));
  }
  collReqSeen(userId, req) {
    return !!this.db.prepare('SELECT 1 FROM collection_req WHERE user_id = ? AND req = ?').get(String(userId), String(req));
  }
  collReqAdd(userId, req, at, keep = 50) {
    const u = String(userId);
    this.db.prepare('INSERT OR IGNORE INTO collection_req (user_id, req, at) VALUES (?, ?, ?)').run(u, String(req), at);
    this.db.prepare(`DELETE FROM collection_req WHERE user_id = ? AND rowid NOT IN
      (SELECT rowid FROM collection_req WHERE user_id = ? ORDER BY at DESC, rowid DESC LIMIT ?)`).run(u, u, keep);
  }

  /* ---------------------------------------------------------------- groups */

  /** A group the hub knows: its public code (for `startapp=g_…`) and its card. */
  saveGroup(group) {
    this.q.putGroup.run(String(group.chatId), group.code, JSON.stringify(group), Date.now());
  }

  /** @returns {Array<object>} */
  loadGroups() {
    const out = [];
    for (const row of this.q.allGroups.all()) {
      try {
        out.push({ ...JSON.parse(row.data), chatId: String(row.chat_id), code: String(row.code) });
      } catch {
        /* a broken row loses its card, not the group's games */
      }
    }
    return out;
  }

  /* -------------------------------------------------------------- настройки */

  /**
   * Настройка, которая должна пережить перезапуск, — режим обслуживания.
   * Если бы он жил в памяти, он снимался бы сам в самый неподходящий момент.
   */
  getSetting(key, fallback = null) {
    const row = this.q.getMeta.get(`s:${key}`);
    if (!row?.value) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  setSetting(key, value) {
    this.q.putMeta.run(`s:${key}`, JSON.stringify(value ?? null));
  }

  /* --------------------------------------------------------------- рассылки */

  /**
   * Получатели рассылки, по возрастанию id — чтобы отправку можно было
   * продолжить с того места, где её прервал перезапуск.
   *
   * Только те, у кого личка с ботом открыта: Telegram не даёт боту написать
   * первым, и адресов «всех пользователей Telegram» ни у кого нет. Минус
   * отписавшиеся — отписка сильнее любой аудитории.
   *
   * @param audience 'all' | 'week' (заходили за 7 дней) | 'sleep' (не заходили)
   */
  audience(kind = 'all', { now = Date.now(), after = null, limit = 0 } = {}) {
    const week = ymdBack(now, 6);
    const where = ["dm = 'ok'", "(ads IS NULL OR ads <> 'off')"];
    if (kind === 'week') where.push('user_id IN (SELECT user_id FROM seen WHERE day >= ?)');
    else if (kind === 'sleep') where.push('user_id NOT IN (SELECT user_id FROM seen WHERE day >= ?)');
    const args = kind === 'all' ? [] : [week];
    if (after != null) {
      where.push('user_id > ?');
      args.push(String(after));
    }
    const tail = limit ? ' LIMIT ?' : '';
    if (limit) args.push(limit);
    return this.db
      .prepare(`SELECT user_id FROM users WHERE ${where.join(' AND ')} ORDER BY user_id${tail}`)
      .all(...args)
      .map((r) => String(r.user_id));
  }

  /** Новая рассылка. Возвращает её вместе с id. */
  addBroadcast({ at, text, btnText = null, btnUrl = null, audience = 'all', total = 0, createdAt = Date.now() }) {
    const r = this.q.addCast.run(createdAt, at, text, btnText, btnUrl, audience, 'scheduled', total);
    return this.broadcast(Number(r.lastInsertRowid));
  }

  broadcast(id) {
    return this.q.getCast.get(Number(id)) ?? null;
  }

  broadcasts(limit = 20) {
    return this.q.allCasts.all(limit);
  }

  /** Всё, что ещё должно уйти, — для восстановления после перезапуска. */
  pendingBroadcasts() {
    return this.q.dueCasts.all();
  }

  patchBroadcast(id, patch = {}) {
    const cur = this.broadcast(id);
    if (!cur) return null;
    const n = { ...cur, ...patch };
    this.q.patchCast.run(n.status, n.total, n.sent, n.failed, n.cursor ?? null, n.started_at ?? null, n.done_at ?? null, n.note ?? null, Number(id));
    return this.broadcast(id);
  }

  /* ---------------------------------------------------------- статистика */

  /**
   * Заметить, что человек открыл приложение. Второй раз за тот же день
   * ничего не пишет.
   */
  noteSeen(userId, at = Date.now()) {
    this.q.addSeen.run(String(userId), ymd(at));
  }

  /**
   * Заметить, что случилось с игрой: `created`, `round` (сдана раздача или
   * партия), `finished`. Ни одного поля, по которому можно узнать человека
   * или его карты, здесь нет и быть не должно.
   */
  addEvent({ at = Date.now(), kind, game = null, chatId = null, code = null, n = null }) {
    this.q.addEvent.run(at, ymd(at), String(kind), game, chatId == null ? null : String(chatId), code, n == null ? null : Math.round(n));
  }

  /** Числа для админки. Всё обезличенно: только счётчики. */
  stats(now = Date.now(), { days = 14 } = {}) {
    const one = (sql, ...args) => this.db.prepare(sql).get(...args)?.n ?? 0;
    const today = ymd(now);
    const yesterday = ymdBack(now, 1);
    const weekAgo = ymdBack(now, 6); // сегодня плюс шесть прошлых = неделя

    const byGame = (since) => {
      const out = {};
      for (const r of this.db
        .prepare("SELECT game, COUNT(*) AS rounds, COUNT(DISTINCT code) AS games FROM events WHERE kind = 'round' AND day >= ? GROUP BY game")
        .all(since)) {
        out[r.game || 'poker'] = { rounds: r.rounds, games: r.games };
      }
      return out;
    };
    const period = (since) => ({
      created: one("SELECT COUNT(*) AS n FROM events WHERE kind = 'created' AND day >= ?", since),
      finished: one("SELECT COUNT(*) AS n FROM events WHERE kind = 'finished' AND day >= ?", since),
      games: one("SELECT COUNT(DISTINCT code) AS n FROM events WHERE kind = 'round' AND day >= ?", since),
      rounds: one("SELECT COUNT(*) AS n FROM events WHERE kind = 'round' AND day >= ?", since),
      byGame: byGame(since),
    });

    return {
      day: today,
      people: {
        total: one('SELECT COUNT(DISTINCT user_id) AS n FROM seen'),
        today: one('SELECT COUNT(DISTINCT user_id) AS n FROM seen WHERE day = ?', today),
        week: one('SELECT COUNT(DISTINCT user_id) AS n FROM seen WHERE day >= ?', weekAgo),
        fresh: one('SELECT COUNT(*) AS n FROM (SELECT user_id FROM seen GROUP BY user_id HAVING MIN(day) = ?)', today),
        yesterday: one('SELECT COUNT(DISTINCT user_id) AS n FROM seen WHERE day = ?', yesterday),
        // Из вчерашних вернулись сегодня — единственная метрика, по которой
        // видно, игра это на вечер или на неделю.
        returned: one('SELECT COUNT(*) AS n FROM seen a JOIN seen b ON a.user_id = b.user_id WHERE a.day = ? AND b.day = ?', yesterday, today),
      },
      groups: {
        total: one('SELECT COUNT(DISTINCT chat_id) AS n FROM events'),
        week: one('SELECT COUNT(DISTINCT chat_id) AS n FROM events WHERE day >= ?', weekAgo),
      },
      today: period(today),
      week: period(weekAgo),
      // Хвост по дням — чтобы на экране была не одна цифра, а линия.
      days: Array.from({ length: days }, (_, i) => {
        const d = ymdBack(now, days - 1 - i);
        return {
          day: d,
          people: one('SELECT COUNT(DISTINCT user_id) AS n FROM seen WHERE day = ?', d),
          rounds: one("SELECT COUNT(*) AS n FROM events WHERE kind = 'round' AND day = ?", d),
        };
      }),
    };
  }

  /* -------------------------------------------------------------- рейтинг */

  /**
   * Начислить одному человеку за одну партию.
   *
   * Строка журнала уникальна по (человек, игра, партия). Если ту же партию
   * попробуют засчитать второй раз — перезапуск, повторный вызов, что угодно —
   * запись не пройдёт и очки не удвоятся; метод вернёт false.
   *
   * Ниже нуля рейтинг не опускается: упереться в дно и бросить не за что.
   */
  rate({ userId, game, round, place, of, delta, name = null, win = false, fool = false, chatId = null, at = Date.now() }) {
    const id = String(userId);
    const g = String(game);
    const chat = chatId == null ? null : String(chatId);
    const log = this.db
      .prepare('INSERT OR IGNORE INTO rating_log (user_id, chat_id, game, round, place, of, delta, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, chat, g, String(round), Math.round(place), Math.round(of), Math.round(delta), at);
    if (!log.changes) return false;
    this.#bump('ratings', null, { id, game: g, name, delta, win, fool, at });
    // Тот же счёт внутри группы — по тем же правилам, включая «не ниже нуля».
    if (chat) this.#bump('ratings_group', chat, { id, game: g, name, delta, win, fool, at });
    return true;
  }

  /** Прибавить очки в одну из двух таблиц рейтинга: общую или групповую. */
  #bump(table, chat, { id, game, name, delta, win, fool, at }) {
    const month = ym(at);
    const where = chat ? 'chat_id = ? AND user_id = ? AND game = ?' : 'user_id = ? AND game = ?';
    const key = chat ? [chat, id, game] : [id, game];
    const row = this.db.prepare(`SELECT name, points, month, month_points FROM ${table} WHERE ${where}`).get(...key);
    // Сменился месяц — счёт месяца начинается с нуля сам, без ночной задачи.
    const wasMonth = row?.month === month ? row.month_points : 0;
    const points = Math.max(0, (row?.points ?? 0) + delta);
    const monthPoints = Math.max(0, wasMonth + delta);
    const cols = chat ? '(chat_id, user_id, game, ' : '(user_id, game, ';
    const marks = chat ? '(?, ?, ?, ' : '(?, ?, ';
    const conflict = chat ? '(chat_id, user_id, game)' : '(user_id, game)';
    this.db
      .prepare(
        `INSERT INTO ${table} ${cols}name, points, month, month_points, played, wins, fools, updated_at) ` +
          `VALUES ${marks}?, ?, ?, ?, 1, ?, ?, ?) ` +
          `ON CONFLICT${conflict} DO UPDATE SET name = excluded.name, points = ?, month = ?, month_points = ?, ` +
          'played = played + 1, wins = wins + ?, fools = fools + ?, updated_at = excluded.updated_at'
      )
      .run(...key, name ?? row?.name ?? null, points, month, monthPoints, win ? 1 : 0, fool ? 1 : 0, at,
        points, month, monthPoints, win ? 1 : 0, fool ? 1 : 0);
  }

  /** Сколько зачётных партий у этого состава за день. */
  partyCount(fingerprint, at = Date.now()) {
    return this.db.prepare('SELECT n FROM party_day WHERE fingerprint = ? AND day = ?').get(String(fingerprint), ymd(at))?.n ?? 0;
  }

  /** Записать ещё одну зачётную партию этого состава; вернуть, какая по счёту. */
  countParty(fingerprint, at = Date.now()) {
    this.db
      .prepare('INSERT INTO party_day (fingerprint, day, n) VALUES (?, ?, 1) ON CONFLICT(fingerprint, day) DO UPDATE SET n = n + 1')
      .run(String(fingerprint), ymd(at));
    return this.partyCount(fingerprint, at);
  }

  /**
   * Таблица рейтинга. `month` — за какой месяц ('2026-09'); без него за всё
   * время. При равенстве очков выше тот, кто сыграл меньше партий: одинаковый
   * счёт за меньшее число вечеров — лучше.
   */
  ratingTop(game, { month = null, limit = 50, offset = 0, chatId = null } = {}) {
    const t = chatId == null ? 'ratings' : 'ratings_group';
    const scope = chatId == null ? [] : [String(chatId)];
    const only = chatId == null ? '' : 'chat_id = ? AND ';
    const sql = month
      // В месячном списке — все, кто в этом месяце играл, даже если очков
      // ноль: иначе человек сыграл пять партий и не видит себя.
      ? `SELECT user_id, name, month_points AS points, played, wins, fools FROM ${t} ` +
        `WHERE ${only}game = ? AND month = ? ORDER BY month_points DESC, played ASC, user_id LIMIT ? OFFSET ?`
      : `SELECT user_id, name, points, played, wins, fools FROM ${t} ` +
        `WHERE ${only}game = ? AND played > 0 ORDER BY points DESC, played ASC, user_id LIMIT ? OFFSET ?`;
    const args = month ? [...scope, String(game), month, limit, offset] : [...scope, String(game), limit, offset];
    return this.db.prepare(sql).all(...args).map((r) => ({ ...r, userId: String(r.user_id) }));
  }

  /** Профиль для показа: ник и id аватара (или null, null). */
  getProfile(userId) {
    const r = this.q.getProfile.get(String(userId));
    return { nickname: r?.nickname ?? null, avatar: r?.avatar ?? null };
  }

  putProfile(userId, { nickname = null, avatar = null } = {}, at = Date.now()) {
    this.q.putProfile.run(String(userId), nickname, avatar, at);
  }

  /** Строка одного человека: его очки, место и сколько всего в списке. */
  ratingOf(userId, game, { month = null, chatId = null } = {}) {
    const id = String(userId);
    const t = chatId == null ? 'ratings' : 'ratings_group';
    const scope = chatId == null ? [] : [String(chatId)];
    const only = chatId == null ? '' : 'chat_id = ? AND ';
    const row = this.db.prepare(`SELECT * FROM ${t} WHERE ${only}user_id = ? AND game = ?`).get(...scope, id, String(game));
    if (!row) return null;
    const points = month ? (row.month === month ? row.month_points : 0) : row.points;
    const col = month ? 'month_points' : 'points';
    const where = month ? `${only}game = ? AND month = ?` : `${only}game = ? AND played > 0`;
    const args = month ? [...scope, String(game), month] : [...scope, String(game)];
    // Место считается ровно тем же порядком, что и список: очки, потом
    // меньше сыгранных партий. Иначе при равных очках человек видит «2-е
    // место», а в списке стоит третьим — и правильно не верит ни тому, ни
    // другому.
    const above = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${t} WHERE ${where} AND ` +
          `(${col} > ? OR (${col} = ? AND (played < ? OR (played = ? AND user_id < ?))))`
      )
      .get(...args, points, points, row.played, row.played, id)?.n ?? 0;
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`).get(...args)?.n ?? 0;
    return {
      userId: id,
      name: row.name,
      points,
      played: row.played,
      wins: row.wins,
      fools: row.fools,
      place: above + 1,
      total,
    };
  }

  /** Последние партии человека — откуда взялись очки. */
  ratingLog(userId, game, limit = 5, { chatId = null } = {}) {
    const only = chatId == null ? '' : 'chat_id = ? AND ';
    const scope = chatId == null ? [] : [String(chatId)];
    return this.db
      .prepare(`SELECT round, place, of, delta, at FROM rating_log WHERE ${only}user_id = ? AND game = ? ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...scope, String(userId), String(game), limit);
  }

  // ---- «Тренировка»: личный прогресс (bot/train.js) ----
  trainLoad(userId) {
    const u = String(userId);
    const q = this.q;
    return {
      skills: q.trSkills.all(u).map((r) => ({ skill: r.skill, level: r.level, rating: r.rating, n: r.n, updatedAt: r.updated_at })),
      results: q.trResults.all(u).map((r) => ({ ex: r.ex, track: r.track, topic: r.topic, level: r.level, score: r.score, ms: r.ms, at: r.at })),
      topics: q.trTopics.all(u).map((r) => ({ topic: r.topic, mastery: r.mastery, intervalDays: r.interval_days, dueAt: r.due_at, lapses: r.lapses, updatedAt: r.updated_at })),
      mistakes: q.trMistakes.all(u).map((r) => ({ topic: r.topic, code: r.code, n: r.n, lastAt: r.last_at })),
      passed: q.trPasses.all(u).map((r) => ({ track: r.track, level: r.level, at: r.passed_at })),
    };
  }
  trainSetSkill(userId, { skill, level, rating, n }, at) {
    this.q.trPutSkill.run(String(userId), skill, level, rating, n, at);
  }
  trainAddResult(userId, r, cap) {
    const u = String(userId);
    this.q.trAddResult.run(u, r.ex, r.track, r.topic, r.level, r.score, r.ms, r.at);
    this.q.trTrim.run(u, u, cap);
  }
  trainSetTopic(userId, t, at) {
    this.q.trPutTopic.run(String(userId), t.topic, t.mastery, t.intervalDays, t.dueAt, t.lapses, at);
  }
  trainAddMistake(userId, topic, code, at) {
    this.q.trAddMistake.run(String(userId), topic, code, at);
  }
  trainSetPass(userId, track, level, at) {
    this.q.trPutPass.run(String(userId), track, level, at);
  }
  /** «Сбросить мой прогресс»: всё личное по Тренировке, ничего чужого. */
  trainReset(userId) {
    const u = String(userId);
    for (const t of ['train_skill', 'train_result', 'train_topic', 'train_mistake', 'train_pass']) {
      this.db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(u);
    }
  }
  /** Сколько человек открывали Тренировку — только число, без имён. */
  trainPeople() {
    return this.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM train_result').get().n;
  }

  /** Журнал решений: записать одну строку и подрезать до последних `keep` у этого игрока. */
  addDecision(userId, row, keep = 300) {
    const u = String(userId);
    this.q.addDecision.run(
      u, row.handKey ?? null, row.street ?? null, row.position ?? null, row.hole ?? null, row.board ?? null,
      row.pot ?? null, row.toCall ?? null, row.stack ?? null, row.opps ?? null, row.bb ?? null, row.action ?? null, row.amount ?? null,
      row.strength ?? null, row.equity ?? null, row.kind ?? null, row.at
    );
    this.q.trimDecisions.run(u, u, keep);
  }

  /** Последние решения игрока, новые первыми. */
  decisionsOf(userId, limit = 300) {
    return this.q.getDecisions.all(String(userId), limit).map(decisionFromRow);
  }

  /** «Удалить историю решений» — всё, что записано про этого игрока. */
  deleteDecisions(userId) {
    return Number(this.q.delDecisions.run(String(userId)).changes);
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * A drop-in that keeps no tables — used by tests that do not care about disk.
 * DM status is still remembered in memory: without it every test would have
 * to re-open every player's private chat before each hand.
 */
export class NullStore {
  constructor() {
    this.dm = new Map();
    this.shop = new Map();
    this.tab = new Map();
    this.tabDays = new Map();
    this.profiles = new Map();
    // collections: то же, что в Store, но в памяти
    this.collGrants = new Map();
    this.collPicks = new Map();
    this.collReqs = new Map();
    this.decisions = new Map();
    this.nextDecision = 1;
    this.ads = new Map();
    this.settings = new Map();
    /** Рассылки живут в памяти: тесты, которым они нужны, берут настоящий Store. */
    this.casts = new Map();
    this.nextCast = 1;
    /** Рейтинг — тоже в памяти, с теми же правилами: партия считается один раз. */
    this.rating = new Map();
    this.rated = new Set();
    this.parties = new Map();
    this.train = new Map();
    // payments: настоящая SQLite в памяти — у покупок важны транзакции и уникальность, их не подделываем.
    this.pay = new PayStore(new DatabaseSync(':memory:'));
  }
  shopInterest(userId, item, variant, action, at) {
    const key = `${userId}:${item}`;
    const row = this.shop.get(key) || { userId: String(userId), item, variant, viewedAt: at, wantedAt: null };
    if (action === 'want' && row.wantedAt === null) row.wantedAt = at;
    this.shop.set(key, row);
  }
  shopTabTap(userId, at) {
    const row = this.tab.get(String(userId)) || { taps: 0 };
    row.taps++;
    this.tab.set(String(userId), row);
    const day = ymd(at);
    this.tabDays.set(day, (this.tabDays.get(day) || 0) + 1);
  }
  shopTabTotals(now, days = 14) {
    return {
      people: this.tab.size, taps: [...this.tab.values()].reduce((n, r) => n + r.taps, 0),
      days: Array.from({ length: days }, (_, i) => { const day = ymdBack(now, days - 1 - i); return { day, taps: this.tabDays.get(day) || 0 }; }),
    };
  }
  shopMine(userId) {
    return [...this.shop.values()].filter((r) => r.userId === String(userId) && r.wantedAt !== null).map((r) => r.item).sort();
  }
  shopReset(userId) {
    for (const [key, row] of this.shop) if (row.userId === String(userId)) this.shop.delete(key);
  }
  shopTotals() {
    const totals = new Map();
    for (const r of this.shop.values()) {
      const key = `${r.item}:${r.variant}`;
      const t = totals.get(key) || { item: r.item, variant: r.variant, views: 0, wants: 0 };
      t.views++;
      if (r.wantedAt !== null) t.wants++;
      totals.set(key, t);
    }
    return [...totals.values()];
  }
  // ---- «Тренировка» в памяти (тот же интерфейс, что у Store) ----
  trainBox(userId) {
    const u = String(userId);
    if (!this.train.has(u)) this.train.set(u, { skills: new Map(), results: [], topics: new Map(), mistakes: new Map(), passed: new Map() });
    return this.train.get(u);
  }
  trainLoad(userId) {
    const b = this.trainBox(userId);
    return {
      skills: [...b.skills.values()].map((x) => ({ ...x })),
      results: b.results.map((x) => ({ ...x })).reverse(),
      topics: [...b.topics.values()].map((x) => ({ ...x })),
      mistakes: [...b.mistakes.values()].map((x) => ({ ...x })).sort((x, y) => y.lastAt - x.lastAt),
      passed: [...b.passed.values()].map((x) => ({ ...x })),
    };
  }
  trainSetSkill(userId, { skill, level, rating, n }, at) {
    this.trainBox(userId).skills.set(skill, { skill, level, rating, n, updatedAt: at });
  }
  trainAddResult(userId, r, cap) {
    const b = this.trainBox(userId);
    b.results.push({ ...r });
    if (b.results.length > cap) b.results.splice(0, b.results.length - cap);
  }
  trainSetTopic(userId, t, at) {
    this.trainBox(userId).topics.set(t.topic, { ...t, updatedAt: at });
  }
  trainAddMistake(userId, topic, code, at) {
    const m = this.trainBox(userId).mistakes;
    const k = `${topic}:${code}`;
    const cur = m.get(k);
    m.set(k, { topic, code, n: (cur?.n ?? 0) + 1, lastAt: at });
  }
  trainSetPass(userId, track, level, at) {
    const p = this.trainBox(userId).passed;
    if (!p.has(`${track}:${level}`)) p.set(`${track}:${level}`, { track, level, at });
  }
  trainReset(userId) {
    this.train.delete(String(userId));
  }
  trainPeople() {
    return [...this.train.values()].filter((b) => b.results.length).length;
  }
  getDm(userId) {
    return this.dm.get(String(userId)) ?? null;
  }
  setDm(userId, status) {
    this.dm.set(String(userId), status);
  }
  adsAllowed(userId) {
    return this.ads.get(String(userId)) !== 'off';
  }
  setAds(userId, value) {
    this.ads.set(String(userId), value);
  }
  getSetting(key, fallback = null) {
    return this.settings.has(key) ? this.settings.get(key) : fallback;
  }
  setSetting(key, value) {
    this.settings.set(key, value);
  }
  audience(kind = 'all', { after = null, limit = 0 } = {}) {
    const all = [...this.dm.entries()]
      .filter(([id, dm]) => dm === 'ok' && this.adsAllowed(id) && (after == null || id > String(after)))
      .map(([id]) => id)
      .sort();
    return limit ? all.slice(0, limit) : all;
  }
  addBroadcast({ at, text, btnText = null, btnUrl = null, audience = 'all', total = 0, createdAt = Date.now() }) {
    const id = this.nextCast++;
    const row = { id, created_at: createdAt, at, text, btn_text: btnText, btn_url: btnUrl, audience, status: 'scheduled', total, sent: 0, failed: 0, cursor: null, started_at: null, done_at: null, note: null };
    this.casts.set(id, row);
    return row;
  }
  broadcast(id) {
    return this.casts.get(Number(id)) ?? null;
  }
  broadcasts(limit = 20) {
    return [...this.casts.values()].sort((a, b) => b.at - a.at).slice(0, limit);
  }
  pendingBroadcasts() {
    return [...this.casts.values()].filter((c) => c.status === 'scheduled' || c.status === 'sending').sort((a, b) => a.at - b.at);
  }
  patchBroadcast(id, patch = {}) {
    const cur = this.broadcast(id);
    if (!cur) return null;
    Object.assign(cur, patch);
    return cur;
  }
  rate({ userId, game, round, place, of, delta, name = null, win = false, fool = false, chatId = null, at = Date.now() }) {
    if (this.rated.has(`${userId}:${game}:${round}`)) return false;
    this.rated.add(`${userId}:${game}:${round}`);
    const bump = (chat) => {
      const key = `${chat ?? ''}:${userId}:${game}`;
      const month = ym(at);
      const r = this.rating.get(key)
        || { userId: String(userId), chat, game, name, points: 0, month, monthPoints: 0, played: 0, wins: 0, fools: 0, log: [] };
      if (r.month !== month) {
        r.month = month;
        r.monthPoints = 0;
      }
      r.name = name ?? r.name;
      r.points = Math.max(0, r.points + delta);
      r.monthPoints = Math.max(0, r.monthPoints + delta);
      r.played += 1;
      if (win) r.wins += 1;
      if (fool) r.fools += 1;
      r.log.unshift({ round: String(round), place, of, delta, at });
      this.rating.set(key, r);
    };
    bump(null);
    if (chatId != null) bump(String(chatId));
    return true;
  }
  partyCount(fingerprint, at = Date.now()) {
    return this.parties.get(`${fingerprint}:${ymd(at)}`) ?? 0;
  }
  countParty(fingerprint, at = Date.now()) {
    const key = `${fingerprint}:${ymd(at)}`;
    const n = (this.parties.get(key) ?? 0) + 1;
    this.parties.set(key, n);
    return n;
  }
  getProfile(userId) {
    return { ...(this.profiles.get(String(userId)) ?? { nickname: null, avatar: null }) };
  }
  putProfile(userId, { nickname = null, avatar = null } = {}) {
    this.profiles.set(String(userId), { nickname, avatar });
  }
  collDemoGrant(userId, item, at) {
    const m = this.collGrants.get(String(userId)) ?? new Map();
    if (!m.has(String(item))) m.set(String(item), at);
    this.collGrants.set(String(userId), m);
  }
  collDemoItems(userId) {
    return [...(this.collGrants.get(String(userId)) ?? new Map())].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([i]) => i);
  }
  collChoices(userId) {
    return [...(this.collPicks.get(String(userId)) ?? new Map())].map(([slot, v]) => ({ slot, item: v.item, color: v.color }));
  }
  collChoiceSet(userId, slot, item, color, at) {
    const m = this.collPicks.get(String(userId)) ?? new Map();
    m.set(String(slot), { item: String(item), color: String(color), at });
    this.collPicks.set(String(userId), m);
  }
  collChoiceClear(userId, slot) {
    this.collPicks.get(String(userId))?.delete(String(slot));
  }
  collReqSeen(userId, req) {
    return (this.collReqs.get(String(userId)) ?? []).some((r) => r.req === String(req));
  }
  collReqAdd(userId, req, at, keep = 50) {
    const list = this.collReqs.get(String(userId)) ?? [];
    if (!list.some((r) => r.req === String(req))) list.push({ req: String(req), at });
    this.collReqs.set(String(userId), list.slice(-keep));
  }
  addDecision(userId, row, keep = 300) {
    const u = String(userId);
    const list = this.decisions.get(u) ?? [];
    list.unshift({ id: this.nextDecision++, ...row });
    list.length = Math.min(list.length, keep);
    this.decisions.set(u, list);
  }
  decisionsOf(userId, limit = 300) {
    return (this.decisions.get(String(userId)) ?? []).slice(0, limit).map((r) => ({ ...r }));
  }
  deleteDecisions(userId) {
    const n = (this.decisions.get(String(userId)) ?? []).length;
    this.decisions.delete(String(userId));
    return n;
  }
  ratingTop(game, { month = null, limit = 50, offset = 0, chatId = null } = {}) {
    const chat = chatId == null ? null : String(chatId);
    return [...this.rating.values()]
      .filter((r) => r.game === game && (r.chat ?? null) === chat && (month ? r.month === month : r.played > 0))
      .map((r) => ({ userId: r.userId, name: r.name, points: month ? r.monthPoints : r.points, played: r.played, wins: r.wins, fools: r.fools }))
      .sort((a, b) => b.points - a.points || a.played - b.played || a.userId.localeCompare(b.userId))
      .slice(offset, offset + limit);
  }
  ratingOf(userId, game, { month = null, chatId = null } = {}) {
    const r = this.rating.get(`${chatId == null ? '' : String(chatId)}:${userId}:${game}`);
    if (!r) return null;
    const list = this.ratingTop(game, { month, limit: 1e6, chatId });
    const points = month ? (r.month === month ? r.monthPoints : 0) : r.points;
    const at = list.findIndex((x) => x.userId === String(userId));
    return {
      userId: String(userId), name: r.name, points, played: r.played, wins: r.wins, fools: r.fools,
      place: at < 0 ? 0 : at + 1,
      total: list.length,
    };
  }
  ratingLog(userId, game, limit = 5, { chatId = null } = {}) {
    return (this.rating.get(`${chatId == null ? '' : String(chatId)}:${userId}:${game}`)?.log ?? []).slice(0, limit);
  }
  save() {}
  loadAll() {
    return [];
  }
  noteSeen() {}
  addEvent() {}
  stats(now = Date.now()) {
    const period = { created: 0, finished: 0, games: 0, rounds: 0, byGame: {} };
    return {
      day: ymd(now),
      people: { total: 0, today: 0, week: 0, fresh: 0, yesterday: 0, returned: 0 },
      groups: { total: 0, week: 0 },
      today: { ...period },
      week: { ...period },
      days: [],
    };
  }
  remove() {}
  removeChat() {}
  roomChats() {
    return [];
  }
  migrate() {}
  saveGroup() {}
  loadGroups() {
    return [];
  }
  close() {}
}
