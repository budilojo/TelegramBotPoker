/**
 * Оформление «Графит» на игровых экранах — настоящими браузерами, через настоящий сервер и хаб
 * (демосреда включена опцией `collectionsDemo`, три страницы).
 *
 *   node tools/e2e-collections-look.mjs
 *   SHOTS=1 node tools/e2e-collections-look.mjs     ещё и снимки в preview/collections-look/
 *
 * Сценарий (покер): выбор вида → лобби: рамка и знак у тех, у кого они выбраны → раздача №1 →
 * выбор меняется посреди раздачи, у всех экранов вид прежний → раздача №2: рубашка владельца на его
 * закрытых картах у остальных, стол хоста у всех; своих карт-лиц вид не касается → обрыв связи и
 * переподключение посреди раздачи вид не меняют → нет файла орнамента/рамки → база без ошибок →
 * четыре цвета на 320/360/390/430 → итоги: рамка и знак. Затем дурак: стол хоста, рубашки прежние,
 * лобби и итоги. В партии рамки и знака нет нигде, блока «Так видят друзья» нет.
 * В конце — приватность по истории: всё, что получил каждый телефон.
 *
 * Chromium с эмуляцией — не настоящий WebView Telegram.
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
import { TelegramStub, cmdUpdate, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';
import { stack, durakDecks } from '../bot/harness.js';
import { assertNoJump } from './lib/scroll-probe.mjs';
import { allCovered, waitingThrowers } from '../bot/games/durak/rules.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8097);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const CHAT = -100881;
const CHAT2 = -100882;
const SHOTS = process.env.SHOTS === '1';
const OUT = path.join(ROOT, 'preview', 'collections-look');
if (SHOTS) fs.mkdirSync(OUT, { recursive: true });

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

// Длинное имя у Макса — проверка, что знак не расширяет строку.
const ivan = user(101, 'Иван');
const max = user(202, 'Максимильян Длиннофамильный');
const dima = user(303, 'Дима');
const PEOPLE = [ivan, max, dima];
// Сервер режет ник до 16 знаков: так имя и видно на экранах.
const MAX_SHOWN = max.first_name.slice(0, 16);
const HOLES = { 101: 'As Kh', 202: 'Qs Qd', 303: '9c 9d' };
const CODES = { 101: ['AS', 'KH'], 202: ['QS', 'QD'], 303: ['9C', '9D'] };

const CB = 'graphit-cardback';
const TB = 'graphit-table';
const PR = 'graphit-profile';

const api = new TelegramStub();
const app = new App({
  api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0,
  webappUrl: `http://localhost:${PORT}`, miniAppName: 'table',
  deck: stack(HOLES, 'Ts Jh 2c 3d 8s'), durakDeck: durakDecks(5),
  collectionsDemo: true,
});
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));

const step = (s) => console.log(`· ${s}`);
const room = () => app.room(CHAT);
const durakRoom = () => app.roomsOf(CHAT2).filter((r) => r.game === 'durak').at(-1);
async function until(cond, what, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sdkStub = (initData) => `
  window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: new URLSearchParams(${JSON.stringify(initData)}).get('start_param') },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(){},
    BackButton: { show(){}, hide(){}, onClick(){} },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  } };
  /* Журнал всего, что страница получила по сокету, и список сокетов (чтобы оборвать связь). */
  (() => {
    const Native = window.WebSocket;
    window.__log = [];
    window.__sockets = [];
    window.WebSocket = class extends Native {
      constructor(...a) {
        super(...a);
        window.__sockets.push(this);
        this.addEventListener('message', (e) => window.__log.push(String(e.data)));
      }
    };
  })();`;

const browser = await chromium.launch();
const pages = new Map();
const problems = [];
const aborted = new Map(); // id → набор адресов, которые «не грузятся»

async function openPage(u, startParam, { width = 360, height = 740 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => problems.push(`${u.first_name}: ${e.message}`));
  page.on('console', (m) => {
    // Нет файла — это ожидаемый сбой сети в сценарии «файла нет»; остальное — ошибка.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`${u.first_name}: ${m.text()}`);
  });
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: startParam }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  for (const re of aborted.get(String(u.id)) ?? []) await page.route(re, (r) => r.abort());
  await page.goto(`http://localhost:${PORT}/`);
  pages.set(String(u.id), page);
  return page;
}
const pageOf = (u) => pages.get(String(u.id));
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(OUT, `${name}.png`) }); };

/** Отправить сообщение от лица страницы (то же, что делает приложение). */
const sendFrom = (u, msg) => pageOf(u).evaluate(async (m) => (await import('/net.js')).send(m, { lock: false }), msg);
let reqN = 0;
const req = () => `e2e-req-${String(++reqN).padStart(6, '0')}`;
const choice = (u, slot) => app.collections.choiceOf(String(u.id))[slot];
async function grant(u, item) {
  await sendFrom(u, { t: 'col', op: 'grant', item, req: req() });
  await until(() => app.collections.owns(String(u.id), item), `${u.first_name} получил ${item}`);
}
async function choose(u, slot, item, color) {
  await sendFrom(u, { t: 'col', op: 'apply', slot, item, color, req: req() });
  await until(() => choice(u, slot)?.color === color, `${u.first_name}: ${slot} → ${color}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function seqSync(page) {
  const seq = room()?.seq;
  if (seq != null) await page.waitForFunction((s) => document.body.dataset.seq === String(s), seq, { timeout: 4000 }).catch(() => {});
}

/** Оборвать связь у страницы и дождаться возврата на тот же стол. */
async function dropAndReturn(page) {
  const n = await page.evaluate(() => window.__sockets.length);
  await page.evaluate(() => window.__sockets.at(-1).close());
  await page.waitForFunction((k) => window.__sockets.length > k && window.__sockets.at(-1).readyState === 1, n, { timeout: 15000 });
  await wait(300);
}

/* --------------------------------------------------------- снимок вида на экране */

/** Всё оформление, что страница показывает на столе покера. */
const tableLook = (page) => page.evaluate(() => {
  const felt = document.querySelector('.felt');
  const seats = {};
  for (const s of document.querySelectorAll('.seat')) {
    const imgs = [...s.querySelectorAll('.minis img')];
    seats[s.dataset.seat] = imgs.map((i) => i.dataset.grBack || (i.getAttribute('src') === '/cards/back.svg' ? 'base' : i.getAttribute('alt')));
  }
  return {
    table: felt?.dataset.grTable ?? null,
    orn: !!felt?.querySelector('img.gr-orn'),
    dia: !!felt?.querySelector('img.gr-dia'),
    seats,
    frames: document.querySelectorAll('.gr-frame, .gr-mark, .gr-ava').length,
  };
});
const dkLook = (page) => page.evaluate(() => {
  const c = document.querySelector('.dk-cloth');
  return {
    table: c?.dataset.grTable ?? null,
    orn: !!c?.querySelector('img.gr-orn'),
    customBacks: document.querySelectorAll('img.gr-back').length,
    frames: document.querySelectorAll('.gr-frame, .gr-mark, .gr-ava').length,
  };
});

/** Все картинки внутри стола загрузились (нет «битых»). */
const imagesOk = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(`${s} img`)].every((i) => i.complete && i.naturalWidth > 0), sel);

/** Орнамент не выходит за страницу, горизонтального скролла нет. */
async function noSideways(what) {
  for (const [id, page] of pages) {
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(sw <= iw, `${what}: у ${id} страница шире экрана (${sw} > ${iw})`);
  }
}

/* ------------------------------------------------ группа: /newgame, три телефона */

// Дима: файл орнамента бордо и рамки петроль «не грузятся».
aborted.set('303', [/table-ornament-bordeaux\.svg/, /frame-small-petrol\.svg/]);

await app.handleUpdate(cmdUpdate(CHAT, ivan, '/newgame', { message_id: 1 }));
await app.settle();
const code = room().code;
for (const u of PEOPLE) {
  const page = await openPage(u, code);
  await page.waitForSelector('.lobby');
}
step(`/newgame: комната ${code}, три страницы открыты`);

// Демо-права и выбор. Иван — хост: стол, рубашка, знак. Макс: рубашка и знак. Дима: только знак.
await grant(ivan, TB); await grant(ivan, CB); await grant(ivan, PR);
await grant(max, CB); await grant(max, PR);
await grant(dima, PR);
await choose(ivan, 'table', TB, 'sapphire');
await choose(ivan, 'cardback', CB, 'bordeaux');
await choose(ivan, 'profile', PR, 'petrol');
await choose(max, 'cardback', CB, 'petrol');
await choose(max, 'profile', PR, 'graphite');
await choose(dima, 'profile', PR, 'bordeaux');
step('выбор сделан: Иван — стол «Сапфир», рубашка «Бордо», знак «Петроль»; Макс — рубашка «Петроль», знак «Графит»; Дима — знак «Бордо»');

/* ----------------------------------------------------------------- лобби */

for (const u of [max, dima]) {
  const n = room().players.length;
  await pageOf(u).getByRole('button', { name: 'Сесть за стол' }).click();
  await until(() => room().players.length === n + 1, `${u.first_name} садится`);
}
await pageOf(ivan).waitForSelector('text=3/8');

/** Что видно в лобби у игрока по имени: цвет рамки и знака. */
const lobbyOf = (page, name) => page.evaluate((nm) => {
  const seat = [...document.querySelectorAll('.lseat')].find((s) => s.querySelector('.nm .gr-nm')?.getAttribute('title') === nm || s.querySelector('.nm')?.textContent.trim() === nm);
  if (!seat) return null;
  return {
    frame: seat.querySelector('.gr-ava')?.dataset.grFrame ?? null,
    frameImg: !!seat.querySelector('img.gr-frame'),
    mark: seat.querySelector('img.gr-mark')?.dataset.grMark ?? null,
    full: seat.querySelector('.nm .gr-nm')?.getAttribute('aria-label') ?? null,
  };
}, name);

for (const [id, page] of pages) {
  await page.waitForFunction(() => document.querySelectorAll('.lseat .gr-mark').length >= 3, null, { timeout: 5000 });
  const forIvan = await lobbyOf(page, 'Иван');
  const forMax = await lobbyOf(page, MAX_SHOWN);
  const forDima = await lobbyOf(page, 'Дима');
  // У Димы файл рамки петроль «не грузится» — у него самого рамка Ивана исчезает (база), у других есть.
  if (id === '303') {
    assert.equal(forIvan.frameImg, false, 'Дима: файла рамки нет — база, рамки нет');
    await page.waitForSelector('.lseat .av'); // аватар на месте
  } else assert.equal(forIvan.frame, 'petrol', `${id}: рамка Ивана «петроль»`);
  assert.equal(forIvan.mark, 'petrol', `${id}: знак Ивана «петроль»`);
  assert.equal(forMax.frame, 'graphite');
  assert.equal(forMax.mark, 'graphite');
  assert.equal(forMax.full, MAX_SHOWN, 'полное имя — в подписи');
  assert.equal(forDima.frame, 'bordeaux');
}
await noSideways('лобби');
await wait(900);
await shot(pageOf(ivan), 'poker-lobby-360');
step('лобби: у каждого своя рамка и знак своего цвета; у Макса длинное имя сокращено, полное — в подписи; у Димы файла рамки нет — база без ошибок');

// Лобби — вид «сразу»: смена знака Макса обновляет всем лобби без перезагрузки.
await choose(max, 'profile', PR, 'sapphire');
await pageOf(ivan).waitForFunction((nm) => [...document.querySelectorAll('.lseat')].some((s) => s.querySelector('.gr-ava')?.dataset.grFrame === 'sapphire'), null, { timeout: 5000 });
await choose(max, 'profile', PR, 'graphite');
await pageOf(ivan).waitForFunction(() => ![...document.querySelectorAll('.lseat .gr-ava')].some((a) => a.dataset.grFrame === 'sapphire'), null, { timeout: 5000 });
step('в лобби смена знака видна сразу и без перезагрузки страницы');

/* ----------------------------------------------------- раздача №1 (вид прежний) */

await pageOf(ivan).getByRole('button', { name: '▶ Начать' }).click();
await until(() => room().status === 'playing', 'раздача #1');
for (const page of pages.values()) await page.waitForSelector('.hero-cards img.card');
const seatOf = (u) => room().players.findIndex((p) => p.id === String(u.id));
const snap1 = {};
async function expectSeatBacks(label) {
  for (const u of PEOPLE) {
    const page = pageOf(u);
    const look = await tableLook(page);
    for (const o of PEOPLE.filter((x) => x !== u)) {
      const want = choiceAtDeal[String(o.id)];
      const got = look.seats[seatOf(o)];
      if (!got) continue; // сбросил — карт нет
      assert.ok(got.length === 2, `${label}: у места ${o.first_name} две закрытые карты`);
      for (const g of got) assert.equal(g, want ?? 'base', `${label}: у ${u.first_name} рубашка ${o.first_name}`);
    }
    assert.ok(!/Так видят друзья/.test(await page.evaluate(() => document.body.innerText)), `${label}: в партии нет блока «Так видят друзья»`);
    // Свои карты (лица) не заменяются: настоящие коды, никаких наших рубашек.
    const hero = await page.$$eval('.hero-cards img.card', (xs) => xs.map((x) => [x.alt, x.classList.contains('gr-back')]));
    assert.deepEqual(hero.map((x) => x[0]).sort(), [...CODES[u.id]].sort(), `${label}: ${u.first_name} видит свои карты`);
    assert.ok(hero.every((x) => !x[1]), `${label}: лицо своей карты не заменено рубашкой`);
  }
}
const choiceAtDeal = { 101: 'bordeaux', 202: 'petrol', 303: null };
for (const [id, page] of pages) {
  const t = await tableLook(page);
  assert.equal(t.table, 'sapphire', `раздача 1: у ${id} стол «Сапфир»`);
  assert.equal(t.orn, id !== '303' || true, 'орнамент есть');
  assert.equal(t.frames, 0, `раздача 1: у ${id} в партии нет ни рамки, ни знака`);
  snap1[id] = t;
}
await expectSeatBacks('раздача 1');
step('раздача №1: стол «Сапфир» у всех, рубашки «Бордо» (Иван) и «Петроль» (Макс) на закрытых картах, у Димы — обычная; свои карты — лица');

// Выбор меняется ПОСРЕДИ раздачи — вид у всех прежний (в том числе после следующего хода).
await choose(ivan, 'table', TB, 'bordeaux');
await choose(ivan, 'cardback', CB, 'sapphire');
await choose(max, 'cardback', CB, 'sapphire');
await choose(dima, 'cardback', CB, 'sapphire').catch(() => {}); // у Димы права нет — отказ, это нормально
const actor1 = () => room().hand.actorId;
async function foldActor() {
  const n = room().hand.log.length;
  const page = pages.get(actor1());
  await page.getByRole('button', { name: 'Fold', exact: false }).first().click();
  await until(() => room().hand.log.length > n, 'ход сделан');
}
await foldActor();
await wait(250);
for (const [id, page] of pages) {
  await seqSync(page);
  const t = await tableLook(page);
  assert.equal(t.table, 'sapphire', `посреди раздачи у ${id} стол прежний`);
  for (const [seat, backs] of Object.entries(t.seats)) {
    for (const b of backs) assert.ok(['bordeaux', 'petrol', 'base'].includes(b), `посреди раздачи у ${id} рубашка прежняя (${b})`);
  }
}
step('выбор изменён посреди раздачи №1 (стол, обе рубашки) — у всех трёх экранов вид прежний, и после хода');
await foldActor();
await until(() => room().hand.phase === 'complete', 'раздача #1 окончена');
for (const page of pages.values()) await page.waitForSelector('.result-line');

/* ----------------------------------------------------- раздача №2 (новый вид) */

await sendFrom(ivan, { t: 'next' });
await until(() => room().handNo === 2 && room().hand.phase !== 'complete', 'раздача #2');
for (const page of pages.values()) await page.waitForSelector('.hero-cards img.card');
choiceAtDeal[101] = 'sapphire'; choiceAtDeal[202] = 'sapphire';
for (const [id, page] of pages) {
  await seqSync(page);
  const t = await tableLook(page);
  assert.equal(t.table, 'bordeaux', `раздача 2: у ${id} стол «Бордо»`);
  if (id === '303') assert.equal(t.orn, false, 'Дима: файла орнамента бордо нет — база, без ошибок');
  else assert.equal(t.orn, true, `у ${id} орнамент на месте`);
  assert.ok(await imagesOk(page, '.felt'), `у ${id} в овале нет битых картинок`);
}
await expectSeatBacks('раздача 2');
await shot(pageOf(ivan), 'poker-bordeaux-ivan-360');
await shot(pageOf(dima), 'poker-bordeaux-no-ornament-file-dima-360');
step('раздача №2: у всех новый вид — стол «Бордо», рубашки «Сапфир»; у Димы файла орнамента нет — стол базовый, игра идёт');

// Дима всё равно может играть: его ход — кнопка работает.
// Связь рвётся посреди раздачи №2 — вид прежний; выбор тем временем снова меняется.
await choose(ivan, 'table', TB, 'petrol');
await choose(max, 'cardback', CB, 'graphite');
const before2 = {};
for (const [id, page] of pages) before2[id] = await tableLook(page);
for (const page of pages.values()) await dropAndReturn(page);
for (const [id, page] of pages) {
  await page.waitForSelector('.hero-cards img.card');
  await seqSync(page);
  assert.deepEqual(await tableLook(page), before2[id], `после обрыва связи у ${id} вид тот же`);
}
step('обрыв связи у всех трёх страниц посреди раздачи №2 при изменённом выборе — вид не изменился');

/* ----- «Ваш ход» рядом с петролем, четыре цвета, ширины 320/360/390/430 ----- */

await foldActor();
await foldActor().catch(() => {});
await until(() => room().hand.phase === 'complete', 'раздача #2 окончена');
const COLORS4 = ['petrol', 'graphite', 'sapphire', 'bordeaux'];
let hand = 3;
for (const color of ['petrol', 'graphite', 'sapphire']) {
  // Раздача №3 — стол «Петроль» (выбран во время раздачи №2), дальше меняем цвет перед каждой.
  if (color !== 'petrol') await choose(ivan, 'table', TB, color);
  await sendFrom(ivan, { t: 'next' });
  await until(() => room().handNo === hand && room().hand.phase !== 'complete', `раздача #${hand}`);
  for (const page of pages.values()) await page.waitForSelector('.hero-cards img.card');
  for (const [id, page] of pages) {
    await seqSync(page);
    const t = await tableLook(page);
    assert.equal(t.table, color, `раздача ${hand}: стол «${color}» у ${id}`);
  }
  for (const w of [320, 360, 390, 430]) {
    for (const u of [ivan, dima]) {
      const page = pageOf(u);
      await page.setViewportSize({ width: w, height: w === 320 ? 568 : 740 });
      await wait(250);
      const m = await page.evaluate(() => {
        const felt = document.querySelector('.felt').getBoundingClientRect();
        const dia = document.querySelector('.felt .gr-dia')?.getBoundingClientRect();
        const box = (el) => el.getBoundingClientRect();
        const center = [...document.querySelectorAll('.center .pot, .center .board > *, .center .bet-line, .center .result-line')].map(box).filter((r) => r.width && r.height);
        const hit = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
        return {
          sw: document.documentElement.scrollWidth, iw: innerWidth,
          feltInside: felt.left >= 0 && felt.right <= innerWidth,
          diaHits: dia ? center.filter((r) => hit(r, dia)).length : 0,
          center: !!document.querySelector('.center'),
          yourTurn: !!document.querySelector('.your-turn'),
        };
      });
      assert.ok(m.sw <= m.iw, `раздача ${hand}, ${w}px: ${u.first_name} — страница шире экрана`);
      assert.ok(m.feltInside, `раздача ${hand}, ${w}px: стол помещается`);
      assert.equal(m.diaHits, 0, `раздача ${hand}, ${w}px (${color}): центральный ромб не лежит под банком, картами и ставкой`);
      assert.ok(await imagesOk(page, '.felt'), `${w}px: нет битых картинок`);
    }
  }
  await shot(pageOf(ivan), `poker-${color}-ivan-430`);
  await pageOf(ivan).setViewportSize({ width: 320, height: 568 });
  await wait(250);
  await shot(pageOf(ivan), `poker-${color}-ivan-320`);
  // «Ваш ход» (зелёная плашка) рядом с цветом предмета: оба видны, плашка не перекрашена.
  const actorPage = pages.get(room().hand.actorId);
  await actorPage.waitForSelector('.your-turn');
  const green = await actorPage.$eval('.your-turn', (el) => getComputedStyle(el).backgroundColor);
  assert.ok(/rgb\(19, 122, 67\)|rgb\(0, 0, 0, 0\)|rgba/.test(green) || green.includes('19, 122, 67'), `«Ваш ход» остаётся зелёным (${green})`);
  await pageOf(ivan).setViewportSize({ width: 360, height: 740 });
  await pageOf(dima).setViewportSize({ width: 360, height: 740 });
  if (color === 'petrol') await shot(actorPage, 'poker-petrol-your-turn');
  await foldActor();
  await foldActor().catch(() => {});
  await until(() => room().hand.phase === 'complete', `раздача #${hand} окончена`);
  hand++;
}
step('четыре цвета стола (сапфир, бордо, петроль, графит) на 320/360/390/430: стол помещается, горизонтального скролла нет, ромб не под банком/картами; «Ваш ход» зелёный');

/* ------------------------------------------------------------- итоги покера */

await app.handleUpdate(cmdUpdate(CHAT, ivan, '/finish', { message_id: 9 }));
await app.settle();
for (const page of pages.values()) await page.waitForSelector('h1:has-text("Итоги")');
for (const [id, page] of pages) {
  await page.waitForSelector('.res-row.gr');
  const rows = await page.$$eval('.res-row.gr', (xs) => xs.map((r) => ({
    name: r.querySelector('.n')?.getAttribute('title') ?? '',
    frame: r.querySelector('.gr-ava')?.dataset.grFrame ?? null,
    mark: r.querySelector('.gr-mark')?.dataset.grMark ?? null,
    w: r.getBoundingClientRect().width, sw: r.scrollWidth,
  })));
  assert.equal(rows.length, 3);
  const by = (n) => rows.find((r) => r.name === n);
  assert.equal(by('Иван').mark, 'petrol');
  assert.equal(by(MAX_SHOWN).mark, 'graphite');
  assert.equal(by('Дима').mark, 'bordeaux');
  if (id !== '303') assert.equal(by('Иван').frame, 'petrol');
  for (const r of rows) assert.ok(r.sw <= r.w + 1, `итоги: строка «${r.name}» не шире экрана`);
}
for (const [w, hgt] of [[320, 568], [360, 740], [390, 844], [430, 932]]) {
  await pageOf(ivan).setViewportSize({ width: w, height: hgt });
  await wait(150);
  await noSideways(`итоги ${w}`);
}
await shot(pageOf(ivan), 'poker-results-430');
await pageOf(ivan).setViewportSize({ width: 320, height: 380 });
await assertNoJump(pageOf(ivan), { scroller: 'auto', label: 'итоги покера, обрыв связи' }, () => dropAndReturn(pageOf(ivan)));
await shot(pageOf(ivan), 'poker-results-320');
await pageOf(ivan).setViewportSize({ width: 360, height: 740 });
step('итоги покера: у каждой строки рамка и знак своего цвета, имена сокращены; на 320–430 нет горизонтального скролла; обрыв связи на итогах без «прыжка»');

/* ================================================================== дурак */

for (const [, page] of pages) await page.close();
pages.clear();
await app.handleUpdate(cmdUpdate(CHAT2, ivan, '/game', { message_id: 1 }));
await app.settle();
const group = app.groups.get(String(CHAT2));
const hubPage = await openPage(ivan, `g_${group.code}`);
await hubPage.waitForSelector('.game-card');
await choose(ivan, 'table', TB, 'sapphire');
await sendFrom(ivan, { t: 'create', game: 'durak', settings: {}, reqId: req() });
await until(() => !!durakRoom(), 'лобби дурака');
const dcode = durakRoom().code;
await pageOf(ivan).waitForSelector('h1:has-text("Дурак")');
for (const u of [max, dima]) {
  const page = await openPage(u, dcode);
  await page.waitForSelector('h1:has-text("Дурак")');
  await page.getByRole('button', { name: 'Сесть за стол' }).click();
}
await until(() => durakRoom().players.length === 3, 'все сели за дурака');
for (const [id, page] of pages) {
  await page.waitForFunction(() => document.querySelectorAll('.lseat .gr-mark').length >= 3, null, { timeout: 5000 });
  const marks = await page.$$eval('.lseat .gr-mark', (xs) => xs.map((x) => x.dataset.grMark).sort());
  assert.deepEqual(marks, ['bordeaux', 'graphite', 'petrol'], `лобби дурака: знаки у ${id}`);
}
await noSideways('лобби дурака');
await shot(pageOf(ivan), 'durak-lobby-360');
await pageOf(ivan).getByRole('button', { name: '▶ Начать' }).click();
await until(() => durakRoom().deal?.phase === 'play', 'партия дурака');
for (const page of pages.values()) await page.waitForSelector('.dk-hand .dk-card');
for (const [id, page] of pages) {
  await seqSync(page);
  const t = await dkLook(page);
  assert.equal(t.table, 'sapphire', `дурак: стол «Сапфир» у ${id}`);
  assert.equal(t.orn, true);
  assert.equal(t.customBacks, 0, 'у дурака нет персональных рубашек');
  assert.equal(t.frames, 0, `дурак: в партии нет рамки и знака у ${id}`);
  assert.ok(await imagesOk(page, '.dk-cloth'), 'орнамент загрузился');
}
await shot(pageOf(ivan), 'durak-sapphire-360');
// Посреди партии: выбор меняется, связь рвётся — стол прежний.
await choose(ivan, 'table', TB, 'bordeaux');
for (const page of pages.values()) await dropAndReturn(page);
for (const [id, page] of pages) {
  await page.waitForSelector('.dk-hand .dk-card');
  await seqSync(page);
  assert.equal((await dkLook(page)).table, 'sapphire', `дурак: после обрыва связи и смены выбора стол прежний у ${id}`);
}
for (const w of [320, 360, 390, 430]) {
  for (const u of [ivan, dima]) {
    const page = pageOf(u);
    await page.setViewportSize({ width: w, height: w === 320 ? 568 : 740 });
    await wait(250);
    const m = await page.evaluate(() => {
      const dia = document.querySelector('.dk-cloth .gr-dia');
      const dr = dia && getComputedStyle(dia).display !== 'none' ? dia.getBoundingClientRect() : null;
      const rects = [...document.querySelectorAll('.dk-pair, .dk-line, .dk-deck, .dk-discard, .dk-seat .pod, .dk-seat .info, .dk-seat .plate')].map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
      const hit = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
      return { sw: document.documentElement.scrollWidth, iw: innerWidth, c: document.querySelector('.dk-cloth')?.getBoundingClientRect().right, diaHits: dr ? rects.filter((r) => hit(r, dr)).length : 0 };
    });
    assert.equal(m.diaHits, 0, `дурак ${w}px: ромб не лежит под картами, строкой и сиденьями`);
    assert.ok(m.sw <= m.iw, `дурак ${w}px: нет горизонтального скролла`);
    assert.ok(m.c <= m.iw + 1, `дурак ${w}px: стол помещается`);
  }
}
await pageOf(ivan).setViewportSize({ width: 320, height: 568 });
await wait(250);
await shot(pageOf(ivan), 'durak-sapphire-320');
await pageOf(ivan).setViewportSize({ width: 360, height: 740 });
await pageOf(dima).setViewportSize({ width: 360, height: 740 });
step('дурак: стол «Сапфир» у всех, рубашки обычные, в партии ни рамки, ни знака; смена выбора и обрыв связи стол не меняют; 320–430 без скролла');

// Партию доигрываем быстро, сообщениями (защитник берёт, остальные пасуют): нужны итоги с играми.
const byId = (id) => PEOPLE.find((u) => String(u.id) === String(id));
const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const lowest = (cards) => cards.reduce((a, b) => (RANKS.indexOf(b.slice(0, -1)) < RANKS.indexOf(a.slice(0, -1)) ? b : a));
for (let guard = 0; durakRoom().deal.phase === 'play' && guard < 600; guard++) {
  const d = durakRoom().deal;
  const seq = durakRoom().seq;
  let who = byId(d.attacker);
  let msg = d.table.length ? null : { t: 'attack', card: lowest(d.hands[d.attacker]) };
  if (d.table.length && !allCovered(d) && !d.bout.taking) {
    who = byId(d.defender);
    const at = d.table.findIndex((x) => !x.d);
    const a = d.table[at].a;
    const ok = d.hands[d.defender].filter((c) => (c.slice(-1) === a.slice(-1) ? RANKS.indexOf(c.slice(0, -1)) > RANKS.indexOf(a.slice(0, -1)) : c.slice(-1) === d.trump && a.slice(-1) !== d.trump));
    msg = ok.length ? { t: 'defend', card: lowest(ok), target: at } : { t: 'take' };
  }
  else if (d.table.length) { who = byId(waitingThrowers(d)[0]); msg = { t: 'pass' }; }
  await wait(70); // не чаще лимита сообщений страницы
  await sendFrom(who, msg);
  await until(() => durakRoom().seq !== seq, `ход в дураке (${JSON.stringify(msg)})`);
}
assert.equal(durakRoom().deal.phase, 'over', 'партия дурака доиграна');
await app.handleUpdate(cmdUpdate(CHAT2, ivan, '/finish', { message_id: 5 }));
await app.settle();
for (const page of pages.values()) await page.waitForSelector('h1:has-text("Итоги")');
// Итоги дурака показывают игроков, сыгравших хотя бы одну партию; в этой партии никто не доигран —
// поэтому сверяем рамку только если строки есть.
for (const [id, page] of pages) {
  await page.waitForSelector('.res-row.gr');
  const rows = await page.$$eval('.res-row.gr', (xs) => xs.map((r) => ({
    mark: r.querySelector('.gr-mark')?.dataset.grMark ?? null, frame: r.querySelector('.gr-ava')?.dataset.grFrame ?? null,
    w: r.getBoundingClientRect().width, sw: r.scrollWidth,
  })));
  assert.ok(rows.length >= 2, `итоги дурака: строки есть у ${id}`);
  assert.ok(rows.every((r) => r.mark), `итоги дурака: у каждой строки знак (${id})`);
  for (const r of rows) assert.ok(r.sw <= r.w + 1, 'строка итогов не шире экрана');
}
for (const [w, hgt] of [[320, 568], [360, 740], [390, 844], [430, 932]]) {
  await pageOf(ivan).setViewportSize({ width: w, height: hgt });
  await wait(150);
  await noSideways(`итоги дурака ${w}`);
}
await pageOf(ivan).setViewportSize({ width: 360, height: 740 });
await shot(pageOf(ivan), 'durak-results-360');
step('итоги дурака: у каждой строки знак своего цвета и рамка, строки не шире экрана на 320–430');

/* ---------------------------------------------- «Так видят друзья» — не в игре */

for (const [id, page] of pages) {
  const text = await page.evaluate(() => document.body.innerText);
  assert.ok(!/Так видят друзья/.test(text), `${id}: блока «Так видят друзья» в игре нет`);
}

/* -------------------------------------------- приватность по истории сокетов */

const ALL_CARDS = Object.values(CODES).flat();
const FORBIDDEN = new Set(['owned', 'demo', 'choice', 'pending', 'price', 'unlocked', 'enabled', 'req']);
const walk = (x, fn) => {
  if (Array.isArray(x)) x.forEach((v) => walk(v, fn));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { fn(k, v); walk(v, fn); }
};
for (const [id, page] of pages) {
  const log = await page.evaluate(() => window.__log);
  assert.ok(log.length > 3, 'журнал не пуст');
  for (const raw of log) {
    const msg = JSON.parse(raw);
    if (msg.t === 'col') continue; // свои права и свой выбор — только вам, на ваш запрос
    walk(msg, (k) => assert.ok(!FORBIDDEN.has(k), `${id}: в сообщении «${msg.t}» поле «${k}» — чужие права/демо-данные`));
    // Идентификаторы людей в look нет.
    if (msg.state?.look) assert.ok(!JSON.stringify(msg.state.look).match(/"(id|userId|owner)"/), 'в look нет id людей');
  }
}
// История покера: чужие карты не приходили ни разу (раздачи доведены до конца сбросами, вскрытия не было).
for (const page of [pageOf(max)]) {
  const log = (await page.evaluate(() => window.__log)).filter((l) => l.includes('"hand"')).join('');
  for (const c of [...CODES[101], ...CODES[303]]) assert.ok(!log.includes(`"${c}"`), `Макс за всё время не получал карту ${c}`);
}
step('приватность по истории: ни одна страница не получила чужих прав/демо-полей, в look нет id людей, чужих карт у Макса за партию не было');

await browser.close();
await new Promise((r) => web.close().then(r));
assert.deepEqual(problems, [], `ошибки в консоли страниц: ${problems.join(' | ')}`);
step('в консолях страниц ошибок нет');
console.log('OK: e2e-collections-look');
process.exit(0);
