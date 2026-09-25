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
CREATE TABLE IF NOT EXISTS users (
  user_id    TEXT PRIMARY KEY,
  dm         TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  chat_id    TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export const SCHEMA_VERSION = '2';

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
      getDm: this.db.prepare('SELECT dm FROM users WHERE user_id = ?'),
      putDm: this.db.prepare(
        'INSERT INTO users (user_id, dm, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(user_id) DO UPDATE SET dm = excluded.dm, updated_at = excluded.updated_at'
      ),
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
    return this.q.getDm.get(String(userId))?.dm ?? null;
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
  }
  getDm(userId) {
    return this.dm.get(String(userId)) ?? null;
  }
  setDm(userId, status) {
    this.dm.set(String(userId), status);
  }
  save() {}
  loadAll() {
    return [];
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
