/**
 * Пульт владельца, вкладка «Магазин», настоящим браузером на НАСТОЯЩЕМ сервере (bot/app.js + hub + server), 320 и 390 px.
 *
 *   node tools/e2e-admin-shop.mjs          (SHOTS=1 — снимки в preview/)
 *
 * Telegram — заглушка (bot/tg-stub.js), продажи — тестовая среда заглушки; реальных счетов, звёзд и возвратов нет.
 * Путь: «Магазин» → готовность (причины словами) → цена двумя шагами → скрыть/показать → найти человека → выдать →
 * забрать → заказ → возврат двумя шагами → остановить/возобновить продажи. Посторонний по ссылке на админку — «Стол не найден».
 * Вёрстка: нет горизонтального скролла, кнопки вкладки — от 44 px.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { Store } from '../bot/store.js';
import { startServer } from '../bot/server.js';
import { TelegramStub, dmUpdate, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';
import { cfgOf, preCheckout, paid } from '../bot/payments/testkit.js';
import { payloadOf } from '../bot/payments/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_PORT = Number(process.env.E2E_PORT || 8141);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const SHOTS = process.env.SHOTS === '1';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ivan = user(101, 'Иван'); // владелец
const max = user(202, 'Макс');
const step = (s) => console.log(`· ${s}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, ms = 6000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`);
    await wait(30);
  }
}

const sdk = (initData) => `
  window.Telegram = { WebApp: { initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: new URLSearchParams(${JSON.stringify(initData)}).get('start_param') },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(){}, BackButton: { show(){}, hide(){}, onClick(){} },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} } } };`;

const browser = await chromium.launch();
const problems = [];

async function boot(port) {
  const api = new TelegramStub();
  const store = new Store(':memory:');
  const app = new App({ api, store, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${port}`, miniAppName: 'table', admins: ['101'], sales: cfgOf({ mode: 'test' }) });
  const hub = new Hub(app, { botToken: TOKEN });
  app.attachHub(hub);
  const web = startServer({ hub, port, root: path.join(ROOT, 'miniapp'), log: () => {} });
  await new Promise((r) => web.server.once('listening', r));
  for (const u of [ivan, max]) { api.dmOpen.add(String(u.id)); await app.handleUpdate(dmUpdate(u, '/start')); }
  store.putProfile('202', { nickname: 'Максик', avatar: null });
  // Макс купил стол — как в Telegram: заказ → pre_checkout → successful_payment (заглушка).
  const inv = await app.payments.buy('202', 'graphit-table', 'e2e-buy-000001');
  const order = store.pay.order(inv.order);
  const t = { app, tg: api };
  await preCheckout(t, max, { payload: payloadOf(order), amount: order.price });
  await paid(t, max, { payload: payloadOf(order), amount: order.price });
  assert.equal(store.pay.order(order.id).state, 'paid');
  return { app, api, store, web, port, order };
}

async function open(s, u, size, startParam = 'admin') {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(m.text()));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: startParam }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdk(initData) }));
  await page.goto(`http://localhost:${s.port}/`);
  return page;
}

async function noScroll(page, what) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= iw, `${what}: страница шире экрана (${sw} > ${iw})`);
}
async function tapTargets(page, what) {
  const small = await page.evaluate(() => [...document.querySelectorAll('.ashop button, .tabs .tab, .sheet button')]
    .filter((b) => b.offsetParent).map((b) => [b.textContent.trim(), Math.round(b.getBoundingClientRect().height)]).filter(([, hgt]) => hgt < 44));
  assert.deepEqual(small, [], `${what}: кнопки ниже 44 px`);
}
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(path.join(ROOT, 'preview'), { recursive: true }); await page.screenshot({ path: path.join(ROOT, 'preview', name), fullPage: true }); } };
const sheetBtn = (page, name) => page.locator('.sheet').getByRole('button', { name, exact: true });

let port = BASE_PORT;
for (const size of [[320, 640], [390, 844]]) {
  const s = await boot(port++);
  const tag = `${size[0]}px`;

  // Посторонний по ссылке на админку: та же страница, что на выдуманный стол.
  const stranger = await open(s, max, size);
  await stranger.waitForSelector('text=Стол не найден');
  assert.equal(await stranger.locator('.tab', { hasText: 'Магазин' }).count(), 0);
  await stranger.close();
  if (size[0] === 320) step('посторонний по ссылке на админку: «Стол не найден», вкладки нет');

  const pa = await open(s, ivan, size);
  await pa.waitForSelector('h1:has-text("Пульт")');
  await pa.locator('.tab', { hasText: 'Магазин' }).click();
  await pa.waitForSelector('.ashop');
  const ready = await pa.locator('.ashop .box').first().innerText();
  assert.match(ready, /Продажи открыты — тестовая среда/);
  for (const [id, price] of [['graphit-cardback', 30], ['graphit-table', 50], ['graphit-profile', 20], ['graphit-bundle', 80]]) {
    assert.match(await pa.locator(`.ashop-item[data-item="${id}"]`).innerText(), new RegExp(`${price} ⭐`));
  }
  await noScroll(pa, `${tag} магазин`);
  await tapTargets(pa, `${tag} магазин`);
  await shot(pa, `admin-shop-${size[0]}.png`);
  step(`${tag}: вкладка «Магазин» — готовность, четыре вещи с ценами; без скролла вбок, кнопки от 44 px`);

  // Цена двумя шагами.
  const row = pa.locator('.ashop-item[data-item="graphit-table"]');
  await row.locator('.ashop-price').fill('65');
  await row.locator('[data-act="ashop-price"]').click();
  await pa.waitForSelector('.sheet');
  const askText = await pa.locator('.sheet').innerText();
  assert.match(askText, /50 ⭐ → 65 ⭐/);
  assert.match(askText, /старой ценой оплатить будет нельзя/);
  assert.equal(s.app.payments.offers().items['graphit-table'], 50, 'до «Подтвердить» цена прежняя');
  await tapTargets(pa, `${tag} окно цены`);
  await wait(400); // шторка доезжает — снимок без полупрозрачности
  await shot(pa, `admin-shop-price-${size[0]}.png`);
  await sheetBtn(pa, 'Подтвердить').click();
  await until(() => s.app.payments.offers().items['graphit-table'] === 65, 'цена сменилась');
  await pa.waitForFunction(() => /65 ⭐/.test(document.querySelector('.ashop-item[data-item="graphit-table"]')?.textContent || ''));
  step(`${tag}: цена стола 50 → 65 ⭐ — окно «было → стало», только после «Подтвердить»`);

  // Скрыть / показать.
  await row.locator('[data-act="ashop-hide"]').click();
  await until(() => s.app.payments.offers().hidden.includes('graphit-table'), 'скрыта');
  await pa.waitForSelector('.ashop-item[data-item="graphit-table"] [data-act="ashop-show"]');
  await pa.locator('.ashop-item[data-item="graphit-table"] [data-act="ashop-show"]').click();
  await until(() => !s.app.payments.offers().hidden.includes('graphit-table'), 'показана');

  // Найти по нику → выдать → забрать.
  await pa.locator('input[aria-label="Кому: Telegram id или ник"]').fill('макс');
  await pa.locator('[data-act="ashop-find"]').click();
  await pa.locator('.ashop-found .btn', { hasText: 'Максик · 202' }).click();
  await pa.waitForSelector('.ashop-user[data-user="202"]');
  assert.match(await pa.locator('.ashop-give[data-item="graphit-table"]').innerText(), /куплено/);
  await pa.locator('.ashop-give[data-item="graphit-profile"] [data-act="ashop-grant"]').click();
  await until(() => s.app.collections.ownedItems('202').includes('graphit-profile'), 'выдано');
  await pa.waitForSelector('.ashop-give[data-item="graphit-profile"] [data-act="ashop-revoke"]');
  assert.match(await pa.locator('.ashop-give[data-item="graphit-profile"]').innerText(), /выдано вами/);
  assert.equal(s.store.pay.db.prepare('SELECT COUNT(*) n FROM pay_order').get().n, 1, 'выдача не создала заказа');
  await noScroll(pa, `${tag} выдача`);
  await tapTargets(pa, `${tag} выдача`);
  await shot(pa, `admin-shop-give-${size[0]}.png`);
  await pa.locator('.ashop-give[data-item="graphit-profile"] [data-act="ashop-revoke"]').click();
  await pa.waitForSelector('.sheet');
  await sheetBtn(pa, 'Забрать').click();
  await until(() => !s.app.collections.ownedItems('202').includes('graphit-profile'), 'забрано');
  assert.ok(s.app.collections.ownedItems('202').includes('graphit-table'), 'купленное осталось');
  step(`${tag}: нашёл «Максик» по нику, выдал знак (заказа нет), забрал — купленный стол на месте`);

  // Возврат двумя шагами.
  const ord = pa.locator(`.ashop-order[data-order="${s.order.id}"]`);
  await ord.locator('[data-act="ashop-refund"]').click();
  await pa.waitForSelector('.sheet');
  assert.match(await pa.locator('.sheet').innerText(), /Права на вещь будут сняты/);
  assert.equal(s.api.calls.filter((c) => c.method === 'refundStarPayment').length, 0, 'до «Вернуть» денег не трогаем');
  await sheetBtn(pa, 'Вернуть 50 ⭐').click();
  await until(() => s.store.pay.order(s.order.id).state === 'refunded', 'возврат');
  assert.equal(s.api.calls.filter((c) => c.method === 'refundStarPayment').length, 1);
  await pa.waitForFunction((id) => /возвращён/.test(document.querySelector(`.ashop-order[data-order="${id}"]`)?.textContent || ''), s.order.id);
  step(`${tag}: возврат — сумма и код от сервера, «Вернуть 50 ⭐», один вызов заглушки`);

  // Остановить / возобновить.
  await pa.locator('[data-act="ashop-stop"]').click();
  await pa.waitForSelector('.sheet');
  await sheetBtn(pa, 'Остановить').click();
  await until(() => s.store.pay.stopped(), 'остановлено');
  await pa.waitForSelector('[data-act="ashop-resume"]');
  assert.match(await pa.locator('.ashop-reasons').innerText(), /остановлены владельцем/);
  await pa.locator('[data-act="ashop-resume"]').click();
  await until(() => !s.store.pay.stopped(), 'возобновлено');
  step(`${tag}: «Остановить новые продажи» → причина в готовности → «Возобновить»`);

  await pa.waitForSelector('.ashop-log');
  await noScroll(pa, `${tag} в конце`);
  await pa.close();
  await s.web.close();
  s.app.stop();
  s.store.close();
}

/* ------------------------------------------- сторона игрока: подарок при выключенных продажах */
{
  const port2 = port++;
  const api = new TelegramStub();
  const store = new Store(':memory:');
  const app = new App({ api, store, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${port2}`, miniAppName: 'table', admins: ['101'] });
  const hub = new Hub(app, { botToken: TOKEN });
  app.attachHub(hub);
  const web = startServer({ hub, port: port2, root: path.join(ROOT, 'miniapp'), log: () => {} });
  await new Promise((r) => web.server.once('listening', r));
  assert.equal(app.payments.cfg.mode, 'off');
  const s2 = { port: port2 };
  const pa = await open(s2, ivan, [320, 640]);
  await pa.waitForSelector('h1:has-text("Пульт")');
  await pa.locator('.tab', { hasText: 'Магазин' }).click();
  await pa.waitForSelector('.ashop-reasons');
  assert.match(await pa.locator('.ashop-reasons').innerText(), /SALES_MODE/, 'причина «режим выключен» словами');
  await pa.locator('input[aria-label="Кому: Telegram id или ник"]').fill('202');
  await pa.locator('[data-act="ashop-find"]').click();
  await pa.locator('.ashop-give[data-item="graphit-cardback"] [data-act="ashop-grant"]').click();
  await until(() => app.collections.ownedItems('202').includes('graphit-cardback'), 'выдано при выключенных продажах');
  await pa.close();

  const pm = await open(s2, max, [320, 640], '');
  await pm.waitForSelector('.nav-tab[data-tab="settings"]');
  await pm.locator('.nav-tab[data-tab="settings"]').click();
  await pm.locator('[data-entry="collections"]').click();
  await pm.locator('[data-act="purchases"]').click();
  await pm.waitForSelector('.col-order[data-gift]');
  const text = await pm.locator('.col-purchases').innerText();
  assert.match(text, /Рубашка «Графит»/);
  assert.match(text, /Подарок от администратора/);
  assert.ok(!/Заказ /.test(text) && !/⭐/.test(text.split('Поддержка')[0]), 'у подарка нет номера заказа и цены');
  assert.equal(api.calls.filter((c) => c.method === 'createInvoiceLink').length, 0, 'счетов не было');
  await noScroll(pm, '320 мои покупки');
  await shot(pm, 'admin-shop-gift-320.png');
  step('продажи выключены: владелец выдал рубашку — у Макса «Мои покупки» → «Подарок от администратора», без цены и номера');
  await pm.close();
  await web.close();
  app.stop();
  store.close();
}

assert.deepEqual(problems, [], 'ошибок в консоли страниц нет');
await browser.close();
console.log('e2e магазина в админке: всё сошлось');
process.exit(0);
