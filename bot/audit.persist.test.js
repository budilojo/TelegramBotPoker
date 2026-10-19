'use strict';
/**
 * Аудит E-03: ход сохраняется в базу сразу, а не «когда Telegram примет
 * карточку».
 *
 * Стол писался в базу внутри перерисовки карточки группы — после ответа
 * Telegram. Если карточка менялась, а Telegram отвечал ошибкой (у бота
 * отняли право писать в группе, сбой сети, 400), сохранение пропускалось
 * совсем — и перезапуск откатывал партию к последней удачной перерисовке.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { Store } from './store.js';
import { TelegramError } from './tg-stub.js';

const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };

test('АУДИТ E-03: покер — Telegram не принимает карточку, бот перезапустился: сыгранное не откатилось', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store });
  await t.begin(cast, { blinds: [25, 50] });
  const room = t.room;
  const fail = async () => {
    throw new TelegramError('Bad Request: not enough rights to send text messages to the chat');
  };
  t.tg.editMessageText = fail;
  t.tg.sendMessage = fail;
  // Префлоп доигран: колл и чек — на столе флоп, карточка поменялась.
  for (let i = 0; i < 4 && room.hand.street === 'preflop'; i++) {
    const who = t.actorOf(cast);
    const l = t.state(who).legal;
    await t.act(who, l.canCheck ? 'check' : 'call');
  }
  assert.equal(room.hand.street, 'flop', 'на столе флоп');

  const t2 = new Table({ store, clock: t.clock });
  t2.app.load();
  const back = t2.app.roomByCode(room.code);
  assert.equal(back.hand.street, 'flop', 'после перезапуска — тот же флоп, а не префлоп');
  assert.deepEqual(back.hand.board, room.hand.board);
});
