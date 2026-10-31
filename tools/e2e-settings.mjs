/**
 * Настройки стола во время партии — настоящим браузером (покер, хост и гость).
 *
 *   node tools/e2e-settings.mjs
 *
 * Дефект владельца: «при изменении настроек стола во время игры». Здесь он
 * воспроизводится так: хост открывает «Настройки стола» посреди раздачи, ставит
 * курсор в поле блайнда и печатает; в это время приходит обновление стола
 * (чужой ход, часы). Раньше шторка пересобиралась целиком — поле теряло фокус,
 * клавиатура закрывалась, цифры терялись. Проверяем:
 *   • фокус, набранное и положение курсора переживают обновление стола;
 *   • «Сохранить» меняет блайнды только со следующей раздачи, текущая раздача,
 *     банк, очередь хода не трогаются;
 *   • настройка, ставшая недопустимой, пока форма была открыта (раздача началась,
 *     пока хост сидел между раздачами), не отбрасывает остальное;
 *   • гость настроек не видит; 320 и 390 px; страница не шире экрана.
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
const PORT = Number(process.env.E2E_PORT || 8097);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
let CHAT = -100888;
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}
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
const room = () => app.room(CHAT);
const until = async (cond, what, ms = 4000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const sdkStub = (initData) => `
  window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: new URLSearchParams(${JSON.stringify(initData)}).get('start_param') },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(){},
    BackButton: { show(){}, hide(){}, onClick(){} },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  } };`;

let code;
const browser = await chromium.launch();

async function open(u, size) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => problems.push(`${u.first_name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${u.first_name}: ${m.text()}`));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: code }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('.lobby');
  return page;
}
const noSideways = async (page, what) => {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= iw, `${what}: страница шире экрана (${sw} > ${iw})`);
};

try {
  for (const size of [[320, 568], [390, 800]]) {
    step(`экран ${size[0]} px`);
    CHAT -= 1;
    await app.handleUpdate(cmdUpdate(CHAT, ivan, '/newgame', { message_id: 1 }));
    await app.settle();
    code = room().code;
    const host = await open(ivan, size);
    const guest = await open(max, size);
    if (room().players.length < 2) {
      await guest.getByRole('button', { name: 'Сесть за стол' }).first().click();
      await until(() => room().players.length === 2, 'Макс сел');
    }
    if (room().status === 'lobby') {
      await host.getByRole('button', { name: '▶ Начать' }).first().click();
      await until(() => room().status === 'playing', 'раздача');
    }
    await host.waitForSelector('.hero-cards img.card');

    // Гость в меню настроек стола не видит.
    await guest.getByRole('button', { name: 'Меню' }).click();
    await guest.waitForSelector('.sheet .menu-list');
    assert.equal(await guest.getByText('Настройки стола').count(), 0, 'гость настроек не видит');
    await guest.keyboard.press('Escape');
    await guest.waitForSelector('.sheet', { state: 'detached' });

    // Хост открывает настройки посреди раздачи и начинает печатать в поле малого блайнда.
    await host.getByRole('button', { name: 'Меню' }).click();
    await host.getByText('Настройки стола').click();
    await host.waitForSelector('.sheet input.num');
    await noSideways(host, 'форма настроек');
    const sbBefore = room().settings.smallBlind;
    const handNo = room().hand.no;
    const actor0 = room().hand.actorId;
    const potBefore = room().hand.pots?.reduce?.((a, p) => a + p.amount, 0);
    const field = host.locator('.sheet input.num').nth(1); // малый блайнд (первое — стартовый стек, в раздаче он закрыт)
    await field.click();
    await field.fill('');
    await host.keyboard.type('7');
    // Приходит обновление стола: сервер присылает состояние (так же приходит чужой ход или часы).
    await host.evaluate(async () => { const { send } = await import('/net.js'); send({ t: 'refresh' }, { lock: false }); });
    await guest.evaluate(async () => { const { send } = await import('/net.js'); send({ t: 'refresh' }, { lock: false }); });
    await host.waitForTimeout(300);
    const kept = await host.evaluate(() => ({
      focused: document.activeElement?.tagName === 'INPUT' && document.activeElement.closest('.sheet') ? [...document.querySelectorAll('.sheet input.num')].indexOf(document.activeElement) : -1,
      value: document.activeElement?.value,
    }));
    assert.equal(kept.focused, 1, 'после обновления стола фокус остался в поле малого блайнда');
    assert.equal(kept.value, '7', 'набранное не потерялось');
    await host.keyboard.type('5'); // продолжаем печатать без повторного нажатия на поле: 75
    assert.equal(await host.evaluate(() => document.activeElement.value), '75');
    step('фокус и набранное переживают обновление стола');

    // Малый 75 при большом 50 — ошибка словами, «Сохранить» закрыта, на сервер ничего не ушло.
    assert.ok(await host.locator('.sheet .field-err').innerText().then((t) => /не может быть меньше/.test(t)), 'ошибка объяснена словами');
    assert.equal(await host.getByRole('button', { name: 'Сохранить' }).isDisabled(), true, 'с ошибкой сохранить нельзя');
    const big = host.locator('.sheet input.num').nth(2);
    await big.fill('');
    assert.equal(await host.getByRole('button', { name: 'Сохранить' }).isDisabled(), true, 'пустое поле — тоже нельзя');
    await big.fill('150');
    assert.equal(await host.getByRole('button', { name: 'Сохранить' }).isDisabled(), false, 'исправили — можно');
    await host.getByRole('button', { name: 'Сохранить' }).click();
    await until(() => room().pendingBlinds || room().settings.smallBlind !== sbBefore, 'настройки дошли');
    assert.equal(room().hand.no, handNo, 'текущая раздача та же');
    assert.equal(room().hand.actorId, actor0, 'очередь хода не сдвинулась');
    assert.equal(room().settings.smallBlind, sbBefore, 'блайнды в этой раздаче не менялись');
    assert.ok(room().pendingBlinds, 'блайнды ждут следующей раздачи');
    assert.equal(room().pendingBlinds.sb, 75);
    assert.equal(room().pendingBlinds.bb, 150);
    if (potBefore != null) assert.equal(room().hand.pots.reduce((a, p) => a + p.amount, 0), potBefore, 'банк не тронут');
    step('сохранение: блайнды со следующей раздачи, раздача и ход целы');
    await host.waitForSelector('.sheet', { state: 'detached' });
    await noSideways(host, 'после сохранения');
    await host.close();
    await guest.close();
  }
} finally {
  await browser.close();
  web.server.close();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('настройки стола: ок');
process.exit(0);
