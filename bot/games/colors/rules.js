'use strict';
/**
 * «Радуга» — правила как чистые функции над комнатой. Ни Telegram, ни
 * сокетов, ни таймеров: каждая функция берёт комнату и id того, кто ходит
 * (всегда из проверенной подписи, никогда из тела сообщения), проверяет ход,
 * применяет его или отказывает кодом.
 *
 * Правила целиком — в docs/game-hub.md, раздел «Правила Радуги»; на каждое
 * есть по тесту в colors.rules.test.js.
 *
 * Места идут в том порядке, в каком садились; «следующий» — соседнее место в
 * эту сторону, а «разворот» эту сторону меняет.
 *
 * Два решения, которых нет в книжке, и оба в пользу темпа:
 *
 *   1. КОГДА ВЫБОРА НЕТ, ЗА НЕГО НЕ ПРОСЯТ ТАПА. Прилетело «+2», а крыть
 *      нечем — карты берутся сами и ход идёт дальше. Кнопка «Взять N» есть
 *      только у того, кому действительно есть что выбрать.
 *   2. ВЗЯТАЯ КАРТА НЕ ПОДОШЛА — ход уходит сам. Держать человека ради
 *      «ладно, пас» не за чем: решать ему нечего.
 */
import crypto from 'node:crypto';
import { newRoomCode } from '../../room.js';
import { cleanName } from '../../fmt.js';
import {
  COLORS, COLOR_RU, SIGN_RU, HAND, isCard, isWild, isNumber, colorOf, signOf, matches, label,
  shuffled, shuffleOf, isFullDeck, takeOne, WILD, WILD_FOUR,
} from './cards.js';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** Чем ещё можно покрыть верхнюю карту, кроме цвета, — словами. */
const topWord = (d) =>
  isWild(d.top) ? 'любая карта названного цвета'
    : isNumber(d.top) ? `любая ${signOf(d.top)}`
      : `любой «${SIGN_RU[signOf(d.top)]}»`;

/** Показываемое название. Одной константой: его могут поменять. */
export const TITLE = 'Радуга';

export const MAX_SEATS = 8;
export const MIN_PLAYERS = 2;
/** Сколько у человека есть, чтобы нажать «Радуга!», пока его не поймали. */
export const CALL_MS = 5_000;
/** Столько кругов подряд бот ходит за всех — и партия останавливается. */
export const IDLE_ROUNDS = 2;
/** Лента событий над кучей: столько последних держим, три из них показываем. */
const EVENTS_KEPT = 6;

const defaultDeck = () => shuffled();

/* ------------------------------------------------------------------ model */

export function createRoom({ chatId, host, title = '', code = newRoomCode(), stacking = true, turnSeconds = 0 }) {
  const room = {
    game: 'colors',
    chatId: String(chatId),
    code,
    title: cleanName(title, '', 40),
    createdAt: Date.now(),
    touchedAt: Date.now(),
    status: 'lobby', // lobby | playing | finished — между двумя партиями всё ещё `playing`
    settings: {
      stacking: stacking !== false,
      turnSeconds: timerIn(turnSeconds, 0),
    },
    players: [],
    hostId: null,
    gameNo: 0,
    lastLoser: null, // последний прошлой партии: следующую сдаёт он
    lastDealer: null,
    history: [], // { no, loser, aborted, out: [id...], quit: [id...] }
    deal: null,
    turn: null, // { key, deadline, remaining } — таймер хода, если хост его включил
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

/** 0 = выключен; иначе от 15 секунд до 10 минут. */
function timerIn(v, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  if (n <= 0) return 0;
  return Math.min(600, Math.max(15, n));
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

/**
 * Сесть за стол. Один аккаунт — одно место: второй тап находит ту же строку.
 * Кто сел посреди партии, тому сдадут со следующей.
 */
export function addPlayer(room, user) {
  const id = String(user.id);
  const existing = findPlayer(room, id);
  if (existing?.kicked) return { error: 'KICKED' };
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (existing && isSeated(existing)) {
    existing.name = cleanName(user.name, existing.name);
    return existing;
  }
  if (seatedPlayers(room).length >= MAX_SEATS) {
    return { error: 'TABLE_FULL', text: `За столом нет мест — в «${TITLE}» играют до восьми.` };
  }
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
    stats: { games: 0, last: 0, wins: 0, forced: 0, drew: 0, wilds: 0 },
  };
  room.players.push(p);
  touch(room);
  return p;
}

/** Встать. Не посреди партии: карты в руке принадлежат ей. */
export function leave(room, userId) {
  const p = findPlayer(room, userId);
  if (!p || !isSeated(p)) return { error: 'NOT_SEATED' };
  if (inLiveDeal(room, p.id)) return { error: 'IN_DEAL' };
  if (room.status === 'lobby' && !isHost(room, p.id)) {
    room.players.splice(room.players.indexOf(p), 1);
  } else {
    p.seated = false;
  }
  room.notice = `${p.name} встал из-за стола`;
  touch(room);
  return { ok: true };
}

/* --------------------------------------------------------------- the deal */

const live = (room) => (room.deal && room.deal.phase === 'play' ? room.deal : null);
const inLiveDeal = (room, id) => !!live(room)?.order.includes(String(id));

/** Кто ещё в партии: не вышел и не ушёл из чата. */
export const alive = (d) => d.order.filter((id) => !d.out.includes(id) && !d.quit.includes(id));

/** Следующее место за `id` в текущую сторону — из тех, кто ещё играет. */
export function nextAlive(d, id, steps = 1) {
  const ring = alive(d);
  if (!ring.length) return null;
  let at = ring.indexOf(String(id));
  // Того, кто только что вышел, в кольце уже нет: отсчитываем от его соседа.
  if (at < 0) {
    const all = d.order;
    let k = all.indexOf(String(id));
    for (let i = 0; i < all.length && at < 0; i++) {
      k = (k + d.dir + all.length) % all.length;
      at = ring.indexOf(all[k]);
    }
    if (at < 0) return null;
    steps -= 1; // шаг до соседа уже сделан
  }
  const n = ring.length;
  return ring[(((at + d.dir * steps) % n) + n) % n];
}

export function startBlocker(room) {
  const n = seatedPlayers(room).length;
  if (n < MIN_PLAYERS) return n === 0 ? 'За столом никого нет.' : 'Нужен ещё хотя бы один игрок.';
  return null;
}

export function startGame(room, userId, opts = {}) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (room.status !== 'lobby') return { error: 'ALREADY_STARTED' };
  const blocker = startBlocker(room);
  if (blocker) return { error: 'NOT_ENOUGH_PLAYERS', text: blocker };
  room.status = 'playing';
  const r = dealGame(room, opts);
  if (r.error) room.status = 'lobby';
  return r;
}

/** Следующая партия серии — сдать может любой за столом. */
export function nextGame(room, userId, opts = {}) {
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (room.status !== 'playing') return { error: 'NOT_PLAYING' };
  if (live(room)) return { error: 'DEAL_IN_PROGRESS' };
  if (!isSeated(findPlayer(room, userId)) && !isHost(room, userId)) return { error: 'NOT_SEATED' };
  const blocker = startBlocker(room);
  if (blocker) return { error: 'NOT_ENOUGH_PLAYERS', text: blocker };
  return dealGame(room, opts);
}

/**
 * Начало: по семь карт каждому, верхняя карта колоды — в сброс. Если она
 * особая, колода тасуется заново и открывается снова, пока не выйдет цифра:
 * партия должна начинаться с чистого листа, а не с чужого «+4».
 *
 * Первым ходит тот, кто слева от сдающего; сторона — по часовой.
 */
function dealGame(room, { deck = defaultDeck, randInt = (n) => crypto.randomInt(n) } = {}) {
  const { order, dealer, dealOrder } = nextDealOrder(room);
  const n = order.length;

  let cards = null;
  // Пересдача — только если открылась особая. Чужая подтасовка в тестах даёт
  // ту же колоду снова, поэтому круг конечный: не вышло — играем как есть.
  for (let tries = 0; tries < 20; tries++) {
    const got = deck();
    if (!isFullDeck(got)) return { error: 'BAD_DECK' };
    cards = got;
    if (isNumber(cards[HAND * n])) break;
    if (tries === 0) continue;
    cards = shuffleOf(cards, randInt);
    if (isNumber(cards[HAND * n])) break;
  }
  // Крайний случай: открылась особая и перетасовать не вышло — уводим первую
  // цифру наверх руками, чтобы партия всё равно началась с цифры.
  if (!isNumber(cards[HAND * n])) {
    const at = cards.findIndex((c, i) => i >= HAND * n && isNumber(c));
    if (at < 0) return { error: 'BAD_DECK' };
    [cards[HAND * n], cards[at]] = [cards[at], cards[HAND * n]];
  }

  const hands = Object.fromEntries(order.map((id) => [id, []]));
  for (let k = 0; k < HAND * n; k++) hands[dealOrder[k % n]].push(cards[k]);
  const top = cards[HAND * n];
  const rest = cards.slice(HAND * n + 1);

  room.gameNo += 1;
  const d = {
    no: room.gameNo,
    order,
    dealer,
    hands,
    deck: rest,
    discard: [], // всё, что под верхней картой; наружу уходит только число
    top,
    color: colorOf(top),
    dir: 1,
    turn: dealOrder[0], // слева от сдающего
    pending: 0,
    pendingKind: null, // 'P' (+2) или 'F' (+4)
    pendingBy: null, // кто это накопил — ему и зачтётся «заставил взять»
    drawn: null, // карта, только что взятая ходящим: её можно сыграть сразу
    out: [], // порядок выхода — он же порядок мест
    quit: [], // ушли из чата посреди партии
    call: null, // { id, at, called } — окно «Радуга!»
    phase: 'play',
    loser: null,
    aborted: false,
    abortedWhy: null,
    events: [], // лента над кучей; карта в ней — та, что лежит у всех на виду
    stats: Object.fromEntries(order.map((id) => [id, { forced: 0, drew: 0, wilds: 0, played: 0 }])),
    step: 0, // меняется на каждом переходе хода — на нём держится таймер
    moves: 0,
    idle: 0,
  };
  room.deal = d;
  room.turn = null;
  room.notice = `Партия #${d.no}: первым ходит ${nameOf(room, d.turn)}`;
  touch(room);
  return { ok: true };
}

/**
 * Кто сдаёт следующую партию и в каком порядке идут карты: сдаёт последний
 * прошлой партии (первую — хост), по одной с его левой руки.
 */
export function nextDealOrder(room) {
  const order = seatedPlayers(room).map((p) => p.id);
  const n = order.length;
  const dealer = [room.lastLoser, room.lastDealer, room.hostId].find((id) => id && order.includes(id)) || order[0];
  const from = order.indexOf(dealer);
  return { order, dealer, dealOrder: order.map((_, k) => order[(from + 1 + k) % n]) };
}

/* --------------------------------------------------------------- the moves */

/** Проверки, общие всем ходам: партия идёт, человек в ней, его очередь. */
function guard(room, userId, seq) {
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  const d = live(room);
  if (!d) return { error: room.status === 'lobby' ? 'NOT_PLAYING' : 'DEAL_OVER' };
  if (typeof seq === 'number' && seq !== room.seq) return { error: 'STALE', seq: room.seq };
  const id = String(userId);
  if (!d.order.includes(id)) return { error: 'NOT_IN_DEAL' };
  if (d.out.includes(id) || d.quit.includes(id)) return { error: 'OUT' };
  if (d.turn !== id) return { error: 'NOT_YOUR_TURN', text: `Сейчас ходит ${nameOf(room, d.turn)}.` };
  return { d, id };
}

/** Что сейчас висит на столе: «+2» кладут на «+2», и берёт следующий сумму. */
export function stackableOn(d, card) {
  if (!d.pending) return false;
  if (d.pendingKind === 'F') return card === WILD_FOUR; // на «+4» — только «+4»
  return signOf(card) === 'P' || card === WILD_FOUR; // на «+2» — «+2» или «+4»
}

/**
 * Положить карту. Цвет называется только у бесцветной — и только ей.
 */
export function play(room, userId, card, { color = null, seq, now = Date.now(), randInt = (n) => crypto.randomInt(n) } = {}) {
  const g = guard(room, userId, seq);
  if (g.error) return g;
  const { d, id } = g;
  if (!isCard(card)) return { error: 'NOT_YOUR_CARD' };
  if (!d.hands[id].includes(card)) return { error: 'NOT_YOUR_CARD' };
  // Взял карту — играть можно только её: остальная рука уже спасовала.
  if (d.drawn && card !== d.drawn) return { error: 'ONLY_DRAWN' };

  if (d.pending) {
    if (!room.settings.stacking) return { error: 'MUST_TAKE' };
    if (!stackableOn(d, card)) return { error: d.pendingKind === 'F' ? 'STACK_FOUR_ONLY' : 'STACK_ONLY' };
  } else if (!matches(card, d.top, d.color)) {
    return { error: 'CANNOT_PLAY', text: `${cap(label(card))} сюда не ложится: нужен ${COLOR_RU[d.color]}, ${topWord(d)} или смена цвета.` };
  }
  if (isWild(card) && !COLORS.includes(color)) return { error: 'NEED_COLOR' };

  takeOne(d.hands[id], card);
  d.discard.push(d.top);
  d.top = card;
  d.color = isWild(card) ? color : colorOf(card);
  d.drawn = null;
  d.stats[id].played += 1;
  if (isWild(card)) d.stats[id].wilds += 1;

  const hand = d.hands[id];
  if (hand.length === 1) d.call = { id, at: now, called: false };
  else if (d.call?.id === id) d.call = null; // вышел или набрал карт — ловить некого
  const wentOut = hand.length === 0;
  if (wentOut) {
    d.out.push(id);
    if (d.call?.id === id) d.call = null;
  }

  // Эффекты карты. «Разворот» вдвоём — это «стоп»: развернуть круг из двух
  // игроков значит отдать ход тому же человеку, а это и есть пропуск.
  let skip = 0;
  const sign = signOf(card);
  if (sign === 'P') {
    d.pending += 2;
    d.pendingKind = 'P';
    d.pendingBy = id;
  } else if (card === WILD_FOUR) {
    d.pending += 4;
    d.pendingKind = 'F';
    d.pendingBy = id;
  } else if (sign === 'S') {
    skip = 1;
  } else if (sign === 'V') {
    if (alive(d).length <= 2) skip = 1;
    else d.dir = -d.dir;
  }

  note(d, { kind: wentOut ? 'out' : 'play', by: id, card, color: d.color });
  advance(room, { skip, by: id, now, randInt });
  return played(room, { wentOut });
}

/**
 * Взять из колоды. Это же действие — «взять всё, что висит»: когда прилетело
 * «+2» и крыть есть чем, человек может и не крыть.
 */
export function draw(room, userId, { seq, now = Date.now(), randInt = (n) => crypto.randomInt(n) } = {}) {
  const g = guard(room, userId, seq);
  if (g.error) return g;
  const { d, id } = g;
  if (d.drawn) return { error: 'ALREADY_DREW' };

  if (d.pending) {
    const n = d.pending;
    forceDraw(room, id, n, { randInt, by: d.pendingBy });
    d.pending = 0;
    d.pendingKind = null;
    d.pendingBy = null;
    note(d, { kind: 'take', by: id, count: n });
    advance(room, { skip: 0, by: id, now, randInt, drewPending: true });
    return played(room, {});
  }

  // Брать — когда класть нечего. Это про свою же руку: подсказки чужой нет.
  if (playableFor(d, id, room.settings).length) return { error: 'CAN_PLAY' };

  const got = drawCards(d, 1, { randInt });
  d.stats[id].drew += got.length;
  if (!got.length) {
    // Колода и сброс пусты: брать неоткуда — ход просто переходит.
    note(d, { kind: 'empty', by: id });
    advance(room, { skip: 0, by: id, now, randInt });
    return played(room, {});
  }
  const card = got[0];
  d.hands[id].push(card);
  if (d.call?.id === id) d.call = null; // карт стало больше одной
  note(d, { kind: 'draw', by: id });
  if (matches(card, d.top, d.color)) {
    d.drawn = card; // подошла — можно сыграть прямо сейчас
    d.step += 1; // новое ожидание: таймер считает заново
    return played(room, {});
  }
  advance(room, { skip: 0, by: id, now, randInt });
  return played(room, {});
}

/** Взятая карта подошла, но играть её не хочется — ход уходит дальше. */
export function pass(room, userId, { seq, now = Date.now(), randInt = (n) => crypto.randomInt(n) } = {}) {
  const g = guard(room, userId, seq);
  if (g.error) return g;
  const { d, id } = g;
  if (!d.drawn) return { error: 'NOTHING_TO_PASS' };
  d.drawn = null;
  advance(room, { skip: 0, by: id, now, randInt });
  return played(room, {});
}

/**
 * «Радуга!» — своя и только своя. Нажать за другого нельзя: вся эта кнопка
 * про то, успел ли человек сам.
 */
export function rainbow(room, userId, { now = Date.now() } = {}) {
  const d = live(room);
  if (!d) return { error: room.status === 'lobby' ? 'NOT_PLAYING' : 'DEAL_OVER' };
  const id = String(userId);
  if (!d.order.includes(id)) return { error: 'NOT_IN_DEAL' };
  if (d.hands[id]?.length !== 1) return { error: 'NOT_ONE_CARD' };
  if (!d.call || d.call.id !== id) return { error: 'NOT_ONE_CARD' };
  if (d.call.called) return { ok: true, noop: true };
  d.call.called = true;
  note(d, { kind: 'rainbow', by: id });
  room.notice = `🌈 ${nameOf(room, id)}: Радуга! Осталась одна карта.`;
  touch(room);
  return { ok: true };
}

/**
 * «Поймал!» — за того, кто с одной картой промолчал. Своё молчание поймать
 * нельзя, и после пяти секунд ловить уже поздно: промолчал и ушёл чисто.
 */
export function catchRainbow(room, userId, { now = Date.now(), randInt = (n) => crypto.randomInt(n) } = {}) {
  const d = live(room);
  if (!d) return { error: room.status === 'lobby' ? 'NOT_PLAYING' : 'DEAL_OVER' };
  const id = String(userId);
  if (!d.order.includes(id)) return { error: 'NOT_IN_DEAL' };
  const c = d.call;
  if (!c || c.called) return { error: 'NOTHING_TO_CATCH' };
  if (c.id === id) return { error: 'CATCH_SELF' };
  if (now - c.at >= CALL_MS) return { error: 'TOO_LATE' };
  if (d.hands[c.id]?.length !== 1) return { error: 'NOTHING_TO_CATCH' };

  forceDraw(room, c.id, 2, { randInt, by: id });
  d.call = null;
  note(d, { kind: 'caught', by: id, target: c.id });
  room.notice = `🫵 ${nameOf(room, id)} поймал: ${nameOf(room, c.id)} молчал и берёт две.`;
  touch(room);
  return { ok: true, target: c.id };
}

/* ------------------------------------------------------------- the engine */

/** Запись в ленту над кучей. Карта в ней лежит у всех на виду — это не секрет. */
function note(d, e) {
  d.events.push({ n: (d.events.at(-1)?.n ?? 0) + 1, ...e });
  if (d.events.length > EVENTS_KEPT) d.events.splice(0, d.events.length - EVENTS_KEPT);
}

/** Снять `n` карт с колоды; кончилась — сброс, кроме верхней, идёт в колоду. */
function drawCards(d, n, { randInt }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!d.deck.length) {
      if (!d.discard.length) break; // и так пусто — больше взять негде
      d.deck = shuffleOf(d.discard, randInt);
      d.discard = [];
    }
    out.push(d.deck.shift());
  }
  return out;
}

/**
 * Выдать человеку карты не по его воле: «+2», «+4», «Поймал!». Взятое
 * записывается дважды — ему «взял», а тому, из-за кого, «заставил взять».
 */
function forceDraw(room, id, n, { randInt, by = null }) {
  const d = room.deal;
  const got = drawCards(d, n, { randInt });
  d.hands[id].push(...got);
  d.stats[id].drew += got.length;
  const blame = by && by !== id ? by : null;
  if (blame && d.stats[blame]) d.stats[blame].forced += got.length;
  if (got.length && d.call?.id === id) d.call = null;
  return got.length;
}

/**
 * Передать ход. Здесь же разбирается накопление: если тому, кому ход
 * достался, крыть нечем (или накопление выключено), он берёт сам и ход идёт
 * дальше — тапа ради единственного возможного действия не просят.
 */
function advance(room, { skip = 0, by, randInt, drewPending = false }) {
  const d = room.deal;
  d.drawn = null;
  d.step += 1;

  // Тот, кто только что взял по накоплению, свой ход пропускает.
  if (drewPending) {
    d.turn = nextAlive(d, by, 1);
    return;
  }
  if (skip) {
    const skipped = nextAlive(d, by, 1);
    if (skipped) note(d, { kind: 'skip', by: skipped });
  }
  d.turn = nextAlive(d, by, 1 + skip);

  // Накопление: кому крыть нечем, тот берёт сам, и ход идёт дальше. Когда в
  // партии остался один, крыть всё равно некому — он берёт в любом случае:
  // вышедший последней «+2» своё «+2» с собой не уносит.
  for (let g = 0; g < d.order.length + 2 && d.pending && d.turn; g++) {
    const who = d.turn;
    const canStack = room.settings.stacking && alive(d).length > 1 && d.hands[who].some((c) => stackableOn(d, c));
    if (canStack) return; // есть из чего выбирать — пусть выбирает
    const n = d.pending;
    forceDraw(room, who, n, { randInt, by: d.pendingBy });
    d.pending = 0;
    d.pendingKind = null;
    d.pendingBy = null;
    note(d, { kind: 'forced', by: who, count: n });
    d.step += 1;
    d.turn = nextAlive(d, who, 1);
  }
}

/** Всё, что после хода: может быть, партия кончилась. */
function played(room, { wentOut = false, byTimer = false } = {}) {
  const d = room.deal;
  if (byTimer) d.idle = (d.idle || 0) + 1;
  else {
    d.moves += 1;
    d.idle = 0;
  }
  const left = alive(d);
  if (left.length <= 1) {
    endDeal(room, left[0] ?? null);
    touch(room);
    return { ok: true, wentOut };
  }
  if (byTimer && d.idle >= IDLE_ROUNDS * d.order.length) {
    abortDeal(room, 'никто не ходит сам — время выходит у всех');
  }
  touch(room);
  return { ok: true, wentOut };
}

/**
 * Партия кончилась: вышел последний, кому было чем ходить. Он и «последний» —
 * как дурак в дураке, и минус в рейтинге достаётся ему.
 */
function endDeal(room, loserId) {
  const d = room.deal;
  d.phase = 'over';
  d.loser = loserId;
  d.call = null;
  d.pending = 0;
  d.pendingKind = null;
  d.pendingBy = null;
  d.drawn = null;
  if (loserId && !d.out.includes(loserId)) d.out.push(loserId);
  room.history.push({ no: d.no, loser: loserId, aborted: false, out: [...d.out], quit: [...d.quit] });
  room.lastLoser = loserId;
  room.lastDealer = d.dealer;
  for (const id of d.order) {
    const p = findPlayer(room, id);
    if (!p || d.quit.includes(id)) continue;
    p.stats.games += 1;
    if (id === loserId) p.stats.last += 1;
    if (d.out[0] === id) p.stats.wins += 1;
    // За серию, а не за партию: экран итогов говорит про весь вечер.
    const s = d.stats[id] || {};
    p.stats.forced += s.forced || 0;
    p.stats.drew += s.drew || 0;
    p.stats.wilds += s.wilds || 0;
  }
  room.turn = null;
  room.notice = loserId ? `🏁 Партия #${d.no}: последний — ${nameOf(room, loserId)}` : `🏁 Партия #${d.no} закончилась`;
}

/**
 * Партия, которую нельзя доиграть (вдвоём, и один ушёл). Карт его никто не
 * видел и сыграть за него нельзя — партия останавливается и не считается.
 */
function abortDeal(room, why) {
  const d = live(room);
  if (!d) return false;
  d.phase = 'over';
  d.aborted = true;
  d.abortedWhy = why;
  d.call = null;
  d.drawn = null;
  room.history.push({ no: d.no, loser: null, aborted: true, out: [...d.out], quit: [...d.quit] });
  room.turn = null;
  room.notice = `Партия прервана: ${why}. Она не засчитывается.`;
  return true;
}

/* ------------------------------------------------------------- the timer */

/** Чего партия ждёт прямо сейчас, одним ключом: новый ход — новые часы. */
export function waitKey(room) {
  const d = live(room);
  if (!d) return null;
  return `${d.no}:${d.step}:${d.turn}`;
}

/** Таймер хода, паркуемый на диск, как покерный. */
export function syncTurn(room, now) {
  const secs = room.settings.turnSeconds || 0;
  const key = waitKey(room);
  if (!secs || !key || room.status !== 'playing') {
    room.turn = null;
    return null;
  }
  if (room.turn?.key !== key) room.turn = { key, deadline: null, remaining: secs * 1000 };
  if (room.turn.deadline == null) room.turn.deadline = now + room.turn.remaining;
  return room.turn;
}

/**
 * Время вышло. Самое малое, что бот делает вместо человека: берёт одну карту
 * и передаёт ход. Если висит «+2», брать приходится их — отдать ход, не
 * разобравшись с ними, нельзя.
 */
export function timeoutMove(room, key, now, { randInt = (n) => crypto.randomInt(n) } = {}) {
  const t = room.turn;
  const d = live(room);
  if (!d || !t || t.key !== key || waitKey(room) !== key) return { error: 'STALE' };
  if (t.deadline == null || now < t.deadline) return { error: 'EARLY' };
  const who = d.turn;

  if (d.pending) {
    const n = d.pending;
    forceDraw(room, who, n, { randInt, by: d.pendingBy });
    d.pending = 0;
    d.pendingKind = null;
    d.pendingBy = null;
    note(d, { kind: 'take', by: who, count: n });
    room.notice = `${nameOf(room, who)}: время вышло — берёт ${n}`;
    advance(room, { skip: 0, by: who, now, randInt, drewPending: true });
    return finishTimer(room, who, 'take');
  }
  if (d.drawn) {
    d.drawn = null;
    room.notice = `${nameOf(room, who)}: время вышло — ход переходит`;
    advance(room, { skip: 0, by: who, now, randInt });
    return finishTimer(room, who, 'pass');
  }
  const got = drawCards(d, 1, { randInt });
  d.hands[who].push(...got);
  d.stats[who].drew += got.length;
  if (got.length && d.call?.id === who) d.call = null;
  note(d, { kind: got.length ? 'draw' : 'empty', by: who });
  room.notice = got.length
    ? `${nameOf(room, who)}: время вышло — бот взял карту и передал ход`
    : `${nameOf(room, who)}: время вышло — брать нечего, ход переходит`;
  advance(room, { skip: 0, by: who, now, randInt });
  return finishTimer(room, who, 'draw');
}

function finishTimer(room, who, move) {
  const r = played(room, { byTimer: true });
  return r.error ? r : { ok: true, who: [who], move };
}

/* -------------------------------------------------------- what is allowed */

/** Карты руки `id`, которые можно положить прямо сейчас. Только своя рука. */
function playableFor(d, id, settings) {
  const hand = d.hands[id] || [];
  if (d.drawn) return hand.includes(d.drawn) ? [d.drawn] : [];
  if (d.pending) {
    if (!settings.stacking) return [];
    return hand.filter((c) => stackableOn(d, c));
  }
  return hand.filter((c) => matches(c, d.top, d.color));
}

/**
 * Ходы, которые есть у одного игрока прямо сейчас, — посчитанные ТОЛЬКО по
 * его руке, так что ответ ничего не говорит о чужих картах. Приложение
 * поднимает эти карты; сервер всё равно проверяет каждый ход заново.
 */
export function legalFor(room, userId, { now = Date.now() } = {}) {
  const d = live(room);
  const id = String(userId);
  const none = { play: [], draw: false, drawCount: 0, pass: false, rainbow: false, catch: null, myTurn: false, needColor: false };
  if (!d || !d.order.includes(id) || d.out.includes(id) || d.quit.includes(id)) {
    return { ...none, catch: catchableFor(d, id, now) };
  }
  const myTurn = d.turn === id;
  const playable = myTurn ? playableFor(d, id, room.settings) : [];
  return {
    play: [...new Set(playable)],
    // «Взять» всегда есть, когда класть нечего, и когда висит накопление:
    // взять — это и есть законный ответ на «+2».
    draw: myTurn && (d.pending > 0 || (!d.drawn && playable.length === 0)),
    drawCount: myTurn && d.pending ? d.pending : 1,
    pass: myTurn && !!d.drawn,
    rainbow: !!d.call && d.call.id === id && !d.call.called && d.hands[id].length === 1,
    catch: catchableFor(d, id, now),
    myTurn,
    needColor: playable.some(isWild),
  };
}

/** Кого этот человек может поймать прямо сейчас (и до какой секунды). */
function catchableFor(d, id, now) {
  const c = d?.call;
  if (!c || c.called || c.id === String(id)) return null;
  if (now - c.at >= CALL_MS) return null;
  if (d.hands[c.id]?.length !== 1) return null;
  return { id: c.id, until: c.at + CALL_MS };
}

/* ----------------------------------------------------------- host and seats */

export function updateSettings(room, userId, patch = {}) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  const cur = room.settings;
  const stacking = typeof patch.stacking === 'boolean' ? patch.stacking : cur.stacking;
  const turnSeconds = patch.turnSeconds != null ? timerIn(patch.turnSeconds, cur.turnSeconds) : cur.turnSeconds;
  if (stacking !== cur.stacking && live(room)) return { error: 'DEAL_IN_PROGRESS' };
  if (stacking === cur.stacking && turnSeconds === cur.turnSeconds) return { ok: true, noop: true };
  room.settings = { ...cur, stacking, turnSeconds };
  room.notice =
    stacking !== cur.stacking
      ? stacking
        ? 'Накопление включено: «+2» можно положить на «+2».'
        : 'Накопление выключено: «+2» кроют только картами.'
      : turnSeconds
        ? `Таймер хода: ${turnSeconds} с. Не успел — бот берёт карту и передаёт ход.`
        : 'Таймер хода выключен.';
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

export function kickPlayer(room, userId, targetId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (String(targetId) === room.hostId) return { error: 'CANNOT_KICK_HOST' };
  const p = findPlayer(room, targetId);
  if (!p || p.kicked) return { error: 'NO_PLAYER' };
  let msg = `${p.name} удалён из игры`;
  if (room.status === 'lobby') {
    room.players.splice(room.players.indexOf(p), 1);
  } else {
    p.kicked = true;
    p.seated = false;
    const r = dropFromDeal(room, p.id, `хост удалил ${p.name}`);
    if (r) msg = null;
  }
  if (msg) room.notice = msg;
  touch(room);
  return { ok: true };
}

/**
 * Кто-то вышел из партии посреди неё (из группы, или его удалил хост).
 *
 * Втроём и больше партия продолжается без него: его карты уходят в сброс,
 * место ему — последнее. Вдвоём продолжать не из чего — партия прерывается и
 * не засчитывается.
 */
function dropFromDeal(room, id, why) {
  const d = live(room);
  if (!d || !d.order.includes(id) || d.out.includes(id) || d.quit.includes(id)) return null;
  if (alive(d).length <= 2) {
    abortDeal(room, why);
    return 'aborted';
  }
  const wasTurn = d.turn === id;
  d.discard.push(...d.hands[id]);
  d.hands[id] = [];
  d.quit.push(id);
  if (d.call?.id === id) d.call = null;
  note(d, { kind: 'quit', by: id });
  room.notice = `${nameOf(room, id)} вышел из партии — она продолжается без него.`;
  const left = alive(d);
  if (left.length <= 1) {
    endDeal(room, left[0] ?? null);
    return 'ended';
  }
  if (wasTurn) {
    d.pending = 0;
    d.pendingKind = null;
    d.drawn = null;
    d.step += 1;
    d.turn = nextAlive(d, id, 1);
  }
  return 'dropped';
}

/** Кто-то вышел из группы. */
export function markLeft(room, targetId) {
  const p = findPlayer(room, targetId);
  if (!p || p.left) return { error: 'NO_PLAYER' };
  p.left = true;
  p.seated = false;
  const r = dropFromDeal(room, p.id, `${p.name} вышел из чата`);
  if (room.hostId === p.id) reassignHost(room);
  if (!r) room.notice = `${p.name} вышел из чата`;
  touch(room);
  return { ok: true, player: p };
}

/** Хост останавливает партию, которую нельзя доиграть. Она не считается. */
export function abortGame(room, userId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (!live(room)) return { error: 'DEAL_OVER' };
  abortDeal(room, 'её остановил хост');
  touch(room);
  return { ok: true };
}

/** Конец серии. Недоигранная партия снимается и не считается. */
export function endGame(room, userId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { ok: true, noop: true };
  if (live(room)) abortDeal(room, 'игру завершил хост');
  room.status = 'finished';
  room.finishedAt = Date.now();
  room.turn = null;
  touch(room);
  return { ok: true };
}

/** Счёт серии: кто сколько раз остался последним, лучшие сверху. */
export function score(room) {
  return room.players
    .filter((p) => p.stats.games > 0 || isSeated(p))
    .map((p) => ({
      id: p.id,
      name: p.name,
      last: p.stats.last,
      wins: p.stats.wins,
      games: p.stats.games,
      isHost: isHost(room, p.id),
      kicked: !!p.kicked,
      left: !!p.left,
    }))
    .sort((a, b) => b.wins - a.wins || a.last - b.last || b.games - a.games);
}

/**
 * Одна живая строка на человека для экрана итогов — «заставил взять 14 карт»,
 * «ни разу не брал из колоды», «четыре раза менял цвет».
 *
 * Люди обсуждают именно это, а не таблицу мест, поэтому строка выбирается по
 * тому, что у человека вышло ярче всего, а не по порядку полей.
 */
export function highlights(room) {
  const out = {};
  for (const p of room.players) {
    if (!p.stats.games) continue;
    const { forced, drew, wilds, wins, games } = p.stats;
    out[p.id] =
      forced >= 6 ? `заставил взять ${forced} ${cards(forced)}` :
      drew === 0 ? 'ни разу не брал из колоды' :
      wilds >= 3 ? `${times(wilds)} менял цвет` :
      wins === games && games > 1 ? `выиграл все ${games} ${parties(games)}` :
      forced > 0 ? `заставил взять ${forced} ${cards(forced)}` :
      `взял из колоды ${drew} ${cards(drew)}`;
  }
  return out;
}

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const cards = (n) => plural(n, 'карту', 'карты', 'карт');
const parties = (n) => plural(n, 'партию', 'партии', 'партий');
const times = (n) => (n === 2 ? 'дважды' : n === 3 ? 'трижды' : `${n} раз`);

/* ------------------------------------------------------------ persistence */

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

/** Таймер хода пишется остатком: бот лежал — это не чьё-то время. */
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
  room.game = 'colors';
  room.ui = room.ui || {};
  room.ui.lastText = null; // карточку перерисовать
  room.ui.lastKb = null;
  room.ui.lastMsgId = room.ui.lastMsgId || 0;
  room.ui.pings = room.ui.pings || {};
  room.code = room.code || newRoomCode();
  // Окно «Радуга!» живёт пять секунд: пережить перезапуск оно не может и не
  // должно — ловить человека за молчание, которого никто не видел, нечестно.
  if (room.deal) room.deal.call = null;
  return room;
}

export { label, COLORS };
