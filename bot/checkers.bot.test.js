'use strict';
/**
 * Бот шашек (games/checkers/engine.js, bot.js): ходит только законно, видит
 * простое, уровни различаются — и играет через тот же хаб, что человек.
 *
 * «Законно» проверяется тысячами партий бот-против-бота через правила стола
 * (rules.move — те же проверки, что у `handle`): ни одного отказа. Лестница
 * уровней здесь — для младших (быстро); старшие пары — в
 * tools/checkers-ladder.mjs, итоги записаны в docs/checkers.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bestMove, LEVELS } from './games/checkers/engine.js';
import * as C from './games/checkers/rules.js';
import { fromFen, legalMoves, make, notation, sqName, startPosition, toFen } from './games/checkers/board.js';
import { seededRng } from './deck.js';
import { Table, user, botRandom } from './harness.js';
import bot from './games/checkers/bot.js';
import { key } from './games/checkers/board.js';

const IVAN = user(101, 'Иван');
const asNotation = (fen, r) => notation(legalMoves(fromFen(fen)).find((m) => m.from === r.from && m.to === r.to && m.caps.join() === r.caps.join()));

/** Партии бот-против-бота через правила стола. Возвращает счёт и число отказов. */
function match(levelA, levelB, games, { timeMs = 20, seed = 1 } = {}) {
  const out = { a: 0, b: 0, draw: 0, refused: [] };
  for (let g = 0; g < games; g++) {
    const room = C.createRoom({ chatId: 1, host: { id: 1, name: 'A' }, base: 0, side: g % 2 ? 'white' : 'black' });
    C.addPlayer(room, { id: 2, name: 'B' });
    C.startGame(room, '1', { rand: () => 0.1 });
    for (let guard = 0; C.live(room) && guard < 600; guard++) {
      const m = room.match;
      const id = m.pos.t === 'w' ? m.white : m.black;
      const mv = bestMove(toFen(m.pos), id === '1' ? levelA : levelB, { seed: seed * 100_000 + g * 1000 + guard, timeMs });
      const r = C.move(room, id, { from: sqName(mv.from), to: sqName(mv.to), path: mv.path.map(sqName) }, 0);
      if (r.error) {
        out.refused.push(`${toFen(m.pos)} ${sqName(mv.from)}-${sqName(mv.to)}: ${r.error}`);
        break;
      }
    }
    const o = room.match.over;
    if (!o?.winner) out.draw += 1;
    else if ((o.winner === 'w' ? room.match.white : room.match.black) === '1') out.a += 1;
    else out.b += 1;
  }
  return out;
}

test('2000 партий новичков между собой — ни одного отказа сервера; партии кончаются', () => {
  const r = match(0, 0, 2000);
  assert.deepEqual(r.refused, []);
  assert.ok(r.a + r.b > 1500, `большинство партий — с победителем (${r.a + r.b} из 2000)`);
});

test('уровни значат, и ни одного отказа: любитель обыгрывает новичка (180 партий), клубный — любителя (24)', () => {
  const low = match(0, 1, 180, { seed: 3 });
  const mid = match(1, 2, 24, { seed: 5, timeMs: 25 });
  assert.deepEqual([...low.refused, ...mid.refused], [], 'серии с путём проходят у сервера');
  assert.ok(low.b > low.a * 3, `любитель против новичка: ${low.b}:${low.a}`);
  assert.ok(mid.b > mid.a * 2, `клубный против любителя: ${mid.b}:${mid.a}`);
});

test('из двух серий сильнее уровни берут ту, что бьёт больше, если ответа нет', () => {
  // c3:e5 (одна) или c3:a5:c7 (две); после двух отыграться нечем.
  const fen = 'W:Wc3,g1:Bd4,b4,b6,h8';
  for (let l = 1; l < LEVELS.length; l++) {
    for (let seed = 1; seed <= 3; seed++) assert.equal(asNotation(fen, bestMove(fen, l, { seed, timeMs: 200 })), 'c3:a5:c7', `${LEVELS[l].name}, seed ${seed}`);
  }
});

test('бот никогда не делает незаконного хода: 60 случайных позиций, все уровни', () => {
  const rnd = seededRng(13);
  for (let game = 0; game < 60; game++) {
    let pos = startPosition();
    const plies = 4 + Math.floor(rnd() * 60);
    for (let i = 0; i < plies; i++) {
      const moves = legalMoves(pos);
      if (!moves.length) break;
      pos = make(pos, moves[Math.floor(rnd() * moves.length)]);
    }
    const legal = legalMoves(pos);
    if (!legal.length) continue;
    const level = game % LEVELS.length;
    const r = bestMove(toFen(pos), level, { seed: game + 1, timeMs: 60 });
    assert.ok(legal.some((m) => m.from === r.from && m.to === r.to && m.caps.join() === r.caps.join()), `позиция ${toFen(pos)}`);
    // Если бить надо — бот бьёт, на любом уровне.
    if (legal[0].caps.length) assert.ok(r.caps.length > 0, `${LEVELS[level].name} пропустил взятие в ${toFen(pos)}`);
  }
});

test('сообщение бота принимает сервер и там, где на одно поле ведут две серии', async () => {
  // Дамка d8 → f2 через f6 и d4 или через b6: без пути сервер ответил бы NEED_PATH.
  let twins = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const room = C.createRoom({ chatId: 1, host: { id: 1, name: 'Иван' }, base: 0, side: 'black' });
    const me = C.addPlayer(room, { id: 'bot1', name: 'бот' });
    me.bot = { type: 'engine', level: 0 };
    C.startGame(room, '1', { rand: () => 0.1 });
    room.match.pos = fromFen('W:WKh4,Kd8:Bg1,e3,a5,e5,c7,e7');
    room.match.seen = { [key(room.match.pos)]: 1 };
    const msg = await bot.decide({ room, me, wait: { kind: 'move' }, rng: botRandom(seed) });
    if (msg.to === 'f2') twins += 1;
    const r = C.move(room, me.id, { from: msg.from, to: msg.to, path: msg.path }, 0);
    assert.ok(r.ok, `seed ${seed}: ${msg.from}-${msg.to} → ${r.error}`);
  }
  assert.ok(twins > 0, 'бот хоть раз выбрал серию-двойника — проверка что-то проверила');
});

test('нет ходов — нет ответа', () => {
  assert.equal(bestMove('B:Wg7,f6,e5:Bh8', 3), null);
  assert.equal(bestMove('B:Wd4:B', 3), null);
});

test('время на ход ограничено: «мастер» укладывается в срок с запасом', () => {
  const t = Date.now();
  bestMove(toFen(startPosition()), 4, { timeMs: 300 });
  assert.ok(Date.now() - t < 1500, `уложился за ${Date.now() - t} мс при лимите 300`);
});

/* ---------------------------------------------------- через хаб, как человек */

async function botMoves(t, room, plies, tries = 60) {
  for (let i = 0; i < tries && room.match.moves.length < plies; i++) {
    await t.advance(1_000);
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(room.match.moves.length, plies, 'бот сходил');
}

async function vsBot(t, settings = { level: 0, side: 'white' }) {
  await t.start(IVAN);
  t.openSolo(IVAN);
  await t.send(IVAN, { t: 'play', game: 'checkers', settings });
  return t.app.soloOf('101');
}

test('шашки против бота из лички: человек белыми, бот отвечает сам через тот же хаб', async () => {
  const t = new Table({ botRng: botRandom(3) });
  const room = await vsBot(t);
  assert.ok(room.solo);
  assert.equal(room.game, 'checkers');
  assert.ok(room.players.find((p) => p.bot), 'второй — бот');
  assert.equal(t.state(IVAN).me.color, 'w');
  await t.send(IVAN, { t: 'move', from: 'c3', to: 'd4', ply: 0 });
  await botMoves(t, room, 2);
  assert.ok(room.match.moves[1].n, 'бот сходил записью');
  // Партия с ботом в рейтинг не идёт.
  assert.equal(t.app.store.ratingOf?.(101, 'checkers') ?? null, null);
});

test('бот белыми ходит первым сам; человек за бота не ходит', async () => {
  const t = new Table({ botRng: botRandom(5) });
  const room = await vsBot(t, { level: 1, side: 'black' });
  assert.equal(t.state(IVAN).me.color, 'b');
  // Ход белых — бота. Человек пытается сходить за него, назвавшись им, — отказ.
  await t.send(IVAN, { t: 'move', from: 'e3', to: 'f4', ply: 0, uid: 'bot1', id: 'bot1', color: 'w' });
  assert.equal(t.lastError(IVAN).code, 'NOT_YOUR_TURN');
  assert.equal(room.match.moves.length, 0);
  await botMoves(t, room, 1);
});

test('бот отвечает на ничью и на просьбу вернуть ход', async () => {
  const t = new Table({ botRng: botRandom(8) });
  const room = await vsBot(t, { level: 0, side: 'white' });
  await t.send(IVAN, { t: 'move', from: 'c3', to: 'd4', ply: 0 });
  await botMoves(t, room, 2);
  await t.send(IVAN, { t: 'takeback' });
  for (let i = 0; i < 10 && room.match.takeback; i++) await t.advance(1_000);
  assert.equal(room.match.takeback, null, 'на откат ответил');
  assert.ok(room.match.moves.length === 0 || room.match.moves.length === 2, 'новичок разрешает вернуть — или ход остаётся');
  // Ничья: доиграть до двух ходов, предложить — бот отвечает (принимает или отклоняет).
  while (room.match.moves.length < 2) {
    if (room.match.pos.t === 'w') await t.send(IVAN, { t: 'move', ...firstMove(t), ply: room.match.moves.length });
    else await botMoves(t, room, room.match.moves.length + 1);
  }
  await t.send(IVAN, { t: 'draw' });
  assert.ok(room.match.drawOffer, 'предложение висит');
  for (let i = 0; i < 10 && room.match.drawOffer && !room.match.over; i++) await t.advance(1_000);
  assert.ok(!room.match.drawOffer, 'на ничью ответил');
});

/** Первый законный ход, который страница видит у человека. */
function firstMove(t) {
  const mv = t.state(IVAN).legal.moves[0];
  return { from: mv.from, to: mv.to, path: mv.path };
}
