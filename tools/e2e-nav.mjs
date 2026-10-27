/**
 * Нижняя навигация настоящим браузером.
 *
 *   node tools/e2e-nav.mjs
 *
 * Панель «Игры · Рейтинг · Магазин · Настройки» есть на «моих группах», хабе группы,
 * «Играх с ботами» и таблице рейтинга; нет за столом, в пульте владельца, под
 * шторкой и при открытой клавиатуре. Пока рейтинг закрыт, вкладка «Рейтинг»
 * честно говорит «скоро» и не запрашивает у сервера ни одного стола; когда
 * открыт (второй сервер) — игра → рейтинговые столы → «Присоединиться», и
 * обычного стола группы в списке нет. 320, 360 и 390 px. Telegram — заглушка.
 * Снимки — в preview/nav-*.png (в git не попадают).
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
import { TelegramStub, cmdUpdate, dmUpdate, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8096);
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
const step = (s) => console.log(`· ${s}`);
const problems = [];

async function boot(port, ratingSoon, admins = []) {
  const api = new TelegramStub();
  const app = new App({ api, store: new Store(':memory:'), botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${port}`, miniAppName: 'table', ratingSoon, admins });
  const hub = new Hub(app, { botToken: TOKEN });
  app.attachHub(hub);
  const web = startServer({ hub, port, root: path.join(ROOT, 'miniapp'), log: () => {} });
  await new Promise((r) => web.server.once('listening', r));
  api.dmOpen.add('101');
  await app.handleUpdate(dmUpdate(ivan, '/start'));
  return { app, web, port };
}
const group = async (s, chat, title) => {
  await s.app.handleUpdate({ update_id: Math.random(), message: { message_id: Math.floor(Math.random() * 1e6), chat: { id: chat, type: 'supergroup', title }, from: ivan, text: '/game', date: Math.floor(Date.now() / 1000) } });
  await s.app.settle();
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

const browser = await chromium.launch();
async function open(s, startParam, size = [360, 740]) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 2 });
  page.sent = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('websocket', (ws) => ws.on('framesent', (f) => page.sent.push(String(f.payload))));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: ivan, start_param: startParam }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${s.port}/`);
  return page;
}

const active = (page) => page.locator('.nav-tab.on').getAttribute('data-tab');
const tab = (page, id) => page.locator(`.nav-tab[data-tab="${id}"]`);
const navCount = (page) => page.locator('.nav').count();

/** Панель по размеру: вся ширина, у нижнего края, вкладки от 44 px, горизонтального скролла нет; последнее на экране не закрыто. */
async function fits(page, what) {
  const bad = await page.evaluate(() => {
    const out = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) out.push(`страница шире экрана: ${doc.scrollWidth} > ${doc.clientWidth}`);
    const nav = document.querySelector('.nav');
    if (!nav) return ['панели нет'];
    const r = nav.getBoundingClientRect();
    if (Math.abs(r.bottom - innerHeight) > 1) out.push(`панель не у нижнего края: ${r.bottom} из ${innerHeight}`);
    if (r.height < 56) out.push(`панель ниже 56: ${r.height}`);
    for (const b of nav.querySelectorAll('button')) {
      const q = b.getBoundingClientRect();
      if (q.height < 44 || q.width < 44) out.push(`вкладка ${q.width}×${q.height}`);
    }
    const sc = document.querySelector('#app > .lobby');
    if (sc) {
      const sr = sc.getBoundingClientRect();
      if (sr.bottom > r.top + 0.5) out.push(`экран заходит под панель: ${sr.bottom} > ${r.top}`);
      // Нижние элементы прокручиваются и не прячутся за панелью: до конца списка можно доехать.
      sc.scrollTop = sc.scrollHeight;
      const last = [...sc.children].filter((e) => e.getBoundingClientRect().height).pop();
      if (last && last.getBoundingClientRect().bottom > r.top + 0.5) out.push('последний блок закрыт панелью');
      sc.scrollTop = 0;
    }
    return out;
  });
  assert.deepEqual(bad, [], `${what}: ${bad.join('; ')}`);
}

try {
  /* ================== сервер 1: рейтинг закрыт (как в проде) ================== */
  const A = await boot(PORT, true, ['101']);
  await group(A, -4001, 'Первая');
  await group(A, -4002, 'Вторая');

  for (const size of [[320, 568], [360, 740], [390, 844]]) {
    const page = await open(A, '', size);
    const tag = `${size[0]}px`;
    await page.waitForSelector('h1:has-text("Ваши группы")');
    assert.equal(await tab(page, 'games').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.nav-tab').count(), 4);
    assert.equal(await active(page), 'games');
    await fits(page, `мои группы, ${tag}`);

    await tab(page, 'rating').click();
    await page.waitForSelector('h1:has-text("Рейтинг игроков")');
    assert.equal(await active(page), 'rating');
    await page.waitForSelector('.rk-soon');
    assert.equal(await page.locator('.rk-games .rt-chip').count(), 0, 'пока закрыт: карточек игр нет');
    assert.equal(await page.getByRole('button', { name: 'Присоединиться' }).count(), 0, 'кнопки «Присоединиться» нет');
    await fits(page, `вкладка «Рейтинг» (скоро), ${tag}`);
    if (size[0] === 320 || size[0] === 390) await page.screenshot({ path: path.join(SHOTS, `nav-${tag}-rating-soon.png`) });

    await tab(page, 'settings').click();
    await page.waitForSelector('h1:has-text("Настройки")');
    assert.equal(await active(page), 'settings');
    await fits(page, `вкладка «Настройки», ${tag}`);
    if (size[0] === 320 || size[0] === 390) await page.screenshot({ path: path.join(SHOTS, `nav-${tag}-settings.png`) });

    await tab(page, 'games').click();
    await page.waitForSelector('h1:has-text("Ваши группы")');
    assert.equal(await active(page), 'games');
    if (size[0] === 320 || size[0] === 390) await page.screenshot({ path: path.join(SHOTS, `nav-${tag}-home.png`) });

    // Ни одного запроса столов, пока рейтинг закрыт.
    assert.equal(page.sent.filter((m) => m.includes('rtables') || m.includes('rjoin')).length, 0, 'страница не просила рейтинговые столы');
    step(`${tag}: мои группы → Рейтинг (скоро) → Настройки → Игры; запросов столов нет`);
    if (size[0] !== 360) { await page.close(); continue; }

    // Нажатие по активной вкладке — к началу экрана, а не «обновление».
    await tab(page, 'games').click();
    assert.equal(await active(page), 'games');

    // В группу: хаб с панелью; шторка и клавиатура панель убирают.
    await page.locator('.lrow', { hasText: 'Первая' }).getByRole('button', { name: 'Открыть' }).click();
    await page.waitForSelector('h1:has-text("Выберите игру")');
    assert.equal(await navCount(page), 1, 'на хабе группы панель есть');
    await fits(page, `хаб группы, ${tag}`);
    await page.locator('.game-card.g-durak').click();
    await page.waitForSelector('.sheet');
    assert.equal(await page.locator('.nav').isVisible(), false, 'под шторкой панели не видно');
    await page.keyboard.press('Escape');
    await page.locator('.backdrop').click({ position: { x: 5, y: 5 } });
    await page.waitForSelector('.sheet', { state: 'detached' });
    assert.equal(await page.locator('.nav').isVisible(), true, 'шторку закрыли — панель вернулась');

    // Клавиатура: поле в фокусе — панели нет (в заглушке окно не сжимается, поэтому проверяем по фокусу).
    await page.evaluate(() => { const i = document.createElement('input'); i.id = 'kb-probe'; document.body.append(i); i.focus(); });
    assert.equal(await page.locator('.nav').isVisible(), false, 'при поле ввода в фокусе панели нет');
    await page.evaluate(() => { document.activeElement?.blur(); document.getElementById('kb-probe').remove(); });
    await page.locator('.nav').waitFor({ state: 'visible' });
    await page.reload();
    await page.waitForSelector('h1:has-text("Ваши группы")');
    step('хаб: панель есть; под шторкой и при вводе её нет; после — вернулась');

    // Стол: панели нет, ничего у доски не отнимает.
    await page.locator('.lrow', { hasText: 'Первая' }).getByRole('button', { name: 'Открыть' }).click();
    await page.locator('.game-card.g-durak').click();
    await page.getByRole('button', { name: 'Создать лобби' }).click();
    await page.waitForSelector('.lobby:not(.hub)', { timeout: 5000 }).catch(async () => { await page.screenshot({ path: path.join(SHOTS, 'nav-debug.png') }); console.log((await page.locator('#app').innerText()).slice(0, 300)); throw new Error('нет лобби'); });
    assert.equal(await navCount(page), 0, 'в лобби панели нет');
    assert.equal(await page.evaluate(() => document.body.dataset.nav), '', 'и признака панели нет');
    assert.equal(await navCount(page), 0, 'за столом панели нет');
    // Назад в хаб — панель вернулась на «Игры».
    await page.locator('.back-link', { hasText: 'Все игры группы' }).first().click().catch(async () => { await page.goBack(); });
    await page.waitForSelector('h1:has-text("Выберите игру")');
    assert.equal(await navCount(page), 1, 'вернулись в хаб — панель вернулась');
    assert.equal(await active(page), 'games');
    step('стол: панели нет; назад в хаб — есть');
    await page.close();
  }

  // Игры с ботами (личка без групп) — на втором сервере без групп.
  const B = await boot(PORT + 2, true);
  const solo = await open(B, 'solo');
  await solo.waitForSelector('h1:has-text("Игры с ботами")');
  assert.equal(await navCount(solo), 1, 'на «Играх с ботами» панель есть');
  await fits(solo, 'игры с ботами, 360 px');
  await tab(solo, 'settings').click();
  await tab(solo, 'games').click();
  await solo.waitForSelector('h1:has-text("Игры с ботами")');
  await solo.locator('.game-card.g-durak').click();
  await solo.waitForSelector('.sheet');
  await solo.getByRole('button', { name: '▶ Играть' }).click();
  await solo.waitForSelector('.panel, .seat, .ch-head', { timeout: 8000 });
  assert.equal(await navCount(solo), 0, 'за столом с ботом панели нет');
  step('игры с ботами: панель есть; за столом с ботом нет');
  await solo.close();

  // Пульт владельца — без панели.
  const admin = await open(A, 'admin');
  await admin.waitForSelector('h1:has-text("Пульт")');
  assert.equal(await navCount(admin), 0, 'в пульте панели нет');
  step('пульт владельца: панели нет');
  await admin.close();

  /* ================== сервер 2: рейтинг открыт ================== */
  const C = await boot(PORT + 1, false);
  await group(C, -5001, 'Рейтинговая');
  const ro = await open(C, '');
  await ro.waitForSelector('h1:has-text("Выберите игру")'); // группа одна: сразу хаб
  // С хаба группы можно сразу играть с ботом — без захода в личку бота.
  await ro.getByRole('button', { name: '🤖 Играть с ботами' }).click();
  await ro.waitForSelector('h1:has-text("Игры с ботами")');
  step('хаб группы → «🤖 Играть с ботами» → экран игр с ботами (из группы, без личного чата)');
  await ro.locator('.back-link', { hasText: 'Мои группы' }).click();
  await ro.waitForSelector('.lobby.hub');
  await ro.getByRole('button', { name: 'Открыть' }).first().click();
  await ro.waitForSelector('h1:has-text("Выберите игру")');
  await ro.locator('.game-card.g-durak').click();
  await ro.getByRole('button', { name: 'Создать лобби' }).click();
  await ro.waitForSelector('.lobby:not(.hub)');
  await ro.locator('.back-link', { hasText: 'Все игры' }).first().click();
  await ro.waitForSelector('h1:has-text("Выберите игру")');
  await tab(ro, 'rating').click();
  await ro.waitForSelector('h1:has-text("Рейтинг игроков")');
  assert.equal(await ro.locator('.rk-soon').count(), 0, 'открыт: «скоро» нет');
  assert.equal(await ro.locator('.rk-games .rt-chip').count(), 7, 'карточки семи игр');
  await fits(ro, 'рейтинг открыт, выбор игры');
  await ro.locator('.rk-games .rt-chip', { hasText: 'Дурак' }).click();
  await ro.waitForSelector('.hint:has-text("Рейтинговых столов в этой игре пока нет")');
  assert.equal(await ro.getByRole('button', { name: 'Присоединиться' }).count(), 0, 'обычный стол группы в рейтинговых не показан');
  await ro.screenshot({ path: path.join(SHOTS, 'nav-360px-rating-open-empty.png') });
  step('рейтинг открыт: семь игр → у «Дурака» обычный стол группы НЕ в списке, пусто');

  C.app.liveRooms(-5001)[0].ranked = true; // стол, объявленный рейтинговым
  await ro.locator('.rk-games .rt-chip', { hasText: 'Покер' }).click();
  await ro.locator('.rk-games .rt-chip', { hasText: 'Дурак' }).click();
  await ro.getByRole('button', { name: 'Присоединиться' }).waitFor();
  await ro.screenshot({ path: path.join(SHOTS, 'nav-360px-rating-open-table.png') });
  await ro.getByRole('button', { name: 'Присоединиться' }).click();
  await ro.waitForSelector('.lobby:not(.hub)');
  assert.equal(await navCount(ro), 0, 'сел за стол — панели нет');
  step('объявленный рейтинговым стол появился в списке; «Присоединиться» ведёт за стол');

  // Таблица лидеров: панель на ней, активна «Рейтинг», «Игры» ведёт назад.
  await ro.locator('.back-link', { hasText: 'Все игры' }).first().click();
  await ro.waitForSelector('h1:has-text("Выберите игру")');
  await tab(ro, 'rating').click();
  await ro.getByRole('button', { name: /Таблица лидеров/ }).click();
  await ro.waitForSelector('.lobby.rating');
  assert.equal(await navCount(ro), 1, 'на таблице лидеров панель есть');
  assert.equal(await active(ro), 'rating');
  await fits(ro, 'таблица лидеров');
  await tab(ro, 'games').click();
  await ro.waitForSelector('h1:has-text("Выберите игру")');
  step('таблица лидеров: панель есть, «Игры» возвращает в хаб');

  assert.deepEqual(problems, [], `ошибки на странице: ${problems.join('; ')}`);
  console.log('e2e навигации: всё сошлось');
} catch (err) {
  console.error('ПРОВАЛ:', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
}
