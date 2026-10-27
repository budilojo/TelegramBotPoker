/**
 * Иконка на рабочий стол в «Настройках» настоящим браузером (Chromium) с заглушкой Telegram.
 *
 *   node tools/e2e-homescreen.mjs
 *   SHOTS=1 node tools/e2e-homescreen.mjs   ещё и снимки в preview/homescreen/
 *
 * Сценарии заглушки: нет метода; версия мала; метод есть, «не добавлено»; успех подтверждён событием;
 * успех подтверждён повторной проверкой; отказ; успех НЕ подтверждён (иконка не объявляется добавленной).
 * Это эмуляция, а не живой Telegram: реальное добавление иконки так не проверить.
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
import { assertNoJump } from './lib/scroll-probe.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8099);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const SHOTS = process.env.SHOTS === '1';
const OUT = path.join(ROOT, 'preview', 'homescreen');
if (SHOTS) fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const api = new TelegramStub();
const app = new App({ api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${PORT}`, miniAppName: 'table' });
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));

const step = (s) => console.log(`· ${s}`);
const problems = [];

/** cfg: {methods, version, status, onAdd:'event'|'status'|'nothing'|'throw'}. Счётчики — в window.__hs. */
const sdkStub = (initData, cfg) => `
  (() => { const cfg = ${JSON.stringify(cfg)}; const H = {}; let status = cfg.status; window.__hs = { adds: 0, checks: 0 };
  const W = { initData: ${JSON.stringify(initData)}, initDataUnsafe: {},
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(n, f){ H[n] = f; }, offEvent(n){ delete H[n]; }, openTelegramLink(){},
    isVersionAtLeast: () => cfg.version,
    BackButton: { show(){}, hide(){}, onClick(){} },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} } };
  if (cfg.methods) {
    W.checkHomeScreenStatus = (cb) => { window.__hs.checks++; if (cfg.silentCheck) return; setTimeout(() => cb && cb(status), 20); };
    W.addToHomeScreen = () => { window.__hs.adds++;
      if (cfg.onAdd === 'throw') throw new Error('WebAppMethodUnsupported');
      if (cfg.onAdd === 'event') setTimeout(() => H.homeScreenAdded && H.homeScreenAdded(), 50);
      if (cfg.onAdd === 'status') status = 'added'; };
  }
  window.Telegram = { WebApp: W }; })();`;

const browser = await chromium.launch();
let n = 0;
async function openSettings(cfg, w = 360, h = 740, clock = false) {
  const u = user(5000 + (++n), 'Иван');
  const chat = -100960 - n;
  await app.handleUpdate(cmdUpdate(chat, u, '/play', { message_id: n }));
  await app.settle();
  const group = app.groups.get(String(chat));
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  if (clock) await page.clock.install();
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: `g_${group.code}` }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData, cfg) }));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('.nav');
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.waitForSelector('.hs-row');
  return page;
}
const st = (p) => p.locator('.hs-row').getAttribute('data-hs');
const waitSt = (p, s, timeout = 4000) => p.waitForFunction((x) => document.querySelector('.hs-row')?.dataset.hs === x, s, { timeout });
const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(OUT, `${name}.png`) });
async function layout(p, what) {
  const [sw, iw] = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= iw, `${what}: страница шире экрана`);
  const b = p.locator('.hs-row .btn');
  if (await b.count()) { const r = await b.boundingBox(); assert.ok(r.height >= 44 - 0.5 && r.width >= 44, `${what}: кнопка ≥ 44 px (${r.width}×${r.height})`); }
  const row = await p.locator('.hs-row').boundingBox();
  assert.ok(row.x >= 0 && row.x + row.width <= iw + 1, `${what}: строка в пределах экрана`);
}
const base = { methods: true, version: true, status: 'missed', onAdd: 'event' };

step('нет методов → «недоступно», кнопки нет');
{ const p = await openSettings({ ...base, methods: false });
  assert.equal(await st(p), 'unavailable'); assert.equal(await p.locator('.hs-row .btn').count(), 0);
  assert.match(await p.locator('.hs-row').innerText(), /Недоступно/); await shot(p, 'unavailable'); await p.close(); }

step('версия мала → «недоступно», методы не вызваны');
{ const p = await openSettings({ ...base, version: false });
  assert.equal(await st(p), 'unavailable'); assert.equal(await p.evaluate(() => window.__hs.checks + window.__hs.adds), 0); await p.close(); }

step('статус «unsupported» → «недоступно»');
{ const p = await openSettings({ ...base, status: 'unsupported' }); await waitSt(p, 'unavailable'); await p.close(); }

step('статус «added» → «уже добавлено» (по подтверждению), кнопки нет');
{ const p = await openSettings({ ...base, status: 'added' }); await waitSt(p, 'added');
  assert.equal(await p.locator('.hs-row .btn').count(), 0); await shot(p, 'added'); await p.close(); }

step('«не добавлено» → кнопка; нажатие → ожидание → событие → «добавлено» (все ширины)');
for (const [w, h] of [[320, 640], [360, 740], [390, 844], [430, 932]]) {
  const p = await openSettings(base, w, h); await waitSt(p, 'can'); await layout(p, `${w}px can`); await shot(p, `can-${w}`);
  assert.equal(await p.evaluate(() => window.__hs.adds), 0, 'сам по себе иконку не предлагает');
  await p.locator('.hs-row .btn').focus();
  assert.equal(await p.evaluate(() => document.activeElement.textContent), 'Добавить', 'фокус на кнопке');
  await p.locator('.hs-row .btn').click();
  await waitSt(p, 'added'); await layout(p, `${w}px added`);
  assert.equal(await p.evaluate(() => window.__hs.adds), 1);
  await p.close();
}

step('событие не пришло, повторная проверка говорит «added» → «добавлено» (часы страницы перемотаны на таймаут)');
{ const p = await openSettings({ ...base, onAdd: 'status' }, 360, 740, true);
  await waitSt(p, 'can');
  await p.locator('.hs-row .btn').click();
  assert.equal(await st(p), 'pending'); assert.equal(await p.locator('.hs-row .btn').count(), 0, 'в ожидании кнопки нет — повторное нажатие невозможно');
  await shot(p, 'pending');
  await p.clock.fastForward(31000); await waitSt(p, 'added'); await p.close(); }

step('успех НЕ подтверждён: события нет, проверка отвечает «missed» → «не получилось», не «добавлено»');
{ const p = await openSettings({ ...base, onAdd: 'nothing' }, 360, 740, true);
  await waitSt(p, 'can');
  await p.locator('.hs-row .btn').click();
  assert.equal(await st(p), 'pending');
  await p.waitForTimeout(300);
  assert.notEqual(await st(p), 'added', 'до таймаута иконка не объявляется добавленной');
  await p.clock.fastForward(31000); await waitSt(p, 'failed');
  assert.match(await p.locator('.hs-row').innerText(), /не подтвердил/); await p.close(); }

step('addToHomeScreen бросает ошибку → «не получилось», есть «Повторить»; повтор доходит до метода');
{ const p = await openSettings({ ...base, onAdd: 'throw' }); await waitSt(p, 'can');
  await p.locator('.hs-row .btn').click(); await waitSt(p, 'failed');
  assert.match(await p.locator('.hs-row').innerText(), /Повторить/); await layout(p, 'failed'); await shot(p, 'failed');
  await p.locator('.hs-row .btn').click(); await p.waitForFunction(() => window.__hs.adds === 2); await p.close(); }

step('проверка статуса молчит → не вечный спиннер: через ~6 с «не удалось проверить»');
{ const p = await openSettings({ ...base, silentCheck: true });
  assert.equal(await st(p), 'checking');
  await waitSt(p, 'failed', 9000); assert.match(await p.locator('.hs-row').innerText(), /проверить/); await p.close(); }

step('нажатие не двигает прокрутку и не пересоздаёт «Настройки» (assertNoJump)');
{ const p = await openSettings(base, 320, 400); await waitSt(p, 'can');
  await assertNoJump(p, { scroller: 'auto', at: 'bottom', label: 'добавить иконку' }, () => p.locator('.hs-row .btn').click());
  await p.close(); }

step('длинные подписи при 320 px: ничего не вылезает');
{ const p = await openSettings({ ...base, onAdd: 'throw' }, 320, 640); await waitSt(p, 'can');
  await p.locator('.hs-row .btn').click(); await waitSt(p, 'failed'); await layout(p, '320 failed длинный текст'); await p.close(); }

assert.deepEqual(problems, [], 'ошибок в консоли нет');
await browser.close();
await web.close();
app.stop?.();
console.log('e2e иконки: всё сошлось');
process.exit(0);
