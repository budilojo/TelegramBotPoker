'use strict';
/**
 * The bot around the table: the group is the lobby and the notice board,
 * the private chat is for "your turn", and the game itself is in the Mini
 * App. End-to-end over a stubbed Telegram — the whole bot except the socket.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, stack, TEST_TOKEN, initDataFor, FakeClock } from './harness.js';
import { App, parseCommand } from './app.js';
import { Hub } from './hub.js';
import { Store } from './store.js';
import { totalPot } from '../server/game.js';

const CAST = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима'), sasha: user(404, 'Саша') });
const THREE = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') });

/** New messages the bot posted into the group (not edits). */
const groupPosts = (t) => t.tg.calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(t.chatId));

/* ------------------------------------------------------------ the card */

test('/newgame posts one card whose button opens exactly this table', async () => {
  const t = new Table({ botUsername: 'All_InPoker_bot', miniAppName: 'table' });
  await t.cmd(user(101, 'Иван'), '/newgame');
  const [btn] = t.cardButtons();
  assert.equal(btn.text, '🃏 Открыть стол');
  assert.equal(btn.url, `https://t.me/All_InPoker_bot/table?startapp=${t.room.code}`);
  assert.match(t.room.code, /^[a-z0-9]{10}$/, 'a random code…');
  assert.ok(!btn.url.includes(String(t.chatId).replace('-', '')), '…that is not the chat id');
  assert.match(t.text(), /Покерная комната/);
  assert.match(t.text(), /Игроков: <b>1\/8<\/b>/);
  assert.match(t.text(), /Ожидание игроков/);
});

test('without a registered Mini App the button goes through the private chat, which answers with the table', async () => {
  const t = new Table({ botUsername: 'All_InPoker_bot', miniAppName: '', webappUrl: 'https://poker.example' });
  await t.cmd(user(101, 'Иван'), '/newgame');
  const [btn] = t.cardButtons();
  assert.equal(btn.url, `https://t.me/All_InPoker_bot?start=t_${t.room.code}`);

  const max = user(202, 'Макс');
  await t.start(max, `t_${t.room.code}`);
  const dm = t.tg.messages.get([...t.tg.messages.keys()].at(-1));
  const wa = dm.markup.inline_keyboard[0][0];
  assert.deepEqual(wa.web_app, { url: `https://poker.example/?room=${t.room.code}` }, 'a web_app button — allowed in private chats');
  assert.equal(t.room.players.length, 1, 'the link seats nobody');
});

test('the card follows the game: seats, the hand, whose turn — by editing, not by posting', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast);
  assert.match(t.text(), /Игроков: <b>3\/8<\/b> — Иван, Макс, Дима/);
  const posts = groupPosts(t).length;

  await t.send(cast.ivan, { t: 'start' });
  const actor = t.room.players.find((p) => p.id === t.actor());
  assert.match(t.text(), /Идёт игра · раздача #1 · ПРЕФЛОП/);
  assert.match(t.text(), new RegExp(`👉 Ход: <b>${actor.name}</b>`));
  await t.runToShowdown(cast);
  assert.match(t.text(), /🏆/);
  assert.equal(groupPosts(t).length, posts, 'a whole hand, and not one new message in the group');
});

test('a whole evening puts exactly two messages in the group: the card and the results', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { dm: false });
  for (let i = 0; i < 4 && t.room.status !== 'finished'; i++) {
    if (i === 0) await t.send(cast.ivan, { t: 'start' });
    else await t.send(cast.max, { t: 'next' });
    await t.runToShowdown(cast);
  }
  await t.cmd(cast.ivan, '/finish');
  const posts = groupPosts(t);
  assert.equal(posts.length, 2, posts.map((p) => p.text.slice(0, 30)).join(' | '));
  assert.match(posts[0].text, /Покерная комната/);
  assert.match(posts[1].text, /ИТОГИ/);
});

test('a second /newgame is refused while a table is live; /table brings the card back down', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast);
  const code = t.room.code;
  const first = t.cardId;
  await t.cmd(cast.max, '/newgame');
  assert.equal(t.room.code, code);
  assert.match(t.lastPost(), /Стол уже есть/);

  await t.cmd(cast.max, '/table');
  assert.notEqual(t.cardId, first, 'a fresh card at the bottom of the chat');
  assert.equal(t.tg.message(first).markup, null, 'the old one lost its button');
});

test('/cancel is the host\'s, and frees the chat for a new game', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast);
  await t.cmd(cast.max, '/cancel');
  assert.ok(t.room, 'a non-host cannot cancel');
  await t.cmd(cast.ivan, '/cancel');
  assert.equal(t.room, null);
  assert.ok(t.page(cast.max).inbox.some((m) => m.t === 'gone'), 'open tables are told the game is gone');
  await t.cmd(cast.max, '/newgame');
  assert.equal(t.room.hostId, '202');
});

test('buttons left over from the chat version are still answered — never a spinner', async () => {
  const t = new Table();
  await t.cmd(user(101, 'Иван'), '/newgame');
  await t.pressData(user(202, 'Макс'), 'a:call:5');
  assert.equal(t.answer().url, `https://t.me/ChipTableBot/table?startapp=${t.room.code}`, 'straight to the table');
});

test('commands addressed to another bot are ignored', async () => {
  const t = new Table({ botUsername: 'ChipTableBot' });
  await t.cmd(user(101, 'Иван'), '/newgame@SomeOtherBot');
  assert.equal(t.room, null);
  await t.cmd(user(101, 'Иван'), '/newgame@ChipTableBot');
  assert.ok(t.room);
});

test('parseCommand handles the shapes Telegram actually sends', () => {
  assert.deepEqual(parseCommand('/join'), { cmd: 'join', rest: '', args: [] });
  assert.deepEqual(parseCommand('  /JOIN  '), { cmd: 'join', rest: '', args: [] });
  assert.deepEqual(parseCommand('/start t_abc123'), { cmd: 'start', rest: 't_abc123', args: ['t_abc123'] });
  assert.deepEqual(parseCommand('/join@ChipTableBot', 'ChipTableBot'), { cmd: 'join', rest: '', args: [] });
  assert.equal(parseCommand('/join@OtherBot', 'ChipTableBot'), null);
  assert.equal(parseCommand('привет'), null);
  assert.equal(parseCommand('не /join'), null);
});

/* ------------------------------------------------------- "your turn" */

test('a closed table gets a ping with a button; an open one gets nothing', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast);
  // Иван (first to act) closes the app before the host deals.
  t.close(cast.ivan);
  await t.send(cast.max, { t: 'sit' }); // noop, keeps Макс's page
  const host = cast.ivan;
  t.open(host); // the host opens again to deal…
  await t.send(host, { t: 'start' });
  // …and Иван is on the clock with his table OPEN: no ping.
  assert.equal(t.actor(), '101');
  assert.ok(!t.tg.dms(101).some((x) => /Ваш ход/.test(x)), 'looking at the table already — no ping');

  // He moves; Макс is next and has his table open too: no ping.
  await t.act(cast.ivan, 'call');
  assert.equal(t.actor(), '202');
  assert.ok(!t.tg.dms(202).some((x) => /Ваш ход/.test(x)));

  // Дима puts the app in the background, Макс calls: Дима gets pinged.
  await t.send(cast.dima, { t: 'visible', visible: false });
  await t.act(cast.max, 'call');
  assert.equal(t.actor(), '303');
  const ping = t.lastDm(cast.dima);
  assert.match(ping, /Ваш ход/);
  assert.match(ping, /Раздача #1/);
  const msg = [...t.tg.messages.values()].filter((m) => m.chatId === '303').at(-1);
  assert.equal(msg.markup.inline_keyboard[0][0].web_app.url, `https://poker.example/?room=${t.room.code}`);
  assert.ok(!t.tg.dms(101).some((x) => /Ваш ход/.test(x)) && !t.tg.dms(202).some((x) => /Ваш ход/.test(x)), 'nobody else was pinged');
});

test('the ping disappears once the turn has passed — no stale "your turn" in the chat', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast);
  await t.send(cast.max, { t: 'visible', visible: false });
  await t.act(cast.ivan, 'call');
  assert.equal(t.actor(), '202');
  const pingId = [...t.tg.messages.entries()].filter(([, m]) => m.chatId === '202' && /Ваш ход/.test(m.text)).at(-1)[0];
  await t.act(cast.max, 'call');
  assert.equal(t.tg.message(pingId).deleted, true);
});

test('nobody is pinged who never pressed Start, or who blocked the bot', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { dm: false });
  await t.send(cast.max, { t: 'visible', visible: false });
  await t.send(cast.ivan, { t: 'start' });
  await t.act(cast.ivan, 'call');
  assert.equal(t.actor(), '202');
  assert.equal(t.tg.dms(202).length, 0, 'the bot may not write first');
  assert.equal(t.errors.length, 0, 'and it does not even try');
});

/* --------------------------------------------------- chips and the game */

test('a hidden ALL-IN is refused by the server, not just left out of the panel', async () => {
  // ENGINE-NOTE.md, finding B: the engine lets `allin` re-open betting that a
  // short all-in closed. The app hides the button — a message can still say it.
  const cast = CAST();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50], stack: 5000 });
  const maks = t.room.players.find((p) => p.id === '202');
  maks.stack = 90; // Макс can shove for less than a full raise
  maks.stats.buyIn = 90;
  await t.send(cast.ivan, { t: 'start' });

  // Иван button, Макс SB, Дима BB, Саша first to act.
  assert.equal(t.actor(), '404');
  await t.act(cast.sasha, 'call');
  await t.act(cast.ivan, 'call');
  await t.act(cast.max, 'allin'); // 90 — a 40 increment over 50
  assert.equal(t.room.hand.currentBet, 90);
  await t.act(cast.dima, 'call');
  assert.equal(t.actor(), '404', 'back to Саша, who had already called');

  const l = t.state(cast.sasha).legal;
  assert.equal(l.canRaise, false);
  assert.deepEqual(l.presets, [], 'no RAISE sheet, no ALL-IN button');

  const stack = t.room.players.find((p) => p.id === '404').stack;
  await t.act(cast.sasha, 'allin');
  assert.equal(t.lastError(cast.sasha).code, 'CANNOT_RAISE', 'refused — and said so');
  assert.equal(t.room.players.find((p) => p.id === '404').stack, stack, 'not a chip moved');
  assert.equal(t.actor(), '404', 'still Саша to call or fold');
  await t.act(cast.sasha, 'raise', 500);
  assert.equal(t.lastError(cast.sasha).code != null, true, 'a sized raise is refused too');
  await t.act(cast.sasha, 'call');
  assert.notEqual(t.actor(), '404', 'calling works');
});

test('a raise outside the legal range is refused with a reason, and moves nothing', async () => {
  // The slider cannot produce these — a message typed in the dev tools can.
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  const who = t.actorOf(cast);
  const before = t.room.players.map((p) => p.stack);

  for (const [amount, code] of [
    [70, 'BELOW_MIN_RAISE'], // the minimum is to 100
    [999999, 'NOT_ENOUGH_CHIPS'],
    ['2.5к', 'BAD_AMOUNT'],
    [null, 'BELOW_MIN_RAISE'],
    [-100, 'BELOW_MIN_RAISE'],
  ]) {
    await t.act(who, 'raise', amount);
    const err = t.lastError(who);
    assert.equal(err.code, code, `raise ${amount}`);
    assert.ok(err.text.length > 5, 'with words, not a code');
  }
  assert.deepEqual(t.room.players.map((p) => p.stack), before);
  assert.equal(t.actor(), String(who.id));

  await t.act(who, 'raise', 100.4);
  assert.equal(t.room.hand.currentBet, 100, 'a fractional amount is rounded — chips stay whole');
  assert.ok(t.room.players.every((p) => Number.isInteger(p.stack)));
});

test('undo takes back the host\'s own admin action — never a bet', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const dima = () => t.room.players.find((p) => p.id === '303');
  await t.send(cast.ivan, { t: 'rebuy', seat: t.room.players.indexOf(dima()) }); // a tap on the wrong name
  assert.equal(dima().stats.buyIn, 20000);

  await t.send(cast.ivan, { t: 'undo' });
  assert.equal(dima().stats.buyIn, 10000, 'the re-buy was taken back');
  assert.match(t.state(cast.max).room.notice, /Отменено: докупка: Дима/, 'and everybody is told');

  await t.act(t.actorOf(cast), 'call');
  await t.send(cast.ivan, { t: 'undo' });
  assert.equal(t.lastError(cast.ivan).code, 'NOTHING_TO_UNDO', 'a bet is not an admin action');
});

test('/newgame in the private chat creates nothing — the game lives in a group', async () => {
  const t = new Table();
  const u = user(101, 'Иван');
  await t.start(u);
  await t.dm(u, '/newgame');
  assert.equal(t.app.rooms.size, 0);
  assert.match(t.lastDm(u), /в группе/);
});

test('when only one stack is left, the game ends and the results are posted', async () => {
  const duo = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };
  const t = new Table();
  t.useDeck(stack({ 101: 'As Ah', 202: 'Kd Kc' }, 'Js 9h 4d 3c 8s'));
  await t.begin(duo);
  await t.shoveDown(duo);
  await t.advance(60_000); // the all-in board, turned over street by street
  assert.equal(t.room.status, 'finished');
  assert.match(t.lastPost(), /ИТОГИ/);
  assert.equal(t.state(duo.max).room.status, 'finished', 'open tables show the end too');
});

/* ------------------------------------------------- the card and Telegram */

test('an unchanged card is never re-sent (no "message is not modified")', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const edits = t.tg.countOf('editMessageText');
  await t.app.draw(t.room, { immediate: true });
  await t.app.draw(t.room, { immediate: true });
  assert.equal(t.tg.countOf('editMessageText'), edits, 'identical state produced no API call');
  assert.equal(t.errors.length, 0, 'and therefore no 400 from Telegram');
});

test('a deleted card is replaced instead of breaking the game', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const oldId = t.cardId;
  await t.tg.deleteMessage(t.chatId, oldId); // somebody cleaned up the chat
  await t.act(t.actorOf(cast), 'call');
  assert.notEqual(t.cardId, oldId, 'a fresh card was posted');
  assert.match(t.text(), /Идёт игра/);
  assert.equal(t.cardButtons()[0].text, '🃏 Открыть стол');
});

test('a burst of moves is one edit of the card — the pages still get every state', async () => {
  const cast = CAST();
  const t = new Table({ minIntervalMs: 1000 });
  await t.begin(cast, { blinds: [25, 50] });
  const before = t.tg.countOf('editMessageText') + t.tg.countOf('sendMessage');
  const states = t.page(cast.dima).inbox.filter((m) => m.t === 'state').length;

  // Four people tap 0.3 s apart — faster than a group message may change.
  let moves = 0;
  while (t.room.hand?.phase === 'betting' && moves < 6) {
    const who = t.actorOf(cast);
    await t.hub.handle(t.page(who).session, { t: 'act', action: t.state(who).legal.canCheck ? 'check' : 'call' });
    await t.clock.advance(300);
    moves++;
  }
  await t.clock.advance(1000);
  await t.app.settle();

  const calls = t.tg.countOf('editMessageText') + t.tg.countOf('sendMessage') - before;
  assert.ok(moves >= 4, 'the burst really happened');
  assert.ok(calls <= 2, `${moves} moves should not mean ${calls} API calls`);
  assert.ok(t.page(cast.dima).inbox.filter((m) => m.t === 'state').length - states >= moves, 'the socket has no such limit');

  // And the card shows the LATEST state, not a stale one in between.
  const actor = t.room.players.find((p) => p.id === t.actor());
  assert.match(t.text(), new RegExp(`Ход: <b>${actor.name}</b>`));
  assert.match(t.text(), /ФЛОП/);
});

test('the same button twice (same seq) is applied once', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const actor = t.actorOf(cast);
  const seq = t.state(actor).seq;
  await t.act(actor, 'call', null, { seq });
  const pot = totalPot(t.room);
  await t.act(actor, 'call', null, { seq });
  assert.equal(totalPot(t.room), pot, 'the second tap put no chips in');
});

test('chips are conserved across many hands played through the Mini App', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  const TOTAL = t.chips();
  await t.send(cast.ivan, { t: 'start' });
  for (let hand = 0; hand < 12; hand++) {
    await t.runToShowdown(cast);
    assert.equal(t.room.hand.phase, 'complete');
    assert.equal(t.chips(), TOTAL, `hand ${hand + 1}`);
    if (t.room.status === 'finished') break;
    await t.send(cast.max, { t: 'next' });
  }
  assert.ok(t.room.handNo >= 5);
});

test('a pot only one player can claim is a refund, never a question', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  const depth = { 101: 200, 202: 3000, 303: 5000 };
  for (const p of t.room.players) {
    p.stack = depth[p.id];
    p.stats.buyIn = p.stack;
  }
  const TOTAL = t.chips();
  await t.send(cast.ivan, { t: 'start' });
  await t.shoveDown(cast);
  const solo = t.room.hand.pots.filter((p) => p.eligible.length === 1);
  assert.ok(solo.length > 0, 'the deepest stack over-shoved into a pot only it can win');
  for (const pot of solo) assert.deepEqual(pot.winners, pot.eligible);
  assert.equal(t.chips(), TOTAL);
});

test('blinds changed mid-game land on the next hand, not this one', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  await t.send(cast.ivan, { t: 'settings', smallBlind: 100, bigBlind: 200 });
  assert.equal(t.room.settings.bigBlind, 50);
  assert.deepEqual(t.state(cast.max).room.pendingBlinds, { sb: 100, bb: 200 }, 'everyone can see it coming');
  await t.runToShowdown(cast);
  await t.send(cast.max, { t: 'next' });
  assert.equal(t.room.settings.bigBlind, 200);
});

test('/finish ends the game, returns an unfinished pot and posts an honest P/L', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  await t.runToShowdown(cast);
  await t.send(cast.max, { t: 'next' });
  await t.act(t.actorOf(cast), 'call');

  await t.cmd(cast.max, '/finish');
  assert.equal(t.room.status, 'playing', 'only the host may end the game');
  await t.cmd(cast.ivan, '/finish');
  assert.equal(t.room.status, 'finished');
  assert.match(t.lastPost(), /Сумма P\/L: 0/);
  assert.match(t.text(), /Игра завершена/);
  assert.equal(t.state(cast.dima).room.status, 'finished', 'the phones show the results too');
});

test('a re-buy tops up the stack and the buy-in, so P/L stays honest', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast);
  await t.send(cast.ivan, { t: 'rebuy', seat: 2 });
  const dima = t.room.players[2];
  assert.equal(dima.stack, 20000);
  assert.equal(dima.stats.buyIn, 20000);
});

test('a busted player can be brought back instead of ending the evening', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  t.useDeck(stack({ 101: '7c 2d', 202: 'As Ah', 303: '9c 8c' }, 'Kd Qh 4s 5d Jc'));
  await t.send(cast.ivan, { t: 'start' });
  await t.act(cast.ivan, 'allin');
  await t.act(cast.max, 'call');
  await t.act(cast.dima, 'fold');
  assert.equal(t.room.players[0].stack, 0);
  assert.equal(t.room.status, 'playing');
  await t.send(cast.ivan, { t: 'rebuy', seat: 0 });
  await t.send(cast.max, { t: 'next' });
  assert.equal(t.room.players[0].inHand, true);
  assert.equal(t.state(cast.ivan).me.cards.length, 2);
});

test('the host can hand the room over, and only the host can', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast);
  await t.send(cast.max, { t: 'host', seat: 2 });
  assert.equal(t.room.hostId, '101');
  await t.send(cast.ivan, { t: 'host', seat: 2 });
  assert.equal(t.room.hostId, '303');
  assert.equal(t.state(cast.dima).me.isHost, true);
  await t.send(cast.ivan, { t: 'settings', smallBlind: 500, bigBlind: 1000 });
  assert.equal(t.room.settings.bigBlind, 50, 'the old host lost the rights');
});

/* ---------------------------------------------------- people come and go */

test('leaving the group mid-hand folds the player and unblocks the table', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  const actor = t.actorOf(cast);
  const TOTAL = t.chips();
  await t.raw({
    update_id: 1,
    message: { message_id: t.tg.nextId++, chat: { id: t.chatId, type: 'supergroup' }, from: actor,
      left_chat_member: { id: actor.id, is_bot: false, first_name: actor.first_name } },
  });
  const p = t.room.players.find((x) => x.id === String(actor.id));
  assert.equal(p.left, true);
  assert.equal(p.folded, true);
  assert.notEqual(t.actor(), String(actor.id), 'the clock moved on');
  assert.equal(t.chips(), TOTAL);
});

test('when the host leaves, the table gets a new one instead of freezing', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  await t.raw({
    update_id: 2,
    message: { message_id: t.tg.nextId++, chat: { id: t.chatId, type: 'supergroup' }, from: cast.ivan,
      left_chat_member: { id: 101, is_bot: false, first_name: 'Иван' } },
  });
  assert.notEqual(t.room.hostId, '101');
});

test('a player removed mid-hand leaves their chips in the pot and their result in the P/L', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  const TOTAL = t.chips();
  await t.send(cast.ivan, { t: 'start' });
  assert.equal(t.actor(), '404');
  await t.act(cast.sasha, 'raise', 500);
  await t.send(cast.ivan, { t: 'kick', seat: 3 });
  assert.equal(totalPot(t.room), 575, 'his 500 are still in the pot');
  assert.equal(t.chips(), TOTAL);
  await t.runToShowdown({ ivan: cast.ivan, max: cast.max, dima: cast.dima });
  await t.send(cast.sasha, { t: 'sit' });
  assert.equal(t.lastError(cast.sasha).code, 'KICKED');
  await t.cmd(cast.ivan, '/finish');
  assert.match(t.lastPost(), /Саша \(удалён\)/);
  assert.match(t.lastPost(), /Сумма P\/L: 0/);
});

test('leave and sit again puts you back in the game', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast);
  await t.send(cast.dima, { t: 'leave' });
  assert.equal(t.room.players[2].sittingOut, true);
  await t.send(cast.dima, { t: 'sit' });
  assert.equal(t.room.players[2].sittingOut, false);
  await t.runToShowdown(cast);
  await t.send(cast.ivan, { t: 'next' });
  assert.equal(t.room.players[2].inHand, true);
});

test('when the last opponent walks out, the pot goes to the one left — nobody moves for them', async () => {
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  const TOTAL = t.chips();
  await t.send(cast.ivan, { t: 'start' });
  assert.equal(t.actor(), '101');
  await t.raw({
    update_id: 11,
    message: { message_id: t.tg.nextId++, chat: { id: t.chatId, type: 'supergroup' }, from: cast.max,
      left_chat_member: { id: 202, is_bot: false, first_name: 'Макс' } },
  });
  const ivan = t.room.players[0];
  assert.equal(t.room.hand.phase, 'complete');
  assert.equal(ivan.lastAction, 'SB', 'no move was made in his name');
  assert.equal(ivan.stack, 10050);
  assert.equal(t.chips(), TOTAL);
});

test('an all-in player who leaves the chat keeps their hand in play', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  t.useDeck(stack({ 101: 'As Ah', 202: 'Kd Kc', 303: '7c 2d' }, 'Qs 9h 4d 3c 8s'));
  await t.send(cast.ivan, { t: 'start' });
  await t.act(cast.ivan, 'allin');
  await t.raw({
    update_id: 12,
    message: { message_id: t.tg.nextId++, chat: { id: t.chatId, type: 'supergroup' }, from: cast.ivan,
      left_chat_member: { id: 101, is_bot: false, first_name: 'Иван' } },
  });
  assert.equal(t.room.players[0].folded, false);
  await t.act(cast.max, 'call');
  await t.act(cast.dima, 'fold');
  assert.equal(t.room.hand.pots[0].winners[0], '101', 'his aces still win');
});

test('only somebody at the table can deal the next hand', async () => {
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };
  const t = new Table();
  await t.begin(cast);
  await t.runToShowdown(cast);
  const n = t.room.handNo;
  const guest = user(9999, 'Прохожий');
  await t.send(guest, { t: 'next' });
  assert.equal(t.room.handNo, n);
  assert.equal(t.lastError(guest).code, 'NOT_SEATED');
  await t.send(cast.max, { t: 'next' });
  assert.equal(t.room.handNo, n + 1);
});

test('the bot removed from the group takes the table with it, and open tables are told', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast);
  await t.raw({
    update_id: 13,
    my_chat_member: { chat: { id: t.chatId, type: 'supergroup' }, from: cast.ivan, new_chat_member: { status: 'kicked', user: { id: 1, is_bot: true } } },
  });
  assert.equal(t.room, null);
  assert.ok(t.page(cast.max).inbox.some((m) => m.t === 'gone'));
});

/* ------------------------------------------------------------ restarts */

test('a restart mid-hand keeps the table and redraws the card in place', async () => {
  const store = new Store(':memory:');
  const cast = CAST();
  const t = new Table({ store });
  await t.begin(cast, { blinds: [25, 50] });
  await t.act(t.actorOf(cast), 'call');
  const actorId = t.actor();
  const cardId = t.cardId;
  const stacks = t.room.players.map((p) => p.stack);

  const clock = new FakeClock();
  const app2 = new App({ api: t.tg, store, minIntervalMs: 0, botUsername: 'ChipTableBot', clock, runoutStepMs: 0, miniAppName: 'table' });
  const hub2 = new Hub(app2, { botToken: TEST_TOKEN });
  app2.attachHub(hub2);
  assert.equal(app2.load(), 1);
  await app2.resume();
  const room2 = app2.room(t.chatId);
  assert.equal(room2.hand.actorId, actorId);
  assert.deepEqual(room2.players.map((p) => p.stack), stacks);
  assert.equal(room2.ui.tableMessageId, cardId, 'the same card, edited');

  const who = Object.values(cast).find((u) => String(u.id) === actorId);
  const inbox = [];
  const s = hub2.open({ initData: initDataFor(who, { startParam: room2.code, clock }) }, (m) => inbox.push(m)).session;
  await hub2.handle(s, { t: 'act', action: 'call' });
  assert.notEqual(room2.hand.actorId, actorId, 'the reconnected table accepts moves');
  store.close();
});

test('a group promoted to a supergroup keeps its table — and open tables keep working', async () => {
  const store = new Store(':memory:');
  const cast = THREE();
  const t = new Table({ store });
  await t.begin(cast);
  const code = t.room.code;
  const NEW_ID = -1009999;
  await t.raw({
    update_id: 3,
    message: { message_id: t.tg.nextId++, chat: { id: t.chatId, type: 'group' }, from: cast.ivan, migrate_to_chat_id: NEW_ID },
  });
  assert.equal(t.app.room(t.chatId), null);
  const moved = t.app.room(NEW_ID);
  assert.equal(moved.code, code, 'the link in the old card still opens it');
  assert.equal(store.loadAll()[0].chatId, String(NEW_ID));
  t.chatId = NEW_ID; // the harness follows the group, as Telegram does
  const actor = t.actorOf(cast);
  await t.act(actor, 'call');
  assert.notEqual(moved.hand.actorId, String(actor.id), 'a page opened before the migration still plays');
  store.close();
});
