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
 * Rooms are stored whole, as one JSON blob per chat. A poker table is a few
 * kilobytes and is always read and written as a unit; splitting it across
 * tables would buy nothing and cost consistency.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  chat_id    TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  status     TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export class Store {
  /** @param file path, or ':memory:' for tests */
  constructor(file = ':memory:') {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema', '1');
    this.q = {
      put: this.db.prepare(
        'INSERT INTO rooms (chat_id, data, status, updated_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data, ' +
          'status = excluded.status, updated_at = excluded.updated_at'
      ),
      all: this.db.prepare('SELECT chat_id, data FROM rooms ORDER BY updated_at DESC'),
      del: this.db.prepare('DELETE FROM rooms WHERE chat_id = ?'),
      rekey: this.db.prepare('UPDATE rooms SET chat_id = ? WHERE chat_id = ?'),
    };
  }

  save(room, serialized) {
    this.q.put.run(String(room.chatId), JSON.stringify(serialized), room.status, Date.now());
  }

  /** @returns {Array<{chatId:string, data:object}>} */
  loadAll() {
    const out = [];
    for (const row of this.q.all.all()) {
      try {
        out.push({ chatId: String(row.chat_id), data: JSON.parse(row.data) });
      } catch {
        // A corrupt row must not stop the other tables from coming back.
      }
    }
    return out;
  }

  remove(chatId) {
    this.q.del.run(String(chatId));
  }

  /**
   * A group promoted to a supergroup gets a brand new chat.id. Telegram sends
   * `migrate_to_chat_id` once; if the row is not re-keyed here, the table is
   * lost the moment the group is upgraded.
   */
  migrate(oldChatId, newChatId) {
    this.q.del.run(String(newChatId));
    this.q.rekey.run(String(newChatId), String(oldChatId));
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/** A drop-in that keeps nothing — used by tests that do not care about disk. */
export class NullStore {
  save() {}
  loadAll() {
    return [];
  }
  remove() {}
  migrate() {}
  close() {}
}
