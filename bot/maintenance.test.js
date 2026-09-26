'use strict';
/**
 * Режим обслуживания — «всё стоп».
 *
 * Главное, что тут проверяется, — что пауза не крадёт чужое время. Бот не
 * ходит за игрока; простой сервера тем более не должен доедать его минуту на
 * ход. Остальное: игрок видит экран, а не ошибку; ни одного хода не
 * принимается; админка при этом работает, иначе обслуживание нельзя было бы
 * снять; и флаг переживает перезапуск.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, durakStack } from './harness.js';
import { Store } from './store.js';
import { MAINTENANCE_TEXT } from './app.js';

const THREE = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') });
const withStats = (opts = {}) => new Table({ store: new Store(':memory:'), admins: ['101'], ...opts });
const SEC = 1000;

/** Стол с таймером хода и тремя игроками. */
async function timed(t, cast, secs = 60) {
  await t.seat(cast, { blinds: [25, 50] });
  await t.send(cast.ivan, { t: 'settings', turnSeconds: secs });
  await t.send(cast.ivan, { t: 'start' });
  return t;
}

/* ------------------------------------------------------------- включение */

test('обслуживание включает только админ, и только со своей страницы', async () => {
  const cast = THREE();
  const t = withStats();
  await timed(t, cast);

  // Игрок со своей страницы стола: такой команды у него нет вообще.
  await t.send(cast.max, { t: 'maintenance', on: true });
  assert.equal(t.lastError(cast.max).code, 'BAD_REQUEST');
  assert.equal(t.app.down, false, 'и обслуживание не включилось');

  t.openAdmin(cast.ivan); // Иван — в списке админов
  await t.send(cast.ivan, { t: 'maintenance', on: true, text: 'Обновляем дурака' });
  assert.equal(t.app.down, true);
  assert.equal(t.app.downText, 'Обновляем дурака');
  t.app.store.close();
});

test('свой текст показывается игрокам, без него — общий', async () => {
  const t = withStats();
  const ivan = user(101, 'Иван');
  t.openAdmin(ivan);
  await t.send(ivan, { t: 'maintenance', on: true });
  assert.equal(t.app.downText, MAINTENANCE_TEXT);
  await t.send(ivan, { t: 'maintenance', on: true, text: 'Вернёмся в 22:00' });
  assert.equal(t.app.downText, 'Вернёмся в 22:00');
  t.app.store.close();
});

/* --------------------------------------------------------- что видит игрок */

test('игрок видит экран обслуживания, а не ошибку и не пустой стол', async () => {
  const cast = THREE();
  const t = withStats();
  await timed(t, cast);

  t.openAdmin(cast.ivan);
  await t.send(cast.ivan, { t: 'maintenance', on: true, text: 'Пять минут' });

  const seen = t.state(cast.max);
  assert.equal(seen.kind, 'down', 'страница переключилась сама, без перезагрузки');
  assert.equal(seen.text, 'Пять минут');
  assert.ok(!('legal' in seen), 'ни кнопок, ни карт на этом экране нет');
  assert.ok(!t.received(cast.max).includes('"fatal"'), 'и это не «стол недоступен»');
  t.app.store.close();
});

test('во время обслуживания не принимается ни один ход', async () => {
  const cast = THREE();
  const t = withStats();
  await timed(t, cast);
  const before = JSON.stringify(t.room.hand);

  t.openAdmin(cast.ivan);
  await t.send(cast.ivan, { t: 'maintenance', on: true });

  // Кто угодно, кроме Ивана: у него в этом тесте открыта админка, а не стол.
  const actor = [cast.max, cast.dima].find((u) => String(u.id) === t.actor()) || cast.max;
  await t.act(actor, 'fold');
  assert.equal(t.lastError(actor).code, 'DOWN');
  assert.equal(JSON.stringify(t.room.hand), before, 'раздача не сдвинулась');
  t.app.store.close();
});

test('во время обслуживания не создаётся новая игра — ни в группе, ни из хаба', async () => {
  const cast = THREE();
  const t = withStats();
  await t.cmd(cast.ivan, '/game');
  t.openHub(cast.dima);
  t.openAdmin(cast.ivan);
  await t.send(cast.ivan, { t: 'maintenance', on: true, text: 'Скоро вернёмся' });

  await t.send(cast.dima, { t: 'create', game: 'durak' });
  assert.equal(t.lastError(cast.dima).code, 'DOWN');
  assert.equal(t.app.roomsOf(t.chatId).length, 0);

  await t.cmd(cast.max, '/newgame');
  assert.match(t.lastPost(), /Идёт обслуживание/);
  assert.match(t.lastPost(), /Скоро вернёмся/);
  assert.equal(t.app.roomsOf(t.chatId).length, 0, 'и стола не появилось');
  t.app.store.close();
});

test('кнопка на карточке в группе отвечает, а не висит', async () => {
  const cast = THREE();
  const t = withStats();
  await timed(t, cast);
  t.openAdmin(cast.ivan);
  await t.send(cast.ivan, { t: 'maintenance', on: true });

  await t.pressData(cast.max, 'open');
  assert.match(t.answer().text, /Идёт обслуживание/);
  t.app.store.close();
});

/* ------------------------------------------------------------ чужое время */

test('обслуживание не съедает время на ход', async () => {
  const cast = THREE();
  const t = withStats();
  await timed(t, cast, 60);
  const actor = t.actorOf(cast);

  await t.advance(20 * SEC); // двадцать секунд человек думал
  const left = t.room.turn.deadline - t.clock.now();
  assert.ok(left > 39 * SEC && left <= 40 * SEC, `осталось ${Math.round(left / 1000)} с`);

  t.openAdmin(cast.ivan);
  await t.send(cast.ivan, { t: 'maintenance', on: true });
  assert.equal(t.room.turn.deadline, null, 'часы остановлены');
  assert.ok(t.room.turn.remaining > 39 * SEC, 'остаток запомнен');

  await t.advance(10 * 60 * SEC); // десять минут обслуживания
  assert.equal(t.actor(), String(actor.id), 'ход не отобрали');
  assert.equal(t.room.hand.phase, 'betting', 'и раздачу не свернули');

  await t.send(cast.ivan, { t: 'maintenance', on: false });
  const after = t.room.turn.deadline - t.clock.now();
  assert.ok(after > 39 * SEC && after <= 40 * SEC, `после снятия осталось ${Math.round(after / 1000)} с`);

  // И таймер снова живой: досидел — ход всё-таки уходит.
  await t.advance(41 * SEC);
  assert.notEqual(t.actor(), String(actor.id), 'после обслуживания таймер работает как прежде');
  t.app.store.close();
});

test('автораздача во время обслуживания не срабатывает', async () => {
  const cast = THREE();
  const t = withStats();
  await timed(t, cast, 60);
  t.openAdmin(cast.ivan);
  await t.send(cast.ivan, { t: 'maintenance', on: true });
  await t.advance(60 * 60 * SEC);
  assert.equal(t.app.handles.size, 0, 'ни одного живого таймера');
  t.app.store.close();
});

/* ------------------------------------------------------------- снятие */

test('снятие возвращает игрока к столу, а хаб — к списку игр', async () => {
  const cast = THREE();
  const t = withStats();
  await timed(t, cast);
  t.openHub(cast.dima);
  t.openAdmin(cast.ivan);

  await t.send(cast.ivan, { t: 'maintenance', on: true });
  assert.equal(t.state(cast.max).kind, 'down');
  assert.equal(t.state(cast.dima).kind, 'down');

  await t.send(cast.ivan, { t: 'maintenance', on: false });
  assert.equal(t.state(cast.max).room.code, t.room.code, 'снова свой стол');
  assert.equal(t.state(cast.dima).kind, 'hub', 'и снова список игр группы');
  t.app.store.close();
});

test('страница сама переспрашивает: «обновить» во время обслуживания не ошибка', async () => {
  const cast = THREE();
  const t = withStats();
  await timed(t, cast);
  t.openAdmin(cast.ivan);
  await t.send(cast.ivan, { t: 'maintenance', on: true });

  await t.send(cast.max, { t: 'refresh' });
  assert.equal(t.lastError(cast.max), null, 'отказа нет');
  assert.equal(t.state(cast.max).kind, 'down');

  await t.send(cast.ivan, { t: 'maintenance', on: false });
  await t.send(cast.max, { t: 'refresh' });
  assert.equal(t.state(cast.max).room.code, t.room.code);
  t.app.store.close();
});

test('админка работает во время обслуживания — иначе его не снять', async () => {
  const cast = THREE();
  const t = withStats();
  await timed(t, cast);
  t.openAdmin(cast.ivan);
  await t.send(cast.ivan, { t: 'maintenance', on: true, text: 'Чиню' });

  const s = t.state(cast.ivan);
  assert.equal(s.kind, 'admin');
  assert.equal(s.down.on, true);
  assert.equal(s.down.text, 'Чиню');
  assert.equal(s.sessions.length, 1, 'сессии видны и во время паузы');
  t.app.store.close();
});

test('флаг обслуживания переживает перезапуск', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store, admins: ['101'] });
  const ivan = user(101, 'Иван');
  t.openAdmin(ivan);
  await t.send(ivan, { t: 'maintenance', on: true, text: 'Переносим на новый сервер' });

  const again = new Table({ store, admins: ['101'] });
  assert.equal(again.app.down, true, 'после перезапуска обслуживание всё ещё идёт');
  assert.equal(again.app.downText, 'Переносим на новый сервер');
  store.close();
});

/* ----------------------------------------------------------- завершить всё */

test('«завершить все» закрывает игры с итогами в группы', async () => {
  const cast = THREE();
  const t = withStats();
  t.useDurakDeck(durakStack({ 202: '6D 7S 8S 9S 10S JS', 303: '7H 8H 9H 10H JH QH', 101: '7C 8C 9C 10C JC QC' }, { trump: 'AD' }));
  await timed(t, cast);
  const poker = t.room;

  await t.cmd(cast.ivan, '/game');
  t.openHub(cast.dima);
  await t.send(cast.dima, { t: 'create', game: 'durak' });
  const durak = t.durak;

  t.openAdmin(cast.ivan);
  await t.send(cast.ivan, { t: 'stopAll' });

  assert.equal(poker.status, 'finished');
  assert.equal(durak.status, 'finished');
  const posted = t.tg.groupTexts(t.chatId).join('\n');
  assert.match(posted, /ИТОГИ/, 'итоги ушли в группу, а стол не пропал молча');
  t.app.store.close();
});

test('«завершить все» на пустом месте ничего не ломает', async () => {
  const t = withStats();
  const ivan = user(101, 'Иван');
  t.openAdmin(ivan);
  await t.send(ivan, { t: 'stopAll' });
  assert.equal(t.errors.length, 0);
  t.app.store.close();
});

/* ------------------------------------------------------------ админ-бот */

test('/pause и /resume делают то же, что кнопки', async () => {
  const cast = THREE();
  const t = withStats();
  await timed(t, cast);

  await t.admin(cast.ivan, '/pause Обновляем дурака');
  assert.equal(t.app.down, true);
  assert.equal(t.app.downText, 'Обновляем дурака');
  assert.match(t.lastAdmin(cast.ivan), /Обслуживание включено/);
  assert.equal(t.state(cast.max).kind, 'down', 'игрок узнал сразу');

  await t.admin(cast.ivan, '/resume');
  assert.equal(t.app.down, false);
  assert.match(t.lastAdmin(cast.ivan), /Обслуживание снято/);
  t.app.store.close();
});

test('/stopall просит подтверждения словом', async () => {
  const cast = THREE();
  const t = withStats();
  await timed(t, cast);

  await t.admin(cast.ivan, '/stopall');
  assert.match(t.lastAdmin(cast.ivan), /stopall да/);
  assert.equal(t.room.status, 'playing', 'без «да» ничего не закрылось');

  await t.admin(cast.ivan, '/stopall да');
  assert.equal(t.room.status, 'finished');
  t.app.store.close();
});

test('постороннему /pause не поможет', async () => {
  const cast = THREE();
  const t = withStats();
  await timed(t, cast);
  await t.admin(cast.max, '/pause всё стоп');
  assert.equal(t.app.down, false);
  assert.equal(t.lastAdmin(cast.max), null);
  t.app.store.close();
});
