/**
 * Покупка за Stars в настоящем браузере на НАСТОЯЩЕМ сервере (bot/app.js + hub + server), 320 и 390 px.
 *
 *   node tools/e2e-payments.mjs          (SHOTS=1 — снимки в preview/)
 *
 * Telegram — заглушка (bot/tg-stub.js): окно оплаты — подменённый `Telegram.WebApp.openInvoice`, сама «оплата» —
 * обновления pre_checkout_query и successful_payment, которые тест посылает серверу. Реальных счетов и звёзд нет.
 *
 * Путь: «Настройки» → «Коллекции» → стол → «Примерить» → назад → состав/цена/условия → «Купить за 50 ⭐» → окно →
 * «оплачено» в окне (вещи ещё НЕТ — «ждём подтверждения») → successful_payment → «Куплено» → надеть → выбор на сервере.
 * Ещё: отмена окна, «Мои покупки», «Поддержка», условия; режим off — входа нет.
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
const PORT = Number(process.env.E2E_PORT || 8131);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const SHOTS = process.env.SHOTS === '1';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ivan = user(101, 'Иван');
const step = (s) => console.log(`· ${s}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, ms = 6000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`);
    await wait(30);
  }
}

async function boot(port, sales) {
  const api = new TelegramStub();
  const app = new App({ api, store: new Store(':memory:'), botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${port}`, miniAppName: 'table', sales });
  const hub = new Hub(app, { botToken: TOKEN });
  app.attachHub(hub);
  const web = startServer({ hub, port, root: path.join(ROOT, 'miniapp'), log: () => {} });
  await new Promise((r) => web.server.once('listening', r));
  api.dmOpen.add('101');
  await app.handleUpdate(dmUpdate(ivan, '/start'));
  return { app, api, web, port, t: { app, tg: api } };
}

const sdk = (initData) => `
  window.__invoices = [];
  window.Telegram = { WebApp: { initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: new URLSearchParams(${JSON.stringify(initData)}).get('start_param') },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(url){ window.__openedTelegram = url; }, BackButton: { show(){}, hide(){}, onClick(){} },
    openInvoice(url, cb) { window.__invoices.push({ url, cb }); },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} } } };`;

const browser = await chromium.launch();
const problems = [];
async function open(s, u, size) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(m.text()));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdk(initData) }));
  await page.goto(`http://localhost:${s.port}/`);
  await page.waitForSelector('.nav-tab[data-tab="settings"]');
  return page;
}
const goSettings = async (page) => { await page.locator('.nav-tab[data-tab="settings"]').click(); await page.waitForSelector('h1:has-text("Настройки")'); };
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(path.join(ROOT, 'preview'), { recursive: true }); await page.screenshot({ path: path.join(ROOT, 'preview', name), fullPage: false }); } };

/** Нет горизонтального скролла, кнопки не ниже 44 px. */
async function layoutOk(page, where) {
  const r = await page.evaluate(() => {
    const root = document.querySelector('.col-root');
    const small = [...document.querySelectorAll('.col-root button')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44)
      .map((b) => `${b.textContent.trim().slice(0, 30)}:${Math.round(b.getBoundingClientRect().height)}`);
    const wide = [...document.querySelectorAll('.col-root *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.className).slice(0, 5);
    return { over: document.documentElement.scrollWidth > innerWidth || (root && root.scrollWidth > root.clientWidth), small, wide };
  });
  assert.equal(r.over, false, `${where}: горизонтальный скролл`);
  assert.deepEqual(r.wide, [], `${where}: вылезает за край`);
  assert.deepEqual(r.small.filter((x) => !/^(Графит|Сапфир|Бордо|Петроль)/.test(x)), [], `${where}: кнопки ниже 44 px`);
}

try {
  for (const [i, size] of [[320, 640], [390, 844]].entries()) {
    const S = await boot(PORT + i, cfgOf({ mode: 'test' }));
    const col = S.app.collections;
    const page = await open(S, ivan, size);
    await goSettings(page);
    await page.locator('[data-act="support"]').click();
    assert.equal(await page.evaluate(() => window.__openedTelegram), 'https://t.me/All_InPoker_bot?start=support');
    await shot(page, `support-settings-${size[0]}.png`);
    await page.locator('[data-entry="collections"]').click();
    await page.waitForSelector('.col-show');
    assert.match(await page.locator('.col-show').innerText(), /Тестовая среда · звёзды ненастоящие/);
    await page.locator('.col-card[data-item="graphit-table"]').click();
    await page.waitForSelector('.col-item');
    await page.getByRole('button', { name: 'Примерить' }).click();
    await page.waitForSelector('.col-fit');
    await page.getByRole('button', { name: 'Назад к карточке' }).click();
    await page.waitForSelector('.col-buy');
    const card = await page.locator('.col-buy').innerText();
    assert.ok(!card.includes('Навсегда'), 'обещания «навсегда» в условиях покупки нет');
    for (const want of ['Пока работает приложение', 'не влияет', 'Возврат полностью', '50 ⭐', 'Условия покупки', 'Правила возврата', 'Нажимая «Купить», вы подтверждаете, что прочитали и принимаете Условия покупки версии 1.0.']) assert.ok(card.includes(want), `на карточке до покупки: «${want}»`);
    await layoutOk(page, `${size[0]}: карточка`);
    await shot(page, `pay-card-${size[0]}.png`);
    await page.locator('[data-act="buy"]').scrollIntoViewIfNeeded();
    await shot(page, `pay-terms-${size[0]}.png`);
    step(`${size[0]} px: карточка — состав, цена 50 ⭐, условия и возврат видны до «Купить»`);

    // Купить → окно оплаты. В окне «оплачено», но сервер ещё не подтвердил — вещи нет.
    await page.locator('[data-act="buy"]').click();
    await page.waitForFunction(() => window.__invoices.length === 1);
    const url = await page.evaluate(() => window.__invoices[0].url);
    assert.match(url, /^https:\/\/t\.me\/\$/);
    const order = S.app.store.pay.recentOrders(1)[0];
    assert.equal(order.price, 50);
    await page.evaluate(() => window.__invoices[0].cb('paid'));
    await page.waitForSelector('.col-pay-status.confirming');
    assert.equal(await page.locator('.col-recv').count(), 0, '«Куплено» не показано по одному статусу окна');
    assert.equal(col.owns('101', 'graphit-table'), false);
    await shot(page, `pay-confirming-${size[0]}.png`);
    step(`${size[0]} px: окно сказало «оплачено» — экран «ждём подтверждения», вещи нет`);

    // Telegram: pre_checkout → successful_payment.
    const payload = payloadOf(order);
    const ans = await preCheckout(S.t, ivan, { payload, amount: order.price });
    assert.equal(ans.ok, true);
    await paid(S.t, ivan, { payload, amount: order.price });
    await page.waitForSelector('.col-recv');
    assert.match(await page.locator('.col-title').innerText(), /Куплено/);
    await layoutOk(page, `${size[0]}: куплено`);
    await shot(page, `pay-bought-${size[0]}.png`);
    await page.locator('.col-switch').click();
    await until(() => col.choiceOf('101').table?.item === 'graphit-table', 'надето на сервере');
    step(`${size[0]} px: successful_payment → «Куплено» → надето (выбор на сервере)`);

    // Отмена окна для другой вещи.
    await page.getByRole('button', { name: 'К витрине' }).click();
    await page.locator('.col-card[data-item="graphit-cardback"]').click();
    await page.locator('[data-act="buy"]').click();
    await page.waitForFunction(() => window.__invoices.length === 2);
    await page.evaluate(() => window.__invoices[1].cb('cancelled'));
    await page.waitForSelector('.col-pay-status.cancelled');
    assert.match(await page.locator('.col-pay-status').innerText(), /Звёзды не списаны/);
    assert.equal(col.owns('101', 'graphit-cardback'), false);
    step(`${size[0]} px: отмена окна — «Звёзды не списаны», вещи нет`);

    // Комплект при купленном столе — без кнопки покупки, с объяснением.
    await page.locator('.col-back').click();
    await page.locator('.col-card[data-item="graphit-bundle"]').click();
    await page.waitForSelector('.col-item');
    assert.equal(await page.locator('[data-act="buy"]').count(), 0);
    assert.match(await page.locator('.col-item').innerText(), /не продаётся — купите недостающие/);
    step(`${size[0]} px: комплект при частичном владении не продаётся`);

    // Мои покупки, поддержка, документ.
    await page.locator('.col-back').click();
    await page.locator('[data-act="purchases"]').click();
    await page.waitForSelector('.col-order');
    assert.match(await page.locator('.col-purchases').innerText(), new RegExp(`Заказ ${order.id}`));
    await page.locator('.col-purchases [data-act="support"]').click();
    await page.waitForSelector('.col-purchases [role="status"]');
    assert.match(await page.locator('.col-purchases').innerText(), /в личку/);
    assert.match(S.api.dms('101').at(-1), new RegExp(order.id), 'бот прислал номер заказа в личку');
    await page.evaluate(() => { window.__openedTelegram = null; });
    await page.locator('.col-purchases [data-act="support-chat"]').click();
    assert.equal(await page.evaluate(() => window.__openedTelegram), 'https://t.me/All_InPoker_bot?start=support');
    await layoutOk(page, `${size[0]}: мои покупки`);
    await shot(page, `pay-purchases-${size[0]}.png`);
    await page.locator('[data-doc="terms-of-purchase"]').click();
    await page.waitForSelector('.col-doc-text');
    await layoutOk(page, `${size[0]}: документ`);
    step(`${size[0]} px: «Мои покупки», «Поддержка» (ответ в личку), условия покупки`);
    await page.close();
    await S.web.close();
  }

  // Режим по умолчанию (off): ни входа, ни цен.
  const W = await boot(PORT + 5, null);
  const page = await open(W, ivan, [360, 740]);
  await goSettings(page);
  await wait(400);
  assert.equal(await page.locator('[data-entry="collections"]').count(), 0, 'при закрытых продажах входа нет');
  await page.evaluate(async () => (await import('/net.js')).send({ t: 'pay', op: 'buy', item: 'graphit-table', req: 'off-0000001' }, { lock: false }));
  await wait(300);
  assert.equal(W.api.calls.filter((c) => c.method === 'createInvoiceLink').length, 0, 'счёт не выставлен');
  step('режим off: входа нет, счёт не выставляется');
  await W.web.close();

  assert.deepEqual(problems, [], `ошибки в консоли страниц: ${problems.join('; ')}`);
  console.log('e2e покупок: всё в порядке');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  process.exit(process.exitCode ?? 0);
}
