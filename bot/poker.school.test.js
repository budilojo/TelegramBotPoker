'use strict';
/**
 * «Школа покера» (режим «Обучение» в форме покера с ботами): уроки против
 * наставника и свободная игра.
 *
 *   УРОК ПРОХОДИТСЯ ПО ПОДСКАЗКАМ. Кто делает то, что советует наставник, —
 *   проходит каждый урок; кто играет наоборот — получает объяснение, почему нет.
 *
 *   ЧЕСТНО. Карты наставника человек не видит до вскрытия ни в одном
 *   сообщении; подсказка говорит только о своих картах и борде.
 *
 *   ПОДСТРОЕННЫЕ КАРТЫ — ВСЕГДА ТЕ ЖЕ. Где бы ни стояла кнопка, у человека
 *   карты урока.
 */
import { hints } from './hints.js';

// Подсказки выключены у всех (bot/hints.js), но механизм остаётся — его и проверяем: этот файл включает их у себя.
hints.on = true;
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, botRandom } from './harness.js';
import * as S from './games/poker/school.js';

const IVAN = user(101, 'Иван');
const CARD = /"((?:[2-9]|10|J|Q|K|A)[SHDC])"/g;

async function school(t, lesson = 0) {
  await t.start(IVAN);
  t.openSolo(IVAN);
  await t.send(IVAN, { t: 'play', game: 'poker', settings: { learn: true, lesson } });
  return t.app.soloOf('101');
}

/** Сделать то, что советует наставник. */
function follow(s) {
  const l = s.legal;
  const a = s.learn.tip.advice;
  if (a === 'bet' || a === 'raise') {
    const amount = Math.min(l.maxTotal, Math.max(l.minTotal, Math.round(l.currentBet + (l.potTotal + l.toCall) * 0.5)));
    return { action: l.canBet ? 'bet' : 'raise', amount };
  }
  if (a === 'call') return { action: l.canCall ? 'call' : 'check' };
  if (a === 'check') return { action: 'check' };
  return { action: 'fold' };
}

/** Чек или колл всегда — «пассивный» человек. */
const passive = (s) => ({ action: s.legal.canCheck ? 'check' : 'call' });
const folding = (s) => ({ action: s.legal.canCheck ? 'check' : 'fold' });

/** Сыграть раздачу урока до итога. */
async function playLesson(t, room, how, steps = 200) {
  for (let i = 0; i < steps; i++) {
    const s = t.state(IVAN);
    if (s.learn?.result) return s.learn.result;
    if (s.legal) await t.send(IVAN, { t: 'act', ...how(s), seq: s.seq });
    else await t.advance(2_500);
  }
  assert.fail(`урок ${room.learn.lesson} не закончился`);
}

test('школа в форме покера с ботами: шесть уроков', async () => {
  const t = new Table();
  t.openSolo(IVAN);
  const poker = t.state(IVAN).games.find((g) => g.id === 'poker');
  assert.equal(poker.catalog.school.length, S.LESSONS.length);
  assert.equal(S.LESSONS.length, 6);
  for (const l of poker.catalog.school) assert.ok(l.title && l.goal);
});

test('по подсказкам наставника проходятся все уроки подряд, потом — свободная игра', async () => {
  const t = new Table({ botRng: botRandom(1) });
  const room = await school(t, 0);
  assert.equal(room.players.length, 2);
  assert.equal(room.players[1].name, 'Наставник');
  for (let k = 0; k < S.LESSONS.length; k++) {
    const s = t.state(IVAN);
    assert.equal(s.learn.lesson, k);
    assert.equal(s.learn.title, S.LESSONS[k].title);
    // Карты урока — у человека, как бы ни стояла кнопка.
    const mine = S.LESSONS[k].holes.me.toUpperCase().split(' ');
    assert.deepEqual([...s.me.cards].sort(), mine.sort(), `карты урока ${k}`);
    const r = await playLesson(t, room, follow);
    assert.equal(r.ok, true, `урок «${S.LESSONS[k].title}»: ${r.text}`);
    assert.equal(t.state(IVAN).canNext, false, 'после урока — «Дальше», а не просто раздача');
    await t.send(IVAN, { t: 'learn', step: 'next' });
  }
  const s = t.state(IVAN);
  assert.equal(s.learn.lesson, S.FREE);
  assert.equal(s.learn.title, 'Свободная игра');
  // Свободная игра: подсказка с живым расчётом на каждом ходу.
  for (let i = 0; i < 20 && !t.state(IVAN).legal; i++) await t.advance(2_500);
  const tip = t.state(IVAN).learn.tip;
  assert.ok(tip, 'подсказка есть');
  assert.match(tip.text, /Шанс выиграть .*≈ \d+%/);
  assert.deepEqual(t.errors, []);
});

test('урок без нужного действия не засчитан — и сказано почему', async () => {
  const cases = [
    [0, passive, /ни разу не поставили/],
    [1, passive, /рисковали|поздно/],
    [3, folding, /уравнивают/],
    [4, passive, /Дорого|не на флопе/],
    [5, passive, /можно было забрать его ставкой/],
  ];
  for (const [lesson, how, why] of cases) {
    const t = new Table({ botRng: botRandom(lesson + 3) });
    const room = await school(t, lesson);
    const r = await playLesson(t, room, how);
    assert.equal(r.ok, false, `урок ${lesson} не должен засчитаться`);
    assert.match(r.text, why);
    // «Ещё раз» — тот же урок, стеки снова полные.
    await t.send(IVAN, { t: 'learn', step: 'retry' });
    const s = t.state(IVAN);
    assert.equal(s.learn.lesson, lesson);
    assert.equal(s.learn.result, null);
    assert.equal(room.players.reduce((n, p) => n + p.stack + (p.committed || 0), 0), 20_000, 'фишки на месте');
  }
});

test('карты наставника человек не видит: ни в столе, ни в подсказках — до вскрытия', async () => {
  const t = new Table({ botRng: botRandom(5) });
  const room = await school(t, 0);
  for (let k = 0; k < S.LESSONS.length; k++) {
    await playLesson(t, room, follow);
    await t.send(IVAN, { t: 'learn', step: 'next' });
  }
  for (const m of t.page(IVAN).inbox.filter((x) => x.t === 'state' && x.state.game === 'poker')) {
    const s = m.state;
    const hand = s.hand;
    if (!hand || hand.phase === 'complete') continue;
    const allowed = new Set([...(s.me.cards || []), ...(hand.board || [])]);
    for (const [, c] of JSON.stringify(s).matchAll(CARD)) assert.ok(allowed.has(c), `до вскрытия пришла чужая карта ${c}`);
    for (const p of s.players.filter((x) => !x.isMe)) assert.equal(p.cards, null);
  }
});

test('подсказка свободной игры — из своих карт: тузы — повышать, 7-2 против ставки в банк — сбросить', () => {
  const view = (cards, board, legal) => ({
    seq: 3, me: { cards, handName: null }, hand: { board },
    players: [{ isMe: true, inHand: true }, { isMe: false, inHand: true, folded: false }],
    legal,
  });
  const open = { toCall: 0, canCheck: true, canCall: false, canBet: true, canRaise: false, minTotal: 100, maxTotal: 10000, potTotal: 150, currentBet: 0, myBet: 0, stack: 10000 };
  const aces = S.liveTip(view(['AS', 'AH'], [], open));
  assert.equal(aces.advice, 'bet');
  assert.ok(aces.equity > 80);
  const facing = { ...open, toCall: 1000, canCheck: false, canCall: true, canBet: false, canRaise: true, potTotal: 1000 };
  const trash = S.liveTip(view(['7C', '2D'], ['KS', 'QH', '9D'], facing));
  assert.equal(trash.advice, 'fold');
  assert.match(trash.text, /колл в минус/);
});

test('человек не может вызвать урок за чужим столом и не может «Дальше» посреди раздачи', async () => {
  const t = new Table({ botRng: botRandom(2) });
  const room = await school(t, 2);
  for (let i = 0; i < 10 && !t.state(IVAN).legal; i++) await t.advance(2_500);
  assert.ok(room.hand.phase !== 'complete');
  await t.send(IVAN, { t: 'learn', step: 'next' });
  assert.equal(t.lastError(IVAN).code, 'HAND_IN_PROGRESS');
  assert.equal(room.learn.lesson, 2);
  // Обычный покер с ботами: «урок» — не его действие.
  const t2 = new Table({ botRng: botRandom(2) });
  await t2.start(IVAN);
  t2.openSolo(IVAN);
  await t2.send(IVAN, { t: 'play', game: 'poker', settings: { opponents: 2 } });
  await t2.send(IVAN, { t: 'learn', step: 'next' });
  assert.equal(t2.lastError(IVAN).code, 'BAD_REQUEST');
});
