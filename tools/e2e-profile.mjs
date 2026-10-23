/**
 * Профиль настоящими браузерами: экран «Профиль» (ник, сетка аватаров 4×3,
 * предпросмотр), отказ словами под полем, смена ника и аватара — у соседа за
 * столом имя и картинка меняются сразу, без перезагрузки. 320 и 390 px.
 *
 *   node tools/e2e-profile.mjs
 *   SHOTS=1 node tools/e2e-profile.mjs   ещё и снимки в preview/profile/
 *
 * Тот же сервер, сокет и страница, что в бою; Telegram — заглушка. Клавиатуру
 * телефона это не проверяет (видимая область сжимается только имитацией).
 *
 * Настоящих PNG аватарок пока нет: браузер пишет 404 на /avatars/*.png, клиент
 * берёт запасной .svg. Такие строки не считаются ошибкой, остальные — считаются.
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8098);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const CHAT = -100978;
const SHOTS = process.env.SHOTS === '1';
const OUT = path.join(ROOT, 'preview', 'profile');
if (SHOTS) fs.mkdirSync(OUT, { recursive: true });
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
const zoya = user(404, 'Зоя'); // зритель

const api = new TelegramStub();
const app = new App({ api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${PORT}`, miniAppName: 'table' });
app.chessRand = () => 0.1;
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));

const step = (s) => console.log(`· ${s}`);
const problems = [];
async function until(cond, what, ms = 4000) {
  const t0 = Date.now();
  while (!(await cond())) {
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
  } };`;

const browser = await chromium.launch();
async function openPage(u, code, width = 360, height = 740) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => problems.push(`${u.first_name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource.*404/.test(m.text()) && /\/avatars\/av\d\d\.png/.test(m.location()?.url || '')) return;
    problems.push(`${u.first_name}: ${m.text()}`);
  });
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: code }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  return page;
}

const box = (page, sel) => page.locator(sel).first().boundingBox();
const overlap = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Пузырь не лежит ни на одной из этих вещей. */
async function clearOf(page, bubbleSel, sels, what) {
  await page.waitForTimeout(300); // появление (0,22 с) закончилось: меряем настоящий размер
  const b = await box(page, bubbleSel);
  assert.ok(b, `${what}: пузырь на экране`);
  for (const sel of sels) {
    for (const el of await page.locator(sel).all()) {
      if (!(await el.isVisible())) continue;
      const r = await el.boundingBox();
      assert.ok(!overlap(b, r), `${what}: пузырь закрывает ${sel} (${JSON.stringify(b)} / ${JSON.stringify(r)})`);
    }
  }
}
async function noSideways(page, what) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= iw, `${what}: страница шире экрана (${sw} > ${iw})`);
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(OUT, `${name}.png`) });


/* ------------------------------------------------------------- профиль */

for (const [w, h] of [[320, 568], [390, 844]]) {
  const chat = CHAT - w;
  const ivan = user(1000 + w, 'Иван'); // свой на каждый размер: смену профиля ограничивает частота
  const max = user(2000 + w, 'Макс');
  await app.handleUpdate(cmdUpdate(chat, ivan, '/play', { message_id: w }));
  await app.handleUpdate(cmdUpdate(chat, ivan, '/newgame', { message_id: w + 1 }));
  await app.settle();
  const group = app.groups.get(String(chat));
  const room = app.room(chat);
  const nick = `Шмель${w}`.slice(0, 8);

  const pm = await openPage(max, room.code, w, h);
  await pm.waitForSelector('.lobby');
  await pm.getByRole('button', { name: 'Сесть за стол' }).first().click();
  await until(() => room.players.length === 2, 'Макс сел');
  const pi = await openPage(ivan, `g_${group.code}`, w, h);
  await pi.waitForSelector('.pf-temp');
  await pi.locator('.pf-temp').click();
  await pi.waitForSelector('.pf .pf-cell');
  await pi.waitForFunction(() => document.querySelectorAll('.pf-cell').length === 13);
  step(`${w}px: экран «Профиль» открыт, в сетке 13 клеток (без аватара + 12)`);

  // Размеры: клетки и кнопки ≥ 44, четыре колонки, ничего не шире экрана.
  for (const sel of ['.pf-cell', '.pf-save', '.pf-reset', '.pf-input']) {
    for (const el of await pi.locator(sel).all()) {
      const r = await el.boundingBox();
      assert.ok(r.width >= 44 && r.height >= 44, `${w}px: ${sel} не меньше 44 px (${r.width}×${r.height})`);
    }
  }
  const cols = new Set(await pi.locator('.pf-cell').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left))));
  assert.equal(cols.size, 4, `${w}px: четыре колонки`);
  await noSideways(pi, `${w}px профиль`);
  await pi.waitForTimeout(450);
  await shot(pi, `settings-${w}`);

  // Пустой ник: предпросмотр — имя из Telegram, «Сохранить» и «Сбросить» выключены.
  assert.equal((await pi.locator('.pf-prev-name').innerText()).trim(), 'Иван');
  assert.ok(await pi.locator('.pf-save').isDisabled(), 'нечего сохранять');
  assert.ok(await pi.locator('.pf-reset').isDisabled(), 'нечего сбрасывать');

  // Отказ словами под полем.
  await pi.locator('.pf-input').fill('@boss');
  await pi.locator('.pf-save').click();
  await pi.waitForFunction(() => document.querySelector('.pf-err')?.textContent.length > 3);
  assert.match(await pi.locator('.pf-err').innerText(), /@|ссылк/i);
  assert.equal(await pi.locator('.pf-input').getAttribute('aria-invalid'), 'true');
  assert.equal(app.store.getProfile(String(ivan.id)).nickname, null, 'плохой ник не сохранён');
  await shot(pi, `error-${w}`);

  // Выбор аватара и ник: предпросмотр живой, выбранный отмечен галочкой.
  await pi.locator('.pf-input').fill(nick);
  await pi.locator('.pf-cell').nth(3).click(); // av03
  assert.equal(await pi.locator('.pf-cell.on .pf-check').count(), 1, 'выбранный отмечен не только цветом');
  assert.equal((await pi.locator('.pf-prev-name').innerText()).trim(), nick);
  await pi.waitForFunction(() => document.querySelector('.pf-prev-av img.av-img')?.src.endsWith('av03.svg'));
  assert.equal(await pi.locator('.pf-count').innerText(), `${nick.length} / 16`);
  await shot(pi, `draft-${w}`);

  // Сохранить → у Макса в лобби имя и картинка Ивана сменились сами.
  await pi.locator('.pf-save').click();
  await until(() => app.store.getProfile(String(ivan.id)).nickname === nick, 'профиль в базе');
  assert.equal(app.store.getProfile(String(ivan.id)).avatar, 'av03');
  const hostSeat = pm.locator('.lseat', { hasText: nick });
  await hostSeat.waitFor();
  await hostSeat.locator('img.av-img').waitFor();
  await pm.waitForFunction(() => [...document.querySelectorAll('.lseat img.av-img')].some((i) => i.src.endsWith('av03.svg') && i.naturalWidth > 0));
  assert.equal(await pm.locator('.lseat', { hasText: 'Иван' }).count(), 0, 'прежнего имени у Макса нет');
  assert.equal(await pm.locator('.lseat.me img.av-img').count(), 0, 'у Макса без аватара — инициал, не картинка');
  await noSideways(pm, `${w}px лобби у Макса`);
  await pm.waitForTimeout(700); // место «въехало»
  await shot(pm, `lobby-max-${w}`);
  step(`${w}px: Иван стал «${nick}» с аватаром av03 — у Макса за столом это видно сразу`);

  // Сброс к имени из Telegram.
  await pi.waitForFunction(() => !document.querySelector('.pf-reset')?.disabled);
  await pi.waitForTimeout(10_200); // не чаще раза в 10 секунд
  await pi.locator('.pf-reset').click();
  await pm.locator('.lseat', { hasText: 'Иван' }).waitFor();
  assert.equal(await pm.locator('.lseat', { hasText: nick }).count(), 0);
  step(`${w}px: «Сбросить к имени из Telegram» — снова «Иван»`);

  // Клавиатура: видимая область сжимается, поле и кнопка остаются на экране.
  await pi.setViewportSize({ width: w, height: Math.round(h * 0.5) });
  await pi.locator('.pf-input').focus();
  await pi.waitForTimeout(200);
  const vh = await pi.evaluate(() => innerHeight);
  if (process.env.DBG) console.log(await pi.evaluate(() => { const sh = document.querySelector('.sheet'); const r = sh.getBoundingClientRect(); return JSON.stringify({ top: r.top, h: r.height, bottom: r.bottom, st: sh.scrollTop, sh: sh.scrollHeight, ch: sh.clientHeight, kb: getComputedStyle(sh).bottom, vh: innerHeight, vv: visualViewport.height }); }));
  for (const sel of ['.pf-input', '.pf-save']) {
    const r = await box(pi, sel);
    assert.ok(r.y >= 0 && r.y + r.height <= vh + 1, `${w}px: ${sel} на виду при сжатой области (${r.y}…${r.y + r.height} из ${vh})`);
  }
  step(`${w}px: при сжатой вдвое области поле и «Сохранить» на виду`);
  for (const p of [pi, pm]) await p.close();
}

assert.deepEqual(problems, [], 'ошибок в консоли страниц нет');
await browser.close();
await web.close();
app.stop?.();
console.log('e2e профиля: всё сошлось');
process.exit(0);
