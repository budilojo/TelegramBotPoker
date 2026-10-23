/**
 * ЧАТ за столом настоящими браузерами: кнопка внизу экрана, панель, история,
 * бейдж непрочитанных, клавиатура, дуэль, зритель; и кнопка на всех семи играх
 * (320 и 390 px) — не лежит на картах, доске и кнопках.
 *
 *   node tools/e2e-chat.mjs
 *   SHOTS=1 node tools/e2e-chat.mjs   ещё и снимки в preview/chat/
 *
 * Тот же сервер, сокет и страница, что в бою; Telegram — заглушка. Нужен
 * Playwright с Chromium (как tools/e2e.mjs).
 *
 * Картинок miniapp/emoji/*.png пока нет: проверяется запасной эмодзи. Запрос
 * несуществующей картинки браузер пишет в консоль (404) — такие строки здесь
 * не считаются ошибкой, все остальные считаются.
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
const PORT = Number(process.env.E2E_PORT || 8099);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const CHAT = -100955;
const SHOTS = process.env.SHOTS === '1';
const OUT = path.join(ROOT, 'preview', 'chat');
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
    if (/Failed to load resource.*404/.test(m.text()) && /\/emoji\//.test(m.location()?.url || '')) return;
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

/** Видимые «содержимое игры»: кнопки, картинки, значки — то, чего кнопка чата касаться не должна. */
const CONTENT = 'button:not(.chat-fab):not(.chat-badge), img, svg:not(.chat-fab svg), canvas, [role="button"]';
async function fabClear(page, what) {
  await page.waitForSelector('.chat-fab');
  await page.waitForTimeout(450); // кнопка нашла место (60 мс на разгон + кадр)
  const b = await box(page, '.chat-fab');
  const vw = page.viewportSize().width;
  const vh = page.viewportSize().height;
  assert.ok(b.width >= 44 && b.height >= 44, `${what}: кнопка не меньше 44 px (${b.width}×${b.height})`);
  assert.ok(b.x >= 0 && b.x + b.width <= vw && b.y >= 0 && b.y + b.height <= vh, `${what}: кнопка в пределах экрана`);
  const hits = await page.evaluate(({ sel, b }) => {
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest('#chat-root')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      if (cs.pointerEvents === 'none') continue; // рисунок без нажатий (стрелки направления) — не содержимое под пальцем
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.left < b.x + b.width && b.x < r.right && r.top < b.y + b.height && b.y < r.bottom) out.push(`${el.tagName}.${String(el.className?.baseVal ?? el.className).slice(0, 30)} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return out;
  }, { sel: CONTENT, b });
  assert.deepEqual(hits, [], `${what}: кнопка чата лежит на содержимом игры (кнопка ${JSON.stringify(b)})`);
  return b;
}

const panelBox = (page) => box(page, '.chat-panel');
const badgeText = (page) => page.locator('.chat-badge').evaluate((e) => (e.hidden ? '' : e.textContent));
const setLimit = () => {
  hub.reactLimiter.sent.clear();
  hub.chatLimiter.by.clear();
};

/* ------------------------------------------------------------- покер */

for (const [w, h] of [[320, 568], [390, 844]]) {
  setLimit();
  const chat = CHAT - w;
  await app.handleUpdate(cmdUpdate(chat, ivan, '/newgame', { message_id: w }));
  await app.settle();
  const room = app.room(chat);
  const pi = await openPage(ivan, room.code, w, h);
  const pm = await openPage(max, room.code, w, h);
  const pd = await openPage(dima, room.code, w, h);
  for (const p of [pm, pd]) {
    await p.waitForSelector('.lobby');
    await p.getByRole('button', { name: 'Сесть за стол' }).first().click();
  }
  await until(() => room.players.length === 3, 'трое за столом');
  await pi.getByRole('button', { name: '▶ Начать' }).click();
  await until(() => room.status === 'playing', 'раздача');
  for (const p of [pi, pm, pd]) await p.waitForSelector('.hero-cards img.card');
  const pz = await openPage(zoya, room.code, w, h);
  await pz.waitForSelector('.table');
  await pz.waitForTimeout(400);
  assert.equal(await pz.locator('.chat-fab').count(), 0, 'у зрителя кнопки чата нет');
  assert.equal(await pi.locator('.top .rx-btn, .icon-btn:has-text("🙂")').count(), 0, 'в шапке кнопки смайликов больше нет');
  for (const p of [pi, pm, pd]) await fabClear(p, `покер ${w}px`);
  step(`${w}px: у троих кнопка чата внизу и свободна; у зрителя нет; в шапке смайлика нет`);

  // Открыть: высота ≤ половины, пустое состояние, игра под панелью не заблокирована.
  await pi.locator('.chat-fab').click();
  await pi.waitForSelector('.chat-panel');
  const pb = await panelBox(pi);
  assert.ok(pb.height <= h / 2 + 1, `панель не выше половины экрана (${pb.height} из ${h})`);
  assert.ok(pb.width <= w + 0.5, 'панель не шире экрана');
  assert.match(await pi.locator('.chat-empty').innerText(), /Пока тихо\. Напишите первым — увидят только игроки за этим столом\./);
  assert.equal(await pi.locator('.chat-fab').isVisible(), false, 'пока панель открыта, кнопки нет');
  await pi.waitForTimeout(400); // манифест набора подгрузился, быстрый ряд перерисован
  const sendBox = await box(pi, '.chat-send');
  assert.ok(sendBox.width >= 44 && sendBox.height >= 44, '«Отправить» не меньше 44 px');
  for (const c of await pi.locator('.chat-q').all()) {
    const r = await c.boundingBox();
    assert.ok(r.width >= 44 && r.height >= 44, `кнопка реакции не меньше 44 px (${r.width}×${r.height})`);
  }
  await noSideways(pi, `${w}px панель`);
  await shot(pi, `poker-empty-${w}`);
  step(`${w}px: панель ≤ половины экрана, пустое состояние словами, «Отправить» ≥ 44 px`);

  // Написать — Enter отправляет; у других бейдж 1, зритель ничего не получает.
  await pi.locator('.chat-input').fill('Всем привет!');
  await pi.keyboard.press('Enter');
  await pm.waitForSelector('.chat-badge:not([hidden])');
  assert.equal(await badgeText(pm), '1');
  assert.equal(await badgeText(pd), '1');
  await pi.waitForFunction(() => document.querySelector('.chat-input').value === '', null, { timeout: 2000 });
  assert.equal(await pi.locator('.chat-msg.mine .chat-text').innerText(), 'Всем привет!');
  assert.equal(await pz.locator('.chat-panel, .chat-badge').count(), 0, 'зритель не получил ничего');
  assert.doesNotMatch(await pz.content(), /Всем привет/);
  await shot(pm, `poker-badge-${w}`);
  // Shift+Enter — новая строка, не отправка.
  await pi.locator('.chat-input').fill('раз');
  await pi.locator('.chat-input').press('Shift+Enter');
  await pi.locator('.chat-input').pressSequentially('два');
  assert.equal(await pi.locator('.chat-input').inputValue(), 'раз\nдва');
  assert.equal(await pi.locator('.chat-msg').count(), 1, 'Shift+Enter не отправил');
  await pi.locator('.chat-input').fill('');
  step(`${w}px: Enter отправляет, Shift+Enter — перенос; у Макса и Димы бейдж «1», у зрителя ничего`);

  // Макс открывает — бейдж гаснет, видит сообщение с автором, отвечает; у Ивана — бейдж и ответ в панели.
  await pm.locator('.chat-fab').click();
  await pm.waitForSelector('.chat-msg .chat-text');
  assert.equal(await pm.locator('.chat-msg:not(.mine) .chat-name').first().innerText(), 'Иван');
  await pm.locator('.chat-input').fill('Привет, Иван');
  await pm.locator('.chat-send').click();
  await pi.waitForSelector('.chat-msg:not(.mine) .chat-text');
  assert.equal(await pi.locator('.chat-msg:not(.mine) .chat-name').innerText(), 'Макс');
  await pm.locator('.chat-close').click();
  await pm.waitForSelector('.chat-fab');
  assert.equal(await badgeText(pm), '', 'прочитанное — без бейджа');
  assert.equal(await badgeText(pd), '2', 'Дима не читал: два сообщения');
  await fabClear(pm, `покер ${w}px после закрытия`);
  step(`${w}px: Макс открыл → бейдж погас, ответил → у Ивана в панели; у Димы «2»`);

  // Длинные: слово на 300 символов без пробелов и длинный текст — панель не растёт, горизонтального скролла нет.
  await pi.waitForTimeout(1600);
  await pi.locator('.chat-input').fill('я'.repeat(300));
  await pi.keyboard.press('Enter');
  await pi.waitForSelector('.chat-msg.mine:nth-child(3)');
  const h1 = (await panelBox(pi)).height;
  await pi.waitForTimeout(1600);
  await pi.locator('.chat-input').fill(('длинное сообщение с пробелами ').repeat(9).trim());
  await pi.keyboard.press('Enter');
  await pi.waitForSelector('.chat-msg.mine:nth-child(4)');
  assert.equal((await panelBox(pi)).height, h1, 'панель не растёт от длинных сообщений');
  assert.ok(await pi.locator('.chat-text.collapsed').count() >= 1, 'длинное сообщение свёрнуто');
  const wide = await pi.locator('.chat-log').evaluate((e) => e.scrollWidth > e.clientWidth + 1);
  assert.equal(wide, false, 'слово без пробелов переносится, горизонтального скролла в истории нет');
  await pi.locator('.chat-more-text').last().click();
  assert.equal(await pi.locator('.chat-text.collapsed').count(), 1, '«Показать полностью» раскрывает');
  await noSideways(pi, `${w}px длинные`);
  await shot(pi, `poker-long-${w}`);
  // Счётчик символов у предела и отказ сервера словами под полем.
  await pi.locator('.chat-input').fill('х'.repeat(270));
  assert.equal(await pi.locator('.chat-count').innerText(), '30');
  await pi.locator('.chat-input').fill('');
  await pi.locator('.chat-input').fill('частота');
  await pi.keyboard.press('Enter'); // сразу после предыдущего — «не чаще»
  await pi.waitForFunction(() => /подождите \d+ с/.test(document.querySelector('.chat-err')?.textContent || ''));
  assert.equal(await pi.locator('.chat-input').inputValue(), 'частота', 'при отказе текст остаётся в поле');
  step(`${w}px: длинное слово и длинный текст не ломают панель; счётчик у предела; «подождите N с» под полем`);

  // «новые ↓»: прокрутили вверх — новое сообщение не дёргает, появляется кнопка.
  await pi.locator('.chat-log').evaluate((e) => { e.scrollTop = 0; });
  await pi.waitForTimeout(100);
  await pd.locator('.chat-fab').click();
  await pd.locator('.chat-input').fill('новость');
  await pd.locator('.chat-send').click();
  await pi.waitForSelector('.chat-new:not([hidden])');
  await pi.locator('.chat-new').click();
  await pi.waitForSelector('.chat-new[hidden]', { state: 'attached' });
  await pd.locator('.chat-close').click();

  // Реакции: быстрый ряд → пузырь у всех; в истории — маленькая строка; «ещё» — категории.
  setLimit();
  const seat = room.players.findIndex((p) => p.id === '101');
  assert.ok(await pi.locator('.chat-q[data-rx-pick]').count() >= 3, 'быстрый ряд реакций');
  await pi.locator('.chat-q[data-rx-pick="wow"]').click();
  for (const p of [pm, pd, pi]) await p.waitForSelector(`.rx-bubble[data-rx-seat="${seat}"][data-rx="wow"]`);
  await pi.waitForSelector('.chat-react[data-chat-react="wow"]');
  await pi.locator('[data-chat-more]').click();
  assert.deepEqual(await pi.locator('.chat-tab').allInnerTexts(), ['Реакции', 'Покер'], 'категории: общие и покер');
  assert.equal(await pi.locator('.chat-cell').count(), 14);
  await pi.locator('.chat-tab[data-chat-tab="poker"]').click();
  assert.deepEqual(await pi.locator('.chat-cell').evaluateAll((els) => els.map((e) => e.dataset.rx).sort()), ['allin', 'bluff']);
  await shot(pi, `poker-sets-${w}`);
  await pi.locator('[data-chat-more]').click();
  await pi.waitForSelector('.chat-sets[hidden]', { state: 'attached' });
  step(`${w}px: реакция из быстрого ряда — пузырь у всех и строка в истории; «ещё» — категории (Реакции · Покер)`);

  // Ход виден в шапке панели, когда он ваш.
  await pi.waitForFunction(() => document.querySelector('.chat-turn') !== null);
  const myTurnHere = [pi, pm, pd].find(() => true);
  void myTurnHere;
  for (const p of [pi, pm, pd]) {
    const mine = await p.evaluate(() => !!document.querySelector('.your-turn'));
    if (!mine || !(await p.locator('.chat-panel').count())) continue;
    assert.equal(await p.locator('.chat-turn:not([hidden])').count(), 1, 'в шапке панели виден «Ваш ход»');
    assert.match(await p.locator('.chat-turn').innerText(), /Ваш ход/);
  }

  // Клавиатура: видимая область 308 px (клавиатура 260) — поле и последние сообщения над ней, быстрый ряд спрятан.
  const kbH = Math.round(h * 0.46);
  await pi.evaluate((kb) => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => innerHeight - kb });
    document.documentElement.style.setProperty('--kb', `${kb}px`);
    vv.dispatchEvent(new Event('resize'));
  }, kbH);
  await pi.waitForTimeout(250);
  const kp = await panelBox(pi);
  assert.ok(Math.abs(kp.y + kp.height - (h - kbH)) <= 1, `панель стоит над клавиатурой (низ ${kp.y + kp.height}, ждали ${h - kbH})`);
  assert.ok(kp.y >= 0, 'панель не уехала за верх экрана');
  const inp = await box(pi, '.chat-input');
  assert.ok(inp.y + inp.height <= h - kbH + 1, 'поле ввода над клавиатурой');
  assert.equal(await pi.locator('.chat-quick').isVisible(), false, 'быстрый ряд спрятан, пока открыта клавиатура');
  const last = await pi.locator('.chat-log').evaluate((e) => e.scrollTop + e.clientHeight >= e.scrollHeight - 24);
  assert.ok(last, 'последние сообщения видны над клавиатурой');
  await shot(pi, `poker-keyboard-${w}`);
  await pi.evaluate(() => {
    delete window.visualViewport.height;
    document.documentElement.style.setProperty('--kb', '0px');
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await pi.waitForTimeout(250);
  const back = await panelBox(pi);
  assert.ok(Math.abs(back.height - h / 2) <= 1 && back.y + back.height === h, 'клавиатура ушла — панель вернулась на прежнее место');
  assert.equal(await pi.locator('.chat-quick').isVisible(), true);
  step(`${w}px: клавиатура ${kbH} px — панель над ней, поле и история видны, ряд реакций спрятан; ушла — всё на месте`);

  // Закрытие: свайп вниз за шапку; тап вне панели; экран игры тот же.
  const before = await pi.evaluate(() => document.getElementById('app').innerHTML.length);
  const hb = await box(pi, '.chat-head');
  await pi.mouse.move(hb.x + hb.width / 2, hb.y + 12);
  await pi.mouse.down();
  await pi.mouse.move(hb.x + hb.width / 2, hb.y + 160, { steps: 6 });
  await pi.mouse.up();
  await pi.waitForSelector('.chat-panel', { state: 'detached' });
  await fabClear(pi, `покер ${w}px после свайпа`);
  assert.equal(await pi.evaluate(() => document.getElementById('app').innerHTML.length), before, 'экран игры прежний');
  await pi.locator('.chat-fab').click();
  await pi.waitForSelector('.chat-panel');
  await pi.mouse.click(w / 2, 30); // тап вне панели — в шапку игры
  await pi.waitForSelector('.chat-panel', { state: 'detached' });
  step(`${w}px: свайп вниз и тап вне панели возвращают к игре без изменений`);

  // «Не показывать чат и реакции» у Макса: ни кнопки, ни бейджа, ни пузырей; у Димы — есть.
  if (w === 320) {
    await pm.getByRole('button', { name: 'Меню' }).click();
    await pm.getByRole('button', { name: /Не показывать чат и реакции/ }).click();
    await until(() => pm.locator('.chat-fab:visible').count().then((n) => n === 0), 'у Макса кнопка спряталась');
    await pm.waitForTimeout(200);
    assert.equal(await pm.locator('.chat-fab:visible').count(), 0);
    setLimit();
    await pi.locator('.chat-fab').click();
    await pi.waitForTimeout(3200); // «не чаще раза в 3 с» у самого Ивана
    await pi.locator('.chat-q[data-rx-pick="gg"]').click();
    await pd.waitForSelector('.rx-bubble[data-rx="gg"]');
    await pi.locator('.chat-close').click();
    await pm.waitForTimeout(300);
    assert.equal(await pm.locator('.rx-bubble').count(), 0, 'у выключившего пузырей нет');
    await pm.reload();
    await pm.waitForSelector('.table');
    await pm.waitForTimeout(400);
    assert.equal(await pm.locator('.chat-fab:visible').count(), 0, 'выбор помнится после перезагрузки');
    await pm.getByRole('button', { name: 'Меню' }).click();
    await pm.getByRole('button', { name: /Показывать чат и реакции/ }).click();
    await pm.waitForSelector('.chat-fab');
    step('320px: «Не показывать чат и реакции» — у Макса ни кнопки, ни пузырей; включается обратно');
  }
  for (const p of [pi, pm, pd, pz]) await noSideways(p, `${w}px стол`);
  for (const p of [pi, pm, pd, pz]) await p.close();
}

/* ---------------------------------------- все семь игр: кнопка свободна */

const GAMES = [
  { id: 'durak', sit: 'Сесть за стол', ready: '.dk-hand .dk-card' },
  { id: 'colors', sit: 'Сесть за стол', ready: '.cl-hand, .cl-felt, .top' },
  { id: 'chess', sit: 'Сесть за доску', ready: '.ch-board', settings: { base: 0 } },
  { id: 'checkers', sit: 'Сесть за доску', ready: '.ch-board', settings: { base: 0 } },
  { id: 'nardy', sit: 'Сесть за доску', ready: '.nd-board, .ch-board, .ch-head', settings: { base: 0 } },
  { id: 'battleship', sit: 'Сесть за стол', ready: '.ch-head', settings: { base: 0 } },
];
for (const [w, h] of [[320, 568], [390, 844]]) {
  let n = 0;
  for (const g of GAMES) {
    setLimit();
    const room = app.createGame(g.id, { chatId: String(CHAT - 100 - w - ++n), title: 'Клуб', host: { id: 101, tgId: 101, name: 'Иван' }, settings: g.settings || null });
    const pi = await openPage(ivan, room.code, w, h);
    const pm = await openPage(max, room.code, w, h);
    await pm.getByRole('button', { name: g.sit }).first().click();
    await until(() => room.players.length >= 2, `${g.id}: Макс сел`);
    // Лобби: кнопка есть и у хоста, и у севшего.
    await pi.waitForTimeout(500);
    await shot(pi, `${g.id}-lobby-${w}`);
    await fabClear(pi, `${g.id} лобби ${w}px`);
    await pi.getByRole('button', { name: '▶ Начать' }).click();
    await pi.waitForSelector(g.ready, { timeout: 8000 });
    await pm.waitForSelector(g.ready, { timeout: 8000 });
    await pi.waitForTimeout(600);
    await shot(pi, `${g.id}-${w}`);
    await fabClear(pi, `${g.id} ${w}px`);
    await fabClear(pm, `${g.id} ${w}px (Макс)`);
    // Пишем: приходит собеседнику (дуэли и дурак/радуга — одно ядро).
    await pi.locator('.chat-fab').click();
    await pi.locator('.chat-input').fill(`привет из ${g.id}`);
    await pi.keyboard.press('Enter');
    await pm.waitForSelector('.chat-badge:not([hidden])');
    await pi.locator('.chat-close').click();
    await pm.locator('.chat-fab').click();
    await pm.waitForSelector(`.chat-text:has-text("привет из ${g.id}")`);
    await shot(pm, `${g.id}-panel-${w}`);
    for (const p of [pi, pm]) await noSideways(p, `${g.id} ${w}px`);
    step(`${g.id} ${w}px: кнопка чата свободна в лобби и в партии, сообщение дошло`);
    for (const p of [pi, pm]) await p.close();
  }
}

/* ------------------------- партия с ботами: чата нет, кнопки нет */

{
  const solo = await app.createSolo('chess', { id: '505', tgId: 505, name: 'Оля' }, { level: 0, side: 'white', base: 300 });
  const po = await openPage(user(505, 'Оля'), solo.code, 390, 844);
  await po.waitForSelector('.ch-board');
  await po.waitForTimeout(500);
  assert.equal(await po.locator('.chat-fab:visible').count(), 0, 'с ботами чата нет');
  await po.getByRole('button', { name: 'Меню' }).click();
  assert.equal(await po.getByRole('button', { name: /чат и реакции/i }).count(), 0, 'и пункта меню нет');
  step('партия с ботами: ни кнопки, ни пункта меню');
  await po.close();
}

assert.deepEqual(problems, [], 'ошибок в консоли страниц нет');
await browser.close();
await web.close();
app.stop?.();
console.log('e2e чата: всё сошлось');
process.exit(0);
