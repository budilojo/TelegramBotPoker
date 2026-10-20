/**
 * See the Mini App without Telegram: builds typical table situations on a
 * real server (the same hub, view and static files the bot uses), signs an
 * initData for a chosen viewer with a THROWAWAY token, and screenshots each
 * one at phone size with Playwright.
 *
 *   node tools/preview.mjs            → preview/*.png
 *   node tools/preview.mjs --serve    → keeps the server up and prints URLs
 *
 * Nothing here touches the real bot: the token is random and dies with the
 * process, and Telegram is replaced by the test stub.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { Broadcaster } from '../bot/broadcast.js';
import { startServer } from '../bot/server.js';
import { TelegramStub } from '../bot/tg-stub.js';
import { Store } from '../bot/store.js';
import { signInitData } from '../bot/webapp-auth.js';
import { stack } from '../bot/harness.js';
import * as R from '../bot/room.js';
import * as D from '../bot/games/durak/rules.js';
import * as C from '../bot/games/chess/rules.js';
import { fromFen } from '../bot/games/chess/board.js';
import * as K from '../bot/games/checkers/rules.js';
import { fromFen as kFen, key as kKey } from '../bot/games/checkers/board.js';
import * as ND from '../bot/games/nardy/rules.js';
import * as BS from '../bot/games/battleship/rules.js';
import { shipCells as bsCells, randomFleet as bsFleet } from '../bot/games/battleship/board.js';
import { abs as ndAbs } from '../bot/games/nardy/board.js';
import { durakStack } from '../bot/harness.js';
import { legalActions } from '../server/game.js';
import { GAMES } from '../bot/games/index.js';
import * as SCHOOL from '../bot/games/poker/school.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZE_TAG = process.env.PREVIEW_W || process.env.PREVIEW_H
  ? `preview-${process.env.PREVIEW_W || 'auto'}x${process.env.PREVIEW_H || 'auto'}`
  : 'preview';
const OUT = path.join(ROOT, SIZE_TAG);
const PORT = Number(process.env.PREVIEW_PORT || 8090);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const serve = process.argv.includes('--serve');

const api = new TelegramStub();
// Как в проде: рейтинг людям пока закрыт кнопкой «скоро». Экран живой, и его
// снимки нужны — две его сцены открывают его сами и закрывают за собой.
const app = new App({ api, store: new Store(':memory:'), botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${PORT}`, admins: ['101'] });
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);
app.casts = new Broadcaster({ app });

const PEOPLE = [
  [101, 'Иван'], [102, 'Артём'], [103, 'Макс'], [104, 'Дима'], [105, 'Саша'], [106, 'Лена'],
];
let chat = -100500;

function table(n, { host = 101, ...opts } = {}) {
  const chatId = String(chat--);
  const [hid, hname] = PEOPLE.find(([id]) => id === host);
  const room = R.createRoom({ chatId, title: 'Покер по пятницам', host: { id: hid, name: hname, dm: 'ok' }, smallBlind: 25, bigBlind: 50, ...opts });
  for (const [id, name] of PEOPLE.filter(([id]) => id !== host).slice(0, n - 1)) R.addPlayer(room, { id, name, dm: 'ok' });
  app.addRoom(room);
  return room;
}

/** Move the hand along until `until(room)` says stop. */
function play(room, until, pick) {
  let guard = 0;
  while (room.hand.phase === 'betting' && !until(room) && guard++ < 80) {
    const id = room.hand.actorId;
    const l = legalActions(room, id);
    const [action, amount] = pick?.(room, id, l) ?? [l.canCheck ? 'check' : 'call'];
    const r = R.act(room, id, action, amount);
    if (r.error) throw new Error(`${id} ${action}: ${r.error}`);
  }
}

/*
 * ПЕРЕСНЯТЬ ВСЁ ОДНИМ РАЗМЕРОМ:
 *
 *   PREVIEW_W=320 PREVIEW_H=568 npm run preview
 *
 * Снимки по умолчанию сняты под 390 — размер, под который нарисованы макеты.
 * Но проверять вёрстку надо и на 320: это самый узкий телефон, который
 * Telegram ещё показывает, и именно там сначала ломается всё. Без этого
 * переключателя узкий экран приходилось ловить сценами по одной, и его
 * ловили не всегда.
 *
 * Размер пишется в имя папки, чтобы прогоны не затирали друг друга.
 */
const FORCE_W = Number(process.env.PREVIEW_W) || 0;
const FORCE_H = Number(process.env.PREVIEW_H) || 0;

const scenes = [];
function scene(name, room, viewer, { width = 390, height = 780, click = null, press = null, start = room?.code, tap = [], sq = [], sel = [], scroll = 0, tab = null, before = null, after = null } = {}) {
  if (FORCE_W) width = FORCE_W;
  if (FORCE_H) height = FORCE_H;
  const user = { id: viewer, first_name: PEOPLE.find(([id]) => id === viewer)?.[1] ?? 'Гость' };
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user, ...(start ? { start_param: start } : {}) }, TOKEN);
  // `before` — то, что надо сделать с ботом ровно перед этой страницей
  // (включить обслуживание): иначе оно попало бы на все остальные снимки.
  scenes.push({ name, code: start, initData, width, height, click, press, tap, sq, sel, scroll, tab, before, after });
}

const deck6 = stack({ 101: 'As Kh', 102: 'Qs Qd', 103: '9c 9d', 104: '7h 2c', 105: 'Jd 10d', 106: '5s 4s' }, '10s Jh Qc 3d 8s');

// 1. Lobby — the host's view.
{
  const r = table(4);
  r.settings.turnSeconds = 60;
  scene('01-lobby-host', r, 101);
}
// 2. My turn on the flop, facing a bet, timer on.
{
  const r = table(6);
  r.settings.turnSeconds = 60;
  R.startGame(r, '101', { deck: () => deck6(r) });
  play(r, (x) => x.hand.street === 'flop', (x, id, l) => (id === '104' ? ['fold'] : [l.canCheck ? 'check' : 'call']));
  play(r, (x) => x.hand.actorId === '101', (x, id, l) => (l.currentBet === 0 && id === '103' ? ['bet', 100] : [l.canCheck ? 'check' : 'call']));
  scene('02-my-turn-flop', r, 101);
  scene('03-raise-sheet', r, 101, { click: 'Raise' });
  scene('04-small-phone', r, 101, { width: 360, height: 640 });
}
// 3. Somebody else's turn — I am waiting.
{
  const r = table(5);
  r.settings.turnSeconds = 60;
  R.startGame(r, '101', { deck: () => deck6(r) });
  play(r, (x) => x.hand.actorId === '103');
  scene('05-their-turn', r, 102);
}
// 4. Showdown on the river.
{
  const r = table(4);
  R.startGame(r, '101', { deck: () => deck6(r) });
  play(r, () => false);
  scene('06-showdown', r, 101);
}
// 5. A short stack shoves pre-flop and gets called: the board is being
//    turned over (flop frame). Deep stacks, so the game goes on after.
{
  const r = table(3);
  r.players[0].stack = 2000;
  r.players[0].stats.buyIn = 2000;
  R.startGame(r, '101', { deck: () => deck6(r) });
  play(r, () => false, (x, id, l) => (id === '101' ? ['allin'] : id === '102' ? ['call'] : ['fold']));
  r.ui.reveal = { handNo: r.hand.no, shown: 3 };
  scene('07-allin-reveal', r, 102);
}
// 6. Real cards: the dealer decides who won.
{
  const r = table(5);
  R.updateSettings(r, '101', { cards: 'live' });
  R.setRole(r, '101', '105', 'dealer');
  R.startGame(r, '101');
  play(r, () => false);
  scene('08-dealer-table', r, 101);
  scene('09-dealer-who-won', r, 105);
}
// 7. Results.
{
  const r = table(4);
  R.startGame(r, '101', { deck: () => deck6(r) });
  play(r, () => false, (x, id, l) => (l.canBet || l.canRaise ? ['allin'] : ['call']));
  R.endGame(r, '101');
  scene('10-results', r, 101);
}

/* ------------------------------------------------------ the hub and durak */

/** A durak game in a group, `n` players seated, the host first. */
function durak(n, { variant = 'podkidnoy', chatId = String(chat--), turnSeconds = 0 } = {}) {
  const [hid, hname] = PEOPLE[0];
  const room = app.createGame('durak', { chatId, title: 'Покер по пятницам', host: { id: hid, tgId: hid, name: hname }, settings: { variant, turnSeconds } });
  for (const [id, name] of PEOPLE.slice(1, n)) D.addPlayer(room, { id, name, dm: 'ok' });
  return room;
}
// Артём leads (6♦ is the lowest trump), Макс defends, Иван throws in.
const deal3 = { 102: '6D 7S 8C 10S KH JS', 103: '7H 9S 10C JH QH 8D', 101: '7C 9C 9D QS KD AS' };

// 11. The hub of a group: the games, and what is open.
{
  const chatId = String(chat--);
  const g = app.ensureGroup(chatId, 'Покер по пятницам');
  const open = durak(3, { chatId });
  open.players[1].name = 'Артём';
  const p = R.createRoom({ chatId, title: 'Покер по пятницам', host: { id: 104, name: 'Дима', dm: 'ok' } });
  p.createdAt = Date.now() - 1000;
  for (const [id, name] of PEOPLE.slice(4, 6)) R.addPlayer(p, { id, name, dm: 'ok' });
  R.startGame(p, '104', { deck: () => deck6(p) });
  app.addRoom(p);
  scene('11-hub', open, 101, { start: `g_${g.code}` });
  scene('12-hub-new-durak', open, 101, { start: `g_${g.code}`, click: 'Дурак' });
  // Шторка каждой игры — своя: однажды UNOQ спросил у людей «подкидной или
  // переводной», потому что форму рисовал хаб, а не игра.
  scene('12б-hub-new-colors', open, 101, { start: `g_${g.code}`, click: 'UNOQ' });
}
// 12. A durak lobby, the host's view.
{
  const r = durak(3, { variant: 'perevodnoy', turnSeconds: 60 });
  scene('13-durak-lobby', r, 101);
}
// 13. At the table: Артём led two sevens at Макс; Макс covered one.
{
  const r = durak(3);
  D.startGame(r, '101', { deck: () => durakStack(deal3, { trump: 'AD' })(r) });
  D.attack(r, '102', '7S');
  D.attack(r, '101', '7C');
  D.defend(r, '103', '9S', 0); // nines on the table now: Иван may throw his
  scene('14-durak-throw', r, 101, { tap: ['9C'] });
  scene('15-durak-defend', r, 103, { tap: ['10C'] });
}
// 14. Everything covered: the attacker's «Бито».
{
  const r = durak(3);
  D.startGame(r, '101', { deck: () => durakStack(deal3, { trump: 'AD' })(r) });
  D.attack(r, '102', '7S');
  D.defend(r, '103', '9S', 0);
  scene('16-durak-bito', r, 102);
}
// 15. Six at the table, the pack dealt out, a bout going on.
{
  const r = durak(6);
  D.startGame(r, '101', { deck: () => shuffledFor(r, 7) });
  const d = r.deal;
  const lead = d.hands[d.attacker][0];
  D.attack(r, d.attacker, lead);
  scene('17-durak-6p', r, 104, { width: 360, height: 640 });
}
// 16. The end of a game: the durak, and the score.
{
  const r = durak(3);
  D.startGame(r, '101', { deck: () => shuffledFor(r, 3) });
  playOut(r);
  if (r.deal.fool) {
    D.nextGame(r, '101', { deck: () => shuffledFor(r, 4) });
    playOut(r);
  }
  scene('18-durak-over', r, 101);
  const f = durak(3);
  D.startGame(f, '101', { deck: () => shuffledFor(f, 5) });
  playOut(f);
  D.nextGame(f, '101', { deck: () => shuffledFor(f, 6) });
  playOut(f);
  D.endGame(f, '101');
  scene('19-durak-results', f, 101);
}

// 17. Opened from the bot's profile: the groups Иван plays in.
{
  const a = app.ensureGroup(String(chat--), 'Покер по пятницам');
  const b = app.ensureGroup(String(chat--), 'Дача 🏕');
  a.members = ['101'];
  b.members = ['101'];
  const r = durak(2, { chatId: a.chatId });
  scene('20-my-groups', r, 101, { start: '' });
}

function shuffledFor(room, seed) {
  let a = seed >>> 0;
  const rnd = (n) => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a % n;
  };
  const d = ['S', 'H', 'D', 'C'].flatMap((s) => ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].map((r) => r + s));
  for (let i = d.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/** Plain bots play a durak game to the end: lowest card, beat if possible, else take. */
function playOut(room) {
  const rank = (c) => ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].indexOf(c.slice(0, -1));
  for (let i = 0; i < 3000 && room.deal.phase === 'play'; i++) {
    const d = room.deal;
    if (!d.table.length) D.attack(room, d.attacker, d.hands[d.attacker].reduce((x, y) => (rank(y) < rank(x) ? y : x)));
    else if (!D.allCovered(d) && !d.bout.taking) {
      const at = d.table.findIndex((x) => !x.d);
      const l = D.legalFor(room, d.defender);
      const c = Object.keys(l.defend).find((k) => l.defend[k].includes(at));
      if (c) D.defend(room, d.defender, c, at);
      else D.take(room, d.defender);
    } else for (const id of D.waitingThrowers(d)) D.pass(room, id);
  }
}

// 18. Админка: цифры за две недели, накрученные правдоподобно.
{
  const chatId = String(chat--);
  const r = durak(3, { chatId });
  const day = 86_400_000;
  const now = Date.now();
  const store = app.store;
  for (let back = 13; back >= 0; back--) {
    const at = now - back * day;
    // К концу двух недель людей и партий заметно больше, чем в начале.
    const people = Math.round(3 + (13 - back) * 1.6 + (back % 3 === 0 ? 2 : 0));
    for (let i = 0; i < people; i++) store.noteSeen(String(1000 + ((i * 7 + back) % 40)), at);
    const rounds = Math.round(2 + (13 - back) * 2.2 + (back % 4 === 0 ? 5 : 0));
    for (let i = 0; i < rounds; i++) {
      store.addEvent({ at, kind: 'round', game: i % 3 ? 'durak' : 'poker', chatId: `-100${i % 5}`, code: `r${back}-${i % 6}`, n: 3 });
    }
    if (back % 2 === 0) store.addEvent({ at, kind: 'created', game: 'durak', chatId: `-100${back % 5}`, code: `c${back}` });
    if (back % 3 === 0) store.addEvent({ at, kind: 'finished', game: 'poker', chatId: `-100${back % 5}`, code: `f${back}` });
  }
  scene('21-admin', r, 101, { start: 'admin', height: 900 });
  scene('22-admin-charts', r, 101, { start: 'admin', height: 900, scroll: 1200 });
  // Правдоподобная личка: кому бот может написать, и одна ушедшая рассылка.
  for (let i = 0; i < 128; i++) app.store.setDm(String(2000 + i), i % 11 ? 'ok' : 'fail');
  app.store.setAds('2005', 'off');
  const sent = app.store.addBroadcast({ at: now - 2 * day, text: 'Завели дурака — заходите играть! Подкидной и переводной, от 2 до 6 человек.', audience: 'all', total: 116, createdAt: now - 2 * day });
  app.store.patchBroadcast(sent.id, { status: 'done', sent: 113, failed: 3, done_at: now - 2 * day });
  scene('23-admin-now', r, 101, { start: 'admin', height: 900, tab: 'Сейчас' });
  scene('24-admin-cast', r, 101, { start: 'admin', height: 900, tab: 'Рассылка' });
  scene('25-admin-tools', r, 101, { start: 'admin', height: 900, tab: 'Пульт' });
  // Последним: обслуживание включается перед самим снимком и на другие не попадает.
  scene('26-maintenance', r, 102, { before: () => app.setMaintenance(true, 'Обновляемся. Вернёмся через пять минут.') });
}

// 25. Рейтинг: он постоянный, поэтому для снимка нужна история, а не текущий
// стол. Очки проставлены прямо в базу — как их проставили бы сыгранные вечера.
{
  const chatId = String(chat--);
  const g = app.ensureGroup(chatId, 'Свои');
  const open = durak(3, { chatId });
  const day = Date.now();
  const cast = [
    [102, 'Артём', 8], [103, 'Макс', 6], [104, 'Дима', 5], [105, 'Саша', 3], [106, 'Лена', 2], [101, 'Иван', 4],
  ];
  let n = 0;
  for (const [id, name, wins] of cast) {
    for (let i = 0; i < wins; i++) {
      app.store.rate({ userId: id, game: 'durak', round: `pre${n++}`, place: 1, of: 4, delta: 20, name, win: true, at: day - i * 3_600_000 });
    }
    app.store.rate({ userId: id, game: 'durak', round: `pre${n++}`, place: 4, of: 4, delta: -10, name, fool: true, at: day - 7_200_000 });
  }
  // Обслуживание включалось для снимка 26 — снять, иначе рейтинга не видно.
  const openRating = () => { app.setMaintenance(false); app.ratingSoon = false; };
  const closeRating = () => { app.ratingSoon = true; };
  scene('27-rating', open, 101, { start: `g_${g.code}`, press: 'Рейтинг', before: openRating, after: closeRating });
  // Как это выглядит у людей сейчас: кнопка на месте, экран ещё закрыт.
  scene('27б-rating-soon', open, 101, { start: `g_${g.code}`, press: 'Рейтинг', before: () => app.setMaintenance(false) });
  scene('28-rating-who', open, 101, { start: `g_${g.code}`, press: ['Рейтинг', 'Артём'], before: openRating, after: closeRating });
}

// 26. Шахматы — дуэль: лобби, партия за белых и за чёрных, превращение,
//     мат, предложение ничьей, зритель, маленький телефон.
{
  const chatId = String(chat--);
  const g = app.ensureGroup(chatId, 'Шахматный клуб');
  const host = { id: 101, tgId: 101, name: 'Иван' };
  const guest = { id: 102, tgId: 102, name: 'Артём', dm: 'ok' };
  const duel = (opts = {}) => {
    const r = app.createGame('chess', { chatId, title: 'Шахматный клуб', host, settings: { base: 300, inc: 2, side: 'white', ...opts } });
    C.addPlayer(r, guest);
    return r;
  };
  const go = (r, moves) => {
    for (const [from, to] of moves) {
      const m = r.match;
      const id = m.pos.t === 'w' ? m.white : m.black;
      const x = C.move(r, id, { from, to, promo: 'q' }, Date.now());
      if (x.error) throw new Error(`${from}${to}: ${x.error}`);
    }
  };
  const ITALIAN = [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'c4'], ['g8', 'f6'], ['d2', 'd3'], ['f8', 'c5'], ['c1', 'g5']];

  const lone = app.createGame('chess', { chatId, title: 'Шахматный клуб', host, settings: { base: 600, inc: 0, side: 'random' } });
  scene('29-chess-lobby', lone, 101);
  scene('29б-hub-new-chess', lone, 101, { start: `g_${g.code}`, click: 'Шахматы' });
  scene('29в-hub-chess-list', lone, 101, { start: `g_${g.code}`, height: 1100 });

  const mid = duel();
  C.startGame(mid, '101', { rand: () => 0.1 });
  go(mid, ITALIAN);
  scene('30-chess-black-to-move', mid, 102);
  go(mid, [['d7', 'd6']]);
  scene('30б-chess-my-turn', mid, 101);
  scene('30в-chess-selected', mid, 101, { sq: ['b1'] });
  scene('30г-chess-spectator', mid, 103);
  scene('30д-chess-small-phone', mid, 101, { width: 360, height: 640, sq: ['g5'] });

  const promo = duel({ base: 0, inc: 0 });
  C.startGame(promo, '101', { rand: () => 0.1 });
  promo.match.moves.push({ uci: 'a1a2', san: 'a3', from: 'a1', to: 'a2', cap: '' }, { uci: 'a8a7', san: 'a6', from: 'a8', to: 'a7', cap: '' });
  promo.match.pos = fromFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 40');
  scene('31-chess-promotion', promo, 101, { sq: ['a7', 'a8'] });

  const mate = duel();
  C.startGame(mate, '101', { rand: () => 0.1 });
  go(mate, [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]);
  scene('32-chess-mate', mate, 101);

  const offer = duel();
  C.startGame(offer, '101', { rand: () => 0.1 });
  go(offer, ITALIAN);
  C.offerDraw(offer, '101');
  scene('33-chess-draw-offer', offer, 102);

  // Откат: соперник просит вернуть ход — у второго игрока всплывает окно.
  const take = duel();
  C.startGame(take, '101', { rand: () => 0.1 });
  go(take, ITALIAN);
  C.requestTakeback(take, '101');
  scene('33б-chess-takeback-popup', take, 102);
}

// 26б. Шашки — дуэль: лобби, обязательное взятие, серия по шагам, дамки, конец.
{
  const chatId = String(chat--);
  const g = app.ensureGroup(chatId, 'Шашечный клуб');
  const host = { id: 101, tgId: 101, name: 'Иван' };
  const guest = { id: 102, tgId: 102, name: 'Артём', dm: 'ok' };
  const duel = (opts = {}) => {
    const r = app.createGame('checkers', { chatId, title: 'Шашечный клуб', host, settings: { base: 300, inc: 2, side: 'white', ...opts } });
    K.addPlayer(r, guest);
    K.startGame(r, '101', { rand: () => 0.1 });
    return r;
  };
  const go = (r, moves) => {
    for (const mv of moves) {
      const sq = mv.split(/[-:]/);
      const m = r.match;
      const id = m.pos.t === 'w' ? m.white : m.black;
      const x = K.move(r, id, { from: sq[0], to: sq.at(-1), path: mv.includes(':') ? sq : null }, Date.now());
      if (x.error) throw new Error(`${mv}: ${x.error}`);
    }
  };
  /** Позиция посреди партии: как будто до неё доиграли. */
  const at = (r, fen) => {
    r.match.pos = kFen(fen);
    r.match.seen = { [kKey(r.match.pos)]: 1 };
  };

  const lone = app.createGame('checkers', { chatId, title: 'Шашечный клуб', host, settings: { base: 600, inc: 0, side: 'random' } });
  scene('35-checkers-lobby', lone, 101);
  scene('35б-hub-new-checkers', lone, 101, { start: `g_${g.code}`, click: 'Шашки' });

  const opening = duel();
  go(opening, ['c3-d4', 'f6-e5']);
  scene('36-checkers-must-capture', opening, 101);
  scene('36б-checkers-black-waits', opening, 102);
  scene('36в-checkers-spectator', opening, 103);

  const series = duel();
  go(series, ['c3-d4', 'b6-a5', 'g3-h4']);
  at(series, 'W:Wa1,c1,e1,g1,b2,d2,f2,h2,a3,c3,e3,g3:Bb4,d6,f6,h6,a7,c7,e7,g7,b8,d8,f8,h8');
  scene('37-checkers-series-pick', series, 101, { sq: ['a3'] });
  at(series, 'W:Wc1,e1,g1,b2,d2,f2,h2,c3,e3:Bb4,d4,b6,f6,h6,a7,g7,b8,d8,f8,h8');
  scene('37б-checkers-series-step', series, 101, { sq: ['c3', 'a5'] });

  const kings = duel();
  go(kings, ['c3-d4', 'f6-e5']);
  at(kings, 'W:WKa1,Kh4,c3,e1:BKd8,c7,e7,a5,g5');
  scene('38-checkers-kings', kings, 101);
  scene('38б-checkers-small-phone', kings, 101, { width: 320, height: 568 });

  const won = duel();
  go(won, ['c3-d4', 'f6-e5']);
  at(won, 'W:Wc3,e1:Bd4');
  go(won, ['c3:e5']);
  scene('39-checkers-won', won, 101);
}

// 26в. Нарды — дуэль: лобби, бросок, выбор шашки, ход соперника, снятие, конец.
{
  const chatId = String(chat--);
  const g = app.ensureGroup(chatId, 'Нардный клуб');
  const host = { id: 101, tgId: 101, name: 'Иван' };
  const guest = { id: 102, tgId: 102, name: 'Артём', dm: 'ok' };
  const q = (pairs) => () => pairs.shift() || [2, 1];
  const duel = (start = [[5, 3]]) => {
    const r = app.createGame('nardy', { chatId, title: 'Нардный клуб', host, settings: { base: 300, inc: 5, side: 'white' } });
    ND.addPlayer(r, guest);
    ND.startGame(r, '101', { rand: () => 0.1, dice: q(start) });
    return r;
  };
  /** Ход целиком: [индекс пути, число]… — бросок из `dice`, если нужен. */
  const go = (r, steps, dice = null) => {
    const m = r.match;
    const id = m.turn.c === 'w' ? m.white : m.black;
    if (!m.turn.dice) ND.roll(r, id, Date.now(), { dice: () => dice });
    for (const [i, die] of steps) {
      const x = ND.move(r, id, { from: ndAbs(m.turn.c, i), die }, Date.now());
      if (x.error) throw new Error(`${i}+${die}: ${x.error}`);
    }
    ND.endTurn(r, id, Date.now());
  };

  const lone = app.createGame('nardy', { chatId, title: 'Нардный клуб', host, settings: { base: 600, inc: 0, side: 'random' } });
  scene('40-nardy-lobby', lone, 101);
  scene('40б-hub-new-nardy', lone, 101, { start: `g_${g.code}`, click: 'Нарды' });

  const first = duel();
  scene('41-nardy-first-move', first, 101);
  scene('41б-nardy-selected', first, 101, { sel: ['.nd-pt[data-p="0"]'] });
  scene('41в-nardy-opponent-waits', first, 102);

  const mid = duel();
  go(mid, [[0, 5], [5, 3]]);
  go(mid, [[0, 4], [4, 2]], [4, 2]);
  scene('42-nardy-roll', mid, 101);
  scene('42б-nardy-spectator', mid, 103);
  scene('42в-nardy-small-phone', mid, 101, { width: 320, height: 568 });

  const bear = duel();
  const b = Array(24).fill(0);
  for (const [i, n] of [[18, 3], [19, 3], [20, 3], [21, 2], [22, 2], [23, 1]]) b[ndAbs('w', i)] = n;
  for (const [i, n] of [[10, 5], [14, 4], [20, 6]]) b[ndAbs('b', i)] = -n;
  bear.match.pos = { b, off: { w: 1, b: 0 }, t: 'w' };
  bear.match.turn = { c: 'w', dice: [6, 4], played: [], start: { b: b.slice(), off: { w: 1, b: 0 }, t: 'w' }, headLimit: 1 };
  bear.match.log.push({ c: 'b', dice: [3, 1], steps: [], notation: [] }, { c: 'w', dice: [2, 2], steps: [], notation: [] });
  scene('43-nardy-bear-off', bear, 101, { sel: [`.nd-pt[data-p="${ndAbs('w', 18)}"]`] });
}

// 26г. Морской бой — дуэль: лобби, расстановка, бой (свой ход, чужой, зритель, 320 px), конец.
//      Игра пока черновик — снимки только с DRAFT_GAMES=1 (npm run preview так и запускает).
if (GAMES.battleship) {
  const chatId = String(chat--);
  const g = app.ensureGroup(chatId, 'Флотилия');
  const host = { id: 101, tgId: 101, name: 'Иван' };
  const guest = { id: 102, tgId: 102, name: 'Артём', dm: 'ok' };
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const duel = ({ base = 300, inc = 2 } = {}) => {
    const r = app.createGame('battleship', { chatId, title: 'Флотилия', host, settings: { base, inc } });
    BS.addPlayer(r, guest);
    BS.startGame(r, '101', { rand: () => 0.1 });
    return r;
  };
  const ready = (r) => {
    BS.placeRandom(r, '101', Date.now(), { fleetRand: rnd });
    BS.placeRandom(r, '102', Date.now(), { fleetRand: rnd });
    BS.ready(r, '101');
    BS.ready(r, '102');
  };
  const water = (r, side) => {
    const busy = new Set(r.match.fleets[side].flatMap(bsCells));
    return Array.from({ length: 100 }, (_, c) => c).filter((c) => !busy.has(c));
  };
  /** Партия посередине: Иван потопил корабль, ранил другой и промахнулся; Артём попал и промахнулся. */
  const mid = () => {
    const r = duel();
    ready(r);
    const foe = r.match.fleets[1];
    const sunk = foe.find((x) => x.len === 2);
    for (const c of bsCells(sunk)) BS.fire(r, '101', c);
    BS.fire(r, '101', bsCells(foe.find((x) => x.len === 3))[0]);
    const known = BS.knownEmpty(r.match, 0);
    BS.fire(r, '101', water(r, 1).find((c) => !known.has(c) && c > 50));
    BS.fire(r, '102', bsCells(r.match.fleets[0][0])[1]);
    BS.fire(r, '102', water(r, 0)[3]);
    return r;
  };

  const lone = app.createGame('battleship', { chatId, title: 'Флотилия', host, settings: { base: 600, inc: 0 } });
  scene('50-battleship-lobby', lone, 101);
  scene('50б-hub-new-battleship', lone, 101, { start: `g_${g.code}`, click: 'Морской бой' });

  const place = duel();
  scene('51-battleship-place-empty', place, 101);
  scene('51б-battleship-place-picked', place, 101, { sel: ['.bs-tray-ship[data-len="3"]'] });
  const placed = duel();
  BS.placeRandom(placed, '101', Date.now(), { fleetRand: rnd });
  scene('51в-battleship-place-random', placed, 101);
  BS.ready(placed, '101');
  scene('51г-battleship-locked', placed, 101);
  scene('51д-battleship-place-spectator', placed, 103);
  scene('51е-battleship-place-small', duel(), 101, { width: 320, height: 568 });

  const m = mid();
  const target = water(m, 1).find((c) => !BS.knownEmpty(m.match, 0).has(c) && !m.match.shots[0].some((x) => x.c === c) && c < 40);
  scene('52-battleship-my-turn', m, 101);
  scene('52б-battleship-aim', m, 101, { sel: [`.bs-grid:not(.mini) .bs-cell[data-c="${target}"]`] });
  scene('52в-battleship-opponent', m, 102);
  scene('52г-battleship-spectator', m, 103);
  scene('52д-battleship-small-aim', m, 101, { width: 320, height: 568, sel: [`.bs-grid:not(.mini) .bs-cell[data-c="${target}"]`] });

  const over = mid();
  BS.resign(over, '102');
  scene('53-battleship-over-win', over, 101);
  scene('53б-battleship-over-spectator', over, 103);
  void bsFleet;
}

// 27. Игры с ботами: экран из лички, форма шахмат, партия против бота.
{
  const someone = { id: 106, tgId: 106, name: 'Лена' };
  scene('34-solo', null, 105, { start: 'solo' });
  scene('34б-solo-chess-form', null, 105, { start: 'solo', click: 'Шахматы' });
  scene('34г-solo-resume', null, 106, { start: 'solo', before: () => {} });
  const vs = await app.createSolo('chess', someone, { level: 1, side: 'white' });
  C.move(vs, '106', { from: 'e2', to: 'e4' }, Date.now());
  C.move(vs, 'bot1', { from: 'e7', to: 'e5' }, Date.now());
  scene('34в-solo-chess-game', vs, 106);
  // Покер с ботами: форма (уровень, число соперников, характеры) и стол.
  scene('34д-solo-poker-form', null, 105, { start: 'solo', click: 'Покер' });
  scene('34е-solo-poker-types', null, 105, { start: 'solo', click: 'Покер', press: ['Выбрать самому'] });
  scene('34ж-solo-poker-type-pick', null, 105, { start: 'solo', click: 'Покер', press: ['Выбрать самому', 'Соперник 1'] });
  const pk = await app.createSolo('poker', { id: 104, tgId: 104, name: 'Дима' }, { opponents: 5, level: 2 });
  scene('34з-solo-poker-table', pk, 104);
  scene('34и-solo-poker-menu', pk, 104, { click: 'Меню' });
  // Дурак с ботами: форма и стол.
  scene('35-solo-durak-form', null, 105, { start: 'solo', click: 'Дурак' });
  const dk = await app.createSolo('durak', { id: 103, tgId: 103, name: 'Макс' }, { opponents: 3, level: 2, variant: 'perevodnoy' });
  scene('35б-solo-durak-table', dk, 103);
  scene('35в-solo-durak-menu', dk, 103, { click: 'Меню' });
  // UNOQ с ботами: форма и стол.
  scene('36-solo-unoq-form', null, 105, { start: 'solo', click: 'UNOQ' });
  const uq = await app.createSolo('colors', { id: 102, tgId: 102, name: 'Артём' }, { opponents: 4, level: 1 });
  scene('36б-solo-unoq-table', uq, 102);
  scene('36в-solo-unoq-menu', uq, 102, { click: 'Меню' });
}

// 28. Школа покера: список уроков, азбука, тест, урок с подсказкой и итог урока.
{
  scene('37-school-list', null, 105, { start: 'solo', click: 'Школа покера' });
  scene('37б-school-abc-flow', null, 105, { start: 'solo', click: 'Школа покера', press: ['Азбука покера', 'Дальше →'] });
  scene('37в-school-abc-combos', null, 105, { start: 'solo', click: 'Школа покера', press: ['Азбука покера', 'Дальше →', 'Дальше →', 'Дальше →'] });
  scene('37г-school-quiz', null, 105, { start: 'solo', click: 'Школа покера', press: ['Азбука покера', 'Дальше →', 'Дальше →', 'Дальше →', 'Проверить себя →', 'Флеш'] });

  /** Довести раздачу урока: человек — по `human`, наставник — по сценарию. */
  const drive = async (room, human, until) => {
    const g = GAMES.poker;
    for (let i = 0; i < 30 && !until(room); i++) {
      const uid = room.hand.actorId;
      if (!uid) break;
      const view = g.view(room, uid, { now: Date.now() });
      const msg = uid === room.solo.owner ? { t: 'act', ...human(view), seq: view.seq } : SCHOOL.coachMove(room, view);
      await g.handle({ app, hub, session: { user: { id: uid, name: '' }, send() {}, visible: true }, room, uid, msg, refuse: (c) => console.log('[школа]', c), push() {} });
    }
  };
  const pupil = { id: 107, tgId: 107, name: 'Ученик' };
  const draw = await app.createSolo('poker', pupil, { learn: true, lesson: 3 });
  // До флопа: человек уравнивает — на флопе наставник ставит, и подсказка про ауты.
  await drive(draw, (v) => ({ action: v.legal.canCheck ? 'check' : 'call' }), (r) => r.hand.street === 'flop' && r.hand.actorId === '107');
  scene('37д-school-lesson-draw', draw, 107);
  scene('37е-school-lesson-more', draw, 107, { press: ['Подробнее'] });
  const done = await app.createSolo('poker', { id: 108, tgId: 108, name: 'Ученица' }, { learn: true, lesson: 1 });
  await drive(done, (v) => ({ action: v.legal.canCheck ? 'check' : 'fold' }), (r) => r.hand.phase === 'complete');
  scene('37ж-school-lesson-passed', done, 108);
}

app.syncClocks(); // turn deadlines, as the running bot would have them
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));

/** What Telegram's SDK would give the page: a signed identity and the room. */
const sdkStub = (initData) => `
  window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: new URLSearchParams(${JSON.stringify(initData)}).get('start_param') },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(){},
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  } };`;

if (serve) {
  console.log(`preview on http://localhost:${PORT} — scenes:`);
  for (const s of scenes) console.log(`  ${s.name}: room ${s.code}`);
  console.log('(open them with tools/preview.mjs without --serve to get screenshots)');
} else {
  const require = createRequire(import.meta.url);
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
  }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  // Аудит F-3: служебные слова на экране и ошибки JS — в каждом кадре.
  const JUNK_WORDS = /(^|[^\p{L}\p{N}_])(null|undefined|NaN)(?![\p{L}\p{N}_])|\[object Object\]/u;
  const junk = [];
  for (const s of scenes) {
    s.before?.();
    const page = await browser.newPage({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: 2 });
    page.on('pageerror', (err) => junk.push(`[${s.name}] ошибка JS: ${err.message}`));
    await page.route('https://telegram.org/**', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: sdkStub(s.initData) }));
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector('.top, .lobby, .fatal, .ch', { timeout: 5000 });
    if (s.tab) {
      await page.locator('.tab', { hasText: s.tab }).click();
      await page.waitForTimeout(80);
    }
    if (s.click) {
      await page.getByRole('button', { name: s.click, exact: false }).first().click();
      await page.waitForSelector('.sheet');
    }
    // `press` — нажать и остаться: экран сменится, шторки не будет.
    for (const label of [].concat(s.press || [])) {
      try {
        await page.getByRole('button', { name: label, exact: false }).first().click({ timeout: 4000 });
      } catch (err) {
        console.log(`[${s.name}] «${label}» не нашлось. На экране:\n${(await page.evaluate(() => document.body.innerText)).slice(0, 400)}`);
        throw err;
      }
      await page.waitForTimeout(220);
    }
    for (const card of s.tap) await page.locator(`.dk-card[data-card="${card}"]`).click();
    for (const css of s.sel) await page.locator(css).first().click();
    for (const name of s.sq) {
      await page.locator(`.ch-sq[data-sq="${name}"]`).click();
      await page.waitForTimeout(120);
    }
    if (s.scroll) await page.evaluate((y) => document.querySelector('.lobby')?.scrollTo(0, y), s.scroll);
    await page.waitForTimeout(700); // let the deal animations settle
    await page.screenshot({ path: path.join(OUT, `${s.name}.png`) });
    const words = await page.evaluate(() => [
      document.body.innerText,
      ...[...document.querySelectorAll('[alt],[title],[aria-label],[placeholder]')].map((e) => [e.alt, e.title, e.getAttribute('aria-label'), e.placeholder].filter(Boolean).join(' ')),
    ].join('\n'));
    const hit = JUNK_WORDS.exec(words);
    if (hit) junk.push(`[${s.name}] на экране «${hit[0].trim()}»: …${words.slice(Math.max(0, hit.index - 60), hit.index + 60).replace(/\n/g, ' ')}…`);
    await page.close();
    s.after?.(); // снять то, что сцена включила для себя одной
  }
  await browser.close();
  await web.close();
  console.log(`preview: ${scenes.length} screenshots → ${path.relative(process.cwd(), OUT)}/`);
  if (junk.length) {
    console.log(`служебные слова и ошибки на экранах (${junk.length}):\n${junk.join('\n')}`);
    process.exit(1);
  }
  console.log('служебных слов (null, undefined, NaN, [object Object]) и ошибок JS на экранах нет');
  process.exit(0);
}
