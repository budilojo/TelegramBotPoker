/**
 * Смайлики настоящими браузерами: кнопка → шторка 4×4 → пузырь у других
 * игроков; зритель кнопки не видит; «Не показывать смайлики»; пузырь не
 * закрывает карты и кнопки действий. Покер на троих (320 и 390 px) и шахматы.
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

/* ------------------------------------------------------------- покер */

for (const [w, h] of [[320, 568], [390, 844]]) {
  // Лимит — на человека за всеми столами сразу: новый прогон начинаем с чистого.
  hub.reactLimiter.sent.clear();
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
  const pz = await openPage(zoya, room.code, w, h);
  await pz.waitForSelector('.table');
  assert.equal(await pz.locator('.rx-btn').count(), 0, 'у зрителя кнопки смайликов нет');
  step(`${w}px: трое за столом, у зрителя кнопки нет`);

  // Кнопка → шторка 4×4.
  const btn = pi.locator('.rx-btn');
  const bb = await btn.boundingBox();
  assert.ok(bb.width >= 44 && bb.height >= 44, `кнопка не меньше 44 px (${bb.width}×${bb.height})`);
  await btn.click();
  await pi.waitForSelector('.rx-grid');
  assert.equal(await pi.locator('.rx-cell').count(), 16, '16 смайликов в шторке');
  for (const c of await pi.locator('.rx-cell').all()) {
    const r = await c.boundingBox();
    assert.ok(r.width >= 44 && r.height >= 44, `клетка шторки не меньше 44 px (${r.width}×${r.height})`);
  }
  const cols = new Set(await pi.locator('.rx-cell').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left))));
  assert.equal(cols.size, 4, 'четыре колонки');
  await until(() => pi.locator('.rx-cell .rx-emoji').count().then((n) => n === 16), 'без картинок — запасные эмодзи');
  await noSideways(pi, `${w}px шторка`);
  await pi.waitForTimeout(400); // шторка доехала
  await shot(pi, `poker-sheet-${w}`);
  // Подписи не рвут слово посередине: у каждой строки — целые слова.
  const broken = await pi.locator('.rx-label').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  assert.deepEqual(broken, [], 'подписи помещаются в клетку');

  // Тап — пузырь у остальных над местом Ивана.
  const seat = room.players.findIndex((p) => p.id === '101');
  await pi.locator('.rx-cell[data-rx="fire"]').click();
  for (const p of [pm, pd, pz, pi]) await p.waitForSelector(`.rx-bubble[data-rx-seat="${seat}"][data-rx="fire"]`);
  assert.equal(await pi.locator('.rx-grid').count(), 0, 'шторка закрылась');
  assert.ok(await pi.locator('.rx-btn.cool').count(), 'кнопка бледная, пока «подождите»');
  // У Макса пузырь у аватара Ивана, а не где попало.
  const av = await box(pm, `.seat[data-seat="${seat}"] .av`);
  const bub = await box(pm, '.rx-bubble');
  assert.ok(Math.abs(bub.x + bub.width / 2 - (av.x + av.width / 2)) < 40, 'пузырь над аватаром отправителя');
  for (const p of [pm, pd, pi]) await clearOf(p, '.rx-bubble', ['.panel button', '.board img.card', '.hero-cards img.card'], `${w}px`);
  await shot(pm, `poker-bubble-${w}`);
  await shot(pi, `poker-mine-${w}`);
  step(`${w}px: Иван отправил «Огонь!» — пузырь у всех над его местом, карты и кнопки свободны`);

  // Сразу второй — отказ словами, пузыря нет.
  await btn.click();
  await pi.locator('.rx-cell[data-rx="gg"]').click();
  await pi.waitForSelector('#toast.show');
  assert.match(await pi.locator('#toast').textContent(), /подождите \d+ с/);
  assert.equal(await pm.locator('.rx-bubble[data-rx="gg"]').count(), 0);

  // Пузырь уходит сам.
  await until(() => pm.locator('.rx-bubble').count().then((n) => n === 0), 'пузырь пропал', 4500);
  await until(() => pi.locator('.rx-btn.cool').count().then((n) => n === 0), 'кнопка снова яркая', 2000);
  step(`${w}px: второй подряд — «подождите N с»; пузырь ушёл через ~3 с, кнопка снова яркая`);

  if (w === 320) {
    // «Не показывать смайлики» у Макса: кнопки нет, пузырей нет. У Димы — есть.
    await pm.getByRole('button', { name: 'Меню' }).click();
    await pm.getByRole('button', { name: /Не показывать смайлики/ }).click();
    await until(() => pm.locator('.rx-btn').count().then((n) => n === 0), 'у Макса кнопка спряталась');
    await btn.click();
    await pi.locator('.rx-cell[data-rx="cool"]').click();
    await pd.waitForSelector('.rx-bubble[data-rx="cool"]');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await pm.locator('.rx-bubble').count(), 0, 'у выключившего пузырей нет');
    // Включается обратно тем же пунктом меню и переживает перезагрузку как выбор телефона.
    await pm.reload();
    await pm.waitForSelector('.table');
    assert.equal(await pm.locator('.rx-btn').count(), 0, 'выбор помнится после перезагрузки');
    await pm.getByRole('button', { name: 'Меню' }).click();
    await pm.getByRole('button', { name: /Показывать смайлики/ }).click();
    await pm.waitForSelector('.rx-btn');
    step('320px: «Не показывать смайлики» — у Макса ни кнопки, ни пузырей; включается обратно');
  }
  for (const p of [pi, pm, pd, pz]) await noSideways(p, `${w}px стол`);
  for (const p of [pi, pm, pd, pz]) await p.close();
}

/* ------------------------------------------------------------ шахматы */

for (const [w, h] of [[320, 568], [390, 844]]) {
  hub.reactLimiter.sent.clear();
  const room = app.createGame('chess', { chatId: String(CHAT - 7 - w), title: '', host: { id: 101, tgId: 101, name: 'Иван' }, settings: { base: 0 } });
  const pi = await openPage(ivan, room.code, w, h);
  const pm = await openPage(max, room.code, w, h);
  await pm.waitForSelector('h1:has-text("Шахматы")');
  await pm.getByRole('button', { name: 'Сесть за доску' }).click();
  await until(() => room.players.length === 2, 'Макс сел');
  await pi.getByRole('button', { name: '▶ Начать' }).click();
  await until(() => !!room.match, 'партия');
  for (const p of [pi, pm]) await p.waitForSelector('.ch-board');
  await pm.locator('.rx-btn').click();
  await pm.locator('.rx-cell[data-rx="think"]').click();
  for (const p of [pi, pm]) await p.waitForSelector('.rx-bubble[data-rx="think"]');
  // У Ивана — у верхней плашки (Макс чёрными), справа от аватара, не на доске.
  const bar = await box(pi, '.ch-bar[data-color="b"]');
  const bub = await box(pi, '.rx-bubble');
  assert.ok(bub.y + bub.height > bar.y && bub.y < bar.y + bar.height, 'пузырь на уровне плашки соперника');
  await clearOf(pi, '.rx-bubble', ['.ch-board', '.ch-head button'], `шахматы ${w}px`);
  await clearOf(pm, '.rx-bubble', ['.ch-board', '.ch-head button'], `шахматы ${w}px, свой`);
  const title = await pi.locator('.ch-title').evaluate((e) => e.scrollWidth <= e.clientWidth + 1);
  assert.ok(title, `${w}px: заголовок шахмат не обрезан`);
  for (const p of [pi, pm]) await noSideways(p, `шахматы ${w}px`);
  await shot(pi, `chess-bubble-${w}`);
  await shot(pm, `chess-mine-${w}`);
  step(`шахматы ${w}px: смайлик Макса — у плашки соперника у Ивана, доска свободна`);
  for (const p of [pi, pm]) await p.close();
}

assert.deepEqual(problems, [], 'ошибок в консоли страниц нет');
await browser.close();
await web.close();
app.stop?.();
console.log('e2e смайликов: всё сошлось');
process.exit(0);
