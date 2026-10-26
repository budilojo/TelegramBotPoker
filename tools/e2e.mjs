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
import { cardsInPlace, resizeMidAnimation } from './cards-in-place.mjs';

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
    // На столе не бывает слов «null» и «undefined» (append(null) печатает их буквами).
    const text = await page.evaluate(() => document.body.innerText);
    assert.ok(!/\bnull\b|\bundefined\b/.test(text), `${label}: ${u.first_name} видит на экране служебное слово: «${text.match(/\bnull\b|\bundefined\b/)?.[0]}»`);
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
// До первых действий под бордом — «BB 50» (блайнд), а не «Bet 50»; после рейза — «Raise N».
for (const [id, page] of pages) {
  await page.waitForFunction(() => /^BB \d/.test(document.querySelector('.bet-line')?.textContent || ''), null, { timeout: 3000 })
    .catch(() => assert.fail(`до первых действий подпись под бордом должна быть «BB N» (у ${id})`));
}
await actorPage().getByRole('button', { name: 'Raise' }).click();
await actorPage().waitForSelector('.sheet');
const potBtn = () => actorPage().locator('.size-btn', { hasText: 'Pot' }).filter({ hasNotText: '½' }).filter({ hasNotText: '¾' }).first();
const potLabel = await potBtn().innerText();
const potTotal = Number(potLabel.replace(/\D/g, ''));
await potBtn().click();
await until(() => room().hand.currentBet === potTotal, `рейз Ивана до ${potTotal}`);
for (const [id, page] of pages) {
  await page.waitForFunction(() => /^Raise \d/.test(document.querySelector('.bet-line')?.textContent || ''), null, { timeout: 3000 })
    .catch(() => assert.fail(`после рейза под бордом должно быть «Raise N» (у ${id})`));
}
// Суммы — по сетке малого блайнда (25): ни одной «кривой».
const sbNow = room().settings.smallBlind;
for (const t of await actorPage().locator('.size-btn .num').allInnerTexts()) {
  const v = Number(t.replace(/\D/g, ''));
  assert.ok(v % sbNow === 0 || v === room().players.find((p) => p.id === room().hand.actorId).stack + room().hand.currentBet, `сумма ${t} не по сетке ${sbNow}`);
}
step(`Иван: Raise → Pot = ${potTotal} (два тапа)`);
await assertTurn();

for (const who of ['Макс', 'Дима']) {
  assert.equal(actorName(), who);
  const n = room().hand.log.length;
  await tap(actorPage(), 'Call', () => room().hand.log.length > n, `${who} коллирует`);
}
await until(() => room().hand.street === 'flop', 'флоп');
for (const page of pages.values()) await page.waitForFunction(() => document.querySelectorAll('.board img.card').length >= 3);
await assertPrivacy('флоп');
await noSideways('флоп');
step('флоп открыт у всех, чужих карт не видно');

// Nobody bets: Check is free — and Fold is still there, behind a second tap.
let foldChecked = false;
while (room().hand.phase === 'betting') {
  await assertTurn();
  const page = actorPage();
  await page.waitForSelector('.panel button:has-text("Check")');
  assert.equal(await page.locator('.panel button', { hasText: /^Fold/ }).count(), 1, 'Fold есть и при бесплатном Check');
  if (!foldChecked) {
    foldChecked = true;
    const folds = room().hand.log.length;
    await page.locator('.panel button', { hasText: /^Fold/ }).click();
    await page.waitForSelector('.panel button:has-text("Fold anyway?")');
    assert.equal(room().hand.log.length, folds, 'первый тап по Fold при бесплатном Check ничего не сбрасывает');
    step('Fold при бесплатном Check: первый тап предупреждает («Fold anyway?»), рука на месте');
  }
  const n = room().hand.log.length;
  await page.locator('.panel button', { hasText: /^Check$/ }).click(); // не по подстроке: у армированного Fold в подписи тоже есть «Check»
  await until(() => room().hand.log.length > n || room().hand.phase !== 'betting', 'чек');
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
await shover.getByRole('button', { name: 'Raise' }).click();
await shover.waitForSelector('.sheet');

// Кнопки «+» и «−»: тап — один шаг по сетке, удержание — повтор до упора, отпускание — стоп.
{
  const input = shover.locator('.amount-input');
  const amount = async () => Number((await input.inputValue()).replace(/\D/g, ''));
  const plus = shover.getByRole('button', { name: 'Больше' });
  const minus = shover.getByRole('button', { name: 'Меньше' });
  const sb = room().settings.smallBlind;
  const confirmText = () => shover.locator('.sheet-confirm .btn').innerText();
  const a0 = await amount();
  await plus.click();
  const a1 = await amount();
  assert.ok(a1 > a0 && a1 - a0 <= sb, `тап по «+» — ровно один шаг (было ${a0}, стало ${a1})`);
  await shover.waitForTimeout(700);
  assert.equal(await amount(), a1, 'после тапа повтора нет');
  // Мышь: держим — идёт повтор; отпустили — стоп.
  const box = await plus.boundingBox();
  await shover.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await shover.mouse.down();
  await shover.waitForTimeout(1600);
  const held = await amount();
  await shover.mouse.up();
  const stopped = await amount();
  await shover.waitForTimeout(500);
  assert.ok(held - a1 >= 4 * sb, `удержание «+» мышью повторяет шаг (${a1} → ${held})`);
  assert.equal(await amount(), stopped, 'после отпускания мыши повтор стоит');
  // Палец: те же события, что шлёт телефон (pointerType touch).
  const touch = { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, bubbles: true };
  const before = await amount();
  await minus.dispatchEvent('pointerdown', touch);
  await shover.waitForTimeout(1500);
  const down = await amount();
  await minus.dispatchEvent('pointerup', touch);
  await shover.waitForTimeout(500);
  const afterUp = await amount();
  await shover.waitForTimeout(500);
  assert.ok(before - down >= 4 * sb, `удержание «−» пальцем повторяет шаг (${before} → ${down})`);
  assert.equal(await amount(), afterUp, 'после отпускания пальца повтор стоит');
  await minus.dispatchEvent('pointerdown', touch);
  await shover.waitForTimeout(900);
  await minus.dispatchEvent('pointercancel', touch);
  const cancelled = await amount();
  await shover.waitForTimeout(500);
  assert.equal(await amount(), cancelled, 'сорванное нажатие (pointercancel) тоже останавливает повтор');
  // До упора: держим «+», пока не дойдёт до всего стека, и повтор сам кончается.
  await plus.dispatchEvent('pointerdown', { ...touch, pointerId: 8 });
  await shover.waitForFunction(() => /^All-in/.test(document.querySelector('.sheet-confirm .btn')?.textContent || ''), null, { timeout: 15000 });
  const top = await amount();
  await shover.waitForTimeout(600);
  assert.equal(await amount(), top, 'на максимуме повтор остановился сам');
  await plus.dispatchEvent('pointerup', { ...touch, pointerId: 8 });
  assert.match(await confirmText(), /^All-in/);
  step(`«+» и «−»: тап — один шаг, удержание — повтор (мышь и палец), стоп при отпускании, срыве и упоре в стек (${top})`);
}
const allin = shover.locator('.size-btn', { hasText: 'All-in' });
const before = room().hand.log.length;
await allin.click();
await shover.waitForSelector('.size-btn:has-text("sure?")');
assert.equal(room().hand.log.length, before, 'первый тап по «All-in» ничего не ставит');
await shover.locator('.size-btn', { hasText: 'sure?' }).click();
await until(() => room().hand.log.length > before, 'олл-ин');
step(`${shoverName}: All-in — только со второго тапа`);

{
  const n = room().hand.log.length;
  const who = actorName();
  await tap(actorPage(), 'Fold', () => room().hand.log.length > n, `${who} сбрасывает`);
  step(`${who}: Fold`);
}
{
  const n = room().hand.log.length;
  const who = actorName();
  await tap(actorPage(), 'Call', () => room().hand.log.length > n, `${who} коллирует олл-ин`);
  step(`${who}: CALL — олл-ин, борд открывается по улицам`);
}
await until(() => room().hand.phase === 'complete' && !room().ui.reveal, 'пошаговое открытие борда', 8000);
for (const page of pages.values()) await page.waitForSelector('.result-line');
assert.equal(chips(), 30000);
await noSideways('итог раздачи #2');
step('раздача #2 сыграна, фишки сошлись');

for (const [id, page] of pages) await cardsInPlace(page, `итог раздачи #2 у ${id}`);
step('после анимаций все карты на месте у всех троих');

/* ------------------- один на один: карты на столе не «отдаляются» */

// Владелец (iPhone): «в какой-то момент карты на столе отдаляются, и их
// становится не видно». Причина: на вскрытии карты соперника напротив
// упирались в верхний край стола, раскладка решала «не влезает совсем» и
// сжимала стол и общие карты до самых мелких. Один на один соперник всегда
// напротив — проверяем вскрытие вдвоём, на iPhone и на самом узком экране,
// с изменением размера окна посреди раздачи.
const CHAT2 = -100779;
const room2 = () => app.room(CHAT2);
await app.handleUpdate(cmdUpdate(CHAT2, ivan, '/newgame', { message_id: 1 }));
await app.settle();
const code2 = room2().code;
const duo = new Map();
for (const [u, vp] of [[ivan, { width: 390, height: 844 }], [max, { width: 320, height: 568 }]]) {
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 3 });
  page.on('pageerror', (e) => problems.push(`${u.first_name} (вдвоём): ${e.message}`));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: code2 }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('.lobby');
  duo.set(String(u.id), page);
}
await tap(duo.get('202'), 'Сесть за стол', () => room2().players.length === 2, 'Макс садится (вдвоём)');
await tap(duo.get('101'), '▶ Начать', () => room2().status === 'playing', 'раздача вдвоём');
// Окно меняется, пока карты ещё летят из середины стола.
await Promise.all([...duo.values()].map((page) => page.waitForSelector('.hero-cards img.card')));
await Promise.all([...duo.values()].map((page) => resizeMidAnimation(page, [375, 600])));
for (const [id, page] of duo) await cardsInPlace(page, `вдвоём, префлоп у ${id}`);

const river = new Map();
while (room2().hand.phase === 'betting') {
  const page = duo.get(room2().hand.actorId);
  const n = room2().hand.log.length;
  if (room2().hand.street === 'river' && !river.size) {
    for (const [id, p] of duo) river.set(id, await cardsInPlace(p, `вдвоём, ривер у ${id}`));
  }
  await page.locator('.panel button', { hasText: /^(Check|Call)/ }).first().click();
  await until(() => room2().hand.log.length > n || room2().hand.phase !== 'betting', 'чек или колл вдвоём');
}
await until(() => room2().hand.phase === 'complete' && !room2().ui.reveal, 'вскрытие вдвоём', 8000);
for (const [id, page] of duo) {
  await page.waitForSelector('.result-line');
  // Соперник показал карты — они лежат на его месте наверху стола.
  const other = id === '101' ? '202' : '101';
  if (room2().hand.shown?.[other]) await page.waitForSelector('.minis.shown img.card');
  const end = await cardsInPlace(page, `вдвоём, вскрытие у ${id}`);
  const before = river.get(id);
  assert.ok(end.boardW >= before.boardW * 0.9,
    `вдвоём у ${id}: на вскрытии общие карты сжались — ${end.boardW} px, на ривере были ${before.boardW} px (масштаб ${before.u} → ${end.u})`);
}
assert.ok(Object.keys(room2().hand.shown || {}).length > 0, 'вдвоём: хотя бы один показал карты — иначе проверка вскрытия пустая');
step(`вдвоём (390×844 и 320×568, окно менялось посреди раздачи): на вскрытии общие карты не сжимаются, все карты на месте`);

assert.deepEqual(problems, [], 'ошибок в консоли страниц нет');
await browser.close();
await web.close();
app.stop?.();
console.log('e2e: всё сошлось');
process.exit(0);
