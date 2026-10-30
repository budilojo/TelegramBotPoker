/**
 * Каталог игр карточками — настоящим браузером.
 *
 *   node tools/e2e-catalog.mjs
 *
 * Хаб группы и «Игры с ботами»: страницы, кнопки «‹ ›», точки, свайп, индикатор «Страница N из M»,
 * позиция при возврате, 320 и 390 px, длинное название, одна страница (без элементов листания)
 * и пустой набор. Полный путь «группа → карточка игры на другой странице → форма лобби».
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
const PORT = Number(process.env.E2E_PORT || 8098);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const SHOTS = path.join(ROOT, 'preview');
fs.mkdirSync(SHOTS, { recursive: true });
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const ivan = user(101, 'Иван');
const step = (s) => console.log(`· ${s}`);
const problems = [];

const api = new TelegramStub();
const app = new App({ api, store: new Store(':memory:'), botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${PORT}`, miniAppName: 'table' });
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));
api.dmOpen.add('101');
await app.handleUpdate(dmUpdate(ivan, '/start'));
await app.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: -100555, type: 'supergroup', title: 'Группа' }, from: ivan, text: '/game', date: Math.floor(Date.now() / 1000) } });
await app.settle();
const gcode = [...app.groups.values()][0].code;

const sdk = (initData) => `
  window.Telegram = { WebApp: { initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: new URLSearchParams(${JSON.stringify(initData)}).get('start_param') },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(){}, BackButton: { show(){}, hide(){}, onClick(){} },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} } } };`;
const browser = await chromium.launch();
async function open(size, startParam) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 2, hasTouch: true });
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: ivan, start_param: startParam }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdk(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  return page;
}
const info = (page) => page.evaluate(() => {
  const t = document.querySelector('.gc-track');
  const pages = t ? [...t.querySelectorAll('.gc-page')].length : 0;
  const cur = t ? Math.round(t.scrollLeft / t.clientWidth) : -1;
  const doc = document.documentElement;
  return {
    pages, cur, cards: document.querySelectorAll('.game-card').length, label: document.querySelector('.gc-pagelabel')?.textContent || '',
    dots: document.querySelectorAll('.gc-dot').length, nav: document.querySelectorAll('.gc-nav').length, wide: doc.scrollWidth > doc.clientWidth,
    same: [...document.querySelectorAll('.gc-players')].map((e) => e.textContent).filter((s) => /(\d)–\1 /.test(s)),
    small: [...document.querySelectorAll('.gc-nav, .gc-dot, .game-card')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.height < 44 || r.width < 44); }).length,
  };
});
const settle = (page) => page.waitForTimeout(450);

try {
  for (const size of [[320, 640], [390, 844]]) {
    step(`хаб группы, ${size[0]} px`);
    const page = await open(size, `g_${gcode}`);
    await page.waitForSelector('.game-card');
    let i = await info(page);
    assert.ok(i.cards >= 7, `все игры из реестра на месте: ${i.cards}`);
    assert.ok(i.pages > 1, 'страниц несколько');
    assert.equal(i.dots, i.pages);
    assert.equal(i.nav, 2);
    assert.equal(i.cur, 0);
    assert.match(i.label, /^Страница 1 из \d+$/);
    assert.deepEqual(i.same, [], 'у дуэлей «2 игрока», а не «2–2 игроков»');
    assert.equal(i.small, 0, 'кнопки листания, точки и карточки не меньше 44 px');
    assert.equal(i.wide, false, 'горизонтального скролла у страницы нет');
    assert.equal(await page.locator('.gc-prev').isDisabled(), true, 'на первой странице «назад» выключена');
    await page.screenshot({ path: path.join(SHOTS, `catalog-${size[0]}-1.png`) });

    await page.locator('.gc-next').click(); await settle(page);
    i = await info(page);
    assert.equal(i.cur, 1); assert.match(i.label, /^Страница 2 из/);
    // Точка ведёт на свою страницу, без жестов.
    await page.locator('.gc-dot').last().click(); await settle(page);
    i = await info(page);
    assert.equal(i.cur, i.pages - 1);
    assert.equal(await page.locator('.gc-next').isDisabled(), true, 'на последней странице «дальше» выключена');
    await page.screenshot({ path: path.join(SHOTS, `catalog-${size[0]}-last.png`) });
    await page.locator('.gc-prev').click(); await settle(page);
    assert.equal((await info(page)).cur, i.pages - 2);

    // Свайп пальцем: прокрутка трека вправо/влево защёлкивается на странице.
    await page.evaluate(() => document.querySelector('.gc-track').scrollTo({ left: 0, behavior: 'instant' })); await settle(page);
    await page.evaluate(() => { const t = document.querySelector('.gc-track'); t.scrollTo({ left: t.clientWidth * 0.8, behavior: 'smooth' }); });
    await settle(page);
    i = await info(page);
    assert.equal(i.cur, 1, 'жест листает страницу'); assert.match(i.label, /^Страница 2 из/, 'индикатор следует за жестом');

    // Позиция сохраняется при возврате: уходим в «Настройки» и обратно, и после обновления состояния.
    await page.locator('.nav-tab[data-tab="settings"]').click();
    await page.locator('.nav-tab[data-tab="games"]').click(); await settle(page);
    assert.equal((await info(page)).cur, 1, 'после возврата открыта та же страница');
    await page.evaluate(async () => { const { send } = await import('/net.js'); send({ t: 'refresh' }, { lock: false }); }); await settle(page);
    assert.equal((await info(page)).cur, 1, 'обновление состояния не сбрасывает страницу');

    // Путь: игра на второй странице → форма лобби.
    const title = await page.locator('.gc-page[data-page="1"] .gc-title').first().innerText();
    await page.locator('.gc-page[data-page="1"] .game-card').first().click();
    await page.waitForSelector('.sheet');
    assert.match(await page.locator('.sheet h3').innerText(), new RegExp(title.split(' ')[0]));
    await page.keyboard.press('Escape');
    await page.close();
  }

  step('«Игры с ботами»: те же страницы');
  {
    const page = await open([320, 640], '');
    await page.locator('button:has-text("Играть с ботами")').first().click();
    await page.waitForSelector('.hub.solo .game-card');
    const i = await info(page);
    assert.ok(i.pages > 1 && i.dots === i.pages && i.wide === false && i.small === 0, JSON.stringify(i));
    await page.screenshot({ path: path.join(SHOTS, 'catalog-solo-320.png') });
    await page.close();
  }

  step('одна страница и пустой набор, длинное название (на подставленном состоянии)');
  {
    const page = await open([320, 640], `g_${gcode}`);
    await page.waitForSelector('.game-card');
    const probe = (games) => page.evaluate(async (list) => {
      const { gameCatalog } = await import('/catalog.js');
      const { h } = await import('/ui.js');
      const root = document.createElement('div'); root.className = 'hub';
      root.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0a1216;padding:16px';
      root.append(gameCatalog({ games: list, key: 'probe', empty: 'Игр пока нет.', card: (g) => h('button.game-card', h('div.gc-body', h('div.gc-title', g.title), h('div.gc-blurb', g.blurb || ''))) }));
      document.body.append(root);
      const r = { dots: root.querySelectorAll('.gc-dot').length, nav: root.querySelectorAll('.gc-nav').length, cards: root.querySelectorAll('.game-card').length, text: root.innerText, wide: root.scrollWidth > root.clientWidth };
      root.remove();
      return r;
    }, games);
    let r = await probe([]);
    assert.equal(r.cards, 0); assert.match(r.text, /Игр пока нет/);
    r = await probe([{ title: 'Одна' }]);
    assert.equal(r.cards, 1); assert.equal(r.dots + r.nav, 0, 'одна страница — ни точек, ни стрелок');
    const long = 'Очень длинное название игры которое не помещается в одну строку на узком экране';
    r = await probe(Array.from({ length: 5 }, (_, k) => ({ title: `${long} ${k}`, blurb: long })));
    assert.equal(r.wide, false, 'длинное название не раздвигает страницу');
    await page.close();
  }
} finally {
  await browser.close();
  web.server.close();
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('каталог игр: ок');
process.exit(0);
