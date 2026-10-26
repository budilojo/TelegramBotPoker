'use strict';
/**
 * Журнал решений не уходит никому, кроме самого игрока (проверка K, волна 3).
 * «Что получил каждый телефон» за раздачу: ни одного следа журнала и оценки решений
 * (поля таблицы `decision_log`, вердикты, слова «журнал»), ни у себя, ни у соседей, пока
 * человек не спросил свой «train/history» сам; подсказок во время партии нет (решение 016).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { NullStore } from './store.js';
import { hints } from './hints.js';

const CAST = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') });
const TRACES = ['decision_log', 'hand_key', 'to_call', '"verdict"', '"doubtful"', '"journal"', 'placement', '"train"'];

test('журнал решений: за раздачу ни один телефон не получает его следов, а подсказок нет', async () => {
  assert.equal(hints.on, false, 'подсказки в партии выключены (решение 016)');
  const store = new NullStore();
  const cast = CAST();
  const t = new Table({ store });
  await t.begin(cast);
  let guard = 0;
  while (t.room.hand?.phase === 'betting' && guard++ < 40) {
    const who = t.actorOf(cast);
    if (!who) break;
    const l = t.state(who).legal;
    await t.act(who, l?.canCheck ? 'check' : 'call');
  }
  assert.ok(store.decisionsOf(cast.ivan.id).length + store.decisionsOf(cast.max.id).length + store.decisionsOf(cast.dima.id).length >= 3, 'журнал не пуст — проверка не пустая');
  for (const u of Object.values(cast)) {
    const all = JSON.stringify(t.page(u).inbox);
    for (const trace of TRACES) assert.ok(!all.includes(trace), `у ${u.first_name} в сообщениях стола есть след журнала: ${trace}`);
    assert.ok(!/"(equity|strength)"/.test(all), `у ${u.first_name} в сообщениях стола есть оценка силы руки (подсказка)`);
  }
});
