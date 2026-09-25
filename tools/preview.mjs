/**
 * See the Mini App without Telegram: builds typical table situations on a
 * real server (the same hub, view and static files the bot uses), signs an
 * initData for a chosen viewer with a THROWAWAY token, and screenshots each
 * one at phone size with Playwright.
 *
 *   node tools/preview.mjs            → preview/*.png
 *   node tools/preview.mjs --serve    → keeps the server up and prints URLs
 *
 * Nothing here touches the real bot: the token is random and dies with the
 * process, and Telegram is replaced by the test stub.
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
import { stack } from '../bot/harness.js';
import * as R from '../bot/room.js';
import { legalActions } from '../server/game.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'preview');
const PORT = Number(process.env.PREVIEW_PORT || 8090);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const serve = process.argv.includes('--serve');

const api = new TelegramStub();
const app = new App({ api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${PORT}` });
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);

const PEOPLE = [
  [101, 'Иван'], [102, 'Артём'], [103, 'Макс'], [104, 'Дима'], [105, 'Саша'], [106, 'Лена'],
];
let chat = -100500;

function table(n, { host = 101, ...opts } = {}) {
  const chatId = String(chat--);
  const [hid, hname] = PEOPLE.find(([id]) => id === host);
  const room = R.createRoom({ chatId, title: 'Покер по пятницам', host: { id: hid, name: hname, dm: 'ok' }, smallBlind: 25, bigBlind: 50, ...opts });
  for (const [id, name] of PEOPLE.filter(([id]) => id !== host).slice(0, n - 1)) R.addPlayer(room, { id, name, dm: 'ok' });
  app.rooms.set(chatId, room);
  return room;
}

/** Move the hand along until `until(room)` says stop. */
function play(room, until, pick) {
  let guard = 0;
  while (room.hand.phase === 'betting' && !until(room) && guard++ < 80) {
    const id = room.hand.actorId;
    const l = legalActions(room, id);
    const [action, amount] = pick?.(room, id, l) ?? [l.canCheck ? 'check' : 'call'];
    const r = R.act(room, id, action, amount);
    if (r.error) throw new Error(`${id} ${action}: ${r.error}`);
  }
}

const scenes = [];
function scene(name, room, viewer, { width = 390, height = 780, click = null } = {}) {
  const user = { id: viewer, first_name: PEOPLE.find(([id]) => id === viewer)?.[1] ?? 'Гость' };
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user, start_param: room.code }, TOKEN);
  scenes.push({ name, code: room.code, initData, width, height, click });
}

const deck6 = stack({ 101: 'As Kh', 102: 'Qs Qd', 103: '9c 9d', 104: '7h 2c', 105: 'Jd 10d', 106: '5s 4s' }, '10s Jh Qc 3d 8s');

// 1. Lobby — the host's view.
{
  const r = table(4);
  r.settings.turnSeconds = 60;
  scene('01-lobby-host', r, 101);
}
// 2. My turn on the flop, facing a bet, timer on.
{
  const r = table(6);
  r.settings.turnSeconds = 60;
  R.startGame(r, '101', { deck: () => deck6(r) });
  play(r, (x) => x.hand.street === 'flop', (x, id, l) => (id === '104' ? ['fold'] : [l.canCheck ? 'check' : 'call']));
  play(r, (x) => x.hand.actorId === '101', (x, id, l) => (l.currentBet === 0 && id === '103' ? ['bet', 100] : [l.canCheck ? 'check' : 'call']));
  scene('02-my-turn-flop', r, 101);
  scene('03-raise-sheet', r, 101, { click: 'RAISE' });
  scene('04-small-phone', r, 101, { width: 360, height: 640 });
}
// 3. Somebody else's turn — I am waiting.
{
  const r = table(5);
  r.settings.turnSeconds = 60;
  R.startGame(r, '101', { deck: () => deck6(r) });
  play(r, (x) => x.hand.actorId === '103');
  scene('05-their-turn', r, 102);
}
// 4. Showdown on the river.
{
  const r = table(4);
  R.startGame(r, '101', { deck: () => deck6(r) });
  play(r, () => false);
  scene('06-showdown', r, 101);
}
// 5. A short stack shoves pre-flop and gets called: the board is being
//    turned over (flop frame). Deep stacks, so the game goes on after.
{
  const r = table(3);
  r.players[0].stack = 2000;
  r.players[0].stats.buyIn = 2000;
  R.startGame(r, '101', { deck: () => deck6(r) });
  play(r, () => false, (x, id, l) => (id === '101' ? ['allin'] : id === '102' ? ['call'] : ['fold']));
  r.ui.reveal = { handNo: r.hand.no, shown: 3 };
  scene('07-allin-reveal', r, 102);
}
// 6. Real cards: the dealer decides who won.
{
  const r = table(5);
  R.updateSettings(r, '101', { cards: 'live' });
  R.setRole(r, '101', '105', 'dealer');
  R.startGame(r, '101');
  play(r, () => false);
  scene('08-dealer-table', r, 101);
  scene('09-dealer-who-won', r, 105);
}
// 7. Results.
{
  const r = table(4);
  R.startGame(r, '101', { deck: () => deck6(r) });
  play(r, () => false, (x, id, l) => (l.canBet || l.canRaise ? ['allin'] : ['call']));
  R.endGame(r, '101');
  scene('10-results', r, 101);
}

app.syncClocks(); // turn deadlines, as the running bot would have them
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));

/** What Telegram's SDK would give the page: a signed identity and the room. */
const sdkStub = (initData) => `
  window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: new URLSearchParams(${JSON.stringify(initData)}).get('start_param') },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(){},
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  } };`;

if (serve) {
  console.log(`preview on http://localhost:${PORT} — scenes:`);
  for (const s of scenes) console.log(`  ${s.name}: room ${s.code}`);
  console.log('(open them with tools/preview.mjs without --serve to get screenshots)');
} else {
  const require = createRequire(import.meta.url);
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
  }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  for (const s of scenes) {
    const page = await browser.newPage({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: 2 });
    await page.route('https://telegram.org/**', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: sdkStub(s.initData) }));
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector('.top, .lobby, .fatal', { timeout: 5000 });
    if (s.click) {
      await page.getByRole('button', { name: s.click, exact: false }).first().click();
      await page.waitForSelector('.sheet');
    }
    await page.waitForTimeout(700); // let the deal animations settle
    await page.screenshot({ path: path.join(OUT, `${s.name}.png`) });
    await page.close();
  }
  await browser.close();
  await web.close();
  console.log(`preview: ${scenes.length} screenshots → ${path.relative(process.cwd(), OUT)}/`);
  process.exit(0);
}
