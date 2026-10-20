'use strict';
/**
 * Шахматы за столом: двое, цвета, часы, сдача и ничья, серия партий.
 *
 * Сами ходы и конец партии — board.js. Здесь то, что делает из доски игру
 * двух людей в Telegram: кто сидит, кто за белых, чей ход и сколько у него
 * осталось, что значит «сдался» и «не пришёл». Как и в остальных играх, это
 * просто функции над комнатой: ни Telegram, ни сокетов, ни таймеров. Каждая
 * принимает id того, кто действует (всегда из подписанного initData, не из
 * сообщения), проверяет и применяет ход или отказывает кодом.
 *
 * Дуэль — игра на двоих: `MAX_SEATS = 2`. Это число читает ядро (хаб), чтобы
 * разрешить хосту несколько лобби сразу.
 *
 * Время. Часы у каждого свои: `m.clock.w` / `m.clock.b` — сколько осталось
 * В НАЧАЛЕ хода тому, чей он сейчас, и сколько у второго. Идущее время —
 * `room.turn` (ключ, срок, остаток), как у остальных игр: ядро его замораживает
 * на время обслуживания и не даёт потеряться при перезапуске. Первые два хода
 * (по одному на каждого) идут по общему короткому сроку FIRST_MS: если
 * соперник так и не пришёл, партия отменяется без результата, а не засчитывается
 * поражением — человек мог просто не увидеть приглашение.
 */
import { newRoomCode } from '../../room.js';
import { cleanName } from '../../fmt.js';
import {
  startPosition, findMove, san, make, legalMoves, outcome, key, canMate, other, inCheck, sqName, fromFen, toFen,
} from './board.js';

export const MAX_SEATS = 2;
export const MIN_PLAYERS = 2;
/** Сдача и время засчитываются в рейтинг, только если сыграно не меньше 10 ходов каждым (20 полуходов). */
export const RATED_MIN_PLIES = 20;
/**
 * КД на просьбы: ничью и откат один и тот же игрок может предлагать не чаще
 * раза в 20 секунд — иначе соперника можно закидать окнами «ответьте мне». К
 * отказу это не относится: после отказа ещё и два хода подряд нельзя.
 */
export const ASK_COOLDOWN_MS = 20_000;
/** На первый ход каждому — столько, независимо от часов партии. */
export const FIRST_MS = 60_000;
/** Секунды на партию; 0 — без часов. */
export const BASES = [0, 60, 180, 300, 600, 900, 1800];
/** Прибавка за ход, секунды. */
export const INCS = [0, 2, 3, 5, 10];
export const SIDES = ['random', 'white', 'black'];
export const SIDE_RU = { random: 'случайно', white: 'белые', black: 'чёрные' };
export const KIND_RU = {
  mate: 'мат',
  resign: 'сдался',
  time: 'время вышло',
  stalemate: 'пат',
  insufficient: 'недостаточно материала',
  fifty: 'правило 50 ходов',
  repetition: 'троекратное повторение',
  agreed: 'ничья по согласию',
  aborted: 'отменена',
};

export const controlRu = (s) => (s.base ? `${s.base >= 60 ? `${Math.round(s.base / 60)} мин` : `${s.base} с`}${s.inc ? ` + ${s.inc} с` : ''}` : 'без часов');

const pick = (v, list, dflt) => (list.includes(Number(v)) ? Number(v) : dflt);

/* ------------------------------------------------------------------ model */

/** Настройки из чего угодно: значения только из списков; без часов нет и прибавки. */
const settingsOf = (base, inc, side) => {
  const b = pick(base, BASES, 600);
  return { base: b, inc: b ? pick(inc, INCS, 0) : 0, side: SIDES.includes(side) ? side : 'random' };
};

export function createRoom({ chatId, host, title = '', code = newRoomCode(), base = 600, inc = 0, side = 'random' }) {
  const room = {
    game: 'chess',
    chatId: String(chatId),
    code,
    title: cleanName(title, '', 40),
    createdAt: Date.now(),
    touchedAt: Date.now(),
    status: 'lobby', // lobby | playing | finished — между партиями серии он остаётся `playing`
    settings: settingsOf(base, inc, side),
    players: [],
    hostId: null,
    gameNo: 0,
    history: [], // { no, white, black, winner (id|null), kind, aborted, plies }
    match: null,
    turn: null, // { key, deadline, remaining } — идущие часы того, чей ход
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

/** Идёт ли сейчас партия (а не пауза между партиями серии). */
export const live = (room) => (room.match && !room.match.over ? room.match : null);

/** Цвет игрока в текущей (или последней) партии: 'w' | 'b' | null. */
export function colorOfPlayer(room, id) {
  const m = room.match;
  if (!m) return null;
  return m.white === String(id) ? 'w' : m.black === String(id) ? 'b' : null;
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

/** Встать из-за стола — только не посреди партии: сдаются, а не уходят. */
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

/** Почему партию нельзя начать, или null. */
export function startBlocker(room) {
  const n = seatedPlayers(room).length;
  if (n < MIN_PLAYERS) return n === 0 ? 'За столом никого нет.' : 'Ждём соперника.';
  return null;
}

/* ------------------------------------------------------------- the match */

function newMatch(room, white, black) {
  const pos = startPosition();
  room.gameNo += 1;
  const { base } = room.settings;
  room.match = {
    no: room.gameNo,
    white,
    black,
    pos,
    moves: [], // { uci, san, from, to, cap }
    seen: { [key(pos)]: 1 },
    clock: { w: base * 1000, b: base * 1000 },
    over: null, // { winner: 'w'|'b'|null, kind }
    drawOffer: null, // { by, ply }
    noOffer: {}, // id -> с какого хода снова можно предлагать
    takeback: null, // { by, ply } — просьба вернуть свой последний ход
    noTake: {}, // id -> с какого хода снова можно просить
    asked: {}, // `id:draw` | `id:takeback` -> когда в последний раз просил (по часам приложения)
    // Позиция и часы ПОСЛЕ каждого хода: по ним откат возвращает доску и время.
    hist: [], // FEN после хода i+1
    clk: [], // { w, b } после хода i+1
  };
  room.turn = null;
}

/** Кто за белых в первой партии: настройка хоста, а `random` решает жребий. */
function firstColors(room, rand) {
  const seated = seatedPlayers(room).sort((x, y) => x.joinedAt - y.joinedAt);
  const a = seated.find((p) => isHost(room, p.id)) || seated[0];
  const b = seated.find((p) => p !== a);
  const hostWhite = room.settings.side === 'white' ? true : room.settings.side === 'black' ? false : rand() < 0.5;
  return hostWhite ? [a.id, b.id] : [b.id, a.id];
}

export function startGame(room, userId, opts = {}) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (room.status !== 'lobby') return { error: 'ALREADY_STARTED' };
  if (startBlocker(room)) return { error: 'NOT_ENOUGH_PLAYERS' };
  const [white, black] = firstColors(room, opts.rand || Math.random);
  room.status = 'playing';
  newMatch(room, white, black);
  room.notice = null;
  touch(room);
  return { ok: true, started: true };
}

/** Следующая партия серии: цвета меняются. Предложить может любой из двоих. */
export function nextGame(room, userId) {
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (room.status !== 'playing') return { error: 'NOT_PLAYING' };
  if (live(room)) return { error: 'GAME_IN_PROGRESS' };
  if (!isSeated(findPlayer(room, userId)) && !isHost(room, userId)) return { error: 'NOT_SEATED' };
  if (startBlocker(room)) return { error: 'NOT_ENOUGH_PLAYERS' };
  const m = room.match;
  const ids = seatedPlayers(room).map((p) => p.id);
  const [white, black] = m && ids.includes(m.white) && ids.includes(m.black) ? [m.black, m.white] : ids;
  newMatch(room, white, black);
  room.notice = null;
  touch(room);
  return { ok: true, started: true };
}

/** Закрыть партию: записать результат, остановить часы. */
function conclude(room, winner, kind, why = null) {
  const m = room.match;
  m.over = { winner, kind };
  m.drawOffer = null;
  m.takeback = null;
  const aborted = kind === 'aborted';
  room.history.push({
    no: m.no,
    white: m.white,
    black: m.black,
    winner: winner ? (winner === 'w' ? m.white : m.black) : null,
    kind,
    aborted,
    plies: m.moves.length,
  });
  room.turn = null;
  const who = winner ? nameOf(room, winner === 'w' ? m.white : m.black) : null;
  room.notice = aborted ? `Партия отменена${why ? ` — ${why}` : ''}. Не засчитывается.`
    : winner ? `${who} выиграл: ${KIND_RU[kind]}`
      : `Ничья: ${KIND_RU[kind]}`;
  touch(room);
}

/** Сколько осталось тому, чей сейчас ход: идёт часами или стоит на паузе. */
export function mover(m) {
  return m.pos.t;
}
export function leftOf(room, now) {
  const m = live(room);
  if (!m) return 0;
  const t = room.turn;
  if (t && t.deadline != null) return Math.max(0, t.deadline - now);
  if (t) return t.remaining;
  return firstPhase(m) ? FIRST_MS : m.clock[mover(m)];
}

const firstPhase = (m) => m.moves.length < 2;
const timed = (room) => room.settings.base > 0;

/**
 * Часы: чего ждёт ядро. Партия идёт — у того, чей ход, есть срок. Пока никто
 * не сделал по ходу, срок общий и короткий (FIRST_MS); дальше — по часам
 * партии, если они вообще включены.
 */
export function syncTurn(room, now) {
  const m = live(room);
  if (!m || room.status !== 'playing' || (!firstPhase(m) && !timed(room))) {
    room.turn = null;
    return null;
  }
  const k = `${m.no}:${m.moves.length}`;
  if (room.turn?.key !== k) room.turn = { key: k, deadline: null, remaining: firstPhase(m) ? FIRST_MS : m.clock[mover(m)] };
  if (room.turn.deadline == null) room.turn.deadline = now + room.turn.remaining;
  return room.turn;
}

/** Время вышло — у того, чей ход (или никто не пришёл на первый ход). */
export function timeoutMove(room, k, now) {
  const m = live(room);
  const t = room.turn;
  if (!m || !t || t.key !== k || `${m.no}:${m.moves.length}` !== k) return { error: 'STALE' };
  if (t.deadline == null || now < t.deadline) return { error: 'EARLY' };
  if (firstPhase(m)) {
    conclude(room, null, 'aborted', 'соперник не сделал первый ход');
    return { ok: true, kind: 'aborted' };
  }
  flagFall(room);
  return { ok: true, kind: 'time' };
}

/** Callback мог задержаться: исход по сроку фиксируем до действия, тем же путём. */
function expireTurn(room, now) {
  const t = room.turn;
  if (!t || t.deadline == null || now < t.deadline) return null;
  const r = timeoutMove(room, t.key, now);
  return r.ok ? { error: 'TIME_UP', ended: true } : null;
}

/** У того, чей ход, упал флажок. Если у соперника нечем ставить мат — это ничья. */
function flagFall(room) {
  const m = live(room);
  const loser = mover(m);
  m.clock[loser] = 0;
  conclude(room, canMate(m.pos.b, other(loser)) ? other(loser) : null, 'time');
}

/**
 * Ход. `ply` (сколько ходов уже сделано) — страховка от запоздавшего
 * нажатия: ход, посланный по старой позиции, не должен лечь на новую.
 */
export function move(room, userId, { from, to, promo = '' }, now = Date.now(), ply = undefined) {
  const m = live(room);
  if (!m) return { error: 'NOT_PLAYING' };
  const mine = colorOfPlayer(room, userId);
  if (!mine) return { error: 'NOT_IN_GAME' };
  if (mine !== mover(m)) return { error: 'NOT_YOUR_TURN' };
  if (ply != null && ply !== m.moves.length) return { error: 'STALE' };
  const mv = findMove(m.pos, from, to, promo);
  if (!mv) return { error: mustPromote(m, from, to, promo) ? 'NEED_PROMO' : 'ILLEGAL' };

  const expired = expireTurn(room, now);
  if (expired) return expired;

  // Часы: потратили `left`, получили прибавку. Первые два хода — без часов партии.
  if (!firstPhase(m) && timed(room)) {
    const left = leftOf(room, now);
    m.clock[mine] = left + room.settings.inc * 1000;
  }
  m.moves.push({ uci: `${sqName(mv.from)}${sqName(mv.to)}${mv.promo}`, san: san(m.pos, mv), from: sqName(mv.from), to: sqName(mv.to), cap: mv.cap });
  m.pos = make(m.pos, mv);
  const k = key(m.pos);
  m.seen[k] = (m.seen[k] || 0) + 1;
  m.hist.push(toFen(m.pos));
  m.clk.push({ w: m.clock.w, b: m.clock.b });
  m.drawOffer = null; // предложение живёт до ближайшего хода
  m.takeback = null; // и просьба об откате — тоже
  room.turn = null; // часы следующего пересоздаст ядро (syncClocks)
  room.notice = null;

  const end = outcome(m.pos, m.seen);
  if (end) conclude(room, end.winner, end.kind);
  else touch(room);
  return { ok: true, san: m.moves.at(-1).san, over: !!end };
}

function mustPromote(m, from, to, promo) {
  return !promo && legalMoves(m.pos).some((x) => sqName(x.from) === from && sqName(x.to) === to && x.promo);
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

/** Пока каждый не сходил, партию можно отменить — без результата и рейтинга. */
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

/** Через сколько миллисекунд игрок снова вправе просить (0 — уже можно). */
export function askWait(m, userId, kind, now) {
  const at = m?.asked?.[`${userId}:${kind}`];
  return at == null ? 0 : Math.max(0, at + ASK_COOLDOWN_MS - now);
}

/** Отказ с КД: сказать, сколько ждать. */
const tooFast = (ms) => ({ error: 'ASK_TOO_FAST', text: `Не так часто: просить можно раз в ${ASK_COOLDOWN_MS / 1000} секунд — подождите ещё ${Math.ceil(ms / 1000)} с.` });

/** Предложить ничью — или принять предложение соперника. */
export function offerDraw(room, userId, now = Date.now()) {
  const m = live(room);
  if (!m) return { error: 'NOT_PLAYING' };
  const mine = colorOfPlayer(room, userId);
  if (!mine) return { error: 'NOT_IN_GAME' };
  const expired = expireTurn(room, now);
  if (expired) return expired;
  if (m.drawOffer && m.drawOffer.by !== String(userId)) {
    conclude(room, null, 'agreed');
    return { ok: true, accepted: true };
  }
  if (m.drawOffer) return { ok: true, noop: true }; // своё же предложение, ещё висит
  if (m.takeback) return { error: 'OFFER_PENDING' }; // сначала ответ на просьбу об откате
  if (firstPhase(m)) return { error: 'TOO_EARLY' };
  const until = m.noOffer[String(userId)] ?? 0;
  if (m.moves.length < until) return { error: 'OFFER_COOLDOWN' };
  const wait = askWait(m, userId, 'draw', now);
  if (wait) return tooFast(wait);
  (m.asked ??= {})[`${userId}:draw`] = now;
  m.drawOffer = { by: String(userId), ply: m.moves.length };
  room.notice = `${nameOf(room, userId)} предлагает ничью`;
  touch(room);
  return { ok: true, offered: true };
}

export function declineDraw(room, userId) {
  const m = live(room);
  if (!m) return { error: 'NOT_PLAYING' };
  if (!colorOfPlayer(room, userId)) return { error: 'NOT_IN_GAME' };
  if (!m.drawOffer || m.drawOffer.by === String(userId)) return { error: 'NO_OFFER' };
  // Предложивший не засыпает соперника: следующее — не раньше, чем через два хода.
  m.noOffer[m.drawOffer.by] = m.moves.length + 2;
  m.drawOffer = null;
  room.notice = `${nameOf(room, userId)} отклонил ничью`;
  touch(room);
  return { ok: true };
}

/* ---------------------------------------------------------------- откат */

/** Сколько ходов в этой партии сделал игрок этого цвета. */
const movesOf = (m, color) => (color === 'w' ? Math.ceil(m.moves.length / 2) : Math.floor(m.moves.length / 2));

/** Почему игрок не может сейчас просить откат, или null. */
export function takebackBlocker(room, userId) {
  const m = live(room);
  if (!m) return 'NOT_PLAYING';
  const mine = colorOfPlayer(room, userId);
  if (!mine) return 'NOT_IN_GAME';
  if (m.takeback) return 'OFFER_PENDING';
  if (m.drawOffer) return 'OFFER_PENDING';
  if (!movesOf(m, mine)) return 'NOTHING_TO_TAKE';
  if (m.moves.length < (m.noTake[String(userId)] ?? 0)) return 'TAKEBACK_COOLDOWN';
  return null;
}

/**
 * Откат: попросить соперника вернуть свой последний ход — или разрешить его
 * просьбу. Возвращается позиция ДО последнего хода просящего: если он только
 * что сходил — один полуход, если соперник уже ответил — два. Часы тоже
 * возвращаются к тому моменту: время, потраченное на отменённые ходы, не
 * сгорает ни у кого.
 */
export function requestTakeback(room, userId, now = Date.now()) {
  const m = live(room);
  if (!m) return { error: 'NOT_PLAYING' };
  const mine = colorOfPlayer(room, userId);
  if (!mine) return { error: 'NOT_IN_GAME' };
  const expired = expireTurn(room, now);
  if (expired) return expired;
  if (m.takeback && m.takeback.by !== String(userId)) return acceptTakeback(room);
  if (m.takeback) return { ok: true, noop: true }; // своя просьба ещё висит
  const why = takebackBlocker(room, userId);
  if (why) return { error: why };
  const wait = askWait(m, userId, 'takeback', now);
  if (wait) return tooFast(wait);
  (m.asked ??= {})[`${userId}:takeback`] = now;
  m.takeback = { by: String(userId), ply: m.moves.length };
  room.notice = `${nameOf(room, userId)} просит вернуть ход`;
  touch(room);
  return { ok: true, offered: true };
}

function acceptTakeback(room) {
  const m = live(room);
  const by = m.takeback.by;
  const pop = mover(m) === colorOfPlayer(room, by) ? 2 : 1; // соперник уже ответил — вернуть и его ход
  revertTo(room, m.moves.length - pop);
  room.notice = `${nameOf(room, by)} вернул ход — соперник разрешил`;
  touch(room);
  return { ok: true, accepted: true };
}

/** Вернуть партию к тому, что было после `n` полуходов. */
function revertTo(room, n) {
  const m = room.match;
  const base = room.settings.base * 1000;
  m.moves.length = n;
  m.hist.length = n;
  m.clk.length = n;
  m.pos = n ? fromFen(m.hist[n - 1]) : startPosition();
  m.clock = n ? { ...m.clk[n - 1] } : { w: base, b: base };
  // Сколько раз встречалась каждая позиция — заново, по оставшейся истории.
  m.seen = { [key(startPosition())]: 1 };
  for (const fen of m.hist) {
    const k = key(fromFen(fen));
    m.seen[k] = (m.seen[k] || 0) + 1;
  }
  m.takeback = null;
  m.drawOffer = null;
  room.turn = null; // часы пересоздаст ядро: ключ другой
}

export function declineTakeback(room, userId) {
  const m = live(room);
  if (!m) return { error: 'NOT_PLAYING' };
  if (!colorOfPlayer(room, userId)) return { error: 'NOT_IN_GAME' };
  if (!m.takeback || m.takeback.by === String(userId)) return { error: 'NO_TAKEBACK' };
  m.noTake[m.takeback.by] = m.moves.length + 2; // не засыпать соперника просьбами
  m.takeback = null;
  room.notice = `${nameOf(room, userId)} отказал в откате`;
  touch(room);
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

/** Игрок вышел из Telegram-группы: партия, в которой он играл, отменяется. */
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

/** Конец серии. Идущая партия не засчитывается. Закрыть может хост — или любой из двоих между партиями. */
export function endGame(room, userId, now = Date.now()) {
  const p = findPlayer(room, userId);
  // Между партиями закрыть может любой из двоих; лобби — только хост (аудит A-03).
  const between = room.status !== 'lobby' && !live(room) && isSeated(p);
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

/** Счёт серии: по партиям, без отменённых. */
export function score(room) {
  return room.players
    .filter((pl) => isSeated(pl) || room.history.some((h) => h.white === pl.id || h.black === pl.id))
    .map((pl) => {
      const mine = room.history.filter((h) => !h.aborted && (h.white === pl.id || h.black === pl.id));
      return {
        id: pl.id,
        name: pl.name,
        wins: mine.filter((h) => h.winner === pl.id).length,
        draws: mine.filter((h) => h.winner == null).length,
        losses: mine.filter((h) => h.winner != null && h.winner !== pl.id).length,
        games: mine.length,
        isHost: isHost(room, pl.id),
        kicked: !!pl.kicked,
        left: !!pl.left,
      };
    })
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.draws - a.draws);
}

export const checked = (m) => !!m && inCheck(m.pos);

/* ------------------------------------------------------------ persistence */

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

/** Часы сохраняются как остаток: простой бота — не чьё-то время. */
export function serialize(room, now = Date.now()) {
  const copy = clone(room);
  if (copy.turn && copy.turn.deadline != null) {
    copy.turn.remaining = Math.max(0, copy.turn.deadline - now);
    copy.turn.deadline = null;
  }
  return copy;
}

export function deserialize(data) {
  const room = clone(data);
  room.game = 'chess';
  room.ui = room.ui || {};
  room.ui.lastText = null; // заставить карточку перерисоваться
  room.ui.lastKb = null;
  room.ui.lastMsgId = room.ui.lastMsgId || 0;
  room.ui.pings = room.ui.pings || {};
  room.code = room.code || newRoomCode();
  if (room.match && !room.match.hist) rebuildHistory(room.match); // стол, сохранённый до отката
  return room;
}

/**
 * Столы, начатые до появления отката, не хранят позиции по ходам: восстановим
 * их, переиграв записанные ходы. Часы такой партии уже не вернуть по ходам —
 * откат вернёт их к нынешним значениям (лучше, чем потерять откат вовсе).
 */
function rebuildHistory(m) {
  let pos = startPosition();
  m.hist = [];
  m.clk = [];
  for (const mv of m.moves) {
    const found = findMove(pos, mv.from, mv.to, mv.uci.slice(4));
    if (!found) break;
    pos = make(pos, found);
    m.hist.push(toFen(pos));
    m.clk.push({ ...m.clock });
  }
  m.takeback ??= null;
  m.noTake ??= {};
}
