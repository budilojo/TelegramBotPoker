/**
 * «Тренировка»: показ ситуации и диапазона, интерактив разбора (волна 4, агент F).
 *
 *   node tools/e2e-train-scenes.mjs
 *
 * 1) каждое из зарегистрированных упражнений открывается на 320 и 390 px без ошибок в консоли и без
 *    горизонтального скролла; 2) префлоп: ряд позиций, карты, банк видны ДО ответа; 3) «Чтение
 *    диапазонов 3» показывает матрицу до ответа; «вы» и 3-бет не перепутаны; 4) после ответа в
 *    разборе раскрывается диапазон с обведённой рукой; нажатие на клетку отвечает словами и не двигает
 *    прокрутку; 5) точки подхода и «N верных подряд»; 6) итоги: «Где ошибались» → «Решить снова».
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
import { assertNoJump } from './lib/scroll-probe.mjs';
import { signInitData } from '../bot/webapp-auth.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8198);
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



const eng = await import('../miniapp/train/engine.js');
await import('../miniapp/train/content/index.js');
const all = eng.allExercises();

async function open(width) {
  const ctx = await browser.newContext({ viewport: { width, height: 700 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push('PAGEERR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && problems.push('CONSOLE ' + m.text()));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: ivan, start_param: 'solo' }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('h1:has-text("Игры с ботами")');
  await page.locator('.game-card.g-poker').click();
  await page.locator('.sheet .seg.solo-mode button', { hasText: 'Тренировка' }).click();
  await page.waitForSelector('[data-pl=zero], h1:has-text("Тренировка")');
  if (await page.locator('[data-pl=zero]').count()) await page.locator('[data-pl=zero]').click();
  await page.waitForSelector('h1:has-text("Тренировка")');
  return page;
}
const start = async (page, ex, seed = 12345, level = null) => {
  await page.evaluate(async (a) => { const m = await import('/train/screens.js'); m.startRun(a); }, { track: ex.track, exercise: ex.id, seed, level });
  await page.waitForSelector('.tr-ex');
};
const byId = (id) => all.find((e) => e.id === id);

try {
  for (const width of [320, 390]) {
    const page = await open(width);
    // 1) все упражнения
    for (const ex of all) {
      await start(page, ex);
      const bad = await page.evaluate(() => { const d = document.documentElement; return d.scrollWidth > d.clientWidth; });
      assert.ok(!bad, `${ex.id}: горизонтальный скролл на ${width} px`);
      assert.ok(await page.locator('.tr-prompt').count(), `${ex.id}: нет текста задания`);
    }
    step(`${width} px: ${all.length} упражнений открываются без горизонтального скролла`);

    // 2) префлоп: ситуация видна до ответа
    await start(page, byId('w-preflop-open-1'));
    assert.equal(await page.locator('.tr-widget .tm-pos-chip').count(), 6, 'ряд позиций');
    assert.equal(await page.locator('.tr-widget .tm-pos-chip.me').count(), 1, 'ваша позиция отмечена');
    assert.ok(await page.locator('.tr-widget .tm-hero-cards > *').count() === 2, 'ваши две карты видны');
    assert.ok(await page.locator('.tr-widget .tm-pot.bb').count(), 'банк и стек в BB');
    // 3) матрица до ответа и «вы» в 3-бете
    await start(page, byId('w-readrange-shape-3'));
    assert.ok(await page.locator('.tr-widget .tm-scene .rg-c').count() >= 169, 'матрица видна до ответа');
    await start(page, byId('w-readrange-3bet-3'));
    const meTxt = await page.locator('.tm-pos-chip.me').first().getAttribute('aria-label');
    const prompt = await page.locator('.tr-prompt').textContent();
    const opener = /открылись рейзом с \S+ \((\w+)/.exec(prompt) || /открылись рейзом с (\w+)/.exec(prompt);
    assert.ok(opener && meTxt.startsWith(opener[1]), `«вы» — тот, кто открылся: «${meTxt}» / «${prompt}»`);
    if (process.env.SHOT && width === 320) await page.screenshot({ path: process.env.SHOT + '/3bet-320.png' });
    assert.ok((await page.locator('.tm-pos-chip.op').first().getAttribute('aria-label')).includes('3-бет'), 'соперник подписан «3-бет»');
    step(`${width} px: позиции, карты, банк и матрица видны до ответа; «вы» не перепутан в 3-бете`);

    if (width === 390) {
      // 4) разбор: диапазон с обведённой рукой, нажатие на клетку
      await start(page, byId('w-preflop-open-1'));
      const sol = await page.evaluate(async () => { const e = await import('/train/engine.js'); return e.instantiate('w-preflop-open-1', 12345).task.solution; });
      await page.locator(`.tr-opt[data-id="${sol}"]`).click();
      await page.locator('[data-go="check"]').click();
      await page.waitForSelector('.tr-explain .tm-reveal .rg');
      assert.ok(await page.locator('.tm-reveal .rg-c.mk').count() === 1, 'рука задания обведена');
      const before = await page.locator('.tm-cell-note').first().textContent();
      // прокручиваемый родитель разбора — ищем и помечаем; окно делаем низким, чтобы было что прокручивать
      await page.waitForTimeout(900); // после «Проверить» экран плавно докручивает разбор — ждём конца этой прокрутки
      await page.setViewportSize({ width, height: 420 });
      await page.waitForTimeout(200);
      const marked = await page.evaluate(() => { let e = document.querySelector('.tm-reveal'); while (e && e !== document.documentElement) { const o = getComputedStyle(e).overflowY; if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 1) { e.setAttribute('data-scr', '1'); return true; } e = e.parentElement; } return false; });
      assert.ok(marked, 'экран разбора прокручивается');
      await assertNoJump(page, { scroller: '[data-scr]', at: 'middle', label: 'нажатие на клетку разбора' }, () => page.locator('.tm-reveal .rg-c[data-h="AKs"]').first().dispatchEvent('click'));
      await page.setViewportSize({ width, height: 700 });
      const after = await page.locator('.tm-cell-note').first().textContent();
      assert.notEqual(after, before, 'нажатие на клетку отвечает');
      if (process.env.SHOT) { await page.locator('.tr-explain').scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.SHOT + '/reveal-390.png' }); }
      assert.match(after, /AKs — туз-король одной масти, 4 комбинации\. (Входит|Не входит)/, after);
      // 5) точки подхода
      assert.equal(await page.locator('.tr-run-dots i.ok').count(), 1, 'верный ответ — зелёная точка');
      assert.equal(await page.locator('.tr-run-dots i.cur').count(), 1, 'следующее задание отмечено');
      assert.ok(!/null|undefined|\[object/.test(await page.locator('.tr-body, .tr-head').allInnerTexts().then((a) => a.join(' '))), 'на экране нет «null» и «[object …]»');
      // «Повторить это» грузит то же задание: второй верный ответ → серия 2; неверный → красная точка
      const pickAndCheck = async (id) => { await page.locator(`.tr-opt[data-id="${id}"]`).click(); await page.locator('[data-go="check"]').click(); await page.waitForSelector('.tr-explain'); };
      await page.locator('[data-go="again"]').click();
      await page.waitForSelector('.tr-ex .tr-opt');
      await pickAndCheck(sol);
      assert.equal(await page.locator('.tr-run-dots i.ok').count(), 2, 'две зелёные точки');
      assert.match(await page.locator('.tr-streak').textContent(), /2 верных подряд/);
      await page.locator('[data-go="again"]').click();
      await page.waitForSelector('.tr-ex .tr-opt');
      const wrongId = await page.locator('.tr-opt').evaluateAll((bs, s) => bs.map((b) => b.dataset.id).find((i) => i !== s), sol);
      await pickAndCheck(wrongId);
      assert.equal(await page.locator('.tr-run-dots i.bad').count(), 1, 'неверный ответ — красная точка');
      assert.equal(await page.locator('.tr-streak').count(), 0, 'серия сброшена');
      // 6) итоги: «Где ошибались» → «Решить снова»
      await page.evaluate(async () => { const r = await import('/train/route.js'); r.openRoute('train-sum'); });
      await page.waitForSelector('h1:has-text("Подход закончен")');
      if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '/summary-390.png' });
      assert.equal(await page.locator('.tr-redo li').count(), 1, 'в «Где ошибались» одно задание');
      await page.locator('.tr-redo [data-go="redo"]').click();
      await page.waitForSelector('.tr-ex .tr-opt');
      assert.equal(await page.locator('.tr-run-dots i.ok, .tr-run-dots i.bad').count(), 0, 'новый подход с чистыми точками');
      step('390 px: разбор раскрывает диапазон, обводка руки, нажатие на клетку, точки подхода');
    }
    await page.context().close();
  }
  assert.deepEqual(problems, [], `ошибки в консоли: ${problems.join(' | ')}`);
  console.log('e2e train scenes: ok');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  web.server.close();
  process.exit(process.exitCode || 0);
}
