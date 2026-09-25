'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from './store.js';
import { createRoom, addPlayer, startGame, serialize, deserialize } from './room.js';

function sample() {
  const room = createRoom({ chatId: -1001, host: { id: 1, name: 'Иван' } });
  addPlayer(room, { id: 2, name: 'Макс' });
  addPlayer(room, { id: 3, name: 'Дима' });
  startGame(room, 1);
  return room;
}

test('a room survives a round trip through the database', () => {
  const db = new Store(':memory:');
  const room = sample();
  db.save(room, serialize(room));

  const [row] = db.loadAll();
  const back = deserialize(row.data);
  assert.equal(back.handNo, room.handNo);
  assert.equal(back.hand.actorId, room.hand.actorId);
  assert.deepEqual(back.players.map((p) => p.stack), room.players.map((p) => p.stack));
  assert.equal(back.hostId, room.hostId);
  db.close();
});

test('a restart does not bill the table for time the bot was down', () => {
  const db = new Store(':memory:');
  const room = sample();
  room.settings.blindMode = 'levels';
  room.level = { index: 0, elapsedMs: 60_000, runningSince: Date.now() - 5_000 };

  const frozen = serialize(room);
  assert.equal(frozen.level.runningSince, null, 'the clock is parked on the way out');
  assert.ok(frozen.level.elapsedMs >= 65_000, 'and the time played so far is kept');

  const back = deserialize(frozen);
  assert.ok(back.level.runningSince, 'the clock restarts on the way back in');
  db.close();
});

test('a ForceReply prompt does not survive a restart', () => {
  const room = sample();
  room.ui.pendingBet = { userId: '2', promptMessageId: 42 };
  room.ui.armedAllIn = { userId: '2' };
  const back = deserialize(serialize(room));
  assert.equal(back.ui.pendingBet, null, 'the prompt message is long gone');
  assert.equal(back.ui.armedAllIn, null, 'and an armed all-in must be re-armed deliberately');
});

test('a restored room is redrawn rather than assumed unchanged', () => {
  const room = sample();
  room.ui.lastText = 'whatever was on screen';
  const back = deserialize(serialize(room));
  assert.equal(back.ui.lastText, null, 'so the first draw after a restart actually happens');
  assert.equal(back.ui.tableMessageId, room.ui.tableMessageId, 'but it edits the same message');
});

test('a supergroup migration re-keys the row', () => {
  const db = new Store(':memory:');
  const room = sample();
  db.save(room, serialize(room));
  db.migrate('-1001', '-1009999');
  const rows = db.loadAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chatId, '-1009999');
  db.close();
});

test('a corrupt row does not take the other tables down with it', () => {
  const db = new Store(':memory:');
  const room = sample();
  db.save(room, serialize(room));
  db.db.prepare('INSERT INTO rooms (chat_id, data, status, updated_at) VALUES (?,?,?,?)')
    .run('-777', '{not json', 'playing', Date.now());

  const rows = db.loadAll();
  assert.equal(rows.length, 1, 'the good room still loads');
  assert.equal(rows[0].chatId, '-1001');
  db.close();
});

test('saving twice updates in place instead of duplicating', () => {
  const db = new Store(':memory:');
  const room = sample();
  db.save(room, serialize(room));
  room.players[0].stack = 12345;
  db.save(room, serialize(room));
  const rows = db.loadAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.players[0].stack, 12345);
  db.close();
});

test('it creates its own directory on first run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chiptable-'));
  const file = path.join(dir, 'nested', 'bot.db');
  const db = new Store(file);
  const room = sample();
  db.save(room, serialize(room));
  db.close();

  assert.ok(fs.existsSync(file));
  const again = new Store(file);
  assert.equal(again.loadAll().length, 1, 'and the data is really on disk');
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
