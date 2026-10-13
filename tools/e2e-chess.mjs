/**
 * Шахматы настоящими браузерами: точки ходов, тап-тап, перетаскивание мышью и
 * пальцем, анимация хода у соперника.
 *
 *   node tools/e2e-chess.mjs
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
import { TelegramStub, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';
import * as C from '../bot/games/chess/rules.js';
import { fromFen } from '../bot/games/chess/board.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8094);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const CHAT = -100991;
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
app.chessRand = () => 0.1; // хост — белыми
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
    onEvent(){}, openTelegramLink(){},
    BackButton: { show(){}, hide(){}, onClick(){} },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  } };
  // Сколько раз страница двигала элемент анимацией (скольжение фигуры) — для проверок.
  window.__slides = [];
  const orig = Element.prototype.animate;
  Element.prototype.animate = function (frames, opts) {
    if (this.classList?.contains('ch-pc')) window.__slides.push(this.parentElement?.dataset.sq);
    return orig.call(this, frames, opts);
  };`;

const browser = await chromium.launch();
async function openPage(u, code, { touch = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, hasTouch: touch, isMobile: touch });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${u.first_name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${u.first_name}: ${m.text()}`));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: code }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  return page;
}

const room = app.createGame('chess', { chatId: String(CHAT), title: 'Клуб', host: { id: 101, tgId: 101, name: 'Иван' }, settings: { base: 0 } });
const pi = await openPage(ivan, room.code);
const pm = await openPage(max, room.code);
await pm.waitForSelector('h1:has-text("Шахматы")');
await pm.getByRole('button', { name: 'Сесть за доску' }).click();
await until(() => room.players.length === 2, 'Макс сел');
await pi.getByRole('button', { name: '▶ Начать' }).click();
await until(() => !!room.match, 'партия началась');
await pi.waitForSelector('.ch-board');
await pm.waitForSelector('.ch-board');
step('двое сели и начали: у обоих доска');

const sq = (page, name) => page.locator(`.ch-sq[data-sq="${name}"]`);
const center = async (page, name) => {
  const b = await sq(page, name).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
};
const slides = (page) => page.evaluate(() => window.__slides.length);
const settle = () => new Promise((r) => setTimeout(r, 120));

/* ------------------------------------------------ точки ходов при нажатии */

await sq(pi, 'e2').click();
assert.equal(await pi.locator('.ch-sq.dot').count(), 2, 'у пешки e2 две точки: e3 и e4');
for (const name of ['e3', 'e4']) {
  const info = await sq(pi, name).evaluate((cell) => {
    const cs = getComputedStyle(cell);
    const dot = getComputedStyle(cell, '::after');
    const w = parseFloat(dot.width);
    return {
      isDot: cell.classList.contains('dot'),
      centered: cs.display === 'flex' && cs.justifyContent === 'center' && cs.alignItems === 'center',
      absolute: dot.position === 'absolute',
      share: w / cell.getBoundingClientRect().width,
      visible: dot.content !== 'none' && dot.visibility !== 'hidden',
    };
  });
  assert.ok(info.isDot && info.centered && info.absolute && info.visible, `${name}: точка в центре клетки`);
  assert.ok(info.share > 0.2 && info.share < 0.4, `${name}: точка заметная, но не закрывает клетку (${info.share.toFixed(2)})`);
}
assert.equal(await pi.locator('.ch-sq.sel').count(), 1, 'выбранная фигура обведена');
await pi.screenshot({ path: path.join(ROOT, 'preview', 'e2e-chess-dots.png') });
step('нажали на пешку e2: точки в центре e3 и e4, фигура обведена');

await sq(pi, 'e3').click(); // повторный тап по выбранной снимает, а по другой своей — переносит выбор
await until(() => room.match.moves.length === 1, 'тап-тап: e2-e3');
assert.equal(room.match.moves[0].san, 'e3');
await pm.waitForFunction(() => window.__slides.length >= 1);
step('тап по точке — ход сделан; у Макса фигура проскользила на e3');

/* --------------------------- перетаскивание мышью: ход, возврат, взятие */

const before = await slides(pm);
const a = await center(pm, 'e7');
const b = await center(pm, 'e5');
await pm.mouse.move(a.x, a.y);
await pm.mouse.down();
await pm.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
assert.equal(await pm.locator('.ch-pc.drag').count(), 1, 'фигура в руке');
assert.ok(await pm.locator('.ch-sq.dot').count() >= 2, 'пока тащим, точки на месте');
assert.equal(await pm.locator('.ch-sq.hover').count(), 1, 'над e6 (это тоже ход пешки) клетка-цель подсвечена');
await pm.mouse.move(b.x, b.y, { steps: 4 });
assert.equal(await pm.locator('.ch-sq.hover').count(), 1, 'над e5 клетка-цель подсвечена');
await pm.mouse.up();
await until(() => room.match.moves.length === 2, 'перетащили e7-e5');
assert.equal(room.match.moves[1].san, 'e5');
await settle();
assert.equal(await slides(pm), before, 'свой ход, положенный рукой, второй раз анимацией не едет');
await pi.waitForFunction(() => window.__slides.length >= 1);
assert.ok(await slides(pi) >= 1, 'у Ивана ход Макса проскользил');
step('Макс перетащил e7→e5: ход принят, у Ивана фигура проскользила, у Макса — без повторной анимации');

// Неверная клетка: фигура возвращается, выбор остаётся.
const c1 = await center(pi, 'd2');
const far = await center(pi, 'd6');
await pi.mouse.move(c1.x, c1.y);
await pi.mouse.down();
await pi.mouse.move(far.x, far.y, { steps: 5 });
await pi.mouse.up();
await new Promise((r) => setTimeout(r, 300)); // возврат фигуры идёт 150 мс
assert.equal(room.match.moves.length, 2, 'd2→d6 — не ход: позиция не изменилась');
assert.equal(await pi.locator('.ch-sq.sel').count(), 1, 'выбор остался — можно тапнуть клетку');
assert.equal(await pi.locator('.ch-pc.drag').count(), 0, 'фигура вернулась на место');
await sq(pi, 'd2').click(); // тап по выбранной снимает выбор
step('перетащили d2 на d6: не ход — фигура вернулась, выбор остался');

// Взятие перетаскиванием: d4, d5, dxe... — подготовим d4/e5.
await pi.mouse.move(...Object.values(await center(pi, 'd2')).slice(0, 2));
await pi.mouse.down();
const d4 = await center(pi, 'd4');
await pi.mouse.move(d4.x, d4.y, { steps: 5 });
await pi.mouse.up();
await until(() => room.match.moves.length === 3, 'd2-d4');
const e5 = await center(pm, 'e5');
await pm.mouse.move(e5.x, e5.y);
await pm.mouse.down();
const d4m = await center(pm, 'd4');
await pm.mouse.move(d4m.x, d4m.y, { steps: 5 });
await pm.mouse.up();
await until(() => room.match.moves.length === 4, 'exd4');
assert.equal(room.match.moves[3].san, 'exd4', 'взятие перетаскиванием');
assert.equal(room.match.pos.b[27], 'p', 'чёрная пешка стоит на d4');
step('Макс взял перетаскиванием: e5×d4');

/* ------------------------------------------------ палец: сенсорное касание */

const pt = await openPage(ivan, room.code, { touch: true });
await pt.waitForSelector('.ch-board');
const cdp = await pt.context().newCDPSession(pt);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
const g1 = await center(pt, 'g1');
const f3 = await center(pt, 'f3');
await touch('touchStart', g1.x, g1.y);
// Палец ведёт фигуру; она чуть выше пальца, поэтому целимся ниже клетки-цели.
await touch('touchMove', (g1.x + f3.x) / 2, (g1.y + f3.y) / 2 + f3.h * 0.55);
await touch('touchMove', f3.x, f3.y + f3.h * 0.55);
assert.equal(await pt.locator('.ch-pc.drag').count(), 1, 'пальцем фигура тоже в руке');
assert.equal(await pt.evaluate(() => scrollY), 0, 'страница не прокрутилась');
await touch('touchEnd');
await until(() => room.match.moves.length === 5, 'Nf3 пальцем');
assert.equal(room.match.moves[4].san, 'Nf3');
step('пальцем: конь g1→f3 — фигура идёт чуть выше пальца, страница не едет');

/* --------------------------------------------- рокировка: ладья тоже едет */

room.match.pos = fromFen('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
room.match.moves.length = 4; // белые ходят, ход чётный
app.hub.broadcast(room);
await pi.waitForFunction(() => document.querySelector('.ch-sq[data-sq="h1"] .ch-pc'));
await sq(pi, 'e1').click();
await sq(pi, 'g1').click();
await until(() => room.match.moves.at(-1)?.san === 'O-O', 'рокировка');
await pm.waitForFunction(() => window.__slides.length >= 3);
const moved = await pm.evaluate(() => window.__slides.slice(-2));
assert.deepEqual(moved.sort(), ['f1', 'g1'], 'у соперника поехали и король, и ладья');
step('рокировка: у соперника скользят и король, и ладья');

/* ------------------------------------------------------ формат и ошибки */

for (const page of [pi, pm, pt]) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= iw, `страница шире экрана (${sw} > ${iw})`);
}
assert.deepEqual(problems, [], 'ошибок в консоли страниц нет');
await browser.close();
await web.close();
app.stop?.();
console.log('e2e шахмат: всё сошлось');
process.exit(0);
