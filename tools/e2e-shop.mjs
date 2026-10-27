/** Вкладка «Магазин»: экран «скоро» и счётчик нажатий на сервере. Telegram — заглушка. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { Store } from '../bot/store.js';
import { startServer } from '../bot/server.js';
import { TelegramStub, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';
import { assertNoJump } from './lib/scroll-probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8113);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const OUT = path.join(ROOT, 'preview/shop');
fs.mkdirSync(OUT, { recursive: true });
const store = new Store();
const app = new App({ api: new TelegramStub(), store, admins: ['9000'], botUsername: 'ShopTestBot', minIntervalMs: 0 });
const hub = new Hub(app, { botToken: TOKEN }); app.attachHub(hub);
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), host: '127.0.0.1', log: () => {} });
await new Promise((r) => web.server.once('listening', r));
const browser = await chromium.launch();
const errors = [];
const tab = (p) => p.locator('.nav-tab[data-tab="shop"]');
const taps = () => store.db.prepare('SELECT COALESCE(SUM(taps), 0) AS n FROM shop_tab').get().n;

async function pageFor(id, width, code = 'solo') {
  const page = await browser.newPage({ viewport: { width, height: width === 320 ? 568 : 844 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const initData = signInitData({ user: user(id, 'Гость'), auth_date: Math.floor(Date.now() / 1000), start_param: code }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.Telegram={WebApp:{initData:${JSON.stringify(initData)},initDataUnsafe:{start_param:${JSON.stringify(code)}},ready(){},expand(){},disableVerticalSwipes(){},onEvent(){},setHeaderColor(){},setBackgroundColor(){},setBottomBarColor(){},BackButton:{show(){},hide(){},onClick(fn){window.telegramBack=fn}},HapticFeedback:{impactOccurred(){},selectionChanged(){},notificationOccurred(){}}}};` }));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  return page;
}


try {
  for (const width of [320, 390]) {
    console.log(`· Вкладка «Магазин» ${width} px`);
    const id = width === 390 ? 9201 : 9200;
    const page = await pageFor(id, width);
    await page.locator('.nav').waitFor();
    assert.equal(await page.locator('.nav-tab').count(), 4);
    assert.deepEqual(await page.locator('.nav-tab .nav-label').allTextContents(), ['Игры', 'Рейтинг', 'Магазин', 'Настройки']);
    const box = await tab(page).boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, `вкладка мала: ${JSON.stringify(box)}`);
    assert.equal(taps(), width === 320 ? 0 : 1, 'до нажатия этот человек не посчитан');
    await tab(page).click();
    await page.getByText('Магазин скоро откроется', { exact: true }).waitFor();
    assert.equal(await tab(page).getAttribute('aria-current'), 'page');
    await page.waitForFunction(() => true);
    for (let i = 0; i < 50 && taps() < (width === 320 ? 1 : 2); i++) await page.waitForTimeout(100);
    // Честность: ни цен, ни кнопок покупки, ни «Хочу».
    const text = await page.locator('#app').innerText();
    assert.ok(!/Stars|₽|\$|Хочу|Купить|Примерить/.test(text), `на экране «скоро» лишнее: ${text}`);
    assert.equal(await page.locator('#app .lobby button, #app .lobby img').count(), 0, 'на экране нет кнопок и картинок');
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.shop-soon, .shop-soon *, .nav, .nav *')].filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); }).length);
    assert.equal(overflow, 0, 'горизонтального выхода за край нет');
    await page.screenshot({ path: path.join(OUT, `soon-${width}.png`) });
    assert.equal(taps(), width === 320 ? 1 : 2, 'ровно одно нажатие записано');
    // Повторное нажатие подряд: и активная вкладка, и частота — счёт не растёт.
    await tab(page).click();
    await page.waitForTimeout(300);
    assert.equal(taps(), width === 320 ? 1 : 2, 'нажатие по уже открытой вкладке не считается');
    // Обновление состояния не выбрасывает с экрана, прокрутка не прыгает.
    await page.setViewportSize({ width, height: 200 });
    await assertNoJump(page, { scroller: '.lobby', label: `«скоро» ${width}` }, async () => {
      await page.evaluate(async () => { const { send } = await import('/net.js'); send({ t: 'refresh' }, { lock: false }); });
      await page.waitForTimeout(400);
    });
    await page.getByText('Магазин скоро откроется', { exact: true }).waitFor();
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
    // Другие вкладки живы; «Игры» возвращает хаб.
    await page.locator('.nav-tab[data-tab="games"]').click();
    assert.equal(await page.getByText('Магазин скоро откроется', { exact: true }).count(), 0);
    // Клавиатура прячет панель вместе с вкладкой.
    await page.evaluate(() => { const i = document.createElement('input'); i.id = 'kb'; document.body.append(i); i.focus(); });
    assert.equal(await tab(page).isVisible(), false, 'при вводе вкладки нет');
    await page.evaluate(() => document.getElementById('kb').remove());
    await page.close();
  }
  // За столом, в лобби и под шторкой панель (а с ней вкладка) скрыта — это проверяет e2e-nav.mjs.
  // Пульт: суммы без имён.
  console.log('· Пульт владельца');
  const owner = await pageFor(9000, 320, 'admin');
  await owner.getByText('Вкладка «Магазин»', { exact: true }).waitFor();
  const adminText = await owner.locator('.admin').innerText();
  assert.ok(/нажали/.test(adminText) && /всего нажатий/.test(adminText));
  assert.ok(!/9200|9201|9202/.test(adminText), 'в пульте нет id людей');
  assert.ok(await owner.evaluate(() => document.querySelector('.admin').scrollWidth <= innerWidth + 1));
  await owner.screenshot({ path: path.join(OUT, 'admin-320.png') });
  await owner.close();
  assert.deepEqual(errors, [], `ошибки в консоли: ${errors.join('; ')}`);
  console.log('Вкладка «Магазин»: всё сошлось');
} finally {
  await browser.close();
  web.server.close();
  store.close();
}
