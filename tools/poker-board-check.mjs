/**
 * Покерный стол на телефоне: ряд общих карт по центру и целиком в экране,
 * подсказка «Вы сбросили…» — одна.
 *
 * Строит столы (настоящие карты `live` и карты бота `virtual`; флоп, тёрн, ривер;
 * игрок сбросил и не сбросил), открывает каждый настоящей страницей на 320/390/430 px
 * (и 414×896), для каждой косметической серии стола (шесть серий + без оформления)
 * и меряет:
 *   — левый и правый край ряда карт внутри экрана;
 *   — ряд симметричен (середина ряда = середина стола ±3 px);
 *   — ряд лежит внутри стола (овала) и не шире экрана;
 *   — фраза «Вы сбросили» встречается ровно один раз (если игрок сбросил) или ни разу.
 *
 *   node tools/poker-board-check.mjs          → таблица; код 1 при любом нарушении
 *   SHOTS=1 node tools/poker-board-check.mjs → снимки в preview/poker-board/
 *   QUICK=1 …                                  → по одной серии (без оформления и «сотовая»)
 *
 * Chromium с заглушкой Telegram — это не настоящий WebView Telegram.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { startServer } from '../bot/server.js';
import { TelegramStub } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';
import * as R from '../bot/room.js';
import { seededRng, shuffled } from '../bot/deck.js';
import { legalActions } from '../server/game.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BOARD_PORT || 8098);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const SHOTS = process.env.SHOTS === '1';
const OUT = path.join(ROOT, 'preview', 'poker-board');
const SERIES = process.env.QUICK === '1' ? [null, 'obsidian'] : [null, 'sever', 'obsidian', 'chertezh', 'terracotta', 'orbita', 'porcelain'];
const VIEWPORTS = [[320, 568], [390, 844], [414, 896], [430, 932]];

const api = new TelegramStub();
const app = new App({ api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${PORT}`, collectionsDemo: true });
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);

let chat = -100800;
const NAMES = ['Иван', 'Mr.Porcelain', 'Константин', 'Дима'];

/** Стол на n человек; `live` — настоящие карты. Герой — Иван (101). */
function table(n, live) {
  const room = R.createRoom({ chatId: String(chat--), title: 'Проверка', host: { id: 101, name: NAMES[0], dm: 'ok' }, startingStack: 10_000, smallBlind: 25, bigBlind: 50 });
  for (let i = 1; i < n; i++) R.addPlayer(room, { id: 101 + i, name: NAMES[i], dm: 'ok' });
  if (live) R.updateSettings(room, '101', { cards: 'live' });
  app.addRoom(room);
  R.startGame(room, '101', { deck: () => shuffled(seededRng(7)) });
  return room;
}
/** Доиграть до улицы `street`; герой сбрасывает карты при первой возможности, если `fold`. */
function toStreet(room, street, fold) {
  let guard = 0;
  while (room.hand.phase === 'betting' && room.hand.street !== street && guard++ < 60) {
    const id = room.hand.actorId;
    const l = legalActions(room, id);
    const act = id === '101' && fold && l.canFold !== false && !l.canCheck ? ['fold'] : id === '101' && fold ? ['fold'] : [l.canCheck ? 'check' : 'call'];
    const r = R.act(room, id, act[0], act[1]);
    if (r.error) throw new Error(`${id} ${act[0]}: ${r.error}`);
  }
  if (room.hand.street !== street) throw new Error(`не дошли до ${street}: ${room.hand.street}`);
}

const scenes = [];
for (const live of [true, false]) {
  for (const street of ['flop', 'turn', 'river']) {
    for (const fold of [false, true]) {
      const room = table(3, live);
      toStreet(room, street, fold);
      scenes.push({ name: `${live ? 'live' : 'virt'}-${street}${fold ? '-fold' : ''}`, room, fold, live });
    }
  }
}

const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));
app.syncClocks();

const sdk = (initData, code) => `
  window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: ${JSON.stringify(code)} },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(){},
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  } };`;

/** Оформление стола серии — как в e2e-cosmetics-v2: подменяем снимок и перерисовываем. */
async function dress(page, series) {
  await page.evaluate(async (collection) => {
    const net = await import('/net.js');
    const registry = await import('/games/index.js');
    void registry;
    const s = structuredClone(net.net.state);
    s.look = s.look || { v: 2, dealNo: 0, backs: [] };
    s.look.dealNo = (s.look.dealNo || 0) + 1000;
    s.look.table = collection ? { item: `${collection}-table`, color: 'default' } : null;
    const mod = await import('/games/poker.js');
    mod.onState(s, net.net.state, { wasConnected: true });
    const ui = await import('/ui.js');
    ui.$app.replaceChildren();
    mod.render();
    ui.flushAnimations({ still: true });
  }, series);
  await page.waitForTimeout(120);
}

/** Что видно на странице, в пикселях окна. */
function measure() {
  const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
  const table = document.querySelector('.table');
  const felt = document.querySelector('.table .felt');
  const cells = [...document.querySelectorAll('.board > .card, .board > .slot')].map(r);
  const text = document.body.innerText;
  return {
    vw: innerWidth,
    sw: document.documentElement.scrollWidth,
    table: table ? r(table) : null,
    felt: felt ? r(felt) : null,
    cells,
    folded: (text.match(/Вы сбросили/g) || []).length,
    tableNodes: document.querySelectorAll('.table').length,
  };
}

function problems(m, sc) {
  const out = [];
  if (!m.table || m.cells.length !== 5) return [`нет стола или ряда из пяти (${m.cells.length})`];
  const left = Math.min(...m.cells.map((c) => c.l));
  const right = Math.max(...m.cells.map((c) => c.r));
  if (left < -0.5) out.push(`ряд выезжает влево (${left.toFixed(1)})`);
  if (right > m.vw + 0.5) out.push(`ряд выезжает вправо (${right.toFixed(1)} > ${m.vw})`);
  const mid = (left + right) / 2;
  const tmid = (m.table.l + m.table.r) / 2;
  if (Math.abs(mid - tmid) > 3) out.push(`ряд сдвинут: середина ${mid.toFixed(1)}, середина стола ${tmid.toFixed(1)}`);
  if (m.felt && (left < m.felt.l - 1 || right > m.felt.r + 1)) out.push(`ряд шире сукна (${left.toFixed(0)}..${right.toFixed(0)} против ${m.felt.l.toFixed(0)}..${m.felt.r.toFixed(0)})`);
  if (m.sw > m.vw) out.push(`страница шире экрана (${m.sw} > ${m.vw})`);
  const want = sc.fold ? 1 : 0;
  if (m.folded !== want) out.push(`«Вы сбросили» встречается ${m.folded} раз, нужно ${want}`);
  return out;
}

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}
if (SHOTS) fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
let failures = 0;
let total = 0;
for (const [w, hgt] of VIEWPORTS) {
  for (const sc of scenes) {
    const page = await browser.newPage({ viewport: { width: w, height: hgt }, deviceScaleFactor: 1 });
    const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: { id: 101, first_name: 'Иван' }, start_param: sc.room.code }, TOKEN);
    await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdk(initData, sc.room.code) }));
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector('.table');
    await page.waitForTimeout(150);
    for (const series of SERIES) {
      if (series || page.__dressed) await dress(page, series);
      page.__dressed = true;
      const found = problems(await page.evaluate(measure), sc);
      total++;
      if (found.length) {
        failures++;
        console.log(`${w}×${hgt} ${sc.name} ${series ?? 'без оформления'}: ${found.join('; ')}`);
      }
      if (SHOTS && (found.length || series === 'obsidian' || !series)) {
        await page.screenshot({ path: path.join(OUT, `${w}x${hgt}-${sc.name}-${series ?? 'base'}.png`) });
      }
    }
    await page.close();
  }
}

/*
 * Окно меняется уже при открытом столе (в Telegram на iPhone оно раскрывается
 * и сжимается при свёрнутой клавиатуре, шторке, повороте): ряд карт должен
 * вернуться на место и после каждой смены. Свежая страница этого не покажет.
 */
const SEQ = [[390, 844], [390, 560], [320, 568], [430, 932], [360, 640], [390, 844]];
for (const sc of scenes.filter((x) => x.name.endsWith('river-fold') || x.name.endsWith('flop'))) {
  for (const series of [null, 'obsidian']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: { id: 101, first_name: 'Иван' }, start_param: sc.room.code }, TOKEN);
    await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdk(initData, sc.room.code) }));
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector('.table');
    if (series) await dress(page, series);
    for (const [w, hgt] of SEQ) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.waitForTimeout(250);
      const found = problems(await page.evaluate(measure), sc);
      total++;
      if (found.length) {
        failures++;
        console.log(`смена окна → ${w}×${hgt} ${sc.name} ${series ?? 'без оформления'}: ${found.join('; ')}`);
        if (SHOTS) await page.screenshot({ path: path.join(OUT, `resize-${w}x${hgt}-${sc.name}-${series ?? 'base'}.png`) });
      }
    }
    await page.close();
  }
}

/*
 * Защита от сдвига: если вёрстка (оформление серии, поздний шрифт, смена окна)
 * когда-либо уведёт ряд вбок, следующий пересчёт стола ставит его на середину.
 * Уводим ряд руками и просим пересчёт — как это делает смена окна.
 */
for (const sc of scenes.filter((x) => x.name === 'live-river-fold' || x.name === 'virt-flop')) {
  for (const [w, hgt] of [[320, 568], [390, 844]]) {
    const page = await browser.newPage({ viewport: { width: w, height: hgt }, deviceScaleFactor: 1 });
    const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: { id: 101, first_name: 'Иван' }, start_param: sc.room.code }, TOKEN);
    await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdk(initData, sc.room.code) }));
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector('.table');
    await page.waitForTimeout(150);
    await page.evaluate(() => { const c = document.querySelector('.table .center'); c.style.left = '82%'; c.style.top = '30%'; });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(150);
    const found = problems(await page.evaluate(measure), sc);
    total++;
    if (found.length) {
      failures++;
      console.log(`уведённый ряд не вернулся ${w}×${hgt} ${sc.name}: ${found.join('; ')}`);
    }
    await page.close();
  }
}
await browser.close();
await web.close();
console.log(failures ? `\n${failures} из ${total} проверок с нарушениями` : `\nвсе ${total} проверок чисто`);
process.exit(failures ? 1 : 0);
