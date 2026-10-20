'use strict';
/**
 * Аудит, фаза 1 (A): личность и права — фаззером по всем играм.
 *
 * Железное правило №1: никто не ходит за другого. Здесь его проверяет не
 * сценарий, а перебор: каждой игре, в каждом её состоянии (лобби, партия,
 * конец), шлётся КАЖДЫЙ тип сообщения, который она понимает, с мусорными
 * параметрами и с подменой личности в теле (`id`, `uid`, `userId`, `seat`,
 * `color`, `side`, `by`, `from`, `player`, `user`…), — от того, кому это
 * делать нельзя:
 *
 *   - ЗРИТЕЛЬ (открыл стол, не садился) — не меняет стол ничем, кроме «сесть»;
 *   - ИГРОК-НЕ-ХОСТ — не трогает чужие строки и настройки стола.
 *
 * Инвариант: снимок стола (без служебного: часы, карточка в чате) до и после
 * сообщения одинаков. Зерно случайности печатается при падении.
 *
 *   AUDIT_STEPS=20000 node --test bot/audit.identity.test.js   — подольше
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, initDataFor } from './harness.js';
import { seededRng } from './deck.js';
import { GAMES, GAME_LIST } from './games/index.js';

const STEPS = Number(process.env.AUDIT_STEPS || 600);

/** Все типы сообщений, какие понимает хоть одна игра, плюс чужие и выдуманные. */
const TYPES = [
  'sit', 'leave', 'start', 'next', 'act', 'settings', 'role', 'kick', 'rebuy', 'host', 'pause', 'resume', 'undo',
  'finish', 'pick', 'potNext', 'potBack', 'confirm', 'learn', 'attack', 'defend', 'transfer', 'take', 'pass',
  'play', 'draw', 'shout', 'catch', 'abort', 'move', 'resign', 'decline', 'takeback', 'declinetb', 'roll', 'end',
  'place', 'random', 'ready', 'fire', 'share', 'again', 'hub', 'stop', 'stopAll', 'maintenance', 'cast',
  'castTest', 'castCancel', 'refresh', 'visible', 'join', 'create', '__proto__', 'constructor', 'toString',
];

/** Значения, которыми стреляем в каждое поле. */
const JUNK = [
  null, undefined, 0, 1, -1, 2, 7, 99, 1e9, -1e9, 0.5, NaN, Infinity, -Infinity, '', '0', '1', 'abc', '__proto__',
  true, false, [], [1], {}, { x: 1 }, '101', '202', 101, 202, 'white', 'black', 'R5', 'AS', '6S', 'e2', 'e4',
  'A1', [[0, 0, 1, 'h']], 'x'.repeat(500),
];

const IDENTITY = ['id', 'uid', 'userId', 'user', 'player', 'by', 'from', 'who', 'seat', 'color', 'side', 'tgId', 'owner', 'hostId'];
const PARAMS = ['action', 'amount', 'seq', 'card', 'target', 'color', 'to', 'from', 'promo', 'ply', 'path', 'die', 'turn',
  'cell', 'ships', 'shot', 'pot', 'role', 'lesson', 'step', 'stacking', 'variant', 'turnSeconds', 'settings', 'code', 'game'];

/** Снимок того, что игра хранит о партии, без служебного: часы, карточка, отметки времени. */
const VOLATILE = new Set(['ui', 'touchedAt', 'idleAt', 'idleWarned', 'botDue', 'deadline', 'remaining', 'runningSince', 'elapsedMs']);
const snap = (room) => JSON.stringify(room, (k, v) => (VOLATILE.has(k) ? undefined : v));

function randomMsg(rnd, { victimIds }) {
  const pick = (a) => a[rnd(a.length)];
  const msg = { t: pick(TYPES) };
  const n = rnd(5);
  for (let i = 0; i < n; i++) msg[pick(PARAMS)] = pick(JUNK);
  // Подмена личности: в каждое «кто» — чужой id.
  for (const k of IDENTITY) if (rnd(2)) msg[k] = rnd(2) ? pick(victimIds) : Number(pick(victimIds));
  if (msg.t === 'sit') msg.t = 'refresh'; // «сесть» зрителю можно — это не атака
  return msg;
}

/** Стол игры: хост и второй игрок сели, партия начата (если игра даёт). */
async function setUp(t, gameId, cast) {
  const { host, guest } = cast;
  await t.cmd(host, '/game');
  t.openHub(host);
  await t.send(host, { t: 'create', game: gameId, settings: {} });
  const room = [...t.app.rooms.values()].find((r) => r.game === gameId);
  t.close(host);
  t.openRoom(host, room);
  t.openRoom(guest, room);
  await t.send(guest, { t: 'sit' });
  return room;
}

async function startIt(t, cast) {
  await t.send(cast.host, { t: 'start' });
}

for (const g of GAME_LIST) {
  test(`АУДИТ A-4: ${g.title} — зритель с чужим id в теле не меняет стол ни одним сообщением`, async () => {
    for (const phase of ['lobby', 'playing']) {
      const t = new Table();
      const cast = { host: user(101, 'Хост'), guest: user(202, 'Гость'), spy: user(303, 'Зритель') };
      const room = await setUp(t, g.id, cast);
      if (phase === 'playing') await startIt(t, cast);
      t.openRoom(cast.spy, room);
      const seed = 1000 + GAME_LIST.indexOf(g) * 7 + (phase === 'playing' ? 1 : 0);
      const rnd = seededRng(seed);
      for (let i = 0; i < STEPS; i++) {
        const before = snap(room);
        const msg = randomMsg(rnd, { victimIds: ['101', '202'] });
        await t.send(cast.spy, msg);
        const after = snap(room);
        if (before !== after) {
          assert.fail(`${g.id}/${phase}, зерно ${seed}, шаг ${i}: зритель изменил стол сообщением ${JSON.stringify(msg)}\n` +
            `до:    ${before.slice(0, 600)}\nпосле: ${after.slice(0, 600)}`);
        }
        if (!t.app.rooms.has(room.code)) assert.fail(`${g.id}: зритель удалил стол сообщением ${JSON.stringify(msg)}`);
      }
      assert.equal(t.errors.length, 0, `ошибки в логе: ${t.errors.map(String).join('; ')}`);
      t.app.stop();
    }
  });

  test(`АУДИТ A-4/A-7: ${g.title} — игрок-не-хост не меняет чужого и не правит стол`, async () => {
    const t = new Table();
    const cast = { host: user(101, 'Хост'), guest: user(202, 'Гость') };
    const room = await setUp(t, g.id, cast);
    const seed = 2000 + GAME_LIST.indexOf(g);
    const rnd = seededRng(seed);
    const HOST_ONLY = ['settings', 'kick', 'host', 'rebuy', 'role', 'finish', 'undo', 'pause', 'resume', 'pick', 'potNext', 'potBack', 'confirm'];
    for (const phase of ['lobby', 'playing']) {
      if (phase === 'playing') await startIt(t, cast);
      // Лобби закрывает только хост — и в дуэлях тоже (A-03, решение владельца:
      // гость может только встать). Между партиями дуэль закрывает любой из двоих.
      const list = HOST_ONLY;
      for (let i = 0; i < STEPS / 2; i++) {
        const msg = randomMsg(rnd, { victimIds: ['101'] });
        msg.t = list[rnd(list.length)];
        msg.seat = rnd(3) - 0; // 0 — хост, 1 — сам гость, 2 — никого
        const before = snap(room);
        const host = room.hostId;
        const settings = JSON.stringify(room.settings);
        await t.send(cast.guest, msg);
        assert.equal(room.hostId, host, `${g.id}, зерно ${seed}: гость сменил хоста сообщением ${JSON.stringify(msg)}`);
        assert.equal(JSON.stringify(room.settings), settings, `${g.id}, зерно ${seed}: гость поменял настройки ${JSON.stringify(msg)}`);
        const hostRow = room.players.find((p) => p.id === '101');
        assert.ok(hostRow && !hostRow.kicked, `${g.id}: гость удалил хоста ${JSON.stringify(msg)}`);
        assert.notEqual(room.status, 'finished', `${g.id}: гость завершил игру ${JSON.stringify(msg)}`);
        if (before !== snap(room)) {
          assert.fail(`${g.id}/${phase}, зерно ${seed}, шаг ${i}: гость изменил стол командой хоста ${JSON.stringify(msg)}\n` +
            `до:    ${before.slice(0, 600)}\nпосле: ${snap(room).slice(0, 600)}`);
        }
      }
    }
    assert.equal(t.errors.length, 0, `ошибки в логе: ${t.errors.map(String).join('; ')}`);
    t.app.stop();
  });
}

test('АУДИТ A-7: команды пульта не работают ни с одной страницы, кроме пульта админа', async () => {
  const t = new Table({ admins: ['999'] });
  const host = user(101, 'Хост');
  const guest = user(202, 'Гость');
  await t.cmd(host, '/game');
  await t.cmd(host, '/durak');
  const room = t.durak;
  const ADMIN = [
    { t: 'maintenance', on: true, text: 'взлом' }, { t: 'stopAll' }, { t: 'stop', code: room.code },
    { t: 'cast', text: 'реклама', audience: 'all' }, { t: 'castTest', text: 'x' }, { t: 'castCancel', id: 1 },
  ];
  const opens = {
    room: () => t.openRoom(guest, room),
    hub: () => t.openHub(guest),
    solo: () => t.openSolo(guest),
    home: () => t.open(guest, { initData: initDataFor(guest, { clock: t.clock }) }),
    'room-host': () => t.openRoom(host, room),
    'startapp=admin': () => t.open(guest, { initData: initDataFor(guest, { startParam: 'admin', clock: t.clock }) }),
  };
  for (const [kind, open] of Object.entries(opens)) {
    const r = open();
    const who = kind === 'room-host' ? host : guest;
    if (!r.session) {
      assert.equal(kind, 'startapp=admin', `${kind}: страница не открылась`);
      assert.equal(r.error, 'NO_ROOM', 'не админу админка отвечает как на выдуманный код');
      continue;
    }
    for (const msg of ADMIN) {
      await t.send(who, { ...msg, admin: true, kind: 'admin' });
      assert.equal(t.app.down, false, `${kind}: ${msg.t} включил обслуживание`);
      assert.notEqual(room.status, 'finished', `${kind}: ${msg.t} завершил игру`);
      assert.ok(t.app.rooms.has(room.code), `${kind}: ${msg.t} удалил игру`);
      assert.equal(t.app.casts.list(10).length, 0, `${kind}: ${msg.t} запустил рассылку`);
    }
    t.close(who);
  }
});

test('АУДИТ A-8: «нет такого» и «чужое» отвечают одинаково — существование кода не узнать', async () => {
  const t = new Table();
  const owner = user(101, 'Хозяин');
  const other = user(202, 'Чужой');
  await t.cmd(owner, '/game');
  await t.cmd(owner, '/durak');
  const room = t.durak;
  // Чужая партия с ботами против выдуманного кода.
  t.openSolo(owner);
  await t.send(owner, { t: 'play', game: 'durak', settings: {} });
  const solo = t.app.soloOf(owner.id);
  assert.ok(solo, 'партия с ботами создана');
  const openAs = (code, asked = null) => t.hub.open({ initData: initDataFor(other, { startParam: code, clock: t.clock }), room: asked }, () => {});
  const ghost = 'zzzzzzzzzz';
  assert.deepEqual(openAs(solo.code), openAs(ghost), 'чужая партия с ботами = выдуманный код');
  // Хаб группы: чужой код без подписи (из лички) = выдуманный.
  const fromDm = (asked) => t.hub.open({ initData: initDataFor(other, { clock: t.clock }), room: asked }, () => {});
  assert.deepEqual(fromDm(`g_${t.group.code}`), fromDm(`g_${ghost}`));
  // Из хаба другой группы — «join» чужого стола = выдуманного.
  const t2group = t.app.ensureGroup('-100777', 'Другая');
  const got = [];
  const page = t.hub.open({ initData: initDataFor(other, { startParam: `g_${t2group.code}`, clock: t.clock }) }, (m) => got.push(m));
  await t.hub.handle(page.session, { t: 'join', code: room.code });
  await t.hub.handle(page.session, { t: 'join', code: ghost });
  const errs = got.filter((m) => m.t === 'error');
  assert.equal(errs.length, 2);
  assert.deepEqual(errs[0], errs[1]);
  // Админка не админу = выдуманный код.
  assert.deepEqual(openAs('admin'), openAs(ghost));
  assert.equal(t.errors.length, 0, t.errors.map(String).join('; '));
});

// A-03 (решение владельца): в дуэли лобби закрывает только хост; гость может встать.
for (const g of GAME_LIST.filter((x) => x.maxPlayers === 2)) {
  test(`АУДИТ A-03: ${g.title} — гость не закрывает лобби хоста, а встать может`, async () => {
    const t = new Table();
    const cast = { host: user(101, 'Хост'), guest: user(202, 'Гость') };
    const room = await setUp(t, g.id, cast);
    await t.send(cast.guest, { t: 'finish' });
    assert.equal(t.lastError(cast.guest)?.code, 'NOT_HOST');
    assert.equal(room.status, 'lobby', 'лобби живо');
    await t.send(cast.guest, { t: 'leave' });
    assert.equal(room.players.filter((p) => p.seated).length, 1, 'гость встал');
    await t.send(cast.host, { t: 'finish' });
    assert.equal(room.status, 'finished', 'хост закрыл');
    t.app.stop();
  });
}
