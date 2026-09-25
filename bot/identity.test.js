'use strict';
/**
 * The tests that matter most: NOBODY EVER ACTS FOR SOMEBODY ELSE.
 *
 * Buttons in a group chat are visible to every member and can be pressed by
 * every member, so every test here presses a button that legitimately exists
 * on screen — the attack is not forging callback_data, it is being the wrong
 * person when you press it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { identify, GROUP_ANONYMOUS_BOT_ID, CHANNEL_BOT_ID } from './identity.js';
import { Table, user } from './harness.js';
import { ANON_USER, cmdUpdate, pressUpdate } from './tg-stub.js';

const CAST = () => ({
  ivan: user(101, 'Иван'),
  max: user(202, 'Макс'),
  dima: user(303, 'Дима'),
  sasha: user(404, 'Саша'),
});

/* ------------------------------------------------------------- the unit */

test('identify: a normal member becomes a player id equal to their Telegram id', () => {
  const r = identify({ id: 555, is_bot: false, first_name: 'Иван' });
  assert.equal(r.ok, true);
  assert.equal(r.user.id, '555');
  assert.equal(r.user.tgId, 555);
  assert.equal(r.user.name, 'Иван');
});

test('identify: the anonymous-admin account is refused, with a reason', () => {
  const r = identify({ id: GROUP_ANONYMOUS_BOT_ID, is_bot: true, first_name: 'GroupAnonymousBot' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ANON');
  assert.match(r.text, /Анонимные админы/);
});

test('identify: sender_chat replaces the user — also anonymous, also refused', () => {
  const r = identify({ id: 777, is_bot: false, first_name: 'X' }, { id: -100500, type: 'supergroup' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ANON');
});

test('identify: a channel post and a plain bot are both kept out', () => {
  assert.equal(identify({ id: CHANNEL_BOT_ID, is_bot: true }).reason, 'ANON');
  assert.equal(identify({ id: 12345, is_bot: true, first_name: 'SomeBot' }).reason, 'BOT');
  assert.equal(identify(null).ok, false);
  assert.equal(identify({}).ok, false);
});

test('identify: a missing first_name falls back without throwing', () => {
  assert.equal(identify({ id: 9, is_bot: false, username: 'nick' }).user.name, 'nick');
  assert.equal(identify({ id: 9, is_bot: false }).user.name, 'Игрок 9');
});

/* ------------------------------------------------- nobody acts for anybody */

test('a different member pressing the actor\'s own button is refused', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);

  const actorId = t.actor();
  const intruder = Object.values(cast).find((u) => String(u.id) !== actorId);
  const stacksBefore = t.room.players.map((p) => p.stack);

  // The exact button that is on screen for the player on the clock.
  const fold = t.button('FOLD');
  assert.ok(fold, 'the actor should have a FOLD button');
  await t.pressData(intruder, fold.callback_data);

  assert.deepEqual(t.room.players.map((p) => p.stack), stacksBefore, 'no chips moved');
  assert.equal(t.actor(), actorId, 'the clock did not move');
  assert.match(t.answer().text, /Сейчас ходит/, 'the refusal is spoken, not silent');
});

test('a spectator who never sat down cannot act either', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const ghost = user(9999, 'Прохожий');

  const before = t.room.hand.actorId;
  const btn = t.button('CALL') || t.button('CHECK');
  await t.pressData(ghost, btn.callback_data);

  assert.equal(t.room.hand.actorId, before);
  assert.match(t.answer().text, /не за столом/i);
  assert.equal(t.room.players.length, 4, 'and they were not seated by pressing');
});

test('an anonymous admin cannot sit down, and is told why', async () => {
  const t = new Table();
  await t.cmd(user(101, 'Иван'), '/newgame');
  await t.cmd(ANON_USER, '/join');

  assert.equal(t.room.players.length, 1, 'the anonymous admin got no seat');
  assert.match(t.lastPost(), /Анонимные админы/);
});

test('an anonymous admin cannot press a button, and the press is answered', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);

  const before = t.chips();
  const btn = t.button('CALL') || t.button('CHECK');
  await t.pressData(ANON_USER, btn.callback_data);

  assert.equal(t.chips(), before);
  const ans = t.answer();
  assert.match(ans.text, /Анонимные админы/);
  assert.equal(ans.show_alert, true, 'an explanation this long needs an alert, not a toast');
});

test('a message sent on behalf of the chat (anonymous) creates nothing', async () => {
  const t = new Table();
  await t.raw(
    cmdUpdate(t.chatId, user(101, 'Иван'), '/newgame', { sender_chat: { id: -1001, type: 'supergroup' } })
  );
  assert.equal(t.room, null, 'no table was created for an unidentifiable author');
});

/* ------------------------------------------------------------ host rights */

test('a non-host cannot change the blinds or the starting stack', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast);

  await t.cmd(cast.max, '/blinds 500 1000');
  assert.equal(t.room.settings.bigBlind, 50, 'blinds untouched');
  assert.match(t.lastPost(), /только хост/i);

  await t.cmd(cast.dima, '/stack 999999');
  assert.equal(t.room.settings.startingStack, 10000, 'stack untouched');
});

test('a non-host cannot start the game', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast);
  await t.press(cast.sasha, 'Начать игру');

  assert.equal(t.room.status, 'lobby');
  assert.match(t.answer().text, /только хост/i);
});

test('a non-host cannot change roles, even with the host\'s own panel button', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast);
  await t.cmd(cast.ivan, '/roles'); // host opens the panel

  // The panel is a group message: Макс can see and press it.
  await t.panel(cast.max, 'Дима');

  assert.equal(t.room.players.find((p) => p.id === '303').role, 'player');
  assert.match(t.answer().text, /только хост/i);

  // …and the host pressing the same button does work.
  await t.panel(cast.ivan, 'Дима');
  assert.equal(t.room.players.find((p) => p.id === '303').role, 'dealer');
});

test('a non-host cannot kick, and the host cannot kick themselves out', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast);
  await t.cmd(cast.ivan, '/kick');

  await t.panel(cast.max, 'Дима');
  assert.equal(t.room.players.length, 4, 'a non-host kick does nothing');
  assert.match(t.answer().text, /только хост/i);

  await t.panel(cast.ivan, 'Дима');
  assert.equal(t.room.players.length, 3);

  const kickPanel = t.lastPanel();
  const hostButton = kickPanel.markup.inline_keyboard.flat().find((b) => b.text.includes('Иван'));
  assert.equal(hostButton, undefined, 'the host is not offered as a target at all');
});

/* ---------------------------------------------------------- dealer rights */

test('with a dealer assigned, another player cannot close the pot', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast);
  await t.cmd(cast.ivan, '/roles');
  await t.panel(cast.ivan, 'Саша'); // Саша becomes the dealer
  assert.equal(t.room.players.find((p) => p.id === '404').role, 'dealer');

  await t.press(cast.ivan, 'Начать игру');
  await t.runToShowdown(cast);
  assert.equal(t.room.hand.phase, 'showdown');

  const stacksBefore = t.room.players.map((p) => p.stack);
  const pick = t.button('Макс');
  assert.ok(pick, 'the winner buttons are on screen for everyone to see');

  // Макс is neither host nor dealer: he may not award himself the pot.
  await t.pressData(cast.max, pick.callback_data);
  assert.deepEqual(t.room.players.map((p) => p.stack), stacksBefore);
  assert.match(t.answer().text, /Победителя определяет Саша/);

  // The dealer can.
  await t.pressData(cast.sasha, pick.callback_data);
  assert.deepEqual(t.room.hand.pots[0].winners, ['202']);
});

test('the dealer is not dealt in and risks no chips', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast);
  await t.cmd(cast.ivan, '/roles');
  await t.panel(cast.ivan, 'Саша');
  await t.press(cast.ivan, 'Начать игру');

  const sasha = t.room.players.find((p) => p.id === '404');
  assert.equal(sasha.inHand, false);
  assert.equal(sasha.stack, 10000, 'the dealer posted no blind and lost nothing');
  assert.equal(t.room.players.filter((p) => p.inHand).length, 3);
});

test('with no dealer, any seated player may close the pot — but not a stranger', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  await t.runToShowdown(cast);

  const pick = t.button('Дима');
  await t.pressData(user(9999, 'Прохожий'), pick.callback_data);
  assert.deepEqual(t.room.hand.pots[0].winners, [], 'a non-member decided nothing');

  await t.pressData(cast.max, pick.callback_data);
  assert.deepEqual(t.room.hand.pots[0].winners, ['303']);
});

/* ------------------------------------------------- one account, one seat */

test('a repeated /join returns the same seat instead of creating a second', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  const max = user(202, 'Макс');
  await t.cmd(ivan, '/newgame');
  await t.cmd(max, '/join');
  await t.cmd(max, '/join');
  await t.cmd(max, '/join');

  assert.equal(t.room.players.length, 2);
  assert.equal(t.room.players.filter((p) => p.id === '202').length, 1);
});

test('re-joining keeps the stack the player already had', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const actor = t.actorOf(cast);
  await t.press(actor, t.button('CALL') ? 'CALL' : 'CHECK');

  const before = t.room.players.find((p) => p.id === String(actor.id)).stack;
  await t.cmd(actor, '/join');
  assert.equal(t.room.players.find((p) => p.id === String(actor.id)).stack, before);
  assert.equal(t.room.players.length, 4);
});

/* --------------------------------------------- every press gets an answer */

test('every callback is answered — refused ones too', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);

  const intruder = Object.values(cast).find((u) => String(u.id) !== t.actor());
  const before = t.tg.countOf('answerCallbackQuery');

  await t.pressData(intruder, t.button('FOLD').callback_data); // wrong person
  await t.pressData(ANON_USER, t.button('FOLD').callback_data); // anonymous
  await t.pressData(intruder, 'a:fold:999999'); // stale seq
  await t.pressData(intruder, 'total garbage'); // unparsable

  assert.equal(
    t.tg.countOf('answerCallbackQuery') - before,
    4,
    'a press without answerCallbackQuery leaves the user staring at a spinner'
  );
  for (const a of t.tg.answered.slice(-4)) {
    assert.ok(a.text.length > 0, 'a silent refusal reads as "the bot is broken"');
  }
});

test('a button on a message posted by a channel is still pressable by people', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const actor = t.actorOf(cast);
  const btn = t.button('CALL') || t.button('CHECK');

  // In a channel's discussion group the surrounding message carries a
  // `sender_chat`. That describes the message, not the person pressing it.
  await t.raw({
    update_id: 77,
    callback_query: {
      id: 'cb-channel',
      from: actor,
      data: btn.callback_data,
      message: {
        message_id: t.tableId,
        chat: { id: t.chatId, type: 'supergroup' },
        sender_chat: { id: -1002222, type: 'channel', title: 'Канал' },
      },
    },
  });

  assert.notEqual(t.actor(), String(actor.id), 'the real player was allowed to act');
  assert.doesNotMatch(t.answer().text, /Анонимные админы/);
});
