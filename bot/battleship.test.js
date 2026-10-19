'use strict';
/**
 * Морской бой через мини-приложение — с настоящими страницами через хаб.
 *
 *   ТАЙНА ФЛОТА — главное. До конца партии чужая расстановка не уходит
 *   наружу ни по какому каналу. Проверяется двумя способами:
 *
 *   1. «Что знает каждый телефон»: вся партия, всё, что получил каждый
 *      телефон; про чужое поле в сообщениях — только клетки, в которые этот
 *      игрок стрелял, и корабли, которые он потопил.
 *
 *   2. «Подмена флота»: одна и та же партия дважды, но у соперника в
 *      клетках, куда никто не стрелял, корабли стоят по-разному. Всё, что
 *      получил другой игрок, зритель, пульт владельца, группа и личка, —
 *      ДОСЛОВНО одинаково. Значит, ни одно сообщение не зависит от
 *      нераскрытой части чужого флота: утечь ей неоткуда, каким бы полем,
 *      текстом ошибки или подписью она ни пыталась выйти.
 *
 *   НИКТО НЕ ХОДИТ ЗА ДРУГОГО — личность только из initData: расставить,
 *   «готов» и выстрел — только за себя; поля тела вроде uid/side
 *   игнорируются.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, FakeClock, botRandom, user } from './harness.js';
import { Store } from './store.js';
import { PLACE } from './rating.js';
import { shipCells, cellOf, checkFleet, addr, sortShips } from './games/battleship/board.js';
import { FIRST_MS, PLACE_MS } from './games/battleship/rules.js';
import { fleet, ROWS, COLS } from './battleship.fixtures.js';

const IVAN = user(101, 'Иван');
const MAX = user(202, 'Макс');
const DIMA = user(303, 'Дима');
const OLEG = user(404, 'Олег'); // владелец: пульт

const states = (t, u) => t.page(u).inbox.filter((m) => m.t === 'state' && m.state.game === 'battleship').map((m) => m.state);
const sideOfU = (room, u) => room.match.ids.indexOf(String(u.id));
const C = (a) => {
  // «Б7» → клетка
  const x = 'АБВГДЕЖЗИК'.indexOf(a[0]);
  return cellOf(x, Number(a.slice(1)) - 1);
};

async function lobby(t, settings = { base: 0 }) {
  await t.start(IVAN);
  if (!t.group) await t.cmd(IVAN, '/play');
  t.openHub(IVAN);
  await t.send(IVAN, { t: 'create', game: 'battleship', settings, reqId: 'b1' });
  const room = t.battleship;
  await t.start(MAX);
  t.openRoom(MAX, room);
  await t.send(MAX, { t: 'sit' });
  return room;
}

async function duel(t, settings) {
  const room = await lobby(t, settings);
  await t.send(IVAN, { t: 'start' });
  return room;
}

/** Оба расставили и готовы. */
async function battle(t, { ivan = ROWS, max = COLS, settings } = {}) {
  const room = await duel(t, settings);
  await t.send(IVAN, { t: 'place', ships: ivan });
  await t.send(MAX, { t: 'place', ships: max });
  await t.send(IVAN, { t: 'ready' });
  await t.send(MAX, { t: 'ready' });
  assert.equal(room.match.phase, 'battle');
  return room;
}

async function shot(t, u, cell, { ok = true } = {}) {
  const before = t.page(u).inbox.length;
  await t.send(u, { t: 'fire', cell });
  const err = t.page(u).inbox.slice(before).find((m) => m.t === 'error');
  if (ok) assert.equal(err?.code ?? null, null, `${u.first_name} → ${addr(cell)}`);
  return err || null;
}

/* ------------------------------------------------------------ игра и личность */

test('партия с двух телефонов: расстановка, готовность, жребий, «попал — ещё», победа и рейтинг', async () => {
  const t = new Table({ store: new Store(':memory:') });
  const room = await duel(t);
  assert.equal(room.game, 'battleship');
  assert.equal(t.state(IVAN).match.phase, 'place');
  assert.equal(t.state(IVAN).canPlace, true);
  assert.equal(t.state(IVAN).canReady, false, 'флота ещё нет');
  await t.send(IVAN, { t: 'place', ships: ROWS });
  assert.equal(t.state(IVAN).canReady, true);
  await t.send(IVAN, { t: 'ready' });
  assert.equal(t.state(MAX).match.boards[0].ready, true, 'Макс видит, что Иван готов');
  await t.send(MAX, { t: 'random' });
  await t.send(MAX, { t: 'ready' });
  const s = t.state(IVAN);
  assert.equal(s.match.phase, 'battle');
  assert.equal(s.match.first, 0, 'жребий (подмена в тестах): первым — хост');
  assert.equal(s.legal.myTurn, true);
  assert.equal(t.state(MAX).legal.myTurn, false);
  const target = room.match.fleets[1].flatMap(shipCells);
  for (const c of target) await shot(t, IVAN, c);
  assert.deepEqual(room.match.over, { winner: 0, kind: 'fleet' });
  assert.equal(t.state(MAX).match.over.why, 'весь флот соперника потоплен');
  assert.equal(t.app.store.ratingOf(101, 'battleship').points, PLACE[0]);
  t.app.store.close();
});

test('никто не ходит за другого: расстановка, «готов» и выстрел — только за себя; зритель — ни во что', async () => {
  const t = new Table();
  const room = await duel(t);
  await t.start(DIMA);
  t.openRoom(DIMA, room);
  // Макс шлёт флот «за Ивана»: поля тела не читаются — это флот Макса.
  await t.send(MAX, { t: 'place', ships: COLS, uid: '101', id: 101, side: 0, seat: 0 });
  assert.equal(room.match.fleets[0], null, 'у Ивана флота нет');
  assert.deepEqual(room.match.fleets[1], checkFleet(COLS).ships);
  await t.send(MAX, { t: 'ready', uid: '101', side: 0 });
  assert.deepEqual(room.match.ready, [false, true]);
  for (const msg of [{ t: 'place', ships: ROWS }, { t: 'random' }, { t: 'ready' }, { t: 'fire', cell: 0 }, { t: 'resign' }]) {
    await t.send(DIMA, msg);
    assert.equal(t.lastError(DIMA).code, 'NOT_IN_GAME', msg.t);
  }
  await t.send(IVAN, { t: 'place', ships: ROWS });
  await t.send(IVAN, { t: 'ready' });
  await t.send(MAX, { t: 'fire', cell: 0, uid: '101', side: 0 });
  assert.equal(t.lastError(MAX).code, 'NOT_YOUR_TURN');
  assert.equal(t.lastError(MAX).text, 'Сейчас ходит соперник.');
  assert.equal(room.match.log.length, 0);
  await t.send(IVAN, { t: 'draw' });
  assert.equal(t.lastError(IVAN).code, 'BAD_REQUEST', 'ничьей в морском бое нет');
  await t.send(IVAN, { t: 'place', ships: COLS });
  assert.equal(t.lastError(IVAN).code, 'BATTLE_ON');
  assert.match(t.lastError(IVAN).text, /идёт бой/);
});

test('кривая расстановка — отказ словами; случайность со страницы не берётся', async () => {
  const t = new Table({ battleshipFleetRand: botRandom(9) });
  const room = await duel(t);
  await t.send(IVAN, { t: 'place', ships: ROWS.slice(0, 9) });
  assert.match(t.lastError(IVAN).text, /один четырёхпалубный, два трёхпалубных/);
  await t.send(IVAN, { t: 'place', ships: ROWS.map((s, i) => (i === 9 ? { x: 4, y: 1, len: 1, dir: 'h' } : s)) });
  assert.match(t.lastError(IVAN).text, /не должны касаться/);
  await t.send(IVAN, { t: 'place', ships: ROWS.map((s, i) => (i === 0 ? { x: 8, y: 9, len: 4, dir: 'h' } : s)) });
  assert.match(t.lastError(IVAN).text, /в поле целиком/);
  await t.send(IVAN, { t: 'place', ships: 'ROWS' });
  assert.equal(t.lastError(IVAN).code, 'BAD_FLEET');
  assert.equal(room.match.fleets[0], null);
  await t.send(IVAN, { t: 'random', seed: 1, ships: ROWS, rand: 0 });
  assert.deepEqual(room.match.fleets[0], sortShips(room.match.fleets[0]));
  assert.ok(checkFleet(room.match.fleets[0]).ok);
  assert.notDeepEqual(room.match.fleets[0], checkFleet(ROWS).ships, 'флот со страницы в «случайно» не подставить');
  await t.send(IVAN, { t: 'ready', ships: COLS });
  assert.notDeepEqual(room.match.fleets[0], checkFleet(COLS).ships, '«готов» флот не меняет');
});

/* ------------------------------------------------------------ тайна флота */

/** Корабельные клетки поля `side`, которые раскрывает один вид (корабли в списке и отметки «ранил/убил»). */
function revealed(state, side) {
  const b = state.match.boards[side];
  const out = new Set(b.ships.flatMap(shipCells));
  for (const x of b.shots) if (x.r !== 'miss') out.add(x.c);
  return out;
}

/** Все корабли-объекты, где бы в сообщении они ни лежали. */
function shipObjects(x, out = []) {
  if (Array.isArray(x)) x.forEach((v) => shipObjects(v, out));
  else if (x && typeof x === 'object') {
    if ('len' in x && 'x' in x && 'y' in x) out.push(x);
    Object.values(x).forEach((v) => shipObjects(v, out));
  }
  return out;
}

/** Сыграть партию до конца: оба стреляют по порядку, кто попал — стреляет ещё. Иван бьёт точнее. */
async function playOut(t, room) {
  const order = (fleetCells, from) => {
    const water = Array.from({ length: 100 }, (_, c) => c).filter((c) => !fleetCells.includes(c));
    // Сначала вода «из угла», потом корабли — чтобы были и промахи, и попадания, и потопленные.
    return from === 'ivan' ? [...water.slice(-6), ...fleetCells] : [...water.slice(0, 30), ...fleetCells];
  };
  const plan = {
    0: order(room.match.fleets[1].flatMap(shipCells), 'ivan'),
    1: order(room.match.fleets[0].flatMap(shipCells), 'max'),
  };
  const done = [new Set(), new Set()];
  for (let guard = 0; guard < 400 && !room.match.over; guard++) {
    const s = room.match.turn;
    const u = s === sideOfU(room, IVAN) ? IVAN : MAX;
    // Следующая клетка, которую сервер ещё примет: не стрелянная и не рядом с потопленным.
    const known = t.state(u).match.boards[1 - s];
    const skip = new Set([...known.shots.map((x) => x.c), ...known.around]);
    const c = plan[s].find((x) => !skip.has(x) && !done[s].has(x));
    done[s].add(c);
    await shot(t, u, c);
  }
  assert.ok(room.match.over, 'партия доиграна');
}

test('ЧТО ЗНАЕТ КАЖДЫЙ ТЕЛЕФОН: за всю партию — про чужое поле только свои выстрелы и потопленные корабли', async () => {
  const t = new Table();
  const room = await battle(t);
  await t.start(DIMA);
  t.openRoom(DIMA, room);
  await playOut(t, room);
  const fleets = room.match.fleets;
  for (const [u, me] of [[IVAN, 0], [MAX, 1]]) {
    const foe = 1 - me;
    const foeCells = new Set(fleets[foe].flatMap(shipCells));
    const all = states(t, u).filter((s) => s.match);
    const before = all.filter((s) => !s.match.over);
    assert.ok(before.length > 20, `${u.first_name}: состояний за партию — ${before.length}`);
    for (const s of before) {
      const b = s.match.boards[foe];
      const myShots = new Set(b.shots.map((x) => x.c));
      // Ни одной корабельной клетки, в которую этот игрок не стрелял.
      for (const c of revealed(s, foe)) {
        assert.ok(foeCells.has(c), `${u.first_name}: «корабль» в ${addr(c)}, где его нет`);
        assert.ok(myShots.has(c), `${u.first_name}: увидел ${addr(c)} чужого флота, не стреляв туда`);
      }
      // Корабли соперника в виде — только потопленные, то есть целиком прострелянные.
      for (const ship of b.ships) assert.ok(shipCells(ship).every((c) => myShots.has(c)), `${u.first_name}: живой корабль соперника в виде`);
      // Отметки — только свои выстрелы, ровно как на сервере.
      assert.deepEqual(b.shots.map((x) => x.c), room.match.shots[me].slice(0, b.shots.length).map((x) => x.c));
      // Свой флот — целиком, с начала боя.
      if (s.match.phase === 'battle') assert.deepEqual(s.match.boards[me].ships, fleets[me]);
    }
    // Где бы ни лежали корабли-объекты в любом сообщении до конца партии — только свои и потопленные чужие.
    const mineJson = new Set(fleets[me].map((x) => JSON.stringify(x)));
    for (const s of before) {
      const sunk = new Set(s.match.boards[foe].ships.map((x) => JSON.stringify(x)));
      for (const o of shipObjects(s)) {
        const k = JSON.stringify({ x: o.x, y: o.y, len: o.len, dir: o.dir });
        assert.ok(mineJson.has(k) || sunk.has(k), `${u.first_name}: чужой корабль ${k} в сообщении`);
      }
    }
    // В конце открываются оба флота.
    const last = all.at(-1);
    assert.ok(last.match.over);
    assert.deepEqual(last.match.boards[foe].ships, fleets[foe], 'после партии — чужой флот целиком');
  }
  // Зритель: ни одного корабля до конца партии — только отметки выстрелов.
  const ds = states(t, DIMA).filter((s) => s.match && !s.match.over);
  assert.ok(ds.length > 20);
  for (const s of ds) {
    assert.equal(s.match.mySide, null);
    assert.deepEqual(shipObjects(s), [], 'зрителю — ни одного корабля');
    for (const side of [0, 1]) {
      const shotCells = new Set(room.match.shots[1 - side].map((x) => x.c));
      for (const x of s.match.boards[side].shots) assert.ok(shotCells.has(x.c));
    }
  }
  assert.deepEqual(t.errors, [], 'в журнал ошибок ничего не ушло');
});

test('отказы не выдают поле: «уже стреляли» и «не ваш ход» звучат одинаково — над кораблём и над водой', async () => {
  const t = new Table();
  const room = await battle(t);
  const colsCells = COLS.flatMap(shipCells);
  // Не в свой ход — над кораблём Ивана и над водой.
  const overShip = await shot(t, MAX, ROWS.flatMap(shipCells)[0], { ok: false });
  const overWater = await shot(t, MAX, C('К10'), { ok: false });
  assert.deepEqual({ ...overShip }, { ...overWater, }, 'один и тот же отказ');
  // Уже стреляли — туда, где ранил, и туда, где мимо.
  await shot(t, IVAN, colsCells[0]);
  const again1 = await shot(t, IVAN, colsCells[0], { ok: false });
  await shot(t, IVAN, C('К1'));
  await shot(t, MAX, C('К10'));
  const again2 = await shot(t, IVAN, C('К1'), { ok: false });
  assert.equal(again1.code, 'ALREADY_SHOT');
  assert.deepEqual(again1, again2);
  // Ни один текст отказа за партию не называет клетку.
  for (const u of [IVAN, MAX]) {
    for (const e of t.page(u).inbox.filter((m) => m.t === 'error')) assert.doesNotMatch(e.text, /[А-К](10|[1-9])\b/, e.text);
  }
  assert.equal(room.match.log.length, 3);
});

/**
 * Одна и та же партия по одному сценарию; меняются только флоты. Возвращает
 * всё, что ушло наружу, кроме страницы хозяина меняющегося флота.
 */
async function scenario({ ivanFleet, maxFleet }) {
  const store = new Store(':memory:');
  const clock = new FakeClock();
  const t = new Table({ store, clock, admins: ['404'], battleshipFleetRand: botRandom(11) });
  const room = await lobby(t, { base: 300, inc: 2 });
  await t.start(DIMA);
  t.openRoom(DIMA, room);
  t.openAdmin(OLEG);
  await t.send(IVAN, { t: 'start' });
  // До готовности: Макс пробует «случайно», потом ставит свой флот; Иван — свой.
  await t.send(MAX, { t: 'random' });
  await t.advance(5_000);
  await t.send(IVAN, { t: 'place', ships: ivanFleet });
  await t.send(MAX, { t: 'place', ships: maxFleet });
  await t.send(MAX, { t: 'ready' });
  await t.advance(3_000);
  await t.send(IVAN, { t: 'ready' });
  // Бой. Иван стреляет первым (жребий в тестах — хост).
  await t.send(IVAN, { t: 'visible', visible: false }); // чтобы «ваш ход» пошёл в личку
  for (const a of ['А10', 'А1', 'А2', 'В5']) await shot(t, IVAN, C(a)); // убил, ранил, ранил, ранил
  await shot(t, IVAN, C('Е6')); // мимо
  await shot(t, IVAN, C('Д1'), { ok: false }); // не в свой ход (в одном флоте там корабль, в другом — вода)
  await t.send(MAX, { t: 'visible', visible: false });
  for (const a of ['А1', 'Б1']) await shot(t, MAX, C(a)); // ранил, ранил
  await shot(t, MAX, C('К10')); // мимо
  await shot(t, MAX, C('Г5'), { ok: false }); // не в свой ход
  await shot(t, IVAN, C('А1'), { ok: false }); // уже стрелял — ранил
  await shot(t, IVAN, C('Е6'), { ok: false }); // уже стрелял — мимо
  await shot(t, IVAN, C('Б10'), { ok: false }); // рядом с потопленным
  await t.advance(7_000);
  await shot(t, IVAN, C('И9')); // мимо

  // Перезапуск посреди боя: расстановки на месте, вид — по-прежнему без чужого.
  t.app.save(room);
  const out1 = collect(t, room);
  const t2 = new Table({ store, clock, admins: ['404'], battleshipFleetRand: botRandom(11) });
  t2.app.load();
  const back = t2.app.roomByCode(room.code);
  assert.deepEqual(back.match.fleets, room.match.fleets, 'после перезапуска обе расстановки на месте');
  for (const u of [IVAN, MAX, DIMA]) {
    await t2.start(u);
    t2.openRoom(u, back);
  }
  t2.openAdmin(OLEG);
  await shot(t2, MAX, C('Е10')); // мимо
  await shot(t2, IVAN, C('Ж10')); // мимо
  const out2 = collect(t2, back);
  store.close();
  return { first: out1, second: out2, room: back };
}

/** Всё, что видно снаружи сервера, с подменой случайных кодов на постоянные. */
function collect(t, room) {
  const codes = [room.code, t.group?.code].filter(Boolean);
  const norm = (x) => {
    let s = JSON.stringify(x);
    codes.forEach((c, i) => { s = s.split(c).join(`<код${i}>`); });
    return JSON.parse(s);
  };
  const inbox = (u) => norm(t.pages.get(String(u.id))?.inbox ?? []);
  const tg = [...t.tg.messages.values()].map((m) => ({ chat: m.chatId, text: m.text, kb: m.markup ?? null, deleted: !!m.deleted }));
  return {
    ivan: inbox(IVAN),
    max: inbox(MAX),
    dima: inbox(DIMA),
    admin: inbox(OLEG),
    group: norm(tg.filter((m) => m.chat === String(t.chatId))),
    dmIvan: norm(tg.filter((m) => m.chat === '101')),
    dmMax: norm(tg.filter((m) => m.chat === '202')),
    dmDima: norm(tg.filter((m) => m.chat === '303')),
    errors: t.errors.map(String),
  };
}

// Два флота Макса: в клетках, куда стрелял Иван (А10 убит, А1-А2 и В5 ранены,
// Е6, И9, Ж10 — мимо), — одно и то же; остальное расставлено по-разному.
// Однопалубный в Д1 (там Иван «пытался» выстрелить не в свой ход) — только у первого.
const MAX_A = COLS;
const MAX_B = fleet(`
  X . X . . . . X . .
  X . X . . . . X . .
  X . X . . . . . . .
  X . . . . . . . . X
  . . X . . . . . . .
  X . X . . . . X . .
  X . . . . . . . . .
  X . X . . . . . . X
  . . X . . . . . . .
  X . . . . . . . . .
`);
// Третий флот Макса: совпадает только то, что Иван узнал выстрелами. Раненый у А1-А2 —
// трёхпалубный, а не четырёхпалубный; раненый в В5 — четырёхпалубный поперёк; всё остальное — в
// других местах.
const MAX_C = fleet(`
  X . . . . . . X X X
  X . . . . X . . . .
  X . . . . . . X X .
  . . . . . . . . . .
  . . X X X X . . . X
  . . . . . . . . . X
  . . . . . . . X . .
  . . X X . X . . . .
  . . . . . . . . . .
  X . . . . . . . . .
`);
// Два флота Ивана: Макс стрелял в А1, Б1 (ранил), К10, Е10 (мимо), «пытался» в Г5.
const IVAN_A = ROWS;
const IVAN_B = fleet(`
  X X X X . X X X . X
  . . . . . . . . . .
  X X X . X X . X X .
  . . . . . . . . . .
  . . . . . . . . . .
  . . . . . . . . . .
  X X . . . . . . . .
  . . . . X . X . X .
  . . . . . . . . . .
  . . . . . . . . . .
`);
// Третий флот Ивана: раненый в А1-Б1 — трёхпалубный, всё остальное — в других местах.
const IVAN_C = fleet(`
  X X X . X . . X X .
  . . . . X . . . . .
  X . . . X . . . . .
  X . . . . . . . . X
  X . X X . . . . . .
  X . . . . . . . X .
  . . . . . . X . . .
  . . . . X . X . . .
  X . . . . . . . . .
  . . . . . . . . . .
`);

test('ПОДМЕНА ФЛОТА: нераскрытая часть флота не влияет ни на одно сообщение наружу — до и после перезапуска', async () => {
  for (const f of [MAX_B, MAX_C, IVAN_B, IVAN_C]) assert.ok(checkFleet(f).ok, 'подменные флоты — по правилам');
  // Общих кораблей у основного и третьего флота — только раскрытый выстрелами однопалубный А10 (у Макса).
  const common = (a, b) => a.filter((x) => b.some((y) => JSON.stringify(x) === JSON.stringify(y))).length;
  assert.equal(common(MAX_A, MAX_C), 1);
  assert.equal(common(IVAN_A, IVAN_C), 0);
  const base = await scenario({ ivanFleet: IVAN_A, maxFleet: MAX_A });
  const swaps = [
    ['флот Макса (B)', await scenario({ ivanFleet: IVAN_A, maxFleet: MAX_B }), 'max'],
    ['флот Макса (C)', await scenario({ ivanFleet: IVAN_A, maxFleet: MAX_C }), 'max'],
    ['флот Ивана (B)', await scenario({ ivanFleet: IVAN_B, maxFleet: MAX_A }), 'ivan'],
    ['флот Ивана (C)', await scenario({ ivanFleet: IVAN_C, maxFleet: MAX_A }), 'ivan'],
  ];
  assert.equal(base.room.match.over, null, 'партия не кончилась: флоты закрыты');

  for (const part of ['first', 'second']) {
    const a = base[part];
    for (const [what, run, owner] of swaps) {
      assert.equal(run.room.match.log.length, base.room.match.log.length, `${what}: партия та же`);
      const b = run[part];
      // У всех, кроме хозяина подменённого флота, — дословно то же: страницы, пульт, группа, личка, журнал.
      const others = owner === 'max' ? ['ivan', 'dima', 'admin', 'group', 'dmIvan', 'dmDima', 'errors'] : ['max', 'dima', 'admin', 'group', 'dmMax', 'dmDima', 'errors'];
      for (const k of others) assert.deepEqual(b[k], a[k], `${part}: «${k}» зависит от того, где стоит ${what}`);
      // Сам тест не пустой: хозяин флота свой флот видит, и разницу — тоже.
      assert.notDeepEqual(b[owner], a[owner], `${what}: хозяин видит свой флот`);
    }
    for (const k of ['ivan', 'max', 'dima', 'admin', 'group', 'dmIvan', 'dmMax']) assert.ok(a[k].length > 0, `${part}: ${k} — пусто, сравнивать нечего`);
    assert.deepEqual(a.errors, []);
  }
  // Во время расстановки соперник «расставляет» или «готов» — одним признаком.
  const ivanSeen = base.first.ivan.filter((m) => m.t === 'state' && m.state.match?.phase === 'place');
  assert.ok(ivanSeen.length >= 3);
  for (const m of ivanSeen) {
    const foe = m.state.match.boards[1];
    assert.deepEqual(foe.ships, []);
    assert.deepEqual(foe.shots, []);
    assert.equal(typeof foe.ready, 'boolean');
  }
  assert.ok(ivanSeen.some((m) => m.state.match.boards[1].ready === false) && ivanSeen.some((m) => m.state.match.boards[1].ready === true));
});

test('карточка, итоги и «ваш ход» не называют расстановок; итоги — только после конца', async () => {
  const t = new Table();
  const room = await battle(t);
  await t.send(IVAN, { t: 'visible', visible: false });
  await shot(t, IVAN, C('А10'));
  await shot(t, IVAN, C('К1'));
  await shot(t, MAX, C('Б1'));
  await shot(t, MAX, C('К10'));
  const toIvan = [...t.tg.messages.values()].filter((m) => m.chatId === '101' && /Ваш ход/.test(m.text)).at(-1);
  assert.ok(toIvan, 'Ивану напомнили');
  assert.match(toIvan.text, /Соперник: К10 — мимо/, 'куда выстрелили по ЕГО полю');
  const card = t.tg.message(room.ui.tableMessageId).text;
  assert.match(card, /Идёт бой/);
  assert.doesNotMatch(card, /[А-К](10|[1-9])\b|палуб|ранил|убил|попал/);
  for (const m of t.tg.messages.values()) {
    if (m.chatId !== String(t.chatId)) continue;
    assert.doesNotMatch(m.text, /[А-К](10|[1-9])\b|палуб|ИТОГИ/, 'в группе до конца партии — ни клеток, ни итогов');
  }
  await t.send(IVAN, { t: 'finish' });
  const results = [...t.tg.messages.values()].filter((m) => m.chatId === String(t.chatId) && /ИТОГИ · МОРСКОЙ БОЙ/.test(m.text));
  assert.equal(results.length, 1);
  assert.doesNotMatch(results[0].text, /[А-К](10|[1-9])\b|палуб/);
});

test('«Поделиться» итогом — без расстановок; до конца партии — нечем делиться', async () => {
  const t = new Table();
  const room = await battle(t);
  await t.send(IVAN, { t: 'share' });
  assert.equal(t.lastError(IVAN).code, 'NOT_SHAREABLE');
  for (const c of COLS.flatMap(shipCells)) await shot(t, IVAN, c);
  const g = t.app.rooms.get(room.code);
  const card = (await import('./games/battleship/index.js')).default.shareText(g, '101', { botUsername: 'ChipTableBot' });
  assert.match(card.plain, /Победил Иван — весь флот соперника потоплен, 20 выстрелов/);
  assert.doesNotMatch(card.plain + card.html, /[А-К](10|[1-9])\b|"len"/);
});

test('«Сыграть ещё» и «+ Новое лобби» не переносят расстановок', async () => {
  const t = new Table();
  const room = await battle(t);
  for (const c of COLS.flatMap(shipCells)) await shot(t, IVAN, c);
  await t.send(MAX, { t: 'next' });
  assert.equal(room.match.no, 2);
  assert.deepEqual(room.match.fleets, [null, null]);
  assert.deepEqual(room.match.ready, [false, false]);
  for (const u of [IVAN, MAX]) {
    const s = t.state(u);
    assert.equal(s.match.phase, 'place');
    assert.deepEqual(shipObjects(s), [], `${u.first_name}: в новой партии кораблей ещё нет`);
  }
  // «+ Новое лобби» — со страницы, открытой из хаба: новый стол, та же игра и часы, без флотов.
  await t.send(IVAN, { t: 'again', reqId: 'a1' });
  const fresh = t.battleship;
  assert.notEqual(fresh.code, room.code);
  assert.equal(fresh.match, null);
  assert.ok(!JSON.stringify(fresh).includes('"len"'), 'в новом столе — ни одного корабля');
});

test('срок расстановки: не успел — флот расставит сервер, и бой начнётся; первый выстрел не сделан — отмена', async () => {
  const t = new Table({ battleshipFleetRand: botRandom(4) });
  const room = await duel(t, { base: 0 });
  await t.send(IVAN, { t: 'place', ships: ROWS });
  await t.send(IVAN, { t: 'ready' });
  await t.advance(PLACE_MS - 1_000);
  assert.equal(room.match.phase, 'place');
  await t.advance(1_000);
  assert.equal(room.match.phase, 'battle');
  assert.ok(checkFleet(room.match.fleets[1]).ok, 'Максу флот расставлен по правилам');
  assert.match(t.state(MAX).room.notice, /Срок расстановки вышел/);
  await t.advance(FIRST_MS);
  assert.equal(room.match.over.kind, 'aborted');
  assert.equal(room.history.at(-1).aborted, true);
});

test('часы: время вышло — проигрыш того, чей ход; сдача; короткая партия очков не даёт', async () => {
  const t = new Table({ store: new Store(':memory:') });
  const room = await battle(t, { settings: { base: 180 } });
  await shot(t, IVAN, C('К1'));
  await shot(t, MAX, C('К10'));
  await t.advance(179_000);
  assert.equal(room.match.over, null);
  await t.advance(1_000);
  assert.deepEqual(room.match.over, { winner: 1, kind: 'time' });
  assert.equal(t.app.store.ratingOf(202, 'battleship'), null, 'два выстрела — партия короткая');
  assert.match(room.rated[`${room.code}#1`].why, /короче/);
  t.app.store.close();
});

test('/battleship в группе: лобби одной командой, повторно — ещё одно (дуэль)', async () => {
  const t = new Table();
  await t.start(IVAN);
  await t.cmd(IVAN, '/battleship');
  await t.cmd(IVAN, '/battleship');
  const lobbies = t.app.liveRooms(String(t.chatId)).filter((r) => r.game === 'battleship' && r.status === 'lobby');
  assert.equal(lobbies.length, 2);
  assert.equal(t.tg.message(lobbies[0].ui.tableMessageId).markup.inline_keyboard[0][0].text, '🚢 Присоединиться');
});
