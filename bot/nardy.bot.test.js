'use strict';
/**
 * Бот нардов (games/nardy/engine.js, bot.js): ходит только допустимыми
 * шагами, решает по своему виду (будущих кубиков не знает), уровни
 * различаются — и играет через тот же хаб, что человек.
 *
 * Партии бот-против-бота — через правила стола (те же проверки, что у
 * `handle`): ни одного отказа. Старшие пары лестницы — tools/nardy-ladder.mjs,
 * итоги в docs/nardy.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { playGame } from '../tools/nardy-ladder.mjs';
import bot from './games/nardy/bot.js';
import { chooseSequence } from './games/nardy/engine.js';
import { sequences } from './games/nardy/board.js';
import * as N from './games/nardy/rules.js';
import { nardyView } from './games/nardy/view.js';
import { abs, idx } from './games/nardy/board.js';
import { Table, user, botRandom } from './harness.js';

test('1000 партий новичков между собой — ни одного отказа сервера, все доиграны', () => {
  let refused = 0;
  let unfinished = 0;
  for (let g = 0; g < 1000; g++) {
    const r = playGame(0, 0, 50_000 + g);
    refused += r.refused.length;
    if (!r.winner) unfinished += 1;
  }
  assert.equal(refused, 0);
  assert.equal(unfinished, 0);
});

test('уровни значат: каждый следующий обыгрывает предыдущий (300 партий на пару); ни одного отказа', () => {
  // Каждый расклад кубиков — дважды, уровни меняются местами: удача достаётся
  // обоим поровну, и разница в силе видна на сотнях, а не тысячах партий.
  const tally = (a, b, n, seed) => {
    const out = { a: 0, b: 0, refused: 0 };
    for (let g = 0; g < n; g++) {
      for (const [x, y, flip] of [[a, b, false], [b, a, true]]) {
        const r = playGame(x, y, seed + g);
        out.refused += r.refused.length;
        if (!r.winner) continue;
        const firstWon = r.winner === '1';
        if (firstWon !== flip) out.a += 1;
        else out.b += 1;
      }
    }
    return out;
  };
  for (let level = 0; level < 4; level++) {
    const r = tally(level, level + 1, 150, 1_000 * (level + 1));
    assert.equal(r.refused, 0);
    assert.ok(r.b > r.a * 1.15, `${level + 1} против ${level}: ${r.b}:${r.a}`);
  }
});

test('бот решает только по виду: комнаты не видит, бросить просит без чисел', async () => {
  const room = N.createRoom({ chatId: 1, host: { id: 1, name: 'A' }, base: 0, side: 'white' });
  N.addPlayer(room, { id: 2, name: 'B' });
  N.startGame(room, '1', { dice: () => [5, 3] });
  const me = { id: '1', bot: { level: 3 } };
  // Комнаты в вызове нет вовсе: если бы бот смотрел в неё, он бы упал.
  let msg = bot.decide({ view: nardyView(room, '1', { now: 0 }), me, rng: botRandom(1) });
  assert.equal(msg.t, 'move');
  for (let i = 0; i < 2; i++) {
    assert.ok(N.move(room, '1', { from: msg.from, die: msg.die }, 0).ok);
    msg = bot.decide({ view: nardyView(room, '1', { now: 0 }), me, rng: botRandom(1) });
  }
  assert.deepEqual(msg, { t: 'end' });
  N.endTurn(room, '1', 0);
  const black = { id: '2', bot: { level: 3 } };
  const ask = bot.decide({ view: nardyView(room, '2', { now: 0 }), me: black, rng: botRandom(2) });
  assert.deepEqual(ask, { t: 'roll' }, 'на бросок — только просьба, чисел нет');
  // В виде нет ничего, похожего на будущие кубики.
  assert.equal(nardyView(room, '2', { now: 0 }).match.dice, null);
});

test('второй игрок на первом броске 6-6 снимает с головы две — бот считает это так же, как сервер', async () => {
  const room = N.createRoom({ chatId: 1, host: { id: 1, name: 'A' }, base: 0, side: 'white' });
  N.addPlayer(room, { id: 2, name: 'B' });
  N.startGame(room, '1', { dice: () => [5, 3] });
  for (const [from, die] of [[abs('w', 0), 5], [abs('w', 5), 3]]) N.move(room, '1', { from, die }, 0);
  N.endTurn(room, '1', 0);
  N.roll(room, '2', 0, { dice: () => [6, 6] });
  const me = { id: '2', bot: { level: 2 } };
  for (let i = 0; i < 2; i++) {
    const msg = bot.decide({ view: nardyView(room, '2', { now: 0 }), me, rng: botRandom(3) });
    assert.equal(msg.t, 'move');
    assert.ok(N.move(room, '2', { from: msg.from, die: msg.die }, 0).ok, `шаг ${i + 1} принят`);
  }
  assert.equal(room.match.turn.played.filter((s) => idx('b', s.from) === 0).length, 2, 'две с головы');
  assert.deepEqual(bot.decide({ view: nardyView(room, '2', { now: 0 }), me, rng: botRandom(3) }), { t: 'end' });
});

test('шаги бота — одной последовательности: следующий всегда продолжает уже сыгранное', () => {
  const room = N.createRoom({ chatId: 1, host: { id: 1, name: 'A' }, base: 0, side: 'white' });
  N.addPlayer(room, { id: 2, name: 'B' });
  N.startGame(room, '1', { dice: () => [6, 5] });
  N.move(room, '1', { from: abs('w', 0), die: 6 }, 0);
  N.move(room, '1', { from: abs('w', 6), die: 5 }, 0);
  N.endTurn(room, '1', 0);
  N.roll(room, '2', 0, { dice: () => [4, 2] });
  N.move(room, '2', { from: abs('b', 0), die: 4 }, 0);
  N.move(room, '2', { from: abs('b', 4), die: 2 }, 0);
  N.endTurn(room, '2', 0);
  N.roll(room, '1', 0, { dice: () => [6, 3] });
  // «Новичок» выбирает наугад; передумай он между шагами, следующий шаг всё
  // равно берётся только из последовательностей, начатых уже сыгранным.
  const me = { id: '1', bot: { level: 0 } };
  for (let seed = 1; seed <= 20; seed++) {
    const r2 = N.deserialize(JSON.parse(JSON.stringify(N.serialize(room, 0))));
    let rng = 0;
    const rnd = botRandom(seed);
    for (let i = 0; i < 2; i++) {
      const msg = bot.decide({ view: nardyView(r2, '1', { now: 0 }), me, rng: () => { rng += 1; return rnd(); } });
      assert.ok(N.move(r2, '1', { from: msg.from, die: msg.die }, 0).ok, `seed ${seed}, шаг ${i + 1}`);
    }
    assert.equal(N.turnState(r2.match).phase, 'done');
  }
});

test('выбор посреди хода продолжает уже сыгранное — на любом уровне и при любом зерне', () => {
  const start = { b: Array(24).fill(0), off: { w: 0, b: 0 }, t: 'w' };
  for (const [i, n] of [[0, 9], [3, 2], [7, 2], [11, 2]]) start.b[abs('w', i)] = n;
  start.b[abs('b', 0)] = -15;
  const dice = [6, 3];
  const all = sequences(start, dice).seqs;
  for (const seq of all) {
    for (let level = 0; level < 5; level++) {
      for (let seed = 1; seed <= 5; seed++) {
        const got = chooseSequence(start, dice, [seq[0]], level, { seed });
        assert.deepEqual(got[0], seq[0], `уровень ${level}, зерно ${seed}`);
      }
    }
  }
});

/* ---------------------------------------------------- через хаб, как человек */

const IVAN = user(101, 'Иван');

async function untilTurn(t, room, color, tries = 80) {
  for (let i = 0; i < tries && !(room.match.turn.c === color && !room.match.turn.dice); i++) {
    await t.advance(1_000);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('нарды против бота из лички: бот бросает, ходит и жмёт «Готово» сам; за бота не сходить', async () => {
  const pairs = [[5, 3], [4, 2], [6, 1]];
  const t = new Table({ botRng: botRandom(4), nardyDice: () => pairs.shift() || [2, 1] });
  await t.start(IVAN);
  t.openSolo(IVAN);
  await t.send(IVAN, { t: 'play', game: 'nardy', settings: { level: 1, side: 'white' } });
  const room = t.app.soloOf('101');
  assert.equal(room.game, 'nardy');
  assert.ok(room.players.find((p) => p.bot));
  assert.equal(t.state(IVAN).me.color, 'w');
  // Ход белых (человек, 5 против 3). Сыграть 1/6 6/9.
  await t.send(IVAN, { t: 'move', from: abs('w', 0), die: 5, turn: 0 });
  await t.send(IVAN, { t: 'move', from: abs('w', 5), die: 3, turn: 0 });
  await t.send(IVAN, { t: 'end' });
  // Пока бот не сходил — человек за него не бросит и не сходит.
  await t.send(IVAN, { t: 'roll', uid: 'bot1' });
  assert.equal(t.lastError(IVAN).code, 'NOT_YOUR_TURN');
  await untilTurn(t, room, 'w');
  assert.equal(room.match.log.length, 2, 'бот сыграл ход целиком');
  assert.deepEqual(room.match.log[1].dice, [4, 2], 'кубики бота — с сервера');
  assert.equal(room.match.log[1].steps.length, 2);
  assert.equal(t.app.store.ratingOf?.(101, 'nardy') ?? null, null, 'партия с ботом не в рейтинге');
});
