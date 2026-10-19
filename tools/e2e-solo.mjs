/**
 * Игры с ботами и школа покера настоящим браузером.
 *
 *   node tools/e2e-solo.mjs
 *
 * Человек открывает «Игры с ботами» без группы, проходит азбуку покера и
 * первый урок, нажимая то, что советует наставник; потом садится за дурака
 * с ботами — боты ходят сами, на экране их карт нет; и открывает шахматы с
 * ботом — у дуэли в форме цвет и часы. Telegram — заглушка.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { startServer } from '../bot/server.js';
import { TelegramStub, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8095);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

const ivan = user(101, 'Иван');
const api = new TelegramStub();
const app = new App({ api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${PORT}`, miniAppName: 'table' });
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));

const step = (s) => console.log(`· ${s}`);
const problems = [];

const sdkStub = (initData) => `
  window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: new URLSearchParams(${JSON.stringify(initData)}).get('start_param') },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(){},
    BackButton: { show(){}, hide(){}, onClick(){} },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  } };`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: ivan, start_param: 'solo' }, TOKEN);
await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
await page.goto(`http://localhost:${PORT}/`);

try {
  await page.waitForSelector('h1:has-text("Игры с ботами")');
  step('из лички без групп: экран «Игры с ботами»');

  // Азбука: четыре шага и тест.
  await page.getByRole('button', { name: 'Школа покера' }).click();
  await page.getByRole('button', { name: 'Азбука покера' }).click();
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Дальше →' }).click();
  await page.waitForSelector('.abc-combo >> nth=9');
  step('азбука: цель, ход раздачи, действия, десять комбинаций картинками');
  await page.getByRole('button', { name: 'Проверить себя →' }).click();
  for (const right of ['Флеш', 'Тройка', 'Фулл-хаус']) {
    await page.locator('.abc-option', { hasText: right }).first().click();
    await page.waitForSelector('.abc-option.right');
    await page.getByRole('button', { name: 'Дальше →' }).click();
  }
  await page.waitForSelector('text=Правильных ответов: 3 из 3');
  step('тест «что сильнее?»: три из трёх');

  // Первый урок: жмём то, что советует наставник (кнопка с контуром).
  await page.getByRole('button', { name: '▶ Первый урок' }).click();
  await page.waitForSelector('.coach');
  const room = () => app.soloOf('101');
  for (let i = 0; i < 60; i++) {
    if (await page.locator('.coach.ok, .coach.no').count()) break;
    const advised = page.locator('.panel .btn.advised');
    if (await advised.count()) {
      const isRaise = (await advised.textContent()).match(/Bet|Raise/);
      await advised.click();
      if (isRaise) {
        // Размер — первый из предложенных: нажатие сразу ставит.
        await page.waitForSelector('.sheet .size-btn');
        await page.locator('.sheet .size-btn').first().click();
      }
    }
    await page.waitForTimeout(400);
  }
  await page.waitForSelector('.coach.ok', { timeout: 15000 });
  assert.equal(room().learn.result.ok, true, room().learn.result.text);
  step(`урок «Сильная рука» пройден по подсказкам: ${room().learn.result.text}`);
  const coachCards = room().hand.holes.bot1;
  assert.ok(coachCards.length === 2);
  await page.getByRole('button', { name: 'Дальше →' }).click();
  await page.waitForSelector('text=Урок 2 из 6');
  step('«Дальше →» — урок 2');
  const done = await page.evaluate(() => localStorage.getItem('school.done'));
  assert.equal(done, '[0]', 'телефон запомнил пройденный урок');
  step('пройденный урок отмечен на телефоне');

  // Дурак с ботами: форма, игра идёт сама.
  await page.locator('.icon-btn[aria-label="Меню"]').click();
  await page.getByRole('button', { name: '← Игры с ботами' }).click();
  await page.waitForSelector('h1:has-text("Игры с ботами")');
  await page.getByRole('button', { name: /Дурак/ }).first().click();
  await page.getByRole('button', { name: 'Переводной', exact: true }).click();
  await page.getByRole('button', { name: '▶ Играть' }).click();
  await page.waitForSelector('.dk-hero, .hero');
  const dk = app.soloOf('101');
  assert.equal(dk.game, 'durak');
  assert.equal(dk.settings.variant, 'perevodnoy');
  const before = dk.seq;
  for (let i = 0; i < 40 && dk.seq === before; i++) await page.waitForTimeout(250);
  assert.ok(dk.seq > before || dk.deal.attacker === '101', 'боты ходят сами (или первым ходит человек)');
  // На экране — только свои карты: ни одной карты из руки ботов.
  const shown = await page.evaluate(() => [...document.querySelectorAll('.dk-hero img, .hero img')].map((i) => i.getAttribute('src')));
  for (const id of dk.deal.order.filter((x) => x !== '101')) {
    for (const c of dk.deal.hands[id]) assert.ok(!shown.some((s) => s?.endsWith(`/${c}.svg`)), `карта бота ${c} на экране человека`);
  }
  step('дурак с ботами: переводной, боты ходят сами, их карт на экране нет');

  // Шахматы с ботом: вместо числа соперников — цвет и часы (форма дуэли).
  await page.locator('.icon-btn[aria-label="Меню"]').click();
  await page.getByRole('button', { name: '← Игры с ботами' }).click();
  await page.waitForSelector('h1:has-text("Игры с ботами")');
  await page.getByRole('button', { name: /Шахматы/ }).first().click();
  await page.waitForSelector('.section-label:has-text("Ваш цвет")');
  assert.equal(await page.locator('.section-label:has-text("Соперников")').count(), 0, 'у дуэли нет выбора числа соперников');
  await page.getByRole('button', { name: 'Чёрные', exact: true }).click();
  await page.getByRole('button', { name: '5 мин', exact: true }).click();
  await page.getByRole('button', { name: '▶ Играть' }).click();
  await page.waitForSelector('.ch-board, .board');
  const ch = app.soloOf('101');
  assert.equal(ch.game, 'chess');
  assert.equal(ch.settings.side, 'black');
  assert.equal(ch.settings.base, 300);
  step('шахматы с ботом: форма — цвет и часы, без числа соперников; выбор дошёл до сервера');

  // Шашки с ботом: та же форма дуэли; ход человека — и бот отвечает сам.
  await page.locator('.k-icon-btn[aria-label="Игры с ботами"]').click();
  await page.waitForSelector('h1:has-text("Игры с ботами")');
  await page.getByRole('button', { name: /Шашки/ }).first().click();
  await page.waitForSelector('.section-label:has-text("Ваш цвет")');
  await page.getByRole('button', { name: 'Белые', exact: true }).click();
  await page.getByRole('button', { name: '▶ Играть' }).click();
  await page.waitForSelector('.ck .ch-board');
  const ck = app.soloOf('101');
  assert.equal(ck.game, 'checkers');
  assert.equal(ck.settings.side, 'white');
  await page.locator('.ch-sq[data-sq="c3"]').click();
  await page.locator('.ch-sq[data-sq="d4"]').click();
  for (let i = 0; i < 40 && ck.match.moves.length < 2; i++) await page.waitForTimeout(150);
  assert.equal(ck.match.moves.length, 2, 'бот ответил на ход');
  await page.waitForSelector('.ch-status.mine');
  step(`шашки с ботом: форма дуэли, ход c3-d4 — бот ответил ${ck.match.moves[1].n}`);

  // Нарды с ботом: форма дуэли; жребий решает, кто первый; бот бросает и ходит сам.
  await page.locator('.k-icon-btn[aria-label="Игры с ботами"]').click();
  await page.waitForSelector('h1:has-text("Игры с ботами")');
  await page.getByRole('button', { name: /Нарды/ }).first().click();
  await page.waitForSelector('.section-label:has-text("Ваш цвет")');
  await page.getByRole('button', { name: 'Белые', exact: true }).click();
  await page.getByRole('button', { name: '▶ Играть' }).click();
  await page.waitForSelector('.nd .nd-board');
  const nd = app.soloOf('101');
  assert.equal(nd.game, 'nardy');
  // Если первым ходит бот — дождаться, пока он сходит.
  for (let i = 0; i < 80 && nd.match.turn.c !== 'w'; i++) await page.waitForTimeout(150);
  if (!nd.match.turn.dice) await page.getByRole('button', { name: '🎲 Бросить' }).click();
  for (let i = 0; i < 40 && !nd.match.turn.dice; i++) await page.waitForTimeout(50);
  const myTurns = nd.match.log.length;
  // Сыграть шаги, которые предлагает сервер: шашка с пунктиром → точка с числом.
  for (let k = 0; k < 4; k++) {
    await page.waitForTimeout(200);
    if (await page.locator('.nd-pt.can').count() === 0) break;
    await page.locator('.nd-pt.can').first().click();
    await page.locator('.nd-pt.dot, .nd-off.dot').first().click();
  }
  await page.getByRole('button', { name: 'Готово' }).click();
  for (let i = 0; i < 80 && nd.match.log.length < myTurns + 2; i++) await page.waitForTimeout(150);
  assert.ok(nd.match.log.length >= myTurns + 2, 'после хода человека бот бросил и сыграл свой');
  assert.equal(nd.match.log.at(-1).c, 'b');
  step(`нарды с ботом: ход человека, бот ответил броском ${nd.match.log.filter((x) => x.c === 'b').at(-1).dice.join('-')}`);

  assert.deepEqual(problems, [], `ошибки на странице: ${problems.join('; ')}`);
  console.log('e2e игр с ботами: всё сошлось');
} catch (err) {
  console.error('ПРОВАЛ:', err.message);
  await page.screenshot({ path: path.join(ROOT, 'preview', 'e2e-solo-fail.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  web.server.close();
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
}
