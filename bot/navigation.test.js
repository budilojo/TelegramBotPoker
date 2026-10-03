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

/* ------------------------------------------- один запрет — одно объяснение */

import { MAX_LIVE_PER_GROUP, TOO_MANY_GAMES_TEXT } from './app.js';

/** Набить группу до предела: по лобби от разных людей. */
async function fillGroup(t) {
  for (let i = 0; i < MAX_LIVE_PER_GROUP; i++) {
    const u = user(200 + i, `Хост${i}`);
    await t.cmd(u, '/play');
    t.openHub(u);
    await t.send(u, { t: 'create', game: 'durak' });
  }
  assert.equal(t.app.liveRooms(t.chatId).length, MAX_LIVE_PER_GROUP, 'предел набран');
}

test('предел игр в группе одинаков для обеих дверей — кнопки и команды', async () => {
  const t = new Table();
  await fillGroup(t);

  // Дверь первая: кнопка в приложении.
  const extra = user(300, 'Лишний');
  await t.cmd(extra, '/play');
  t.openHub(extra);
  await t.send(extra, { t: 'create', game: 'durak' });
  assert.equal(t.lastError(extra).code, 'TOO_MANY_GAMES');
  assert.equal(t.app.liveRooms(t.chatId).length, MAX_LIVE_PER_GROUP, 'через хаб не пустило');

  // Дверь вторая: команда в чате. Раньше она проходила мимо предела.
  await t.cmd(extra, '/newgame');
  assert.equal(t.app.liveRooms(t.chatId).length, MAX_LIVE_PER_GROUP, 'и через команду тоже не пустило');

  // И объяснение одно и то же, слово в слово: человек не должен гадать, два
  // это разных правила или одно.
  assert.equal(t.lastPost(), TOO_MANY_GAMES_TEXT, 'команда отвечает теми же словами');
  assert.equal(t.lastError(extra).text, TOO_MANY_GAMES_TEXT, 'и приложение — ими же');
});

test('пока предел не набран, /newgame работает как работал', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/newgame');
  assert.equal(t.app.liveRooms(t.chatId).length, 1, 'стол создан');
  assert.match(t.text(), /Покерная комната|Покер/, 'и это покер');
});
