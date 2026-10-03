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

/* ------------------------------------- группа умерла под открытым экраном */

import { RATING_SOON_TEXT } from './app.js';

/** Человек в двух группах, смотрит хаб первой. */
async function twoGroups(t) {
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/play');
  await t.app.handleUpdate({
    message: {
      message_id: t.tg.nextId++, date: t.date, chat: { id: -4002, type: 'supergroup', title: 'Вторая' },
      from: { id: 101, first_name: 'Иван' }, text: '/play',
    },
  });
  await t.app.settle();
  assert.equal(t.app.groupsOf(101).length, 2, 'групп две');
  t.openHub(ivan);
  assert.equal(t.state(ivan).kind, 'hub');
  return ivan;
}

test('бота выгнали из группы — человека уводят к своим группам, а не бросают', async () => {
  const t = new Table({ chatId: -4001 });
  const ivan = await twoGroups(t);
  // Со столом: его тоже должно снести, и в памяти, и в базе.
  await t.send(ivan, { t: 'create', game: 'durak' });
  assert.equal(t.app.roomsOf(t.chatId).length, 1);

  // Настоящий путь: Telegram говорит, что бота выгнали.
  await t.raw({
    my_chat_member: {
      chat: { id: t.chatId, type: 'supergroup' }, from: { id: 999 }, date: t.date,
      old_chat_member: { status: 'member', user: { id: 1, is_bot: true, username: 'ChipTableBot' } },
      new_chat_member: { status: 'kicked', user: { id: 1, is_bot: true, username: 'ChipTableBot' } },
    },
  });

  assert.equal(t.app.roomsOf(t.chatId).length, 0, 'столы группы снесены');
  assert.equal(t.app.groups.get(String(t.chatId)), undefined, 'и сама группа');

  // Экран сменился сам, без единого нажатия: смотреть на хаб мёртвой группы
  // не на что, а вторая группа у человека осталась.
  const s = t.state(ivan);
  assert.equal(s.kind, 'home', 'страницу увели на «Мои группы»');
  assert.ok(s.groups.some((g) => g.title === 'Вторая'), 'и вторая группа в списке — человеку есть куда идти');

  // Главное. Список, который УВИДЕЛА страница, не должен содержать группу, из
  // которой человека только что выгнали: нажми на неё — и получишь отказ.
  // Снимок берётся во время разборки, и легко взять его на шаг раньше, чем
  // разборка кончилась.
  assert.equal(s.groups.some((g) => g.title === 'Покер по пятницам'), false,
    'мёртвой группы в списке нет');
  assert.deepEqual(t.app.groupsOf(101).map((g) => g.title), ['Вторая'], 'и сервер того же мнения');
});

test('на хабе мёртвой группы ни одна кнопка не остаётся без ответа', async () => {
  const t = new Table({ chatId: -4003 });
  const ivan = await twoGroups(t);
  // Группа пропала, а страница об этом ещё не знает (её не успели увести).
  t.app.groups.delete(String(t.chatId));

  for (const msg of [{ t: 'refresh' }, { t: 'create', game: 'durak' }, { t: 'home' }]) {
    const before = t.page(ivan).inbox.length;
    await t.send(ivan, msg);
    const got = t.page(ivan).inbox.slice(before);
    // Ответ обязан быть любой: состояние или объяснённый отказ. Молчание —
    // единственное, чего быть не может: страница от него выглядит зависшей.
    assert.ok(got.length, `на «${msg.t}» страница не получила НИЧЕГО — она выглядит зависшей`);
    for (const m of got) {
      if (m.t === 'error') assert.match(m.text, /[а-яА-Я]/, `отказ на «${msg.t}» без слов`);
    }
  }
  assert.equal(t.state(ivan).kind, 'home', 'и в итоге человек на экране, с которого есть выход');
});

test('закрытый рейтинг объясняется одинаково на обоих экранах', async () => {
  const t = new Table({ chatId: -4004 });
  const ivan = await twoGroups(t);
  assert.equal(t.state(ivan).ratingSoon, RATING_SOON_TEXT, 'на хабе группы — словами');

  // На «Мои группы» человек попадает, открыв приложение из лички: групп у
  // него две, и сразу в хаб его не уводят.
  t.close(ivan);
  t.open(ivan, {});
  assert.equal(t.state(ivan).kind, 'home');
  assert.equal(t.state(ivan).ratingSoon, RATING_SOON_TEXT, 'и на «Моих группах» — теми же словами');
});
