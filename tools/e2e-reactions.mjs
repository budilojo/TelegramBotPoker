/**
 * Реакции настоящими браузерами: быстрый ряд в чате → пузырь у других игроков
 * над местом отправившего; «подождите N с»; пузырь не закрывает карты и кнопки.
 * Покер на троих (320 и 390 px) и шахматы. (Сам чат — tools/e2e-chat.mjs.)
 *
 *   node tools/e2e-reactions.mjs
 *   SHOTS=1 node tools/e2e-reactions.mjs   ещё и снимки в preview/reactions/
 *
 * Тот же сервер, сокет и страница, что в бою; Telegram — заглушка. Нужен
 * Playwright с Chromium (как tools/e2e.mjs).
 *
 * Картинок miniapp/emoji/*.png пока нет: проверяется запасной эмодзи. Запрос
 * несуществующей картинки браузер пишет в консоль (404) — такие строки здесь
 * не считаются ошибкой, все остальные считаются.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { startServer } from '../bot/server.js';
import { TelegramStub, cmdUpdate, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8097);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const CHAT = -100977;
const SHOTS = process.env.SHOTS === '1';
const OUT = path.join(ROOT, 'preview', 'reactions');
if (SHOTS) fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

const ivan = user(101, 'Иван');
const max = user(202, 'Макс');
const dima = user(303, 'Дима');
const zoya = user(404, 'Зоя'); // зритель

const api = new TelegramStub();
const app = new App({ api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${PORT}`, miniAppName: 'table' });
app.chessRand = () => 0.1;
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));

const step = (s) => console.log(`· ${s}`);
const problems = [];
async function until(cond, what, ms = 4000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
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
  } };`;

const browser = await chromium.launch();
async function openPage(u, code, width = 360, height = 740) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => problems.push(`${u.first_name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource.*404/.test(m.text()) && /\/emoji\//.test(m.location()?.url || '')) return;
    problems.push(`${u.first_name}: ${m.text()}`);
  });
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: code }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  return page;
}

const box = (page, sel) => page.locator(sel).first().boundingBox();
const overlap = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Пузырь не лежит ни на одной из этих вещей. */
async function clearOf(page, bubbleSel, sels, what) {
  await page.waitForTimeout(300); // появление (0,22 с) закончилось: меряем настоящий размер
  const b = await box(page, bubbleSel);
  assert.ok(b, `${what}: пузырь на экране`);
  for (const sel of sels) {
    for (const el of await page.locator(sel).all()) {
      if (!(await el.isVisible())) continue;
      const r = await el.boundingBox();
      assert.ok(!overlap(b, r), `${what}: пузырь закрывает ${sel} (${JSON.stringify(b)} / ${JSON.stringify(r)})`);
    }
  }
}
async function noSideways(page, what) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= iw, `${what}: страница шире экрана (${sw} > ${iw})`);
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(OUT, `${name}.png`) });


const setLimit = () => {
  hub.reactLimiter.sent.clear();
  hub.chatLimiter.by.clear();
};
/** Подождать, пока клиент-лимит «3 с» у этой страницы пройдёт. */
const cooled = (page) => page.waitForFunction(() => !document.querySelector('.chat-q.cool'), null, { timeout: 5000 });

/* ------------------------------------------------------------- покер */

for (const [w, h] of [[320, 568], [390, 844]]) {
  setLimit();
  const chat = CHAT - w;
  await app.handleUpdate(cmdUpdate(chat, ivan, '/newgame', { message_id: w }));
  await app.settle();
  const room = app.room(chat);
  const pi = await openPage(ivan, room.code, w, h);
  const pm = await openPage(max, room.code, w, h);
  const pd = await openPage(dima, room.code, w, h);
  for (const p of [pm, pd]) {
    await p.waitForSelector('.lobby');
    await p.getByRole('button', { name: 'Сесть за стол' }).first().click();
  }
  await until(() => room.players.length === 3, 'трое за столом');
  await pi.getByRole('button', { name: '▶ Начать' }).click();
  await until(() => room.status === 'playing', 'раздача');
  for (const p of [pi, pm, pd]) await p.waitForSelector('.hero-cards img.card');

  // Реакция — из быстрого ряда панели чата.
  await pi.locator('.chat-fab').click();
  await pi.waitForSelector('.chat-quick');
  await pi.waitForTimeout(400);
  const seat = room.players.findIndex((p) => p.id === '101');
  await pi.locator('.chat-q[data-rx-pick="fire"]').click().catch(() => {});
  if (!(await pm.locator('.rx-bubble').count())) {
    await pi.locator('[data-chat-more]').click();
    await pi.locator('.chat-cell[data-rx="fire"]').click();
  }
  for (const p of [pm, pd, pi]) await p.waitForSelector(`.rx-bubble[data-rx-seat="${seat}"][data-rx="fire"]`);
  await pi.locator('.chat-close').click();
  assert.ok(await pi.locator('.chat-q.cool, .chat-fab').count(), 'панель закрыта, кнопка на месте');
  const av = await box(pm, `.seat[data-seat="${seat}"] .av`);
  const bub = await box(pm, '.rx-bubble');
  assert.ok(Math.abs(bub.x + bub.width / 2 - (av.x + av.width / 2)) < 40, 'пузырь над аватаром отправителя');
  for (const p of [pm, pd, pi]) await clearOf(p, '.rx-bubble', ['.panel button', '.board img.card', '.hero-cards img.card'], `${w}px`);
  await shot(pm, `poker-bubble-${w}`);
  step(`${w}px: Иван отправил «Огонь» — пузырь у всех над его местом, карты и кнопки свободны`);

  // Сразу второй — отказ словами, пузыря нет.
  await pi.locator('.chat-fab').click();
  await pi.locator('.chat-q[data-rx-pick="gg"]').click();
  await pi.waitForSelector('#toast.show');
  assert.match(await pi.locator('#toast').textContent(), /подождите \d+ с/);
  assert.equal(await pm.locator('.rx-bubble[data-rx="gg"]').count(), 0);
  await until(() => pm.locator('.rx-bubble').count().then((n) => n === 0), 'пузырь пропал', 4500);
  await cooled(pi);
  step(`${w}px: второй подряд — «подождите N с»; пузырь ушёл через ~3 с, реакции снова яркие`);
  for (const p of [pi, pm, pd]) await noSideways(p, `${w}px стол`);
  for (const p of [pi, pm, pd]) await p.close();
}

/* ------------------------------------------------------------ шахматы */

for (const [w, h] of [[320, 568], [390, 844]]) {
  setLimit();
  const room = app.createGame('chess', { chatId: String(CHAT - 7 - w), title: '', host: { id: 101, tgId: 101, name: 'Иван' }, settings: { base: 0 } });
  const pi = await openPage(ivan, room.code, w, h);
  const pm = await openPage(max, room.code, w, h);
  await pm.waitForSelector('h1:has-text("Шахматы")');
  await pm.getByRole('button', { name: 'Сесть за доску' }).click();
  await until(() => room.players.length === 2, 'Макс сел');
  await pi.getByRole('button', { name: '▶ Начать' }).click();
  await until(() => !!room.match, 'партия');
  for (const p of [pi, pm]) await p.waitForSelector('.ch-board');
  await pm.locator('.chat-fab').click();
  await pm.waitForTimeout(400);
  await pm.locator('.chat-q[data-rx-pick="think"]').click();
  for (const p of [pi, pm]) await p.waitForSelector('.rx-bubble[data-rx="think"]');
  const bar = await box(pi, '.ch-bar[data-color="b"]');
  const bub = await box(pi, '.rx-bubble');
  assert.ok(bub.y + bub.height > bar.y && bub.y < bar.y + bar.height, 'пузырь на уровне плашки соперника');
  await clearOf(pi, '.rx-bubble', ['.ch-board', '.ch-head button'], `шахматы ${w}px`);
  // В шахматах нет покерной категории: «ещё» — один набор без вкладок.
  await pm.locator('[data-chat-more]').click();
  assert.equal(await pm.locator('.chat-tab').count(), 0, 'в шахматах одна категория — без вкладок');
  assert.equal(await pm.locator('.chat-cell').count(), 14, 'общие 14 реакций');
  assert.equal(await pm.locator('.chat-cell[data-rx="bluff"], .chat-cell[data-rx="allin"]').count(), 0, 'покерных реакций нет');
  const title = await pi.locator('.ch-title').evaluate((e) => e.scrollWidth <= e.clientWidth + 1);
  assert.ok(title, `${w}px: заголовок шахмат не обрезан`);
  assert.equal(await pi.locator('.ch-head .rx-btn').count(), 0, 'в шапке кнопки смайликов нет');
  for (const p of [pi, pm]) await noSideways(p, `шахматы ${w}px`);
  await shot(pi, `chess-bubble-${w}`);
  step(`шахматы ${w}px: смайлик Макса — у плашки соперника у Ивана, доска свободна; «ещё» — только общие`);
  for (const p of [pi, pm]) await p.close();
}

assert.deepEqual(problems, [], 'ошибок в консоли страниц нет');
await browser.close();
await web.close();
app.stop?.();
console.log('e2e смайликов: всё сошлось');
process.exit(0);
