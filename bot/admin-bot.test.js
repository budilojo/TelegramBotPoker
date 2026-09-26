'use strict';
/**
 * Админ-бот: второй бот, который знает про игру всё — и отвечает только своим.
 *
 * Что тут проверяется:
 *   — белый список: посторонний не получает ни ответа, ни намёка, что бот жив;
 *   — в ответах нет ни одной карты и ни одного имени игрока;
 *   — `/stop` завершает игру по коду, и игроки видят обычные итоги;
 *   — подпись админ-бота открывает в приложении ровно один экран — админку;
 *   — письма об ошибках склеиваются, а не заливают личку.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, initDataFor, durakStack, ADMIN_TEST_TOKEN } from './harness.js';
import { Store } from './store.js';
import { ERROR_QUIET_MS } from './admin-bot.js';

const THREE = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') });
const withStats = (opts = {}) => new Table({ store: new Store(':memory:'), admins: ['101'], ...opts });

/** Живая игра в дурака с известными руками — чтобы искать утечки карт. */
async function durakGame(t, cast) {
  t.useDurakDeck(durakStack({ 202: '6D 7S 8S 9S 10S JS', 303: '7H 8H 9H 10H JH QH', 101: '7C 8C 9C 10C JC QC' }, { trump: 'AD' }));
  await t.cmd(cast.ivan, '/game');
  t.openHub(cast.ivan);
  await t.send(cast.ivan, { t: 'create', game: 'durak' });
  const room = t.durak;
  for (const u of [cast.max, cast.dima]) {
    t.openRoom(u, room);
    await t.send(u, { t: 'sit' });
  }
  await t.send(cast.ivan, { t: 'start' });
  return room;
}

/* ----------------------------------------------------------- белый список */

test('посторонний не получает от админ-бота ничего — даже отказа', async () => {
  const t = withStats();
  const max = user(202, 'Макс');
  await t.admin(max, '/stats');
  await t.admin(max, '/now');
  await t.admin(max, 'привет');
  assert.equal(t.lastAdmin(max), null, 'ни одного сообщения: бот для него как будто не существует');
  t.app.store.close();
});

test('свой получает справку на что угодно и цифры на /stats', async () => {
  const t = withStats();
  const ivan = user(101, 'Иван');
  await t.admin(ivan, 'привет');
  assert.match(t.lastAdmin(ivan), /Админка/);
  assert.match(t.lastAdmin(ivan), /\/stop/, 'в справке перечислены команды');

  await t.admin(ivan, '/stats');
  assert.match(t.lastAdmin(ivan), /Цифры/);
  const m = [...t.adminTg.messages.values()].at(-1);
  assert.deepEqual(m.markup.inline_keyboard[0][0].web_app, { url: 'https://poker.example/?room=admin' },
    'и кнопка на экран с графиками');
  t.app.store.close();
});

test('без списка админов админ-бот не отвечает никому', async () => {
  const t = new Table({ store: new Store(':memory:') });
  await t.admin(user(101, 'Иван'), '/stats');
  assert.equal(t.lastAdmin(user(101, 'Иван')), null);
  t.app.store.close();
});

test('в группе админ-бот молчит: его команды только для лички', async () => {
  const t = withStats();
  const ivan = user(101, 'Иван');
  await t.adminBot.handleUpdate({
    update_id: 1,
    message: { message_id: 1, chat: { id: -100500, type: 'supergroup', title: 'Группа' }, from: ivan, text: '/stats' },
  });
  assert.equal(t.lastAdmin(ivan), null);
  t.app.store.close();
});

/* ------------------------------------------------------------------ цифры */

test('цифры в личке — те же, что на экране, и настоящие', async () => {
  const cast = THREE();
  const t = withStats();
  await durakGame(t, cast);
  await t.admin(cast.ivan, '/stats');
  const said = t.lastAdmin(cast.ivan);
  assert.match(said, /Всего: 3/, 'трое открывали приложение');
  assert.match(said, /durak: 1 партий/);
  assert.match(said, /игр идёт: 1/);
  t.app.store.close();
});

test('/now показывает, что идёт, и чем это завершить', async () => {
  const cast = THREE();
  const t = withStats();
  const room = await durakGame(t, cast);
  await t.admin(cast.ivan, '/now');
  const said = t.lastAdmin(cast.ivan);
  assert.match(said, /Идут: 1/);
  assert.match(said, /Дурак/);
  assert.ok(said.includes(room.code), 'код нужен: им и завершают');
  assert.match(said, /\/stop/);
  t.app.store.close();
});

test('когда никто не играет, так и сказано', async () => {
  const t = withStats();
  await t.admin(user(101, 'Иван'), '/now');
  assert.match(t.lastAdmin(user(101, 'Иван')), /никто не играет/);
  t.app.store.close();
});

test('ни в одном ответе админ-боту нет ни карты, ни имени игрока', async () => {
  const cast = THREE();
  const t = withStats();
  const room = await durakGame(t, cast);
  for (const c of ['/stats', '/now', '/health', 'привет']) await t.admin(cast.ivan, c);
  const all = t.adminSaid(cast.ivan);
  for (const name of ['Макс', 'Дима']) assert.ok(!all.includes(name), `в личке админа есть имя ${name}`);
  for (const card of Object.values(room.deal.hands).flat()) {
    assert.ok(!all.includes(card), `в личке админа есть карта ${card}`);
  }
  for (const card of room.deal.discard.flat()) assert.ok(!all.includes(card), 'сброс тем более закрыт');
  t.app.store.close();
});

test('/health говорит, жив ли бот, и не выдаёт токена', async () => {
  const t = withStats();
  const ivan = user(101, 'Иван');
  await t.admin(ivan, '/health');
  const said = t.lastAdmin(ivan);
  assert.match(said, /Бот жив/);
  assert.match(said, /Память/);
  assert.ok(!/\d{6,}:/.test(said), 'токен в ответе искать нечего');
  t.app.store.close();
});

/* ------------------------------------------------------------------- /stop */

test('/stop завершает игру по коду, и в группу уходят итоги', async () => {
  const cast = THREE();
  const t = withStats();
  const room = await durakGame(t, cast);
  await t.admin(cast.ivan, `/stop ${room.code}`);
  assert.equal(room.status, 'finished');
  assert.match(t.lastAdmin(cast.ivan), /завершена/);
  assert.match(t.lastPost(), /ИТОГИ · ДУРАК/, 'игроки видят итоги, а не пропавший стол');
  t.app.store.close();
});

test('/stop без кода и с чужим кодом ничего не ломает', async () => {
  const cast = THREE();
  const t = withStats();
  const room = await durakGame(t, cast);
  await t.admin(cast.ivan, '/stop');
  assert.match(t.lastAdmin(cast.ivan), /Нужен код/);
  await t.admin(cast.ivan, '/stop zzzzzz');
  assert.match(t.lastAdmin(cast.ivan), /Такой игры нет/);
  assert.equal(room.status, 'playing', 'игра идёт как шла');
  t.app.store.close();
});

test('посторонний не может завершить игру, даже зная код', async () => {
  const cast = THREE();
  const t = withStats();
  const room = await durakGame(t, cast);
  await t.admin(cast.max, `/stop ${room.code}`);
  assert.equal(room.status, 'playing');
  assert.equal(t.lastAdmin(cast.max), null);
  t.app.store.close();
});

/* ------------------------------------------------------- подпись админ-бота */

const adminInit = (u, t, startParam = null) => initDataFor(u, { token: ADMIN_TEST_TOKEN, startParam, clock: t.clock });

test('подписью админ-бота открывается админка — и только она', async () => {
  const cast = THREE();
  const t = withStats();
  const room = await durakGame(t, cast);

  const ok = t.open(cast.ivan, { initData: adminInit(cast.ivan, t), room: 'admin' });
  assert.ok(ok.session, 'кнопка из лички админ-бота открывает цифры');
  assert.equal(t.state(cast.ivan).kind, 'admin');
  t.close(cast.ivan);

  const atTable = t.open(cast.ivan, { initData: adminInit(cast.ivan, t, room.code) });
  assert.equal(atTable.error, 'NO_ROOM', 'за стол эта подпись не пускает — даже хоста');
  const atHub = t.open(cast.ivan, { initData: adminInit(cast.ivan, t, `g_${t.group.code}`) });
  assert.equal(atHub.error, 'NO_ROOM', 'и в хаб группы тоже');
  t.app.store.close();
});

test('подпись админ-бота не делает админом того, кого нет в списке', async () => {
  const t = withStats();
  const max = user(202, 'Макс');
  const r = t.open(max, { initData: adminInit(max, t), room: 'admin' });
  assert.equal(r.error, 'NO_ROOM');
  t.app.store.close();
});

test('чужой токен не открывает ничего', async () => {
  const t = withStats();
  const ivan = user(101, 'Иван');
  const r = t.open(ivan, { initData: initDataFor(ivan, { token: '999:не-наш-токен', clock: t.clock }), room: 'admin' });
  assert.equal(r.error, 'AUTH');
  t.app.store.close();
});

test('заход владельца за цифрами не попадает в «сколько людей играло»', async () => {
  const t = withStats();
  const ivan = user(101, 'Иван');
  t.open(ivan, { initData: adminInit(ivan, t), room: 'admin' });
  assert.equal(t.app.store.stats(t.clock.now()).people.total, 0, 'смотреть цифры — не играть');
  t.app.store.close();
});

/* ----------------------------------------------------------------- ошибки */

test('ошибки склеиваются: одно письмо в минуту, а не сто', async () => {
  const t = withStats();
  const ivan = user(101, 'Иван');
  t.adminTg.dmOpen.add('101'); // Start у админ-бота нажат
  await t.adminBot.onAppError(new Error('раз'));
  await t.adminBot.onAppError(new Error('два'));
  await t.adminBot.onAppError(new Error('три'));
  assert.equal(t.adminTg.dms(ivan.id).length, 1, 'три подряд — одно письмо');
  assert.match(t.lastAdmin(ivan), /раз/);

  await t.advance(ERROR_QUIET_MS + 1000);
  await t.adminBot.onAppError(new Error('четыре'));
  const said = t.lastAdmin(ivan);
  assert.match(said, /четыре/);
  assert.match(said, /и ещё 2 за последнюю минуту/, 'проглоченные посчитаны, а не потеряны');
  t.app.store.close();
});

test('если Start у админ-бота не нажат, игра от этого не встаёт', async () => {
  const t = withStats();
  const ivan = user(101, 'Иван');
  await t.adminBot.notify('проверка'); // 403: личка закрыта
  assert.equal(t.lastAdmin(ivan), null);
  assert.deepEqual(t.errors, [], '403 — не поломка, в лог ошибок он не идёт');
  t.app.store.close();
});
