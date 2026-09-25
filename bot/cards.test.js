'use strict';
/**
 * The second rule, next to "nobody acts for somebody else":
 * NOBODY SEES SOMEBODY ELSE'S CARDS.
 *
 * Hole cards may leave the bot in exactly two ways — a private message to
 * their owner, and a popup Telegram shows only to the person who pressed.
 * These tests look at EVERYTHING the bot ever sent (every send and every
 * edit, deleted messages included), not just at the final screen: a card
 * that flashed in the group for one edit has leaked just the same.
 *
 * And the other half of dealing the cards: the bot now decides who wins, so
 * a wrong answer here silently hands a pot to the wrong person.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, stack } from './harness.js';
import { cardText, BOARD_SIZE } from './cards.js';
import { rank } from './eval.js';
import { Store } from './store.js';
import { App } from './app.js';
import { distribution, legalActions } from '../server/game.js';
import { seededRng } from './deck.js';
import { pressUpdate } from './tg-stub.js';

const CAST = () => ({
  ivan: user(101, 'Иван'),
  max: user(202, 'Макс'),
  dima: user(303, 'Дима'),
  sasha: user(404, 'Саша'),
});
const THREE = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') });

/** Every text the bot ever put into a chat: sends AND edits. */
function everything(t, chatId) {
  return t.tg.calls
    .filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.chatId === String(chatId))
    .map((c) => c.text);
}
const shows = (texts, card) => texts.some((x) => x.includes(cardText(card)));

/** The message of hand #no as it stands in the chat now (frozen or live). */
function handMessage(t, no) {
  let found = null;
  for (const m of t.tg.messages.values()) {
    if (m.chatId === String(t.chatId) && !m.deleted && m.text.includes(`РАЗДАЧА #${no}`)) found = m;
  }
  return found;
}

/* ---------------------------------------------------------- the deal */

test('every player gets exactly their own two cards, in their own private chat', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);

  const all = [];
  for (const u of Object.values(cast)) {
    const mine = t.hole(u);
    assert.equal(mine.length, 2, `${u.first_name} has two cards`);
    all.push(...mine);
    const dm = t.lastDm(u);
    for (const c of mine) assert.ok(dm.includes(cardText(c)), `${u.first_name}'s own ${cardText(c)} is in their DM`);
    for (const other of Object.values(cast)) {
      if (other === u) continue;
      for (const c of t.hole(other)) {
        assert.ok(!shows(t.tg.dms(u.id), c), `${u.first_name} must never receive ${other.first_name}'s ${cardText(c)}`);
      }
    }
  }
  assert.equal(new Set(all).size, 8, 'one deck: no card dealt twice');

  // Private messages went to players and only to players.
  const privateTargets = new Set(
    t.tg.calls.filter((c) => c.method === 'sendMessage' && Number(c.chatId) > 0).map((c) => c.chatId)
  );
  for (const id of privateTargets) {
    assert.ok(Object.values(cast).some((u) => String(u.id) === id), `a private message went to a stranger: ${id}`);
  }
});

test('the group never sees a hole card before the showdown — not even in one edit', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast);
  t.useDeck(stack(
    { [cast.ivan.id]: 'As Ah', [cast.max.id]: 'Kd Kc', [cast.dima.id]: '7c 2d' },
    '4s 9h Jd 3c 8s'
  ));
  await t.press(cast.ivan, 'Начать игру');

  // Play to the river and stop one move short of the showdown.
  let guard = 0;
  while (guard++ < 40) {
    const h = t.room.hand;
    const who = t.actorOf(cast);
    const lastMove = h.street === 'river' && t.room.players.filter((p) => p.inHand && !p.folded && !p.acted).length === 1;
    if (lastMove) break;
    await t.press(who, t.button('CHECK') ? 'CHECK' : 'CALL');
  }
  assert.equal(t.room.hand.street, 'river');
  assert.equal(t.room.hand.phase, 'betting');

  const group = everything(t, t.chatId);
  for (const u of Object.values(cast)) {
    for (const c of t.hole(u)) assert.ok(!shows(group, c), `${cardText(c)} of ${u.first_name} leaked into the group`);
  }
  for (const c of t.room.hand.board) assert.ok(shows(group, c), `the board card ${cardText(c)} is public`);

  // The last check. Now the winner shows — and only the winner: the two
  // losing hands (nobody is all-in) are mucked, and stay unseen for good.
  await t.press(t.actorOf(cast), 'CHECK');
  assert.equal(t.room.hand.phase, 'complete');
  const after = everything(t, t.chatId);
  for (const c of t.hole(cast.ivan)) assert.ok(shows(after, c), 'the winning aces are shown');
  for (const u of [cast.max, cast.dima]) {
    for (const c of t.hole(u)) assert.ok(!shows(after, c), `${u.first_name} lost and mucked, ${cardText(c)} was shown`);
    assert.match(t.text(), new RegExp(`${u.first_name}: карты не показаны`));
  }
  assert.doesNotMatch(t.text(), /Пара K|Старшая/, 'not even the name of a mucked hand');
});

test('a folded hand is never shown — not at showdown, not anywhere', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast);
  t.useDeck(stack(
    { [cast.ivan.id]: 'As Ah', [cast.max.id]: 'Kd Kc', [cast.dima.id]: 'Qh Qd' },
    '4s 9h Jd 3c 8s'
  ));
  await t.press(cast.ivan, 'Начать игру');

  // Дима folds on his first turn — by typing it: as the big blind he faces
  // no bet, and the FOLD button is hidden when checking is free. The other
  // two go to showdown.
  let folded = false;
  let guard = 0;
  while (t.room.hand.phase === 'betting' && guard++ < 40) {
    const who = t.actorOf(cast);
    if (who === cast.dima && !folded) {
      await t.cmd(who, '/fold');
      folded = true;
    } else {
      await t.press(who, t.button('CHECK') ? 'CHECK' : 'CALL');
    }
  }
  assert.ok(folded, 'Дима really folded');
  assert.ok(t.room.hand.shown, 'it went to a showdown');

  const group = everything(t, t.chatId);
  for (const c of t.hole(cast.dima)) assert.ok(!shows(group, c), `folded ${cardText(c)} was shown`);
  for (const c of t.hole(cast.ivan)) assert.ok(shows(group, c), 'the winner shows');
  for (const c of t.hole(cast.max)) assert.ok(!shows(group, c), 'the loser mucks');
  assert.equal(t.room.hand.shown[String(cast.dima.id)], undefined, 'and it is not even in the record');
  assert.doesNotMatch(t.text(), /Дима:/, 'a folded player is not even listed at the showdown');
});

test('winning because everyone folded shows nobody\'s cards, the winner\'s included', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);

  let guard = 0;
  while (t.room.hand.phase === 'betting' && guard++ < 10) await t.press(t.actorOf(cast), 'FOLD');

  assert.equal(t.room.hand.phase, 'complete');
  assert.equal(t.room.hand.shown, null, 'no showdown happened');
  const group = everything(t, t.chatId);
  for (const u of Object.values(cast)) {
    for (const c of t.hole(u)) assert.ok(!shows(group, c), `${cardText(c)} of ${u.first_name} was revealed`);
  }
  assert.match(t.text(), /остальные сбросили/);
});

/* ---------------------------------------------------------- peeking */

test('"🂠 Мои карты" shows your own cards to you — whoever\'s copy of the button you press', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);

  for (const u of Object.values(cast)) {
    const a = await t.peek(u);
    assert.equal(a.show_alert, true, 'a popup only the presser sees, not a toast in the chat');
    for (const c of t.hole(u)) assert.ok(a.text.includes(cardText(c)));
    for (const other of Object.values(cast)) {
      if (other === u) continue;
      for (const c of t.hole(other)) assert.ok(!a.text.includes(cardText(c)), `${u.first_name} saw ${cardText(c)}`);
    }
    assert.ok(a.text.length <= 200, 'Telegram cuts callback answers at 200 characters');
  }

  // Everyone presses literally the same button: there is nothing in it that
  // could point at somebody else's hand.
  const data = t.button('Мои карты').callback_data;
  assert.doesNotMatch(data, /10[1-4]|20[12]|30[13]|40[14]/, 'the button carries no player id');

  const stranger = await t.peek(user(9999, 'Прохожий'));
  assert.match(stranger.text, /не в этой раздаче/);
});

test('/cards in the group reveals nothing; in the private chat it shows your hand', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast);

  await t.cmd(cast.max, '/cards');
  const reply = t.lastPost();
  assert.match(reply, /в личке|Мои карты/);
  for (const u of Object.values(cast)) for (const c of t.hole(u)) assert.ok(!reply.includes(cardText(c)));

  await t.dm(cast.max, '/cards');
  const dm = t.lastDm(cast.max);
  for (const c of t.hole(cast.max)) assert.ok(dm.includes(cardText(c)));
  for (const c of [...t.hole(cast.ivan), ...t.hole(cast.dima)]) assert.ok(!dm.includes(cardText(c)));
});

/* -------------------------------------------------------- the board */

test('the board follows the street: 0, 3, 4, 5 cards — and the group sees each one', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast);

  const seen = new Set();
  let guard = 0;
  while (t.room.hand.phase === 'betting' && guard++ < 40) {
    const h = t.room.hand;
    assert.equal(h.board.length, BOARD_SIZE[h.street], `${h.street}: ${h.board.length} cards on the board`);
    for (const c of h.board) assert.ok(t.text().includes(cardText(c)));
    seen.add(h.street);
    await t.press(t.actorOf(cast), t.button('CHECK') ? 'CHECK' : 'CALL');
  }
  assert.deepEqual([...seen], ['preflop', 'flop', 'turn', 'river']);
  assert.equal(t.room.hand.board.length, 5);

  const dealt = [...Object.values(t.room.hand.holes).flat(), ...t.room.hand.board];
  assert.equal(new Set(dealt).size, dealt.length, 'hole cards and board come from one deck');
});

test('an all-in before the river still deals the whole board', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast);
  await t.shoveDown(cast);

  assert.equal(t.room.hand.phase, 'complete');
  assert.equal(t.room.hand.board.length, 5, 'the rest of the board is dealt out at once');
  // Equal stacks all-in usually end the game on the spot. The hand's own
  // message must still show how it ended — board, hands, winner — before
  // the results are posted underneath it.
  const m = handMessage(t, 1);
  for (const c of t.room.hand.board) assert.ok(m.text.includes(cardText(c)), `${cardText(c)} is on the final board`);
  assert.match(m.text, /ВСКРЫТИЕ/);
  if (t.room.status === 'finished') {
    assert.equal(m.markup, null, 'a finished game leaves no live buttons behind');
    assert.match(t.lastPost(), /ИТОГИ/);
  }
});

/* ---------------------------------------------------------- who wins */

test('the best hand takes the pot — the bot reads the cards, nobody picks', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  t.useDeck(stack(
    { [cast.ivan.id]: '9c 9d', [cast.max.id]: 'Kd Kc', [cast.dima.id]: '7c 2d' },
    'As 9h Jd 3c 8s'
  ));
  await t.press(cast.ivan, 'Начать игру');
  await t.runToShowdown(cast);

  const h = t.room.hand;
  assert.deepEqual(h.pots.map((p) => p.winners), [[String(cast.ivan.id)]], 'a set of nines beats kings');
  const stackOf = (u) => t.room.players.find((p) => p.id === String(u.id)).stack;
  assert.equal(stackOf(cast.ivan), 10100);
  assert.equal(stackOf(cast.max), 9950);
  assert.equal(stackOf(cast.dima), 9950);
  assert.match(t.text(), /🏆 <b>Иван<\/b> \+150 · Сет 9/);
  assert.match(t.text(), /Иван: 9♣️ 9♦️ — Сет 9/);
  assert.match(t.text(), /Макс: карты не показаны/, 'the beaten kings are mucked');
  assert.doesNotMatch(everything(t, t.chatId).join('\n'), /K♦️ K♣️/);
});

test('equal hands split the pot, and not a chip goes missing on the odd one', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  // The board is a royal flush: everybody plays it, everybody ties.
  t.useDeck(stack({}, 'As Ks Qs Js 10s'));
  await t.press(cast.ivan, 'Начать игру');

  // Make the pot odd: the small blind folds its 25 and the other two split 125.
  let guard = 0;
  while (t.room.hand.phase === 'betting' && guard++ < 40) {
    const who = t.actorOf(cast);
    const p = t.room.players.find((x) => x.id === String(who.id));
    if (p.id === t.room.hand.sbId && t.button('FOLD')) await t.press(who, 'FOLD');
    else await t.press(who, t.button('CHECK') ? 'CHECK' : 'CALL');
  }

  const [pot] = t.room.hand.pots;
  assert.equal(pot.amount, 125);
  assert.equal(pot.winners.length, 2, 'two live hands, one split');
  const gains = pot.winners.map((id) => t.room.players.find((p) => p.id === id).stack - (10000 - 50));
  assert.deepEqual(gains.sort(), [62, 63], 'the odd chip goes to one of them, none is lost');
  assert.equal(t.chips(), 30000);
});

test('side pots: the short stack with the best hand wins only what it could cover', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  const bySeat = { 101: 1000, 202: 5000, 303: 5000 };
  for (const p of t.room.players) {
    p.stack = bySeat[p.id];
    p.stats.buyIn = bySeat[p.id];
  }
  t.useDeck(stack(
    { [cast.ivan.id]: 'As Ah', [cast.max.id]: 'Kd Kc', [cast.dima.id]: 'Qh Qd' },
    '2s 7h 9d Jc 3s'
  ));
  await t.press(cast.ivan, 'Начать игру');
  await t.shoveDown(cast);

  const h = t.room.hand;
  assert.equal(h.pots.length, 2);
  assert.deepEqual(h.pots.map((p) => [p.amount, p.winners]), [
    [3000, ['101']], // aces take the main pot…
    [8000, ['202']], // …and the side pot they had no stake in goes to the kings
  ]);
  const stackOf = (id) => t.room.players.find((p) => p.id === id).stack;
  assert.equal(stackOf('101'), 3000);
  assert.equal(stackOf('202'), 8000);
  assert.equal(stackOf('303'), 0);
  assert.match(t.text(), /MAIN POT 3 000 → Иван/);
  assert.match(t.text(), /SIDE POT 1 8 000 → Макс/);
});

test('every pot pays exactly the engine\'s split of the best hands among ITS claimants', async () => {
  // Randomised: four stacks of different depth shove every hand, so most
  // hands have two or three pots. The expected winners are recomputed here,
  // pot by pot, from the dealt cards; the expected chips come from the
  // engine's own `distribution` — the call the web app's preview uses.
  const cast = CAST();
  const rnd = seededRng(31337);
  let checked = 0;
  for (let round = 0; round < 25; round++) {
    const t = new Table({ deck: undefined });
    t.useDeck(() => {
      const d = Array.from({ length: 52 }, (_, i) => i);
      for (let i = 51; i > 0; i--) {
        const j = rnd(i + 1);
        [d[i], d[j]] = [d[j], d[i]];
      }
      return d;
    });
    await t.seat(cast, { blinds: [25, 50] });
    const depth = [300 + rnd(3000), 300 + rnd(3000), 300 + rnd(3000), 300 + rnd(3000)];
    t.room.players.forEach((p, i) => {
      p.stack = depth[i];
      p.stats.buyIn = depth[i];
    });
    const TOTAL = depth.reduce((a, b) => a + b, 0);
    await t.press(cast.ivan, 'Начать игру');
    await t.shoveDown(cast);

    const room = t.room;
    const h = room.hand;
    assert.equal(h.phase, 'complete');
    assert.equal(t.chips(), TOTAL, 'chips conserved');
    if (!h.shown) continue;

    const seven = (id) => [...h.holes[id], ...h.board];
    const expectedPots = h.pots.map((pot) => ({
      ...pot,
      winners: pot.eligible.length === 1 ? [...pot.eligible] : rank(pot.eligible.map((id) => ({ id, cards: seven(id) })))[0].ids,
    }));
    expectedPots.forEach((pot, i) => {
      assert.deepEqual([...h.pots[i].winners].sort(), [...pot.winners].sort(), `pot ${i} went to the wrong hand`);
    });

    const { totals } = distribution(room, expectedPots);
    for (const p of room.players) {
      const paid = p.stack - (h.startStacks[p.id] - p.committed);
      assert.equal(paid, totals.get(p.id) ?? 0, `${p.name} was paid ${paid}`);
    }
    checked++;
  }
  assert.ok(checked >= 20, `only ${checked} showdowns were checked`);
});

/* --------------------------------------------- without a private chat */

test('without a private chat you still sit down, are told how to fix it, and can still see your cards', async () => {
  const cast = THREE();
  const t = new Table();
  await t.start(cast.ivan);
  await t.start(cast.dima);
  await t.cmd(cast.ivan, '/newgame');
  await t.cmd(cast.dima, '/join');

  // Макс never pressed Start. The button seats him AND opens the bot's chat.
  await t.press(cast.max, 'Сесть за стол');
  assert.ok(t.room.players.find((p) => p.id === '202'), 'seated anyway');
  assert.equal(t.answer().url, 'https://t.me/ChipTableBot?start=cards', 'one tap away from Start');
  assert.match(t.text(), /Макс\s+10 000\s+нет лички/);

  await t.press(cast.ivan, 'Начать игру');
  assert.equal(t.room.players.find((p) => p.id === '202').dm, 'fail', 'the delivery bounced');
  assert.match(t.text(), /Не дошло в личку: Макс/);
  assert.equal(t.errors.length, 0, 'a bounced private message is expected, not an error');

  const a = await t.peek(cast.max);
  for (const c of t.hole(cast.max)) assert.ok(a.text.includes(cardText(c)), 'the popup still works');

  // He presses Start mid-hand: the warning goes, and his cards arrive.
  await t.start(cast.max, 'cards');
  assert.doesNotMatch(t.text(), /Не дошло в личку/);
  const dm = t.tg.dms(cast.max.id).join('\n');
  for (const c of t.hole(cast.max)) assert.ok(dm.includes(cardText(c)), 'the current hand was delivered late');
});

test('the Start link cannot seat you at a table — seats are taken in the group only', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast);
  const stranger = user(9999, 'Прохожий');

  await t.start(stranger, 'cards');
  await t.start(stranger, `j${t.chatId}`);
  await t.dm(stranger, '/join');
  assert.equal(t.room.players.length, 3, 'nobody was seated from a private chat');
});

test('blocking the bot is noticed, and unblocking too', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast);
  const block = (status) => t.raw({
    update_id: 1,
    my_chat_member: {
      chat: { id: 202, type: 'private' },
      from: cast.max,
      new_chat_member: { status, user: { id: 1, is_bot: true } },
    },
  });

  await block('kicked');
  assert.equal(t.room.players.find((p) => p.id === '202').dm, 'fail');
  assert.match(t.text(), /нет лички/);
  await block('member');
  assert.equal(t.room.players.find((p) => p.id === '202').dm, 'ok');
});

/* ---------------------------------------------- no second chances */

test('undo can never re-deal a hand or take back a card', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  const holes = JSON.stringify(t.room.hand.holes);

  // Right after the deal: nothing to undo — otherwise "undo" is a re-shuffle.
  await t.cmd(cast.ivan, '/undo');
  assert.match(t.lastPost(), /Отменять нечего/);
  assert.equal(JSON.stringify(t.room.hand.holes), holes);

  // Close the pre-flop so the flop comes out, then try to take that back.
  await t.runToShowdown({ ...cast }, 3);
  assert.equal(t.room.hand.street, 'flop');
  const board = [...t.room.hand.board];
  await t.cmd(cast.ivan, '/undo');
  assert.deepEqual(t.room.hand.board, board, 'the flop stays out');
  assert.equal(t.room.hand.street, 'flop');

  // Host admin actions since the last card are still undoable.
  await t.cmd(cast.ivan, '/blinds 100 200');
  assert.deepEqual(t.room.pendingBlinds, { sb: 100, bb: 200 });
  await t.cmd(cast.ivan, '/undo');
  assert.equal(t.room.pendingBlinds, null, 'the blinds change was undone');
  assert.deepEqual(t.room.hand.board, board, 'and the cards did not move');
});

/* ------------------------------------------------------- restarts */

test('a restart mid-hand keeps the cards and deals the same turn it would have', async () => {
  const store = new Store(':memory:');
  const cast = THREE();
  const t = new Table({ store });
  await t.begin(cast, { blinds: [25, 50] });
  await t.runToShowdown(cast, 3); // to the flop
  assert.equal(t.room.hand.street, 'flop');
  const holes = JSON.stringify(t.room.hand.holes);
  const board = [...t.room.hand.board];
  const nextCard = t.room.hand.deck[t.room.hand.cursor];

  const app2 = new App({ api: t.tg, store, minIntervalMs: 0, botUsername: 'ChipTableBot' });
  app2.load();
  await app2.resume();
  const room2 = app2.room(t.chatId);
  assert.equal(JSON.stringify(room2.hand.holes), holes, 'nobody got new cards');
  assert.deepEqual(room2.hand.board, board);

  // Check the flop through on the restored bot.
  let guard = 0;
  while (room2.hand.street === 'flop' && guard++ < 6) {
    const who = Object.values(cast).find((u) => String(u.id) === room2.hand.actorId);
    const b = t.tg.message(room2.ui.tableMessageId).markup.inline_keyboard.flat().find((x) => x.text === 'CHECK');
    await app2.handleUpdate(pressUpdate(t.chatId, who, b.callback_data, room2.ui.tableMessageId));
    await app2.settle();
  }
  assert.equal(room2.hand.street, 'turn');
  assert.equal(room2.hand.board[3], nextCard, 'the turn is the card that was next in the saved deck');
  store.close();
});

/* ------------------------------------------------ the long run */

test('many random hands, buttons and typed commands mixed: cards and chips stay sound', async () => {
  const cast = CAST();
  const rnd = seededRng(4242);
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50], stack: 3000 });
  const TOTAL = t.chips();
  await t.press(cast.ivan, 'Начать игру');

  let hands = 0;
  let typed = 0;
  let guard = 0;
  while (t.room.status !== 'finished' && hands < 40 && guard++ < 3000) {
    const h = t.room.hand;
    if (h.phase === 'complete') {
      assert.equal(t.chips(), TOTAL, `chips leaked in hand ${h.no}`);
      hands++;
      await t.press(cast[['ivan', 'max', 'dima', 'sasha'][rnd(4)]], 'Следующая раздача');
      continue;
    }

    // Dealing is sound at every single step.
    const dealt = [...Object.values(h.holes).flat(), ...h.board];
    assert.equal(new Set(dealt).size, dealt.length, 'a card was dealt twice');
    assert.equal(h.board.length, BOARD_SIZE[h.street]);
    assert.ok(t.room.players.every((p) => p.stack >= 0));

    const who = t.actorOf(cast);
    const l = legalActions(t.room, String(who.id));
    const moves = [];
    if (l.canCheck) moves.push(['check'], ['check']);
    if (l.canCall) moves.push(['call'], ['call']);
    if (l.toCall > 0) moves.push(['fold']);
    if (l.canBet || l.canRaise) {
      const span = l.maxTotal - l.minTotal;
      moves.push([l.canBet ? 'bet' : 'raise', l.minTotal + rnd(Math.max(1, Math.floor(span / 3)))]);
      if (rnd(6) === 0) moves.push(['allin']);
    }
    const [move, amount] = moves[rnd(moves.length)];

    if (rnd(2) === 0) {
      typed++;
      await t.cmd(who, amount != null ? `/${move} ${amount}` : `/${move}`);
    } else if (move === 'allin') {
      await t.press(who, 'ALL-IN');
      await t.press(who, 'ПОДТВЕРДИТЬ');
    } else if (move === 'bet' || move === 'raise') {
      await t.pressData(who, `a:${move}:${t.room.seq}:${amount}`);
    } else {
      const label = { check: 'CHECK', call: 'CALL', fold: 'FOLD' }[move];
      await t.press(who, label);
    }
  }
  assert.ok(hands >= 10, `expected a long session, got ${hands} hands`);
  assert.ok(typed > 30, 'the typed path really was exercised');
  if (t.room.hand.phase === 'complete') assert.equal(t.chips(), TOTAL);
  assert.equal(t.errors.length, 0, t.errors.map((e) => e.message || e).join('; '));
});
