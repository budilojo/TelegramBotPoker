/** Настройки → магазин → карточка → примерочная → «Хочу». Telegram — заглушка. */
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
import { ITEMS } from '../miniapp/cosmetics/catalog.js';

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
app.cosmeticsTesters = new Set(['9100']);
const b = (p, name) => p.getByRole('button', { name, exact: true });

async function pageFor(id, width, code = 'solo') {
  const page = await browser.newPage({ viewport: { width, height: width === 320 ? 568 : 844 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const initData = signInitData({ user: user(id, 'Гость'), auth_date: Math.floor(Date.now() / 1000), start_param: code }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.Telegram={WebApp:{initData:${JSON.stringify(initData)},initDataUnsafe:{start_param:${JSON.stringify(code)}},ready(){},expand(){},disableVerticalSwipes(){},onEvent(){},setHeaderColor(){},setBackgroundColor(){},setBottomBarColor(){},BackButton:{show(){},hide(){},onClick(fn){window.telegramBack=fn}},HapticFeedback:{impactOccurred(){},selectionChanged(){},notificationOccurred(){}}}};` }));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  return page;
}

async function layout(page, label, strict = true) {
  const bad = await page.evaluate((strict) => [...document.querySelectorAll('.shop, .shop *')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width && (r.left < -1 || r.right > innerWidth + 1 || (strict && el.scrollWidth > el.clientWidth + 1));
  }).map((el) => `${el.className} ${el.scrollWidth}/${el.clientWidth} L${Math.round(el.getBoundingClientRect().left)} R${Math.round(el.getBoundingClientRect().right)} W${innerWidth}`), strict);
  assert.deepEqual(bad, [], `${label}: горизонтальный скролл`);
  for (const button of await page.locator('.shop button').all()) {
    const r = await button.boundingBox();
    if (r) assert.ok(r.width >= 44 && r.height >= 44, `${label}: маленькая кнопка ${await button.textContent()}: ${JSON.stringify(r)}`);
  }
}

try {
  for (const width of [320, 390]) {
    console.log(`· Магазин ${width} px`);
    const page = await pageFor(width === 390 ? 391 : 320, width);
    await page.locator('[data-tab="settings"]').click();
    await b(page, 'Магазин').click();
    await page.locator('[data-price="nc-back-1"]').filter({ hasText: 'Stars' }).waitFor();
    assert.equal(await page.locator('[data-price="nc-back-1"]').textContent(), width === 320 ? '50 Stars' : '75 Stars');
    assert.equal(await page.locator('.shop-card').count(), 11);
    await layout(page, 'витрина');
    await page.screenshot({ path: path.join(OUT, `shop-${width}.png`) });
    await page.locator('[data-item="nc-back-1"]').click();
    await layout(page, 'карточка');
    await page.screenshot({ path: path.join(OUT, `item-${width}.png`) });
    // Примерочная M: вещь применяется, стол-образец виден, «Снять всё» возвращает как было.
    await b(page, 'Примерить').click();
    await page.locator('.shop-fitting .cos-fit').waitFor();
    await page.locator('.shop-fitting-host img').first().waitFor();
    assert.equal(await page.locator('.shop-fitting-host [data-fit-me]').count(), 1, 'в примерочной есть ваш круг');
    assert.ok((await page.locator('.shop-fitting-host .cf-mini img').first().getAttribute('src')).includes('placeholder/back-1.svg'), 'рубашка применена');
    await layout(page, 'примерочная', false); // 2 px тесноты в карточке «Вы» на 320 px — файл M, см. отчёт
    await page.screenshot({ path: path.join(OUT, `fitting-${width}.png`) });
    await page.screenshot({ path: path.join(OUT, `fitting-${width}.png`) });
    await page.evaluate(() => window.telegramBack());
    await page.locator('[data-try="nc-back-1"]').waitFor();
    assert.equal(await page.locator('.shop-fitting').count(), 0, '«Назад» закрыла примерочную, а не магазин');
    await page.evaluate(async () => (await import('/cosmetics/look.js')).clearLook());
    // Сжимаем окно: карточка обязана действительно прокручиваться при замере.
    await page.setViewportSize({ width, height: 420 });
    await assertNoJump(page, { scroller: '.shop', target: b(page, 'Хочу'), label: `«Хочу» ${width}` }, async () => {
      await b(page, 'Хочу').click(); await b(page, 'Вы хотите ✓').waitFor();
    });
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
    await b(page, 'Вы хотите ✓').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, `wanted-${width}.png`) });
    await b(page, '← Магазин').click();
    assert.equal(await page.locator('[data-want="nc-back-1"]').textContent(), 'Вы хотите ✓');
    const want = page.locator('[data-want="nc-frame-2"]');
    await assertNoJump(page, { scroller: '.shop', target: want, label: `список ${width}` }, async () => {
      await want.click(); await page.waitForFunction(() => document.querySelector('[data-want="nc-frame-2"]').disabled);
    });
    await page.evaluate(async () => { const { send } = await import('/net.js'); send({ t: 'refresh' }, { lock: false }); });
    assert.equal(await page.locator('.shop-card').count(), 11, 'обновление не теряет магазин');
    await page.reload();
    await page.locator('[data-tab="settings"]').click(); await b(page, 'Магазин').click();
    await page.waitForFunction(() => document.querySelector('[data-want="nc-back-1"]')?.textContent === 'Вы хотите ✓');
    await b(page, 'Сбросить мои отметки').click(); await b(page, 'Отмена').click();
    assert.equal(await page.locator('[data-want="nc-back-1"]').textContent(), 'Вы хотите ✓');
    await b(page, 'Сбросить мои отметки').click(); await page.evaluate(() => window.telegramBack());
    assert.equal(await page.locator('.sheet').count(), 0);
    assert.equal(await page.locator('.shop-card').count(), 11, '«Назад» закрыла только подтверждение');
    await b(page, 'Сбросить мои отметки').click(); await b(page, 'Сбросить').click();
    await page.waitForFunction(() => document.querySelector('[data-want="nc-back-1"]').textContent === 'Хочу');
    // Звание и набор — самостоятельные карточки, без битых картинок.
    for (const id of ['nc-title-1', 'nc-bundle']) {
      await page.locator(`[data-item="${id}"]`).click(); await layout(page, id);
      await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
      await page.screenshot({ path: path.join(OUT, `${id}-${width}.png`) });
      await b(page, '← Магазин').click();
    }
    await b(page, '← Настройки').click(); await b(page, 'Посмотреть косметику').click();
    await page.locator('.shop-card').first().waitFor();
    await page.evaluate(() => window.telegramBack());
    await b(page, 'Посмотреть косметику').waitFor();
    await page.close();
  }
  // Администратор и тестер: вещи открыты, «Надеть» вместо «Хочу», вид действует в играх с ботами.
  for (const id of [9000, 9100]) {
    console.log(`· Разблокировано для ${id === 9000 ? 'администратора' : 'тестера'}`);
    const page = await pageFor(id, 390);
    await page.locator('[data-tab="settings"]').click();
    await b(page, 'Магазин').click();
    await page.locator('[data-wear="nc-back-1"]').waitFor();
    assert.equal(await page.locator('[data-want]').count(), 0, 'кнопки «Хочу» нет');
    assert.equal(await page.locator('[data-price="nc-back-1"]').textContent(), 'Открыто для вас');
    for (const want of ['nc-back-1', 'nc-felt-1', 'nc-frame-1', 'nc-title-1']) {
      await page.locator(`[data-wear="${want}"]`).click();
      await page.waitForFunction((x) => document.querySelector(`[data-wear="${x}"]`).textContent === 'Снять', want);
    }
    await layout(page, 'витрина разблокированного');
    await page.locator('[data-item="nc-back-2"]').click();
    await page.locator('[data-wear="nc-back-2"]').waitFor();
    assert.equal(await page.locator('[data-want]').count(), 0);
    await b(page, '← Магазин').click();
    await page.locator('[data-wear="nc-back-1"]').click();
    await page.waitForFunction(() => document.querySelector('[data-wear="nc-back-1"]').textContent === 'Надеть');
    await page.locator('[data-wear="nc-back-1"]').click();
    await page.reload();
    await page.waitForSelector('h1:has-text("Игры с ботами")');
    await page.locator('.game-card.g-poker').click();
    await page.getByRole('button', { name: '▶ Играть' }).click();
    await page.waitForSelector('.hero-cards img.card');
    await page.waitForSelector('.hero .hero-av .cos-frame');
    assert.ok((await page.locator('.seat .minis img.card').evaluateAll((l) => l.map((e) => e.getAttribute('src')))).every((x) => x.includes('placeholder/back-1.svg')), 'покер с ботами: рубашка');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.cosFelt), 'nc-felt-1', 'покер с ботами: сукно');
    assert.equal((await page.locator('.hero .cos-title').textContent()).trim(), 'Крупье');
    await page.screenshot({ path: path.join(OUT, `poker-bots-${id}.png`) });
    await page.reload();
    await page.waitForSelector('h1:has-text("Игры с ботами")');
    await page.getByRole('button', { name: /Дурак/ }).first().click();
    await page.getByRole('button', { name: '▶ Играть' }).click();
    await page.waitForSelector('.dk-hero, .hero');
    assert.ok(await page.locator('img[src*="placeholder/back-1.svg"]').count() > 0, 'дурак с ботами: рубашка');
    await page.close();
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM shop_interest WHERE user_id = ?').get(String(id)).n, 0, 'у открытых вещей спрос не копится');
  }
  const owner = await pageFor(9000, 320, 'admin');
  await owner.getByText('Магазин: спрос', { exact: true }).waitFor();
  assert.equal(await owner.locator('.shop-demand-row').count(), ITEMS.length * 2);
  await owner.evaluate(() => {
    const box = document.querySelector('.admin'), report = document.querySelector('.shop-report');
    box.scrollTop += report.getBoundingClientRect().top - box.getBoundingClientRect().top;
  });
  assert.ok(await owner.evaluate(() => document.querySelector('.shop-report').getBoundingClientRect().right <= innerWidth));
  await owner.screenshot({ path: path.join(OUT, 'demand-320.png') });
  await owner.close();
  assert.deepEqual(errors, [], 'ошибки браузера');
  console.log('Магазин: всё сошлось (320/390 px).');
} finally {
  await browser.close();
  for (const ws of web.wss.clients) ws.terminate();
  await new Promise((r) => web.server.close(r));
  web.wss.close(); app.stop(); store.close();
}
