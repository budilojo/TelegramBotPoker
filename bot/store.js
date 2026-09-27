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

-- Откуда у человека очки. Без этого нельзя ни показать «последние партии»,
-- ни ответить, если он спросит, за что ему столько.
CREATE TABLE IF NOT EXISTS rating_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  game    TEXT NOT NULL,
  round   TEXT NOT NULL,
  place   INTEGER NOT NULL,
  of      INTEGER NOT NULL,
  delta   INTEGER NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rating_log_by_user ON rating_log (user_id, game, at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS rating_log_once ON rating_log (user_id, game, round);

-- Сколько зачётных партий у этого состава сегодня. Вдвоём за час можно
-- нарисовать любое число — вот это и не даёт.
CREATE TABLE IF NOT EXISTS party_day (
  fingerprint TEXT NOT NULL,
  day         TEXT NOT NULL,
  n           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (fingerprint, day)
);
`;

export const SCHEMA_VERSION = '4';

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
  rate({ userId, game, round, place, of, delta, name = null, win = false, fool = false, at = Date.now() }) {
    const id = String(userId);
    const month = ym(at);
    const log = this.db
      .prepare('INSERT OR IGNORE INTO rating_log (user_id, game, round, place, of, delta, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, String(game), String(round), Math.round(place), Math.round(of), Math.round(delta), at);
    if (!log.changes) return false;
    const row = this.db.prepare('SELECT name, points, month, month_points FROM ratings WHERE user_id = ? AND game = ?').get(id, String(game));
    // Сменился месяц — счёт месяца начинается с нуля сам, без ночной задачи.
    const wasMonth = row?.month === month ? row.month_points : 0;
    const points = Math.max(0, (row?.points ?? 0) + delta);
    const monthPoints = Math.max(0, wasMonth + delta);
    this.db
      .prepare(
        'INSERT INTO ratings (user_id, game, name, points, month, month_points, played, wins, fools, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?) ' +
          'ON CONFLICT(user_id, game) DO UPDATE SET name = excluded.name, points = ?, month = ?, month_points = ?, ' +
          'played = played + 1, wins = wins + ?, fools = fools + ?, updated_at = excluded.updated_at'
      )
      .run(id, String(game), name ?? row?.name ?? null, points, month, monthPoints, win ? 1 : 0, fool ? 1 : 0, at,
        points, month, monthPoints, win ? 1 : 0, fool ? 1 : 0);
    return true;
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
  ratingTop(game, { month = null, limit = 50, offset = 0 } = {}) {
    const sql = month
      ? 'SELECT user_id, name, month_points AS points, played, wins, fools FROM ratings ' +
        'WHERE game = ? AND month = ? AND month_points > 0 ORDER BY month_points DESC, played ASC, user_id LIMIT ? OFFSET ?'
      : 'SELECT user_id, name, points, played, wins, fools FROM ratings ' +
        'WHERE game = ? AND played > 0 ORDER BY points DESC, played ASC, user_id LIMIT ? OFFSET ?';
    const args = month ? [String(game), month, limit, offset] : [String(game), limit, offset];
    return this.db.prepare(sql).all(...args).map((r) => ({ ...r, userId: String(r.user_id) }));
  }

  /** Строка одного человека: его очки, место и сколько всего в списке. */
  ratingOf(userId, game, { month = null } = {}) {
    const id = String(userId);
    const row = this.db.prepare('SELECT * FROM ratings WHERE user_id = ? AND game = ?').get(id, String(game));
    if (!row) return null;
    const points = month ? (row.month === month ? row.month_points : 0) : row.points;
    const col = month ? 'month_points' : 'points';
    const where = month ? 'game = ? AND month = ? AND month_points > 0' : 'game = ? AND played > 0';
    const args = month ? [String(game), month] : [String(game)];
    // Место считается ровно тем же порядком, что и список: очки, потом
    // меньше сыгранных партий. Иначе при равных очках человек видит «2-е
    // место», а в списке стоит третьим — и правильно не верит ни тому, ни
    // другому.
    const above = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM ratings WHERE ${where} AND ` +
          `(${col} > ? OR (${col} = ? AND (played < ? OR (played = ? AND user_id < ?))))`
      )
      .get(...args, points, points, row.played, row.played, id)?.n ?? 0;
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM ratings WHERE ${where}`).get(...args)?.n ?? 0;
    return {
      userId: id,
      name: row.name,
      points,
      played: row.played,
      wins: row.wins,
      fools: row.fools,
      place: points > 0 || !month ? above + 1 : 0,
      total,
    };
  }

  /** Последние партии человека — откуда взялись очки. */
  ratingLog(userId, game, limit = 5) {
    return this.db
      .prepare('SELECT round, place, of, delta, at FROM rating_log WHERE user_id = ? AND game = ? ORDER BY at DESC, id DESC LIMIT ?')
      .all(String(userId), String(game), limit);
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
    this.ads = new Map();
    this.settings = new Map();
    /** Рассылки живут в памяти: тесты, которым они нужны, берут настоящий Store. */
    this.casts = new Map();
    this.nextCast = 1;
    /** Рейтинг — тоже в памяти, с теми же правилами: партия считается один раз. */
    this.rating = new Map();
    this.rated = new Set();
    this.parties = new Map();
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
  rate({ userId, game, round, place, of, delta, name = null, win = false, fool = false, at = Date.now() }) {
    const key = `${userId}:${game}`;
    if (this.rated.has(`${key}:${round}`)) return false;
    this.rated.add(`${key}:${round}`);
    const month = ym(at);
    const r = this.rating.get(key) || { userId: String(userId), game, name, points: 0, month, monthPoints: 0, played: 0, wins: 0, fools: 0, log: [] };
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
  ratingTop(game, { month = null, limit = 50, offset = 0 } = {}) {
    return [...this.rating.values()]
      .filter((r) => r.game === game && (month ? r.month === month && r.monthPoints > 0 : r.played > 0))
      .map((r) => ({ userId: r.userId, name: r.name, points: month ? r.monthPoints : r.points, played: r.played, wins: r.wins, fools: r.fools }))
      .sort((a, b) => b.points - a.points || a.played - b.played || a.userId.localeCompare(b.userId))
      .slice(offset, offset + limit);
  }
  ratingOf(userId, game, { month = null } = {}) {
    const r = this.rating.get(`${userId}:${game}`);
    if (!r) return null;
    const list = this.ratingTop(game, { month, limit: 1e6 });
    const points = month ? (r.month === month ? r.monthPoints : 0) : r.points;
    const at = list.findIndex((x) => x.userId === String(userId));
    return {
      userId: String(userId), name: r.name, points, played: r.played, wins: r.wins, fools: r.fools,
      place: at < 0 ? 0 : at + 1,
      total: list.length,
    };
  }
  ratingLog(userId, game, limit = 5) {
    return (this.rating.get(`${userId}:${game}`)?.log ?? []).slice(0, limit);
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
  migrate() {}
  saveGroup() {}
  loadGroups() {
    return [];
  }
  close() {}
}
