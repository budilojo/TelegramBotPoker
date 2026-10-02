/**
 * Стол «Радуги» в настоящем браузере: живой ли экран.
 *
 *   node tools/colors-check.mjs            → отчёт; выход 1 при любой ошибке
 *   node tools/colors-check.mjs --shots    → ещё и снимки в preview/colors/
 *
 * Зачем отдельно от layout-check: тот меряет налезания у покера и дурака, а
 * здесь проверяется другое — что экран вообще поднимается и ведёт себя так,
 * как написано в ТЗ. Руками это не проверить: экран собирается из состояния,
 * которого в тестах на правила нет.
 *
 * Проверяется ровно то, что обещано:
 *   1. ни одной ошибки в консоли и ни одного падения страницы;
 *   2. в руке столько карт, сколько сдали, и поднятые — ровно те, что
 *      сервер назвал играбельными;
 *   3. не мой ход — не поднята ни одна;
 *   4. нечего положить — колода пульсирует;
 *   5. шторка цвета открывается и в ней четыре плашки с фигурами;
 *   6. рука не вылезает за край экрана ни на одном размере;
 *   7. у каждой карты в руке своя картинка и она загрузилась.
 *
 * Нужен Playwright с Chromium, как tools/preview.mjs. Токен одноразовый,
 * Telegram заменён тестовой заглушкой.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { startServer } from '../bot/server.js';
import { TelegramStub } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';
import * as C from '../bot/games/colors/rules.js';
import { shuffled } from '../bot/games/colors/cards.js';
import { seededRng } from '../bot/deck.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.COLORS_PORT || 8099);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const SHOTS = process.argv.includes('--shots') || process.env.SHOTS === '1';
const OUT = path.join(ROOT, 'preview', 'colors');

const VIEWPORTS = [[320, 568], [375, 667], [390, 844], [430, 932], [768, 1024]];
const NAMES = ['Иван', 'Константин', 'Александра', 'Ёж', 'Макс', 'Дима', 'Lev', 'Марина'];

const api = new TelegramStub();
const app = new App({ api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, webappUrl: `http://localhost:${PORT}` });
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);

let chat = -100900;
function tableOf(n, seed) {
  const chatId = String(chat--);
  const room = app.createGame('colors', { chatId, title: 'Проверка', host: { id: 101, tgId: 101, name: NAMES[0] } });
  for (let i = 1; i < n; i++) C.addPlayer(room, { id: 101 + i, tgId: 101 + i, name: NAMES[i], dm: 'ok' });
  C.updateSettings(room, '101', { turnSeconds: 60 });
  const rnd = seededRng(seed);
  C.startGame(room, '101', { deck: () => shuffled(rnd), randInt: rnd });
  return room;
}

/** Повернуть стол так, чтобы ходил Иван (его страницу мы и открываем). */
function giveTurnToHero(room) {
  room.deal.turn = '101';
  room.deal.step += 1;
}

const scenes = [];

// Обычный ход героя при разном числе игроков.
for (const n of [2, 3, 5, 8]) {
  const room = tableOf(n, 40 + n);
  giveTurnToHero(room);
  scenes.push({ name: `${n}p-turn`, room, hero: '101' });
}

// Не мой ход: не должна быть поднята ни одна карта.
{
  const room = tableOf(4, 61);
  room.deal.turn = '102';
  scenes.push({ name: 'not-my-turn', room, hero: '101', expect: { lifted: 0 } });
}

// Нечего положить: колода обязана пульсировать.
{
  const room = tableOf(3, 62);
  giveTurnToHero(room);
  room.deal.top = 'R5';
  room.deal.color = 'R';
  room.deal.hands['101'] = ['G1', 'G3', 'G4', 'G6', 'G7']; // ни красных, ни пятёрок, ни бесцветных
  scenes.push({ name: 'nothing-fits', room, hero: '101', expect: { lifted: 0, pulse: true } });
}

// Большая рука: одна строка с прокруткой и счётчик «N подходят».
{
  const room = tableOf(3, 63);
  giveTurnToHero(room);
  room.deal.top = 'G5';
  room.deal.color = 'G';
  room.deal.hands['101'] = ['G1', 'G2', 'G3', 'G4', 'G6', 'G7', 'G8', 'G9', 'R5', 'Y5', 'B5', 'WC', 'WF', 'R1', 'Y2', 'B3', 'R7', 'Y8'];
  scenes.push({ name: 'big-hand', room, hero: '101', expect: { counter: true } });
}

// Накопление на куче: крупное «+4» поверх.
{
  const room = tableOf(3, 64);
  giveTurnToHero(room);
  room.deal.top = 'GP';
  room.deal.color = 'G';
  room.deal.pending = 4;
  room.deal.pendingKind = 'P';
  room.deal.hands['101'] = ['BP', 'WF', 'R1', 'Y2'];
  scenes.push({ name: 'stacked', room, hero: '101', expect: { pending: '+4' } });
}

// Чужая одна карта и открытое окно «Поймал!».
{
  const room = tableOf(3, 65);
  room.deal.turn = '101';
  room.deal.hands['102'] = ['G1'];
  scenes.push({
    name: 'catch', room, hero: '101', expect: { catchBtn: true },
    before: () => { room.deal.call = { id: '102', at: app.clock.now(), called: false }; },
  });
}

// Своя одна карта: кнопка «Радуга!».
{
  const room = tableOf(3, 66);
  room.deal.turn = '102';
  room.deal.hands['101'] = ['G1'];
  scenes.push({
    name: 'rainbow', room, hero: '101', expect: { rainbowBtn: true },
    before: () => { room.deal.call = { id: '101', at: app.clock.now(), called: false }; },
  });
}

// Лобби и итоги — те же экраны, они тоже обязаны подниматься.
{
  const chatId = String(chat--);
  const lobby = app.createGame('colors', { chatId, title: 'Проверка', host: { id: 101, tgId: 101, name: NAMES[0] } });
  for (let i = 1; i < 4; i++) C.addPlayer(lobby, { id: 101 + i, tgId: 101 + i, name: NAMES[i], dm: 'ok' });
  scenes.push({ name: 'lobby', room: lobby, hero: '101', lobby: true });

  const over = tableOf(4, 67);
  over.deal.phase = 'over';
  over.deal.loser = over.deal.order[1];
  over.deal.out = [...over.deal.order.filter((id) => id !== over.deal.order[1]), over.deal.order[1]];
  over.history.push({ no: 1, loser: over.deal.order[1], aborted: false, out: [...over.deal.out], quit: [] });
  for (const p of over.players) p.stats = { games: 1, last: 0, wins: 0, forced: 4, drew: 3, wilds: 1 };
  over.players[1].stats.last = 1;
  over.players[0].stats.wins = 1;
  scenes.push({ name: 'over', room: over, hero: '101' });

  const done = tableOf(3, 68);
  done.deal.phase = 'over';
  done.deal.loser = done.deal.order[1];
  done.history.push({ no: 1, loser: done.deal.order[1], aborted: false, out: [...done.deal.order], quit: [] });
  for (const p of done.players) p.stats = { games: 2, last: 0, wins: 1, forced: 9, drew: 0, wilds: 4 };
  done.players[1].stats.last = 2;
  C.endGame(done, '101');
  scenes.push({ name: 'results', room: done, hero: '101' });
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
    BackButton: { show(){}, hide(){}, onClick(){} },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  } };`;

const initDataFor = (id, name, code) =>
  signInitData({ auth_date: Math.floor(Date.now() / 1000), user: { id: Number(id), first_name: name, is_bot: false }, start_param: code }, TOKEN);

/** Всё, что меряется на экране «Радуги». */
function probe() {
  const n = (sel) => document.querySelectorAll(sel).length;
  const hand = document.querySelector('.cl-hand');
  const fan = document.querySelector('.cl-fan');
  const imgs = [...document.querySelectorAll('.cl-card img')];
  return {
    felt: n('.cl-felt'),
    lobby: n('.lobby'),
    cards: n('.cl-card'),
    lifted: n('.cl-card.up'),
    pulse: n('.cl-deck.pulse'),
    counter: document.querySelector('.cl-fits')?.textContent || '',
    pending: document.querySelector('.cl-pending')?.textContent || '',
    catchBtn: n('.cl-catch'),
    rainbowBtn: n('.btn.rainbow'),
    seats: n('.cl-seat'),
    events: n('.cl-ev'),
    shapes: n('.cl-shape'),
    pickBtns: n('.cl-pick-btn'),
    // Рука не должна вылезать за край экрана: она прокручивается, а страница — нет.
    handOverflow: hand ? Math.max(0, Math.round(fan.getBoundingClientRect().width - hand.clientWidth)) : 0,
    pageOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    brokenImgs: imgs.filter((im) => im.complete && im.naturalWidth === 0).length,
    loadedImgs: imgs.filter((im) => im.naturalWidth > 0).length,
    seq: document.body.dataset.seq,
    // Тост прибит к верху общими стилями, а здесь наверху сидят соперники:
    // он не имеет права накрыть ни одного из них.
    toastOnSeats: (() => {
      const t = document.querySelector('#toast');
      if (!t) return 0;
      const b = t.getBoundingClientRect();
      if (!b.height) return 0;
      return [...document.querySelectorAll('.cl-seat')].filter((el) => {
        const r = el.getBoundingClientRect();
        return b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom;
      }).length;
    })(),
  };
}

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const browser = await chromium.launch();
const problems = [];
const say = (ok, what) => {
  if (!ok) problems.push(what);
  return !!ok;
};
if (SHOTS) fs.mkdirSync(OUT, { recursive: true });

const rows = [];
for (const scene of scenes) {
  const line = [];
  for (const [w, hgt] of VIEWPORTS) {
    scene.before?.();
    const page = await browser.newPage({ viewport: { width: w, height: hgt }, deviceScaleFactor: 1 });
    const errors = [];
    const ours = (text) => !/telegram\.org|net::ERR_FAILED/.test(text);
    page.on('console', (m) => m.type() === 'error' && ours(m.text()) && errors.push(m.text()));
    page.on('pageerror', (e) => ours(String(e)) && errors.push(String(e)));
    // Настоящий SDK с telegram.org перетёр бы заглушку: внутри Telegram он
    // есть и нужен, а здесь хозяин — наш.
    await page.route('https://telegram.org/**', (r) => r.abort());
    await page.addInitScript(sdk(initDataFor(scene.hero, NAMES[0], scene.room.code), scene.room.code));
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector(scene.lobby || scene.room.status !== 'playing' ? '.lobby' : '.cl-felt', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(260); // анимации успевают отыграть

    const p = await page.evaluate(probe);
    // Снимок до шторки: на нём должен быть стол, а не то, что мы на нём нажали.
    if (SHOTS && w === 390) await page.screenshot({ path: path.join(OUT, `${scene.name}.png`) });
    const tag = `${scene.name} ${w}×${hgt}`;
    let ok = true;
    const need = (cond, what) => { ok = say(cond, what) && ok; };
    need(!errors.length, `${tag}: ошибки в консоли — ${errors.slice(0, 2).join(' | ')}`);
    need(!p.brokenImgs, `${tag}: ${p.brokenImgs} картинок карт не загрузилось`);
    need(p.pageOverflow === 0, `${tag}: страница шире экрана на ${p.pageOverflow}px`);
    need(p.toastOnSeats === 0, `${tag}: подсказка накрыла соперников (${p.toastOnSeats})`);

    if (scene.lobby || scene.room.status === 'finished') {
      need(p.lobby > 0, `${tag}: экран не собрался`);
    } else if (scene.room.deal.phase === 'over') {
      // Партия кончилась: вместо руки — счёт, и это другой экран.
      need(p.felt > 0, `${tag}: стол не собрался`);
      need(p.cards === 0, `${tag}: после партии рука должна уступить место счёту`);
    } else {
      need(p.felt > 0, `${tag}: стол не собрался`);
      need(p.cards === scene.room.deal.hands[scene.hero].length, `${tag}: карт в руке ${p.cards}, а сдали ${scene.room.deal.hands[scene.hero].length}`);
      need(p.loadedImgs === p.cards, `${tag}: загрузилось ${p.loadedImgs} картинок из ${p.cards}`);
      need(p.seats === scene.room.deal.order.length - 1, `${tag}: мест ${p.seats}, а соперников ${scene.room.deal.order.length - 1}`);

      // Подняты ровно те, что сервер назвал играбельными.
      const legal = C.legalFor(scene.room, scene.hero, { now: Date.now() });
      const want = scene.expect?.lifted ?? new Set(legal.play).size;
      need(p.lifted === want, `${tag}: поднято ${p.lifted}, а можно положить ${want}`);
      if (scene.expect?.pulse) need(p.pulse === 1, `${tag}: колода не пульсирует, хотя класть нечего`);
      if (scene.expect?.counter) need(/подход/.test(p.counter), `${tag}: нет счётчика «N подходят» (${p.counter})`);
      if (scene.expect?.pending) need(p.pending === scene.expect.pending, `${tag}: на куче «${p.pending}», а ждали «${scene.expect.pending}»`);
      if (scene.expect?.catchBtn) need(p.catchBtn === 1, `${tag}: нет кнопки «Поймал!»`);
      if (scene.expect?.rainbowBtn) need(p.rainbowBtn === 1, `${tag}: нет кнопки «Радуга!»`);
      need(p.shapes > 0, `${tag}: фигур цвета на экране нет`);

      // Шторка цвета — только там, где есть что ею класть.
      if (legal.play.some((c) => c === 'WC' || c === 'WF')) {
        const wild = legal.play.find((c) => c === 'WC' || c === 'WF');
        // Настоящий тап, а не синтетическое событие: карта играется, только
        // если палец отпустили НА ней, и координаты тут и проверяются.
        // Тап по ВИДИМОЙ полоске карты: в плотном веере правый край каждой
        // карты накрыт соседней, и палец попадает именно по левому краю.
        await page.locator(`.cl-card[data-card="${wild}"]`).first()
          .click({ force: true, position: { x: 6, y: 24 } });
        await page.waitForTimeout(200);
        const picks = await page.evaluate(() => document.querySelectorAll('.cl-pick-btn').length);
        const marks = await page.evaluate(() => document.querySelectorAll('.cl-pick-btn .cl-shape').length);
        need(picks === 4, `${tag}: в шторке ${picks} плашек вместо четырёх`);
        need(marks === 4, `${tag}: на плашках ${marks} фигур вместо четырёх`);
      }
    }
    line.push(ok ? '·' : '✗');
    await page.close();
  }
  rows.push([scene.name, line.join(' ')]);
}

await browser.close();
web.server.close();
app.stop();

const wide = Math.max(...rows.map((r) => r[0].length)) + 2;
console.log('\n' + ' '.repeat(wide) + VIEWPORTS.map(([w, h]) => `${w}×${h}`.padEnd(9)).join(''));
for (const [name, line] of rows) console.log(name.padEnd(wide) + line.split(' ').map((c) => `   ${c}     `).join(''));

if (problems.length) {
  console.log(`\n${problems.length} замечаний:`);
  for (const p of problems.slice(0, 40)) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('\nэкран «Радуги» живой');
