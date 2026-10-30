/**
 * Сквозной сценарий коллекции «Графит» на НАСТОЯЩЕМ сервере (без заглушки ответов `col`) — lead-integration.
 *
 *   node tools/e2e-collections-flow.mjs
 *
 * Демо включена: «Настройки» → «Коллекции» → витрина → карточка рубашки → «Бордо» → «Примерить» (есть «Так видят друзья»)
 * → «Получить для демонстрации» → «Получено» → переключатель → инвентарь → на сервере выбор записан →
 * в начатой раздаче у друга вид прежний → следующая раздача: «Бордо» на закрытых картах Ивана →
 * «Вернуть базовое» → выбор на сервере пуст. Затем рабочий режим: входа нет, `grant` отклонён (COL_DEMO_OFF),
 * вкладка «Магазин» — «скоро».
 */
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { Store } from '../bot/store.js';
import { startServer } from '../bot/server.js';
import { TelegramStub, cmdUpdate, dmUpdate, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8097);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ivan = user(101, 'Иван');
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

async function boot(port, demo) {
  const api = new TelegramStub();
  const app = new App({ api, store: new Store(':memory:'), botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${port}`, miniAppName: 'table', collectionsDemo: demo });
  const hub = new Hub(app, { botToken: TOKEN });
  app.attachHub(hub);
  const web = startServer({ hub, port, root: path.join(ROOT, 'miniapp'), log: () => {} });
  await new Promise((r) => web.server.once('listening', r));
  api.dmOpen.add('101');
  await app.handleUpdate(dmUpdate(ivan, '/start'));
  return { app, web, port };
}

const sdk = (initData) => `
  window.Telegram = { WebApp: { initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: new URLSearchParams(${JSON.stringify(initData)}).get('start_param') },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(){}, BackButton: { show(){}, hide(){}, onClick(){} },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} } } };
  (() => { const N = window.WebSocket; window.__log = [];
    window.WebSocket = class extends N { constructor(...a) { super(...a); this.addEventListener('message', (e) => window.__log.push(String(e.data))); } }; })();`;

const browser = await chromium.launch();
const problems = [];
async function open(s, u, { size = [360, 740], startParam = '' } = {}) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(m.text()));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: startParam }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdk(initData) }));
  await page.goto(`http://localhost:${s.port}/`);
  if (!startParam) await page.waitForSelector('.nav-tab[data-tab="settings"]');
  return page;
}
const text = (page, sel) => page.locator(sel).innerText();
const goSettings = async (page) => { await page.locator('.nav-tab[data-tab="settings"]').click(); await page.waitForSelector('h1:has-text("Настройки")'); };

try {
  /* ================= демо включена, настоящий сервер ================= */
  for (const [i, size] of [[320, 640], [390, 844]].entries()) {
    const S = await boot(PORT + 2 + i, true); // свой сервер на каждую ширину: чистая база
    const col = S.app.collections;
    const page = await open(S, ivan, { size });
    await goSettings(page);
    if (process.env.SHOTS === '1') {
      await page.locator('[data-entry="collections"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(ROOT, 'preview', `flow-settings-${size[0]}.png`) });
    }
    // Вкладка «Магазин» при готовом магазине ведёт в витрину, а не на «скоро» поверх неё.
    await page.locator('.nav-tab[data-tab="games"]').click();
    await page.locator('.nav-tab[data-tab="shop"]').click();
    await page.waitForSelector('.col-show');
    assert.equal(await page.locator('.shop-soon').count(), 0, 'экрана «скоро» нет поверх готового магазина');
    await page.getByRole('button', { name: 'Назад' }).click();
    await page.waitForSelector('.nav-tab[data-tab="settings"]');
    await goSettings(page);
    await page.locator('[data-entry="collections"]').click();
    await page.waitForSelector('.col-show');
    await page.locator('.col-card[data-item="graphit-cardback"]').click();
    await page.waitForSelector('.col-item');
    await page.locator('.col-sw[data-color="bordeaux"]').click();
    await page.getByRole('button', { name: 'Примерить' }).click();
    await page.waitForSelector('.col-fit');
    assert.equal(await page.getByText('Так видят друзья').count(), 1, 'в примерке есть «Так видят друзья»');
    assert.equal(col.owns('101', 'graphit-cardback'), false, 'примерка ничего не выдала');
    await page.getByRole('button', { name: 'Назад к карточке' }).click();
    await page.getByRole('button', { name: 'Получить для демонстрации' }).click();
    await page.waitForSelector('.col-recv');
    assert.equal(col.owns('101', 'graphit-cardback'), true, 'после ответа сервера предмет у Ивана');
    assert.equal(col.choiceOf('101').cardback, null, 'само получение выбор не меняет');
    await page.locator('.col-switch').click();
    await page.waitForFunction(() => document.querySelector('.col-switch')?.getAttribute('aria-checked') === 'true');
    await page.getByRole('button', { name: 'Перейти в инвентарь' }).click();
    await page.waitForSelector('.col-inventory');
    await until(() => col.choiceOf('101').cardback?.item === 'graphit-cardback', 'выбор записан на сервере');
    step(`${size[0]} px: витрина → карточка → примерка → получение → инвентарь → применено на сервере (цвет: ${col.choiceOf('101').cardback.color})`);
    if (size[0] === 390) {
      // вид за столом: Иван применил рубашку, Макс увидит её на СЛЕДУЮЩЕЙ раздаче
      await S.app.handleUpdate(cmdUpdate(-100771, ivan, '/newgame', { message_id: 1 }));
      await S.app.settle();
      const room = () => S.app.room(-100771);
      const code = room().code;
      const pi = await open(S, ivan, { startParam: code });
      const pm = await open(S, max, { startParam: code });
      await pi.waitForSelector('.lobby'); await pm.waitForSelector('.lobby');
      await pm.getByRole('button', { name: 'Сесть за стол' }).click();
      await until(() => room().players.length === 2, 'Макс сел');
      await pi.getByRole('button', { name: '▶ Начать' }).click();
      await until(() => room().status === 'playing', 'раздача 1');
      await pm.waitForSelector('.hero-cards img.card');
      const backsOfIvan = () => pm.evaluate((id) => {
        const s = [...document.querySelectorAll('.seat')].find((x) => x.dataset.seat === String(id));
        return s ? [...s.querySelectorAll('.minis img')].map((i) => i.dataset.grBack || 'base') : null;
      }, room().players.findIndex((p) => p.id === '101'));
      const first = await backsOfIvan();
      assert.ok(first && first.length === 2 && first.every((b) => b === 'bordeaux'), `у Макса закрытые карты Ивана «Бордо»: ${first}`);
      const mine = await pm.$$eval('.hero-cards img.card', (xs) => xs.map((x) => x.classList.contains('gr-back')));
      assert.ok(mine.every((b) => !b), 'лица своих карт у Макса не заменены');
      step('в раздаче у Макса закрытые карты Ивана — «Бордо», свои карты — лица');
      // возврат к базе посреди раздачи: на сервере выбор пуст, а текущий вид у Макса прежний
      await pi.close();
      await col.handle({ id: '101' }, { t: 'col', op: 'clear', slot: 'cardback', req: 'flow-000002' });
      await until(() => col.choiceOf('101').cardback === null, 'выбор сброшен на сервере');
      await wait(300);
      const still = await backsOfIvan();
      assert.deepEqual(still, first, 'выбор изменён посреди раздачи — вид прежний');
      step('возврат к базе посреди раздачи не меняет текущий вид');
      await pm.close();
    }
    await page.close();
    await S.web.close();
  }

  /* ================= рабочий режим: демо выключена ================= */
  const W = await boot(PORT + 1, false);
  const page = await open(W, ivan);
  await goSettings(page);
  await wait(400);
  assert.equal(await page.locator('[data-entry="collections"]').count(), 0, 'входа в коллекции нет');
  await page.evaluate(async () => (await import('/net.js')).send({ t: 'col', op: 'grant', item: 'graphit-cardback', req: 'off-0000001' }, { lock: false }));
  await wait(400);
  const log = await page.evaluate(() => window.__log.filter((x) => /"t":"col"/.test(x)));
  assert.ok(log.some((x) => /COL_DEMO_OFF/.test(x)), `grant отклонён кодом COL_DEMO_OFF: ${log.join(' | ').slice(0, 300)}`);
  assert.equal(W.app.collections.owns('101', 'graphit-cardback'), false, 'ничего не выдано');
  await page.locator('.nav-tab[data-tab="shop"]').click();
  await page.waitForSelector('.shop-soon');
  assert.match(await text(page, '.shop-soon'), /скоро откроется/);
  await until(() => W.app.store.shopTabTotals(Date.now()).taps >= 1, 'счётчик нажатий вкладки «Магазин» работает');
  step('рабочий режим: входа нет, grant отклонён (COL_DEMO_OFF), «Магазин» — «скоро», счётчик считает');
  await W.web.close();

  assert.deepEqual(problems, [], `ошибки в консоли страниц: ${problems.join('; ')}`);
  console.log('e2e сквозного сценария коллекции: всё в порядке');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  process.exit(process.exitCode ?? 0);
}
