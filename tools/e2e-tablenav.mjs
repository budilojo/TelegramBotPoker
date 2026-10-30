/**
 * Путь целиком по кнопкам и «стол → раздел → тот же стол» — настоящим браузером.
 *
 *   node tools/e2e-tablenav.mjs
 *
 * Группа (карточка бота) → «Выбрать игру» → каталог → «Покер» → «Создать лобби» → гость садится по списку
 * «Присоединиться» → «Начать» → партия. Затем хост уходит из-за стола в хаб («← Все игры группы»), листает
 * «Рейтинг» и «Настройки», а место за столом остаётся его: сверху «Вернуться к столу», раздача, ход и часы
 * те же. Пока он смотрит раздел, стол удаляют (хост — другой человек): «Вернуться» не тупик.
 * Кнопка «Назад» Telegram ведёт из-за стола в хаб. 320 и 390 px.
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8099);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const ivan = user(101, 'Иван');
const max = user(202, 'Макс');
const step = (s) => console.log(`· ${s}`);
const problems = [];

const api = new TelegramStub();
const app = new App({ api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${PORT}`, miniAppName: 'table' });
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));
const until = async (cond, what, ms = 5000) => {
  const t0 = Date.now();
  while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`); await new Promise((r) => setTimeout(r, 25)); }
};
const sdk = (initData) => `
  window.__back = [];
  window.Telegram = { WebApp: { initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: new URLSearchParams(${JSON.stringify(initData)}).get('start_param') },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(){},
    BackButton: { show(){ window.__backShown = true; }, hide(){ window.__backShown = false; }, onClick(f){ window.__backClick = f; } },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} } } };`;
const browser = await chromium.launch();
async function open(u, size, startParam) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => problems.push(`${u.first_name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${u.first_name}: ${m.text()}`));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: startParam }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdk(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  return page;
}
const noSideways = async (page, what) => {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= iw, `${what}: страница шире экрана (${sw} > ${iw})`);
};

try {
  let chat = -100900;
  for (const size of [[320, 640], [390, 844]]) {
    step(`экран ${size[0]} px`);
    chat -= 1;
    await app.handleUpdate({ update_id: Math.random(), message: { message_id: 1, chat: { id: chat, type: 'supergroup', title: 'Друзья' }, from: ivan, text: '/game', date: Math.floor(Date.now() / 1000) } });
    await app.settle();
    const gcode = app.groups.get(String(chat)).code;
    const room = () => app.roomsOf(chat).filter((r) => r.game === 'poker').at(-1);

    // 1. Хаб группы → каталог → покер → создать лобби.
    const host = await open(ivan, size, `g_${gcode}`);
    await host.waitForSelector('.game-card');
    await host.locator('.game-card.g-poker').click();
    await host.waitForSelector('.sheet');
    await host.getByRole('button', { name: 'Создать лобби' }).click();
    await until(() => room(), 'лобби создано');
    await host.waitForSelector('text=Сесть за стол').catch(() => {});
    step('хаб → каталог → «Покер» → «Создать лобби»');

    // 2. Гость заходит из хаба группы по списку «Открытые игры» и садится.
    const guest = await open(max, size, `g_${gcode}`);
    await guest.waitForSelector('.lrow');
    await guest.getByRole('button', { name: 'Присоединиться' }).first().click();
    await guest.getByRole('button', { name: 'Сесть за стол' }).first().click();
    await until(() => room().players.length === 2, 'Макс сел');
    if (!room().players.some((p) => p.id === '101')) await host.getByRole('button', { name: 'Сесть за стол' }).first().click();
    await until(() => room().players.length === 2, 'оба сидят');
    await host.getByRole('button', { name: '▶ Начать' }).first().click();
    await until(() => room().status === 'playing', 'раздача');
    await host.waitForSelector('.hero-cards img.card');
    step('гость присоединился по списку, партия началась');

    // 3. Запоминаем состояние стола.
    const before = { no: room().hand.no, actor: room().hand.actorId, log: room().hand.log.length, status: room().status };
    const mySeat = (r) => r.players.findIndex((p) => p.id === '101');
    const heroBefore = await host.$$eval('.hero-cards img.card', (xs) => xs.map((x) => x.alt));

    // 4. Из-за стола: Telegram «Назад» ведёт в хаб; нижняя панель появляется, место за столом остаётся.
    assert.equal(await host.evaluate(() => window.__backShown), true, 'кнопка «Назад» Telegram показана за столом');
    await host.evaluate(() => window.__backClick());
    await host.waitForSelector('.nav');
    await host.waitForSelector('.back-to-table');
    assert.ok(!room().players[mySeat(room())].left, 'место не освобождено');
    assert.ok(!room().players[mySeat(room())].sittingOut, 'за столом не «пропускает раздачи»');
    step('«Назад» Telegram → хаб; сверху «Вернуться к столу»');

    // 5. Разделы: рейтинг и настройки, «Вернуться к столу» остаётся доступным с «Игр».
    await host.locator('.nav-tab[data-tab="rating"]').click();
    await host.locator('.nav-tab[data-tab="settings"]').click();
    await host.waitForSelector('h1:has-text("Настройки")');
    await noSideways(host, 'настройки');
    await host.locator('.nav-tab[data-tab="games"]').click();
    await host.waitForSelector('.back-to-table');
    const box = await host.locator('.back-to-table').boundingBox();
    assert.ok(box.height >= 44, `кнопка не ниже 44: ${box.height}`);
    await noSideways(host, 'хаб с «Вернуться к столу»');
    assert.deepEqual({ no: room().hand.no, actor: room().hand.actorId, log: room().hand.log.length, status: room().status }, before, 'раздача, ход и журнал не тронуты просмотром');

    // 6. Назад к тому же столу: те же карты, та же раздача.
    await host.locator('.back-to-table').click();
    await host.waitForSelector('.hero-cards img.card');
    assert.deepEqual(await host.$$eval('.hero-cards img.card', (xs) => xs.map((x) => x.alt)), heroBefore, 'те же карты');
    assert.equal(room().hand.no, before.no);
    step('стол → «Рейтинг» → «Настройки» → «Вернуться к столу»: те же карты и та же раздача');

    // 7. Пока человек смотрит раздел, стол удалили (хост — Макс не хост; удаляет Иван сам) — тупика нет.
    await host.evaluate(() => window.__backClick());
    await host.waitForSelector('.back-to-table');
    await app.dropGame(room());
    await host.waitForSelector('.back-to-table', { state: 'detached' });
    await host.waitForSelector('.game-card');
    step('стол удалён, пока смотрели раздел: «Вернуться» исчезла, каталог на месте');
    await host.close();
    await guest.close();
  }
} finally {
  await browser.close();
  web.server.close();
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('навигация «стол → раздел → стол»: ок');
process.exit(0);
