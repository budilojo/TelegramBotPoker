'use strict';
/**
 * Snapshot tests for everything the bot writes.
 *
 * These are written out in full rather than stored in a .snap file on
 * purpose: the table IS the product here, and a change to it should be
 * visible in the diff of a review, not hidden behind a regenerated blob.
 *
 * Every hand below is dealt from a stacked deck, so the cards are fixed too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, addPlayer, startGame, act, endGame, syncTurn } from './room.js';
import { renderRoom, renderResults, renderHole, actionKeyboard, commandHints } from './render.js';
import { legalActions } from '../server/game.js';
import { padEnd, visualWidth } from './fmt.js';
import { stack } from './harness.js';

/** Wall-clock differs per run and per timezone; nothing else may. */
const norm = (s) => s.replace(/\d\d:\d\d(:\d\d)?/g, (m) => (m.length > 5 ? 'HH:MM:SS' : 'HH:MM'));

function fixture() {
  const room = createRoom({
    chatId: -1, title: 'Покер по пятницам', host: { id: 1, name: 'Иван', dm: 'ok' },
    startingStack: 10000, smallBlind: 250, bigBlind: 500,
  });
  for (const [id, name, dm] of [[2, 'Макс', 'ok'], [3, 'Дима', null], [4, 'Саша', 'ok']]) {
    addPlayer(room, { id, name, dm });
  }
  return room;
}

const DECK = stack({ 1: 'As Ah', 2: 'Kd Kc', 3: 'Qh Qd', 4: '7c 2d' }, 'Js 9h 4d 3c 8s');
const deal = (room) => startGame(room, 1, { deck: () => DECK(room) });

test('snapshot: lobby, with somebody the bot cannot write to yet', () => {
  const v = renderRoom(fixture(), { botUsername: 'ChipTableBot' });
  assert.equal(
    norm(v.text),
    [
      '♠️ <b>НОВЫЙ СТОЛ</b> · техасский холдем',
      '',
      'Стек 10 000 · блайнды 250/500',
      '',
      '<pre>Иван          10 000  хост',
      'Макс          10 000',
      'Дима          10 000  нет лички',
      'Саша          10 000</pre>',
      '',
      '<i>4 за столом. Хост может начинать.</i>',
      '',
      '🔑 Карты приходят в личку. Дима — нажмите «Карты в личку» и Start. ' +
        'Без этого карты можно смотреть кнопкой «🂠 Мои карты».',
    ].join('\n')
  );
  assert.deepEqual(v.keyboard[2], [{ text: '🔑 Карты в личку', url: 'https://t.me/ChipTableBot?start=cards' }]);
});

test('snapshot: pre-flop — no card in the group, the moves spelled out', () => {
  const room = fixture();
  deal(room);
  act(room, room.hand.actorId, 'raise', 1500);
  act(room, room.hand.actorId, 'fold');

  const v = renderRoom(room);
  assert.equal(
    norm(v.text),
    [
      '♠️ <b>РАЗДАЧА #1</b> · ПРЕФЛОП · HH:MM',
      '',
      '🂠 <i>Карты розданы — смотрите в личке у бота.</i>',
      '',
      '<b>БАНК 2 250</b> · блайнды 250/500 · D Иван',
      '<pre>  Иван        10 000  fold',
      '› Макс         9 750  ← ходит',
      '  Дима         9 500  BB 500',
      '  Саша         8 500  raise 1 500</pre>',
      '▶️ <b>Макс</b> · ставка 1 500 · коллировать 1 250',
      '<code>/call · /raise 2500…10000 · /allin · /fold</code>',
    ].join('\n')
  );
  assert.deepEqual(v.keyboard.map((r) => r.map((b) => b.text)), [
    ['FOLD', 'CALL 1 250'],
    ['½ банка · 3 250', '+5BB · 4 000'],
    ['банк · 5 000'],
    ['✏️ Своя сумма'],
    ['ALL-IN 10 000'],
    ['🂠 Мои карты'],
  ]);
});

test('snapshot: the flop is on the table', () => {
  const room = fixture();
  deal(room);
  while (room.hand.street === 'preflop') {
    const p = room.players.find((x) => x.id === room.hand.actorId);
    act(room, p.id, room.hand.currentBet > p.bet ? 'call' : 'check');
  }
  act(room, room.hand.actorId, 'bet', 1000);

  assert.equal(
    norm(renderRoom(room).text),
    [
      '♠️ <b>РАЗДАЧА #1</b> · ФЛОП · HH:MM',
      '',
      '🂠 <b>J♠️ 9♥️ 4♦️</b>',
      '',
      '<b>БАНК 3 000</b> · блайнды 250/500 · D Иван',
      '<pre>  Иван         9 500  BTN',
      '  Макс         8 500  bet 1 000',
      '› Дима         9 500  ← ходит',
      '  Саша         9 500</pre>',
      '▶️ <b>Дима</b> · ставка 1 000 · коллировать 1 000',
      '<code>/call · /raise 2000…9500 · /allin · /fold</code>',
    ].join('\n')
  );
});

/** An all-in board with three pots — each goes to the best hand among ITS claimants. */
function sidePotFixture() {
  const room = fixture();
  room.players[0].stack = 1000; room.players[0].stats.buyIn = 1000;
  room.players[1].stack = 4000; room.players[1].stats.buyIn = 4000;
  deal(room);
  let guard = 0;
  while (room.hand.phase === 'betting' && guard++ < 20) act(room, room.hand.actorId, 'allin');
  return room;
}

test('snapshot: showdown with side pots', () => {
  const room = sidePotFixture();
  assert.equal(room.hand.pots.length, 3);
  assert.equal(
    norm(renderRoom(room).text),
    [
      '♠️ <b>РАЗДАЧА #1 · ВСКРЫТИЕ</b> · HH:MM',
      '',
      '🂠 <b>J♠️ 9♥️ 4♦️ 3♣️ 8♠️</b>',
      '',
      '🏆 <b>Иван</b> +4 000 · Пара A',
      '🏆 <b>Макс</b> +9 000 · Пара K',
      '🏆 <b>Дима</b> +12 000 · Пара Q',
      '',
      'Иван: A♠️ A♥️ — Пара A',
      'Макс: K♦️ K♣️ — Пара K',
      'Дима: Q♥️ Q♦️ — Пара Q',
      'Саша: 7♣️ 2♦️ — Старшая J',
      '',
      'MAIN POT 4 000 → Иван',
      'SIDE POT 1 9 000 → Макс',
      'SIDE POT 2 12 000 → Дима',
      '',
      '<b>Банк 25 000</b> · стеки:',
      '<pre>Иван           4 000  +3 000',
      'Макс           9 000  +5 000',
      'Дима          12 000  +2 000',
      'Саша               0  −10 000</pre>',
    ].join('\n')
  );
});

test('snapshot: everybody folded — the winner\'s cards stay closed', () => {
  const room = fixture();
  deal(room);
  let guard = 0;
  while (room.hand.phase === 'betting' && guard++ < 10) act(room, room.hand.actorId, 'fold');

  assert.equal(
    norm(renderRoom(room).text),
    [
      '♠️ <b>РАЗДАЧА #1 ЗАВЕРШЕНА</b> · HH:MM',
      '',
      '🏆 <b>Дима</b> +750 — остальные сбросили',
      '',
      '<b>Банк 750</b> · стеки:',
      '<pre>Иван          10 000  0',
      'Макс           9 750  −250',
      'Дима          10 250  +250',
      'Саша          10 000  0</pre>',
    ].join('\n')
  );
});

test('snapshot: a hand abandoned by /finish says so and shows no cards', () => {
  const room = fixture();
  deal(room);
  act(room, room.hand.actorId, 'call');
  endGame(room, 1);

  assert.equal(
    norm(renderRoom({ ...room, status: 'playing' }).text),
    [
      '♠️ <b>РАЗДАЧА #1 ПРЕРВАНА</b> · HH:MM',
      '',
      '<i>Игру завершили посреди раздачи — поставленные фишки вернулись владельцам.</i>',
      '',
      'Стеки:',
      '<pre>Иван          10 000  0',
      'Макс          10 000  0',
      'Дима          10 000  0',
      'Саша          10 000  0</pre>',
    ].join('\n')
  );
});

test('snapshot: a turn on the clock says when, and what happens then', () => {
  const room = fixture();
  room.settings.turnSeconds = 60;
  deal(room);
  syncTurn(room, Date.UTC(2026, 8, 25, 11, 0, 0));
  const text = norm(renderRoom(room).text);
  assert.match(text, /\n⏱ ход до HH:MM:SS — потом фолд$/, 'a fixed time, not a countdown that edits every second');
});

test('snapshot: an all-in board being turned over — the flop frame', () => {
  const room = sidePotFixture();
  room.ui.reveal = { handNo: room.hand.no, shown: 3 };
  const v = renderRoom(room);
  assert.equal(
    norm(v.text),
    [
      '♠️ <b>РАЗДАЧА #1 · ОЛЛ-ИН</b> · HH:MM',
      '',
      '🂠 <b>J♠️ 9♥️ 4♦️</b>',
      '',
      'Иван: A♠️ A♥️',
      'Макс: K♦️ K♣️',
      'Дима: Q♥️ Q♦️',
      'Саша: 7♣️ 2♦️',
      '',
      '<b>БАНК 25 000</b>',
      '<i>Открываем борд…</i>',
    ].join('\n')
  );
  assert.deepEqual(v.keyboard.map((r) => r.map((b) => b.text)), [['🂠 Мои карты']]);
});

test('snapshot: final results balance to zero', () => {
  assert.equal(
    renderResults(sidePotFixture()),
    [
      '🏁 <b>ИТОГИ</b>',
      '',
      '<pre>Макс           9 000   +5 000',
      'Иван           4 000   +3 000',
      'Дима          12 000   +2 000',
      'Саша               0  −10 000</pre>',
      '',
      '<i>Макс: раздач 1, банков 1, крупнейший 9 000',
      'Иван (хост): раздач 1, банков 1, крупнейший 4 000',
      'Дима: раздач 1, банков 1, крупнейший 12 000',
      'Саша: раздач 1, банков 0, крупнейший 0</i>',
      '',
      '<i>Раздач сыграно: 1. Сумма P/L: 0 — должна быть 0.</i>',
    ].join('\n')
  );
});

test('snapshot: the private message holds your two cards and nothing else', () => {
  const room = fixture();
  deal(room);
  assert.equal(
    renderHole(room, '2'),
    [
      '🂠 <b>Раздача #1</b> · Покер по пятницам',
      '',
      '<b>K♦️ K♣️</b>',
      '',
      '<i>Ходить — в группе: кнопками под столом или командами /call, /raise 300, /fold.</i>',
    ].join('\n')
  );
  assert.equal(renderHole(room, '999'), null, 'nobody outside the hand gets a message');
});

/* ----------------------------------------------------------- the details */

test('command hints are <code>, so a stray tap copies instead of sending /allin', () => {
  const room = fixture();
  deal(room);
  const text = renderRoom(room).text;
  const hint = text.split('\n').find((l) => l.includes('/allin'));
  assert.match(hint, /^<code>.*<\/code>$/);
  assert.equal(commandHints(legalActions(room, room.hand.actorId)), '/call · /raise 1000…10000 · /allin · /fold');
});

test('no card is ever rendered inside <pre> — emoji suits would break the columns', () => {
  const room = sidePotFixture();
  const pres = renderRoom(room).text.match(/<pre>[\s\S]*?<\/pre>/g);
  for (const block of pres) assert.doesNotMatch(block, /[♠♥♦♣]/);
});

test('a hostile display name cannot inject markup or break the columns', () => {
  const room = createRoom({ chatId: -2, host: { id: 1, name: '<b>hack</b>' } });
  addPlayer(room, { id: 2, name: 'Мария' });
  const text = renderRoom(room).text;
  assert.ok(!text.includes('<b>hack</b>'), 'the name was escaped');
  assert.match(text, /&lt;b&gt;hack/);
  assert.match(renderResults(room), /&lt;b&gt;hack/, 'escaped once in the results — not twice');
  assert.doesNotMatch(renderResults(room), /&amp;lt;/);
});

test('an invisible RTL override in a name is stripped, not rendered', () => {
  const room = createRoom({ chatId: -3, host: { id: 1, name: 'Иван\u202eevil' } });
  assert.equal(room.players[0].name, 'Иванevil');
});

test('a long emoji name is cut between characters, never inside one', () => {
  const room = createRoom({ chatId: -4, host: { id: 1, name: '🙂'.repeat(20) } });
  assert.equal(room.players[0].name, '🙂'.repeat(16));
  assert.doesNotMatch(room.players[0].name, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'no half of a surrogate pair');
});

test('emoji names still line up, because padding counts cells not code points', () => {
  assert.equal(visualWidth('🙂'), 2);
  assert.equal(visualWidth(padEnd('🙂Ян', 10)), 10);
  assert.equal(visualWidth(padEnd('Ян', 10)), 10);
});

/* -------------------------------------------------------------- keyboard */

test('FOLD is hidden when checking is free — the costliest accidental tap', () => {
  const room = fixture();
  deal(room);
  act(room, room.hand.actorId, 'call'); // Саша
  act(room, room.hand.actorId, 'call'); // Иван
  act(room, room.hand.actorId, 'call'); // Макс completes SB

  const bb = room.players.find((p) => p.id === room.hand.bbId);
  assert.equal(room.hand.actorId, bb.id, 'the big blind still has the option');
  const labels = actionKeyboard(room, bb, legalActions(room, bb.id)).flat().map((b) => b.text);
  assert.ok(labels.includes('CHECK'));
  assert.ok(!labels.includes('FOLD'), 'folding for free is never right, so the button is not there');
});

test('facing a bet, CHECK is replaced by CALL with the real amount', () => {
  const room = fixture();
  deal(room);
  const actor = room.players.find((p) => p.id === room.hand.actorId);
  const labels = actionKeyboard(room, actor, legalActions(room, actor.id)).flat().map((b) => b.text);
  assert.ok(labels.includes('FOLD'));
  assert.ok(labels.includes('CALL 500'));
  assert.ok(!labels.includes('CHECK'));
});

test('presets never offer an illegal size, and never duplicate ALL-IN', () => {
  const room = fixture();
  room.players[3].stack = 900; // Саша is short
  deal(room);
  const actor = room.players.find((p) => p.id === room.hand.actorId);
  const legal = legalActions(room, actor.id);
  const rows = actionKeyboard(room, actor, legal);
  const presets = rows.flat().filter((b) => /·/.test(b.text));

  for (const b of presets) {
    const total = Number(b.callback_data.split(':').pop());
    assert.ok(total >= legal.minTotal, `${b.text} is below the minimum raise`);
    assert.ok(total < legal.maxTotal, `${b.text} duplicates ALL-IN`);
  }
});

test('a short all-in that cannot re-open betting offers no RAISE at all', () => {
  // Built step by step rather than in a loop: a loop here can wander off the
  // intended line and pass without ever reaching the assertion.
  const room = createRoom({
    chatId: -9, host: { id: 1, name: 'Иван' },
    startingStack: 5000, smallBlind: 25, bigBlind: 50,
  });
  for (const [id, name] of [[2, 'Макс'], [3, 'Дима'], [4, 'Саша']]) addPlayer(room, { id, name });
  room.players[1].stack = 90; // Макс can shove for less than a full raise
  room.players[1].stats.buyIn = 90;
  startGame(room, 1);

  // Иван button, Макс SB, Дима BB, Саша first to act.
  assert.equal(room.hand.actorId, '4');
  act(room, '4', 'call', null, room.seq); // Саша acts voluntarily
  act(room, '1', 'call', null, room.seq);

  assert.equal(room.hand.actorId, '2');
  act(room, '2', 'allin', null, room.seq); // total 90 — a 40 increment over 50
  assert.equal(room.hand.currentBet, 90);
  assert.equal(room.hand.minRaise, 50, 'a sub-minimum shove does not raise the bar');

  act(room, '3', 'call', null, room.seq);
  assert.equal(room.hand.actorId, '4', 'back to the player who had already called');

  const legal = legalActions(room, '4');
  assert.equal(legal.canRaise, false, 'a sub-minimum all-in must not re-open the betting');
  assert.equal(legal.canCall, true, 'calling and folding stay available');

  const sasha = room.players.find((p) => p.id === '4');
  const labels = actionKeyboard(room, sasha, legal).flat().map((b) => b.text);
  assert.deepEqual(labels, ['FOLD', 'CALL 40'], 'no sizing buttons are offered at all');
  assert.equal(commandHints(legal), '/call · /fold', 'and no /raise or /allin is suggested either');
});
