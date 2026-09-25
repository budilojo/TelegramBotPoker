/**
 * The Mini App played by real browsers: three people open the table from the
 * group card, sit down, and play two hands by TAPPING — the same page, socket,
 * hub and bot that run for real, with Telegram replaced by the test stub and
 * the bot token by a throwaway one.
 *
 *   node tools/e2e.mjs
 *
 * Needs Playwright with Chromium (not a dependency of the project: this is a
 * developer check, `npm test` does not run it). Exits non-zero on the first
 * thing that is wrong.
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
import { stack } from '../bot/harness.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8091);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const CHAT = -100777;

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
const PEOPLE = [ivan, max, dima];
const HOLES = { 101: 'As Kh', 202: 'Qs Qd', 303: '9c 9d' };
const CODES = { 101: ['AS', 'KH'], 202: ['QS', 'QD'], 303: ['9C', '9D'] };

const api = new TelegramStub();
const app = new App({
  api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 300,
  webappUrl: `http://localhost:${PORT}`, miniAppName: 'table',
  deck: stack(HOLES, 'Ts Jh 2c 3d 8s'),
});
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));

const step = (s) => console.log(`· ${s}`);
const room = () => app.room(CHAT);
const chips = () => room().players.reduce((s, p) => s + p.stack + (room().hand?.phase !== 'complete' ? p.committed || 0 : 0), 0);

async function until(cond, what, ms = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/* ------------------------------------------------ the group: /newgame */

await app.handleUpdate(cmdUpdate(CHAT, ivan, '/newgame', { message_id: 1 }));
await app.settle();
const code = room().code;
const card = api.live(CHAT);
assert.equal(card.markup.inline_keyboard[0][0].url, `https://t.me/All_InPoker_bot/table?startapp=${code}`);
step(`карточка в группе: кнопка ведёт в комнату ${code}`);

/* --------------------------------------------- three phones open it */

const sdkStub = (initData) => `
  window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: new URLSearchParams(${JSON.stringify(initData)}).get('start_param') },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(){},
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  } };`;

const browser = await chromium.launch();
const pages = new Map();
const problems = [];
for (const u of PEOPLE) {
  // 360 px: the narrowest phone we promise to fit without sideways scrolling.
  const page = await browser.newPage({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => problems.push(`${u.first_name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${u.first_name}: ${m.text()}`));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: code }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('.lobby');
  pages.set(String(u.id), page);
}
const pageOf = (u) => pages.get(String(u.id));
const actorPage = () => pages.get(room().hand.actorId);
const actorName = () => room().players.find((p) => p.id === room().hand.actorId).name;

async function noSideways(what) {
  for (const [id, page] of pages) {
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(sw <= iw, `${what}: у ${id} страница шире экрана (${sw} > ${iw})`);
  }
}

/** Tap a button on `page` and wait for the server to have moved. */
async function tap(page, name, moved, what) {
  await page.getByRole('button', { name, exact: false }).first().click();
  await until(moved, what);
}

/* ------------------------------------------------------ the lobby */

for (const u of [max, dima]) {
  const n = room().players.length;
  await tap(pageOf(u), 'Сесть за стол', () => room().players.length === n + 1, `${u.first_name} садится`);
}
await pageOf(ivan).waitForSelector('text=3/8');
await noSideways('лобби');
step('Макс и Дима сели — у Ивана «3/8»');

await tap(pageOf(ivan), '▶ Начать', () => room().status === 'playing', 'раздача #1');
for (const page of pages.values()) await page.waitForSelector('.hero-cards img.card');
step('раздача #1 началась у всех');

/* --------------------------------------- each sees their own cards only */

async function assertPrivacy(label, { shown = [] } = {}) {
  for (const u of PEOPLE) {
    const page = pageOf(u);
    const hero = await page.$$eval('.hero-cards img.card', (xs) => xs.map((x) => x.alt));
    assert.deepEqual(hero.sort(), [...CODES[u.id]].sort(), `${label}: ${u.first_name} видит свои карты`);
    const everything = await page.$$eval('img.card', (xs) => xs.map((x) => x.getAttribute('src')));
    for (const other of PEOPLE.filter((o) => o !== u && !shown.includes(o))) {
      for (const c of CODES[other.id]) {
        assert.ok(!everything.some((src) => src.endsWith(`/${c}.svg`)), `${label}: ${u.first_name} видит карту ${c} (${other.first_name})`);
      }
    }
  }
}
await assertPrivacy('префлоп');
step('каждый видит только свои две карты');

/* --------------------------------------------- whose turn is obvious */

async function assertTurn() {
  const actorId = room().hand.actorId;
  for (const [id, page] of pages) {
    // The server has moved; the page follows over the socket a moment later.
    await page
      .waitForFunction((want) => !!document.querySelector('.your-turn') === want, id === actorId, { timeout: 3000 })
      .catch(() => assert.fail(`«ВАШ ХОД» должен быть только у того, чей ход: ${id} ${id === actorId ? 'не видит' : 'видит'}`));
  }
}
await assertTurn();

// Pre-flop, three-handed: the button (Иван) is first. He raises to POT.
assert.equal(actorName(), 'Иван');
await actorPage().getByRole('button', { name: 'RAISE' }).click();
await actorPage().waitForSelector('.sheet');
const potLabel = await actorPage().locator('.size-btn', { hasText: 'POT' }).filter({ hasNotText: '½' }).first().innerText();
const potTotal = Number(potLabel.replace(/\D/g, ''));
await actorPage().locator('.size-btn', { hasText: 'POT' }).filter({ hasNotText: '½' }).first().click();
await until(() => room().hand.currentBet === potTotal, `рейз Ивана до ${potTotal}`);
step(`Иван: RAISE → POT = ${potTotal} (два тапа)`);
await assertTurn();

for (const who of ['Макс', 'Дима']) {
  assert.equal(actorName(), who);
  const n = room().hand.log.length;
  await tap(actorPage(), 'CALL', () => room().hand.log.length > n, `${who} коллирует`);
}
await until(() => room().hand.street === 'flop', 'флоп');
for (const page of pages.values()) await page.waitForFunction(() => document.querySelectorAll('.board img.card').length >= 3);
await assertPrivacy('флоп');
await noSideways('флоп');
step('флоп открыт у всех, чужих карт не видно');

// Nobody bets: the free check never shows FOLD.
while (room().hand.phase === 'betting') {
  await assertTurn();
  const page = actorPage();
  await page.waitForSelector('.panel button:has-text("CHECK")');
  assert.equal(await page.locator('.panel button', { hasText: 'FOLD' }).count(), 0, 'FOLD спрятан, когда чек бесплатный');
  const n = room().hand.log.length;
  await tap(page, 'CHECK', () => room().hand.log.length > n || room().hand.phase !== 'betting', 'чек');
}
await until(() => room().hand.phase === 'complete', 'конец раздачи #1');
for (const page of pages.values()) await page.waitForSelector('.result-line');
const winnerLine = await pageOf(max).locator('.result-line').innerText();
assert.match(winnerLine, /Макс/, `дамы выигрывают: «${winnerLine}»`);
await assertPrivacy('вскрытие', { shown: PEOPLE.filter((u) => room().hand.shown?.[String(u.id)]) });
assert.equal(chips(), 30000);
step(`вскрытие: «${winnerLine.replace(/\n/g, ' / ')}», фишки сошлись`);

/* ------------------------------------ hand 2: fold, and a two-tap all-in */

await tap(pageOf(dima), 'Следующая раздача', () => room().hand?.no === 2 && room().hand.phase === 'betting', 'раздача #2');
for (const page of pages.values()) await page.waitForFunction(() => !document.querySelector('.result-line'));
const shover = actorPage();
const shoverName = actorName();
await shover.getByRole('button', { name: 'RAISE' }).click();
await shover.waitForSelector('.sheet');
const allin = shover.locator('.size-btn', { hasText: 'ALL-IN' });
const before = room().hand.log.length;
await allin.click();
await shover.waitForSelector('.size-btn:has-text("Точно весь стек?")');
assert.equal(room().hand.log.length, before, 'первый тап по ALL-IN ничего не ставит');
await shover.locator('.size-btn', { hasText: 'Точно весь стек?' }).click();
await until(() => room().hand.log.length > before, 'олл-ин');
step(`${shoverName}: ALL-IN — только со второго тапа`);

{
  const n = room().hand.log.length;
  const who = actorName();
  await tap(actorPage(), 'FOLD', () => room().hand.log.length > n, `${who} сбрасывает`);
  step(`${who}: FOLD`);
}
{
  const n = room().hand.log.length;
  const who = actorName();
  await tap(actorPage(), 'CALL', () => room().hand.log.length > n, `${who} коллирует олл-ин`);
  step(`${who}: CALL — олл-ин, борд открывается по улицам`);
}
await until(() => room().hand.phase === 'complete' && !room().ui.reveal, 'пошаговое открытие борда', 8000);
for (const page of pages.values()) await page.waitForSelector('.result-line');
assert.equal(chips(), 30000);
await noSideways('итог раздачи #2');
step('раздача #2 сыграна, фишки сошлись');

assert.deepEqual(problems, [], 'ошибок в консоли страниц нет');
await browser.close();
await web.close();
app.stop?.();
console.log('e2e: всё сошлось');
process.exit(0);
