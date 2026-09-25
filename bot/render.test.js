'use strict';
/**
 * Snapshot tests for everything the bot still writes in Telegram: the group
 * card, the private "your turn" and the results of the evening.
 *
 * Written out in full rather than stored in a .snap file on purpose: what
 * the group sees IS the product, and a change to it should be visible in the
 * diff of a review, not hidden behind a regenerated blob.
 *
 * Every hand below is dealt from a stacked deck, so the cards are fixed too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoom, addPlayer, startGame, act, endGame, syncTurn, updateSettings, setRole,
  toggleWinner, winnerNext, confirmWinners,
} from './room.js';
import { renderCard, renderTurnPing, renderResults } from './render.js';
import { presets } from './view.js';
import { legalActions } from '../server/game.js';
import { padEnd, visualWidth } from './fmt.js';
import { stack } from './harness.js';

/** Wall-clock differs per run and per timezone; nothing else may. */
const norm = (s) => s.replace(/\d\d:\d\d(:\d\d)?/g, (m) => (m.length > 5 ? 'HH:MM:SS' : 'HH:MM'));

const LINK = 'https://t.me/ChipTableBot/table?startapp=abcdefgh23';

function fixture() {
  const room = createRoom({
    chatId: -1, title: 'Покер по пятницам', host: { id: 1, name: 'Иван', dm: 'ok' },
    startingStack: 10000, smallBlind: 250, bigBlind: 500, code: 'abcdefgh23',
  });
  for (const [id, name, dm] of [[2, 'Макс', 'ok'], [3, 'Дима', null], [4, 'Саша', 'ok']]) {
    addPlayer(room, { id, name, dm });
  }
  return room;
}

const DECK = stack({ 1: 'As Ah', 2: 'Kd Kc', 3: 'Qh Qd', 4: '7c 2d' }, 'Js 9h 4d 3c 8s');
const deal = (room) => startGame(room, 1, { deck: () => DECK(room) });

/** Check or call until the betting is over. */
function callDown(room) {
  let guard = 0;
  while (room.hand.phase === 'betting' && guard++ < 40) {
    const p = room.players.find((x) => x.id === room.hand.actorId);
    act(room, p.id, room.hand.currentBet > p.bet ? 'call' : 'check');
  }
}

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

/** A real-cards table: Саша deals, the other three play. */
function liveFixture() {
  const room = fixture();
  assert.equal(updateSettings(room, '1', { cards: 'live' }).error, undefined);
  assert.equal(setRole(room, '1', '4', 'dealer').ok, true);
  startGame(room, '1');
  return room;
}

const HEAD = [
  '♠️ <b>Покерная комната</b>',
  'Игроков: <b>4/8</b>',
  'Стек 10 000 · блайнды 250/500',
  '🤖 Карты раздаёт бот',
  '',
];

/* ------------------------------------------------------------ the card */

test('snapshot: lobby — who is in, and the one button that opens the table', () => {
  const v = renderCard(fixture(), { link: LINK });
  assert.equal(
    v.text,
    [
      '♠️ <b>Покерная комната</b>',
      'Игроков: <b>4/8</b> — Иван, Макс, Дима, Саша',
      'Стек 10 000 · блайнды 250/500',
      '🤖 Карты раздаёт бот',
      '',
      '⏳ <b>Ожидание игроков</b>',
      '<i>Иван может начинать.</i>',
    ].join('\n')
  );
  assert.deepEqual(v.keyboard, [[{ text: '🃏 Открыть стол', url: LINK }]], 'a link, never a callback — the table is not in the chat');
});

test('snapshot: a lonely host is told what is missing', () => {
  const room = createRoom({ chatId: -1, host: { id: 1, name: 'Иван' }, code: 'abcdefgh23' });
  assert.equal(
    renderCard(room, { link: LINK }).text,
    [
      '♠️ <b>Покерная комната</b>',
      'Игроков: <b>1/8</b> — Иван',
      'Стек 10 000 · блайнды 25/50',
      '🤖 Карты раздаёт бот',
      '',
      '⏳ <b>Ожидание игроков</b>',
      '<i>Нужен ещё хотя бы один игрок.</i>',
    ].join('\n')
  );
});

test('snapshot: pre-flop — the stage and whose turn, and not a single card', () => {
  const room = fixture();
  deal(room);
  act(room, room.hand.actorId, 'raise', 1500); // Саша
  act(room, room.hand.actorId, 'fold'); // Иван

  assert.equal(
    renderCard(room, { link: LINK }).text,
    [...HEAD, '▶️ Идёт игра · раздача #1 · ПРЕФЛОП', '👉 Ход: <b>Макс</b>'].join('\n')
  );
});

test('snapshot: the flop is the table\'s business — the card names the street only', () => {
  const room = fixture();
  room.settings.turnSeconds = 60;
  deal(room);
  while (room.hand.street === 'preflop') {
    const p = room.players.find((x) => x.id === room.hand.actorId);
    act(room, p.id, room.hand.currentBet > p.bet ? 'call' : 'check');
  }
  act(room, room.hand.actorId, 'bet', 1000); // Макс

  const text = renderCard(room, { link: LINK }).text;
  assert.equal(
    text,
    [
      '♠️ <b>Покерная комната</b>',
      'Игроков: <b>4/8</b>',
      'Стек 10 000 · блайнды 250/500 · ⏱ 60 с на ход',
      '🤖 Карты раздаёт бот',
      '',
      '▶️ Идёт игра · раздача #1 · ФЛОП',
      '👉 Ход: <b>Дима</b>',
    ].join('\n')
  );
});

test('snapshot: showdown with side pots — every pot\'s winner, with the hand that won it', () => {
  const room = sidePotFixture();
  assert.equal(room.hand.pots.length, 3);
  assert.equal(
    renderCard(room, { link: LINK }).text,
    [
      ...HEAD,
      '▶️ Идёт игра · раздача #1 · ЗАВЕРШЕНА',
      '🏆 <b>Иван</b> +4 000 · Пара A',
      '🏆 <b>Макс</b> +9 000 · Пара K',
      '🏆 <b>Дима</b> +12 000 · Пара Q',
    ].join('\n')
  );
});

test('snapshot: everybody folded — the winner\'s cards stay closed', () => {
  const room = fixture();
  deal(room);
  let guard = 0;
  while (room.hand.phase === 'betting' && guard++ < 10) act(room, room.hand.actorId, 'fold');

  assert.equal(
    renderCard(room, { link: LINK }).text,
    [...HEAD, '▶️ Идёт игра · раздача #1 · ЗАВЕРШЕНА', '🏆 <b>Дима</b> +750 — остальные сбросили'].join('\n')
  );
});

test('snapshot: while an all-in board is being turned over, the card does not spoil the result', () => {
  const room = sidePotFixture();
  room.ui.reveal = { handNo: room.hand.no, shown: 3 };
  const text = renderCard(room, { link: LINK }).text;
  assert.equal(text, [...HEAD, '▶️ Идёт игра · раздача #1 · ЗАВЕРШЕНА', '🃏 Открываем борд…'].join('\n'));
});

test('snapshot: a finished game points at the results', () => {
  const room = fixture();
  deal(room);
  act(room, room.hand.actorId, 'call');
  endGame(room, 1);
  const v = renderCard(room, { link: LINK });
  assert.equal(v.text.split('\n').at(-1), '🏁 <b>Игра завершена</b> — итоги ниже.');
});

test('snapshot: paused', () => {
  const room = fixture();
  deal(room);
  room.status = 'paused';
  assert.deepEqual(renderCard(room, { link: LINK }).text.split('\n').slice(5), ['⏸ <b>Пауза</b>', 'Раздача #1 · ПРЕФЛОП']);
});

test('snapshot: real cards — the dealer is named, is not counted as a player, and decides the pot', () => {
  const room = liveFixture();
  callDown(room);
  assert.equal(room.hand.phase, 'showdown');
  assert.equal(
    renderCard(room, { link: LINK }).text,
    [
      '♠️ <b>Покерная комната</b>',
      'Игроков: <b>3/8</b>',
      'Стек 10 000 · блайнды 250/500',
      '🃏 Настоящие карты · дилер Саша',
      '',
      '▶️ Идёт игра · раздача #1 · ВСКРЫТИЕ',
      '🃏 Саша определяет победителя',
    ].join('\n')
  );

  const maks = room.players.findIndex((p) => p.id === '2');
  assert.equal(toggleWinner(room, '4', 0, maks).error, undefined);
  assert.equal(winnerNext(room, '4').error, undefined);
  assert.equal(confirmWinners(room, '4', room.seq).error, undefined);
  assert.deepEqual(renderCard(room, { link: LINK }).text.split('\n').slice(5), [
    '▶️ Идёт игра · раздача #1 · ЗАВЕРШЕНА',
    '🏆 <b>Макс</b> +1 500',
  ]);
});

test('the card never carries a card — at any moment of a hand', () => {
  const room = fixture();
  deal(room);
  const texts = [];
  let guard = 0;
  while (room.hand.phase === 'betting' && guard++ < 40) {
    texts.push(renderCard(room, { link: LINK }).text);
    const p = room.players.find((x) => x.id === room.hand.actorId);
    act(room, p.id, room.hand.currentBet > p.bet ? 'call' : 'check');
  }
  texts.push(renderCard(room, { link: LINK }).text);
  assert.ok(texts.length > 10, 'a whole hand was looked at');
  for (const t of texts) {
    // The only suit on the card is the ♠️ of its title.
    assert.doesNotMatch(t.replace('♠️ <b>Покерная комната</b>', ''), /[♠♥♦♣]/);
    assert.doesNotMatch(t, /\b(10|[2-9AKQJ])[shdc]\b/);
  }
});

test('without a link there is no button — never a dead one', () => {
  assert.deepEqual(renderCard(fixture()).keyboard, []);
});

/* ------------------------------------------------------------ the ping */

test('snapshot: "your turn" — what it costs, and when the clock runs out', () => {
  const room = fixture();
  room.settings.turnSeconds = 60;
  deal(room);
  syncTurn(room, Date.UTC(2026, 8, 25, 11, 0, 0));
  const sasha = room.players.find((p) => p.id === room.hand.actorId);
  assert.equal(sasha.name, 'Саша');
  assert.equal(
    norm(renderTurnPing(room, sasha)),
    [
      '👉 <b>Ваш ход</b> · Покер по пятницам',
      'Раздача #1 · ПРЕФЛОП · колл 500 · банк 750',
      '⏱ до HH:MM:SS — потом фолд',
    ].join('\n')
  );
});

test('snapshot: "your turn" when checking is free — and no clock', () => {
  const room = fixture();
  deal(room);
  act(room, room.hand.actorId, 'call'); // Саша
  act(room, room.hand.actorId, 'call'); // Иван
  act(room, room.hand.actorId, 'call'); // Макс completes the small blind
  const bb = room.players.find((p) => p.id === room.hand.actorId);
  assert.equal(bb.id, room.hand.bbId);
  assert.equal(
    renderTurnPing(room, bb),
    ['👉 <b>Ваш ход</b> · Покер по пятницам', 'Раздача #1 · ПРЕФЛОП · можно чекнуть · банк 2 000'].join('\n')
  );
  assert.doesNotMatch(renderTurnPing(room, bb), /[♠♥♦♣]/, 'no cards on a lock screen');
});

/* --------------------------------------------------------- the results */

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

test('results of a real-cards evening name the dealer, who is not a row of the table', () => {
  const room = liveFixture();
  callDown(room);
  const maks = room.players.findIndex((p) => p.id === '2');
  toggleWinner(room, '4', 0, maks);
  winnerNext(room, '4');
  confirmWinners(room, '4', room.seq);
  const text = renderResults(room);
  assert.match(text, /<i>Дилер: Саша<\/i>/);
  assert.doesNotMatch(text.split('<i>Дилер')[0], /Саша/, 'a dealer who never played has no P/L line');
  assert.match(text, /Макс\s+11 000\s+\+1 000/);
  assert.match(text, /Сумма P\/L: 0 —/);
});

/* ----------------------------------------------------------- the details */

test('a hostile display name cannot inject markup', () => {
  const room = createRoom({ chatId: -2, host: { id: 1, name: '<b>hack</b>' } });
  addPlayer(room, { id: 2, name: 'Мария' });
  const text = renderCard(room, { link: LINK }).text;
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

test('emoji names still line up in the results, because padding counts cells not code points', () => {
  assert.equal(visualWidth('🙂'), 2);
  assert.equal(visualWidth(padEnd('🙂Ян', 10)), 10);
  assert.equal(visualWidth(padEnd('Ян', 10)), 10);
});

/* --------------------------------------------- raise presets in the app */

test('presets never offer an illegal size, and never duplicate ALL-IN', () => {
  const room = fixture();
  room.players[3].stack = 900; // Саша is short
  deal(room);
  const all = [];
  let guard = 0;
  while (room.hand.phase === 'betting' && guard++ < 40) {
    const l = legalActions(room, room.hand.actorId);
    const ps = presets(room, l);
    all.push(...ps);
    for (const p of ps.filter((x) => x.kind === 'size')) {
      assert.ok(p.total >= l.minTotal, `${p.label} ${p.total} is below the minimum raise ${l.minTotal}`);
      assert.ok(p.total < l.maxTotal, `${p.label} ${p.total} duplicates ALL-IN`);
    }
    assert.equal(ps.filter((x) => x.kind === 'allin').length, l.canBet || l.canRaise ? 1 : 0);
    const totals = ps.map((x) => x.total);
    assert.equal(new Set(totals).size, totals.length, 'no two buttons for the same amount');
    const p = room.players.find((x) => x.id === room.hand.actorId);
    act(room, p.id, room.hand.currentBet > p.bet ? 'call' : 'check');
  }
  assert.ok(all.some((x) => x.kind === 'size'), 'the test did look at real sizes');
});

test('snapshot: presets facing the big blind — +BB, ½ POT, POT, ALL-IN', () => {
  const room = fixture();
  deal(room);
  const l = legalActions(room, room.hand.actorId); // Саша: 500 to call, pot 750
  assert.deepEqual(presets(room, l), [
    { label: '+500', total: 1000, kind: 'size' },
    { label: '½ POT', total: 1125, kind: 'size' },
    { label: 'POT', total: 1750, kind: 'size' },
    { label: 'ALL-IN', total: 10000, kind: 'allin' },
  ]);
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
  assert.deepEqual(presets(room, legal), [], 'no sizing — not even ALL-IN — is offered at all');
  assert.equal(act(room, '4', 'allin', null, room.seq).error != null, true, 'and a shove typed by hand is refused');
});
