/**
 * Фаззер игр через хаб (аудит, фаза 3).
 *
 *   node --disable-warning=ExperimentalWarning tools/fuzz-games.mjs [игра|all] [шагов] [первое_зерно] [шагов_на_стол]
 *
 * Стол — настоящий: хаб, страницы с подписью, заглушка Telegram, поддельные
 * часы. Каждый шаг — одно из трёх:
 *
 *   - ЗАКОННЫЙ ход того, кого ждёт игра (решение бота по ЕГО виду; в шахматах
 *     и шашках — случайный ход из `legal` его вида);
 *   - ВРАЖДЕБНОЕ сообщение от случайной страницы (игрок, хост, зритель):
 *     любой тип, мусорные параметры, устаревший seq/ply, чужие поля «кто»;
 *   - СОБЫТИЕ СРЕДЫ: часы вперёд, перезапуск (сохранить → поднять),
 *     обслуживание, выход из группы, удаление, передача хоста, пауза,
 *     переподключение, новая партия, «завершить».
 *
 * После КАЖДОГО шага — инварианты (общие и игры). Падение печатает игру,
 * зерно и шаг: `node tools/fuzz-games.mjs <игра> <шаг+1> <зерно> <шаг+1>`
 * повторяет его один в один.
 */
import assert from 'node:assert/strict';
import { Table, user, seededDecks, durakDecks, colorsDecks, botRandom } from '../bot/harness.js';
import { seededRng } from '../bot/deck.js';
import { GAMES } from '../bot/games/index.js';
import * as CB from '../bot/games/chess/board.js';
import * as KB from '../bot/games/checkers/board.js';
import { freshDeck as colorsFresh } from '../bot/games/colors/cards.js';
import { checkFleet } from '../bot/games/battleship/board.js';
import { beats as durakBeats } from '../bot/games/durak/cards.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

/* ---------------------------------------------------------- враждебное */

const JUNK = [
  null, undefined, 0, 1, -1, 2, 3, 7, 9, 99, 1e9, -1e9, 0.5, NaN, Infinity, -Infinity, '', '0', 'abc', '__proto__',
  true, false, [], [1, 2], {}, { x: 1 }, 'AS', '6S', '10H', 'R5', 'WC', 'WF', 'e2', 'e4', 'e7', 'e8', 'c3', 'd4',
  'q', 'n', 'K', 'white', 'black', 'w', 'b', 'R', 'G', 'Y', 'B', 'x'.repeat(300), 2 ** 53, -0, '1e3', ' 5 ', [[0, 0, 1, 'h']],
];
const PARAMS = ['action', 'amount', 'seq', 'card', 'target', 'color', 'to', 'from', 'promo', 'ply', 'path', 'die', 'turn',
  'cell', 'ships', 'shot', 'pot', 'role', 'lesson', 'step', 'stacking', 'variant', 'turnSeconds', 'seat', 'side', 'base',
  'inc', 'startingStack', 'smallBlind', 'bigBlind', 'cards', 'blindMode', 'levelMinutes', 'id', 'uid', 'by'];
const TYPES = {
  poker: ['sit', 'leave', 'start', 'act', 'next', 'settings', 'role', 'kick', 'rebuy', 'host', 'pause', 'resume', 'undo', 'finish', 'pick', 'potNext', 'potBack', 'confirm'],
  durak: ['sit', 'leave', 'start', 'next', 'attack', 'defend', 'transfer', 'take', 'pass', 'settings', 'kick', 'host', 'abort', 'finish'],
  colors: ['sit', 'leave', 'start', 'next', 'play', 'draw', 'pass', 'shout', 'catch', 'settings', 'kick', 'host', 'abort', 'finish'],
  chess: ['sit', 'leave', 'start', 'next', 'move', 'resign', 'abort', 'draw', 'decline', 'takeback', 'declinetb', 'settings', 'kick', 'host', 'finish'],
  checkers: ['sit', 'leave', 'start', 'next', 'move', 'resign', 'abort', 'draw', 'decline', 'takeback', 'declinetb', 'settings', 'kick', 'host', 'finish'],
  nardy: ['sit', 'leave', 'start', 'next', 'roll', 'move', 'undo', 'end', 'resign', 'abort', 'settings', 'kick', 'host', 'finish'],
  battleship: ['sit', 'leave', 'start', 'next', 'place', 'random', 'ready', 'fire', 'resign', 'abort', 'settings', 'kick', 'host', 'finish'],
};

function hostile(rnd, game) {
  const pick = (a) => a[rnd(a.length)];
  const types = TYPES[game];
  // Редкие типы, которые заканчивают стол, — пореже, иначе фаззер всё время в лобби.
  let t = pick(types);
  if ((t === 'finish' || t === 'kick' || t === 'leave') && rnd(4)) t = pick(types);
  const msg = { t };
  const n = rnd(5);
  for (let i = 0; i < n; i++) msg[pick(PARAMS)] = pick(JUNK);
  return msg;
}

/**
 * «Правдоподобный» ход: тип — из игры, значения — настоящие (свои карты,
 * верный seq/ply, существующие клетки и цели), но выбранные наугад. Он
 * проходит входные проверки и упирается в САМИ правила: можно ли этой картой,
 * в эту клетку, сейчас.
 */
const SQUARES = [];
for (const f of 'abcdefgh') for (let r = 1; r <= 8; r++) SQUARES.push(`${f}${r}`);
function plausible(rnd, game, view) {
  const pick = (a) => a[rnd(a.length)];
  const mine = view?.me?.cards || [];
  const t = pick(TYPES[game]);
  const msg = { t, seq: view?.seq, ply: view?.match?.plies, turn: view?.match?.turnNo ?? view?.match?.turns, shot: view?.match?.shots };
  if (mine.length) msg.card = pick(mine);
  msg.target = rnd(7) - 1;
  msg.color = pick(['R', 'Y', 'G', 'B', 'W']);
  msg.seat = rnd(7);
  msg.pot = rnd(3);
  if (game === 'chess' || game === 'checkers') {
    msg.from = pick(SQUARES);
    msg.to = pick(SQUARES);
    msg.promo = pick(['q', 'r', 'b', 'n', 'k', '']);
    if (game === 'checkers' && rnd(2)) msg.path = [msg.from, pick(SQUARES), msg.to];
  }
  if (game === 'nardy') {
    msg.from = rnd(26) - 1;
    msg.die = 1 + rnd(6);
  }
  if (game === 'battleship') msg.cell = rnd(102) - 1;
  if (game === 'poker') {
    msg.action = pick(['fold', 'check', 'call', 'bet', 'raise', 'allin']);
    const l = view?.legal;
    msg.amount = l ? pick([l.minTotal, l.maxTotal, (l.minTotal ?? 0) - 1, (l.maxTotal ?? 0) + 1, l.currentBet, rnd(20000)]) : rnd(20000);
  }
  return msg;
}

/* ------------------------------------------------------ законный ход по виду */

async function legalMove(t, room, rnd, game, cast) {
  const g = GAMES[game];
  const waits = room.status === 'playing' ? g.waiting(room) : [];
  const extra = g.bot?.wants?.(room, t.clock.now()) || [];
  const all = [...waits, ...extra];
  if (!all.length) return null;
  const w = all[rnd(all.length)];
  const u = cast.find((x) => String(x.id) === w.id);
  if (!u) return null;
  const view = t.state(u) && t.page(u) ? g.view(room, w.id, { now: t.clock.now(), botUsername: '' }) : null;
  if (!view) return null;
  let msg = null;
  if (game === 'chess') {
    const to = view.legal?.to || {};
    const froms = Object.keys(to);
    if (w.kind && w.kind !== 'move') msg = { t: rnd(2) ? w.kind : w.kind === 'draw' ? 'decline' : 'declinetb' };
    else if (froms.length) {
      const from = froms[rnd(froms.length)];
      msg = { t: 'move', from, to: to[from][rnd(to[from].length)], promo: 'qrbn'[rnd(4)], ply: view.match?.plies };
    }
  } else if (game === 'checkers') {
    const moves = view.legal?.moves || [];
    if (w.kind && w.kind !== 'move') msg = { t: rnd(2) ? w.kind : w.kind === 'draw' ? 'decline' : 'declinetb' };
    else if (moves.length) {
      const mv = moves[rnd(moves.length)];
      msg = { t: 'move', from: mv.from, to: mv.to, path: mv.path, ply: view.match?.plies };
    }
  } else if (game === 'battleship') {
    const m = view.match;
    if (!m) return null;
    if (m.phase === 'place') msg = rnd(3) ? { t: 'random' } : { t: 'ready' };
    else {
      const enemy = m.boards[1 - m.mySide];
      const known = new Set([...enemy.shots.map((x) => x.c), ...enemy.around]);
      const free = [];
      for (let c = 0; c < 100; c++) if (!known.has(c)) free.push(c);
      msg = { t: 'fire', cell: free[rnd(free.length)], shot: m.shots };
    }
  } else {
    const me = room.players.find((p) => p.id === w.id);
    const spec = g.bot.lineup({ opponents: 1, level: 0 }, () => 0.5)[0];
    try {
      msg = await g.bot.decide({ room, view, me: { ...me, bot: spec }, wait: w, rng: () => rnd(1e6) / 1e6, now: t.clock.now() });
    } catch {
      msg = null;
    }
    if (!msg) msg = g.bot.fallback?.(view, w) || null;
  }
  if (!msg) return null;
  await t.send(u, msg);
  return msg;
}

/* -------------------------------------------------------------- инварианты */

function walk(x, path, out) {
  if (typeof x === 'number' && !Number.isFinite(x)) out.push(`${path} = ${x}`);
  else if (typeof x === 'string' && /undefined|NaN|\[object Object\]/.test(x)) out.push(`${path} = «${x.slice(0, 80)}»`);
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) walk(v, `${path}.${k}`, out);
  return out;
}

/** Первое различие двух объектов — путь и значения, коротко. */
function firstDiff(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
  }
  return `${path}: было ${JSON.stringify(a)?.slice(0, 120)}, стало ${JSON.stringify(b)?.slice(0, 120)}`;
}

const RULES = {
  poker(room, ctx) {
    const h = room.hand;
    const stacks = room.players.reduce((s, p) => s + p.stack, 0);
    const pot = h && h.phase !== 'complete' ? room.players.reduce((s, p) => s + (p.committed || 0), 0) : 0;
    const bought = room.players.reduce((s, p) => s + (p.stats?.buyIn || 0), 0);
    assert.equal(stacks + pot, bought, 'фишки: стеки + банк ≠ всё купленное');
    for (const p of room.players) {
      assert.ok(Number.isInteger(p.stack) && p.stack >= 0, `стек ${p.name}: ${p.stack}`);
      if (h?.phase === 'betting' && p.allIn) assert.equal(p.stack, 0, 'олл-ин с фишками');
    }
    if (h?.holes) {
      const cards = [...Object.values(h.holes).flat(), ...(h.board || [])];
      assert.equal(new Set(cards).size, cards.length, 'карта в двух местах');
      assert.ok((h.board || []).length <= 5, 'на борде больше пяти');
      for (const c of cards) assert.ok(Number.isInteger(c) && c >= 0 && c < 52, `не карта: ${c}`);
    }
  },
  durak(room) {
    const d = room.deal;
    if (!d) return;
    const all = [...Object.values(d.hands).flat(), ...d.talon, ...d.discard, ...d.table.flatMap((x) => (x.d ? [x.a, x.d] : [x.a]))];
    if (d.aborted) return;
    assert.equal(all.length, 36, `карт ${all.length}`);
    assert.equal(new Set(all).size, 36, 'карта дважды');
    if (d.phase !== 'play') return;
    assert.notEqual(d.attacker, d.defender, 'ходит на себя');
    assert.ok(d.table.length <= 6, 'на столе больше шести');
    assert.ok(!d.out.includes(d.defender), 'отбивается вышедший');
    for (const x of d.table) if (x.d) assert.ok(durakBeats(x.a, x.d, d.trump), `${x.d} не бьёт ${x.a} (козырь ${d.trump})`);
  },
  colors(room) {
    const d = room.deal;
    if (!d || d.aborted) return;
    const all = [...Object.values(d.hands).flat(), ...d.deck, ...d.discard, d.top].sort();
    assert.deepEqual(all, colorsFresh().sort(), 'состав колоды UNOQ нарушен');
  },
  chess(room) {
    const m = room.match;
    if (!m) return;
    const b = m.pos.b;
    assert.equal(b.filter((x) => x === 'K').length, 1, 'белых королей не один');
    assert.equal(b.filter((x) => x === 'k').length, 1, 'чёрных королей не один');
    for (let s = 0; s < 8; s++) assert.ok(!/[pP]/.test(b[s] || '') && !/[pP]/.test(b[56 + s] || ''), 'пешка на крайней горизонтали');
    assert.ok(!CB.inCheck(m.pos, CB.other(m.pos.t)), 'тот, кто только что сходил, под шахом');
    // Повтор всех ходов с начала тем же генератором — каждый принятый ход законен.
    if (m.startFen === undefined || m.startFen === null) {
      let pos = CB.startPosition();
      for (const mv of m.moves) {
        const f = CB.findMove(pos, mv.from, mv.to, mv.uci.slice(4));
        assert.ok(f, `ход ${mv.uci} незаконен в позиции ${CB.toFen(pos)}`);
        pos = CB.make(pos, f);
      }
      assert.equal(CB.key(pos), CB.key(m.pos), 'повтор ходов не сходится с доской');
    }
  },
  checkers(room) {
    const m = room.match;
    if (!m) return;
    const b = m.pos.b;
    for (let i = 0; i < 64; i++) if (b[i]) assert.ok(KB.isDark(i), `шашка на белом поле ${i}`);
    assert.ok(b.filter((p) => KB.colorOf(p) === 'w').length <= 12, 'белых больше 12');
    assert.ok(b.filter((p) => KB.colorOf(p) === 'b').length <= 12, 'чёрных больше 12');
    for (let s = 0; s < 8; s++) assert.notEqual(b[56 + s], 'w', 'белая простая на последней горизонтали');
    for (let s = 0; s < 8; s++) assert.notEqual(b[s], 'b', 'чёрная простая на последней горизонтали');
    let pos = KB.startPosition();
    for (const mv of m.moves) {
      const f = KB.findMove(pos, mv.from, mv.to, mv.path);
      assert.ok(f && !f.error, `ход ${mv.n} незаконен`);
      pos = KB.make(pos, f.move || f);
    }
    assert.equal(KB.key(pos), KB.key(m.pos), 'повтор ходов не сходится с доской');
  },
  nardy(room) {
    const m = room.match;
    if (!m) return;
    const { b, off } = m.pos;
    const w = b.reduce((s, x) => s + Math.max(0, x), 0) + off.w;
    const bl = b.reduce((s, x) => s + Math.max(0, -x), 0) + off.b;
    assert.equal(w, 15, `белых ${w}`);
    assert.equal(bl, 15, `чёрных ${bl}`);
    for (const x of b) assert.ok(Number.isInteger(x), 'дробная шашка');
    if (m.turn?.dice) for (const d of m.turn.dice) assert.ok(Number.isInteger(d) && d >= 1 && d <= 6, `кубик ${d}`);
  },
  battleship(room) {
    const m = room.match;
    if (!m) return;
    for (const s of [0, 1]) {
      if (m.fleets[s]) assert.ok(!checkFleet(m.fleets[s]).error, 'флот незаконен');
      const cells = m.shots[s].map((x) => x.c);
      assert.equal(new Set(cells).size, cells.length, 'выстрел в одну клетку дважды');
    }
  },
};

/**
 * Что законно меняется при перезапуске: часы (срок → остаток) и окно «UNOQ!»
 * — оно живёт пять секунд и перезапуск честно закрывает (colors/rules.js).
 */
const VOLATILE = new Set(['deadline', 'now', 'left', 'autoNextAt', 'call', 'catch', 'quiet', 'shout', 'called']);
const stripClock = (v) => JSON.stringify(v, (k, x) => (VOLATILE.has(k) ? undefined : x));

function invariants(t, room, game, viewers) {
  const g = GAMES[game];
  RULES[game](room);
  const bad = walk(clone(room), 'стол', []).length ? [] : walk(room, 'стол', []);
  assert.deepEqual(bad, [], `в состоянии стола: ${bad.join(', ')}`);
  const now = t.clock.now();
  // Перезапуск не меняет того, что видят люди (кроме часов).
  const back = g.deserialize(clone(g.serialize(room, now)));
  back.ui = clone(room.ui || {});
  for (const v of viewers) {
    const view = g.view(room, v, { now, botUsername: 'B' });
    const words = walk(view, 'вид', []);
    assert.deepEqual(words, [], `в виде ${v}: ${words.join(', ')}`);
    const after = stripClock(g.view(back, v, { now, botUsername: 'B' }));
    const before = stripClock(view);
    if (after !== before) assert.fail(`вид ${v} меняется после сохранения и подъёма: ${firstDiff(JSON.parse(before), JSON.parse(after))}`);
  }
  const card = g.card(room, { link: 'L' });
  const words = walk(card, 'карточка', []);
  assert.deepEqual(words, [], `в карточке: ${words.join(', ')}`);
  assert.equal(t.errors.length, 0, `ошибки в логе: ${t.errors.map((e) => e?.stack || e).slice(0, 2).join('\n')}`);
}

/* ------------------------------------------------------------------ прогон */

const SETTINGS = {
  poker: (rnd) => ({ startingStack: [100, 1000, 10000][rnd(3)], smallBlind: [1, 25, 50][rnd(3)], bigBlind: [2, 50, 100][rnd(3)], turnSeconds: [0, 30][rnd(2)], blindMode: rnd(2) ? 'levels' : 'fixed', levelMinutes: [1, 15][rnd(2)], cards: rnd(6) ? 'virtual' : 'live' }),
  durak: (rnd) => ({ variant: ['podkidnoy', 'perevodnoy'][rnd(2)], turnSeconds: [0, 30][rnd(2)] }),
  colors: (rnd) => ({ turnSeconds: [0, 30][rnd(2)], stacking: rnd(2) }),
  chess: (rnd) => ({ base: [0, 60, 300][rnd(3)], inc: [0, 2][rnd(2)] }),
  checkers: (rnd) => ({ base: [0, 60, 300][rnd(3)], inc: [0, 2][rnd(2)] }),
  nardy: (rnd) => ({ base: [0, 60, 300][rnd(3)], inc: [0, 2][rnd(2)] }),
  battleship: (rnd) => ({ base: [0, 180][rnd(2)], inc: [0, 2][rnd(2)] }),
};
const MAXN = { poker: 6, durak: 6, colors: 6, chess: 2, checkers: 2, nardy: 2, battleship: 2 };

export async function runTable(game, seed, steps, { onStep = null, names = null, title = null, onDone = null } = {}) {
  const rnd = seededRng(seed);
  const t = new Table({
    deck: seededDecks(seed), durakDeck: durakDecks(seed), colorsDeck: colorsDecks(seed), botRng: botRandom(seed),
    runoutStepMs: rnd(2) ? 1500 : 0,
    chessRand: () => rnd(1000) / 1000, checkersRand: () => rnd(1000) / 1000,
    nardyDice: () => [1 + rnd(6), 1 + rnd(6)],
    battleshipRand: () => rnd(1000) / 1000, battleshipFleetRand: () => rnd(1e6) / 1e6,
  });
  const n = 2 + rnd(MAXN[game] - 1);
  const cast = Array.from({ length: n + 1 }, (_, i) => user(101 + i, names ? names[i % names.length] : `Игрок${i + 1}`));
  for (const u of cast) await t.start(u); // личка открыта — «ваш ход» тоже проверяется
  await t.cmd(cast[0], '/game', title ? { chat: { id: t.chatId, type: 'supergroup', title } } : {});
  t.openHub(cast[0]);
  await t.send(cast[0], { t: 'create', game, settings: SETTINGS[game](rnd) });
  let code = [...t.app.rooms.values()].find((r) => r.game === game).code;
  t.close(cast[0]);
  for (const u of cast) t.openRoom(u, t.app.roomByCode(code));
  for (const u of cast.slice(1, n)) await t.send(u, { t: 'sit' });
  await t.send(cast[0], { t: 'start' });

  const viewers = cast.map((u) => String(u.id));
  const stats = { legal: 0, hostile: 0, env: 0, finished: 0 };
  let last = '';
  let prevSnap = '';
  for (let step = 0; step < steps; step++) {
    let room = t.app.roomByCode(code);
    if (!room) break;
    if (process.env.FUZZ_DUMP) prevSnap = JSON.stringify({ status: room.status, settings: room.settings, hand: room.hand && { ...room.hand, deck: undefined }, players: room.players.map((p) => ({ id: p.id, stack: p.stack, inHand: p.inHand, folded: p.folded, allIn: p.allIn, bet: p.bet, committed: p.committed, left: p.left, kicked: p.kicked, sittingOut: p.sittingOut, role: p.role })) }, null, 1);
    const r = rnd(100);
    try {
      if (r < 60) {
        const m = await legalMove(t, room, rnd, game, cast.slice(0, n));
        last = `законный ${JSON.stringify(m)}`;
        stats.legal += 1;
      } else if (r < 75) {
        const u = cast[rnd(cast.length)];
        const m = plausible(rnd, game, t.state(u));
        last = `правдоподобный от ${u.id}: ${JSON.stringify(m)}`;
        await t.send(u, m);
        stats.hostile += 1;
      } else if (r < 87) {
        const u = cast[rnd(cast.length)];
        const m = hostile(rnd, game);
        last = `враждебный от ${u.id}: ${JSON.stringify(m)}`;
        await t.send(u, m);
        stats.hostile += 1;
      } else {
        const e = rnd(12);
        stats.env += 1;
        if (e < 5) {
          const ms = [100, 1000, 5000, 31_000, 61_000, 5 * 60_000][rnd(6)];
          last = `часы +${ms}`;
          await t.advance(ms);
        } else if (e === 5) {
          last = 'перезапуск';
          const g = GAMES[game];
          const saved = clone(g.serialize(room, t.clock.now()));
          t.app.stop();
          const back = g.deserialize(saved);
          back.chatId = room.chatId;
          back.code = room.code;
          back.ui = back.ui || {};
          t.app.rooms.set(code, back);
          t.app.syncClocks();
          await t.app.settle();
        } else if (e === 6) {
          last = 'обслуживание вкл/выкл';
          t.app.setMaintenance(true, 'тест');
          await t.advance(rnd(2) ? 0 : 60_000);
          t.app.setMaintenance(false);
          await t.app.settle();
        } else if (e === 7) {
          const u = cast[1 + rnd(n - 1)];
          last = `${u.id} вышел из группы`;
          await t.raw({ message: { message_id: t.tg.nextId++, chat: { id: t.chatId, type: 'supergroup' }, from: u, left_chat_member: u, date: 1 } });
        } else if (e === 8) {
          const u = cast[rnd(n)];
          last = `${u.id} переподключился`;
          t.close(u);
          t.openRoom(u, room);
        } else if (e === 9) {
          const host = cast.find((u) => String(u.id) === room.hostId) || cast[0];
          const m = [{ t: 'next' }, { t: 'start' }, { t: 'pause' }, { t: 'resume' }, { t: 'undo' }, { t: 'host', seat: rnd(n) }, { t: 'kick', seat: 1 + rnd(n - 1) }, { t: 'rebuy', seat: rnd(n) }, { t: 'settings', ...SETTINGS[game](rnd) }][rnd(9)];
          last = `хост: ${JSON.stringify(m)}`;
          await t.send(host, m);
        } else if (e === 10) {
          const u = cast[rnd(n)];
          last = `${u.id} садится обратно`;
          await t.send(u, { t: 'sit' });
        } else {
          const host = cast.find((u) => String(u.id) === room.hostId) || cast[0];
          last = 'хост: «завершить» (редко)';
          if (!rnd(5)) await t.send(host, { t: 'finish' });
        }
      }
      room = t.app.roomByCode(code);
      if (!room) break;
      invariants(t, room, game, viewers);
      onStep?.(step);
      if (room.status === 'finished') {
        stats.finished += 1;
        // Новый стол той же игры — «+ Новое лобби» со страницы хоста.
        const host = cast.find((u) => String(u.id) === room.hostId) || cast[0];
        t.close(host);
        t.openHub(host);
        await t.send(host, { t: 'create', game, settings: SETTINGS[game](rnd) });
        const fresh = [...t.app.rooms.values()].filter((x) => x.game === game && x.status !== 'finished').at(-1);
        if (!fresh) break;
        code = fresh.code;
        for (const u of cast) {
          t.close(u);
          t.openRoom(u, fresh);
        }
        for (const u of cast.slice(0, n)) if (String(u.id) !== fresh.hostId) await t.send(u, { t: 'sit' });
        await t.send(host, { t: 'start' });
      }
    } catch (e) {
      t.app.stop();
      if (process.env.FUZZ_DUMP) console.log('СТОЛ ДО ШАГА:', prevSnap);
      e.message = `${game}, зерно ${seed}, шаг ${step} (${last}): ${e.message}`;
      throw e;
    }
  }
  await onDone?.(t);
  t.app.stop();
  return stats;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [which = 'all', total = '20000', first = '1', per = '400'] = process.argv.slice(2);
  const games = which === 'all' ? Object.keys(RULES) : [which];
  const started = Date.now();
  let failures = 0;
  for (const game of games) {
    const sum = { tables: 0, steps: 0, legal: 0, hostile: 0, env: 0, finished: 0 };
    for (let seed = Number(first); sum.steps < Number(total); seed++) {
      try {
        const s = await runTable(game, seed, Number(per));
        sum.tables += 1;
        for (const k of ['legal', 'hostile', 'env', 'finished']) sum[k] += s[k];
        sum.steps += s.legal + s.hostile + s.env;
      } catch (e) {
        failures += 1;
        const where = (e.stack || '').split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 4).join('\n');
        console.log(`✖ ${String(e.message).split('\n').slice(0, 3).join(' | ')}\n${where}`);
        sum.steps += Number(per);
        if (failures > Number(process.env.FUZZ_MAX_FAIL || 10)) process.exit(1);
      }
    }
    console.log(`${game}: столов ${sum.tables}, шагов ${sum.steps} (законных ${sum.legal}, враждебных ${sum.hostile}, среды ${sum.env}), партий доиграно ${sum.finished}`);
  }
  console.log(`за ${Math.round((Date.now() - started) / 1000)} с${failures ? `, падений ${failures}` : ''}`);
  process.exit(failures ? 1 : 0);
}
