'use strict';
/**
 * Морской бой за столом: двое, расстановка, готовность, выстрелы, часы,
 * сдача, серия партий.
 *
 * Поле и флот — board.js. Здесь то, что делает поле игрой двух людей, и
 * главное новое по сравнению с другими дуэлями: ТАЙНА ФЛОТА.
 *
 *   Сервер хранит обе расстановки в комнате (`m.fleets`) — и только он.
 *   Наружу их отдаёт один view.js, и до конца партии — только хозяину
 *   флота. Здесь ни одно сообщение, отказ или запись не называют клеток
 *   чужого флота: отказ выстрелу решается по тому, что стрелок и так знает
 *   (куда он уже стрелял, вокруг каких потопленных кораблей пусто).
 *
 * Партия: расстановка (`place` — свой флот целиком, `random` — сервер
 * расставит сам, `ready` — флот заперт) → бой, когда готовы оба. Кто
 * стреляет первым — жребий сервера. Попал — стреляешь ещё; мимо — ход
 * соперника. Потопил весь флот — победа. Ничьей нет.
 *
 * Стороны — 0 и 1: `m.ids[s]` — кто играет стороной `s`. `m.shots[s]` —
 * выстрелы стороны `s` по полю соперника, по порядку.
 */
import crypto from 'node:crypto';
import { newRoomCode } from '../../room.js';
import { cleanName } from '../../fmt.js';
import { checkFleet, randomFleet, shoot, allSunk, sunkShips, halo, isCell, addr, FLEET } from './board.js';

export const MAX_SEATS = 2;
export const MIN_PLAYERS = 2;
/** Сдача и время засчитываются в рейтинг, если выстрелов в партии не меньше 20. */
export const RATED_MIN_SHOTS = 20;
/** Срок на расстановку — независимо от часов партии. */
export const PLACE_MS = 120_000;
/** На первый выстрел каждому — столько, независимо от часов партии. */
export const FIRST_MS = 60_000;
/** Секунды на партию; 0 — без часов. */
export const BASES = [0, 180, 300, 600, 900];
/** Прибавка за ход, секунды. */
export const INCS = [0, 2, 5, 10];
export const KIND_RU = {
  fleet: 'весь флот соперника потоплен',
  resign: 'соперник сдался',
  time: 'время вышло',
  aborted: 'отменена',
};
export const RESULT_RU = { miss: 'мимо', hit: 'ранил', sunk: 'убил' };

export const controlRu = (s) => (s.base ? `${Math.round(s.base / 60)} мин${s.inc ? ` + ${s.inc} с` : ''}` : 'без часов');
const pick = (v, list, dflt) => (list.includes(Number(v)) ? Number(v) : dflt);

/** Настоящая случайность сервера: дробь 0…1. Подмена в тестах — из приложения, не со страницы. */
export const realRandom = () => crypto.randomInt(2 ** 31) / 2 ** 31;

/* ------------------------------------------------------------------ model */

/**
 * Кто стреляет первым: жребий (по умолчанию) или — в партии с ботом, по
 * выбору человека в форме — хост ('host') или его соперник ('guest').
 * В настройках хранится, только когда это не жребий.
 */
export const FIRSTS = ['random', 'host', 'guest'];
const settingsOf = (base, inc, first) => {
  const b = pick(base, BASES, 600);
  const out = { base: b, inc: b ? pick(inc, INCS, 0) : 0 };
  if (FIRSTS.includes(first) && first !== 'random') out.first = first;
  return out;
};

export function createRoom({ chatId, host, title = '', code = newRoomCode(), base = 600, inc = 0, first = 'random' }) {
  const room = {
    game: 'battleship',
    chatId: String(chatId),
    code,
    title: cleanName(title, '', 40),
    createdAt: Date.now(),
    touchedAt: Date.now(),
    status: 'lobby',
    settings: settingsOf(base, inc, first),
    players: [],
    hostId: null,
    gameNo: 0,
    history: [], // { no, ids, winner (id|null), kind, aborted, shots }
    match: null,
    turn: null, // часы: { key, deadline, remaining }
    seq: 1,
    notice: null,
    finishedAt: null,
    ui: { tableMessageId: null, lastText: null, lastKb: null, lastMsgId: 0, pings: {} },
  };
  if (host) {
    const p = addPlayer(room, host);
    room.hostId = p.id;
  }
  return room;
}

export const findPlayer = (room, id) => room.players.find((p) => p.id === String(id)) || null;
export const isHost = (room, id) => room.hostId === String(id);
export const isSeated = (p) => !!p && p.seated && !p.left && !p.kicked;
export const seatedPlayers = (room) => room.players.filter(isSeated);
const nameOf = (room, id) => findPlayer(room, id)?.name ?? '—';

export function touch(room) {
  room.touchedAt = Date.now();
  room.seq += 1;
}

export const live = (room) => (room.match && !room.match.over ? room.match : null);

/** Сторона игрока в текущей партии (0 или 1), или null — зритель. */
export function sideOf(room, id) {
  const m = room.match;
  if (!m) return null;
  const i = m.ids.indexOf(String(id));
  return i === -1 ? null : i;
}

export function addPlayer(room, user) {
  const id = String(user.id);
  const existing = findPlayer(room, id);
  if (existing?.kicked) return { error: 'KICKED' };
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (existing && isSeated(existing)) {
    existing.name = cleanName(user.name, existing.name);
    return existing;
  }
  if (seatedPlayers(room).length >= MAX_SEATS) return { error: 'TABLE_FULL' };
  if (existing) {
    existing.name = cleanName(user.name, existing.name);
    existing.seated = true;
    existing.left = false;
    touch(room);
    return existing;
  }
  const p = {
    id,
    tgId: Number(user.tgId ?? user.id),
    name: cleanName(user.name, `Игрок ${room.players.length + 1}`),
    dm: user.dm ?? null,
    joinedAt: Date.now(),
    seated: true,
    left: false,
    kicked: false,
  };
  room.players.push(p);
  touch(room);
  return p;
}

export function leave(room, userId) {
  const p = findPlayer(room, userId);
  if (!p || !isSeated(p)) return { error: 'NOT_SEATED' };
  if (live(room) && sideOf(room, p.id) != null) return { error: 'IN_GAME' };
  if (room.status === 'lobby' && !isHost(room, p.id)) room.players.splice(room.players.indexOf(p), 1);
  else p.seated = false;
  room.notice = `${p.name} встал из-за стола`;
  touch(room);
  return { ok: true };
}

export function startBlocker(room) {
  const n = seatedPlayers(room).length;
  if (n < MIN_PLAYERS) return n === 0 ? 'За столом никого нет.' : 'Ждём соперника.';
  return null;
}

/* ------------------------------------------------------------- the match */

/**
 * Новая партия: флотов ещё нет ни у кого — каждый расставляет заново.
 * Прежние расстановки в новую партию не переходят никогда.
 */
function firstSide(room, ids, rand) {
  const host = ids.indexOf(room.hostId);
  const want = room.settings.first;
  if (host >= 0 && want === 'host') return host;
  if (host >= 0 && want === 'guest') return 1 - host;
  return rand() < 0.5 ? 0 : 1;
}

function newMatch(room, ids, opts) {
  room.gameNo += 1;
  const { base } = room.settings;
  const rand = opts.rand || realRandom;
  room.match = {
    no: room.gameNo,
    ids: ids.slice(),
    phase: 'place',
    fleets: [null, null],
    ready: [false, false],
    // Кто стреляет первым — жребий сервера (или выбор в форме партии с ботом);
    // объявляется, когда начнётся бой.
    first: firstSide(room, ids, rand),
    turn: null,
    shots: [[], []], // shots[s] — выстрелы стороны s: { c, r }
    log: [], // все выстрелы партии по порядку: { by, c, r }
    clock: [base * 1000, base * 1000],
    over: null, // { winner (сторона | null), kind }
  };
  room.turn = null;
}

export function startGame(room, userId, opts = {}) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (room.status !== 'lobby') return { error: 'ALREADY_STARTED' };
  if (startBlocker(room)) return { error: 'NOT_ENOUGH_PLAYERS' };
  const seated = seatedPlayers(room).sort((x, y) => x.joinedAt - y.joinedAt);
  const a = seated.find((p) => isHost(room, p.id)) || seated[0];
  const b = seated.find((p) => p !== a);
  room.status = 'playing';
  newMatch(room, [a.id, b.id], opts);
  room.notice = 'Расставьте флот — бой начнётся, когда оба будут готовы';
  touch(room);
  return { ok: true, started: true };
}

export function nextGame(room, userId, opts = {}) {
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (room.status !== 'playing') return { error: 'NOT_PLAYING' };
  if (live(room)) return { error: 'GAME_IN_PROGRESS' };
  if (!isSeated(findPlayer(room, userId)) && !isHost(room, userId)) return { error: 'NOT_SEATED' };
  if (startBlocker(room)) return { error: 'NOT_ENOUGH_PLAYERS' };
  const m = room.match;
  const ids = seatedPlayers(room).map((p) => p.id);
  const pair = m && ids.includes(m.ids[0]) && ids.includes(m.ids[1]) ? [m.ids[1], m.ids[0]] : ids.slice(0, 2);
  newMatch(room, pair, opts);
  room.notice = 'Новая партия — расставьте флот';
  touch(room);
  return { ok: true, started: true };
}

function conclude(room, winnerSide, kind, why = null) {
  const m = room.match;
  m.over = { winner: winnerSide, kind };
  m.turn = null;
  const aborted = kind === 'aborted';
  room.history.push({
    no: m.no,
    ids: m.ids.slice(),
    winner: winnerSide == null ? null : m.ids[winnerSide],
    kind,
    aborted,
    shots: m.log.length,
  });
  room.turn = null;
  const who = winnerSide == null ? null : nameOf(room, m.ids[winnerSide]);
  room.notice = aborted ? `Партия отменена${why ? ` — ${why}` : ''}. Не засчитывается.` : `${who} выиграл: ${KIND_RU[kind]}`;
  touch(room);
}

/* ---------------------------------------------------------------- часы */

export const mover = (m) => m.turn;
/** Пока расставляют или кто-то ещё ни разу не выстрелил — партию можно отменить. */
export const firstPhase = (m) => m.phase === 'place' || !m.shots[0].length || !m.shots[1].length;
const timed = (room) => room.settings.base > 0;

/** Сколько осталось на текущих часах. */
export function leftOf(room, now) {
  const m = live(room);
  if (!m) return 0;
  const t = room.turn;
  if (t && t.deadline != null) return Math.max(0, t.deadline - now);
  if (t) return t.remaining;
  if (m.phase === 'place') return PLACE_MS;
  return firstPhase(m) ? FIRST_MS : m.clock[mover(m)];
}

/** Ключ часов: расстановка — одна на партию; в бою — номер выстрела. */
export const turnKey = (m) => (m.phase === 'place' ? `${m.no}:place` : `${m.no}:${m.log.length}`);

export function syncTurn(room, now) {
  const m = live(room);
  if (!m || room.status !== 'playing' || (m.phase === 'battle' && !firstPhase(m) && !timed(room))) {
    room.turn = null;
    return null;
  }
  const k = turnKey(m);
  if (room.turn?.key !== k) {
    const remaining = m.phase === 'place' ? PLACE_MS : firstPhase(m) ? FIRST_MS : m.clock[mover(m)];
    room.turn = { key: k, deadline: null, remaining };
  }
  if (room.turn.deadline == null) room.turn.deadline = now + room.turn.remaining;
  return room.turn;
}

/**
 * Срок вышел. На расстановке — кто не успел, за того флот расставит сервер
 * (его черновик, если он по правилам, иначе случайно), и начнётся бой. В бою
 * первый выстрел не сделан — партия отменяется; дальше — проигрыш по
 * времени того, чей ход.
 */
export function timeoutMove(room, k, now, opts = {}) {
  const m = live(room);
  const t = room.turn;
  if (!m || !t || t.key !== k || turnKey(m) !== k) return { error: 'STALE' };
  if (t.deadline == null || now < t.deadline) return { error: 'EARLY' };
  if (m.phase === 'place') {
    for (const s of [0, 1]) {
      if (m.ready[s]) continue;
      if (!m.fleets[s]) m.fleets[s] = randomFleet(opts.fleetRand || realRandom);
      m.ready[s] = true;
    }
    beginBattle(room, 'Срок расстановки вышел — флот расставлен за того, кто не успел');
    return { ok: true, kind: 'placed' };
  }
  if (firstPhase(m)) {
    conclude(room, null, 'aborted', 'первый выстрел не сделан вовремя');
    return { ok: true, kind: 'aborted' };
  }
  const loser = mover(m);
  m.clock[loser] = 0;
  conclude(room, 1 - loser, 'time');
  return { ok: true, kind: 'time' };
}

function expireTurn(room, now, opts) {
  const t = room.turn;
  if (!t || t.deadline == null || now < t.deadline) return null;
  const r = timeoutMove(room, t.key, now, opts);
  if (!r.ok) return null;
  return r.kind === 'placed' ? { error: 'BATTLE_ON', ended: true } : { error: 'TIME_UP', ended: true };
}

/* ----------------------------------------------------------- расстановка */

function checkPlacer(room, userId, now, opts) {
  const m = live(room);
  if (!m) return { error: 'NOT_PLAYING' };
  const s = sideOf(room, userId);
  if (s == null) return { error: 'NOT_IN_GAME' };
  const expired = expireTurn(room, now, opts);
  if (expired) return expired;
  if (m.phase !== 'place') return { error: 'BATTLE_ON' };
  if (m.ready[s]) return { error: 'ALREADY_READY' };
  return { m, s };
}

/** Свой флот целиком, как его расставили на странице. Проверяет сервер. */
export function place(room, userId, ships, now = Date.now(), opts = {}) {
  const r = checkPlacer(room, userId, now, opts);
  if (r.error) return r;
  const f = checkFleet(ships);
  if (f.error) return { error: f.error };
  r.m.fleets[r.s] = f.ships;
  touch(room);
  return { ok: true };
}

/** «Расставить случайно» — расставляет сервер; случайность со страницы не берётся. */
export function placeRandom(room, userId, now = Date.now(), opts = {}) {
  const r = checkPlacer(room, userId, now, opts);
  if (r.error) return r;
  r.m.fleets[r.s] = randomFleet(opts.fleetRand || realRandom);
  touch(room);
  return { ok: true };
}

/** «Я готов»: флот заперт. Готовы оба — начинается бой. */
export function ready(room, userId, now = Date.now(), opts = {}) {
  const r = checkPlacer(room, userId, now, opts);
  if (r.error) return r;
  const { m, s } = r;
  if (!m.fleets[s]) return { error: 'NO_FLEET' };
  m.ready[s] = true;
  if (m.ready[0] && m.ready[1]) {
    beginBattle(room);
    return { ok: true, battle: true };
  }
  room.notice = `${nameOf(room, userId)} готов к бою`;
  touch(room);
  return { ok: true };
}

function beginBattle(room, lead = 'Оба флота на местах') {
  const m = room.match;
  m.phase = 'battle';
  m.turn = m.first;
  room.turn = null; // часы боя заведёт ядро
  room.notice = `${lead}. Жребий: первым стреляет ${nameOf(room, m.ids[m.first])}`;
  touch(room);
}

/* ---------------------------------------------------------------- бой */

/** Клетки, про которые стрелок и так знает, что там пусто: вокруг потопленных им кораблей. */
export function knownEmpty(m, s) {
  const out = new Set();
  const mine = new Set(m.shots[s].map((x) => x.c));
  for (const ship of sunkShips(m.fleets[1 - s], mine)) for (const c of halo(ship)) out.add(c);
  return out;
}

/**
 * Выстрел в клетку `cell` поля соперника. Только тот, чей ход; отказ —
 * по тому, что стрелок и так знает, и никогда не по чужому флоту.
 */
export function fire(room, userId, cell, now = Date.now(), shotNo = undefined, opts = {}) {
  const m = live(room);
  if (!m) return { error: 'NOT_PLAYING' };
  const s = sideOf(room, userId);
  if (s == null) return { error: 'NOT_IN_GAME' };
  const expired = expireTurn(room, now, opts);
  if (expired) return expired;
  if (m.phase !== 'battle') return { error: 'PLACING' };
  if (mover(m) !== s) return { error: 'NOT_YOUR_TURN' };
  if (shotNo != null && shotNo !== m.log.length) return { error: 'STALE' };
  // Клетка — только число 0…99: «null», «Б7», «0» строкой — не клетка.
  const c = typeof cell === 'number' ? cell : NaN;
  if (!isCell(c)) return { error: 'BAD_CELL' };
  if (m.shots[s].some((x) => x.c === c)) return { error: 'ALREADY_SHOT' };
  if (knownEmpty(m, s).has(c)) return { error: 'NEAR_SUNK' };

  const before = new Set(m.shots[s].map((x) => x.c));
  const { r } = shoot(m.fleets[1 - s], before, c);
  // Часы того, кто стрелял: остаток банка; прибавка — когда ход переходит.
  if (!firstPhase(m) && timed(room)) m.clock[s] = leftOf(room, now) + (r === 'miss' ? room.settings.inc * 1000 : 0);
  m.shots[s].push({ c, r });
  m.log.push({ by: s, c, r });
  room.turn = null;
  room.notice = `${nameOf(room, userId)}: ${addr(c)} — ${RESULT_RU[r]}`;
  if (r === 'miss') m.turn = 1 - s;
  else if (r === 'sunk' && allSunk(m.fleets[1 - s], new Set([...before, c]))) {
    conclude(room, s, 'fleet');
    return { ok: true, r, over: true };
  }
  touch(room);
  return { ok: true, r };
}

export function resign(room, userId, now = Date.now(), opts = {}) {
  const m = live(room);
  if (!m) return { error: 'NOT_PLAYING' };
  const s = sideOf(room, userId);
  if (s == null) return { error: 'NOT_IN_GAME' };
  const expired = expireTurn(room, now, opts);
  if (expired) return expired;
  if (firstPhase(m)) return { error: 'TOO_EARLY' };
  conclude(room, 1 - s, 'resign');
  return { ok: true };
}

export function abortMatch(room, userId, now = Date.now(), opts = {}) {
  const m = live(room);
  if (!m) return { error: 'NOT_PLAYING' };
  if (sideOf(room, userId) == null && !isHost(room, userId)) return { error: 'NOT_IN_GAME' };
  const expired = expireTurn(room, now, opts);
  if (expired?.error === 'TIME_UP') return expired;
  if (!firstPhase(live(room) || m)) return { error: 'TOO_LATE' };
  conclude(room, null, 'aborted', `${nameOf(room, userId)} отменил её до начала боя`);
  return { ok: true };
}

/* ----------------------------------------------------------- host and seats */

export function updateSettings(room, userId, patch = {}) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (live(room)) return { error: 'GAME_IN_PROGRESS' };
  const cur = room.settings;
  const next = {
    base: patch.base != null ? pick(patch.base, BASES, cur.base) : cur.base,
    inc: patch.inc != null ? pick(patch.inc, INCS, cur.inc) : cur.inc,
  };
  if (next.base === 0) next.inc = 0;
  if (cur.first) next.first = cur.first;
  if (next.base === cur.base && next.inc === cur.inc) return { ok: true, noop: true };
  room.settings = next;
  room.notice = `Часы: ${controlRu(next)}`;
  touch(room);
  return { ok: true };
}

function reassignHost(room) {
  const heir = room.players.filter((p) => !p.left && !p.kicked).sort((a, b) => a.joinedAt - b.joinedAt)[0];
  if (heir) room.hostId = heir.id;
}

export function transferHost(room, userId, targetId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  const p = findPlayer(room, targetId);
  if (!p || p.kicked || p.left) return { error: 'NO_PLAYER' };
  room.hostId = p.id;
  room.notice = `${p.name} — новый хост`;
  touch(room);
  return { ok: true };
}

export function kickPlayer(room, userId, targetId, now = Date.now()) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (String(targetId) === room.hostId) return { error: 'CANNOT_KICK_HOST' };
  const p = findPlayer(room, targetId);
  if (!p || p.kicked) return { error: 'NO_PLAYER' };
  let stopped = !!expireTurn(room, now, {});
  if (room.status === 'lobby') {
    room.players.splice(room.players.indexOf(p), 1);
  } else {
    p.kicked = true;
    p.seated = false;
    if (live(room) && sideOf(room, p.id) != null) {
      conclude(room, null, 'aborted', `хост удалил ${p.name}`);
      stopped = true;
    }
  }
  if (!stopped) room.notice = `${p.name} удалён из игры`;
  touch(room);
  return { ok: true };
}

export function markLeft(room, targetId, now = Date.now()) {
  const p = findPlayer(room, targetId);
  if (!p || p.left) return { error: 'NO_PLAYER' };
  p.left = true;
  p.seated = false;
  let stopped = !!expireTurn(room, now, {});
  if (live(room) && sideOf(room, p.id) != null) {
    conclude(room, null, 'aborted', `${p.name} вышел из чата`);
    stopped = true;
  }
  if (room.hostId === p.id) reassignHost(room);
  if (!stopped) room.notice = `${p.name} вышел из чата`;
  touch(room);
  return { ok: true, player: p };
}

export function endGame(room, userId, now = Date.now()) {
  const p = findPlayer(room, userId);
  // Между партиями закрыть может любой из двоих; лобби — только хост (аудит A-03).
  const between = room.status !== 'lobby' && !live(room) && isSeated(p);
  if (!isHost(room, userId) && !between) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { ok: true, noop: true };
  expireTurn(room, now, {});
  if (live(room)) conclude(room, null, 'aborted', 'серию завершил хост');
  room.status = 'finished';
  room.finishedAt = Date.now();
  room.turn = null;
  touch(room);
  return { ok: true };
}

export function score(room) {
  return room.players
    .filter((pl) => isSeated(pl) || room.history.some((h) => h.ids.includes(pl.id)))
    .map((pl) => {
      const mine = room.history.filter((h) => !h.aborted && h.ids.includes(pl.id));
      return {
        id: pl.id,
        name: pl.name,
        wins: mine.filter((h) => h.winner === pl.id).length,
        losses: mine.filter((h) => h.winner != null && h.winner !== pl.id).length,
        games: mine.length,
        isHost: isHost(room, pl.id),
        kicked: !!pl.kicked,
        left: !!pl.left,
      };
    })
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses);
}

/** Сколько кораблей каждой длины ещё на плаву — по потопленным (это знают оба). */
export function fleetLeft(sunk) {
  const left = {};
  for (const n of FLEET) left[n] = (left[n] || 0) + 1;
  for (const s of sunk) left[s.len] -= 1;
  return left;
}

/* ------------------------------------------------------------ persistence */

const cloneJson = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

/**
 * Сохраняется всё, включая обе расстановки: это база сервера, страницам она
 * не уходит. Часы — остатком.
 */
export function serialize(room, now = Date.now()) {
  const copy = cloneJson(room);
  if (copy.turn && copy.turn.deadline != null) {
    copy.turn.remaining = Math.max(0, copy.turn.deadline - now);
    copy.turn.deadline = null;
  }
  return copy;
}

export function deserialize(data) {
  const room = cloneJson(data);
  room.game = 'battleship';
  room.ui = room.ui || {};
  room.ui.lastText = null;
  room.ui.lastKb = null;
  room.ui.lastMsgId = room.ui.lastMsgId || 0;
  room.ui.pings = room.ui.pings || {};
  room.code = room.code || newRoomCode();
  return room;
}
