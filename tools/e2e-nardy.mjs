/**
 * Нарды настоящими браузерами: жребий, кубики одинаковые у обоих, «Бросить»
 * без чисел в запросе, шаг тапом с числом на точке, перетаскивание мышью,
 * «Вернуть» и «Готово», история бросков, снятие с доски, 320 px.
 *
 *   node tools/e2e-nardy.mjs
 *
 * Тот же сервер, сокет и страница, что в бою; Telegram — заглушка; кубики —
 * подмена приложения (`app.nardyDice`), как в тестах.
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
import { abs } from '../bot/games/nardy/board.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8098);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const CHAT = -100993;
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
app.nardyRand = () => 0.1; // хост — белыми
const queue = [[5, 3], [4, 2], [6, 1]];
app.nardyDice = () => queue.shift() || [2, 1];
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
  window.__sent = [];
  const socketSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    window.__sent.push(JSON.parse(data));
    return socketSend.call(this, data);
  };`;

const browser = await chromium.launch();
async function openPage(u, code, { width = 390, height = 844 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${u.first_name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${u.first_name}: ${m.text()}`));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: code }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  return page;
}

const room = app.createGame('nardy', { chatId: String(CHAT), title: 'Клуб', host: { id: 101, tgId: 101, name: 'Иван' }, settings: { base: 0 } });
const pi = await openPage(ivan, room.code);
const pm = await openPage(max, room.code);
await pm.waitForSelector('h1:has-text("Нарды")');
await pm.getByRole('button', { name: 'Сесть за доску' }).click();
await until(() => room.players.length === 2, 'Макс сел');
await pi.getByRole('button', { name: '▶ Начать' }).click();
await until(() => !!room.match, 'партия началась');
await pi.waitForSelector('.nd-board');
await pm.waitForSelector('.nd-board');

const pt = (page, p) => page.locator(`.nd-pt[data-p="${p}"]`);
const diceOn = (page) => page.locator('.nd-faces').getAttribute('aria-label');
assert.equal(await diceOn(pi), 'кубики 5 и 3');
assert.equal(await diceOn(pm), 'кубики 5 и 3', 'у соперника те же кубики');
assert.equal(await pi.locator('.nd-pt .nd-pc').count(), 10, 'на двух головах по пять видимых шашек (дальше — число)');
assert.equal(await pt(pi, abs('w', 0)).locator('.nd-count').textContent(), '15');
step('жребий: у белых 5 против 3 — первым ходит Иван; кубики «5 и 3» у обоих, на головах по 15');

/* ------------------------------------------------- шаг тапом: число на точке */

await pi.waitForSelector('.ch-status.mine');
assert.ok(await pt(pi, abs('w', 0)).evaluate((e) => e.classList.contains('can')), 'с головы можно — пункт обведён');
await pt(pi, abs('w', 0)).click();
const badges = await pi.locator('.nd-die').evaluateAll((els) => els.map((e) => e.textContent).sort());
assert.deepEqual(badges, ['3', '5'], 'две точки: на 5 и на 3');
await pt(pi, abs('w', 5)).click();
await until(() => room.match.turn.played.length === 1, 'шаг на 5');
await pi.waitForSelector('.nd-dicef.used');
assert.equal(await pi.locator('.nd-dicef.used').count(), 1, 'сыгранный кубик бледный');
// С головы второй нельзя — точек с головы больше нет.
assert.equal(await pt(pi, abs('w', 0)).evaluate((e) => e.classList.contains('can')), false, 'с головы — одна за ход');
step('тап по голове — точки «5» и «3»; тап по точке — шаг; сыгранный кубик бледнеет; с головы второй не предлагают');

/* ---------------------------------------------------- «Вернуть» и «Готово» */

await pi.getByRole('button', { name: 'Вернуть' }).click();
await until(() => room.match.turn.played.length === 0, 'шаг вернули');
await pi.waitForFunction(() => !document.querySelector('.nd-dicef.used'));
await pt(pi, abs('w', 0)).click();
await pt(pi, abs('w', 3)).click();
await until(() => room.match.turn.played.length === 1, 'шаг на 3');
await pt(pi, abs('w', 3)).click();
await pt(pi, abs('w', 8)).click();
await until(() => room.match.turn.played.length === 2, 'шаг на 5');
await pi.getByRole('button', { name: 'Готово' }).click();
await until(() => room.match.turn.c === 'b', 'ход перешёл');
assert.deepEqual(room.match.log[0].notation, ['24/21', '21/16']);
step('«Вернуть» — шаг назад; потом 24/21 21/16 и «Готово» — ход у Макса');

/* ------------------------------------------- бросок: без чисел, одинаковый */

await pm.getByRole('button', { name: '🎲 Бросить' }).click();
await until(() => !!room.match.turn.dice, 'Макс бросил');
const rollMsg = await pm.evaluate(() => window.__sent.filter((m) => m.t === 'roll'));
assert.equal(rollMsg.length, 1);
assert.ok(!('dice' in rollMsg[0]) && !Object.values(rollMsg[0]).some(Array.isArray), `в запросе «бросить» нет чисел: ${JSON.stringify(rollMsg[0])}`);
await pm.waitForFunction(() => document.querySelector('.nd-faces')?.getAttribute('aria-label') === 'кубики 4 и 2');
await pi.waitForFunction(() => document.querySelector('.nd-faces')?.getAttribute('aria-label') === 'кубики 4 и 2');
step('«Бросить»: в запросе нет чисел, кубики выбросил сервер — «4 и 2» у обоих');

/* ------------------------------------------------ перетаскивание мышью */

const from = await pt(pm, abs('b', 0)).locator('.nd-pc').last().boundingBox();
const to = await pt(pm, abs('b', 4)).boundingBox();
await pm.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
await pm.mouse.down();
await pm.mouse.move(from.x + 20, from.y + 10, { steps: 3 });
await pm.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
await pm.mouse.up();
await until(() => room.match.turn.played.length === 1, 'Макс перетащил шашку на 4');
assert.equal(room.match.turn.played[0].die, 4);
await pm.waitForTimeout(400); // тап сразу после броска пальцем страница считает хвостом перетаскивания
await pt(pm, abs('b', 4)).click();
await pt(pm, abs('b', 6)).click();
await until(() => room.match.turn.played.length === 2, 'и сыграл 2');
await pm.getByRole('button', { name: 'Готово' }).click();
await until(() => room.match.turn.c === 'w', 'ход у Ивана');
step('перетаскивание мышью: с головы на 4, потом 2 тапом и «Готово»');

/* ---------------------------------------------------- история бросков */

await pi.locator('.k-icon-btn[aria-label="Меню"]').click();
await pi.getByRole('button', { name: /История бросков/ }).click();
await pi.waitForSelector('.nd-rolls .res-row');
const rows = await pi.locator('.nd-rolls .res-row').allTextContents();
assert.equal(rows.length, 2);
assert.match(rows[0], /Жребий/);
assert.match(rows[1], /Макс.*4-2/);
await pi.keyboard.press('Escape');
step('история бросков: жребий и бросок Макса с его ходом — видно Ивану');

/* ------------------------------------------------------- снятие с доски */

const b = Array(24).fill(0);
b[abs('w', 20)] = 2;
b[abs('w', 23)] = 1;
b[abs('b', 5)] = -15;
room.match.pos = { b, off: { w: 12, b: 0 }, t: 'w' };
room.match.turn = { c: 'w', dice: [6, 1], played: [], start: { b: b.slice(), off: { w: 12, b: 0 }, t: 'w' }, headLimit: 1 };
room.seq += 1;
app.hub.broadcast(room);
await pi.reload();
await pi.waitForSelector('.nd-board');
await pt(pi, abs('w', 20)).click();
await pi.waitForSelector('.nd-off.show.dot');
await pi.locator('.nd-off').click();
await until(() => room.match.pos.off.w === 13, 'сняли шашку');
step('снятие: «⤓ Снять» рядом с кубиками — цель, тап снимает шашку (6 с 4-го пункта)');

/* ----------------------------------------- /nardy в группе и маленький экран */

await app.handleUpdate(cmdUpdate(CHAT, ivan, '/nardy', { message_id: 900 }));
await app.settle();
const lobby = app.liveRooms(String(CHAT)).find((r) => r.game === 'nardy' && r.status === 'lobby');
assert.ok(lobby, '/nardy — лобби одной командой');
assert.equal(api.message(lobby.ui.tableMessageId).markup.inline_keyboard[0][0].text, '🎲 Присоединиться');
step('/nardy в группе: лобби одной командой, карточка «Присоединиться»');

const small = await openPage(ivan, room.code, { width: 320, height: 568 });
await small.waitForSelector('.nd-board');
for (const page of [pi, pm, small]) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= iw, `страница шире экрана (${sw} > ${iw})`);
}
const board = await small.locator('.nd-board').boundingBox();
const status = await small.locator('.ch-status').boundingBox();
const panel = await small.locator('.panel').boundingBox();
assert.ok(board.x >= 0 && board.x + board.width <= 320, 'доска по ширине на экране');
assert.ok(status.y + status.height <= panel.y + 1, 'строка под доской не уходит под кнопки');
const col = await small.locator('.nd-pt').first().boundingBox();
step(`на 320×568 доска и строка помещаются, горизонтального скролла нет (пункт ${Math.round(col.width)}×${Math.round(col.height)} px)`);

assert.deepEqual(problems, [], 'ошибок в консоли страниц нет');
await browser.close();
app.stop?.();
console.log('e2e нардов: всё сошлось');
process.exit(0);
