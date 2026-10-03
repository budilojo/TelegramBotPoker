'use strict';
/**
 * Durak through the Mini App: the same two iron rules as the poker table.
 *
 *   NOBODY SEES SOMEBODY ELSE'S CARDS — checked on EVERYTHING each phone
 *   received during a whole game, and on every message in the group and in
 *   private chats, edits and deleted ones included.
 *
 *   NOBODY ACTS FOR SOMEBODY ELSE — a validly signed page for each person;
 *   the attack is being the wrong person, or claiming to be somebody else in
 *   the body of a message.
 *
 * And the group stays quiet: the card and the results, nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, durakStack, durakDecks, initDataFor, TEST_TOKEN, FakeClock } from './harness.js';
import { App } from './app.js';
import { Hub } from './hub.js';
import { Store } from './store.js';
import { allCovered, waitingThrowers } from './games/durak/rules.js';
import { RANKS } from './games/durak/cards.js';

const THREE = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') });

/** New messages the bot posted into the group (not edits). */
const groupPosts = (t) => t.tg.calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(t.chatId));
/** Every text the bot ever put in the group or in private — posts and edits. */
const everyText = (t) => t.tg.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => c.text);

/** A card by its picture name ("7D") or as a person writes it ("7♦", "Д♥"). */
const CARD_CODE = /"(?:10|[6-9JQKA])[SHDC]"/g;
const CARD_WORD = /(?:10|[6-9ВДКТ])[♠♥♦♣]/;

/**
 * `/play` → the host creates the lobby from the hub → the others open it by
 * the card and sit down → the host starts. Everybody pressed Start in private.
 */
async function begin(t, cast, { settings = {}, start = true } = {}) {
  const [host, ...rest] = Object.values(cast);
  for (const u of Object.values(cast)) await t.start(u);
  await t.cmd(host, '/play');
  t.openHub(host);
  await t.send(host, { t: 'create', game: 'durak', settings });
  const room = t.durak;
  for (const u of rest) {
    t.openRoom(u, room);
    await t.send(u, { t: 'sit' });
  }
  if (start) await t.send(host, { t: 'start' });
  return room;
}

const who = (cast, id) => Object.values(cast).find((u) => String(u.id) === String(id));
const low = (cards) => cards.reduce((a, b) => (RANKS.indexOf(b.slice(0, -1)) < RANKS.indexOf(a.slice(0, -1)) ? b : a));

/**
 * Play the game out the way the pages would: each move is chosen from what
 * that person's OWN page says is legal, and sent from that page.
 */
async function playOut(t, cast, limit = 3000) {
  for (let i = 0; i < limit && t.durak.deal?.phase === 'play'; i++) {
    const d = t.durak.deal;
    if (!d.table.length) {
      const u = who(cast, d.attacker);
      const s = t.state(u);
      await t.send(u, { t: 'attack', card: low(s.legal.attack), seq: s.seq });
    } else if (!allCovered(d) && !d.bout.taking) {
      const u = who(cast, d.defender);
      const s = t.state(u);
      const at = s.deal.table.findIndex((x) => !x.d);
      const card = Object.keys(s.legal.defend).find((c) => s.legal.defend[c].includes(at));
      await t.send(u, card ? { t: 'defend', card, target: at, seq: s.seq } : { t: 'take', seq: s.seq });
    } else {
      for (const id of waitingThrowers(d)) await t.send(who(cast, id), { t: 'pass', seq: t.state(who(cast, id)).seq });
    }
  }
  assert.equal(t.durak.deal.phase, 'over', 'the game was played to the end');
}

/** Every card named in a state must be the viewer's own, on the table, or the trump. */
function onlyAllowedCards(state, label) {
  const json = JSON.stringify(state);
  const allowed = new Set([...(state.me?.cards || []), state.deal?.trumpCard].filter(Boolean));
  for (const x of state.deal?.table || []) {
    allowed.add(x.a);
    if (x.d) allowed.add(x.d);
  }
  for (const m of json.match(CARD_CODE) || []) {
    const c = m.slice(1, -1);
    assert.ok(allowed.has(c), `${label}: в состоянии чужая карта ${c}`);
  }
  if (state.deal) {
    assert.equal(typeof state.deal.talon, 'number', `${label}: колода — только число`);
    assert.equal(typeof state.deal.discard, 'number', `${label}: сброс — только число`);
  }
  for (const k of ['hands', 'order', 'deck']) assert.ok(!(k in (state.deal || {})), `${label}: нет поля ${k}`);
}

/* ------------------------------------------------------------ privacy */

test('a whole game: every state any phone ever got holds only its own cards, the table and the trump', async () => {
  const cast = THREE();
  const t = new Table({ durakDeck: durakDecks(5) });
  await begin(t, cast);
  // A guest who opened the link but never sat down watches the whole game.
  const guest = user(9999, 'Прохожий');
  t.openRoom(guest, t.durak);
  await playOut(t, cast);

  for (const u of [...Object.values(cast), guest]) {
    const states = t.page(u).inbox.filter((m) => m.t === 'state');
    assert.ok(states.length > 20, `${u.first_name} got the game move by move`);
    for (const [i, m] of states.entries()) onlyAllowedCards(m.state, `${u.first_name} #${i}`);
  }
  const seen = t.state(guest);
  assert.deepEqual(seen.me.cards, [], 'the guest holds nothing');
  assert.ok(seen.players.every((p) => typeof p.count === 'number' && !('cards' in p)), 'hands are counts');
});

test('a player\'s own cards are in their state from the deal on — and in nobody else\'s', async () => {
  const cast = THREE();
  const t = new Table({ durakDeck: durakDecks(6) });
  const room = await begin(t, cast);
  for (const u of Object.values(cast)) {
    const mine = room.deal.hands[String(u.id)];
    assert.deepEqual([...t.state(u).me.cards].sort(), [...mine].sort(), `${u.first_name} sees his six`);
    for (const other of Object.values(cast).filter((o) => o !== u)) {
      const everything = t.received(other);
      for (const c of mine) assert.ok(!everything.includes(`"${c}"`) || c === room.deal.trumpCard, `${other.first_name} never got ${u.first_name}'s ${c}`);
    }
  }
});

test('the group and the private chats never see a card — only the trump suit', async () => {
  const cast = THREE();
  const t = new Table({ durakDeck: durakDecks(7) });
  await begin(t, cast);
  // Somebody has the app closed: private nudges go out during the game.
  await t.send(cast.dima, { t: 'visible', visible: false });
  await playOut(t, cast);
  await t.cmd(cast.ivan, '/finish');
  const texts = everyText(t);
  assert.ok(texts.some((x) => /Отбивайтесь|Ваш ход|Можно подкинуть/.test(x)), 'nudges did go out');
  for (const x of texts) {
    assert.ok(!CARD_WORD.test(x), `карта в Telegram: ${x}`);
    assert.ok(!/(?:^|[^A-Za-z0-9])(?:10|[6-9JQKA])[SHDC](?![A-Za-z0-9])/.test(x.replace(/https?:\S+/g, '')), `код карты в Telegram: ${x}`);
  }
});

/* ---------------------------------------------- nobody acts for another */

test('a move is made by whoever\'s page it came from — ids, seats and names in the message are ignored', async () => {
  const cast = THREE();
  const t = new Table();
  t.useDurakDeck(durakStack(
    { 202: '6D 7S 8S 9S 10S JS', 303: '7H 8H 9H 10H JH QH', 101: '7C 8C 9C 10C JC QC' },
    { trump: 'AD' },
  ));
  const room = await begin(t, cast);
  const d = room.deal;
  assert.equal(d.attacker, '202', 'Макс has the lowest trump');
  // Иван sends Макс's lead, naming Макс every way a message can.
  await t.send(cast.ivan, { t: 'attack', card: '7S', id: 202, userId: '202', seat: 1, from: { id: 202 }, name: 'Макс' });
  assert.equal(d.table.length, 0, 'nothing was played');
  assert.equal(t.lastError(cast.ivan).code, 'NOT_YOUR_CARD', 'that card is not in HIS hand');
  await t.send(cast.ivan, { t: 'attack', card: '7C', as: '202' });
  assert.equal(t.lastError(cast.ivan).code, 'NOT_YOUR_LEAD');
  assert.match(t.lastError(cast.ivan).text, /Первым ходит Макс/);

  await t.send(cast.max, { t: 'attack', card: '7S' });
  assert.deepEqual(d.table.map((x) => x.a), ['7S']);
  // Иван covers for Дима, the defender.
  await t.send(cast.ivan, { t: 'defend', card: '9C', target: 0, as: 303 });
  assert.equal(t.lastError(cast.ivan).code, 'NOT_DEFENDER');
  assert.match(t.lastError(cast.ivan).text, /Отбивается Дима/);
  await t.send(cast.ivan, { t: 'take', seat: 2 });
  assert.equal(t.lastError(cast.ivan).code, 'NOT_DEFENDER');
  assert.equal(d.bout.taking, false, 'Дима does not take because somebody said so');
  await t.send(cast.dima, { t: 'pass' });
  assert.equal(t.lastError(cast.dima).code, 'DEFENDER_PASS');
});

test('every refusal is said in words, and the page is put back to the truth', async () => {
  const cast = THREE();
  const t = new Table();
  t.useDurakDeck(durakStack(
    { 202: '6D 7S 8S 9S 10S JS', 303: '7H 8H 9H 10H JH QH', 101: '7C 8C 9C 10C JC QC' },
    { trump: 'AD' },
  ));
  await begin(t, cast);
  await t.send(cast.max, { t: 'attack', card: '9S' });
  const before = t.page(cast.dima).inbox.length;
  await t.send(cast.dima, { t: 'defend', card: '8H', target: 0 });
  const err = t.lastError(cast.dima);
  assert.equal(err.code, 'CANNOT_BEAT');
  assert.equal(err.text, '8♥ не бьёт 9♠: нужна старшая ♠ или козырь.');
  assert.ok(t.page(cast.dima).inbox.slice(before).some((m) => m.t === 'state'), 'a fresh state follows the refusal');
  await t.send(cast.ivan, { t: 'attack', card: '10C' });
  assert.match(t.lastError(cast.ivan).text, /Подкидывать можно только 9/);
  await t.send(cast.ivan, { t: 'attack', card: 'nonsense' });
  assert.equal(t.lastError(cast.ivan).code, 'NOT_YOUR_CARD');
  await t.send(cast.ivan, { t: 'act', action: 'fold' });
  assert.equal(t.lastError(cast.ivan).code, 'BAD_REQUEST', 'a poker move at a durak table');
});

test('somebody who only opened the link cannot play, cannot start, cannot deal the next game', async () => {
  const cast = THREE();
  const t = new Table({ durakDeck: durakDecks(3) });
  const room = await begin(t, cast, { start: false });
  const guest = user(9999, 'Прохожий');
  t.openRoom(guest, room);
  await t.send(guest, { t: 'start' });
  assert.equal(t.lastError(guest).code, 'NOT_HOST');
  await t.send(cast.ivan, { t: 'start' });
  await t.send(guest, { t: 'attack', card: room.deal.hands[room.deal.attacker][0] });
  assert.equal(t.lastError(guest).code, 'NOT_IN_DEAL');
  await t.send(guest, { t: 'take' });
  assert.equal(t.lastError(guest).code, 'NOT_IN_DEAL');
  assert.equal(room.deal.table.length, 0);
});

test('host rights — settings, removing, handing over, ending — are checked by id', async () => {
  const cast = THREE();
  const t = new Table({ durakDeck: durakDecks(3) });
  const room = await begin(t, cast, { start: false });
  await t.send(cast.max, { t: 'settings', variant: 'perevodnoy' });
  assert.equal(t.lastError(cast.max).code, 'NOT_HOST');
  assert.equal(room.settings.variant, 'podkidnoy');
  await t.send(cast.max, { t: 'kick', seat: 2 });
  assert.equal(t.lastError(cast.max).code, 'NOT_HOST');
  await t.send(cast.max, { t: 'finish' });
  assert.equal(room.status, 'lobby');
  await t.send(cast.ivan, { t: 'host', seat: 1 });
  assert.equal(room.hostId, '202');
  await t.send(cast.ivan, { t: 'settings', variant: 'perevodnoy' });
  assert.equal(t.lastError(cast.ivan).code, 'NOT_HOST', 'the old host lost the rights');
  await t.send(cast.max, { t: 'settings', variant: 'perevodnoy', turnSeconds: 60 });
  assert.deepEqual(room.settings, { variant: 'perevodnoy', turnSeconds: 60 });
});

/* ------------------------------------------------------------ the group */

test('a whole series puts exactly two messages in the group: the card and the results', async () => {
  const cast = THREE();
  const t = new Table({ durakDeck: durakDecks(9) });
  await begin(t, cast, { start: false });
  const posts = groupPosts(t).length;
  assert.equal(posts, 2, 'so far: the /play card and the lobby card');
  await t.send(cast.ivan, { t: 'start' });
  await playOut(t, cast);
  const fool1 = t.durak.deal.fool;
  const card = t.tg.message(t.durak.ui.tableMessageId).text;
  if (fool1) assert.match(card, new RegExp(`Дурак партии #1 — <b>${t.durak.players.find((p) => p.id === fool1).name}</b>`));
  assert.match(card, /Счёт: /);
  await t.send(cast.max, { t: 'next' });
  await playOut(t, cast);
  assert.equal(groupPosts(t).length, posts, 'two whole games, and not one new message in the group');

  await t.cmd(cast.ivan, '/finish');
  const all = groupPosts(t);
  assert.equal(all.length, posts + 1);
  const results = all.at(-1).text;
  assert.match(results, /ИТОГИ · ДУРАК/);
  assert.match(results, /Партий сыграно: 2/);
  for (const u of Object.values(cast)) assert.match(results, new RegExp(`${u.first_name}\\s+дурак \\d`));
  assert.match(t.tg.message(t.durak.ui.tableMessageId).text, /Игра завершена/);
  assert.equal(t.state(cast.dima).room.status, 'finished', 'the phones show the end too');
});

test('the card follows the game: who attacks, who defends, who takes — by editing', async () => {
  const cast = THREE();
  const t = new Table();
  t.useDurakDeck(durakStack(
    { 202: '6D 7S 8S 9S 10S JS', 303: '7H 8H 9H 10H JH QH', 101: '7C 8C 9C 10C JC QC' },
    { trump: 'AD' },
  ));
  const room = await begin(t, cast);
  const text = () => t.tg.message(room.ui.tableMessageId).text;
  assert.match(text(), /Партия #1 · в колоде 18 · козырь ♦/);
  assert.match(text(), /⚔️ <b>Макс<\/b> ходит · 🛡 Дима отбивается/);
  await t.send(cast.max, { t: 'attack', card: '7S' });
  assert.match(text(), /🛡 <b>Дима<\/b> отбивается/);
  await t.send(cast.dima, { t: 'take' });
  assert.match(text(), /🛡 <b>Дима<\/b> берёт/);
  assert.ok(!CARD_WORD.test(text()), 'the card on the table is not in the group');
});

/* ------------------------------------------------------------- nudges */

test('the defender with the app closed gets a nudge; it goes once he has moved; open apps get nothing', async () => {
  const cast = THREE();
  const t = new Table();
  t.useDurakDeck(durakStack(
    { 202: '6D 7S 8S 9S 10S JS', 303: '7H 8H 9H 10H JH QH', 101: '7C 8C 9C 10C JC QC' },
    { trump: 'AD' },
  ));
  await begin(t, cast);
  await t.send(cast.dima, { t: 'visible', visible: false });
  await t.send(cast.max, { t: 'attack', card: '7S' });
  const ping = [...t.tg.messages.entries()].filter(([, m]) => m.chatId === '303' && /Отбивайтесь/.test(m.text)).at(-1);
  assert.ok(ping, 'Дима, the defender, is nudged');
  assert.match(ping[1].text, /Макс ходит на вас: 1 карта/);
  assert.equal(ping[1].markup.inline_keyboard[0][0].web_app.url, `https://poker.example/?room=${t.durak.code}`);
  assert.ok(!t.tg.dms(101).some((x) => /Отбивайтесь|Ваш ход|подкинуть/.test(x)), 'Иван has the app open');

  await t.send(cast.dima, { t: 'take' });
  assert.equal(t.tg.message(ping[0]).deleted, true, 'once he has moved, the nudge is gone');
});

test('throwers the game waits on are nudged too — each until they say «пас»', async () => {
  const cast = THREE();
  const t = new Table();
  t.useDurakDeck(durakStack(
    { 202: '6D 7S 8S 9S 10S JS', 303: '7H 8H 9H 10H JH QH', 101: '7C 8C 9C 10C JC QC' },
    { trump: 'AD' },
  ));
  await begin(t, cast);
  await t.send(cast.ivan, { t: 'visible', visible: false });
  await t.send(cast.max, { t: 'attack', card: '7S' });
  await t.send(cast.dima, { t: 'defend', card: '8H', target: 0 });
  assert.equal(t.lastError(cast.dima).code, 'CANNOT_BEAT');
  await t.send(cast.dima, { t: 'take' });
  const ping = [...t.tg.messages.entries()].filter(([, m]) => m.chatId === '101' && /подкинуть/.test(m.text)).at(-1);
  assert.ok(ping, 'Иван may still throw in after Дима — and the game waits for him');
  assert.match(ping[1].text, /Дима берёт — подкиньте вдогонку или «пас»/);
  await t.send(cast.ivan, { t: 'pass' });
  assert.equal(t.tg.message(ping[0]).deleted, true);
});

/* ---------------------------------------------------------- the timer */

test('with the timer on, an absent defender takes when the time is up, and the phones count it down', async () => {
  const cast = THREE();
  const t = new Table();
  t.useDurakDeck(durakStack(
    { 202: '6D 7S 8S 9S 10S JS', 303: '7H 8H 9H 10H JH QH', 101: '7C 8C 9C 10C JC QC' },
    { trump: 'AD' },
  ));
  const room = await begin(t, cast, { settings: { turnSeconds: 30 } });
  await t.send(cast.max, { t: 'attack', card: '7S' });
  const s = t.state(cast.dima);
  assert.equal(s.deal.deadline, t.clock.now() + 30_000, 'the deadline travels with the state');
  await t.advance(29_000);
  assert.equal(room.deal.bout.taking, false);
  await t.advance(1_000);
  assert.equal(room.deal.bout.taking, true, 'time is up: he takes');
  assert.match(t.state(cast.ivan).room.notice, /Дима: время вышло — берёт/);
  await t.advance(30_000);
  assert.ok(room.deal.hands['303'].includes('7S'), 'the throwers passed on the clock, and he picked up');
});

/* ------------------------------------------------------------ restarts */

test('a restart mid-game keeps the hands, the pack, whose move it is — and the open pages play on', async () => {
  const store = new Store(':memory:');
  const cast = THREE();
  const t = new Table({ store, durakDeck: durakDecks(14) });
  const room = await begin(t, cast);
  const attacker = room.deal.attacker;
  const u = who(cast, attacker);
  await t.send(u, { t: 'attack', card: t.state(u).legal.attack[0] });
  const snapshot = JSON.stringify({ hands: room.deal.hands, talon: room.deal.talon, table: room.deal.table });

  const clock = new FakeClock();
  const app2 = new App({ api: t.tg, store, minIntervalMs: 0, botUsername: 'ChipTableBot', clock, runoutStepMs: 0, miniAppName: 'table' });
  const hub2 = new Hub(app2, { botToken: TEST_TOKEN });
  app2.attachHub(hub2);
  assert.equal(app2.load(), 1);
  await app2.resume();
  const room2 = app2.roomByCode(room.code);
  assert.equal(room2.game, 'durak');
  assert.equal(JSON.stringify({ hands: room2.deal.hands, talon: room2.deal.talon, table: room2.deal.table }), snapshot);
  assert.equal(room2.ui.tableMessageId, room.ui.tableMessageId, 'the same card, edited');

  const defender = who(cast, room2.deal.defender);
  const inbox = [];
  const s = hub2.open({ initData: initDataFor(defender, { startParam: room2.code, clock }) }, (m) => inbox.push(m)).session;
  await hub2.handle(s, { t: 'take' });
  assert.equal(room2.deal.bout.taking, true, 'the reconnected page plays');
  store.close();
});
