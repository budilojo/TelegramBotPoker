'use strict';
/**
 * Аудит, фаза 3 (D, рейтинг): как рейтинг можно обойти — ЗАМЫСЕЛ, а не баг.
 *
 * Эти тесты не чинят, а фиксируют нынешнее поведение, чтобы владелец решал,
 * глядя на запуск, а не на пересказ (docs/audit/findings.md, D-02…D-04).
 * Рейтинг сейчас закрыт для игроков (`RATING_SOON`), очки при этом пишутся.
 * Поменяется замысел — меняются и эти тесты.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { apply, PER_DAY } from './rating.js';
import { NullStore } from './store.js';
import poker from './games/poker/index.js';
import * as R from './room.js';

test('АУДИТ D-02 (замысел): в покере вышедший из группы перед концом не получает −10 — минус уходит следующему', () => {
  const room = R.createRoom({ chatId: '-1', host: { id: 1, name: 'Хост' } });
  for (const [id, name] of [[2, 'Вася'], [3, 'Петя']]) R.addPlayer(room, { id, name });
  room.status = 'finished';
  // Итог вечера: Петя проиграл больше всех — и вышел из группы до конца.
  const [host, vasya, petya] = room.players;
  for (const p of room.players) p.stats.handsPlayed = 5;
  host.stack = 18000;
  vasya.stack = 9000;
  petya.stack = 3000;
  petya.left = true;
  const [round] = poker.rounds(room);
  assert.deepEqual(round.places.map((p) => p.id), ['1', '2'], 'Пети в местах нет');
  assert.equal(round.loserId, '2', '«последним» стал Вася — его −10');
});

test('АУДИТ D-03 (замысел): в дураке выход из группы посреди партии отменяет её — очков нет ни у кого', async () => {
  const t = new Table();
  const [a, b, c] = [user(101, 'А'), user(102, 'Б'), user(103, 'В')];
  await t.cmd(a, '/game');
  await t.cmd(a, '/durak');
  const room = t.durak;
  for (const u of [b, c]) {
    t.openRoom(u, room);
    await t.send(u, { t: 'sit' });
  }
  t.openRoom(a, room);
  await t.send(a, { t: 'start' });
  await t.raw({ message: { message_id: t.tg.nextId++, chat: { id: t.chatId, type: 'supergroup' }, from: c, left_chat_member: c, date: 1 } });
  assert.equal(room.deal.phase, 'over');
  assert.equal(room.deal.aborted, true, 'партия отменена');
  assert.equal(Object.values(room.rated)[0].skipped, 'ABORTED', 'никто не получил очков');
});

test(`АУДИТ D-04 (замысел): предел ${PER_DAY} партий в сутки — на СОСТАВ; с подставными аккаунтами победы копятся без предела`, () => {
  const store = new NullStore();
  const at = Date.UTC(2026, 9, 19, 12);
  let wins = 0;
  for (let alt = 0; alt < 5; alt++) {
    for (let i = 0; i < PER_DAY + 2; i++) {
      const r = apply(store, {
        game: 'durak', round: `alt${alt}#${i}`, at, loserId: `alt${alt}`,
        places: [{ id: 'main', name: 'Накрутчик' }, { id: `alt${alt}`, name: `Подставной ${alt}` }],
      });
      if (r.ok) wins += 1;
    }
  }
  assert.equal(wins, 5 * PER_DAY, `за сутки ${wins} зачётных побед: по ${PER_DAY} с каждым подставным`);
});
