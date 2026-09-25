'use strict';
/**
 * Snapshot tests for the table message.
 *
 * These are written out in full rather than stored in a .snap file on
 * purpose: the table IS the product here, and a change to it should be
 * visible in the diff of a review, not hidden behind a regenerated blob.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoom, addPlayer, startGame, act, toggleWinner, winnerNext, confirmWinners, setRole,
} from './room.js';
import { renderRoom, renderResults, actionKeyboard } from './render.js';
import { legalActions } from '../server/game.js';
import { padEnd, visualWidth } from './fmt.js';

/** Wall-clock differs per run and per timezone; nothing else may. */
const norm = (s) => s.replace(/\d\d:\d\d/g, 'HH:MM');

function fixture() {
  const room = createRoom({
    chatId: -1, host: { id: 1, name: 'Иван' },
    startingStack: 10000, smallBlind: 250, bigBlind: 500,
  });
  for (const [id, name] of [[2, 'Макс'], [3, 'Дима'], [4, 'Саша']]) addPlayer(room, { id, name });
  return room;
}

test('snapshot: lobby', () => {
  assert.equal(
    norm(renderRoom(fixture()).text),
    [
      '♠️ <b>НОВЫЙ СТОЛ</b>',
      '',
      'Стек 10 000 · блайнды 250/500',
      '',
      '<pre>Иван          10 000  хост',
      'Макс          10 000',
      'Дима          10 000',
      'Саша          10 000</pre>',
      '',
      '<i>4 за столом. Хост может начинать.</i>',
    ].join('\n')
  );
});

test('snapshot: mid-street betting', () => {
  const room = fixture();
  startGame(room, 1);
  act(room, room.hand.actorId, 'raise', 1500, room.seq);
  act(room, room.hand.actorId, 'fold', null, room.seq);

  assert.equal(
    norm(renderRoom(room).text),
    [
      '♠️ <b>РАЗДАЧА #1</b> · ПРЕФЛОП · HH:MM',
      '',
      '<b>БАНК  2 250</b> · блайнды 250/500 · D Иван',
      '',
      '<pre>  Иван        10 000  fold',
      '› Макс         9 750  ← ходит',
      '  Дима         9 500  BB 500',
      '  Саша         8 500  raise 1 500</pre>',
      '',
      '▶️ <b>Макс</b> · Ставка 1 500 · коллировать 1 250',
    ].join('\n')
  );
});

/** An all-in board with three pots — the case a dealer must never hand-count. */
function sidePotFixture() {
  const room = fixture();
  room.players[0].stack = 1000; room.players[0].stats.buyIn = 1000;
  room.players[1].stack = 4000; room.players[1].stats.buyIn = 4000;
  startGame(room, 1);
  let guard = 0;
  while (room.hand.phase === 'betting' && guard++ < 20) {
    act(room, room.hand.actorId, 'allin', null, room.seq);
  }
  return room;
}

test('snapshot: showdown with side pots', () => {
  const room = sidePotFixture();
  assert.equal(room.hand.pots.length, 3);
  assert.equal(
    norm(renderRoom(room).text),
    [
      '♠️ <b>РАЗДАЧА #1</b> · ВСКРЫТИЕ · HH:MM',
      '',
      '<b>БАНК  25 000</b> · блайнды 250/500 · D Иван',
      '',
      '<pre>  Иван             0  all-in',
      '  Макс             0  all-in',
      '  Дима             0  all-in',
      '  Саша             0  all-in</pre>',
      '',
      '🏆 <b>MAIN POT · 4 000</b>   (банк 1 из 3)',
      'Кто забрал? Можно отметить нескольких — банк разделится.',
      '',
      '<i>Дилер не назначен — победителя отмечает любой за столом.</i>',
    ].join('\n')
  );
});

test('snapshot: distribution review', () => {
  const room = sidePotFixture();
  let guard = 0;
  while (!room.ui.winner.review && guard++ < 6) {
    const pot = room.hand.pots[room.ui.winner.potIndex];
    const seat = room.players.findIndex((p) => p.id === pot.eligible[0]);
    toggleWinner(room, 1, room.ui.winner.potIndex, seat);
    winnerNext(room, 1);
  }
  assert.equal(
    norm(renderRoom(room).text),
    [
      '♠️ <b>РАЗДАЧА #1 · РАСПРЕДЕЛЕНИЕ</b>',
      '',
      'MAIN POT · 4 000 → Иван',
      'SIDE POT 1 · 9 000 → Макс',
      'SIDE POT 2 · 12 000 → Дима',
      '',
      '<b>На руки:</b>',
      '<pre>Дима         +12 000',
      'Макс          +9 000',
      'Иван          +4 000</pre>',
      '',
      '<i>Фишки двигаются только после подтверждения.</i>',
    ].join('\n')
  );
});

test('snapshot: finished hand', () => {
  const room = sidePotFixture();
  let guard = 0;
  while (!room.ui.winner.review && guard++ < 6) {
    const pot = room.hand.pots[room.ui.winner.potIndex];
    toggleWinner(room, 1, room.ui.winner.potIndex, room.players.findIndex((p) => p.id === pot.eligible[0]));
    winnerNext(room, 1);
  }
  confirmWinners(room, 1, room.seq);

  assert.equal(
    norm(renderRoom(room).text),
    [
      '♠️ <b>РАЗДАЧА #1 ЗАВЕРШЕНА</b> · HH:MM',
      '',
      '<b>БАНК  25 000</b>',
      '',
      '<pre>Иван          +4 000',
      'Макс          +9 000',
      'Дима         +12 000</pre>',
      '',
      '<b>Стеки:</b>',
      '<pre>Иван           4 000  +3 000',
      'Макс           9 000  +5 000',
      'Дима          12 000  +2 000',
      'Саша               0  −10 000</pre>',
    ].join('\n')
  );
});

test('snapshot: final results balance to zero', () => {
  const room = sidePotFixture();
  let guard = 0;
  while (!room.ui.winner.review && guard++ < 6) {
    const pot = room.hand.pots[room.ui.winner.potIndex];
    toggleWinner(room, 1, room.ui.winner.potIndex, room.players.findIndex((p) => p.id === pot.eligible[0]));
    winnerNext(room, 1);
  }
  confirmWinners(room, 1, room.seq);

  assert.equal(
    renderResults(room),
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
      '<i>Сумма P/L: 0 — должна быть 0.</i>',
    ].join('\n')
  );
});

/* ----------------------------------------------------------- the details */

test('the dealer never appears as a seat at the table', () => {
  const room = fixture();
  setRole(room, 1, '4', 'dealer');
  startGame(room, 1);
  const text = renderRoom(room).text;
  assert.ok(!text.includes('Саша'), 'the dealer holds cards, not chips in this hand');
  assert.match(text, /Иван/);
});

test('a hostile display name cannot inject markup or break the columns', () => {
  const room = createRoom({ chatId: -2, host: { id: 1, name: '<b>hack</b>' } });
  addPlayer(room, { id: 2, name: 'Мария' });
  const text = renderRoom(room).text;
  assert.ok(!text.includes('<b>hack</b>'), 'the name was escaped');
  assert.match(text, /&lt;b&gt;hack/);
});

test('an invisible RTL override in a name is stripped, not rendered', () => {
  const room = createRoom({ chatId: -3, host: { id: 1, name: 'Иван\u202eevil' } });
  assert.equal(room.players[0].name, 'Иванevil');
});

test('emoji names still line up, because padding counts cells not code points', () => {
  assert.equal(visualWidth('🙂'), 2);
  assert.equal(visualWidth(padEnd('🙂Ян', 10)), 10);
  assert.equal(visualWidth(padEnd('Ян', 10)), 10);
});

/* -------------------------------------------------------------- keyboard */

test('FOLD is hidden when checking is free — the costliest accidental tap', () => {
  const room = fixture();
  startGame(room, 1);
  act(room, room.hand.actorId, 'call', null, room.seq); // Саша
  act(room, room.hand.actorId, 'call', null, room.seq); // Иван
  act(room, room.hand.actorId, 'call', null, room.seq); // Макс completes SB

  const bb = room.players.find((p) => p.id === room.hand.bbId);
  assert.equal(room.hand.actorId, bb.id, 'the big blind still has the option');
  const labels = actionKeyboard(room, bb, legalActions(room, bb.id)).flat().map((b) => b.text);
  assert.ok(labels.includes('CHECK'));
  assert.ok(!labels.includes('FOLD'), 'folding for free is never right, so the button is not there');
});

test('facing a bet, CHECK is replaced by CALL with the real amount', () => {
  const room = fixture();
  startGame(room, 1);
  const actor = room.players.find((p) => p.id === room.hand.actorId);
  const labels = actionKeyboard(room, actor, legalActions(room, actor.id)).flat().map((b) => b.text);
  assert.ok(labels.includes('FOLD'));
  assert.ok(labels.includes('CALL 500'));
  assert.ok(!labels.includes('CHECK'));
});

test('presets never offer an illegal size, and never duplicate ALL-IN', () => {
  const room = fixture();
  room.players[3].stack = 900; // Саша is short
  startGame(room, 1);
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
});
