/**
 * Durak played by real browsers, the whole way: `/game` in the group → the
 * hub in the Mini App → «Дурак» → «Создать лобби» → a friend joins from the
 * hub, another by the lobby's card → the host starts → a whole game played
 * by TAPPING cards and buttons → the durak on every screen and in the group
 * → the results. Then a transfer in perevodnoy, by the «Перевести» button.
 *
 *   node tools/e2e-durak.mjs
 *
 * The same page, socket, hub and bot that run for real; Telegram replaced by
 * the test stub, the bot token by a throwaway one. Needs Playwright with
 * Chromium, like tools/e2e.mjs. Exits non-zero on the first thing wrong.
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
import { durakDecks, durakStack } from '../bot/harness.js';
import { allCovered, waitingThrowers } from '../bot/games/durak/rules.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8092);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const CHAT = -100778;

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

const api = new TelegramStub();
const app = new App({
  api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0,
  webappUrl: `http://localhost:${PORT}`, miniAppName: 'table', durakDeck: durakDecks(17),
});
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));

const step = (s) => console.log(`· ${s}`);
const room = () => app.roomsOf(CHAT).filter((r) => r.game === 'durak').at(-1);
const byId = (id) => PEOPLE.find((u) => String(u.id) === String(id));

async function until(cond, what, ms = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/* ---------------------------------------------------- the group: /game */

await app.handleUpdate(cmdUpdate(CHAT, ivan, '/game', { message_id: 1 }));
await app.settle();
const group = app.groups.get(String(CHAT));
const hubCard = api.live(CHAT);
assert.equal(hubCard.markup.inline_keyboard[0][0].url, `https://t.me/All_InPoker_bot/table?startapp=g_${group.code}`);
step(`/game: карточка «Во что играем?», кнопка ведёт в хаб группы g_${group.code}`);

const sdkStub = (initData) => `
  window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: new URLSearchParams(${JSON.stringify(initData)}).get('start_param') },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(){},
    BackButton: { show(){ window.__back = true; }, hide(){ window.__back = false; }, onClick(){} },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  } };`;

const browser = await chromium.launch();
const pages = new Map();
const problems = [];
async function openPage(u, startParam) {
  const page = await browser.newPage({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => problems.push(`${u.first_name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${u.first_name}: ${m.text()}`));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: startParam }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  pages.set(String(u.id), page);
  return page;
}
const pageOf = (u) => pages.get(String(u.id));

/* ------------------------------------------------ the hub: create a lobby */

const pi = await openPage(ivan, `g_${group.code}`);
await pi.waitForSelector('.game-card');
assert.equal(await pi.locator('.game-card').count(), 2, 'две игры на выбор');
await pi.locator('.game-card', { hasText: 'Дурак' }).click();
await pi.waitForSelector('.sheet');
await pi.getByRole('button', { name: 'Создать лобби' }).click();
await until(() => !!room(), 'лобби дурака создано');
await pi.waitForSelector('h1:has-text("Дурак")');
const code = room().code;
const lobbyCard = api.message(room().ui.tableMessageId);
assert.equal(lobbyCard.markup.inline_keyboard[0][0].url, `https://t.me/All_InPoker_bot/table?startapp=${code}`);
assert.equal(lobbyCard.markup.inline_keyboard[0][0].text, '🃏 Присоединиться');
assert.equal(await pi.evaluate(() => window.__back), true, 'системная «Назад» ведёт обратно в хаб');
step('Иван: хаб → «Дурак» → «Создать лобби»; в группе — карточка лобби с «Присоединиться»');

// Макс comes through the hub: the lobby is on the list.
const pm = await openPage(max, `g_${group.code}`);
await pm.waitForSelector('.lrow');
await pm.locator('.lrow', { hasText: 'Дурак' }).getByRole('button', { name: 'Присоединиться' }).click();
await pm.waitForSelector('h1:has-text("Дурак")');
await pm.getByRole('button', { name: 'Сесть за стол' }).click();
await until(() => room().players.length === 2, 'Макс сел');
// Дима — by the lobby card in the group.
const pd = await openPage(dima, code);
await pd.waitForSelector('h1:has-text("Дурак")');
await pd.getByRole('button', { name: 'Сесть за стол' }).click();
await until(() => room().players.length === 3, 'Дима сел');
await pi.waitForSelector('text=Игроков 3/6');
step('Макс — из хаба, Дима — по карточке; у Ивана «Игроков 3/6»');

await pi.getByRole('button', { name: '▶ Начать' }).click();
await until(() => room().deal?.phase === 'play', 'партия #1');
for (const page of pages.values()) await page.waitForSelector('.dk-hand .dk-card');
step('партия #1 сдана: у всех по 6 карт веером');

/* --------------------------------------------- nobody sees another's cards */

async function assertPrivacy(label) {
  const d = room().deal;
  const table = new Set(d.table.flatMap((x) => [x.a, x.d]).filter(Boolean));
  for (const u of PEOPLE) {
    const page = pageOf(u);
    // What is on screen must be the latest state, not the one before it.
    await page.waitForFunction((seq) => document.body.dataset.seq === String(seq), room().seq);
    const srcs = await page.$$eval('img.card', (xs) => xs.map((x) => x.getAttribute('src').replace('/cards/', '').replace('.svg', '')));
    const mine = new Set(d.hands[String(u.id)]);
    for (const c of srcs) {
      if (c === 'back') continue;
      assert.ok(mine.has(c) || table.has(c) || c === d.trumpCard, `${label}: у ${u.first_name} на экране чужая карта ${c}`);
    }
  }
}

/* --------------------------------------------------- a game, by tapping */

const low = (cards) => cards.reduce((a, b) => (['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].indexOf(b.slice(0, -1)) < ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].indexOf(a.slice(0, -1)) ? b : a));

/**
 * Tap a card in a fanned hand where a thumb would: on the part that shows —
 * its left edge (the next card covers the rest when the hand is big).
 */
const tapCard = (page, card) => page.locator(`.dk-card[data-card="${card}"]`).click({ position: { x: 7, y: 24 } });

/** Tap a card in your hand twice: pick, play. */
async function playCard(page, card) {
  await tapCard(page, card);
  await page.waitForSelector(`.dk-card[data-card="${card}"] img.picked`);
  await tapCard(page, card);
}

let moves = 0;
let throwsIn = 0;
let takes = 0;
let beats = 0;
for (let guard = 0; room().deal.phase === 'play' && guard < 800; guard++) {
  const r = room();
  const d = r.deal;
  const seq = r.seq;
  const moved = () => room().seq !== seq;
  if (!d.table.length) {
    const u = byId(d.attacker);
    const page = pageOf(u);
    await page.waitForSelector('.dk-role.go');
    await playCard(page, low(d.hands[d.attacker]));
    await until(moved, `${u.first_name} ходит`);
  } else if (!allCovered(d) && !d.bout.taking) {
    const u = byId(d.defender);
    const page = pageOf(u);
    const at = d.table.findIndex((x) => !x.d);
    const trump = d.trump;
    const rank = (c) => ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].indexOf(c.slice(0, -1));
    const a = d.table[at].a;
    const ok = d.hands[d.defender].filter((c) => (c.slice(-1) === a.slice(-1) ? rank(c) > rank(a) : c.slice(-1) === trump && a.slice(-1) !== trump));
    if (ok.length) {
      const card = low(ok);
      await tapCard(page, card);
      await page.waitForSelector(`.dk-pair[data-i="${at}"].target`);
      await page.locator(`.dk-pair[data-i="${at}"]`).click();
      await until(moved, `${u.first_name} кроет`);
      beats++;
    } else {
      await page.getByRole('button', { name: 'ВЗЯТЬ' }).click();
      await until(moved, `${u.first_name} берёт`);
      takes++;
    }
  } else {
    const waiting = waitingThrowers(d);
    const id = waiting[0];
    const u = byId(id);
    const page = pageOf(u);
    // Throw in now and then — the first few bouts — by tapping a lit card.
    const ranks = new Set(d.table.flatMap((x) => [x.a, x.d]).filter(Boolean).map((c) => c.slice(0, -1)));
    const can = d.table.length < Math.min(6, d.bout.startHand) ? d.hands[id].filter((c) => ranks.has(c.slice(0, -1))) : [];
    if (can.length && throwsIn < 3 && d.bout.no < 6) {
      await playCard(page, can[0]);
      await until(moved, `${u.first_name} подкидывает`);
      throwsIn++;
    } else {
      await page.locator('.panel button', { hasText: /^(ПАС|БИТО)$/ }).click();
      await until(moved, `${u.first_name}: пас`);
    }
  }
  moves++;
  if (moves % 15 === 0) await assertPrivacy(`ход ${moves}`);
}
const d1 = room().deal;
assert.equal(d1.phase, 'over', 'партия доиграна тапами');
step(`партия сыграна тапами: ${moves} действий — ${beats} раз покрыли, ${takes} раз взяли, ${throwsIn} подкинули`);

const verdict = d1.fool ? `Дурак — ${room().players.find((p) => p.id === d1.fool).name}` : 'Ничья';
for (const page of pages.values()) await page.waitForSelector(`.dk-line:has-text("${verdict}")`);
const card1 = api.message(room().ui.tableMessageId).text;
assert.match(card1, d1.fool ? /Дурак партии #1/ : /ничья/);
assert.match(card1, /Счёт: /);
step(`итог на всех экранах: «${verdict}»; карточка в группе — «${card1.split('\n').find((l) => /Дурак партии|ничья/.test(l))?.replace(/<[^>]+>/g, '')}»`);

/* -------------------------------------------------- the results, in the group */

const before = api.calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(CHAT)).length;
await app.handleUpdate(cmdUpdate(CHAT, ivan, '/finish', { message_id: 2 }));
await app.settle();
const posts = api.calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(CHAT));
assert.equal(posts.length, before + 1, 'итоги — одним сообщением');
assert.match(posts.at(-1).text, /ИТОГИ · ДУРАК/);
for (const page of pages.values()) await page.waitForSelector('h1:has-text("Итоги")');
step('/finish: итоги в группе одним сообщением, у всех — экран итогов');

// In the whole evening: the /game card, the lobby card, the results.
const all = api.calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(CHAT));
assert.equal(all.length, 3, all.map((c) => c.text.slice(0, 20)).join(' | '));
for (const c of api.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText')) {
  assert.ok(!/(?:10|[6-9ВДКТ])[♠♥♦♣]/.test(c.text), `карта в Telegram: ${c.text}`);
}
step('за вечер в группе три сообщения: /game, карточка, итоги — и ни одной карты');

/* -------------------------------------------- perevodnoy: «Перевести» */

app.durakDeck = durakStack(
  { 202: '6D 7S 8S 9S 10S JS', 303: '7H 7C 8H 9H 10H JH', 101: 'QC KC AC QS KS AS' },
  { trump: 'AD' },
);
await pi.close();
const pi2 = await openPage(ivan, `g_${group.code}`);
await pi2.waitForSelector('.game-card');
await pi2.locator('.game-card', { hasText: 'Дурак' }).click();
await pi2.locator('.sheet').getByRole('button', { name: 'Переводной', exact: true }).click();
await pi2.getByRole('button', { name: 'Создать лобби' }).click();
await until(() => room().code !== code && room().settings.variant === 'perevodnoy', 'лобби переводного');
for (const u of [max, dima]) {
  await pageOf(u).close();
  const page = await openPage(u, room().code);
  await page.getByRole('button', { name: 'Сесть за стол' }).click();
}
await until(() => room().players.length === 3, 'все сели');
await pi2.getByRole('button', { name: '▶ Начать' }).click();
await until(() => room().deal?.phase === 'play', 'партия переводного');
assert.equal(room().deal.attacker, '202', 'у Макса младший козырь');
await playCard(pageOf(max), '7S');
await until(() => room().deal.table.length === 1, 'Макс ходит 7♠');
const pd2 = pageOf(dima);
await pd2.waitForSelector('.panel button:has-text("ПЕРЕВЕСТИ")');
await tapCard(pd2, '7H');
await pd2.locator('.panel button', { hasText: 'ПЕРЕВЕСТИ' }).click();
await until(() => room().deal.defender === '101', 'перевод на Ивана');
await pi2.waitForSelector('.dk-role:has-text("ВЫ ОТБИВАЕТЕСЬ")');
assert.equal(await pi2.locator('.dk-pair').count(), 2, 'у Ивана на столе обе семёрки');
step('переводной: Дима перевёл семёрку кнопкой «Перевести» — теперь отбивается Иван');

async function noSideways(what) {
  for (const [id, page] of pages) {
    if (page.isClosed()) continue;
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(sw <= iw, `${what}: у ${id} страница шире экрана (${sw} > ${iw})`);
  }
}
await noSideways('стол переводного');

assert.deepEqual(problems, [], 'ошибок в консоли страниц нет');
await browser.close();
await web.close();
app.stop?.();
console.log('e2e дурака: всё сошлось');
process.exit(0);
