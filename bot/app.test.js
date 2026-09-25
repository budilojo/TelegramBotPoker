'use strict';
/**
 * End-to-end tests over a stubbed Telegram: the whole bot except the socket.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { App, parseCommand } from './app.js';
import { Store } from './store.js';
import { TelegramStub, cmdUpdate, pressUpdate } from './tg-stub.js';
import { preview } from './room.js';
import { totalPot } from '../server/game.js';

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

test('a double tap on "confirm winners" pays out once', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  await t.runToShowdown(cast);

  await t.press(cast.ivan, 'Макс');
  await t.press(cast.ivan, 'К распределению');
  const confirm = t.button('Подтвердить');

  const before = t.room.players.find((p) => p.id === '202').stack;
  await t.pressData(cast.ivan, confirm.callback_data);
  const after = t.room.players.find((p) => p.id === '202').stack;
  await t.pressData(cast.ivan, confirm.callback_data);

  assert.equal(t.room.players.find((p) => p.id === '202').stack, after);
  assert.ok(after > before, 'the pot was actually awarded once');
});

/* ------------------------------------------------------ chip conservation */

test('chips are conserved across many hands played through the bot', async () => {
  const cast = CAST();
  const t = new Table({ minIntervalMs: 0 });
  await t.seat(cast, { blinds: [25, 50] });
  const TOTAL = t.chips(); // before any blinds are posted
  await t.press(cast.ivan, 'Начать игру');

  for (let hand = 0; hand < 12; hand++) {
    if (t.room.status === 'finished') break;
    await t.runToShowdown(cast);
    if (t.room.hand.phase === 'showdown') {
      const pots = t.room.hand.pots;
      for (let i = 0; i < pots.length; i++) {
        if (pots[i].eligible.length <= 1) continue;
        const name = t.room.players.find((p) => p.id === pots[i].eligible[hand % pots[i].eligible.length]).name;
        await t.press(cast.ivan, name);
        await t.press(cast.ivan, t.button('Далее') ? 'Далее' : 'К распределению');
      }
      await t.press(cast.ivan, 'Подтвердить');
    }
    assert.equal(t.room.hand.phase, 'complete', `hand ${hand + 1} must be settled`);
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
});

/* ------------------------------------------------------------- side pots */

test('side pots through the bot pay exactly what the preview promised', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });

  // Three different stacks guarantee a main pot plus at least one side pot.
  const bySeat = { 101: 1000, 202: 3000, 303: 5000, 404: 5000 };
  for (const p of t.room.players) {
    p.stack = bySeat[p.id];
    p.stats.buyIn = bySeat[p.id];
  }
  const TOTAL = t.chips(); // before any blinds are posted
  await t.press(cast.ivan, 'Начать игру');

  await t.shoveDown(cast);

  assert.equal(t.room.hand.phase, 'showdown');
  assert.ok(t.room.hand.pots.length > 1, `expected side pots, got ${t.room.hand.pots.length}`);

  // Walk the pots, giving each one to its smallest eligible stack.
  let steps = 0;
  while (!t.room.ui.winner.review && steps++ < 6) {
    const pot = t.room.hand.pots[t.room.ui.winner.potIndex];
    const winner = t.room.players.find((p) => p.id === pot.eligible[0]);
    await t.press(cast.ivan, winner.name);
    await t.press(cast.ivan, t.button('Далее') ? 'Далее' : 'К распределению');
  }

  // What the review screen promises, straight from the engine's own
  // `distribution()` — the same call that is about to move the chips.
  const promised = preview(t.room);
  assert.ok(promised.length > 0);
  const reviewText = t.text();
  for (const row of promised) {
    assert.ok(
      reviewText.includes(row.name),
      `the review screen must name ${row.name}`
    );
  }

  const before = new Map(t.room.players.map((p) => [p.id, p.stack]));
  await t.press(cast.ivan, 'Подтвердить');

  for (const row of promised) {
    const delta = t.room.players.find((p) => p.id === row.playerId).stack - before.get(row.playerId);
    assert.equal(delta, row.amount, `${row.name} got ${delta}, preview said ${row.amount}`);
  }
  assert.equal(t.chips(), TOTAL, 'side-pot payout conserved chips');
});

test('a pot only one player can claim is a refund, never a question', async () => {
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') };
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  for (const p of t.room.players) {
    p.stack = p.id === '101' ? 200 : 5000;
    p.stats.buyIn = p.stack;
  }
  await t.press(cast.ivan, 'Начать игру');

  await t.shoveDown(cast);

  const solo = t.room.hand.pots.filter((p) => p.eligible.length === 1);
  for (const pot of solo) {
    assert.equal(pot.winners.length, 1, 'an uncontested pot is settled without asking');
  }
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

test('undo puts the chips back where they were', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  await t.runToShowdown(cast);
  await t.press(cast.ivan, 'Макс');
  await t.press(cast.ivan, 'К распределению');

  const before = t.room.players.map((p) => p.stack);
  await t.press(cast.ivan, 'Подтвердить');
  assert.notDeepEqual(t.room.players.map((p) => p.stack), before);

  await t.press(cast.ivan, 'Отменить результат');
  assert.deepEqual(t.room.players.map((p) => p.stack), before, 'undo restored every stack');
  assert.equal(t.room.hand.phase, 'showdown', 'and put the decision back on screen');
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
  assert.equal(room2.ui.tableMessageId, tableMessageId, 'it redrew the same pinned message');
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
  await t.press(cast.a, t.room.players.find((p) => p.id === t.room.hand.pots[0].eligible[0]).name);
  collect();

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
  await t.app.handleUpdate({
    update_id: 9,
    message: {
      message_id: 1,
      chat: { id: 555, type: 'private' },
      from: user(555, 'Иван'),
      text: '/newgame',
    },
  });
  await t.app.settle();
  assert.equal(t.app.room(555), null);
  assert.match(t.tg.messages.get(100).text, /групповом чате/);
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
  await t.press(cast.ivan, 'Макс');
  await t.press(cast.ivan, 'К распределению');
  await t.press(cast.ivan, 'Подтвердить');
  await t.press(cast.ivan, 'Следующая раздача');

  assert.equal(t.room.settings.bigBlind, 200);
  assert.equal(t.room.pendingBlinds, null);
});

test('/finish ends the game and posts an honest P/L table', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  await t.runToShowdown(cast);
  await t.press(cast.ivan, 'Макс');
  await t.press(cast.ivan, 'К распределению');
  await t.press(cast.ivan, 'Подтвердить');

  await t.cmd(cast.max, '/finish');
  assert.equal(t.room.status, 'playing', 'only the host may end the game');

  await t.cmd(cast.ivan, '/finish');
  assert.equal(t.room.status, 'finished');
  const results = t.lastPost();
  assert.match(results, /ИТОГИ/);
  assert.match(results, /Сумма P\/L: 0/, 'the table must balance to zero');
  for (const p of t.room.players) assert.ok(results.includes(p.name));
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
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  await t.press(cast.ivan, 'Начать игру');
  await t.shoveDown(cast);

  // Give the whole thing to one of them: heads-up, the other is now broke.
  const pot = t.room.hand.pots[0];
  const winner = t.room.players.find((p) => p.id === pot.eligible[0]);
  await t.press(cast.ivan, winner.name);
  await t.press(cast.ivan, 'К распределению');
  await t.press(cast.ivan, 'Подтвердить');

  assert.equal(t.room.status, 'finished', 'with one stack left the game is over');

  const broke = t.room.players.find((p) => p.stack === 0);
  assert.ok(broke, 'somebody really busted');
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
