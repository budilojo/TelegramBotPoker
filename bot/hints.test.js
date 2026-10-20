'use strict';
/**
 * Подсказки выключены у всех (bot/hints.js). Проверяется не «функция вернула
 * null», а то, что игрок получил на телефон: ни имени собранной руки за столом,
 * ни совета наставника, ни «шанса выиграть» — за всю раздачу, а не в одном кадре.
 * И что включение возвращает их (на это рассчитана будущая настройка).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, botRandom } from './harness.js';
import { hints } from './hints.js';

const IVAN = user(101, 'Иван');

async function solo(t, settings) {
  await t.start(IVAN);
  t.openSolo(IVAN);
  await t.send(IVAN, { t: 'play', game: 'poker', settings });
  return t.app.soloOf('101');
}

/** Всё, что телефон получил за N ходов: сбрасываем, пока можно, иначе — чек/колл. */
async function playHands(t, room, steps = 120) {
  for (let i = 0; i < steps && room.status !== 'finished'; i++) {
    const s = t.state(IVAN);
    if (s.legal) await t.send(IVAN, { t: 'act', action: s.legal.canCheck ? 'check' : s.legal.toCall <= 200 ? 'call' : 'fold', seq: s.seq });
    else if (s.hand?.phase === 'complete' && s.canNext) await t.send(IVAN, { t: 'next' });
    else await t.advance(2_500);
  }
}

/** Кадры со столом (без экрана выбора игры). */
const frames = (t) => t.page(IVAN).inbox.filter((m) => m.t === 'state' && m.state.me && m.state.room).map((m) => m.state);

test('по умолчанию подсказки выключены', () => {
  assert.equal(hints.on, false);
});

test('покер с ботами: за всю партию у игрока нет имени своей руки на столе', async () => {
  const t = new Table({ botRng: botRandom(5) });
  const room = await solo(t, { opponents: 3, level: 1 });
  await playHands(t, room);
  const fs = frames(t);
  assert.ok(fs.length > 20, `кадров: ${fs.length}`);
  for (const s of fs) assert.equal(s.me.handName, null, 'имя собранной руки — подсказка, её нет');
  t.app.stop();
});

test('школа: свободная игра и уроки без советов и шанса выиграть', async () => {
  const t = new Table({ botRng: botRandom(6) });
  await t.start(IVAN);
  t.openSolo(IVAN);
  await t.send(IVAN, { t: 'play', game: 'poker', settings: { learn: true, lesson: 6 } }); // 6 = свободная игра (после шести уроков)
  const room = t.app.soloOf('101');
  assert.ok(room?.learn, 'это школа');
  for (let i = 0; i < 12; i++) {
    const s = t.state(IVAN);
    if (s.legal) await t.send(IVAN, { t: 'act', action: s.legal.canCheck ? 'check' : 'fold', seq: s.seq });
    else await t.advance(2_500);
  }
  const json = JSON.stringify(frames(t));
  assert.ok(frames(t).some((s) => s.legal), 'человеку приходилось ходить');
  for (const s of frames(t)) assert.equal(s.learn.tip, null, 'совета на ходу нет');
  assert.ok(!/Шанс выиграть|Совет:|колл в плюс|ставьте, пусть/.test(json), 'ни шанса, ни совета в тексте');
  assert.ok(frames(t).every((s) => !/подсказывает/.test(s.learn.goal)), 'цель не обещает подсказок');
  t.app.stop();
});

test('если включить — подсказки возвращаются (будущая настройка)', async () => {
  hints.on = true;
  try {
    const t = new Table({ botRng: botRandom(5) });
    const room = await solo(t, { opponents: 3, level: 1 });
    await playHands(t, room, 80);
    assert.ok(frames(t).some((s) => s.me.handName), 'имя руки пришло');
    t.app.stop();
  } finally {
    hints.on = false;
  }
});
