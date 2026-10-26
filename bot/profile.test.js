'use strict';
/**
 * Профиль игрока: ник и аватар (bot/profile.js, приём `profile` в bot/hub.js).
 *
 *   ЛИЧНОСТЬ — только из initData; «чей профиль» в теле сообщения не существует.
 *   ПРАВА — профиль их не даёт: ник «Хост» хостом не делает.
 *   ПОКАЗ — за столом всех игр, в рейтинге (на момент показа), без чужих тайн.
 *   ХРАНЕНИЕ — отдельная таблица без смены версии схемы: старый код её не заметит.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Table, user } from './harness.js';
import { Store, SCHEMA_VERSION } from './store.js';
import { apply } from './rating.js';
import { gameOf } from './games/index.js';
import { cleanNick, AVATARS, avatarId, EVERY_MS, PER_HOUR, NICK_MAX } from './profile.js';

const ALICE = user(1, 'Алиса');
const BOB = user(2, 'Боб');
const CAROL = user(3, 'Катя');

const lastProfile = (t, u) => {
  const inbox = t.page(u).inbox;
  for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].t === 'profile') return inbox[i].profile ?? null;
  return null;
};
/** Отказ профиля — последним сообщением `profile` с полем error (иначе null). */
const perr = (t, u) => {
  const inbox = t.page(u).inbox;
  for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].t === 'profile') return inbox[i].error ?? null;
  return null;
};
const names = (state) => state.players.map((p) => p.name);

async function durakLobby(t, cast) {
  const [host, ...rest] = Object.values(cast);
  for (const u of Object.values(cast)) await t.start(u);
  await t.cmd(host, '/play');
  t.openHub(host);
  await t.send(host, { t: 'create', game: 'durak', settings: {} });
  const room = t.durak;
  for (const u of rest) {
    t.openRoom(u, room);
    await t.send(u, { t: 'sit' });
  }
  return room;
}

/* ------------------------------------------------------------ правила ника */

test('ник: границы длины, пробелы схлопываются, пустой — «имя из Telegram»', () => {
  assert.deepEqual(cleanNick('Вася'), { ok: true, nick: 'Вася' });
  assert.deepEqual(cleanNick('  Вася   Пупкин  '), { ok: true, nick: 'Вася Пупкин' }, 'лишние пробелы схлопнуты');
  assert.deepEqual(cleanNick('Вася\t Пупкин'), { ok: true, nick: 'Вася Пупкин' });
  assert.deepEqual(cleanNick(''), { ok: true, nick: null });
  assert.deepEqual(cleanNick('    '), { ok: true, nick: null });
  assert.deepEqual(cleanNick(null), { ok: true, nick: null });
  assert.equal(cleanNick('В').code, 'NICK_SHORT');
  assert.equal(cleanNick('Ва').ok, true, 'два символа — можно');
  assert.equal(cleanNick('а'.repeat(NICK_MAX)).ok, true);
  assert.equal(cleanNick('а'.repeat(NICK_MAX + 1)).code, 'NICK_LONG');
  assert.equal(cleanNick('🦊🦊').ok, true, 'эмодзи считаются символами');
  assert.equal(cleanNick('Anna_K-2.0').ok, true);
  assert.equal(cleanNick('山田太郎').ok, true, 'любые алфавиты');
  assert.equal(cleanNick(42).code, 'NICK_TYPE');
  assert.equal(cleanNick({ toString: () => 'Вася' }).code, 'NICK_TYPE');
});

test('ник: невидимые символы, @, ссылки, одни знаки — отказ', () => {
  for (const bad of ['Ва​ся', 'Ва‮ся', 'Ва‍ся', 'Ва⁦ся', '​​', 'Ва\u0000ся', 'Ва­ся', 'Ваㅤся']) {
    assert.equal(cleanNick(bad).code, 'NICK_INVISIBLE', JSON.stringify(bad));
  }
  for (const bad of ['@vasya', 'va@sya', 'vasya＠x', 'https://x.ru', 'go://x', 't.me/vasya', 'T . me', 'telegram.me', 'www.vasya', 'vasya.com', 'vasya.ru', 'v.RU']) {
    assert.equal(cleanNick(bad).code, 'NICK_LINK', bad);
  }
  for (const bad of ['<b>Вася</b>', 'Вася!', 'Вася#1', 'Вася$']) assert.equal(cleanNick(bad).code, 'NICK_CHARS', bad);
  for (const bad of ['..', '__', '-_-', '. .']) assert.equal(cleanNick(bad).code, 'NICK_EMPTY', bad);
});

test('набор аватарок: ровно av01…av12 без av05, чужое и старое av05 — null', () => {
  assert.deepEqual(AVATARS, ['av01', 'av02', 'av03', 'av04', 'av06', 'av07', 'av08', 'av09', 'av10', 'av11', 'av12']);
  for (const a of AVATARS) assert.equal(avatarId(a), a);
  for (const bad of ['av05', 'av00', 'av13', '../av01', 'av01.png', '/avatars/av01', 'AV01', '', null, undefined, 5, {}, ['av01'], 'constructor', '__proto__']) {
    assert.equal(avatarId(bad), null, JSON.stringify(bad));
  }
});

/* ------------------------------------------------------------------- хаб */

test('личность — только из initData: id/uid/user в теле игнорируются', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store });
  await t.begin({ ALICE, BOB, CAROL });
  await t.send(BOB, { t: 'profile', nickname: 'Шмель', avatar: 'av03', id: ALICE.id, uid: String(ALICE.id), userId: ALICE.id, user: { id: ALICE.id }, from: ALICE.id });
  assert.equal(perr(t, BOB), null);
  assert.deepEqual(store.getProfile(BOB.id), { nickname: 'Шмель', avatar: 'av03' }, 'профиль Боба изменился');
  assert.deepEqual(store.getProfile(ALICE.id), { nickname: null, avatar: null }, 'чужой профиль не тронут');
  assert.deepEqual(store.getProfile(CAROL.id), { nickname: null, avatar: null });
  store.close();
});

test('пустое состояние: без ника — имя из Telegram; «сбросить» возвращает его', async () => {
  const t = new Table({ store: new Store(':memory:') });
  await t.begin({ ALICE, BOB, CAROL });
  await t.send(BOB, { t: 'profile' }); // просто спросить
  assert.deepEqual(lastProfile(t, BOB), { nickname: null, avatar: null, telegramName: 'Боб', shown: 'Боб', avatars: AVATARS, min: 2, max: NICK_MAX });
  await t.send(BOB, { t: 'profile', nickname: 'Шмель' });
  assert.equal(lastProfile(t, BOB).shown, 'Шмель');
  assert.ok(names(t.state(ALICE)).includes('Шмель'), 'за столом у соседа имя уже новое');
  assert.ok(!names(t.state(ALICE)).includes('Боб'));
  t.clock.advance(EVERY_MS + 1);
  await t.clock.advance(EVERY_MS + 1);
  await t.send(BOB, { t: 'profile', nickname: '' });
  assert.equal(lastProfile(t, BOB).shown, 'Боб');
  assert.ok(names(t.state(ALICE)).includes('Боб'), 'после сброса — снова имя из Telegram');
  assert.ok(!names(t.state(ALICE)).includes('Шмель'));
});

test('плохой ник и плохой аватар — отказ словами, ничего не сохранено', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store });
  await t.begin({ ALICE, BOB, CAROL });
  for (const [msg, code] of [
    [{ nickname: '@boss' }, 'NICK_LINK'],
    [{ nickname: 'В' }, 'NICK_SHORT'],
    [{ nickname: 'Ва‮ся' }, 'NICK_INVISIBLE'],
    [{ avatar: 'av99' }, 'BAD_AVATAR'],
    [{ avatar: '../../etc/passwd' }, 'BAD_AVATAR'],
    [{ avatar: { id: 'av01' } }, 'BAD_AVATAR'],
  ]) {
    await t.send(BOB, { t: 'profile', ...msg });
    const e = perr(t, BOB);
    assert.equal(e?.code, code, JSON.stringify(msg));
    assert.match(e.text, /[а-яё]/i, 'отказ словами');
    t.page(BOB).inbox.length = 0;
  }
  assert.deepEqual(store.getProfile(BOB.id), { nickname: null, avatar: null });
  store.close();
});

test('частота: не чаще раза в 10 секунд и 6 раз в час (по часам приложения)', async () => {
  const t = new Table({ store: new Store(':memory:') });
  await t.begin({ ALICE, BOB, CAROL });
  await t.send(BOB, { t: 'profile', nickname: 'Один' });
  assert.equal(perr(t, BOB), null);
  await t.send(BOB, { t: 'profile', nickname: 'Два' });
  assert.equal(perr(t, BOB)?.code, 'PROFILE_FAST');
  await t.clock.advance(EVERY_MS - 1);
  await t.send(BOB, { t: 'profile', nickname: 'Два' });
  assert.equal(perr(t, BOB)?.code, 'PROFILE_FAST', 'ещё рано');
  await t.clock.advance(2);
  t.page(BOB).inbox.length = 0;
  await t.send(BOB, { t: 'profile', nickname: 'Два' });
  assert.equal(perr(t, BOB), null, 'через 10 секунд — можно');
  // пока то же самое значение — не смена, не считается
  await t.send(BOB, { t: 'profile', nickname: 'Два' });
  assert.equal(perr(t, BOB), null);
  // шесть смен в час
  for (let i = 3; i <= PER_HOUR; i++) {
    await t.clock.advance(EVERY_MS + 1);
    await t.send(BOB, { t: 'profile', nickname: `Ник${i}` });
    assert.equal(perr(t, BOB), null, `смена ${i}`);
  }
  await t.clock.advance(EVERY_MS + 1);
  await t.send(BOB, { t: 'profile', nickname: 'Лишний' });
  assert.equal(perr(t, BOB)?.code, 'PROFILE_HOUR', 'седьмая за час — нет');
  await t.clock.advance(3_600_000);
  t.page(BOB).inbox.length = 0;
  await t.send(BOB, { t: 'profile', nickname: 'Лишний' });
  assert.equal(perr(t, BOB), null, 'через час снова можно');
  // чужая частота — своя: Алиса не заблокирована Бобом
  await t.send(ALICE, { t: 'profile', nickname: 'Лиса' });
  assert.equal(perr(t, ALICE), null);
});

test('права: ник «Хост» хостом не делает, чужое имя — не чужие права', async () => {
  const t = new Table({ store: new Store(':memory:') });
  const room = await durakLobby(t, { ALICE, BOB });
  const hostId = room.hostId ?? room.players[0].id;
  await t.send(BOB, { t: 'profile', nickname: 'Хост' });
  await t.clock.advance(EVERY_MS + 1);
  await t.send(BOB, { t: 'profile', nickname: 'Алиса' }); // имя хоста
  assert.equal(perr(t, BOB), null);
  await t.send(BOB, { t: 'start' });
  assert.ok(t.lastError(BOB), 'старт доступен только хосту — Бобу отказ');
  assert.equal(room.status, 'lobby', 'партия не началась');
  assert.equal(t.state(BOB).players.find((p) => p.isMe).isHost, false);
  assert.equal(t.state(ALICE).players.find((p) => p.isHost).name, 'Алиса');
  assert.equal(room.hostId ?? room.players[0].id, hostId);
  const inRoom = room.players.map((p) => p.id);
  assert.deepEqual(inRoom, ['1', '2'], 'личность за столом — прежняя');
});

test('двойник имени: если за столом уже есть такое имя, ставится « 2» (регистр не важен); сидящий дольше имя не теряет', async () => {
  const t = new Table({ store: new Store(':memory:') });
  const room = await durakLobby(t, { ALICE, BOB });
  await t.send(BOB, { t: 'profile', nickname: 'алИСА' });
  const seen = names(t.state(CAROL.id ? ALICE : ALICE));
  assert.deepEqual(seen, ['Алиса', 'алИСА 2']);
  // третий с тем же ником
  await t.start(CAROL);
  t.openRoom(CAROL, room);
  await t.send(CAROL, { t: 'profile', nickname: 'Алиса 2' });
  await t.send(CAROL, { t: 'sit' });
  const all = names(t.state(ALICE));
  assert.equal(new Set(all.map((n) => n.toLowerCase())).size, all.length, `имена разные: ${all}`);
  assert.equal(all[0], 'Алиса', 'первая осталась как была');
  // ник из 16 символов тоже укладывается в 16
  await t.clock.advance(EVERY_MS + 1);
  await t.send(ALICE, { t: 'profile', nickname: 'Ж'.repeat(16) });
  await t.clock.advance(EVERY_MS + 1);
  await t.send(BOB, { t: 'profile', nickname: 'Ж'.repeat(16) });
  for (const n of names(t.state(ALICE))) assert.ok([...n].length <= 16, n);
});

test('ники не раскрывают имя из Telegram: у соседей по столу его нет', async () => {
  const t = new Table({ store: new Store(':memory:') });
  // Ник задан до того, как Боб сел за стол (страницу стола он откроет позже).
  assert.ok(t.app.profiles.update({ id: '2', name: 'Боб' }, { nickname: 'Шмель', avatar: 'av06' }).ok);
  await t.begin({ ALICE, BOB, CAROL });
  const seen = t.received(ALICE) + t.received(CAROL);
  assert.ok(!seen.includes('Боб'), 'настоящее имя Боба не ушло соседям');
  assert.ok(seen.includes('Шмель'));
  assert.ok(!t.received(ALICE).includes('telegramName'));
  await t.send(BOB, { t: 'profile' });
  assert.match(t.received(BOB), /telegramName/, 'а ему самому — оно в экране настроек');
});

test('смена ника на лету: у сидящего за столом имя и аватар обновляются сразу, у всех семи игр вид содержит avatar только из набора', async () => {
  for (const game of ['poker', 'durak', 'colors', 'chess', 'checkers', 'nardy', 'battleship']) {
    const t = new Table({ store: new Store(':memory:') });
    for (const u of [ALICE, BOB]) await t.start(u);
    await t.cmd(ALICE, '/play');
    t.openHub(ALICE);
    await t.send(ALICE, { t: 'create', game, settings: {}, reqId: 'r1' });
    const room = t.app.roomsOf(t.chatId).filter((r) => r.game === game).at(-1);
    assert.ok(room, game);
    t.openRoom(BOB, room);
    await t.send(BOB, { t: 'sit' });
    await t.send(BOB, { t: 'profile', nickname: 'Шмель', avatar: 'av07' });
    const bobIn = (u) => {
      const v = t.state(u);
      const list = v.players || v.room?.players;
      return list.find((p) => p.name === 'Шмель');
    };
    assert.equal(bobIn(ALICE)?.avatar, 'av07', `${game}: Алиса видит ник и аватар Боба сразу`);
    assert.equal(bobIn(BOB)?.avatar, 'av07', game);
    // мусор, попавший в комнату любым путём, в вид не уходит
    for (const junk of ['../../etc/passwd', 'av99', 5, { x: 1 }, '<img onerror=1>']) {
      room.players.find((p) => p.id === String(BOB.id)).avatar = junk;
      const view = gameOf(room).view(room, String(ALICE.id), { now: t.clock.now(), botUsername: 'x' });
      const list = view.players || view.room?.players;
      for (const p of list) assert.ok(p.avatar == null || AVATARS.includes(p.avatar), `${game}: avatar ${JSON.stringify(p.avatar)}`);
    }
  }
});

test('рейтинг: имя и аватар берутся из профиля при показе, старая строка не переписана', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store, ratingSoon: false });
  await t.start(ALICE);
  await t.cmd(ALICE, '/play');
  apply(store, { game: 'durak', round: 'r1', places: [{ id: 1, name: 'Алиса' }, { id: 2, name: 'Боб' }], loserId: 2, at: t.clock.now() });
  t.openHub(ALICE);
  await t.send(ALICE, { t: 'rating' });
  assert.equal(t.state(ALICE).top.find((r) => r.userId === '2').name, 'Боб');
  await t.start(BOB);
  t.openHub(BOB);
  await t.send(BOB, { t: 'profile', nickname: 'Шмель', avatar: 'av09' });
  await t.send(ALICE, { t: 'pick', game: 'durak', period: 'all' });
  const row = t.state(ALICE).top.find((r) => r.userId === '2');
  assert.equal(row.name, 'Шмель');
  assert.equal(row.avatar, 'av09');
  assert.equal(t.state(ALICE).top.find((r) => r.userId === '1').avatar, null, 'без профиля — null, значит инициал');
  assert.equal(store.ratingOf(2, 'durak').name, 'Боб', 'в базе рейтинга — как было');
  store.close();
});

/* ---------------------------------------------------------------- хранение */

test('таблица profiles: создаётся в пустой базе, повторный запуск ничего не ломает, версия схемы не менялась', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  const file = path.join(dir, 'bot.db');
  let s = new Store(file);
  s.putProfile(7, { nickname: 'Шмель', avatar: 'av02' }, 1);
  s.close();
  s = new Store(file); // повторный запуск
  assert.deepEqual(s.getProfile(7), { nickname: 'Шмель', avatar: 'av02' }, 'пережило перезапуск');
  s.putProfile(7, { nickname: null, avatar: null }, 2);
  assert.deepEqual(s.getProfile(7), { nickname: null, avatar: null });
  assert.deepEqual(s.getProfile(8), { nickname: null, avatar: null });
  s.close();
  // база, созданная до профилей (таблицы нет)
  const raw = new DatabaseSync(file);
  raw.exec('DROP TABLE profiles');
  assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, SCHEMA_VERSION);
  raw.close();
  s = new Store(file);
  assert.deepEqual(s.getProfile(7), { nickname: null, avatar: null }, 'таблица создана заново');
  s.close();
  const check = new DatabaseSync(file, { readOnly: true });
  assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, '5', 'версия схемы прежняя');
  check.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('профиль переживает перезапуск бота: ник и аватар подхватываются из базы', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  const file = path.join(dir, 'bot.db');
  let store = new Store(file);
  let t = new Table({ store });
  await t.begin({ ALICE, BOB, CAROL });
  await t.send(BOB, { t: 'profile', nickname: 'Шмель', avatar: 'av04' });
  store.close();
  store = new Store(file);
  t = new Table({ store });
  assert.deepEqual(t.app.profiles.profileOf(BOB.id, 'Боб'), { name: 'Шмель', avatar: 'av04' });
  assert.deepEqual(t.app.profiles.profileOf(CAROL.id, 'Катя'), { name: 'Катя', avatar: null });
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------- файлы аватарок */

test('у каждой аватарки из набора есть PNG: 128×128, палитровый, ≤ 20 КБ; лишних файлов нет', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'miniapp', 'avatars');
  for (const id of AVATARS) {
    const f = path.join(dir, `${id}.png`);
    assert.ok(fs.existsSync(f), `нет файла ${id}.png`);
    const b = fs.readFileSync(f);
    assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG', `${id}: не PNG`);
    assert.equal(b.readUInt32BE(16), 128, `${id}: ширина`);
    assert.equal(b.readUInt32BE(20), 128, `${id}: высота`);
    assert.ok(b.length <= 20 * 1024, `${id}: ${b.length} байт — больше 20 КБ`);
  }
  const extra = fs.readdirSync(dir).filter((n) => n.endsWith('.png') && !AVATARS.includes(n.slice(0, -4)));
  assert.deepEqual(extra, [], 'PNG без id в списке сервера');
});

test('старый выбор av05 не ломается: читается как «без аватара», экран профиля и стол работают', async () => {
  const store = new Store(':memory:');
  store.putProfile(2, { nickname: 'Шмель', avatar: 'av05' }, 1);
  const t = new Table({ store });
  await t.begin({ ALICE, BOB, CAROL });
  assert.equal(t.app.profiles.mine({ id: '2', name: 'Боб' }).avatar, null);
  assert.ok(!t.received(ALICE).includes('av05'), 'av05 соседям не уходит');
  assert.ok(t.received(ALICE).includes('Шмель'), 'ник остался');
  await t.send(BOB, { t: 'profile' });
  assert.ok(!t.received(BOB).includes('av05'));
});
