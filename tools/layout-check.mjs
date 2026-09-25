/**
 * Does anything on the table cover anything else — at any screen size?
 *
 * Builds tables of 2 to 8 players in two worst cases — a hand in progress
 * with long numbers on every plate, and a showdown where every hand is shown
 * with its name — opens each one as a real page at a dozen screen sizes, and
 * measures every seat against the pot, the board, the result line, the other
 * seats, the top bar, the hero panel and the screen edges.
 *
 *   node tools/layout-check.mjs            → a table of results; exit 1 on any overlap
 *   node tools/layout-check.mjs --shots    → also screenshots of the failures in preview/layout/
 *
 * Needs Playwright with Chromium, like tools/preview.mjs. A throwaway token,
 * Telegram replaced by the test stub.
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
import { legalActions } from '../server/game.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.LAYOUT_PORT || 8097);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const SHOTS = process.argv.includes('--shots');
const OUT = path.join(ROOT, 'preview', 'layout');

const VIEWPORTS = [
  [320, 568], [360, 640], [375, 667], [390, 844], [414, 896], [430, 932],
  [360, 520], [390, 600], [480, 560], [600, 420], [768, 1024], [1280, 720],
];
const NAMES = ['Иван', 'Lev', 'Константин', 'Дима', 'Саша', 'Александра', 'Макс', 'Ёж'];

const api = new TelegramStub();
const app = new App({ api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${PORT}` });
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);

let chat = -100700;
/** A table of `n` with big stacks, so every number on it is as long as it gets. */
function table(n) {
  const chatId = String(chat--);
  const room = R.createRoom({ chatId, title: 'Проверка', host: { id: 101, name: NAMES[0], dm: 'ok' }, startingStack: 95_000_000, smallBlind: 1_000_000, bigBlind: 2_000_000 });
  for (let i = 1; i < n; i++) R.addPlayer(room, { id: 101 + i, name: NAMES[i], dm: 'ok' });
  app.rooms.set(chatId, room);
  return room;
}
function play(room, until, pick) {
  let guard = 0;
  while (room.hand.phase === 'betting' && !until(room) && guard++ < 80) {
    const id = room.hand.actorId;
    const l = legalActions(room, id);
    const [action, amount] = pick(room, id, l);
    const r = R.act(room, id, action, amount);
    if (r.error) throw new Error(`${id} ${action}: ${r.error}`);
  }
}

const scenes = [];
for (let n = 2; n <= 8; n++) {
  // In progress: big raises on every plate, the hero to act.
  const a = table(n);
  R.startGame(a, '101');
  play(a, (x) => x.hand.actorId === '101' && x.hand.log.length > n, (x, id, l) =>
    l.canRaise && x.hand.currentBet < 20_000_000 ? ['raise', x.hand.currentBet + 4_000_000] : [l.canCheck ? 'check' : 'call']);
  scenes.push({ name: `${n}p-betting`, room: a });
  // Showdown: everybody all-in, every hand shown and named, a result line.
  const b = table(n);
  R.startGame(b, '101');
  play(b, () => false, (x, id, l) => (l.canBet || l.canRaise ? ['allin'] : ['call']));
  if (b.status === 'finished') b.status = 'playing'; // somebody busted: keep the table, not the results
  scenes.push({ name: `${n}p-showdown`, room: b });
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

/** Everything worth measuring, in viewport pixels. Text by its glyphs, not its box. */
function measure() {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, what: el.className || el.tagName };
  };
  const glyphs = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, what: `${el.className}:${el.textContent.trim().slice(0, 14)}` };
  };
  const seats = [...document.querySelectorAll('.seat')].map((s) => ({
    seat: s.dataset.seat,
    parts: [...s.querySelectorAll('.av, .info, .plate, .minis img')].map(box)
      .concat([...s.querySelectorAll('.nm, .stk')].map(glyphs)),
  }));
  const center = [...document.querySelectorAll('.pot, .board .card, .board .slot')].map(box)
    .concat([...document.querySelectorAll('.result-line, .bet-line')].filter((e) => e.textContent.trim()).map(glyphs));
  return {
    seats,
    center,
    top: box(document.querySelector('.top')),
    hero: box(document.querySelector('.hero')),
    vw: innerWidth,
  };
}

const area = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));

function problems(m) {
  const out = [];
  const EPS = 2; // a pixel of anti-aliasing is not an overlap
  for (const s of m.seats) {
    for (const p of s.parts) {
      for (const c of m.center) if (area(p, c) > EPS) out.push(`seat ${s.seat} ${p.what} × ${c.what}`);
      if (p.t < m.top.b - 1) out.push(`seat ${s.seat} ${p.what} × top bar`);
      if (p.b > m.hero.t + 1) out.push(`seat ${s.seat} ${p.what} × hero`);
      if (p.l < -1 || p.r > m.vw + 1) out.push(`seat ${s.seat} ${p.what} off screen`);
    }
  }
  for (let i = 0; i < m.seats.length; i++) {
    for (let j = i + 1; j < m.seats.length; j++) {
      for (const p of m.seats[i].parts) {
        for (const q of m.seats[j].parts) if (area(p, q) > EPS) out.push(`seat ${m.seats[i].seat} ${p.what} × seat ${m.seats[j].seat} ${q.what}`);
      }
    }
  }
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
const rows = [];
for (const [w, hgt] of VIEWPORTS) {
  const cells = [];
  for (const sc of scenes) {
    const page = await browser.newPage({ viewport: { width: w, height: hgt }, deviceScaleFactor: 1 });
    const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: { id: 101, first_name: 'Иван' }, start_param: sc.room.code }, TOKEN);
    await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdk(initData, sc.room.code) }));
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector('.table');
    await page.waitForTimeout(60);
    const found = problems(await page.evaluate(measure));
    if (process.env.DEBUG && found.length) {
      console.log(await page.evaluate(() => {
        const t = document.querySelector('.table');
        const r = (el) => { const b = el.getBoundingClientRect(); return `${el.className}[${b.left.toFixed(0)},${b.top.toFixed(0)} ${b.width.toFixed(0)}x${b.height.toFixed(0)}]`; };
        return `u=${t.style.getPropertyValue('--u')} cw=${t.style.getPropertyValue('--card-w')} table=${r(t)}\n` +
          [...document.querySelectorAll('.seat .plate, .result-line, .board, .pot')].map(r).join('\n');
      }));
    }
    cells.push(found.length ? '✗' : '·');
    // SHOT=2p-betting@360x520 — a picture of one layout, overlap or not.
    if (process.env.SHOT === `${sc.name}@${w}x${hgt}`) {
      fs.mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: path.join(OUT, `${w}x${hgt}-${sc.name}.png`) });
    }
    if (found.length) {
      failures++;
      console.log(`${w}×${hgt} ${sc.name}: ${found.length} — ${[...new Set(found)].slice(0, 3).join('; ')}`);
      if (SHOTS) await page.screenshot({ path: path.join(OUT, `${w}x${hgt}-${sc.name}.png`) });
    }
    await page.close();
  }
  rows.push(`${`${w}×${hgt}`.padEnd(10)} ${cells.join('')}`);
}
await browser.close();
await web.close();
console.log(`\n           ${scenes.map((s) => s.name[0]).join('')}   (2..8 players, betting/showdown pairs)`);
console.log(rows.join('\n'));
console.log(failures ? `\n${failures} layouts with overlaps` : '\nno overlaps');
process.exit(failures ? 1 : 0);
