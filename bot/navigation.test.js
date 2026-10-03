'use strict';
/**
 * Пути назад: с любого экрана человек должен иметь выход.
 *
 * Самое дорогое здесь — не «кнопка не той ширины», а дверь, которая
 * закрылась за человеком тихо. Телефон теряет связь по десять раз на дню,
 * и страница переподключается сама; если после этого пропадает выход из
 * комнаты, человек об этом узнаёт, только упёршись в него.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, initDataFor } from './harness.js';

test('обрыв связи за столом не отрезает путь в хаб группы', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/game');

  // Приложение открыто из лички, без start_param: группа одна, и человека
  // пускают сразу в её хаб. Оттуда он создаёт стол.
  t.open(ivan, { initData: initDataFor(ivan, { clock: t.clock }) });
  assert.equal(t.state(ivan).kind, 'hub');
  await t.send(ivan, { t: 'create', game: 'durak' });
  const code = t.durak.code;
  assert.equal(t.state(ivan).hub, true, 'из хаба пришли — выход предложен');

  // Связь мигнула. Страница переподключается тем, что у неё есть: той же
  // подписью без start_param и кодом комнаты, в которой она была.
  t.close(ivan);
  t.open(ivan, { initData: initDataFor(ivan, { clock: t.clock }), room: code });
  const s = t.state(ivan);
  assert.equal(s.room.code, code, 'вернулись за тот же стол');
  assert.equal(s.hub, true, 'и выход никуда не делся');

  await t.send(ivan, { t: 'hub' });
  assert.equal(t.state(ivan).kind, 'hub', 'и он работает');
});

test('по чужой ссылке на стол группа не достаётся — выхода в её хаб нет', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/game');
  t.open(ivan, { initData: initDataFor(ivan, { clock: t.clock }) });
  await t.send(ivan, { t: 'create', game: 'durak' });
  const room = t.durak;

  // Посторонний получил ссылку на стол из чужой группы. Стол ему открыт —
  // так и задумано. А игры группы — нет: он в ней не состоит.
  const stranger = user(777, 'Прохожий');
  t.open(stranger, { initData: initDataFor(stranger, { startParam: room.code, clock: t.clock }) });
  assert.equal(t.state(stranger).room.code, room.code, 'стол открылся');
  assert.notEqual(t.state(stranger).hub, true, 'а выхода в чужой хаб ему не предлагают');
  await t.send(stranger, { t: 'hub' });
  assert.equal(t.lastError(stranger).code, 'NOT_FROM_HUB', 'и попросить его нельзя');
});
