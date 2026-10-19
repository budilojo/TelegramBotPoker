'use strict';
/**
 * Покерный стол: блайнды растут, суммы по сетке, Fold есть всегда.
 *
 *   РОСТ. Новый стол — с растущими блайндами (лесенка от стартовых, раз в 15
 *   минут). Хозяин может выключить рост или поменять блайнды руками — тогда
 *   лесенка строится заново от его чисел.
 *
 *   СЕТКА. Предлагаемые суммы — кратные малому блайнду (25, 50, 75, 100…),
 *   а не 137; края (минимум, весь стек) остаются как есть.
 *
 *   FOLD. Сбросить карты можно и тогда, когда можно бесплатно сказать Check:
 *   сервер это принимает (страница просит второго нажатия — это её дело).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { createRoom, addPlayer, startGame } from './room.js';
import { presets } from './view.js';
import { legalActions } from '../server/game.js';

const CAST = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') });

/** Часы уровней идут по `Date.now()`: переводим их на `min` минут вперёд. */
async function withClock(min, fn) {
  const real = Date.now;
  Date.now = () => real() + min * 60_000;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

test('новый стол — с растущими блайндами: 25/50 → 50/100 через 15 минут, со следующей раздачи', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  assert.equal(t.room.settings.blindMode, 'levels', 'рост включён по умолчанию');
  assert.equal(t.room.settings.levelMinutes, 15);
  assert.equal(t.state(cast.max).room.level, 1);
  await t.runToShowdown(cast);
  await withClock(16, async () => {
    await t.send(cast.max, { t: 'next' });
  });
  assert.equal(t.room.settings.bigBlind, 100, 'через 15 минут блайнды 50/100');
  assert.equal(t.room.settings.smallBlind, 50);
  assert.equal(t.state(cast.max).room.level, 2);
});

test('внутри раздачи блайнды не меняются, даже когда уровень истёк', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  await withClock(60, async () => {
    await t.send(t.actorOf(cast), { t: 'act', action: 'call', seq: t.room.seq });
  });
  assert.equal(t.room.settings.bigBlind, 50, 'раздача доиграна по старым блайндам');
});

test('хозяин выключил рост — блайнды стоят; поменял руками при росте — лесенка от его чисел', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  await t.send(cast.ivan, { t: 'settings', blindMode: 'fixed' });
  assert.equal(t.room.settings.blindMode, 'fixed');
  await t.runToShowdown(cast);
  await withClock(120, async () => {
    await t.send(cast.max, { t: 'next' });
  });
  assert.equal(t.room.settings.bigBlind, 50, 'рост выключен — блайнды те же');

  await t.send(cast.ivan, { t: 'settings', blindMode: 'levels', smallBlind: 100, bigBlind: 200 });
  assert.deepEqual(t.room.pendingBlinds, { sb: 100, bb: 200 }, 'новые блайнды — со следующей раздачи');
  assert.deepEqual(t.room.settings.schedule[1], { sb: 200, bb: 400 }, 'лесенка — от 100/200');
  assert.equal(t.room.level.index, 0);

  // Рост уже включён, блайнды правят руками ещё раз — лесенка снова от новых чисел.
  await t.send(cast.ivan, { t: 'settings', smallBlind: 300, bigBlind: 600 });
  assert.deepEqual(t.room.pendingBlinds, { sb: 300, bb: 600 });
  assert.deepEqual(t.room.settings.schedule[1], { sb: 600, bb: 1200 }, 'лесенка перестроена от 300/600');
});

test('настройка роста приходит со страницы как есть, мусор — нет', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  await t.send(cast.ivan, { t: 'settings', blindMode: 'вечно', levelMinutes: 'много' });
  assert.equal(t.room.settings.blindMode, 'levels', 'неизвестный режим игнорируется');
  assert.equal(t.room.settings.levelMinutes, 15);
  await t.send(cast.ivan, { t: 'settings', levelMinutes: 30 });
  assert.equal(t.room.settings.levelMinutes, 30);
  await t.send(cast.max, { t: 'settings', blindMode: 'fixed' });
  assert.equal(t.lastError(cast.max).code, 'NOT_HOST', 'настройки — только хозяину');
  assert.equal(t.room.settings.blindMode, 'levels');
});

test('суммы ставок — по сетке малого блайнда, при любых блайндах', () => {
  for (const [sb, bb] of [[25, 50], [50, 100], [75, 150], [10, 20], [250, 500], [100, 200]]) {
    const room = createRoom({ chatId: -9, host: { id: 1, name: 'А' }, startingStack: bb * 200, smallBlind: sb, bigBlind: bb });
    for (const [id, name] of [[2, 'Б'], [3, 'В']]) addPlayer(room, { id, name });
    startGame(room, '1');
    const l = legalActions(room, room.hand.actorId);
    const list = presets(room, l);
    assert.ok(list.length >= 2, `блайнды ${sb}/${bb}: есть что предложить`);
    for (const p of list) {
      if (p.kind === 'allin' || p.total === l.minTotal) continue; // края — как есть
      assert.equal(p.total % sb, 0, `блайнды ${sb}/${bb}: «${p.label}» = ${p.total} не кратно ${sb}`);
    }
  }
});

test('Fold принимается, и когда можно бесплатно сказать Check', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  // Доводим до большого блайнда: все до него уравняли, у него Check бесплатный.
  for (let i = 0; i < 5; i++) {
    const id = t.room.hand.actorId;
    const l = legalActions(t.room, id);
    if (l.canCheck) break;
    await t.send(t.actorOf(cast), { t: 'act', action: 'call', seq: t.room.seq });
  }
  const id = t.room.hand.actorId;
  assert.ok(legalActions(t.room, id).canCheck, 'Check бесплатный');
  const actor = t.actorOf(cast);
  await t.send(actor, { t: 'act', action: 'fold', seq: t.room.seq });
  assert.equal(t.lastError(actor), null, 'сервер не возражает');
  assert.equal(t.room.players.find((p) => p.id === id).folded, true, 'карты сброшены');
});
