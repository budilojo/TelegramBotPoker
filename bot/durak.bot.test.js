'use strict';
/**
 * Дурак против ботов.
 *
 *   ЧЕСТНО. Каждый вид, по которому бот решал за серию, проверяется: в нём
 *   его карты, открытый стол и козырь — и ни одной карты из чужих рук.
 *
 *   УРОВНИ ЗНАЧАТ. Профи в сотне партий один на один становится дураком
 *   заметно реже новичка.
 *
 *   ГРАНИЦЫ. Человек не ходит за бота и не правит стол с ботами.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, botRandom } from './harness.js';
import * as D from './games/durak/rules.js';
import { durakView } from './games/durak/view.js';
import { GAMES } from './games/index.js';
import durakBot, { TYPES, LEVELS, decideDurak, possibleCards } from './games/durak/bot.js';
import { shuffled36 } from './games/durak/cards.js';
import { seededRng } from './deck.js';

const IVAN = user(101, 'Иван');
const g = GAMES.durak;

async function durakVsBots(t, settings) {
  await t.start(IVAN);
  t.openSolo(IVAN);
  await t.send(IVAN, { t: 'play', game: 'durak', settings });
  return t.app.soloOf('101');
}

/** Простой человек: заходит младшей, кроет первой подходящей, иначе берёт; подкидывать не любит. */
function simple(s) {
  const l = s.legal;
  if (!l) return null;
  const defend = Object.entries(l.defend);
  if (defend.length) return { t: 'defend', card: defend[0][0], target: defend[0][1][0] };
  if (l.take) return { t: 'take' };
  if (l.lead) return { t: 'attack', card: l.attack[0] };
  if (l.pass) return { t: 'pass' };
  return null;
}

async function playSeries(t, room, games, steps = 2000) {
  for (let i = 0; i < steps && room.gameNo <= games; i++) {
    const s = t.state(IVAN);
    const m = simple(s);
    if (m && s.deal?.phase === 'play') await t.send(IVAN, { ...m, seq: s.seq });
    else if (s.canNext && room.gameNo < games) await t.send(IVAN, { t: 'next' });
    else if (s.deal?.phase === 'over' && room.gameNo >= games) break;
    else await t.advance(2_000);
  }
}

function spyOnBots() {
  const seen = [];
  const original = g.bot.decide;
  g.bot.decide = (args) => {
    const msg = original(args);
    seen.push({ id: args.me.id, view: structuredClone(args.view), hands: structuredClone(args.room.deal.hands), msg, mem: structuredClone(args.me.bot.mem ?? null) });
    return msg;
  };
  return { seen, restore: () => { g.bot.decide = original; } };
}

const CARD = /"((?:6|7|8|9|10|J|Q|K|A)[SHDC])"/g;

test('выбор: 8 характеров, 4 уровня, имена влезают', () => {
  const cat = durakBot.catalog();
  assert.equal(cat.types.length, 8);
  assert.equal(cat.levels.length, 4);
  assert.deepEqual(cat.levels, LEVELS.map((l) => l.name));
  assert.equal(new Set(TYPES.map((x) => x.short)).size, TYPES.length);
  for (const x of TYPES) assert.ok(x.short.length <= 9, x.short);
  assert.equal(durakBot.lineup({ opponents: 9 }, botRandom(1)).length, 5, 'до пяти соперников — за столом шесть мест');
  assert.equal(new Set(durakBot.lineup({ opponents: 5 }, botRandom(2)).map((x) => x.type)).size, 5, 'разные характеры');
  assert.equal(durakBot.settings({ variant: 'perevodnoy' }).variant, 'perevodnoy');
  assert.equal(durakBot.settings({ variant: 'покер' }).variant, 'podkidnoy');
});

test('дурак с ботами: серия идёт, боты решают только по своей руке и открытому столу', async () => {
  const t = new Table({ botRng: botRandom(5) });
  const spy = spyOnBots();
  try {
    const room = await durakVsBots(t, { opponents: 3, level: 2, variant: 'podkidnoy' });
    assert.ok(room.solo);
    assert.equal(room.players.filter((p) => p.bot).length, 3);
    assert.equal(room.status, 'playing', 'партия сразу');
    await playSeries(t, room, 3);
    assert.ok(room.history.length >= 3, `сыграно партий: ${room.history.length}`);
    assert.ok(spy.seen.length > 30, `ботам пришлось решать: ${spy.seen.length}`);
    for (const { id, view, hands } of spy.seen) {
      assert.deepEqual([...view.me.cards].sort(), [...hands[id]].sort(), 'в виде — рука самого бота');
      const allowed = new Set([...hands[id], ...view.deal.table.flatMap((x) => [x.a, x.d]).filter(Boolean), view.deal.trumpCard]);
      for (const [, c] of JSON.stringify(view).matchAll(CARD)) assert.ok(allowed.has(c), `${id} увидел чужую карту ${c}`);
      for (const p of view.players.filter((x) => !x.isMe)) assert.equal(p.cards, undefined, 'у соперников — только число карт');
    }
    assert.ok(spy.seen.every((x) => x.msg), 'бот всегда находит ход');
    assert.deepEqual(t.errors, [], 'ни один ход бота не отклонён');
    // Человеку за всю серию тоже не пришло ни одной чужой карты.
    for (const m of t.page(IVAN).inbox.filter((x) => x.t === 'state' && x.state.deal)) {
      const s = m.state;
      const allowed = new Set([...s.me.cards, ...s.deal.table.flatMap((x) => [x.a, x.d]).filter(Boolean), s.deal.trumpCard]);
      for (const [, c] of JSON.stringify(s).matchAll(CARD)) assert.ok(allowed.has(c), `человек увидел чужую карту ${c}`);
    }
    // Ни слова в группы, ни очка в рейтинг.
    assert.ok([...t.tg.messages.values()].every((m) => m.chatId === '101'));
    assert.deepEqual(t.app.rate(room), []);
  } finally {
    spy.restore();
  }
});

test('переводной: боты переводят', async () => {
  const t = new Table({ botRng: botRandom(8) });
  const spy = spyOnBots();
  try {
    const room = await durakVsBots(t, { opponents: 4, level: 3, variant: 'perevodnoy', types: ['mover', 'mover', 'mover', 'mover'] });
    assert.equal(room.settings.variant, 'perevodnoy');
    await playSeries(t, room, 4);
    assert.ok(spy.seen.some((x) => x.msg?.t === 'transfer'), 'хоть раз перевели');
    // Память профи живёт всю серию в самом боте — и в каждой партии своя.
    assert.ok(room.history.length >= 3);
    for (const { id, view, hands, mem } of spy.seen) {
      assert.equal(mem.no, view.deal.no, 'память — о текущей партии');
      const possible = possibleCards(view, mem);
      for (const [other, cards] of Object.entries(hands)) {
        if (other !== id) for (const c of cards) assert.ok(possible.includes(c), `${id} считает невозможной карту ${c}, а она у ${other}`);
      }
    }
    assert.deepEqual(t.errors, []);
  } finally {
    spy.restore();
  }
});

test('человек не ходит за бота и не правит стол с ботами', async () => {
  const t = new Table({ botRng: botRandom(3) });
  const room = await durakVsBots(t, { opponents: 2, level: 1 });
  const d = room.deal;
  const botId = d.order.find((id) => id !== '101');
  const botCard = d.hands[botId][0];
  const seq = room.seq;
  await t.send(IVAN, { t: 'attack', card: botCard, seq });
  assert.equal(t.lastError(IVAN).code, 'NOT_YOUR_CARD', 'чужой картой не сходить');
  assert.ok(d.hands[botId].includes(botCard));
  for (const msg of [{ t: 'settings', variant: 'perevodnoy' }, { t: 'kick', seat: 1 }, { t: 'abort' }, { t: 'leave' }, { t: 'host', seat: 1 }]) {
    await t.send(IVAN, msg);
    assert.equal(t.lastError(IVAN).code, 'SOLO_ONLY', msg.t);
  }
  assert.equal(room.settings.variant, 'podkidnoy');
  assert.ok(room.players.every((p) => !p.kicked));
});

/**
 * Партия один на один между двумя ботами — прямо по правилам, без ядра: каждый
 * решает по своему виду, ход проверяют правила. Возвращает id дурака или null.
 */
function duel(levels, seed, check = null) {
  const rng = botRandom(seed);
  const room = D.createRoom({ chatId: 'x', host: { id: 'a', name: 'A' } });
  room.players.length = 0;
  D.addPlayer(room, { id: 'a', name: 'A' });
  D.addPlayer(room, { id: 'b', name: 'B' });
  // Характер один на двоих — сравниваются только уровни. Объект живёт всю
  // партию: в нём профи помнит вышедшие карты, как бот за настоящим столом.
  const spec = { a: { type: 'calm', level: levels.a }, b: { type: 'calm', level: levels.b } };
  room.hostId = 'a';
  const r = D.startGame(room, 'a', { deck: () => shuffled36(seededRng(seed)), randInt: () => 0 });
  assert.ok(r.ok, r.error);
  for (let i = 0; i < 500 && room.deal.phase === 'play'; i++) {
    const w = g.waiting(room)[0];
    const view = durakView(room, w.id);
    const m = decideDurak(view, spec[w.id], rng) || durakBot.fallback(view);
    check?.(room, w.id, view, spec[w.id]);
    const res = m.t === 'attack' ? D.attack(room, w.id, m.card, m.seq)
      : m.t === 'defend' ? D.defend(room, w.id, m.card, m.target, m.seq)
        : m.t === 'transfer' ? D.transfer(room, w.id, m.card, m.seq)
          : m.t === 'take' ? D.take(room, w.id, m.seq) : D.pass(room, w.id, m.seq);
    assert.ok(!res.error, `ход бота отклонён: ${res.error}`);
  }
  assert.equal(room.deal.phase, 'over', 'партия доиграна');
  return room.deal.fool;
}

/** Сколько раз дураком остался уровень `x` и уровень `y` в `n` партиях один на один. */
function ladder(x, y, n) {
  let fx = 0;
  let fy = 0;
  for (let seed = 1; seed <= n; seed++) {
    // Меняем местами, чтобы не играла роль очерёдность.
    const xIs = seed % 2 ? 'a' : 'b';
    const fool = duel(xIs === 'a' ? { a: x, b: y } : { a: y, b: x }, seed);
    if (fool === xIs) fx++;
    else if (fool) fy++;
  }
  return [fx, fy];
}

test('уровни значат: профи против новичка остаётся дураком заметно реже', () => {
  const [novice, pro] = ladder(0, 3, 120);
  assert.ok(novice > pro * 2.5, `дураком: новичок ${novice}, профи ${pro}`);
});

test('уровни значат: каждый следующий уровень сильнее предыдущего', () => {
  for (const [x, y] of [[0, 1], [1, 2], [2, 3]]) {
    const [weak, strong] = ladder(x, y, 400);
    assert.ok(weak > strong * 1.15, `уровень ${x} дураком ${weak}, уровень ${y} — ${strong}`);
  }
});

test('память профи — только открытые карты: она не ошибается и не подсматривает', () => {
  let exact = 0;
  let checks = 0;
  for (let seed = 1; seed <= 40; seed++) {
    duel({ a: 3, b: 3 }, seed, (room, id, view, spec) => {
      const other = room.deal.order.find((x) => x !== id);
      const theirs = room.deal.hands[other];
      const possible = possibleCards(view, spec.mem);
      // Всё, что реально у соперника, бот считает возможным — память не врёт.
      for (const c of theirs) assert.ok(possible.includes(c), `${id} «забыл», что ${c} может быть у соперника`);
      checks++;
      // Без колоды один на один внимательный игрок знает руку соперника точно.
      if (room.deal.talon.length === 0 && possible.length === theirs.length) exact++;
    });
  }
  assert.ok(checks > 500, `проверок: ${checks}`);
  assert.ok(exact > 50, `память работает: в конце игры рука соперника известна точно ${exact} раз`);
});
