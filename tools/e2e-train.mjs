/**
 * «Тренировка» настоящим браузером (docs/poker-training.md).
 *
 *   node tools/e2e-train.mjs
 *
 * Игры с ботами → Покер → «Тренировка» → направление → подход из 10 заданий
 * (выбор, «Проверить», разбор, «Дальше») → итоги → «Мой прогресс»; уровень
 * меняется без прыжка прокрутки; «Назад» при набранном ответе спрашивает;
 * сброс прогресса. Нижней панели на этих экранах нет, горизонтального
 * скролла нет, кнопки от 44 px, ошибок в консоли нет. 320 и 390 px.
 * Telegram — заглушка; это Chromium, а не WebView телефона.
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
import { TelegramStub, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8097);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const SHOTS = path.join(ROOT, 'preview');
fs.mkdirSync(SHOTS, { recursive: true });
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

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

async function fits(page, what) {
  const bad = await page.evaluate(() => {
    const out = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) out.push(`страница шире экрана: ${doc.scrollWidth} > ${doc.clientWidth}`);
    if (document.querySelector('.nav')) out.push('нижняя панель на экране Тренировки');
    for (const b of document.querySelectorAll('#app button, .sheet button')) {
      const r = b.getBoundingClientRect();
      if (r.width && r.height < 43.5) out.push(`кнопка «${b.textContent.trim().slice(0, 24)}» высотой ${r.height}`);
      if (r.right > doc.clientWidth + 0.5 || r.left < -0.5) out.push(`кнопка «${b.textContent.trim().slice(0, 24)}» за краем`);
    }
    return out;
  });
  assert.deepEqual(bad, [], `${what}: ${bad.join('; ')}`);
}

async function run(width, height) {
  const tag = `${width}`;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.sent = []; page.got = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('websocket', (ws) => { ws.on('framesent', (f) => page.sent.push(String(f.payload))); ws.on('framereceived', (f) => { const s = String(f.payload); if (s.includes('"t":"train"') && s.includes('"error"')) problems.push('сервер отказал: ' + s.slice(0, 160)); }); });
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: ivan, start_param: 'solo' }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('h1:has-text("Игры с ботами")');

  // Вход: форма покера → «Тренировка» (полный экран, шторка закрыта, панели нет).
  await page.locator('.game-card.g-poker').click();
  await page.waitForSelector('.sheet .seg.solo-mode');
  const entries = await page.locator('.sheet .seg.solo-mode button').allTextContents();
  assert.deepEqual(entries, ['Партия', 'Обучение', 'Тренировка'], 'три входа рядом');
  await page.locator('.sheet .seg.solo-mode button', { hasText: 'Тренировка' }).click();
  // Первый заход — выбор уровня (Y): «Начать с нуля» ведёт на главную Тренировки.
  await page.waitForSelector('[data-pl=zero], h1:has-text("Тренировка")');
  if (await page.locator('[data-pl=zero]').count()) await page.locator('[data-pl=zero]').click();
  await page.waitForSelector('h1:has-text("Тренировка")');
  assert.equal(await page.locator('.sheet').count(), 0, 'шторка закрыта');
  assert.equal(await page.locator('.tr-track').count(), 8, 'восемь направлений');
  await fits(page, `направления, ${tag} px`);
  await page.screenshot({ path: path.join(SHOTS, `train-home-${tag}.png`) });
  step(`${tag} px: Покер → Тренировка, 8 направлений, панели внизу нет`);

  // Направление «Ауты»: уровень меняется без прыжка прокрутки.
  await page.locator('.tr-track[data-track="outs"]').click();
  await page.waitForSelector('.tr-levels');
  await fits(page, `направление, ${tag} px`);
  const scroller = page.locator('#app > .lobby');
  await page.setViewportSize({ width, height: 420 });
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const before = await scroller.evaluate((el) => el.scrollTop);
  assert.ok(before > 0, 'есть что прокручивать, чтобы проверить прыжок');
  // dispatchEvent, а не click(): click() Playwright сам докручивает кнопку до видимой — это подвинуло бы прокрутку.
  await page.locator('.tr-levels button[data-level="2"]').dispatchEvent('click');
  await page.waitForFunction(() => document.querySelector('.tr-levels button.on')?.dataset.level === '2');
  await page.waitForTimeout(300);
  const after = await scroller.evaluate((el) => el.scrollTop);
  assert.equal(after, before, 'прокрутка не прыгнула после смены уровня');
  assert.equal(app.training.progress('101').skills.find((s) => s.id === 'math').level, 2, 'уровень дошёл до сервера');
  await page.locator('.tr-levels button[data-level="1"]').dispatchEvent('click');
  await page.waitForFunction(() => document.querySelector('.tr-levels button.on')?.dataset.level === '1');
  await page.setViewportSize({ width, height });
  step(`${tag} px: уровень навыка меняется, прокрутка на месте (${before}), сервер получил`);

  // Подход идём на «Префлоп-решениях»: на 1 уровне все задания — выбор варианта
  // (у «Аутов» есть ползунки и карты — их проходит e2e-train-kinds).
  await page.locator('.back-link', { hasText: 'Тренировка' }).click();
  await page.waitForSelector('.tr-track[data-track="preflop"]');
  await page.locator('.tr-track[data-track="preflop"]').click();
  await page.waitForSelector('.tr-levels');
  await page.locator('[data-go="start"]').click();
  await page.waitForSelector('.tr-ex .tr-opt');
  assert.ok(await page.locator('[data-go="check"]').isDisabled(), '«Проверить» выключена, пока нет ответа');
  await page.locator('.tr-opt').first().click();
  await page.locator('.tr-back').click();
  await page.waitForSelector('.sheet h3:has-text("Выйти из задания?")');
  await fits(page, `выход, ${tag} px`);
  await page.getByRole('button', { name: 'Остаться' }).click();
  assert.equal(await page.locator('.sheet').count(), 0);
  assert.ok(await page.locator('.tr-opt.on').count(), 'ответ сохранён');
  step(`${tag} px: «Назад» при набранном ответе спросил, «Остаться» ответ не потерял`);

  // 10 заданий: выбрать, проверить, разбор, дальше.
  const state = () => page.evaluate(() => ({
    foot: document.querySelector('.tr-foot').getBoundingClientRect().bottom,
    inner: innerHeight,
  }));
  for (let i = 0; i < 10; i++) {
    await page.waitForSelector('.tr-ex .tr-opt');
    if (!(await page.locator('.tr-opt.on').count())) await page.locator('.tr-opt').nth(i % 2).click();
    const prompt = await page.locator('.tr-prompt').textContent();
    await page.locator('[data-go="check"]').click();
    await page.waitForSelector('.tr-explain');
    await page.waitForSelector('.tr-explain .tr-why');
    assert.ok(await page.locator('.tr-opt.right').count() === 1, 'верный вариант отмечен');
    assert.equal(await page.locator('.tr-prompt').textContent(), prompt, 'разбор не пересобрал задание');
    const st = await state();
    assert.ok(Math.abs(st.foot - st.inner) < 2, 'нижняя панель у нижнего края');
    if (i === 0) {
      await fits(page, `разбор, ${tag} px`);
      await page.screenshot({ path: path.join(SHOTS, `train-explain-${tag}.png`) });
    }
    await page.locator('[data-go="next"]').click();
  }
  await page.waitForSelector('h1:has-text("Подход закончен")');
  await fits(page, `итоги, ${tag} px`);
  await page.screenshot({ path: path.join(SHOTS, `train-summary-${tag}.png`) });

  const results = page.sent.filter((s) => s.includes('"op":"result"')).length;
  assert.equal(results, 10, 'десять результатов ушли на сервер');
  step(`${tag} px: подход из 10 заданий, разбор после каждого, итоги`);

  // Статистика.
  await page.locator('button', { hasText: 'Мой прогресс' }).click();
  await page.waitForSelector('h1:has-text("Мой прогресс")');
  await page.waitForSelector('.tr-skill');
  await fits(page, `прогресс, ${tag} px`);
  await page.screenshot({ path: path.join(SHOTS, `train-stats-${tag}.png`) });
  assert.equal(app.training.progress("101").total, 10, "на сервере записано");
  step(`${tag} px: «Мой прогресс» — навыки, направления`);

  // Сброс.
  await page.locator('[data-go="reset"]').click();
  await page.waitForSelector('.sheet h3:has-text("Сбросить прогресс?")');
  await page.locator('[data-go="reset-yes"]').click();
  await page.waitForSelector('.tr-note');
  assert.equal(app.training.progress('101').total, 0, 'прогресс стёрт на сервере');
  step(`${tag} px: сброс прогресса`);
  await ctx.close();
}

try {
  await run(320, 568);
  await run(390, 740);
  assert.deepEqual(problems, [], `ошибки в консоли: ${problems.join(' | ')}`);
  console.log('e2e train: ok');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  web.server.close();
  app.close?.();
  process.exit(process.exitCode || 0);
}
