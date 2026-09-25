'use strict';
/**
 * Everything that happens because TIME passes: the turn timer, the table
 * dealing itself, the all-in board turned over street by street. And the
 * showdown rule that decides whose cards are shown.
 *
 * Time here is a fake clock that moves only when a test says so, so every
 * "59 seconds — not yet, 60 — now" is exact, and nothing sleeps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, stack, FakeClock } from './harness.js';
import { App } from './app.js';
import { Store } from './store.js';
import { cardText } from './cards.js';
import * as R from './room.js';

const THREE = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') });
const SEC = 1000;

const player = (t, u) => t.room.players.find((p) => p.id === String(u.id));

/** Seat everybody, switch the timer on in the lobby, deal. */
async function timed(cast, { secs = 60, deck = null, runoutStepMs = 0, store } = {}) {
  const t = new Table({ runoutStepMs, store });
  await t.seat(cast, { blinds: [25, 50] });
  await t.cmd(cast.ivan, `/timer ${secs}`);
  if (deck) t.useDeck(deck);
  await t.press(cast.ivan, 'Начать игру');
  return t;
}

/** Everyone except `afk` checks or calls; `afk` just lets the clock run. */
async function playAround(t, cast, afk, secs = 60) {
  let guard = 0;
  while (t.room.hand.phase === 'betting' && guard++ < 60) {
    const who = t.actorOf(cast);
    if (who === afk) await t.advance(secs * SEC);
    else await t.press(who, t.button('CHECK') ? 'CHECK' : 'CALL');
  }
}

/** Every text the bot ever put into the group: sends AND edits. */
const everything = (t) =>
  t.tg.calls
    .filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.chatId === String(t.chatId))
    .map((c) => c.text);

/* ----------------------------------------------------------- the timer */

test('there is no turn timer unless the host switches it on', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast);
  const actor = t.actor();
  await t.advance(3600 * SEC);
  assert.equal(t.actor(), actor, 'an hour later the same player is still thinking');
  assert.equal(t.clock.pending(), 0, 'and no timer is even armed');
});

test('only the host sets the timer, and only to something sane', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast);
  await t.cmd(cast.max, '/timer 30');
  assert.match(t.lastPost(), /только хост/i);
  assert.equal(t.room.settings.turnSeconds, 0);

  await t.cmd(cast.ivan, '/timer 5');
  assert.match(t.lastPost(), /от 15 до 600/);
  assert.equal(t.room.settings.turnSeconds, 0);

  await t.cmd(cast.ivan, '/timer 60');
  assert.equal(t.room.settings.turnSeconds, 60);
  assert.match(t.text(), /⏱ 60 с на ход/, 'the lobby says what the table agreed to');

  await t.cmd(cast.ivan, '/timer off');
  assert.equal(t.room.settings.turnSeconds, 0);
});

test('when the clock runs out: a free check is a check, a bet is a fold — never a chip put in', async () => {
  const cast = THREE();
  const t = await timed(cast);
  // Иван (button) acts first and faces the big blind.
  assert.equal(t.actor(), '101');
  assert.match(t.text(), /⏱ ход до \d\d:\d\d:\d\d — потом фолд/);

  await t.advance(59 * SEC);
  assert.equal(t.actor(), '101', 'one second left — nothing yet');
  await t.advance(1 * SEC);
  assert.equal(player(t, cast.ivan).folded, true, 'facing a bet, the timer folds');
  assert.equal(player(t, cast.ivan).stack, 10000, 'and puts in nothing');
  assert.match(t.text(), /Иван: время вышло — фолд/);

  await t.cmd(cast.max, '/call');
  assert.equal(t.actor(), '303');
  assert.match(t.text(), /потом чек/, 'the table says what will happen to Дима');
  const before = player(t, cast.dima).stack;
  await t.advance(60 * SEC);
  assert.equal(player(t, cast.dima).lastAction === 'CHECK' || t.room.hand.street === 'flop', true);
  assert.equal(player(t, cast.dima).folded, false, 'with a free check the timer checks, it does not fold');
  assert.equal(player(t, cast.dima).stack, before, 'and still spends nothing');
  assert.equal(t.room.hand.street, 'flop');
});

test('a move in time disarms the clock, and the next player gets their own full minute', async () => {
  const cast = THREE();
  const t = await timed(cast);

  await t.advance(59 * SEC);
  await t.press(cast.ivan, 'CALL');
  assert.equal(t.actor(), '202');

  await t.advance(59 * SEC);
  assert.equal(t.actor(), '202', 'Макс has not had a minute yet — Иван\'s old deadline means nothing');
  assert.equal(player(t, cast.ivan).folded, false, 'and the timer did not fire for Иван after he moved');
  await t.advance(1 * SEC);
  assert.equal(player(t, cast.max).folded, true);
});

test('the same player on the clock twice in a row gets a fresh clock each time', async () => {
  // Heads-up the big blind closes the pre-flop AND acts first on the flop.
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };
  const t = await timed(cast);
  await t.cmd(cast.ivan, '/call');
  assert.equal(t.actor(), '202');

  await t.advance(50 * SEC);
  await t.cmd(cast.max, '/check');
  assert.equal(t.room.hand.street, 'flop');
  assert.equal(t.actor(), '202');

  await t.advance(50 * SEC);
  assert.equal(t.room.hand.street, 'flop', 'a new street, a new minute');
  assert.equal(t.actor(), '202');
  await t.advance(10 * SEC);
  assert.notEqual(t.actor(), '202');
});

test('a timer for a turn that is already over does nothing, even if it fires late', () => {
  const room = R.createRoom({ chatId: -5, host: { id: 1, name: 'Иван' } });
  R.addPlayer(room, { id: 2, name: 'Макс' });
  R.addPlayer(room, { id: 3, name: 'Дима' });
  room.settings.turnSeconds = 60;
  R.startGame(room, 1);
  const t0 = 1_000_000;
  const turn = R.syncTurn(room, t0);
  const key = turn.key;

  R.act(room, room.hand.actorId, 'call');
  const stacks = room.players.map((p) => p.stack);
  const r = R.timeoutMove(room, key, t0 + 3600 * SEC);
  assert.equal(r.error, 'STALE');
  assert.deepEqual(room.players.map((p) => p.stack), stacks);
  assert.equal(room.players.filter((p) => p.folded).length, 0);

  // And the current turn cannot be timed out before its deadline.
  const cur = R.syncTurn(room, t0 + 1);
  assert.equal(R.timeoutMove(room, cur.key, cur.deadline - 1).error, 'EARLY');
});

test('two timeouts in a row sit a player out; /join brings them back', async () => {
  const cast = THREE();
  const t = await timed(cast);

  await playAround(t, cast, cast.ivan); // hand 1: Иван times out once
  assert.equal(player(t, cast.ivan).timeouts, 1);
  assert.equal(player(t, cast.ivan).sittingOut, false, 'once is not a pattern');

  await t.advance(10 * SEC); // the table deals hand 2 by itself
  assert.equal(t.room.handNo, 2);
  await playAround(t, cast, cast.ivan);
  assert.equal(player(t, cast.ivan).sittingOut, true, 'twice in a row — sat out');
  assert.ok(everything(t).some((x) => /Иван: время вышло — \S+\. Второй раз подряд — пропускает раздачи/.test(x)),
    'the table said so when it happened');
  assert.match(handText(t, 2), /Иван\s+[\d ]+\s+\S+\s+пропуск/, 'and the end of the hand still shows it');

  await t.advance(10 * SEC);
  assert.equal(t.room.handNo, 3);
  assert.equal(player(t, cast.ivan).inHand, false, 'not dealt in while away');
  assert.equal(t.hole(cast.ivan), null, 'and no cards sent to an empty chair');

  await t.cmd(cast.ivan, '/join');
  assert.equal(player(t, cast.ivan).sittingOut, false);
  assert.equal(player(t, cast.ivan).timeouts, 0);
});

test('a move of your own in between resets the count', async () => {
  const cast = THREE();
  const t = await timed(cast);
  await playAround(t, cast, cast.ivan);
  assert.equal(player(t, cast.ivan).timeouts, 1);

  await t.advance(10 * SEC);
  let guard = 0;
  while (t.room.hand.phase === 'betting' && t.actor() !== '101' && guard++ < 10) {
    await t.press(t.actorOf(cast), t.button('CHECK') ? 'CHECK' : 'CALL');
  }
  await t.press(cast.ivan, t.button('CHECK') ? 'CHECK' : 'CALL');
  assert.equal(player(t, cast.ivan).timeouts, 0, 'he is here after all');
});

test('a pause stops the clock; resuming carries on with the time that was left', async () => {
  const cast = THREE();
  const t = await timed(cast);
  await t.advance(40 * SEC);
  await t.cmd(cast.ivan, '/pause');
  await t.advance(600 * SEC);
  assert.equal(t.actor(), '101', 'a smoke break costs nobody their turn');

  await t.cmd(cast.ivan, '/resume');
  await t.advance(19 * SEC);
  assert.equal(player(t, cast.ivan).folded, false, '20 seconds were left, 19 have passed');
  await t.advance(1 * SEC);
  assert.equal(player(t, cast.ivan).folded, true);
});

test('a restart does not bill anybody for the time the bot was down', async () => {
  const store = new Store(':memory:');
  const cast = THREE();
  const t = await timed(cast, { store });
  await t.advance(40 * SEC);
  await t.cmd(cast.ivan, '/blinds 100 200'); // any redraw saves the room: 20 s left

  // Ten minutes of downtime, then a fresh process on the same database.
  const clock2 = new FakeClock(t.clock.now() + 600 * SEC);
  const app2 = new App({ api: t.tg, store, minIntervalMs: 0, botUsername: 'ChipTableBot', clock: clock2, runoutStepMs: 0 });
  app2.load();
  await app2.resume();
  const room2 = app2.room(t.chatId);
  assert.equal(room2.hand.actorId, '101', 'nobody was timed out on waking up');

  await clock2.advance(19 * SEC);
  await app2.settle();
  assert.equal(room2.players[0].folded, false);
  await clock2.advance(1 * SEC);
  await app2.settle();
  assert.equal(room2.players[0].folded, true, 'the 20 seconds that were left, and not a second less');
  store.close();
});

/* ------------------------------------------------- the table deals itself */

test('with the timer on, the next hand is dealt 10 s after the last — cards and all', async () => {
  const cast = THREE();
  const t = await timed(cast);
  await t.runToShowdown(cast);
  assert.equal(t.room.hand.phase, 'complete');
  assert.match(t.text(), /Следующая раздача сама через 10 с/);

  await t.advance(9999);
  assert.equal(t.room.handNo, 1);
  await t.advance(1);
  assert.equal(t.room.handNo, 2);
  for (const u of Object.values(cast)) assert.match(t.lastDm(u), /Раздача #2/, `${u.first_name} got the new cards`);
});

test('without the timer, the table waits for a person to deal', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast);
  await t.runToShowdown(cast);
  await t.advance(3600 * SEC);
  assert.equal(t.room.handNo, 1);
  assert.doesNotMatch(t.text(), /сама через/);
});

test('dealing by hand before the countdown cancels it — never two hands', async () => {
  const cast = THREE();
  const t = await timed(cast);
  await t.runToShowdown(cast);
  await t.advance(5 * SEC);
  await t.press(cast.max, 'Следующая раздача');
  assert.equal(t.room.handNo, 2);
  await t.advance(10 * SEC);
  assert.equal(t.room.handNo, 2, 'the old countdown did not deal a third hand');
  assert.equal(t.room.hand.phase, 'betting');
});

test('a hand nobody played themselves pauses the table instead of dealing into an empty room', async () => {
  const cast = THREE();
  const t = await timed(cast);
  await t.advance(60 * SEC); // Иван
  await t.advance(60 * SEC); // Макс — Дима wins the blinds, nobody touched a thing
  assert.equal(t.room.hand.phase, 'complete');
  assert.equal(t.room.status, 'paused');
  assert.match(t.text(), /никто не сходил сам — пауза/);

  await t.advance(3600 * SEC);
  assert.equal(t.room.handNo, 1, 'an hour later, still no new hand');

  await t.cmd(cast.ivan, '/resume');
  await t.advance(10 * SEC);
  assert.equal(t.room.handNo, 2, 'back to normal once the host says so');
});

test('with fewer than two players left, the automatic deal stops instead of retrying forever', async () => {
  const cast = THREE();
  const t = await timed(cast);
  await t.runToShowdown(cast);
  await t.cmd(cast.max, '/leave');
  await t.cmd(cast.dima, '/leave');

  await t.advance(10 * SEC);
  assert.equal(t.room.handNo, 1);
  assert.match(t.text(), /Автораздача остановлена/);
  const edits = t.tg.countOf('editMessageText') + t.tg.countOf('sendMessage');
  await t.advance(3600 * SEC);
  assert.equal(t.tg.countOf('editMessageText') + t.tg.countOf('sendMessage'), edits, 'no retry every ten seconds');

  await t.cmd(cast.max, '/join');
  await t.cmd(cast.max, '/next');
  assert.equal(t.room.handNo, 2);
});

/* ------------------------------------------------- who shows at showdown */

test('an all-in loser is shown; a loser who is not all-in mucks', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  player(t, cast.ivan).stack = 1000;
  player(t, cast.ivan).stats.buyIn = 1000;
  t.useDeck(stack({ 101: 'Kd Kc', 202: 'As Ah', 303: 'Qh Qd' }, '2s 7h 9d Jc 3s'));
  await t.press(cast.ivan, 'Начать игру');

  await t.cmd(cast.ivan, '/allin');
  await t.cmd(cast.max, '/call');
  await t.cmd(cast.dima, '/call');
  await t.runToShowdown(cast); // Макс and Дима check it down

  const all = everything(t).join('\n');
  assert.match(t.text(), /🏆 <b>Макс<\/b> \+3 000 · Пара A/);
  assert.match(t.text(), /Иван: K♦️ K♣️ — Пара K/, 'all-in: the hand is tabled, win or lose');
  assert.match(t.text(), /Дима: карты не показаны/);
  for (const c of t.hole(cast.dima)) assert.ok(!all.includes(cardText(c)), 'Дима mucked unseen');
});

test('a split pot shows both winners', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  t.useDeck(stack({}, 'As Ks Qs Js 10s'));
  await t.press(cast.ivan, 'Начать игру');
  await t.cmd(cast.ivan, '/call');
  await t.cmd(cast.max, '/fold');
  await t.runToShowdown(cast);

  const shown = Object.keys(t.room.hand.shown).sort();
  assert.deepEqual(shown, ['101', '303'], 'both winners table their hands');
  assert.match(t.text(), /🏆 <b>Иван<\/b>/);
  assert.match(t.text(), /🏆 <b>Дима<\/b>/);
});

test('chips nobody called come back as a refund, not as a won pot', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  player(t, cast.ivan).stack = 300;
  player(t, cast.ivan).stats.buyIn = 300;
  t.useDeck(stack({ 101: 'As Ah', 202: '7c 2d', 303: '9c 8c' }, 'Kd Qh 4s 5d Jc'));
  await t.press(cast.ivan, 'Начать игру');

  await t.cmd(cast.ivan, '/allin'); // 300
  await t.cmd(cast.max, '/raise 2000'); // far more than Иван can call
  await t.cmd(cast.dima, '/fold');

  assert.equal(t.room.hand.phase, 'complete');
  assert.match(t.text(), /🏆 <b>Иван<\/b> \+650 · Пара A/);
  assert.match(t.text(), /↩️ Макс \+1 700 — возврат неуравненной ставки/);
  assert.doesNotMatch(t.text(), /🏆 <b>Макс/, 'getting your own chips back is not a win');
  assert.match(t.text(), /Макс: карты не показаны/, 'a refund does not force the hand open');
});

/* ------------------------------------------- the all-in board, one street at a time */

async function allInPreflop(cast, opts = {}) {
  const t = new Table({ runoutStepMs: 1500, ...opts });
  await t.seat(cast, { blinds: [25, 50] });
  if (opts.timer) await t.cmd(cast.ivan, `/timer ${opts.timer}`);
  t.useDeck(stack({ 101: 'As Ah', 202: 'Kd Kc', 303: '7c 2d' }, 'Qs 9h 4d 3c 8s'));
  await t.press(cast.ivan, 'Начать игру');
  await t.cmd(cast.ivan, '/allin');
  await t.cmd(cast.max, '/call');
  // Дима's fold is the move that ends the betting and starts the reveal.
  const started = Date.now();
  await t.cmd(cast.dima, '/fold');
  const took = Date.now() - started;
  return { t, took };
}

test('an all-in board is turned over street by street, and the result comes with the river', async () => {
  const cast = THREE();
  const { t, took } = await allInPreflop(cast);
  const [q, n9, n4, n3, n8] = t.room.hand.board.map(cardText);

  assert.equal(t.room.hand.phase, 'complete', 'the pot is already decided');
  assert.ok(took < 1000, `handling the move must not sleep through the reveal (${took} ms)`);
  assert.match(t.text(), /ОЛЛ-ИН/);
  assert.match(t.text(), /Иван: A♠️ A♥️/, 'the all-in hands are tabled first, as at a real table');
  assert.match(t.text(), /Макс: K♦️ K♣️/);
  assert.doesNotMatch(t.text(), /🏆/, 'no result before the board is out');
  assert.deepEqual(t.labels(), ['🂠 Мои карты'], 'and no "next hand" to skip past it');

  await t.advance(1500);
  assert.ok(t.text().includes(`${q} ${n9} ${n4}`), 'the flop');
  assert.ok(!t.text().includes(n3), 'but not the turn yet');

  await t.advance(1500);
  assert.ok(t.text().includes(`${q} ${n9} ${n4} ${n3}`), 'the turn');
  assert.ok(!t.text().includes(n8));

  await t.advance(1500);
  assert.match(t.text(), /ВСКРЫТИЕ/);
  assert.ok(t.text().includes(`${q} ${n9} ${n4} ${n3} ${n8}`));
  assert.match(t.text(), /🏆 <b>Иван<\/b>/);

  // Nothing ever showed the river before its turn.
  const texts = everything(t);
  const firstRiver = texts.findIndex((x) => x.includes(n8));
  const firstResult = texts.findIndex((x) => x.includes('🏆'));
  assert.equal(firstRiver, firstResult, 'the river and the result arrive in the same frame');
});

test('while the board turns over, "Мои карты" shows only the cards already out', async () => {
  const cast = THREE();
  const { t } = await allInPreflop(cast);
  await t.advance(1500); // the flop is out
  const [, , , turn, river] = t.room.hand.board.map(cardText);
  const a = await t.peek(cast.max);
  assert.match(a.text, /K♦️ K♣️/);
  assert.ok(!a.text.includes(turn) && !a.text.includes(river), 'the popup must not run ahead of the table');
});

test('the automatic deal waits for the board to finish turning over', async () => {
  const cast = THREE();
  const { t } = await allInPreflop(cast, { timer: 60 });
  await t.advance(4500);
  assert.match(t.text(), /ВСКРЫТИЕ/);
  await t.advance(9999);
  assert.equal(t.room.handNo, 1, 'ten seconds from the river, not from the all-in');
  await t.advance(1);
  assert.equal(t.room.handNo, 2);
});

test('a restart in the middle of the reveal shows the finished hand', async () => {
  const store = new Store(':memory:');
  const cast = THREE();
  const { t } = await allInPreflop(cast, { store });
  await t.advance(1500);

  const app2 = new App({ api: t.tg, store, minIntervalMs: 0, botUsername: 'ChipTableBot', clock: new FakeClock(), runoutStepMs: 1500 });
  app2.load();
  await app2.resume();
  const text = t.tg.message(app2.room(t.chatId).ui.tableMessageId).text;
  assert.match(text, /ВСКРЫТИЕ/);
  assert.match(text, /🏆/);
  store.close();
});

test('/finish during the reveal freezes the finished hand, not a frame of it', async () => {
  const cast = THREE();
  const { t } = await allInPreflop(cast);
  await t.cmd(cast.ivan, '/finish');
  assert.match(handText(t, 1), /ВСКРЫТИЕ/);
  assert.match(t.lastPost(), /ИТОГИ/);
  const calls = t.tg.calls.length;
  await t.advance(10 * SEC);
  assert.equal(t.tg.calls.length, calls, 'the stopped reveal does not wake up and edit anything');
});

test('the all-in that ends the game: first the board, then the results', async () => {
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };
  const t = new Table({ runoutStepMs: 1500 });
  await t.seat(cast, { blinds: [25, 50] });
  t.useDeck(stack({ 101: 'As Ah', 202: 'Kd Kc' }, 'Qs 9h 4d 3c 8s'));
  await t.press(cast.ivan, 'Начать игру');
  await t.cmd(cast.ivan, '/allin');
  await t.cmd(cast.max, '/call');

  assert.equal(t.room.status, 'finished');
  assert.doesNotMatch(t.lastPost(), /ИТОГИ/, 'not while the cards are still coming');
  await t.advance(4500);
  assert.match(t.lastPost(), /ИТОГИ/);
  assert.match(handText(t, 1), /🏆 <b>Иван<\/b> \+20 000/);
});

/** The message of hand #no as it stands in the chat now. */
function handText(t, no) {
  let found = '';
  for (const m of t.tg.messages.values()) {
    if (m.chatId === String(t.chatId) && !m.deleted && m.text.includes(`РАЗДАЧА #${no}`)) found = m.text;
  }
  return found;
}
