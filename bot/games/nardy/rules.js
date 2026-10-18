'use strict';
/**
 * Нарды за столом: двое, цвета, кубики, ход по шагам, часы, сдача, серия.
 *
 * Сами ходы — board.js. Здесь то, что делает доску игрой двух людей, — и
 * главное новое по сравнению с шахматами и шашками: ЧЕСТНОСТЬ КУБИКОВ.
 *
 *   Кубики бросает только сервер: `roll()` берёт числа из `opts.dice` — в
 *   бою это crypto.randomInt, в тестах подмена через приложение
 *   (`app.nardyDice`). Числа от страницы не читаются нигде.
 *
 *   Бросок живёт в комнате (`m.turn.dice`) и сохраняется вместе с ней:
 *   перезапуск бота, обновление страницы, переподключение не дают
 *   перебросить — бросить можно, только пока кубиков на этом ходу ещё нет.
 *
 *   Все броски партии — в `m.rolls`: их видят оба (и зрители).
 *
 * Ход: бросить → сыграть числа по одному (`move`: какая шашка, какое число)
 * → «Готово» (`endTurn`). Пока не нажал «Готово», сыгранное можно вернуть
 * (`undo`). Сервер заранее считает все допустимые последовательности хода и
 * пускает только шаги, с которых ход можно довести до конца по правилам.
 * Нет ни одного хода — ход переходит сам.
 *
 * Кто ходит первым — по правилам (п. 26.3): каждый бросает по кости, у кого
 * больше — тот ходит этими двумя числами. Ничьей в нардах нет.
 */
import crypto from 'node:crypto';
import { newRoomCode } from '../../room.js';
import { cleanName } from '../../fmt.js';
import {
  startPosition, sequences, nextSteps, turnDone, apply, winner, other, stepText, idx, clone, HEAD_LIMIT,
} from './board.js';

export const MAX_SEATS = 2;
export const MIN_PLAYERS = 2;
/** Сдача и время засчитываются в рейтинг, если каждый сделал не меньше 10 ходов. */
export const RATED_MIN_TURNS = 20;
/** На первый ход каждому — столько, независимо от часов партии. */
export const FIRST_MS = 60_000;
/** Секунды на партию; 0 — без часов. */
export const BASES = [0, 180, 300, 600, 900, 1800];
/** Прибавка за ход, секунды. */
export const INCS = [0, 3, 5, 10, 15];
export const SIDES = ['random', 'white', 'black'];
export const SIDE_RU = { random: 'случайно', white: 'белые', black: 'чёрные' };
export const KIND_RU = {
  off: 'все шашки сняты',
  mars: 'марс — соперник не снял ни одной',
  resign: 'сдался',
  time: 'время вышло',
  aborted: 'отменена',
};
/** Дубли, при которых второй игрок на первом ходу снимает с головы две шашки (п. 20.3). */
export const HEAD_DOUBLES = [3, 4, 6];

export const controlRu = (s) => (s.base ? `${Math.round(s.base / 60)} мин${s.inc ? ` + ${s.inc} с` : ''}` : 'без часов');
const pick = (v, list, dflt) => (list.includes(Number(v)) ? Number(v) : dflt);

/** Настоящие кубики. Подмена в тестах — `opts.dice` из приложения, не со страницы. */
export const realDice = () => [crypto.randomInt(1, 7), crypto.randomInt(1, 7)];

/** Числа кубиков — только целые 1…6: подмена в тестах тоже не может сломать правила. */
function throwDice(opts) {
  const d = (opts.dice || realDice)();
  if (!Array.isArray(d) || d.length !== 2 || !d.every((x) => Number.isInteger(x) && x >= 1 && x <= 6)) throw new Error('кубики: нужны два целых 1…6');
  return [d[0], d[1]];
}

/* ------------------------------------------------------------------ model */

const settingsOf = (base, inc, side) => {
  const b = pick(base, BASES, 600);
  return { base: b, inc: b ? pick(inc, INCS, 0) : 0, side: SIDES.includes(side) ? side : 'random' };
};

export function createRoom({ chatId, host, title = '', code = newRoomCode(), base = 600, inc = 0, side = 'random' }) {
  const room = {
    game: 'nardy',
    chatId: String(chatId),
    code,
    title: cleanName(title, '', 40),
    createdAt: Date.now(),
    touchedAt: Date.now(),
    status: 'lobby',
    settings: settingsOf(base, inc, side),
    players: [],
    hostId: null,
    gameNo: 0,
    history: [], // { no, white, black, winner (id|null), kind, aborted, turns, mars }
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

export function colorOfPlayer(room, id) {
  const m = room.match;
  if (!m) return null;
  return m.white === String(id) ? 'w' : m.black === String(id) ? 'b' : null;
}
const idOf = (m, c) => (c === 'w' ? m.white : m.black);

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
  if (live(room) && colorOfPlayer(room, p.id)) return { error: 'IN_GAME' };
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
 * Новая партия: жребий первого хода — каждому по кости (п. 26.3), пока не
 * выпадут разные; у кого больше, тот ходит этими двумя числами.
 */
function newMatch(room, white, black, opts) {
  room.gameNo += 1;
  const { base } = room.settings;
  let d;
  do d = throwDice(opts); while (d[0] === d[1]);
  const first = d[0] > d[1] ? 'w' : 'b';
  const pos = { ...startPosition(), t: first };
  room.match = {
    no: room.gameNo,
    white,
    black,
    pos,
    first,
    // Ход: чей, кубики (null — ещё не бросал), сыгранные шаги, позиция в начале хода.
    turn: { c: first, dice: [d[0], d[1]], played: [], start: clone(pos), headLimit: HEAD_LIMIT },
    rolls: [{ c: null, start: { w: d[0], b: d[1] } }], // все броски партии, по порядку
    log: [], // законченные ходы: { c, dice, steps: [{from,to,die}], auto }
    turns: { w: 0, b: 0 },
    clock: { w: base * 1000, b: base * 1000 },
    over: null, // { winner, kind, mars }
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
  const side = room.settings.side;
  const hostWhite = side === 'white' ? true : side === 'black' ? false : (opts.rand || Math.random)() < 0.5;
  const [white, black] = hostWhite ? [a.id, b.id] : [b.id, a.id];
  room.status = 'playing';
  newMatch(room, white, black, opts);
  room.notice = startNotice(room);
  touch(room);
  return { ok: true, started: true };
}

function startNotice(room) {
  const m = room.match;
  const s = m.rolls[0].start;
  return `Жребий: белые ${s.w}, чёрные ${s.b} — первым ходит ${nameOf(room, idOf(m, m.first))}`;
}

export function nextGame(room, userId, opts = {}) {
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (room.status !== 'playing') return { error: 'NOT_PLAYING' };
  if (live(room)) return { error: 'GAME_IN_PROGRESS' };
  if (!isSeated(findPlayer(room, userId)) && !isHost(room, userId)) return { error: 'NOT_SEATED' };
  if (startBlocker(room)) return { error: 'NOT_ENOUGH_PLAYERS' };
  const m = room.match;
  const ids = seatedPlayers(room).map((p) => p.id);
  const [white, black] = m && ids.includes(m.white) && ids.includes(m.black) ? [m.black, m.white] : ids;
  newMatch(room, white, black, opts);
  room.notice = startNotice(room);
  touch(room);
  return { ok: true, started: true };
}

function conclude(room, winnerColor, kind, why = null) {
  const m = room.match;
  const loser = winnerColor ? other(winnerColor) : null;
  const mars = !!winnerColor && kind === 'off' && m.pos.off[loser] === 0;
  m.over = { winner: winnerColor, kind: mars ? 'mars' : kind, mars };
  const aborted = kind === 'aborted';
  room.history.push({
    no: m.no,
    white: m.white,
    black: m.black,
    winner: winnerColor ? idOf(m, winnerColor) : null,
    kind: m.over.kind,
    aborted,
    turns: m.log.length,
    mars,
  });
  room.turn = null;
  const who = winnerColor ? nameOf(room, idOf(m, winnerColor)) : null;
  room.notice = aborted ? `Партия отменена${why ? ` — ${why}` : ''}. Не засчитывается.` : `${who} выиграл: ${KIND_RU[m.over.kind]}`;
  touch(room);
}

/* ---------------------------------------------------------------- часы */

export const mover = (m) => m.turn.c;
const firstPhase = (m) => m.log.length < 2;
const timed = (room) => room.settings.base > 0;

export function leftOf(room, now) {
  const m = live(room);
  if (!m) return 0;
  const t = room.turn;
  if (t && t.deadline != null) return Math.max(0, t.deadline - now);
  if (t) return t.remaining;
  return firstPhase(m) ? FIRST_MS : m.clock[mover(m)];
}

/** Ключ часов — номер хода (а не шага): на весь ход, с броском и «Готово», одни часы. */
export const turnKey = (m) => `${m.no}:${m.log.length}`;

export function syncTurn(room, now) {
  const m = live(room);
  if (!m || room.status !== 'playing' || (!firstPhase(m) && !timed(room))) {
    room.turn = null;
    return null;
  }
  const k = turnKey(m);
  if (room.turn?.key !== k) room.turn = { key: k, deadline: null, remaining: firstPhase(m) ? FIRST_MS : m.clock[mover(m)] };
  if (room.turn.deadline == null) room.turn.deadline = now + room.turn.remaining;
  return room.turn;
}

export function timeoutMove(room, k, now) {
  const m = live(room);
  const t = room.turn;
  if (!m || !t || t.key !== k || turnKey(m) !== k) return { error: 'STALE' };
  if (t.deadline == null || now < t.deadline) return { error: 'EARLY' };
  if (firstPhase(m)) {
    conclude(room, null, 'aborted', 'соперник не сделал первый ход');
    return { ok: true, kind: 'aborted' };
  }
  const loser = mover(m);
  m.clock[loser] = 0;
  conclude(room, other(loser), 'time');
  return { ok: true, kind: 'time' };
}

function expireTurn(room, now) {
  const t = room.turn;
  if (!t || t.deadline == null || now < t.deadline) return null;
  const r = timeoutMove(room, t.key, now);
  return r.ok ? { error: 'TIME_UP', ended: true } : null;
}

/* ------------------------------------------------------------------ ход */

/** Последовательности текущего хода — считаются заново из позиции начала хода и броска. */
export function turnSequences(m) {
  const t = m.turn;
  if (!t?.dice) return null;
  return sequences({ ...clone(t.start), t: t.c }, t.dice, { headLimit: t.headLimit });
}

/** Что можно сыграть сейчас: шаги, «Готово» и отмена. */
export function turnState(m) {
  const t = m.turn;
  if (!t.dice) return { phase: 'roll', next: [], canEnd: false, canUndo: false };
  const { seqs } = turnSequences(m);
  const next = nextSteps(seqs, t.played);
  return { phase: next.length ? 'move' : 'done', next, canEnd: !next.length, canUndo: t.played.length > 0 };
}

/** Первый ли это ход того, кто ходит вторым: тогда дубль 3-3, 4-4, 6-6 снимает с головы две (п. 20.3). */
const secondsFirst = (m, c) => c !== m.first && m.turns[c] === 0;

function checkMover(room, userId, now) {
  const m = live(room);
  if (!m) return { error: 'NOT_PLAYING' };
  const mine = colorOfPlayer(room, userId);
  if (!mine) return { error: 'NOT_IN_GAME' };
  if (mine !== mover(m)) return { error: 'NOT_YOUR_TURN' };
  const expired = expireTurn(room, now);
  if (expired) return expired;
  return { m, mine };
}

/**
 * Бросок — только сервер, только тому, чей ход, и только раз за ход:
 * кубики, однажды выпавшие, лежат в комнате до конца хода.
 */
export function roll(room, userId, now = Date.now(), opts = {}) {
  const r = checkMover(room, userId, now);
  if (r.error) return r;
  const { m, mine } = r;
  if (m.turn.dice) return { error: 'ALREADY_ROLLED' };
  const dice = throwDice(opts);
  m.turn.dice = dice;
  m.turn.headLimit = secondsFirst(m, mine) && dice[0] === dice[1] && HEAD_DOUBLES.includes(dice[0]) ? 2 : HEAD_LIMIT;
  m.rolls.push({ c: mine, dice });
  room.notice = null;
  // Ни одного хода — ход переходит сам (п. 26.6.3).
  if (turnSequences(m).max === 0) {
    room.notice = `${nameOf(room, userId)}: ${dice[0]}-${dice[1]} — ходов нет, ход переходит`;
    passTurn(room, now, true);
    return { ok: true, dice, passed: true };
  }
  touch(room);
  return { ok: true, dice };
}

/**
 * Шаг: шашка с пункта `from` (абсолютный, 0…23) на число `die`. Сервер
 * пускает только шаги, с которых ход можно довести до конца по правилам.
 */
export function move(room, userId, { from, die }, now = Date.now(), turnNo = undefined) {
  const r = checkMover(room, userId, now);
  if (r.error) return r;
  const { m } = r;
  if (turnNo != null && turnNo !== m.log.length) return { error: 'STALE' };
  if (!m.turn.dice) return { error: 'ROLL_FIRST' };
  const f = Number(from);
  const d = Number(die);
  const st = turnState(m);
  if (st.phase === 'done') return { error: 'TURN_DONE' };
  const step = st.next.find((s) => s.from === f && s.die === d);
  if (!step) return { error: whyNot(m, f, d) };
  m.turn.played.push(step);
  m.pos = apply(m.pos, step);
  const w = winner(m.pos);
  if (w) {
    finishTurn(room, now);
    conclude(room, w, 'off');
    return { ok: true, over: true };
  }
  touch(room);
  return { ok: true, step };
}

/** Почему шаг нельзя — словами, а не «нельзя». */
function whyNot(m, from, die) {
  const t = m.turn;
  const left = [...(t.dice[0] === t.dice[1] ? [t.dice[0], t.dice[0], t.dice[0], t.dice[0]] : t.dice)];
  for (const s of t.played) left.splice(left.indexOf(s.die), 1);
  if (!left.includes(die)) return 'NO_SUCH_DIE';
  if (!(m.pos.b[from] * (m.turn.c === 'w' ? 1 : -1) > 0)) return 'NOT_YOUR_CHECKER';
  if (idx(m.turn.c, from) === 0 && t.played.filter((s) => idx(m.turn.c, s.from) === 0).length >= t.headLimit) return 'HEAD_ONCE';
  return 'BAD_STEP';
}

/** Вернуть последний шаг этого хода — пока не нажато «Готово». */
export function undo(room, userId, now = Date.now()) {
  const r = checkMover(room, userId, now);
  if (r.error) return r;
  const { m } = r;
  if (!m.turn.played.length) return { error: 'NOTHING_TO_UNDO' };
  m.turn.played.pop();
  let pos = { ...clone(m.turn.start), t: m.turn.c };
  for (const s of m.turn.played) pos = apply(pos, s);
  m.pos = pos;
  touch(room);
  return { ok: true };
}

/** «Готово»: ход сыгран целиком — передать кубики сопернику. */
export function endTurn(room, userId, now = Date.now()) {
  const r = checkMover(room, userId, now);
  if (r.error) return r;
  const { m } = r;
  if (!m.turn.dice) return { error: 'ROLL_FIRST' };
  if (!turnState(m).canEnd) return { error: 'MOVES_LEFT' };
  passTurn(room, now, false);
  return { ok: true };
}

/** Записать ход и часы того, кто ходил. */
function finishTurn(room, now) {
  const m = room.match;
  const c = m.turn.c;
  if (!firstPhase(m) && timed(room)) m.clock[c] = leftOf(room, now) + room.settings.inc * 1000;
  m.log.push({ c, dice: m.turn.dice, steps: m.turn.played.slice(), notation: m.turn.played.map((s) => stepText(c, s)) });
  m.turns[c] += 1;
}

function passTurn(room, now, auto) {
  const m = room.match;
  finishTurn(room, now);
  if (auto) m.log.at(-1).auto = true;
  const c = other(m.turn.c);
  m.pos = { ...m.pos, t: c };
  m.turn = { c, dice: null, played: [], start: clone(m.pos), headLimit: HEAD_LIMIT };
  room.turn = null; // часы следующего заведёт ядро
  touch(room);
}

export function resign(room, userId, now = Date.now()) {
  const m = live(room);
  if (!m) return { error: 'NOT_PLAYING' };
  const mine = colorOfPlayer(room, userId);
  if (!mine) return { error: 'NOT_IN_GAME' };
  if (firstPhase(m)) return { error: 'TOO_EARLY' };
  const expired = expireTurn(room, now);
  if (expired) return expired;
  conclude(room, other(mine), 'resign');
  return { ok: true };
}

export function abortMatch(room, userId, now = Date.now()) {
  const m = live(room);
  if (!m) return { error: 'NOT_PLAYING' };
  if (!colorOfPlayer(room, userId) && !isHost(room, userId)) return { error: 'NOT_IN_GAME' };
  if (!firstPhase(m)) return { error: 'TOO_LATE' };
  const expired = expireTurn(room, now);
  if (expired) return expired;
  conclude(room, null, 'aborted', `${nameOf(room, userId)} отменил её до начала игры`);
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
    side: SIDES.includes(patch.side) ? patch.side : cur.side,
  };
  if (next.base === 0) next.inc = 0;
  if (next.base === cur.base && next.inc === cur.inc && next.side === cur.side) return { ok: true, noop: true };
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
  let stopped = !!expireTurn(room, now);
  if (room.status === 'lobby') {
    room.players.splice(room.players.indexOf(p), 1);
  } else {
    p.kicked = true;
    p.seated = false;
    if (live(room) && colorOfPlayer(room, p.id)) {
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
  let stopped = !!expireTurn(room, now);
  if (live(room) && colorOfPlayer(room, p.id)) {
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
  const between = !live(room) && isSeated(p);
  if (!isHost(room, userId) && !between) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { ok: true, noop: true };
  expireTurn(room, now);
  if (live(room)) conclude(room, null, 'aborted', 'серию завершил хост');
  room.status = 'finished';
  room.finishedAt = Date.now();
  room.turn = null;
  touch(room);
  return { ok: true };
}

export function score(room) {
  return room.players
    .filter((pl) => isSeated(pl) || room.history.some((h) => h.white === pl.id || h.black === pl.id))
    .map((pl) => {
      const mine = room.history.filter((h) => !h.aborted && (h.white === pl.id || h.black === pl.id));
      return {
        id: pl.id,
        name: pl.name,
        wins: mine.filter((h) => h.winner === pl.id).length,
        losses: mine.filter((h) => h.winner != null && h.winner !== pl.id).length,
        mars: mine.filter((h) => h.winner === pl.id && h.mars).length,
        games: mine.length,
        isHost: isHost(room, pl.id),
        kicked: !!pl.kicked,
        left: !!pl.left,
      };
    })
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses);
}

/* ------------------------------------------------------------ persistence */

const cloneJson = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

/** Сохраняется всё, включая выпавшие кубики: перезапуск не даёт перебросить. Часы — остатком. */
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
  room.game = 'nardy';
  room.ui = room.ui || {};
  room.ui.lastText = null;
  room.ui.lastKb = null;
  room.ui.lastMsgId = room.ui.lastMsgId || 0;
  room.ui.pings = room.ui.pings || {};
  room.code = room.code || newRoomCode();
  return room;
}
