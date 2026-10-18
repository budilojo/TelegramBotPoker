/**
 * Шашки настоящими браузерами: точки ходов, тап-тап, перетаскивание мышью,
 * пометка «бить обязательно», серия взятий по шагам с побитыми на доске,
 * выбор пути из двух серий на одно поле, скольжение шашки у соперника.
 *
 *   node tools/e2e-checkers.mjs
 *
 * Тот же сервер, сокет и страница, что в бою; Telegram — заглушка, токен
 * одноразовый. Нужен Playwright с Chromium (как в tools/e2e.mjs).
 */
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { startServer } from '../bot/server.js';
import { TelegramStub, cmdUpdate, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';
import { fromFen, key } from '../bot/games/checkers/board.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8096);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const CHAT = -100992;
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

const ivan = user(101, 'Иван');
const max = user(202, 'Макс');
const api = new TelegramStub();
const app = new App({ api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${PORT}`, miniAppName: 'table' });
app.checkersRand = () => 0.1; // хост — белыми
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));

const step = (s) => console.log(`· ${s}`);
const problems = [];
async function until(cond, what, ms = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const sdkStub = (initData) => `
  window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: new URLSearchParams(${JSON.stringify(initData)}).get('start_param') },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(url){ window.__opened = url; },
    BackButton: { show(){}, hide(){}, onClick(){} },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  } };
  window.__slides = [];
  window.__moves = [];
  const socketSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    const msg = JSON.parse(data);
    if (msg.t === 'move') window.__moves.push(msg);
    return socketSend.call(this, data);
  };
  const orig = Element.prototype.animate;
  Element.prototype.animate = function (frames, opts) {
    if (this.classList?.contains('ch-pc')) window.__slides.push({ sq: this.parentElement?.dataset.sq, frames: frames.length });
    return orig.call(this, frames, opts);
  };`;

const browser = await chromium.launch();
async function openPage(u, code, { width = 360, height = 740 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${u.first_name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${u.first_name}: ${m.text()}`));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: code }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  return page;
}

const room = app.createGame('checkers', { chatId: String(CHAT), title: 'Клуб', host: { id: 101, tgId: 101, name: 'Иван' }, settings: { base: 0 } });
const pi = await openPage(ivan, room.code);
const pm = await openPage(max, room.code);
await pm.waitForSelector('h1:has-text("Шашки")');
await pm.getByRole('button', { name: 'Сесть за доску' }).click();
await until(() => room.players.length === 2, 'Макс сел');
await pi.getByRole('button', { name: '▶ Начать' }).click();
await until(() => !!room.match, 'партия началась');
await pi.waitForSelector('.ch-board');
await pm.waitForSelector('.ch-board');
step('двое сели и начали: у обоих доска, у каждого по 12 шашек');
assert.equal(await pi.locator('.ch-sq .ck-pc').count(), 24);

const sq = (page, name) => page.locator(`.ch-sq[data-sq="${name}"]`);
const center = async (page, name) => {
  const b = await sq(page, name).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const moves = (page) => page.evaluate(() => window.__moves.length);
/** Поставить позицию посреди партии и разослать её страницам. */
async function setPosition(fen) {
  room.match.pos = fromFen(fen);
  room.match.seen = { [key(room.match.pos)]: 1 };
  room.seq += 1;
  app.hub.broadcast(room);
  await new Promise((r) => setTimeout(r, 150));
}

/* --------------------------------------------- тап-тап: точки и ход */

await pi.waitForSelector('.ch-status.mine');
await sq(pi, 'c3').click();
assert.equal(await pi.locator('.ch-sq.dot').count(), 2, 'у c3 две точки: b4 и d4');
assert.ok(await sq(pi, 'b4').evaluate((c) => c.classList.contains('dot')));
assert.ok(await sq(pi, 'd4').evaluate((c) => c.classList.contains('dot')));
await sq(pi, 'd4').click();
await until(() => room.match.moves.length === 1, 'ход c3-d4 принят');
assert.equal(room.match.moves[0].n, 'c3-d4');
await pm.waitForFunction(() => window.__slides.some((s) => s.sq === 'd4'));
await pm.waitForSelector('.ch-sq[data-sq="d4"] .ck-pc');
step('тап по шашке — две точки; тап по точке — ход; у соперника шашка скользит на d4');

/* --------------------------------------------- перетаскивание мышью */

await pm.waitForSelector('.ch-status.mine');
const f6 = await center(pm, 'f6');
const e5 = await center(pm, 'e5');
await pm.mouse.move(f6.x, f6.y);
await pm.mouse.down();
await pm.mouse.move(f6.x + 10, f6.y + 10, { steps: 3 });
await pm.mouse.move(e5.x, e5.y, { steps: 8 });
await pm.mouse.up();
await until(() => room.match.moves.length === 2, 'Макс перетащил f6-e5');
assert.equal(room.match.moves[1].n, 'f6-e5');
assert.equal(await moves(pm), 1, 'перетаскивание отправило ровно один ход');
step('перетаскивание мышью: f6 → e5, один запрос');

/* --------------------------------- бить обязательно: кольцо и подсказка */

await pi.waitForSelector('.ch-status.mine:has-text("бить обязательно")');
assert.ok(await sq(pi, 'd4').evaluate((c) => c.classList.contains('ck-must')), 'на d4 кольцо «надо бить»');
assert.equal(await pi.locator('.ch-sq.ck-must').count(), 1);
const before = await moves(pi);
await sq(pi, 'a3').click();
await pi.waitForSelector('#toast.show:has-text("Бить обязательно")');
assert.equal(await moves(pi), before, 'шашкой, которой нельзя, ход не отправлен');
await sq(pi, 'd4').click();
await sq(pi, 'f6').click();
await until(() => room.match.moves.length === 3, 'взятие d4:f6');
await pm.waitForFunction(() => !document.querySelector('.ch-sq[data-sq="e5"] .ck-pc'));
step('бить обязательно: кольцо на шашке, тап по другой — подсказка и ни одного запроса, взятие прошло');

/* --------------------------------------------- серия по шагам */

// Ход Макса: ставим позицию, где белые (Иван) бьют серию c3:a5:c7 — или одну e5 из c3.
room.match.moves.push({ n: 'g7-h6', from: 'g7', to: 'h6', path: ['g7', 'h6'], caps: [], promo: false });
await setPosition('W:Wc1,e1,g1,b2,d2,f2,h2,c3,e3:Bb4,d4,b6,f6,h6,a7,g7,b8,d8,f8,h8');
await pi.waitForSelector('.ch-status.mine');
await sq(pi, 'c3').click();
const dots = await pi.locator('.ch-sq.dot').evaluateAll((els) => els.map((e) => e.dataset.sq).sort());
assert.deepEqual(dots, ['a5', 'e5'], 'из c3 два первых шага: a5 и e5');
await sq(pi, 'a5').click();
await pi.waitForSelector('.ch-sq.ck-taken[data-sq="b4"]');
assert.ok(await sq(pi, 'a5').locator('.ck-pc').count(), 'шашка стоит на пройденном поле');
assert.equal(await sq(pi, 'c3').locator('.ck-pc').count(), 0, 'а с c3 ушла');
assert.equal(await pi.locator('.ch-status:has-text("Бейте дальше")').count(), 1);
assert.equal(await moves(pi), before + 1, 'посреди серии ход не отправлен');
await sq(pi, 'h2').click(); // мимо — серия не прерывается
await pi.waitForSelector('#toast.show:has-text("Доведите серию")');
await sq(pi, 'c7').click();
await until(() => room.match.moves.at(-1).n === 'c3:a5:c7', 'серия c3:a5:c7');
assert.deepEqual(room.match.moves.at(-1).caps.sort(), ['b4', 'b6']);
await pm.waitForFunction(() => window.__slides.some((s) => s.sq === 'c7' && s.frames === 3));
step('серия по шагам: побитая b4 помечена, пока ход не кончен; у соперника шашка скользит c3 → a5 → c7');

/* ------------------------------ две серии на одно поле: выбор пути */

room.match.moves.push({ n: 'h8-g7', from: 'h8', to: 'g7', path: ['h8', 'g7'], caps: [], promo: false });
await setPosition('W:WKh4,Kd8:Bg1,e3,a5,e5,c7,e7');
await pi.waitForSelector('.ch-status.mine');
await sq(pi, 'd8').click();
const first = await pi.locator('.ch-sq.dot').evaluateAll((els) => els.map((e) => e.dataset.sq).sort());
assert.deepEqual(first, ['b6', 'f6', 'g5'], 'первые шаги дамки: b6, f6, g5');
assert.equal(await sq(pi, 'f2').evaluate((c) => c.classList.contains('ck-end')), false, 'на f2 две дороги — сразу нельзя');
assert.ok(await sq(pi, 'd2').evaluate((c) => c.classList.contains('ck-end')), 'на d2 одна — можно сразу');
await sq(pi, 'b6').click();
await sq(pi, 'f2').click();
await until(() => room.match.moves.at(-1).n === 'd8:b6:f2', 'выбран путь через b6');
assert.deepEqual(room.match.moves.at(-1).caps.sort(), ['c7', 'e3']);
step('две серии на f2: путь выбирается шагом (через b6), сервер побил именно c7 и e3');

/* ----------------------------------- /checkers в группе и вёрстка */

await app.handleUpdate(cmdUpdate(CHAT, ivan, '/checkers', { message_id: 900 }));
await app.settle();
const lobby = app.liveRooms(String(CHAT)).find((r) => r.game === 'checkers' && r.status === 'lobby');
assert.ok(lobby, '/checkers в группе — лобби одной командой');
assert.equal(api.message(lobby.ui.tableMessageId).markup.inline_keyboard[0][0].text, '🔘 Присоединиться');
step('/checkers в группе: лобби одной командой, карточка «Присоединиться»');

const small = await openPage(ivan, room.code, { width: 320, height: 568 });
await small.waitForSelector('.ch-board');
for (const page of [pi, pm, small]) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= iw, `страница шире экрана (${sw} > ${iw})`);
}
// Доска целиком на экране. Клетка на 320×568 выходит ~28 px — как у шахмат (общая
// вёрстка chess.css: доска ужимается по высоте); это отмечено в отчёте.
const board = await small.locator('.ch-board').boundingBox();
assert.ok(board.x >= 0 && board.x + board.width <= 320 && board.y + board.height <= 568, 'доска целиком на экране 320×568');
const cell = await small.locator('.ch-sq').first().boundingBox();
step(`на 320×568 доска целиком на экране, горизонтального скролла нет (клетка ${Math.round(cell.width)} px)`);

assert.deepEqual(problems, [], 'ошибок в консоли страниц нет');
await browser.close();
await web.close?.();
app.stop?.();
console.log('e2e шашек: всё сошлось');
process.exit(0);
