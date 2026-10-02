'use strict';
/**
 * Правила «Радуги» — по одному тесту на правило, как в дураке.
 *
 * Здесь нет ни Telegram, ни сокетов: только комната и чистые функции над
 * ней. Что видно людям и кто кем может ходить — в colors.test.js.
 *
 * Колода подтасована всюду, где важно, ЧТО именно лежит: партия в «Радуге»
 * целиком про то, какая карта у кого, и случайная пачка проверяет удачу, а
 * не правила.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from './games/colors/rules.js';
import {
  freshDeck, isFullDeck, sortHand, matches, isCard, COLOR_SHAPE, COLORS, DECK_SIZE,
} from './games/colors/cards.js';
import { colorsStack, colorsRandom } from './harness.js';

/** Стол на `n` человек с подтасованной пачкой. Сдаёт хост, первым ходит №2. */
function table(hands, { top = 'R0', deck = '', stacking = true, ids = null } = {}) {
  const list = ids || Object.keys(hands).map(Number);
  const room = C.createRoom({ chatId: -1001, host: { id: list[0], name: `И${list[0]}` }, stacking });
  for (const id of list.slice(1)) C.addPlayer(room, { id, name: `И${id}` });
  const stack = colorsStack(hands, { top, deck });
  const r = C.startGame(room, list[0], { deck: () => stack(room), randInt: colorsRandom(7) });
  assert.equal(r.error, undefined, `сдача не вышла: ${r.error}`);
  return room;
}

const hand = (room, id) => room.deal.hands[String(id)];
const play = (room, id, card, o = {}) => C.play(room, id, card, { now: 1000, randInt: colorsRandom(3), ...o });
const draw = (room, id, o = {}) => C.draw(room, id, { now: 1000, randInt: colorsRandom(3), ...o });

/* ------------------------------------------------------------- 0. колода */

test('0. колода — 108 карт: по 25 каждого цвета и по четыре бесцветных', () => {
  const d = freshDeck();
  assert.equal(d.length, 108);
  assert.equal(DECK_SIZE, 108);
  for (const c of COLORS) {
    const mine = d.filter((x) => x[0] === c);
    assert.equal(mine.length, 25, `${c}: 25 карт`);
    assert.equal(mine.filter((x) => x === `${c}0`).length, 1, 'ноль один');
    for (let n = 1; n <= 9; n++) assert.equal(mine.filter((x) => x === `${c}${n}`).length, 2, `${c}${n} дважды`);
    for (const s of ['S', 'V', 'P']) assert.equal(mine.filter((x) => x === `${c}${s}`).length, 2, `${c}${s} дважды`);
  }
  assert.equal(d.filter((x) => x === 'WC').length, 4);
  assert.equal(d.filter((x) => x === 'WF').length, 4);
  assert.ok(isFullDeck(d));
  assert.equal(isFullDeck(d.slice(1)), false, 'неполная пачка не проходит');
  assert.ok(d.every(isCard));
});

/* ------------------------------------------------ 1. что на что ложится */

test('1. кладётся по цвету, по числу, по знаку — и больше ничего', () => {
  // На куче красная пятёрка, цвет красный.
  assert.ok(matches('R9', 'R5', 'R'), 'тот же цвет');
  assert.ok(matches('G5', 'R5', 'R'), 'то же число');
  assert.ok(matches('RS', 'R5', 'R'), 'тот же цвет, знак');
  assert.equal(matches('G9', 'R5', 'R'), false, 'ни цвет, ни число');
  // Знак к знаку: синий «стоп» на зелёный «стоп».
  assert.ok(matches('BS', 'GS', 'G'), 'тот же знак');
  assert.equal(matches('BS', 'GV', 'G'), false, '«стоп» на «разворот» не ложится');
  assert.equal(matches('B1', 'G1', 'G'), true, 'единица на единицу');
});

test('1а. стол отказывает словами, а не молчанием', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G9 G8 G7 G6 G5 G4 G3', 3: 'B1 B2 B3 B4 B5 B6 B7' }, { top: 'R0' });
  const r = play(room, 2, 'G9');
  assert.equal(r.error, 'CANNOT_PLAY');
  assert.match(r.text, /красный/);
  assert.equal(room.deal.top, 'R0', 'куча не тронута');
});

/* -------------------------------------------------------- 2. бесцветные */

test('2. «смена цвета» и «+4» кладутся на что угодно; названный цвет становится текущим', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'WC WF G1 G2 G3 G4 G5', 3: 'B1 B2 B3 B4 B5 B6 B7' }, { top: 'R0' });
  assert.equal(play(room, 2, 'WC').error, 'NEED_COLOR', 'цвет назвать обязательно');
  assert.ok(play(room, 2, 'WC', { color: 'B' }).ok);
  assert.equal(room.deal.top, 'WC');
  assert.equal(room.deal.color, 'B', 'цвет теперь синий');
  // Третий кладёт синюю — по названному цвету, а не по верхней карте.
  assert.ok(play(room, 3, 'B1').ok);
  assert.equal(room.deal.color, 'B');
});

test('2а. «+4» кладётся на что угодно и даёт следующему четыре', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'WF G1 G2 G3 G4 G5 G6', 3: 'B1 B2 B3 B4 B5 B6 B7' }, { top: 'R0' });
  assert.ok(play(room, 2, 'WF', { color: 'G' }).ok);
  assert.equal(room.deal.color, 'G');
  assert.equal(hand(room, 3).length, 11, 'третий взял четыре');
  assert.equal(room.deal.turn, '1', 'и пропустил ход');
});

/* ------------------------------------------------------------ 3–5. знаки */

test('3. «+2»: следующий взял две и пропустил', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'GP G1 G2 G3 G4 G5 G6', 3: 'B1 B2 B3 B4 B5 B6 B7' }, { top: 'G0' });
  assert.ok(play(room, 2, 'GP').ok);
  assert.equal(hand(room, 3).length, 9, 'третий взял две');
  assert.equal(room.deal.turn, '1', 'и пропустил ход');
  assert.equal(room.deal.pending, 0, 'накопленное разошлось');
});

test('4. «стоп»: следующий пропустил', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'GS G1 G2 G3 G4 G5 G6', 3: 'B1 B2 B3 B4 B5 B6 B7' }, { top: 'G0' });
  assert.ok(play(room, 2, 'GS').ok);
  assert.equal(hand(room, 3).length, 7, 'карт ему не прибавилось');
  assert.equal(room.deal.turn, '1', 'но ход он пропустил');
});

test('5. «разворот»: втроём сторона сменилась', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'GV G1 G2 G3 G4 G5 G6', 3: 'B1 B2 B3 B4 B5 B6 B7' }, { top: 'G0' });
  assert.equal(room.deal.dir, 1);
  assert.ok(play(room, 2, 'GV').ok);
  assert.equal(room.deal.dir, -1, 'сторона сменилась');
  assert.equal(room.deal.turn, '1', 'и ход пошёл в обратную сторону');
});

test('5а. «разворот» вдвоём работает как «стоп»', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'GV G1 G2 G3 G4 G5 G6' }, { top: 'G0' });
  assert.equal(room.deal.turn, '2', 'первым ходит не сдающий');
  assert.ok(play(room, 2, 'GV').ok);
  assert.equal(room.deal.turn, '2', 'ход вернулся к нему же — это и есть «стоп»');
  assert.equal(room.deal.dir, 1, 'сторону вдвоём разворачивать нечего');
});

/* --------------------------------------------------------- 6–7. накопление */

test('6. накопление включено: «+2» на «+2» — третий берёт четыре', () => {
  const room = table(
    { 1: 'RP R2 R3 R4 R5 R6 R7', 2: 'GP G1 G2 G3 G4 G5 G6', 3: 'B1 B2 B3 B4 B5 B6 B7' },
    { top: 'G0', stacking: true },
  );
  assert.ok(play(room, 2, 'GP').ok);
  // У третьего «+2» нет — он берёт сам, и накопить дальше некому.
  assert.equal(hand(room, 3).length, 9);
  assert.equal(room.deal.turn, '1');

  // А теперь так, чтобы было чем крыть: у третьего свой «+2».
  const r2 = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'GP G1 G2 G3 G4 G5 G6', 3: 'BP B2 B3 B4 B5 B6 B7' },
    { top: 'G0', stacking: true },
  );
  assert.ok(play(r2, 2, 'GP').ok);
  assert.equal(r2.deal.turn, '3', 'третьему дали выбрать: крыть или брать');
  assert.equal(r2.deal.pending, 2);
  assert.ok(play(r2, 3, 'BP').ok);
  assert.equal(hand(r2, 1).length, 11, 'первый берёт четыре');
  assert.equal(r2.deal.turn, '2', 'и пропускает');
});

test('6а. на «+4» можно положить только «+4»', () => {
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'WF G1 G2 G3 G4 G5 G6', 3: 'GP WF B3 B4 B5 B6 B7' },
    { top: 'G0', stacking: true },
  );
  assert.ok(play(room, 2, 'WF', { color: 'G' }).ok);
  assert.equal(room.deal.turn, '3', 'у третьего есть «+4» — ему дали выбрать');
  assert.equal(play(room, 3, 'GP').error, 'STACK_FOUR_ONLY', '«+2» на «+4» не ложится');
  assert.ok(play(room, 3, 'WF', { color: 'B' }).ok);
  assert.equal(hand(room, 1).length, 15, 'первый берёт восемь');
});

test('7. накопление выключено: «+2» на «+2» положить нельзя', () => {
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'GP G1 G2 G3 G4 G5 G6', 3: 'BP B2 B3 B4 B5 B6 B7' },
    { top: 'G0', stacking: false },
  );
  assert.ok(play(room, 2, 'GP').ok);
  // Выбора нет вовсе: третий взял две сам и ход ушёл дальше.
  assert.equal(hand(room, 3).length, 9, 'взял две');
  assert.ok(hand(room, 3).includes('BP'), 'свой «+2» остался при нём');
  assert.equal(room.deal.turn, '1', 'и пропустил ход');
});

/* ---------------------------------------------------------------- 8. взять */

test('8. нечего положить — взял одну; подошла — играет сразу, не хочет — ход ушёл', () => {
  // У второго нечего положить на синюю двойку: всё зелёное и ни одной 2.
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G3 G4 G5 G6 G7 G8', 3: 'B1 B3 B4 B5 B6 B7 B8' },
    { top: 'B2', deck: 'B9' },
  );
  assert.deepEqual(C.legalFor(room, 2).play, [], 'класть нечего');
  assert.ok(C.legalFor(room, 2).draw, 'зато можно взять');
  assert.ok(draw(room, 2).ok);
  assert.ok(hand(room, 2).includes('B9'), 'карта взята');
  assert.equal(room.deal.drawn, 'B9', 'она подошла — можно сыграть прямо сейчас');
  assert.equal(room.deal.turn, '2', 'ход всё ещё его');
  assert.deepEqual(C.legalFor(room, 2).play, ['B9'], 'и только её');
  assert.equal(play(room, 2, 'G1').error, 'ONLY_DRAWN', 'остальная рука уже спасовала');

  assert.ok(C.pass(room, 2, { now: 1 }).ok, 'не хочет — передаёт ход');
  assert.equal(room.deal.turn, '3');
  assert.ok(hand(room, 2).includes('B9'), 'взятая осталась в руке');
});

test('8а. взятая карта не подошла — ход уходит сам, тапа не просят', () => {
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G3 G4 G5 G6 G7 G8', 3: 'B1 B3 B4 B5 B6 B7 B8' },
    { top: 'B2', deck: 'R9' },
  );
  assert.ok(draw(room, 2).ok);
  assert.ok(hand(room, 2).includes('R9'));
  assert.equal(room.deal.drawn, null);
  assert.equal(room.deal.turn, '3', 'ход ушёл сам');
});

test('8б. есть чем ходить — брать не дают', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'B1 G2 G3 G4 G5 G6 G7', 3: 'B2 B3 B4 B5 B6 B7 B8' }, { top: 'B9' });
  assert.equal(draw(room, 2).error, 'CAN_PLAY');
});

/* ------------------------------------------------------ 9–10. конец колоды */

test('9. колода кончилась — сброс перетасовался, верхняя карта осталась на месте', () => {
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G3 G4 G5 G6 G7 G8', 3: 'B1 B3 B4 B5 B6 B7 B8' },
    { top: 'B2' },
  );
  const d = room.deal;
  // Руками: колода пуста, в сбросе лежит пара карт под верхней.
  d.deck = [];
  d.discard = ['Y1', 'Y4'];
  const top = d.top;
  assert.ok(draw(room, 2).ok);
  assert.equal(d.top, top, 'верхняя карта кучи на месте');
  assert.equal(d.discard.length, 0, 'сброс ушёл в колоду');
  assert.equal(d.deck.length + 1, 2, 'одна из двух карт сброса уехала в руку');
  assert.equal(hand(room, 2).length, 8);
});

test('10. колода и сброс пусты — ход просто переходит', () => {
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G3 G4 G5 G6 G7 G8', 3: 'B1 B3 B4 B5 B6 B7 B8' },
    { top: 'B2' },
  );
  const d = room.deal;
  d.deck = [];
  d.discard = [];
  assert.ok(draw(room, 2).ok);
  assert.equal(hand(room, 2).length, 7, 'взять было неоткуда');
  assert.equal(d.turn, '3', 'ход перешёл');
  assert.equal(d.phase, 'play', 'партия идёт дальше');
});

/* ---------------------------------------------------------- 11. выход с «+2» */

test('11. вышел последней «+2» — следующий всё равно берёт две', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'GP G1 G2 G3 G4 G5 G6', 3: 'B1 B2 B3 B4 B5 B6 B7' }, { top: 'G0' });
  const d = room.deal;
  d.hands['2'] = ['GP']; // у второго осталась одна — она же «+2»
  const before = hand(room, 3).length;
  assert.ok(play(room, 2, 'GP').ok);
  assert.ok(d.out.includes('2'), 'второй вышел');
  assert.equal(hand(room, 3).length, before + 2, 'и третий всё равно взял две');
});

test('11а. вдвоём: вышел последней «+2» — второй берёт две и остаётся последним', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'GP G1 G2 G3 G4 G5 G6' }, { top: 'G0' });
  const d = room.deal;
  d.hands['2'] = ['GP'];
  const before = hand(room, 1).length;
  assert.ok(play(room, 2, 'GP').ok);
  assert.equal(hand(room, 1).length, before + 2, 'своё «+2» он с собой не унёс');
  assert.equal(d.phase, 'over');
  assert.equal(d.loser, '1');
});

/* --------------------------------------------------------------- 12. Радуга */

test('12. «Радуга!»: нажал сам — чисто; поймали за три секунды — взял две; через шесть — поздно', () => {
  // Нажал сам.
  let room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7', 3: 'B1 B2 B3 B4 B5 B6 B7' }, { top: 'G0' });
  room.deal.hands['2'] = ['G1', 'G2'];
  assert.ok(play(room, 2, 'G1', { now: 1000 }).ok);
  assert.deepEqual({ id: room.deal.call.id, called: room.deal.call.called }, { id: '2', called: false });
  assert.ok(C.rainbow(room, 2, { now: 1500 }).ok);
  assert.equal(room.deal.call.called, true);
  assert.equal(C.catchRainbow(room, 3, { now: 2000 }).error, 'NOTHING_TO_CATCH', 'назвал вовремя — ловить нечего');

  // Промолчал, поймали на третьей секунде.
  room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7', 3: 'B1 B2 B3 B4 B5 B6 B7' }, { top: 'G0' });
  room.deal.hands['2'] = ['G1', 'G2'];
  assert.ok(play(room, 2, 'G1', { now: 1000 }).ok);
  const r = C.catchRainbow(room, 3, { now: 4000, randInt: colorsRandom(2) });
  assert.ok(r.ok);
  assert.equal(hand(room, 2).length, 3, 'взял две');
  assert.equal(room.deal.call, null, 'окно закрылось');

  // Промолчал, но шесть секунд прошли — ушёл чисто.
  room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7', 3: 'B1 B2 B3 B4 B5 B6 B7' }, { top: 'G0' });
  room.deal.hands['2'] = ['G1', 'G2'];
  assert.ok(play(room, 2, 'G1', { now: 1000 }).ok);
  assert.equal(C.catchRainbow(room, 3, { now: 7000 }).error, 'TOO_LATE');
  assert.equal(hand(room, 2).length, 1, 'карт не прибавилось');
});

test('12а. «Радуга!» за другого нельзя, и «Поймал!» за себя — тоже', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7', 3: 'B1 B2 B3 B4 B5 B6 B7' }, { top: 'G0' });
  room.deal.hands['2'] = ['G1', 'G2'];
  assert.ok(play(room, 2, 'G1', { now: 1000 }).ok);
  assert.equal(C.rainbow(room, 3, { now: 1500 }).error, 'NOT_ONE_CARD', 'нажать за другого нельзя');
  assert.equal(room.deal.call.called, false, 'и чужое молчание так не снимается');
  assert.equal(C.catchRainbow(room, 2, { now: 1500 }).error, 'CATCH_SELF', 'сам себя не ловит');
  assert.equal(C.rainbow(room, 1, { now: 1500 }).error, 'NOT_ONE_CARD', 'у первого семь карт');
});

test('12б. набрал карт — ловить уже нечего: окно закрывается само', () => {
  // Вдвоём, чтобы «+2» прилетело ровно тому, кто молчит с одной картой.
  const room = table({ 1: 'GP R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7' }, { top: 'G0' });
  room.deal.hands['2'] = ['G1', 'G2'];
  assert.ok(play(room, 2, 'G1', { now: 1000 }).ok);
  assert.ok(room.deal.call, 'осталась одна карта — окно открылось');
  assert.equal(room.deal.turn, '1');
  assert.ok(play(room, 1, 'GP', { now: 1100 }).ok); // «+2» прилетело молчуну
  assert.equal(hand(room, 2).length, 3, 'он взял две');
  assert.equal(room.deal.call, null, 'карт у него больше одной — ловить нечего');
  assert.equal(C.catchRainbow(room, 1, { now: 1200 }).error, 'NOTHING_TO_CATCH');
});

/* ------------------------------------------------------------- 13–14. места */

test('13. порядок выхода — это и есть места, последний оставшийся проигравший', () => {
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7', 3: 'B1 B2 B3 B4 B5 B6 B7', 4: 'Y1 Y2 Y3 Y4 Y5 Y6 Y7' },
    { top: 'G0' },
  );
  const d = room.deal;
  d.hands['2'] = ['G1'];
  d.hands['3'] = ['G2'];
  d.hands['4'] = ['G3'];
  assert.ok(play(room, 2, 'G1').ok); // второй вышел первым
  assert.ok(play(room, 3, 'G2').ok); // третий — вторым
  assert.ok(play(room, 4, 'G3').ok); // четвёртый — третьим, остался первый
  assert.equal(d.phase, 'over');
  assert.deepEqual(d.out, ['2', '3', '4', '1'], 'места по порядку выхода, последний в конце');
  assert.equal(d.loser, '1');
  const h = room.history.at(-1);
  assert.deepEqual(h.out, ['2', '3', '4', '1']);
  assert.equal(h.aborted, false);
});

test('14. партия на двоих: первый вышел — второй последний', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7' }, { top: 'G0' });
  room.deal.hands['2'] = ['G1'];
  assert.ok(play(room, 2, 'G1').ok);
  assert.equal(room.deal.phase, 'over');
  assert.deepEqual(room.deal.out, ['2', '1']);
  assert.equal(room.deal.loser, '1');
});

/* ------------------------------------------------------ 15. таймер и уход */

test('15. время вышло — бот взял карту и передал ход; больше он не делает ничего', () => {
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7', 3: 'B1 B2 B3 B4 B5 B6 B7' },
    { top: 'G0', deck: 'Y5' },
  );
  C.updateSettings(room, 1, { turnSeconds: 30 });
  const t = C.syncTurn(room, 1000);
  assert.equal(t.deadline, 31_000);
  assert.equal(C.timeoutMove(room, t.key, 30_000).error, 'EARLY');
  const r = C.timeoutMove(room, t.key, 31_000, { randInt: colorsRandom(1) });
  assert.ok(r.ok);
  assert.equal(hand(room, 2).length, 8, 'взял ровно одну');
  assert.equal(room.deal.turn, '3', 'и ход ушёл');
  assert.equal(C.timeoutMove(room, t.key, 40_000).error, 'STALE', 'тот же ключ второй раз не сработает');
});

test('15а. время вышло, а на нём висит «+2» — бот берёт их, иначе ход не отдать', () => {
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'GP G1 G2 G3 G4 G5 G6', 3: 'BP B2 B3 B4 B5 B6 B7' },
    { top: 'G0' },
  );
  C.updateSettings(room, 1, { turnSeconds: 30 });
  assert.ok(play(room, 2, 'GP').ok);
  assert.equal(room.deal.turn, '3');
  const t = C.syncTurn(room, 1000);
  assert.ok(C.timeoutMove(room, t.key, 31_000, { randInt: colorsRandom(1) }).ok);
  assert.equal(hand(room, 3).length, 9, 'взял две');
  assert.equal(room.deal.turn, '1', 'и пропустил');
});

test('16. ушёл из чата: втроём партия идёт дальше, вдвоём — прерывается', () => {
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7', 3: 'B1 B2 B3 B4 B5 B6 B7' },
    { top: 'G0' },
  );
  const before = room.deal.discard.length;
  assert.ok(C.markLeft(room, 3).ok);
  assert.equal(room.deal.phase, 'play', 'втроём партия продолжается');
  assert.ok(room.deal.quit.includes('3'));
  assert.deepEqual(hand(room, 3), [], 'карты ушли в сброс');
  assert.equal(room.deal.discard.length, before + 7);

  const two = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7' }, { top: 'G0' });
  assert.ok(C.markLeft(two, 2).ok);
  assert.equal(two.deal.phase, 'over');
  assert.equal(two.deal.aborted, true, 'вдвоём доигрывать не из чего');
  assert.equal(two.history.at(-1).aborted, true, 'и партия не засчитывается');
});

test('16а. ушёл тот, чей был ход — ход идёт дальше, партия не висит', () => {
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7', 3: 'B1 B2 B3 B4 B5 B6 B7', 4: 'Y1 Y2 Y3 Y4 Y5 Y6 Y7' },
    { top: 'G0' },
  );
  assert.equal(room.deal.turn, '2');
  assert.ok(C.markLeft(room, 2).ok);
  assert.equal(room.deal.phase, 'play');
  assert.equal(room.deal.turn, '3', 'ход перешёл следующему');
});

/* ---------------------------------------------------- 22–25. рука и экран */

test('22. рука отсортирована: цвета в заданном порядке, внутри по номиналу, бесцветные в конце', () => {
  const got = sortHand(['WF', 'B3', 'R9', 'GP', 'WC', 'YS', 'R0', 'GV', 'B1', 'RP', 'G5', 'Y2', 'RS']);
  assert.deepEqual(got, [
    'R0', 'R9', 'RS', 'RP', // красный: цифры по возрастанию, потом особые
    'Y2', 'YS',
    'G5', 'GV', 'GP',
    'B1', 'B3',
    'WC', 'WF', // бесцветные в самом конце
  ]);
  // Порядок цветов фиксирован и от содержимого руки не зависит.
  assert.deepEqual(sortHand(['B1', 'G1', 'Y1', 'R1']), ['R1', 'Y1', 'G1', 'B1']);
  assert.deepEqual(sortHand(['R1', 'Y1', 'G1', 'B1']), ['R1', 'Y1', 'G1', 'B1']);
});

test('22а. особые карты цвета идут после цифр: «стоп», «разворот», «+2»', () => {
  assert.deepEqual(sortHand(['RP', 'RV', 'RS', 'R9']), ['R9', 'RS', 'RV', 'RP']);
});

test('23. взял карту — порядок прежний, новая встала на своё место', () => {
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G3 G4 G5 G6 G7 G8', 3: 'B1 B3 B4 B5 B6 B7 B8' },
    { top: 'B2', deck: 'G2' },
  );
  const before = sortHand(hand(room, 2));
  assert.ok(draw(room, 2).ok);
  const after = sortHand(hand(room, 2));
  assert.equal(after.length, before.length + 1);
  assert.equal(after.indexOf('G2'), 1, 'двойка встала между единицей и тройкой');
  // Больше не переехало ничего: убрать новую — и получится прежняя рука.
  assert.deepEqual(after.filter((c) => c !== 'G2'), before);
});

test('24. чужой ход не меняет порядок моей руки', () => {
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7', 3: 'B1 B2 B3 B4 B5 B6 B7' },
    { top: 'G0' },
  );
  const mine = sortHand(hand(room, 1));
  assert.ok(play(room, 2, 'G1').ok);
  assert.ok(play(room, 3, 'B1').ok);
  assert.deepEqual(sortHand(hand(room, 1)), mine, 'моя рука не шелохнулась');
});

test('25. подняты ровно те карты, которые можно положить сейчас', () => {
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 R9 WC B5 Y5 G7 B8', 3: 'B1 B2 B3 B4 B6 B7 B9' },
    { top: 'G5' },
  );
  // Цвет зелёный, число 5. Подходят: зелёные, любые пятёрки и бесцветные.
  assert.deepEqual(C.legalFor(room, 2).play.sort(), ['B5', 'G1', 'G7', 'WC', 'Y5'].sort());
  // Не мой ход — не поднята ни одна.
  assert.deepEqual(C.legalFor(room, 3).play, []);
  assert.equal(C.legalFor(room, 3).myTurn, false);
});

test('25а. нечего положить — не поднята ни одна, и предложено брать', () => {
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G3 G4 G6 G7 G8 G9', 3: 'B1 B2 B3 B4 B6 B7 B9' },
    { top: 'B5' },
  );
  const L = C.legalFor(room, 2);
  assert.deepEqual(L.play, []);
  assert.equal(L.draw, true);
  assert.equal(L.drawCount, 1);
});

test('25б. висит «+2» — подняты только те, чем его кроют', () => {
  const room = table(
    { 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'GP G1 G2 G3 G4 G5 G6', 3: 'BP WF B3 B4 B5 B6 B7' },
    { top: 'G0', stacking: true },
  );
  assert.ok(play(room, 2, 'GP').ok);
  const L = C.legalFor(room, 3);
  assert.deepEqual(L.play.sort(), ['BP', 'WF'].sort(), 'только «+2» и «+4»');
  assert.equal(L.draw, true, 'а можно и просто взять');
  assert.equal(L.drawCount, 2, 'взять придётся две');
});

/* ------------------------------------------------------------- 27. фигуры */

test('27. у каждого цвета своя фигура — и выключателя для неё нет', () => {
  assert.deepEqual(COLOR_SHAPE, { R: 'circle', Y: 'triangle', G: 'square', B: 'diamond' });
  assert.equal(new Set(Object.values(COLOR_SHAPE)).size, 4, 'четыре разные фигуры');
  for (const c of COLORS) assert.ok(COLOR_SHAPE[c], `${c} без фигуры не остался`);
});

/* ---------------------------------------------------------- начало партии */

test('начало: по семь каждому, в сброс открыта цифра, первым ходит сосед сдающего', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7', 3: 'B1 B2 B3 B4 B5 B6 B7' }, { top: 'Y4' });
  const d = room.deal;
  assert.equal(Object.values(d.hands).every((x) => x.length === 7), true);
  assert.equal(d.top, 'Y4');
  assert.equal(d.color, 'Y');
  assert.equal(d.deck.length, 108 - 21 - 1);
  assert.equal(d.dealer, '1', 'первую сдаёт хост');
  assert.equal(d.turn, '2', 'ходит тот, кто слева от сдающего');
  assert.equal(d.dir, 1, 'по часовой');
});

test('начало: открылась особая — пачка тасуется, пока не выйдет цифра', () => {
  // Пачка, в которой на месте верхней лежит «стоп»: правила обязаны это
  // поправить сами, а не начинать партию с чужого «+4».
  const room = C.createRoom({ chatId: -1, host: { id: 1, name: 'А' } });
  C.addPlayer(room, { id: 2, name: 'Б' });
  const bad = () => {
    const d = freshDeck();
    const at = d.indexOf('RS');
    [d[14], d[at]] = [d[at], d[14]]; // 14 = HAND * 2 — место верхней карты
    return d;
  };
  assert.ok(C.startGame(room, 1, { deck: bad, randInt: colorsRandom(5) }).ok);
  assert.match(room.deal.top, /^[RYGB][0-9]$/, 'в сбросе цифра');
});

/* -------------------------------------------------------- хост и хранение */

test('настройки: накопление и таймер — только хост, и не посреди партии', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7' }, { top: 'G0' });
  assert.equal(C.updateSettings(room, 2, { stacking: false }).error, 'NOT_HOST');
  assert.equal(C.updateSettings(room, 1, { stacking: false }).error, 'DEAL_IN_PROGRESS');
  assert.ok(C.updateSettings(room, 1, { turnSeconds: 45 }).ok, 'таймер можно и на ходу');
  assert.equal(room.settings.turnSeconds, 45);
  assert.equal(C.updateSettings(room, 1, { turnSeconds: 5 }).ok, true);
  assert.equal(room.settings.turnSeconds, 15, 'меньше пятнадцати секунд не бывает');
});

test('сохранение и чтение: партия переживает перезапуск, окно «Радуги» — нет', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7', 3: 'B1 B2 B3 B4 B5 B6 B7' }, { top: 'G0' });
  room.deal.hands['2'] = ['G1', 'G2'];
  assert.ok(play(room, 2, 'G1', { now: 1000 }).ok);
  assert.ok(room.deal.call, 'окно открыто');
  C.updateSettings(room, 1, { turnSeconds: 30 });
  C.syncTurn(room, 1000);

  const back = C.deserialize(C.serialize(room, 11_000));
  assert.equal(back.game, 'colors');
  assert.deepEqual(back.deal.hands, room.deal.hands, 'руки на месте');
  assert.equal(back.deal.top, room.deal.top);
  assert.equal(back.deal.turn, room.deal.turn);
  assert.equal(back.turn.deadline, null);
  assert.equal(back.turn.remaining, 20_000, 'таймер — остатком: бот лежал, это не чьё-то время');
  assert.equal(back.deal.call, null, 'ловить за молчание, которого никто не видел, нечестно');
});

test('места для рейтинга: доигранная партия даёт порядок, прерванная — отказ', () => {
  const room = table({ 1: 'R1 R2 R3 R4 R5 R6 R7', 2: 'G1 G2 G3 G4 G5 G6 G7' }, { top: 'G0' });
  room.deal.hands['2'] = ['G1'];
  assert.ok(play(room, 2, 'G1').ok);
  assert.deepEqual(room.history.at(-1), { no: 1, loser: '1', aborted: false, out: ['2', '1'], quit: [] });
  assert.ok(C.abortGame(room, 1).error, 'партия уже кончилась');
});
