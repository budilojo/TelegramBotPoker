'use strict';
/**
 * Бот морского боя (games/battleship/bot.js): ходит только законно, уровни
 * различаются, и — главное — тайна флота действует и для него.
 *
 *   ПРИВАТНОСТЬ БОТА проверяется тремя способами:
 *     1. Во всех партиях этого файла `decide` получает вместо комнаты
 *        ловушку (`POISON`), которая падает от любого обращения: бот решает
 *        только по своему виду.
 *     2. Через хаб перехватывается всё, что видит `decide`: в виде нет ни
 *        одного живого корабля соперника — только потопленные.
 *     3. Один и тот же вид при разных нераскрытых флотах — один и тот же
 *        выстрел.
 *   «На зубы» — `node tools/battleship-teeth.mjs` (утечка флота в вид бота,
 *   бот подглядывает в комнату).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, botRandom, user } from './harness.js';
import game from './games/battleship/index.js';
import bot, { chooseShot, decideFromView, LEVELS } from './games/battleship/bot.js';
import * as B from './games/battleship/rules.js';
import { battleshipView } from './games/battleship/view.js';
import { randomFleet, shipCells } from './games/battleship/board.js';
import { ROWS, COLS } from './battleship.fixtures.js';

const IVAN = user(101, 'Иван');

/** Комната-ловушка: бот не вправе в неё заглядывать — любое обращение роняет тест. */
const POISON = new Proxy({}, {
  get(_, k) { throw new Error(`бот заглянул в комнату: room.${String(k)}`); },
  has(_, k) { throw new Error(`бот заглянул в комнату: ${String(k)} in room`); },
  ownKeys() { throw new Error('бот перебрал поля комнаты'); },
});

/** Заглушка ядра для `handle`: ход идёт тем же путём, что у человека. */
function stubApp(seed) {
  return {
    clock: { now: () => 0 },
    battleshipRand: botRandom(seed),
    battleshipFleetRand: botRandom(seed + 1),
    person: (u) => ({ id: String(u.id), tgId: 0, name: u.name, dm: null }),
    dealOpts() { return { rand: this.battleshipRand, fleetRand: this.battleshipFleetRand }; },
    afterChange() {}, afterAction() {}, afterDeal() {}, finishUp() {},
  };
}

/** Решение бота ровно так, как его зовёт ядро, — но комната подменена ловушкой. */
const decide = (view, level, kind, rng) => bot.decide({ room: POISON, view, me: { id: 'x', bot: { level } }, wait: { kind }, rng });

/** Всё, что живо во флоте `ships` при выстрелах `shots`, — строками для поиска в виде. */
const liveShips = (ships, shots) => {
  const hit = new Set(shots.map((x) => x.c));
  return ships.filter((s) => !shipCells(s).every((c) => hit.has(c))).map((s) => JSON.stringify({ x: s.x, y: s.y, len: s.len, dir: s.dir }));
};

/**
 * Партия бот-против-бота через `handle` модуля: расстановка, «готов», бой.
 * Возвращает число выстрелов каждого и отказы сервера.
 */
async function botVsBot(levels, seed) {
  const app = stubApp(seed);
  const rng = botRandom(seed + 2);
  const ids = ['1', '2'];
  const room = B.createRoom({ chatId: 1, host: { id: 1, name: 'A' }, base: 0 });
  B.addPlayer(room, { id: 2, name: 'B' });
  const refused = [];
  const run = (uid, msg) => game.handle({
    app, session: { user: { id: uid, name: uid } }, room, uid, msg,
    refuse: (code) => refused.push(`${uid} ${JSON.stringify(msg).slice(0, 80)}: ${code}`), push() {},
  });
  await run('1', { t: 'start' });
  for (let guard = 0; B.live(room) && guard < 500 && !refused.length; guard++) {
    const w = game.waiting(room)[0];
    const uid = w.id;
    const view = battleshipView(room, uid, { now: 0 });
    // Что видит бот: ни одного живого корабля соперника.
    const m = room.match;
    const foe = 1 - m.ids.indexOf(uid);
    if (m.fleets[foe]) {
      // Свой флот бота из поиска убран: его корабль может совпасть с чужим по клеткам.
      const copy = JSON.parse(JSON.stringify(view));
      copy.match.boards[1 - foe].ships = [];
      const seen = JSON.stringify(copy);
      for (const s of liveShips(m.fleets[foe], m.shots[1 - foe])) assert.ok(!seen.includes(s), `в виде бота живой корабль соперника ${s}`);
    }
    const msg = decide(view, levels[ids.indexOf(uid)], w.kind, rng);
    assert.ok(msg, `бот не нашёл хода (${w.kind})`);
    await run(uid, msg);
  }
  return { room, refused, shots: room.match.shots.map((s) => s.length) };
}

test('2000 партий бот-против-бота через handle — ни одного отказа сервера; каждая доиграна до конца', async () => {
  const refused = [];
  for (let g = 0; g < 2000; g++) {
    const levels = [g % 5, Math.floor(g / 5) % 5];
    const r = await botVsBot(levels, 1000 + g);
    refused.push(...r.refused);
    if (refused.length) break;
    assert.equal(r.room.match.over?.kind, 'fleet', `партия ${g} доиграна до потопления флота`);
  }
  assert.deepEqual(refused, []);
});

/**
 * Сколько выстрелов уровню нужно, чтобы потопить случайный флот. Флоты одни
 * и те же для всех уровней (сравнение попарно), всё на сериях — без случая.
 */
function shotsToWin(level, games) {
  const out = [];
  for (let g = 0; g < games; g++) {
    const fr = botRandom(7000 + g);
    const rng = botRandom(9000 + g);
    const room = B.createRoom({ chatId: 1, host: { id: 1, name: 'A' }, base: 0 });
    B.addPlayer(room, { id: 2, name: 'B' });
    B.startGame(room, '1', { rand: () => 0.1 });
    B.place(room, '1', randomFleet(fr));
    B.place(room, '2', randomFleet(fr));
    B.ready(room, '1');
    B.ready(room, '2');
    let n = 0;
    while (!room.match.over) {
      room.match.turn = 0; // стреляет только бот: считаем его выстрелы до победы
      const msg = decide(battleshipView(room, '1', { now: 0 }), level, 'move', rng);
      const r = B.fire(room, '1', msg.cell, 0, msg.shot);
      assert.ok(!r.error, `уровень ${level}: отказ ${r.error}`);
      n++;
    }
    out.push(n);
  }
  return out;
}

test('уровни значат: каждый следующий топит флот в среднем за меньшее число выстрелов (600 одинаковых флотов)', (t) => {
  const N = 600;
  const runs = LEVELS.map((_, l) => shotsToWin(l, N));
  const mean = runs.map((a) => a.reduce((s, x) => s + x, 0) / N);
  const said = mean.map((x, l) => `${LEVELS[l].name} ${x.toFixed(1)}`).join(' · ');
  t.diagnostic(`выстрелов до победы в среднем: ${said}`);
  for (let l = 1; l < LEVELS.length; l++) assert.ok(mean[l] < mean[l - 1], `уровень ${l} не лучше ${l - 1}: ${said}`);
  assert.ok(mean[1] < mean[0] - 10, `добивание раненых — большой шаг: ${said}`);
  assert.ok(mean[4] < mean[1] - 2, `адмирал заметно сильнее матроса: ${said}`);
});

test('один и тот же вид при разных нераскрытых флотах — один и тот же выстрел (на всех уровнях)', () => {
  // Две партии: у Макса по-разному стоят корабли, но Иван стрелял в клетки,
  // где у обоих флотов одно и то же (вода), — вид Ивана одинаков.
  const build = (maxFleet) => {
    // Код стола один: «Боцман» выбирает шахматную сетку по коду — это часть вида.
    const room = B.createRoom({ chatId: 1, host: { id: 1, name: 'A' }, base: 0, code: 'SAME' });
    B.addPlayer(room, { id: 2, name: 'B' });
    B.startGame(room, '1', { rand: () => 0.1 });
    B.place(room, '1', ROWS);
    B.place(room, '2', maxFleet);
    B.ready(room, '1');
    B.ready(room, '2');
    return room;
  };
  const a = build(ROWS);
  const b = build(COLS);
  const occupied = new Set([...ROWS, ...COLS].flatMap(shipCells));
  const water = Array.from({ length: 100 }, (_, c) => c).filter((c) => !occupied.has(c)).slice(0, 3);
  for (const c of water) {
    for (const room of [a, b]) {
      room.match.turn = 0;
      assert.equal(B.fire(room, '1', c, 0).r, 'miss');
    }
  }
  const va = battleshipView(a, '1', { now: 0 });
  const vb = battleshipView(b, '1', { now: 0 });
  a.match.turn = 0;
  b.match.turn = 0;
  for (let level = 0; level < LEVELS.length; level++) {
    for (let seed = 1; seed <= 3; seed++) {
      const x = decide(battleshipView(a, '1', { now: 0 }), level, 'move', botRandom(seed));
      const y = decide(battleshipView(b, '1', { now: 0 }), level, 'move', botRandom(seed));
      assert.deepEqual(x, y, `уровень ${level}, seed ${seed}`);
    }
  }
  assert.deepEqual(va.match.boards[1], vb.match.boards[1], 'виды Ивана одинаковы — значит, и решение не зависит от флота Макса');
});

test('добивание: попал — бьёт рядом; два попадания в ряд — продолжает линию', () => {
  const view = (shots, left = { 4: 1, 3: 2, 2: 3, 1: 4 }) => ({
    room: { code: 'T' },
    legal: { canFire: true },
    match: { mySide: 0, shots: shots.length, boards: [{ ships: [] }, { shots, around: [], left }] },
  });
  for (let level = 1; level < LEVELS.length; level++) {
    for (let seed = 1; seed <= 5; seed++) {
      const one = chooseShot(view([{ c: 44, r: 'hit' }]), level, botRandom(seed));
      assert.ok([34, 43, 45, 54].includes(one), `уровень ${level}: после попадания в 44 — сосед, а не ${one}`);
      const two = chooseShot(view([{ c: 44, r: 'hit' }, { c: 45, r: 'hit' }]), level, botRandom(seed));
      assert.ok([43, 46].includes(two), `уровень ${level}: 44 и 45 — продолжить ряд, а не ${two}`);
    }
  }
  // Наугад — не обязательно рядом, но всегда в неизвестную клетку.
  const any = chooseShot(view([{ c: 44, r: 'hit' }]), 0, botRandom(1));
  assert.notEqual(any, 44);
});

test('стрелять некуда или не его ход — бот молчит; расстановка: сначала флот, потом «готов»', () => {
  assert.equal(decideFromView({ match: { mySide: 0, over: null, shots: 0, boards: [{}, {}] }, legal: { myTurn: false } }, { kind: 'move' }, 2, botRandom(1)), null);
  const placing = { canPlace: true, canReady: false, match: { mySide: 0, boards: [{ ships: [] }, {}] } };
  const first = decideFromView(placing, { kind: 'place' }, 2, botRandom(1));
  assert.equal(first.t, 'place');
  assert.equal(first.ships.length, 10);
  const placed = { canPlace: true, canReady: true, match: { mySide: 0, boards: [{ ships: first.ships }, {}] } };
  assert.deepEqual(decideFromView(placed, { kind: 'place' }, 2, botRandom(1)), { t: 'ready' });
  assert.deepEqual(bot.fallback(placing, { kind: 'place' }), { t: 'random' }, 'запасной ход расстановки — расставит сервер');
});

/* ---------------------------------------------------- через хаб, как человек */

/** Перехват `decide`: что бот видит, — и комнату вместо настоящей ловушка. */
function spyBot() {
  const seen = [];
  const orig = game.bot.decide;
  game.bot.decide = (args) => {
    seen.push({ view: JSON.parse(JSON.stringify(args.view)), me: args.me.id });
    return orig({ ...args, room: POISON });
  };
  return { seen, restore: () => { game.bot.decide = orig; } };
}

async function vsBot(t, settings) {
  await t.start(IVAN);
  t.openSolo(IVAN);
  await t.send(IVAN, { t: 'play', game: 'battleship', settings });
  return t.app.soloOf('101');
}

async function until(t, cond, what, tries = 80, step = 1_000) {
  for (let i = 0; i < tries && !cond(); i++) await t.advance(step);
  assert.ok(cond(), `не дождались: ${what}`);
}

/** Иван стреляет по порядку в клетки, о которых не знает; бот отвечает сам. */
async function playOut(t, room) {
  const me = room.match.ids.indexOf('101');
  for (let guard = 0; guard < 400 && !room.match.over; guard++) {
    if (room.match.turn !== me) {
      const n = room.match.log.length;
      await until(t, () => room.match.log.length > n || room.match.over, 'выстрел бота');
      continue;
    }
    const v = t.state(IVAN);
    const known = new Set([...v.match.boards[1 - me].shots.map((x) => x.c), ...v.match.boards[1 - me].around]);
    const c = Array.from({ length: 100 }, (_, i) => i).find((i) => !known.has(i));
    await t.send(IVAN, { t: 'fire', cell: c, shot: v.match.shots });
  }
  assert.ok(room.match.over, 'партия доиграна');
}

test('морской бой против бота из лички: бот сам расставляет, стреляет только по своему виду; человек видит только своё', async () => {
  const spy = spyBot();
  try {
    const t = new Table({ botRng: botRandom(4) });
    const room = await vsBot(t, { level: 4, side: 'white', base: 0 });
    assert.ok(room.solo);
    assert.equal(room.game, 'battleship');
    const b = room.players.find((p) => p.bot);
    assert.ok(b, 'второй — бот');
    assert.equal(b.name, `🤖 ${LEVELS[4].name}`);
    // Бот расставляет сам, через тот же handle, и запирает флот.
    await until(t, () => room.match.ready[room.match.ids.indexOf(b.id)], 'бот готов');
    assert.equal(room.match.phase, 'place', 'бой не начат, пока человек не готов');
    await t.send(IVAN, { t: 'place', ships: ROWS });
    await t.send(IVAN, { t: 'ready' });
    assert.equal(room.match.phase, 'battle');
    assert.equal(room.match.turn, room.match.ids.indexOf('101'), '«Я» — первым стреляет человек');
    await playOut(t, room);
    assert.deepEqual(t.errors, [], 'бот ни разу не заглянул в комнату и не получил отказа');
    // Всё, что видел бот: ни одного живого корабля человека — только потопленные.
    assert.ok(spy.seen.length > 20, `бот решал ${spy.seen.length} раз`);
    for (const { view } of spy.seen) {
      const mine = view.match.mySide;
      const foe = view.match.boards[1 - mine];
      const shot = new Set(foe.shots.map((x) => x.c));
      for (const s of foe.ships) assert.ok(shipCells(s).every((c) => shot.has(c)), `в виде бота корабль, который он не потопил: ${JSON.stringify(s)}`);
    }
    // Телефон человека до конца партии не получал ни одного живого корабля бота.
    const bs = room.match.ids.indexOf(b.id);
    const states = t.page(IVAN).inbox.filter((m) => m.t === 'state' && m.state.game === 'battleship' && m.state.match && !m.state.match.over);
    for (const m of states) {
      const shots = m.state.match.boards[bs].shots;
      const json = JSON.stringify(m);
      for (const s of liveShips(room.match.fleets[bs], shots)) assert.ok(!json.includes(s), `телефон Ивана получил живой корабль бота ${s}`);
    }
    // Партия с ботом в рейтинг не идёт.
    assert.equal(t.app.store.ratingOf?.(101, 'battleship') ?? null, null);
  } finally {
    spy.restore();
  }
});

test('«Бот» стреляет первым сам; человек не стреляет за бота; «Ещё партия» и «Сыграть ещё» работают', async () => {
  const spy = spyBot();
  try {
    const t = new Table({ botRng: botRandom(9) });
    const room = await vsBot(t, { level: 1, side: 'black', base: 300 });
    assert.equal(room.settings.base, 300);
    assert.equal(room.settings.first, 'guest');
    await t.send(IVAN, { t: 'random' });
    await t.send(IVAN, { t: 'ready' });
    // Шаг 100 мс: бой начинается, когда бот запер флот, а стреляет он не раньше
    // чем через 700 мс. С шагом в секунду бот успевал выстрелить внутри того же
    // шага, промахнуться — и ход честно переходил к человеку (падение
    // «expected bot1, actual 101», разбор — docs/next-release/reports/check.md).
    await until(t, () => room.match.phase === 'battle', 'бой', 800, 100);
    const bs = room.match.ids.findIndex((id) => id !== '101');
    assert.equal(room.match.first, bs, 'первым стреляет бот');
    assert.equal(room.match.turn, bs, 'первым стреляет бот');
    // Человек пытается выстрелить за бота, назвавшись им, — отказ.
    await t.send(IVAN, { t: 'fire', cell: 0, uid: room.match.ids[bs], id: room.match.ids[bs], side: bs });
    assert.equal(t.lastError(IVAN).code, 'NOT_YOUR_TURN');
    assert.equal(room.match.log.length, 0);
    await until(t, () => room.match.log.length > 0, 'бот выстрелил');
    await playOut(t, room);
    // «Ещё партия» — новая расстановка у обоих; бот снова расставляет сам, и снова первым стреляет он.
    await t.send(IVAN, { t: 'next' });
    assert.equal(room.match.no, 2);
    assert.deepEqual(room.match.fleets.filter(Boolean), [], 'флоты в новую партию не переходят');
    await t.send(IVAN, { t: 'random' });
    await t.send(IVAN, { t: 'ready' });
    await until(t, () => room.match.phase === 'battle', 'бой второй партии', 800, 100);
    const bot2 = room.players.find((p) => p.bot).id;
    assert.equal(room.match.ids[room.match.first], bot2, 'и во второй — первым бот');
    assert.equal(room.match.log.length, 0, 'бой только начался — выстрелов ещё нет');
    assert.equal(room.match.ids[room.match.turn], bot2, 'и во второй — первым бот');
    // «Сыграть ещё» с итогов — новый стол с тем же уровнем, часами и очерёдностью.
    await t.send(IVAN, { t: 'finish' });
    await t.send(IVAN, { t: 'again' });
    const next = t.app.soloOf('101');
    assert.notEqual(next.code, room.code);
    assert.equal(next.game, 'battleship');
    assert.equal(next.players.find((p) => p.bot).bot.level, 1);
    assert.equal(next.settings.base, 300);
    assert.equal(next.settings.first, 'guest');
    assert.equal(next.match.phase, 'place');
    assert.deepEqual(t.errors, []);
  } finally {
    spy.restore();
  }
});

test('«кто первый» не берётся из лобби в группе: там только жребий', async () => {
  const t = new Table();
  await t.start(IVAN);
  await t.cmd(IVAN, '/play');
  t.openHub(IVAN);
  await t.send(IVAN, { t: 'create', game: 'battleship', settings: { base: 0, first: 'host', side: 'white' }, reqId: 'b1' });
  const room = t.battleship;
  assert.equal(room.settings.first, undefined);
});
