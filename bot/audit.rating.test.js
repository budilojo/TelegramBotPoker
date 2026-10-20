'use strict';
/**
 * Аудит, фаза 3 (D, рейтинг): как рейтинг можно было обойти — и решение
 * владельца (20.10.2026), как закрыто (docs/audit/findings.md, D-02…D-04):
 *
 *   D-02 — ушедший из группы перед концом остаётся в местах (покер — со своим
 *          стеком, UNOQ — последним) и получает свой минус;
 *   D-03 — дурак: ушедший посреди партии — дурак, остальным партия засчитана;
 *   D-04 — предел: не больше 10 партий с очками в плюс у ОДНОГО человека в
 *          сутки в одной игре — подставные аккаунты его не обходят.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { apply, PER_DAY } from './rating.js';
import { NullStore, Store } from './store.js';
import poker from './games/poker/index.js';
import * as R from './room.js';

test('АУДИТ D-02: в покере вышедший из группы перед концом остаётся в местах и получает свой −10', () => {
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
  assert.deepEqual(round.places.map((p) => p.id), ['1', '2', '3'], 'Петя на своём месте');
  assert.equal(round.loserId, '3', '−10 — Пете, а не Васе');
  // Удалённого хостом в местах нет — это решение хоста, а не бегство.
  petya.left = false;
  petya.kicked = true;
  assert.deepEqual(poker.rounds(room)[0].places.map((p) => p.id), ['1', '2']);
});

test('АУДИТ D-03: в дураке ушедший из группы посреди партии — дурак, остальным партия засчитана', async () => {
  const t = new Table({ store: new Store(':memory:') });
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
  assert.ok(!room.deal.aborted, 'партия не отменена');
  assert.equal(room.deal.fool, '103', 'ушедший — дурак');
  const rated = Object.values(room.rated)[0];
  assert.ok(rated.ok, 'партия засчитана');
  assert.equal(rated.rows.find((r) => r.userId === '103').delta, -10);
  assert.ok(rated.rows.filter((r) => r.userId !== '103').every((r) => r.delta > 0), 'остальным — плюс');
  assert.match(room.notice, /В вышел из чата посреди партии — он дурак/);
  t.app.store.close();
});

test('АУДИТ D-03: в дураке удалённый хостом посреди партии — партия по-прежнему не засчитывается', async () => {
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
  await t.send(a, { t: 'kick', seat: 2 });
  assert.equal(room.deal.aborted, true);
});

test('АУДИТ D-02: UNOQ вдвоём — ушедший из группы проигрывает, партия засчитана; втроём — он последний', async () => {
  for (const n of [2, 3]) {
    const t = new Table({ store: new Store(':memory:') });
    const cast = [user(101, 'А'), user(102, 'Б'), user(103, 'В')].slice(0, n);
    await t.cmd(cast[0], '/game');
    await t.cmd(cast[0], '/unoq');
    const room = t.colors;
    for (const u of cast.slice(1)) {
      t.openRoom(u, room);
      await t.send(u, { t: 'sit' });
    }
    t.openRoom(cast[0], room);
    await t.send(cast[0], { t: 'start' });
    const leaver = cast[1];
    await t.raw({ message: { message_id: t.tg.nextId++, chat: { id: t.chatId, type: 'supergroup' }, from: leaver, left_chat_member: leaver, date: 1 } });
    if (n === 3) {
      // Втроём двое доигрывают; места — по истории партии, где ушедший в списке «ушли».
      assert.equal(room.deal.phase, 'play', 'втроём партия идёт дальше');
      assert.deepEqual(room.deal.quit, ['102']);
      const [round] = (await import('./games/colors/index.js')).default.rounds({ ...room, history: [{ no: 1, loser: '103', out: ['101', '103'], quit: ['102'] }] });
      assert.deepEqual(round.places.map((p) => p.id), ['101', '103', '102'], 'ушедший — последний');
      assert.equal(round.loserId, '102');
    } else {
      assert.equal(room.deal.phase, 'over');
      assert.ok(!room.deal.aborted, 'вдвоём партия не отменена');
      const rated = Object.values(room.rated)[0];
      assert.ok(rated.ok, `засчитана: ${rated.why}`);
      assert.deepEqual(rated.rows.map((r) => [r.userId, r.delta]), [['101', 20], ['102', -10]]);
    }
    t.app.store.close();
  }
});

test(`АУДИТ D-04: не больше ${PER_DAY} партий с очками в плюс у одного человека в сутки — подставные аккаунты не помогают`, () => {
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
  assert.equal(wins, PER_DAY, `за сутки ${wins} зачётных побед — как с одним соперником`);
  // Вторые места в плюс — тоже в счёт: «пусть подставной выигрывает, а я вторым» не проходит.
  let seconds = 0;
  for (let i = 0; i < PER_DAY + 3; i++) {
    const r = apply(store, {
      game: 'colors', round: `s#${i}`, at, loserId: `x${i}`,
      places: [{ id: `w${i}` }, { id: 'main2' }, { id: `x${i}` }],
    });
    if (r.ok) seconds += 1;
    else assert.equal(r.skipped, 'GAINED');
  }
  assert.equal(seconds, PER_DAY);
  // На следующий день — снова можно.
  const next = apply(store, { game: 'durak', round: 'tomorrow', at: at + 86_400_000, loserId: 'altX', places: [{ id: 'main' }, { id: 'altX' }] });
  assert.ok(next.ok);
  // Другая игра — свой счёт.
  assert.ok(apply(store, { game: 'chess', round: 'c1', at, loserId: 'alt0', places: [{ id: 'main' }, { id: 'alt0' }] }).ok);
});
