'use strict';
/**
 * UNOQ против ботов.
 *
 *   ЧЕСТНО. Каждый вид, по которому бот решал, — его рука и открытое на
 *   столе; ни одной карты из чужих рук.
 *
 *   «UNOQ!» И «ПОЙМАЛ!» — ПО ПРАВИЛАМ. Бот кричит за себя, ловит другого и
 *   только в срок. Профи кричит сразу — человек его не поймает; новичок
 *   медлит — поймать можно. Человек, промолчавший с одной картой, будет пойман.
 *
 *   УРОВНИ ЗНАЧАТ. Профи против новичка проигрывает заметно реже.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, botRandom, colorsDecks, colorsRandom } from './harness.js';
import * as C from './games/colors/rules.js';
import { colorsView } from './games/colors/view.js';
import { GAMES } from './games/index.js';
import colorsBot, { LEVELS, decideColors } from './games/colors/bot.js';
import { shuffled } from './games/colors/cards.js';
import { seededRng } from './deck.js';

const IVAN = user(101, 'Иван');
const g = GAMES.colors;

async function colorsVsBots(t, settings) {
  await t.start(IVAN);
  t.openSolo(IVAN);
  await t.send(IVAN, { t: 'play', game: 'colors', settings });
  return t.app.soloOf('101');
}

/** Простой человек: кладёт первую подходящую, со взятой — играет, иначе берёт; кричит сразу. */
function simple(s, { shout = true } = {}) {
  const l = s.legal;
  if (!l) return null;
  if (shout && l.shout) return { t: 'shout' };
  if (!l.myTurn) return null;
  if (l.play.length) return { t: 'play', card: l.play[0], color: 'R' };
  if (l.draw) return { t: 'draw' };
  if (l.pass) return { t: 'pass' };
  return null;
}

async function playSeries(t, room, games, { steps = 3000, shout = true } = {}) {
  for (let i = 0; i < steps; i++) {
    const s = t.state(IVAN);
    if (s.deal?.phase === 'over' && room.gameNo >= games) break;
    const m = simple(s, { shout });
    if (m && s.deal?.phase === 'play') await t.send(IVAN, { ...m, seq: s.seq });
    else if (s.canNext) await t.send(IVAN, { t: 'next' });
    else await t.advance(1_500);
  }
}

function spyOnBots() {
  const seen = [];
  const original = g.bot.decide;
  g.bot.decide = (args) => {
    const msg = original(args);
    seen.push({ id: args.me.id, kind: args.wait.kind, view: structuredClone(args.view), hands: structuredClone(args.room.deal.hands), msg });
    return msg;
  };
  return { seen, restore: () => { g.bot.decide = original; } };
}

const CARD = /"([RYGB][0-9SVP]|WC|WF)"/g;

test('выбор: 4 уровня с подсказками, до семи соперников', () => {
  const cat = colorsBot.catalog();
  assert.deepEqual(cat.levels, LEVELS.map((l) => l.name));
  assert.equal(cat.levelHints.length, 4);
  assert.equal(cat.maxOpponents, 7);
  assert.equal(colorsBot.lineup({ opponents: 20 }).length, 7);
  assert.equal(colorsBot.lineup({ opponents: 0 }).length, 1);
  assert.ok(colorsBot.lineup({ opponents: 2, level: 7 }).every((x) => x.level === 3));
});

test('UNOQ с ботами: серия идёт, боты решают по своей руке и открытому столу', async () => {
  const t = new Table({ botRng: botRandom(4), colorsDeck: colorsDecks(4), colorsRand: colorsRandom(4) });
  const spy = spyOnBots();
  try {
    const room = await colorsVsBots(t, { opponents: 3, level: 2 });
    assert.ok(room.solo);
    assert.equal(room.players.filter((p) => p.bot).length, 3);
    assert.equal(room.status, 'playing');
    await playSeries(t, room, 3);
    assert.ok(room.history.length >= 3, `сыграно партий: ${room.history.length}`);
    assert.ok(spy.seen.length > 40, `ботам пришлось решать: ${spy.seen.length}`);
    for (const { id, view, hands } of spy.seen) {
      assert.deepEqual([...view.me.cards].sort(), [...hands[id]].sort(), 'в виде — рука самого бота');
      const allowed = new Set([...hands[id], view.deal.top, ...view.deal.events.map((e) => e.card).filter(Boolean)]);
      for (const [, c] of JSON.stringify(view).matchAll(CARD)) assert.ok(allowed.has(c), `${id} увидел чужую карту ${c}`);
    }
    assert.ok(spy.seen.filter((x) => x.kind === 'turn' || x.kind === 'pending').every((x) => x.msg), 'на ход бот всегда находит ответ');
    assert.ok(spy.seen.some((x) => x.kind === 'shout'), 'боты кричат «UNOQ!»');
    assert.deepEqual(t.errors, [], 'ни один ход бота не отклонён');
    assert.ok([...t.tg.messages.values()].every((m) => m.chatId === '101'), 'в группы — ни слова');
    assert.deepEqual(t.app.rate(room), []);
  } finally {
    spy.restore();
  }
});

test('человек промолчал с одной картой — бот его ловит; профи кричит сразу, и его не поймать', async () => {
  const t = new Table({ botRng: botRandom(9), colorsDeck: colorsDecks(9), colorsRand: colorsRandom(9) });
  const room = await colorsVsBots(t, { opponents: 2, level: 3 });
  // Играем, не нажимая «UNOQ!», пока бот не поймает.
  let caught = false;
  for (let i = 0; i < 3000 && !caught; i++) {
    const s = t.state(IVAN);
    caught = (room.deal?.events || []).some((e) => e.kind === 'caught' && e.target === '101');
    if (caught) break;
    const m = simple(s, { shout: false });
    if (m && s.deal?.phase === 'play') await t.send(IVAN, { ...m, seq: s.seq });
    else if (s.canNext) await t.send(IVAN, { t: 'next' });
    else await t.advance(500);
  }
  assert.ok(caught, 'промолчавшего человека поймали');

  // Профи с одной картой кричит раньше, чем человек успевает поймать.
  const calls = [];
  for (let i = 0; i < 3000 && calls.length < 3; i++) {
    const d = room.deal;
    const c = d?.call;
    if (c && room.players.find((p) => p.id === c.id)?.bot && !calls.includes(c.at)) {
      calls.push(c.at);
      await t.advance(1_000); // человек тянется к кнопке через секунду
      await t.send(IVAN, { t: 'catch' });
      assert.equal(t.lastError(IVAN).code, 'NOTHING_TO_CATCH', 'профи уже крикнул');
    }
    const s = t.state(IVAN);
    const m = simple(s);
    if (m && s.deal?.phase === 'play') await t.send(IVAN, { ...m, seq: s.seq });
    else if (s.canNext) await t.send(IVAN, { t: 'next' });
    else await t.advance(300);
  }
  assert.equal(calls.length, 3, 'профи трижды оставался с одной картой');
});

test('новичок медлит с «UNOQ!» — человек успевает поймать', async () => {
  const t = new Table({ botRng: botRandom(2), colorsDeck: colorsDecks(2), colorsRand: colorsRandom(2) });
  const room = await colorsVsBots(t, { opponents: 2, level: 0 });
  let caught = 0;
  for (let i = 0; i < 4000 && caught < 2; i++) {
    const c = room.deal?.call;
    if (c && !c.called && room.players.find((p) => p.id === c.id)?.bot) {
      await t.advance(1_000);
      await t.send(IVAN, { t: 'catch' });
      if (!t.lastError(IVAN) || t.lastError(IVAN).code !== 'NOTHING_TO_CATCH') caught++;
      t.page(IVAN).inbox.length = 0;
      continue;
    }
    const s = t.state(IVAN);
    const m = s && simple(s);
    if (m && s.deal?.phase === 'play') await t.send(IVAN, { ...m, seq: s.seq });
    else if (s?.canNext) await t.send(IVAN, { t: 'next' });
    else await t.advance(300);
  }
  assert.ok(caught >= 2, `новичка поймали ${caught} раз`);
});

test('человек не ходит за бота и не правит стол с ботами', async () => {
  const t = new Table({ botRng: botRandom(3), colorsDeck: colorsDecks(3), colorsRand: colorsRandom(3) });
  const room = await colorsVsBots(t, { opponents: 2, level: 1 });
  const botId = room.deal.order.find((id) => id !== '101');
  const card = room.deal.hands[botId][0];
  await t.send(IVAN, { t: 'play', card, color: 'R', seq: room.seq });
  assert.ok(['NOT_YOUR_CARD', 'NOT_YOUR_TURN', 'CANNOT_PLAY'].includes(t.lastError(IVAN).code));
  assert.ok(room.deal.hands[botId].includes(card), 'карта бота на месте');
  for (const msg of [{ t: 'settings', stacking: false }, { t: 'kick', seat: 1 }, { t: 'abort' }, { t: 'leave' }]) {
    await t.send(IVAN, msg);
    assert.equal(t.lastError(IVAN).code, 'SOLO_ONLY', msg.t);
  }
  assert.equal(room.settings.stacking, true);
});

/** Партия ботов между собой — прямо по правилам; возвращает id последнего. */
function duel(levels, seed) {
  const rng = botRandom(seed);
  const room = C.createRoom({ chatId: 'x', host: { id: 'a', name: 'A' } });
  room.players.length = 0;
  C.addPlayer(room, { id: 'a', name: 'A' });
  C.addPlayer(room, { id: 'b', name: 'B' });
  room.hostId = 'a';
  const spec = { a: { level: levels.a }, b: { level: levels.b } };
  const randInt = seededRng(seed);
  assert.ok(C.startGame(room, 'a', { deck: () => shuffled(randInt), randInt }).ok);
  let now = 1_000_000;
  for (let i = 0; i < 3000 && room.deal.phase === 'play'; i++) {
    now += 1000;
    // Крик: профи кричит всегда, новичок забывает; поймать — по тем же правилам.
    const c = room.deal.call;
    if (c && !c.called) {
      const L = LEVELS[spec[c.id].level];
      if (rng() * 7000 > L.shout[0] + 1000) C.shout(room, c.id, { now });
      else C.catchShout(room, c.id === 'a' ? 'b' : 'a', { now: c.at + 1000, randInt });
    }
    const w = g.waiting(room)[0];
    if (!w) break;
    const view = colorsView(room, w.id, { now });
    const m = decideColors(view, spec[w.id], w, rng) || colorsBot.fallback(view, w);
    const r = m.t === 'play' ? C.play(room, w.id, m.card, { color: m.color, seq: m.seq, now, randInt })
      : m.t === 'draw' ? C.draw(room, w.id, { seq: m.seq, now, randInt }) : C.pass(room, w.id, { seq: m.seq, now, randInt });
    assert.ok(!r.error, `ход бота отклонён: ${r.error}`);
  }
  assert.equal(room.deal.phase, 'over');
  return room.deal.loser;
}

test('уровни значат: профи против новичка остаётся последним заметно реже', () => {
  let pro = 0;
  let novice = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const proIs = seed % 2 ? 'a' : 'b';
    const loser = duel(proIs === 'a' ? { a: 3, b: 0 } : { a: 0, b: 3 }, seed);
    if (loser === proIs) pro++;
    else if (loser) novice++;
  }
  assert.ok(novice > pro * 1.2, `последним: новичок ${novice}, профи ${pro}`);
});
