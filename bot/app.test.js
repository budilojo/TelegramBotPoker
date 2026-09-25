'use strict';
/**
 * End-to-end tests over a stubbed Telegram: the whole bot except the socket.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, stack } from './harness.js';
import { App, parseCommand, amountArg } from './app.js';
import { Store } from './store.js';
import { pressUpdate } from './tg-stub.js';
import { totalPot, legalActions } from '../server/game.js';

/** The message of hand #no as it stands in the chat now (frozen or live). */
function handText(t, no) {
  let found = '';
  for (const m of t.tg.messages.values()) {
    if (m.chatId === String(t.chatId) && !m.deleted && m.text.includes(`РАЗДАЧА #${no}`)) found = m.text;
  }
  return found;
}

const CAST = () => ({
  ivan: user(101, 'Иван'),
  max: user(202, 'Макс'),
  dima: user(303, 'Дима'),
  sasha: user(404, 'Саша'),
});

/* ------------------------------------------------------ double submission */

test('tapping the same button twice applies it exactly once', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);

  const actor = t.actorOf(cast);
  const btn = t.button('CALL');
  const potBefore = totalPot(t.room);
  const stackBefore = t.room.players.find((p) => p.id === String(actor.id)).stack;

  await t.pressData(actor, btn.callback_data);
  const potAfterFirst = totalPot(t.room);
  const stackAfterFirst = t.room.players.find((p) => p.id === String(actor.id)).stack;

  // The identical button, pressed again before the keyboard refreshed.
  await t.pressData(actor, btn.callback_data);

  assert.equal(totalPot(t.room), potAfterFirst, 'the second tap put no chips in');
  assert.equal(t.room.players.find((p) => p.id === String(actor.id)).stack, stackAfterFirst);
  assert.ok(potAfterFirst > potBefore && stackAfterFirst < stackBefore, 'the first tap did act');
  assert.match(t.answer().text, /Уже применено/);
});

test('the same typed move sent twice within a second is applied once', async () => {
  // Heads-up the big blind closes the pre-flop AND acts first on the flop:
  // a duplicated /check would check a flop its author has not seen.
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  await t.press(t.actorOf(cast), 'CALL'); // the button (SB) completes

  const bb = t.actorOf(cast);
  assert.equal(String(bb.id), t.room.hand.bbId);
  await t.cmd(bb, '/check', { date: 2_000_000_000 });
  assert.equal(t.room.hand.street, 'flop');
  assert.equal(t.actor(), String(bb.id), 'the big blind is first on the flop');

  await t.cmd(bb, '/check', { date: 2_000_000_001 }); // the same tap, a second later
  assert.equal(t.actor(), String(bb.id), 'the duplicate did not act on the flop');
  assert.equal(t.room.players.find((p) => p.id === String(bb.id)).acted, false);
  assert.match(t.lastPost(), /повтор/i, 'and the author is told why');

  await t.cmd(bb, '/check', { date: 2_000_000_009 }); // a real decision, later
  assert.notEqual(t.actor(), String(bb.id), 'a deliberate move afterwards goes through');
});

/* ------------------------------------------------------ chip conservation */

test('chips are conserved across many hands played through the bot', async () => {
  const cast = CAST();
  const t = new Table({ minIntervalMs: 0 });
  await t.seat(cast, { blinds: [25, 50] });
  const TOTAL = t.chips(); // before any blinds are posted
  await t.press(cast.ivan, 'Начать игру');

  for (let hand = 0; hand < 12; hand++) {
    await t.runToShowdown(cast);
    assert.equal(t.room.hand.phase, 'complete', `hand ${hand + 1} must be settled by the bot itself`);
    assert.equal(t.chips(), TOTAL, `chips leaked after hand ${hand + 1}`);
    assert.ok(t.room.players.every((p) => p.stack >= 0), 'no negative stacks');
    if (t.room.status === 'finished') break;
    await t.press(cast.ivan, 'Следующая раздача');
  }
  assert.ok(t.room.handNo >= 5, `expected several hands, got ${t.room.handNo}`);
});

test('folding everyone out still conserves chips and needs no winner screen', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  const TOTAL = t.chips();
  await t.press(cast.ivan, 'Начать игру');

  // Everyone folds to the big blind: an uncontested pot is awarded by the
  // engine itself, with no human decision at all.
  let guard = 0;
  while (t.room.hand.phase === 'betting' && guard++ < 10) {
    const who = t.actorOf(cast);
    if (!t.button('FOLD')) break;
    await t.press(who, 'FOLD');
  }
  assert.equal(t.room.hand.phase, 'complete');
  assert.equal(t.chips(), TOTAL);
  assert.match(t.text(), /ЗАВЕРШЕНА/);
  assert.match(t.text(), /остальные сбросили/);
});

/* ------------------------------------------------------------- side pots */

test('a pot only one player can claim is a refund, never a question', async () => {
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') };
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  // Three different depths: the deepest stack shoves more than anyone can
  // call, and that excess is a pot with a single claimant.
  const depth = { 101: 200, 202: 3000, 303: 5000 };
  for (const p of t.room.players) {
    p.stack = depth[p.id];
    p.stats.buyIn = p.stack;
  }
  const TOTAL = t.chips();
  await t.press(cast.ivan, 'Начать игру');

  await t.shoveDown(cast);

  const solo = t.room.hand.pots.filter((p) => p.eligible.length === 1);
  assert.ok(solo.length > 0, 'the deep stacks over-shoved into a pot only they can win');
  for (const pot of solo) {
    assert.deepEqual(pot.winners, pot.eligible, 'an uncontested pot goes back to its only claimant');
  }
  assert.equal(t.chips(), TOTAL);
  assert.match(handText(t, 1), /\(возврат\)/);
});

/* ---------------------------------------------------------------- all-in */

test('ALL-IN takes two taps — one stray press cannot cost a stack', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);

  const actor = t.actorOf(cast);
  const before = t.room.players.find((p) => p.id === String(actor.id)).stack;

  await t.press(actor, 'ALL-IN');
  assert.equal(t.room.players.find((p) => p.id === String(actor.id)).stack, before, 'nothing moved yet');
  assert.match(t.answer().text, /ещё раз/i);
  assert.ok(t.button('ПОДТВЕРДИТЬ ALL-IN'), 'the keyboard now asks for confirmation');
  assert.equal(t.button('FOLD'), null, 'and nothing else can be pressed by mistake');

  await t.press(actor, 'ПОДТВЕРДИТЬ ALL-IN');
  assert.equal(t.room.players.find((p) => p.id === String(actor.id)).stack, 0);
});

test('the all-in confirmation belongs to the player who armed it', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const actor = t.actorOf(cast);
  const other = Object.values(cast).find((u) => String(u.id) !== String(actor.id));

  await t.press(actor, 'ALL-IN');
  const confirm = t.button('ПОДТВЕРДИТЬ ALL-IN');
  await t.pressData(other, confirm.callback_data);

  assert.ok(t.room.players.find((p) => p.id === String(actor.id)).stack > 0, 'nobody shoved for them');
  assert.match(t.answer().text, /Сейчас ходит/);
});

test('ALL-IN can be cancelled', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const actor = t.actorOf(cast);
  await t.press(actor, 'ALL-IN');
  await t.press(actor, 'Отмена');
  assert.ok(t.button('FOLD'), 'the normal keyboard is back');
  assert.equal(t.room.ui.armedAllIn, null);
});

test('a hidden ALL-IN is refused by the server, not just left off the keyboard', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  t.room.players[1].stack = 90; // Макс can only shove for less than a full raise
  t.room.players[1].stats.buyIn = 90;
  await t.press(cast.ivan, 'Начать игру');

  await t.press(cast.sasha, 'CALL');
  await t.press(cast.ivan, 'CALL');
  await t.press(cast.max, 'ALL-IN');
  await t.press(cast.max, 'ПОДТВЕРДИТЬ');
  await t.press(cast.dima, 'CALL');

  // Саша already called, so a short shove cannot re-open the betting for him.
  assert.equal(t.actor(), '404');
  assert.equal(t.button('ALL-IN'), null, 'the button is correctly absent');

  // …and pressing it anyway — a stale button, a forged payload — changes nothing.
  const before = t.room.players.find((p) => p.id === '404').stack;
  await t.pressData(cast.sasha, `a:allin:${t.room.seq}`);
  assert.equal(t.room.players.find((p) => p.id === '404').stack, before);
  assert.equal(t.room.hand.currentBet, 90, 'the betting was not re-opened');

  await t.pressData(cast.sasha, `a:allinok:${t.room.seq}`);
  assert.equal(t.room.hand.currentBet, 90);
});

/* ------------------------------------------------------------ typed moves */

test('typed moves do what the buttons do: /call, /raise N, /check, /fold', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  const bet = (u) => t.room.players.find((p) => p.id === String(u.id)).bet;

  let who = t.actorOf(cast);
  await t.cmd(who, '/call');
  assert.equal(bet(who), 50);

  who = t.actorOf(cast);
  await t.cmd(who, '/raise 300');
  assert.equal(bet(who), 300, '/raise N is a raise TO N — the total in front of you');
  assert.equal(t.room.hand.currentBet, 300);

  who = t.actorOf(cast);
  await t.cmd(who, '/fold');
  assert.equal(t.room.players.find((p) => p.id === String(who.id)).folded, true);

  who = t.actorOf(cast);
  await t.cmd(who, '/raise 1 000'); // with a thousands separator, as people type it
  assert.equal(bet(who), 1000);
});

test('/bet and /raise are forgiving about the word, strict about the chips', async () => {
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') };
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  const bet = (u) => t.room.players.find((p) => p.id === String(u.id)).bet;

  // Pre-flop there is a bet (the big blind): /bet 200 means "raise to 200".
  let who = t.actorOf(cast);
  await t.cmd(who, '/bet 200');
  assert.equal(bet(who), 200);

  // Nothing to call yet /call typed: that is a check, not an error.
  await t.runToShowdown(cast, 2);
  assert.equal(t.room.hand.street, 'flop');
  who = t.actorOf(cast);
  await t.cmd(who, '/call');
  assert.equal(t.room.players.find((p) => p.id === String(who.id)).lastAction, 'CHECK');

  // But never the other way round: /check facing a bet does not put chips in.
  who = t.actorOf(cast);
  await t.cmd(who, '/raise 100');
  const facing = t.actorOf(cast);
  const stack = t.room.players.find((p) => p.id === String(facing.id)).stack;
  await t.cmd(facing, '/check');
  assert.equal(t.room.players.find((p) => p.id === String(facing.id)).stack, stack);
  assert.equal(t.actor(), String(facing.id), 'still their decision');
  assert.match(t.lastPost(), /Чек нельзя/);
});

test('a typed amount outside the legal range is refused with the range, and moves nothing', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  const who = t.actorOf(cast);
  const before = t.room.players.map((p) => p.stack);

  await t.cmd(who, '/raise 70'); // min raise is to 100
  assert.match(t.lastPost(), /Можно от 100 до 10000/);
  await t.cmd(who, '/raise 999999');
  assert.match(t.lastPost(), /Можно от 100 до 10000/);
  await t.cmd(who, '/raise');
  assert.match(t.lastPost(), /Сколько\?/);
  await t.cmd(who, '/raise 2.5к');
  assert.match(t.lastPost(), /Сколько\?/, 'a guess about chips is a bet nobody made');

  assert.deepEqual(t.room.players.map((p) => p.stack), before);
  assert.equal(t.actor(), String(who.id));
});

test('/raise with only enough chips to call says so, instead of blaming a short all-in', async () => {
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') };
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  t.room.players[2].stack = 300; // Дима, the big blind, is short
  t.room.players[2].stats.buyIn = 300;
  await t.press(cast.ivan, 'Начать игру');

  await t.cmd(cast.ivan, '/raise 1000');
  await t.cmd(cast.max, '/call');
  assert.equal(t.actor(), '303');
  await t.cmd(cast.dima, '/raise 2000');
  assert.match(t.lastPost(), /хватает только на колл: \/call 250/);
  assert.doesNotMatch(t.lastPost(), /короткий олл-ин/);
  assert.equal(t.actor(), '303', 'still his decision');
});

test('a typed /allin cannot re-open betting that a short all-in closed', async () => {
  // The same rule as the hidden ALL-IN button — a typed command has no
  // button to hide, so only the server check stands in the way.
  const cast = CAST();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  t.room.players[1].stack = 90;
  t.room.players[1].stats.buyIn = 90;
  await t.press(cast.ivan, 'Начать игру');

  await t.cmd(cast.sasha, '/call');
  await t.cmd(cast.ivan, '/call');
  await t.cmd(cast.max, '/allin'); // 90: short of a full raise
  await t.cmd(cast.dima, '/call');

  assert.equal(t.actor(), '404');
  const before = t.room.players.find((p) => p.id === '404').stack;
  await t.cmd(cast.sasha, '/allin');
  assert.equal(t.room.players.find((p) => p.id === '404').stack, before);
  assert.equal(t.room.hand.currentBet, 90, 'the betting stayed closed');
  assert.match(t.lastPost(), /Повышать нельзя/);
});

test('while people type, the table follows them to the bottom of the chat', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  const first = t.tableId;

  // A button press edits in place: the table is where the finger is.
  await t.press(t.actorOf(cast), 'CALL');
  assert.equal(t.tableId, first);

  // Chat moves on — two messages the bot never sees (privacy mode), then a
  // typed command. The command's id reveals how far the table was buried.
  t.tg.nextId += 2;
  await t.cmd(t.actorOf(cast), '/call');
  assert.ok(t.tableId > first, 'a fresh copy was posted below the conversation');
  assert.equal(t.tg.message(first).deleted, true, 'and the buried copy removed, not left to confuse');
  assert.equal(
    [...t.tg.messages.values()].filter((m) => m.chatId === String(t.chatId) && !m.deleted && m.text.includes('РАЗДАЧА #1')).length,
    1,
    'exactly one live table'
  );

  // Right under the table, a command does not need a new copy.
  const now = t.tableId;
  await t.cmd(t.actorOf(cast), '/call');
  assert.equal(t.tableId, now, 'one message below is still in view: edited in place');
});

/* ------------------------------------------------- people come and go */

test('a player removed mid-hand leaves their chips in the pot and their result in the P/L', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  const TOTAL = t.chips();
  await t.press(cast.ivan, 'Начать игру');

  // Саша raises, then the host removes him while the hand is on.
  assert.equal(t.actor(), '404');
  await t.cmd(cast.sasha, '/raise 500');
  await t.cmd(cast.ivan, '/kick');
  await t.panel(cast.ivan, 'Саша');

  const sasha = t.room.players.find((p) => p.id === '404');
  assert.ok(sasha, 'the row stays — the engine sums the pot from it');
  assert.equal(sasha.folded, true);
  assert.equal(totalPot(t.room), 500 + 25 + 50, 'his 500 are still in the pot');
  assert.equal(t.chips(), TOTAL, 'nothing vanished with him');

  await t.runToShowdown({ ivan: cast.ivan, max: cast.max, dima: cast.dima });
  assert.equal(t.chips(), TOTAL);
  await t.press(cast.ivan, 'Следующая раздача');
  assert.equal(t.room.players.find((p) => p.id === '404').inHand, false, 'not dealt in again');

  await t.cmd(cast.sasha, '/join');
  assert.equal(t.room.players.find((p) => p.id === '404').kicked, true, 'and cannot walk back in');

  await t.cmd(cast.ivan, '/finish');
  assert.match(t.lastPost(), /Саша \(удалён\)/);
  assert.match(t.lastPost(), /Сумма P\/L: 0/, 'his −500 is part of the evening');
});

test('/leave and then /join puts you back in the game', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  await t.cmd(cast.dima, '/leave');
  const dima = () => t.room.players.find((p) => p.id === '303');
  assert.equal(dima().sittingOut, true);

  await t.cmd(cast.dima, '/join');
  assert.equal(dima().sittingOut, false, 'a second /join is "I am back", not a no-op');
  await t.runToShowdown(cast);
  await t.press(cast.ivan, 'Следующая раздача');
  assert.equal(dima().inHand, true);
});

test('when the last opponent walks out, the pot goes to the one left — nobody moves for them', async () => {
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  const TOTAL = t.chips();
  await t.press(cast.ivan, 'Начать игру');

  // Heads-up: Иван (button) is on the clock; Макс leaves the group.
  assert.equal(t.actor(), '101');
  await t.raw({
    update_id: 11,
    message: {
      message_id: t.tg.nextId++,
      chat: { id: t.chatId, type: 'supergroup' },
      from: cast.max,
      left_chat_member: { id: 202, is_bot: false, first_name: 'Макс' },
    },
  });

  const ivan = t.room.players.find((p) => p.id === '101');
  assert.equal(t.room.hand.phase, 'complete', 'the hand is closed, not left waiting on Иван');
  assert.equal(ivan.lastAction, 'SB', 'Иван made no move: none was made in his name');
  assert.equal(t.chips(), TOTAL);
  assert.equal(ivan.stack, 10050, 'he takes back his blind and Макс\'s');
});

test('an all-in player who leaves the chat keeps their hand in play', async () => {
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') };
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  t.useDeck(stack({ 101: 'As Ah', 202: 'Kd Kc', 303: '7c 2d' }, 'Qs 9h 4d 3c 8s'));
  await t.press(cast.ivan, 'Начать игру');
  await t.press(cast.ivan, 'ALL-IN');
  await t.press(cast.ivan, 'ПОДТВЕРДИТЬ');

  await t.raw({
    update_id: 12,
    message: {
      message_id: t.tg.nextId++,
      chat: { id: t.chatId, type: 'supergroup' },
      from: cast.ivan,
      left_chat_member: { id: 101, is_bot: false, first_name: 'Иван' },
    },
  });
  assert.equal(t.room.players.find((p) => p.id === '101').folded, false, 'nothing left to decide, nothing to fold');

  await t.press(cast.max, 'CALL');
  await t.press(cast.dima, 'FOLD');
  assert.equal(t.room.hand.pots[0].winners[0], '101', 'his aces still win');
});

test('only somebody at the table can deal the next hand', async () => {
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };
  const t = new Table();
  await t.begin(cast);
  await t.runToShowdown(cast);
  const n = t.room.handNo;

  await t.press(user(9999, 'Прохожий'), 'Следующая раздача');
  assert.equal(t.room.handNo, n);
  assert.match(t.answer().text, /не за столом/);

  await t.cmd(cast.max, '/next');
  assert.equal(t.room.handNo, n + 1);
});

/* --------------------------------------------------------- custom amount */

test('a custom amount is validated by the server, not by the client', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  const actor = t.actorOf(cast);

  await t.press(actor, 'Своя сумма');
  const promptId = t.room.ui.pendingBet.promptMessageId;
  assert.ok(promptId, 'a ForceReply prompt was sent');
  assert.equal(t.room.ui.pendingBet.userId, String(actor.id));

  // Below the minimum raise: refused, the prompt stays open.
  await t.cmd(actor, '7', { reply_to_message: { message_id: promptId } });
  assert.match(t.lastPost(), /Нужна сумма от/);
  assert.ok(t.room.ui.pendingBet, 'still waiting for a usable number');

  // A legal one goes through.
  await t.cmd(actor, '400', { reply_to_message: { message_id: promptId } });
  assert.equal(t.room.players.find((p) => p.id === String(actor.id)).bet, 400);
  assert.equal(t.room.ui.pendingBet, null);
});

test('somebody else answering the amount prompt does not bet for you', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  const actor = t.actorOf(cast);
  const other = Object.values(cast).find((u) => String(u.id) !== String(actor.id));

  await t.press(actor, 'Своя сумма');
  const promptId = t.room.ui.pendingBet.promptMessageId;
  const potBefore = totalPot(t.room);

  await t.cmd(other, '5000', { reply_to_message: { message_id: promptId } });

  assert.equal(totalPot(t.room), potBefore, 'no chips moved');
  assert.match(t.lastPost(), /Эту ставку делает/);
  assert.ok(t.room.ui.pendingBet, 'the real player can still answer');
});

/* ------------------------------------------------------- one game per chat */

test('a second /newgame is refused while a table is live', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast);
  const firstId = t.tableId;

  await t.cmd(cast.max, '/newgame');
  assert.equal(t.tableId, firstId, 'the existing table is untouched');
  assert.equal(t.room.hostId, '101', 'and the host did not change');
  assert.match(t.lastPost(), /Стол уже создан/);
});

test('/cancel by the host frees the chat for a new game', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast);
  await t.cmd(cast.max, '/cancel');
  assert.ok(t.room, 'a non-host cannot cancel');

  await t.cmd(cast.ivan, '/cancel');
  assert.equal(t.room, null);
  await t.cmd(cast.max, '/newgame');
  assert.equal(t.room.hostId, '202');
});

/* ----------------------------------------------------------------- leave */

test('leaving the group mid-hand folds the player and unblocks the table', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  const actor = t.actorOf(cast);
  const TOTAL = t.chips();

  await t.raw({
    update_id: 1,
    message: {
      message_id: 5000,
      chat: { id: t.chatId, type: 'supergroup' },
      from: actor,
      left_chat_member: { id: actor.id, is_bot: false, first_name: actor.first_name },
    },
  });

  const p = t.room.players.find((x) => x.id === String(actor.id));
  assert.equal(p.left, true);
  assert.equal(p.folded, true, 'they were folded out so the hand can continue');
  assert.notEqual(t.actor(), String(actor.id), 'the clock moved on');
  assert.equal(t.chips() + totalPot(t.room), TOTAL + totalPot(t.room), 'chips intact');
});

test('when the host leaves, the table gets a new one instead of freezing', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  await t.raw({
    update_id: 2,
    message: {
      message_id: 5001,
      chat: { id: t.chatId, type: 'supergroup' },
      from: cast.ivan,
      left_chat_member: { id: 101, is_bot: false, first_name: 'Иван' },
    },
  });
  assert.notEqual(t.room.hostId, '101');
  assert.ok(t.room.players.find((p) => p.id === t.room.hostId));
});

/* ------------------------------------------------------------------ undo */

test('undo takes back the host\'s own admin action, and says so', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  await t.cmd(cast.ivan, '/rebuy');
  await t.panel(cast.ivan, 'Дима'); // a tap on the wrong name

  const dima = () => t.room.players.find((p) => p.id === '303');
  assert.equal(dima().stats.buyIn, 20000);
  await t.cmd(cast.ivan, '/undo');
  assert.equal(dima().stats.buyIn, 10000, 'the re-buy was taken back');
  assert.match(t.lastPost(), /Отменено: докупка: Дима/);

  // A bet is not an admin action: after one, there is nothing left to undo.
  await t.press(t.actorOf(cast), 'CALL');
  await t.cmd(cast.ivan, '/undo');
  assert.match(t.lastPost(), /Ставки и раздачи не отменяются/);
});

/* ------------------------------------------------------------- restarts */

test('a restart mid-hand restores the table and play continues', async () => {
  const store = new Store(':memory:');
  const cast = CAST();
  const t = new Table({ store });
  await t.begin(cast, { blinds: [25, 50] });
  await t.press(t.actorOf(cast), 'CALL');

  const handNo = t.room.handNo;
  const actorId = t.actor();
  const stacks = t.room.players.map((p) => p.stack);
  const tableMessageId = t.room.ui.tableMessageId;

  // A brand new process, same database, same chat.
  const app2 = new App({ api: t.tg, store, minIntervalMs: 0, botUsername: 'ChipTableBot' });
  assert.equal(app2.load(), 1);
  await app2.resume();

  const room2 = app2.room(t.chatId);
  assert.equal(room2.handNo, handNo);
  assert.equal(room2.hand.actorId, actorId, 'the same player is still on the clock');
  assert.deepEqual(room2.players.map((p) => p.stack), stacks);
  assert.equal(room2.ui.tableMessageId, tableMessageId, 'it redrew the same table message');
  assert.match(t.tg.message(tableMessageId).text, /РАЗДАЧА/);

  // And the restored table still takes actions.
  const who = Object.values(cast).find((u) => String(u.id) === room2.hand.actorId);
  const btn = t.tg.message(tableMessageId).markup.inline_keyboard.flat()
    .find((b) => /CALL|CHECK/.test(b.text));
  await app2.handleUpdate(pressUpdate(t.chatId, who, btn.callback_data, tableMessageId));
  await app2.settle();
  assert.notEqual(room2.hand.actorId, actorId, 'the restored table accepted a move');
  store.close();
});

test('a group promoted to a supergroup keeps its table', async () => {
  const store = new Store(':memory:');
  const cast = CAST();
  const t = new Table({ store });
  await t.begin(cast);
  const handNo = t.room.handNo;
  const NEW_ID = -1009999;

  await t.raw({
    update_id: 3,
    message: {
      message_id: 6000,
      chat: { id: t.chatId, type: 'group' },
      from: cast.ivan,
      migrate_to_chat_id: NEW_ID,
    },
  });

  assert.equal(t.app.room(t.chatId), null, 'the old chat id is gone');
  const moved = t.app.room(NEW_ID);
  assert.ok(moved, 'the table followed the chat');
  assert.equal(moved.handNo, handNo);
  assert.equal(moved.chatId, String(NEW_ID));
  assert.equal(store.loadAll()[0].chatId, String(NEW_ID), 'and so did the saved row');
  store.close();
});

/* --------------------------------------------------- Telegram API limits */

test('an unchanged table is never re-sent (no "message is not modified")', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);

  const edits = t.tg.countOf('editMessageText');
  await t.app.draw(t.room, { immediate: true });
  await t.app.draw(t.room, { immediate: true });

  assert.equal(t.tg.countOf('editMessageText'), edits, 'identical state produced no API call');
  assert.equal(t.errors.length, 0, 'and therefore no 400 from Telegram');
});

test('a deleted table message is replaced instead of crashing the game', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const oldId = t.tableId;

  await t.tg.deleteMessage(t.chatId, oldId); // somebody cleaned up the chat
  await t.press(t.actorOf(cast), t.button('CALL') ? 'CALL' : 'CHECK');

  assert.notEqual(t.tableId, oldId, 'a fresh table message was posted');
  assert.match(t.text(), /РАЗДАЧА/);
  assert.equal(t.errors.length, 0);
});

test('a burst of actions is coalesced into one edit of the latest state', async () => {
  const cast = CAST();
  const t = new Table({ minIntervalMs: 1000 });
  await t.begin(cast, { blinds: [25, 50] });
  await t.app.settle();

  const before = t.tg.countOf('editMessageText') + t.tg.countOf('sendMessage');

  // Four players act back to back, faster than the rate limit allows drawing.
  let acted = 0;
  while (t.room.hand?.phase === 'betting' && acted < 6) {
    const who = t.actorOf(cast);
    await t.fire(who, t.button('CHECK') ? 'CHECK' : 'CALL');
    acted++;
  }
  await t.app.settle();

  const calls = t.tg.countOf('editMessageText') + t.tg.countOf('sendMessage') - before;
  assert.ok(acted >= 4, 'the burst really happened');
  assert.ok(calls <= 2, `${acted} actions should not mean ${calls} API calls`);

  // And what is on screen is the LATEST state, not a stale intermediate one.
  assert.equal(t.text(), t.tg.message(t.tableId).text);
  const actorName = t.room.players.find((p) => p.id === t.actor())?.name;
  if (actorName) assert.ok(t.text().includes(actorName), 'the newest actor is the one shown');
});

test('every button ever rendered fits in 64 bytes, even with real Telegram ids', async () => {
  // Real ids are 10 digits today and will be longer tomorrow.
  const cast = {
    a: user(7654321098, 'Иван'),
    b: user(8765432109, 'Макс'),
    c: user(9876543210, 'Дима'),
    d: user(1234567890123, 'Саша'),
  };
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });

  const seen = new Set();
  const collect = () => t.buttons().forEach((b) => seen.add(b.callback_data));
  collect();
  await t.press(t.actorOf(cast), 'ALL-IN');
  collect();
  await t.press(t.actorOf(cast), 'ПОДТВЕРДИТЬ ALL-IN');
  collect();
  await t.runToShowdown(cast);
  collect();
  if (t.room.status !== 'finished') {
    await t.press(cast.a, 'Следующая раздача');
    collect();
  }
  await t.cmd(cast.a, '/kick');
  t.lastPanel().markup.inline_keyboard.flat().forEach((b) => seen.add(b.callback_data));
  await t.cmd(cast.a, '/rebuy');
  t.lastPanel().markup.inline_keyboard.flat().forEach((b) => seen.add(b.callback_data));

  assert.ok(seen.size > 8, `expected a decent sample, got ${seen.size}`);
  for (const data of seen) {
    assert.ok(
      Buffer.byteLength(data, 'utf8') <= 64,
      `callback_data "${data}" is ${Buffer.byteLength(data, 'utf8')} bytes`
    );
  }
  assert.equal(t.errors.length, 0, 'the stub rejects oversized callback_data, so this proves it');
});

/* -------------------------------------------------------------- commands */

test('commands addressed to another bot are ignored', async () => {
  const t = new Table({ botUsername: 'ChipTableBot' });
  await t.cmd(user(101, 'Иван'), '/newgame@SomeOtherBot');
  assert.equal(t.room, null);

  await t.cmd(user(101, 'Иван'), '/newgame@ChipTableBot');
  assert.ok(t.room, 'but ours are answered');
});

test('the game refuses to run outside a group', async () => {
  const t = new Table();
  const ivan = user(555, 'Иван');
  await t.start(ivan);
  await t.dm(ivan, '/newgame');
  assert.equal(t.app.room(555), null, 'no table in a private chat');
  assert.match(t.lastDm(ivan), /в группе/);
});

test('blinds changed mid-game land on the next hand, not this one', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });

  await t.cmd(cast.ivan, '/blinds 100 200');
  assert.equal(t.room.settings.bigBlind, 50, 'the running hand keeps its price');
  assert.deepEqual(t.room.pendingBlinds, { sb: 100, bb: 200 });
  assert.match(t.text(), /25\/50 → 100\/200/, 'and everyone can see it coming');

  await t.runToShowdown(cast);
  await t.press(cast.ivan, 'Следующая раздача');

  assert.equal(t.room.settings.bigBlind, 200);
  assert.equal(t.room.pendingBlinds, null);
});

test('/finish ends the game and posts an honest P/L table', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  await t.runToShowdown(cast);
  await t.press(cast.ivan, 'Следующая раздача');
  await t.press(t.actorOf(cast), 'CALL'); // chips in the pot of an unfinished hand

  await t.cmd(cast.max, '/finish');
  assert.equal(t.room.status, 'playing', 'only the host may end the game');

  await t.cmd(cast.ivan, '/finish');
  assert.equal(t.room.status, 'finished');
  const results = t.lastPost();
  assert.match(results, /ИТОГИ/);
  assert.match(results, /Сумма P\/L: 0/, 'the unfinished pot went back — the table balances');
  for (const p of t.room.players) assert.ok(results.includes(p.name));
  assert.match(handText(t, 2), /ПРЕРВАНА/, 'the abandoned hand says so instead of pretending');
});

test('a re-buy tops up the stack and the buy-in, so P/L stays honest', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast);
  await t.cmd(cast.ivan, '/rebuy');

  // A non-host pressing the panel does nothing.
  await t.panel(cast.max, 'Дима');
  assert.equal(t.room.players.find((p) => p.id === '303').stack, 10000);
  assert.match(t.answer().text, /только хост/i);

  await t.panel(cast.ivan, 'Дима');
  const dima = t.room.players.find((p) => p.id === '303');
  assert.equal(dima.stack, 20000);
  assert.equal(dima.stats.buyIn, 20000, 'a top-up is not winnings');
  assert.equal(dima.stack - dima.stats.buyIn, 0, 'so the P/L column still reads zero');
});

test('a busted player can be brought back instead of ending the evening', async () => {
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') };
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  // Иван shoves seven-deuce into aces; Дима stays out of it.
  t.useDeck(stack({ 101: '7c 2d', 202: 'As Ah', 303: '9c 8c' }, 'Kd Qh 4s 5d Jc'));
  await t.press(cast.ivan, 'Начать игру');
  await t.press(cast.ivan, 'ALL-IN');
  await t.press(cast.ivan, 'ПОДТВЕРДИТЬ');
  await t.press(cast.max, 'CALL'); // covering the shove is a call, not a raise
  await t.press(cast.dima, 'FOLD');

  const ivan = () => t.room.players.find((p) => p.id === '101');
  assert.equal(ivan().stack, 0, 'Иван busted');
  assert.equal(t.room.status, 'playing', 'two stacks left: the evening goes on');

  await t.cmd(cast.ivan, '/rebuy');
  await t.panel(cast.ivan, 'Иван');
  assert.equal(ivan().stack, 10000);
  await t.press(cast.max, 'Следующая раздача');
  assert.equal(ivan().inHand, true, 'back in from the next hand');
  assert.equal(t.hole(cast.ivan).length, 2, 'with cards');
});

test('when only one stack is left, the game ends and the results are posted', async () => {
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  t.useDeck(stack({ 101: '7c 2d', 202: 'As Ah' }, 'Kd Qh 4s 5d Jc'));
  await t.press(cast.ivan, 'Начать игру');
  await t.shoveDown(cast);

  assert.equal(t.room.status, 'finished');
  assert.match(t.lastPost(), /ИТОГИ/);
  assert.match(t.lastPost(), /Сумма P\/L: 0/);
  assert.match(handText(t, 1), /🏆 <b>Макс<\/b> \+20 000/, 'the deciding hand is shown, not cut off');
});

test('the host can hand the room over, and only the host can', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast);
  await t.cmd(cast.ivan, '/host');

  await t.panel(cast.max, 'Дима');
  assert.equal(t.room.hostId, '101', 'a non-host cannot appoint a host');

  await t.panel(cast.ivan, 'Дима');
  assert.equal(t.room.hostId, '303');

  // The old host has really lost the rights.
  await t.cmd(cast.ivan, '/blinds 500 1000');
  assert.equal(t.room.settings.bigBlind, 50);
  await t.cmd(cast.dima, '/blinds 500 1000');
  assert.equal(t.room.settings.bigBlind, 1000);
});

test('/level bumps the blind ladder early — host only, next hand only', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  await t.cmd(cast.ivan, '/levels 20');
  await t.press(cast.ivan, 'Начать игру');

  await t.cmd(cast.max, '/level');
  assert.equal(t.room.level.index, 0, 'a player cannot move the ladder');

  await t.cmd(cast.ivan, '/level');
  assert.equal(t.room.level.index, 1);
  assert.equal(t.room.settings.bigBlind, 50, 'the running hand keeps its price');
  assert.deepEqual(t.room.pendingBlinds, { sb: 50, bb: 100 });

  // A fixed-blinds table refuses, with a reason.
  const t2 = new Table();
  await t2.seat(cast, { blinds: [25, 50] });
  await t2.press(cast.ivan, 'Начать игру');
  await t2.cmd(cast.ivan, '/level');
  assert.match(t2.lastPost(), /Растущие блайнды выключены/);
});

test('parseCommand handles the shapes Telegram actually sends', () => {
  assert.deepEqual(parseCommand('/join'), { cmd: 'join', rest: '', args: [] });
  assert.deepEqual(parseCommand('  /JOIN  '), { cmd: 'join', rest: '', args: [] });
  assert.deepEqual(parseCommand('/blinds 25 50'), { cmd: 'blinds', rest: '25 50', args: ['25', '50'] });
  assert.deepEqual(parseCommand('/blinds   25    50'), { cmd: 'blinds', rest: '25    50', args: ['25', '50'] });
  assert.deepEqual(parseCommand('/join@ChipTableBot', 'ChipTableBot'), { cmd: 'join', rest: '', args: [] });
  assert.deepEqual(parseCommand('/join@chiptablebot', 'ChipTableBot'), { cmd: 'join', rest: '', args: [] });

  assert.equal(parseCommand('/join@OtherBot', 'ChipTableBot'), null, 'addressed to somebody else');
  assert.equal(parseCommand('привет'), null);
  assert.equal(parseCommand('не /join'), null, 'a command must start the message');
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand('/'), null);
});

test('amountArg reads chip amounts the way people type them, and nothing else', () => {
  assert.equal(amountArg('3000'), 3000);
  assert.equal(amountArg('3 000'), 3000);
  assert.equal(amountArg('3\u00a0000'), 3000);
  assert.equal(amountArg('3_000'), 3000);
  for (const bad of ['', '3к', '2.5', '-100', '1e5', 'все', '0x10']) {
    assert.equal(amountArg(bad), null, `"${bad}" is not an amount`);
  }
});
