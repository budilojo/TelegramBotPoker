/**
 * Курс «Обучение»: Покер → Обучение, урок, схема, интерактивный пример, «проверьте себя»,
 * отметка «прочитано»; 320 и 390 px; без горизонтальной прокрутки; без ошибок в консоли;
 * ползунок не сдвигает прокрутку.
 *
 *   node tools/e2e-learn.mjs
 *
 * Telegram — заглушка; это Chromium, а не телефон.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { startServer } from '../bot/server.js';
import { TelegramStub, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';
import { Store } from '../bot/store.js';
import { hints } from '../bot/hints.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8097);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}
const SHOTS = path.join(ROOT, 'preview');
fs.mkdirSync(SHOTS, { recursive: true });

const ivan = user(101, 'Иван');
const api = new TelegramStub();
const app = new App({ api, store: new Store(':memory:'), botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${PORT}`, miniAppName: 'table' });
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

async function run(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: ivan, start_param: 'solo' }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('h1:has-text("Игры с ботами")');
  const fits = async (what) => {
    const bad = await page.evaluate(() => {
      const out = []; const doc = document.documentElement;
      if (doc.scrollWidth > doc.clientWidth) out.push(`страница шире экрана: ${doc.scrollWidth} > ${doc.clientWidth}`);
      for (const b of document.querySelectorAll('.learn button')) {
        const r = b.getBoundingClientRect();
        if (r.width && r.height < 43.5) out.push(`кнопка «${b.textContent.trim().slice(0, 24)}» высотой ${r.height}`);
        if (r.right > doc.clientWidth + 0.5 || r.left < -0.5) out.push(`кнопка «${b.textContent.trim().slice(0, 24)}» за краем`);
      }
      return out;
    });
    assert.deepEqual(bad, [], `${what}: ${bad.join('; ')}`);
  };
  await page.locator('.game-card.g-poker').click();
  await page.waitForSelector('.sheet .seg.solo-mode');
  await page.locator('.sheet .seg.solo-mode button', { hasText: 'Обучение' }).click();
  await page.waitForSelector('.learn h1:has-text("Обучение")');
  assert.equal(await page.locator('.sheet').count(), 0, 'шторка закрыта');
  assert.equal(await page.locator('.learn .ln-section').count() >= 6, true, 'шесть разделов + практика');
  assert.equal(await page.locator('.learn .ln-lesson-item').count(), 29, '29 уроков');
  await fits(`курс, ${width} px`);
  await page.screenshot({ path: path.join(SHOTS, `learn-home-${width}.png`) });
  step(`${width} px: Покер → Обучение — 6 разделов, 29 уроков, без горизонтальной прокрутки`);

  // Урок про улицы: интерактив меняет только свои узлы.
  await page.locator('.ln-lesson-item', { hasText: 'Правила и ход раздачи' }).click();
  await page.waitForSelector('.ln-lesson h1:has-text("Правила и ход раздачи")'); 
  const board = () => page.locator('.ln-board img.card').count();
  assert.equal(await board(), 0);
  await page.getByRole('button', { name: 'Дальше →' }).first().click();
  assert.equal(await board(), 3, 'флоп — три карты');
  await page.getByRole('button', { name: 'Дальше →' }).first().click();
  await page.getByRole('button', { name: 'Дальше →' }).first().click();
  assert.equal(await board(), 5, 'ривер — пять карт');
  // «Проверьте себя»: неверный ответ подсвечен, верный показан, разбор виден.
  await page.locator('.ln-option', { hasText: 'Три' }).click();
  await page.waitForSelector('.ln-option.wrong');
  await page.waitForSelector('.ln-option.right');
  assert.ok((await page.locator('.ln-why').innerText()).includes('Флоп'), 'разбор ответа');
  await fits(`урок, ${width} px`);
  await page.screenshot({ path: path.join(SHOTS, `learn-lesson-${width}.png`) });
  step(`${width} px: урок «Правила» — карты стола 0→3→5, «проверьте себя» с разбором`);

  // Ползунок (правило 2 и 4): числа меняются, прокрутка на месте.
  await page.getByRole('button', { name: /← К курсу/ }).click();
  await page.locator('.ln-lesson-item', { hasText: 'Правило 2 и 4' }).click();
  await page.waitForSelector('.ln-lesson input[type=range]');
  const slider = page.locator('.ln-lesson input[type=range]').first();
  const y0 = await page.evaluate(() => { const el = document.scrollingElement; return el.scrollTop; });
  const before = await page.locator('.ln-play .ln-stat-val').first().innerText();
  await slider.evaluate((el) => { el.value = '15'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const after = await page.locator('.ln-play .ln-stat-val').first().innerText();
  assert.notEqual(before, after, 'число изменилось');
  assert.equal(after, '60%', '15 аутов × 4');
  const y1 = await page.evaluate(() => document.scrollingElement.scrollTop);
  assert.equal(y1, y0, 'прокрутка не сдвинулась от ползунка');
  step(`${width} px: ползунок 15 аутов → «60%», прокрутка на месте`);

  // Прочитано: отметка в списке и на телефоне.
  await page.getByRole('button', { name: /Урок пройден/ }).first().click();
  const read = await page.evaluate(() => JSON.parse(localStorage.getItem('learn.read') || '[]'));
  assert.ok(read.includes('rule-2-4'), 'урок отмечен прочитанным');
  step(`${width} px: «Урок пройден» запомнен на телефоне`);

  // Практика с наставником — прежняя школа жива.
  await page.getByRole('button', { name: /← Назад|← К курсу/ }).first().click().catch(() => {});
  await ctx.close();
}

try {
  await run(320, 640);
  await run(390, 844);
  assert.deepEqual(problems, [], `ошибки на странице: ${problems.join('; ')}`);
  console.log('e2e курса «Обучение»: всё сошлось');
} catch (err) {
  console.error('ПРОВАЛ:', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  web.server.close();
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
}
