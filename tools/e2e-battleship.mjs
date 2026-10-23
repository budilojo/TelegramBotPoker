/**
 * Морской бой настоящими браузерами: расстановка перетаскиванием и тапом,
 * поворот и «Повернуть», «нельзя — касание», «Расставить случайно», «Я готов»;
 * бой — выстрел одним касанием, двойной тап и уехавший палец, ранил, убил, мимо; что видно сопернику и
 * зрителю; 320 px; сдача и оба флота открыты в конце; партия против бота
 * (форма → расстановка → бой → итоги → «Сыграть ещё») на 390×844 и 320×568.
 *
 *   node tools/e2e-battleship.mjs
 *
 * Тот же сервер, сокет и страница, что в бою; Telegram — заглушка.
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
import { shipCells, checkFleet } from '../bot/games/battleship/board.js';
import battleshipGame from '../bot/games/battleship/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8099);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const CHAT = -100994;
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
const api = new TelegramStub();
const app = new App({ api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${PORT}`, miniAppName: 'table' });
app.battleshipRand = () => 0.1; // первым стреляет хост
let seed = 7;
app.battleshipFleetRand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));

const step = (s) => console.log(`· ${s}`);
const problems = [];
async function until(cond, what, ms = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 15));
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
  window.__sent = [];
  window.__got = [];
  const socketSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    window.__sent.push(JSON.parse(data));
    if (!this.__spy) {
      this.__spy = true;
      this.addEventListener('message', (e) => window.__got.push(String(e.data)));
    }
    return socketSend.call(this, data);
  };`;

const browser = await chromium.launch();
async function openPage(u, code, { width = 390, height = 844 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${u.first_name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${u.first_name}: ${m.text()}`));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: code }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  return page;
}

const room = app.createGame('battleship', { chatId: String(CHAT), title: 'Клуб', host: { id: 101, tgId: 101, name: 'Иван' }, settings: { base: 0 } });
const pi = await openPage(ivan, room.code);
const pm = await openPage(max, room.code);
await pm.waitForSelector('h1:has-text("Морской бой")');
await pm.getByRole('button', { name: 'Сесть за стол' }).click();
await until(() => room.players.length === 2, 'Макс сел');
await pi.getByRole('button', { name: '▶ Начать' }).click();
await until(() => !!room.match, 'партия началась');
await pi.waitForSelector('.bs-tray');
await pm.waitForSelector('.bs-tray');
step('лобби → «Начать»: у обоих поле расстановки и лоток');

/* ------------------------------------------------------- расстановка рукой */

const big = (page) => page.locator('.bs-grid:not(.mini)');
async function cellBox(page, c) {
  return page.locator(`.bs-grid:not(.mini) .bs-cell[data-c="${c}"]`).boundingBox();
}
async function dragTo(page, fromBox, c) {
  const to = await cellBox(page, c);
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(fromBox.x + fromBox.width / 2 + 12, fromBox.y + fromBox.height / 2 - 12, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(60);
}
const placedOn = (page) => big(page).locator('.bs-ship').count();
const tray = (page, len) => page.locator(`.bs-tray-ship[data-len="${len}"]`);

// Четырёхпалубный из лотка — на А1 (за первую палубу).
await dragTo(pi, await tray(pi, 4).boundingBox(), 0);
assert.equal(await placedOn(pi), 1, 'четырёхпалубный на поле');
assert.match(await tray(pi, 4).getAttribute('aria-label'), /осталось 0/);
// Тап по нему — повернуть (А1…А4 вниз).
await pi.locator('.bs-grid:not(.mini) .bs-cell[data-c="0"]').click();
await pi.waitForFunction(() => document.querySelector('.bs-grid:not(.mini) .bs-ship')?.classList.contains('v'));
step('перетаскивание из лотка на А1 — корабль примагнитился; тап по нему — повернулся вниз');

// Выбор и поворот: выбранный корабль подписан ориентацией; «Повернуть» крутит его туда и обратно.
{
  const cap = () => pi.locator('.bs-seltext').textContent();
  assert.match(await cap(), /четырёхпалубный: ↕ вертикально/, 'выбранный корабль подписан ориентацией');
  assert.ok(await pi.locator('.bs-grid:not(.mini) .bs-ship.sel').count() === 1, 'выбранный корабль подсвечен на поле');
  const rot = pi.getByRole('button', { name: 'Повернуть выбранный корабль' });
  const rb = await rot.boundingBox();
  assert.ok(rb.height >= 44 && rb.width >= 44, `«Повернуть» не меньше 44 px (${Math.round(rb.width)}×${Math.round(rb.height)})`);
  await rot.click();
  await pi.waitForFunction(() => document.querySelector('.bs-grid:not(.mini) .bs-ship')?.classList.contains('h'));
  assert.match(await cap(), /четырёхпалубный: ↔ горизонтально/);
  await rot.click();
  await pi.waitForFunction(() => document.querySelector('.bs-grid:not(.mini) .bs-ship')?.classList.contains('v'));
  step('тап по кораблю — выбран, подпись «четырёхпалубный: ↕ вертикально» и подсветка; «Повернуть» крутит туда и обратно (≥ 44 px)');
}

// Трёхпалубный вплотную, углом к нему (Б5 касается А4 по диагонали) — не встаёт.
await dragTo(pi, await tray(pi, 3).boundingBox(), 41);
assert.equal(await placedOn(pi), 1, 'касание углом — не поставили');
await pi.waitForSelector('#toast.show:has-text("не касаются")');
// Через клетку — встаёт.
await dragTo(pi, await tray(pi, 3).boundingBox(), 2);
assert.equal(await placedOn(pi), 2);
step('трёхпалубный углом к четырёхпалубному — «нельзя: не касаются», через клетку — встал');

// Предпросмотр во время перетаскивания: «нельзя» — пунктир с крестиком.
{
  const from = await tray(pi, 2).boundingBox();
  const to = await cellBox(pi, 10 + 1); // Б2 — бок о бок с А2
  await pi.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await pi.mouse.down();
  await pi.mouse.move(from.x + 20, from.y - 20, { steps: 3 });
  await pi.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  assert.ok(await big(pi).locator('.bs-cell.pv-bad').count() >= 1, 'пока тащим — видно, что не встанет');
  const far = await cellBox(pi, 77);
  await pi.mouse.move(far.x + far.width / 2, far.y + far.height / 2, { steps: 6 });
  assert.equal(await big(pi).locator('.bs-cell.pv').count(), 2, 'а здесь — встанет: две клетки в сплошной рамке');
  await pi.mouse.up();
  await pi.waitForTimeout(60);
  assert.equal(await placedOn(pi), 3);
}
step('пока тащим: «не встанет» — пунктир с крестиком, «встанет» — сплошная рамка');

// Утащить с поля — обратно в лоток.
{
  const shipCell = await cellBox(pi, 77);
  const out = await pi.locator('.bs-selrow').boundingBox();
  await pi.mouse.move(shipCell.x + shipCell.width / 2, shipCell.y + shipCell.height / 2);
  await pi.mouse.down();
  await pi.mouse.move(shipCell.x + 20, shipCell.y + 20, { steps: 3 });
  await pi.mouse.move(out.x + 10, out.y + out.height / 2, { steps: 8 });
  await pi.mouse.up();
  await pi.waitForTimeout(60);
  assert.equal(await placedOn(pi), 2, 'двухпалубный вернулся в лоток');
}
step('корабль, утащенный с поля, возвращается в лоток');

// Без перетаскивания: тап по лотку, тап по клетке.
await tray(pi, 1).click();
await pi.locator('.bs-grid:not(.mini) .bs-cell[data-c="99"]').click();
assert.equal(await placedOn(pi), 3, 'однопалубный — на К10 тапом');
// Только что поставленный выбран: подпись с ориентацией; однопалубный не поворачивается — кнопка выключена.
assert.match(await pi.locator('.bs-seltext').textContent(), /однопалубный/);
assert.equal(await pi.getByRole('button', { name: 'Повернуть выбранный корабль' }).isDisabled(), true, 'однопалубный — «Повернуть» выключена');
assert.equal(await pi.getByRole('button', { name: 'Я готов' }).isDisabled(), true, 'пока не все — «Я готов» выключена');
assert.equal(room.match.fleets[0], null, 'черновик на странице, серверу ещё ничего не ушло');
step('тап по лотку → тап по клетке — тоже ставит; «Я готов» ждёт, пока на поле все десять');

// «Расставить случайно»: нажимать можно снова — каждый раз новый флот, и каждый раз правильный.
{
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    await pi.getByRole('button', { name: 'Расставить случайно' }).click();
    await until(() => !!room.match.fleets[0] && !seen.has(JSON.stringify(room.match.fleets[0])), `случайная расстановка ${i + 1}`);
    seen.add(JSON.stringify(room.match.fleets[0]));
    assert.ok(checkFleet(room.match.fleets[0]).ok, 'сервер прислал правильный флот');
    await pi.waitForFunction(() => document.querySelectorAll('.bs-grid:not(.mini) .bs-ship').length === 10);
  }
  assert.equal(seen.size, 3, 'три нажатия — три разные расстановки');
  step('«Расставить случайно» три раза подряд — три разных флота, каждый проходит правила');
}
await pi.getByRole('button', { name: 'Очистить' }).click();
assert.equal(await placedOn(pi), 0);
await pi.getByRole('button', { name: 'Расставить случайно' }).click();
await until(() => !!room.match.fleets[0], 'сервер расставил Ивану флот');
await pi.waitForFunction(() => document.querySelectorAll('.bs-grid:not(.mini) .bs-ship').length === 10);
const randomMsg = await pi.evaluate(() => window.__sent.filter((m) => m.t === 'random'));
assert.deepEqual(Object.keys(randomMsg[0]), ['t'], '«Случайно» — просьба без чисел');
await pi.getByRole('button', { name: 'Я готов' }).click();
await until(() => room.match.ready[0], 'Иван готов');
const sentPlace = await pi.evaluate(() => window.__sent.filter((m) => m.t === 'place').at(-1));
assert.equal(sentPlace.ships.length, 10);
await pi.waitForSelector('.ch-status:has-text("Флот заперт")');
await pm.waitForSelector('.ch-title small:has-text("соперник готов")');
step('«Очистить», «Случайно» (расставил сервер), «Я готов» — флот ушёл на проверку и заперт; Макс видит «соперник готов»');

// Макс: случайно и готов. Иван стреляет первым (жребий).
await pm.getByRole('button', { name: 'Расставить случайно' }).click();
await until(() => !!room.match.fleets[1], 'флот Макса');
await pm.waitForFunction(() => document.querySelectorAll('.bs-grid:not(.mini) .bs-ship').length === 10);
await pm.getByRole('button', { name: 'Я готов' }).click();
await until(() => room.match.phase === 'battle', 'бой начался');
await pi.waitForSelector('.bs-row');
await pm.waitForSelector('.bs-row');
const pd = await openPage(dima, room.code);
await pd.waitForSelector('.bs-pair');
step('оба готовы — бой; первым стреляет Иван (жребий); Дима открыл стол зрителем');

/* ------------------------------------------------------- бой: два шага */

const enemy = (page) => page.locator('.bs-grid:not(.mini)');
const enemyCell = (page, c) => enemy(page).locator(`.bs-cell[data-c="${c}"]`);
const maxCells = room.match.fleets[1].flatMap(shipCells);
const water = Array.from({ length: 100 }, (_, c) => c).filter((c) => !maxCells.includes(c) && !maxCells.some((s) => Math.abs((s % 10) - (c % 10)) <= 1 && Math.abs(Math.floor(s / 10) - Math.floor(c / 10)) <= 1));

async function shoot(page, c) {
  const n = room.match.log.length;
  await enemyCell(page, c).click();
  await until(() => room.match.log.length === n + 1, `выстрел в ${c}`);
}

// Одно касание — выстрел сразу. Адрес — крупно, как подтверждение.
const target = maxCells[0];
const LET = 'АБВГДЕЖЗИК';
const want = `${LET[target % 10]}${Math.floor(target / 10) + 1}`;
await enemyCell(pi, target).click();
await until(() => room.match.log.length === 1, 'первый выстрел — одним касанием');
assert.equal(room.match.log[0].c, target, 'стрельнуло в ту клетку, по которой тапнули');
assert.equal(room.match.log[0].r === 'miss', false, 'попал');
await pi.waitForSelector(`.bs-grid:not(.mini) .bs-cell[data-c="${target}"].hit, .bs-grid:not(.mini) .bs-cell[data-c="${target}"].sunk`);
assert.match((await pi.locator('.bs-addr').textContent()).trim(), new RegExp(`^${want} — (ранил|убил)$`), 'после выстрела — адрес и результат крупно');
const fireMsg = await pi.evaluate(() => window.__sent.filter((m) => m.t === 'fire'));
assert.equal(fireMsg.length, 1, 'ровно один запрос на выстрел');
assert.equal(fireMsg[0].cell, target);
assert.equal(await pi.locator('.bs-fire').count(), 0, 'кнопки «Огонь» больше нет');
step(`один тап по клетке «${want}» — выстрел сразу; крупно «${want} — ранил/убил»; кнопки «Огонь» нет`);

// Добить корабль целиком — «убил»: рамка вокруг корабля, клетки вокруг — пустые.
const ship = room.match.fleets[1].find((s) => shipCells(s).includes(target));
for (const c of shipCells(ship)) if (!room.match.shots[0].some((x) => x.c === c)) await shoot(pi, c);
await pi.waitForFunction(() => document.querySelectorAll('.bs-grid:not(.mini) .bs-ship.sunk').length === 1);
assert.ok(await enemy(pi).locator('.bs-cell.around').count() >= 3, 'вокруг убитого — точки');
assert.equal(await enemy(pi).locator('.bs-ship').count(), 1, 'на поле соперника — только потопленный корабль');
// Клетка около убитого — потрачена: касание на неё ничего не делает (не выстрел и не отказ-кнопка).
const aroundCell = await enemy(pi).locator('.bs-cell.around').first().getAttribute('data-c').then(Number);
await enemyCell(pi, aroundCell).click({ force: true }).catch(() => null);
await pi.waitForTimeout(150);
assert.equal(room.match.log.length, 1 + shipCells(ship).filter((c) => c !== target).length, 'около убитого выстрела нет');
step(`убил ${ship.len}-палубный: рамка вокруг корабля, клетки вокруг — точки; туда выстрела нет`);

// Двойной тап: два касания подряд, пока ответа нет, — один выстрел. Вода: промах, ход переходит.
const n0 = room.match.log.length;
await pi.evaluate((c) => {
  const grid = document.querySelector('.bs-grid:not(.mini)');
  const cell = grid.querySelector(`.bs-cell[data-c="${c}"]`);
  const r = cell.getBoundingClientRect();
  const ev = (type) => new PointerEvent(type, { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 7, bubbles: true, button: 0 });
  for (let i = 0; i < 2; i++) { grid.dispatchEvent(ev('pointerdown')); grid.dispatchEvent(ev('pointerup')); }
}, water[0]);
await until(() => room.match.log.length === n0 + 1, 'промах в воду');
await pi.waitForTimeout(300);
assert.equal(room.match.log.length, n0 + 1, 'двойной тап: один выстрел, а не два');
assert.equal(room.match.log.at(-1).c, water[0]);
assert.equal(room.match.turn, 1, 'после промаха ход у Макса');
step('двойной тап по воде (два касания подряд до ответа) — один выстрел');

// Макс: палец уехал больше чем на 8 px — выстрела нет.
const ivanWater = Array.from({ length: 100 }, (_, c) => c).filter((c) => !room.match.fleets[0].flatMap(shipCells).includes(c));
const nM = room.match.log.length;
await pm.evaluate((c) => {
  const grid = document.querySelector('.bs-grid:not(.mini)');
  const cell = grid.querySelector(`.bs-cell[data-c="${c}"]`);
  const r = cell.getBoundingClientRect();
  const ev = (type, dx) => new PointerEvent(type, { clientX: r.left + r.width / 2 + dx, clientY: r.top + r.height / 2, pointerId: 9, bubbles: true, button: 0 });
  grid.dispatchEvent(ev('pointerdown', 0));
  grid.dispatchEvent(ev('pointermove', 30));
  grid.dispatchEvent(ev('pointerup', 30));
}, ivanWater[0]);
await pm.waitForTimeout(250);
assert.equal(room.match.log.length, nM, 'палец уехал — выстрела нет');
step('палец, который уехал больше чем на 8 px, выстрелом не становится');

// Мимо — ход у Макса; у Макса на своём поле — точка (один промах Ивана).
assert.equal(await pm.locator('.bs-grid.mini .bs-cell.miss').count(), 1, 'Макс видит промах Ивана на своём поле');
assert.equal(await pm.locator('.bs-grid.mini .bs-ship').count(), 10, 'свой флот — весь');
await pi.waitForSelector('.ch-status:has-text("Стреляет соперник")');
await enemyCell(pi, water[3]).click();
await pi.waitForSelector('#toast.show:has-text("Сейчас стреляет соперник")');
assert.equal(room.match.log.length, n0 + 1, 'не в свой ход касание выстрела не даёт');
step('мимо — ход у Макса; у Макса на своём поле точка; у Ивана касание не в свой ход — только подсказка');

/* ------------------------------------------------------ что видно кому */

for (const [page, who] of [[pi, 'Иван'], [pd, 'Дима']]) {
  const got = await page.evaluate(() => window.__got.join('\n'));
  for (const s of room.match.fleets[1]) {
    const sunk = shipCells(s).every((c) => room.match.shots[0].some((x) => x.c === c));
    const json = JSON.stringify({ x: s.x, y: s.y, len: s.len, dir: s.dir });
    if (!sunk) assert.ok(!got.includes(json), `${who}: в трафике страницы живой корабль Макса ${json}`);
  }
}
assert.equal(await pd.locator('.bs-ship').count(), 0, 'зрителю — ни одного корабля');
step('в трафике страниц Ивана и Димы нет ни одного живого корабля Макса; у зрителя на экране кораблей нет');

// Зритель на обычном телефоне видит оба поля и строку целиком — ничего не уходит под панель.
{
  const grids = await pd.locator('.bs-grid').all();
  assert.equal(grids.length, 2);
  const panelTop = (await pd.locator('.panel').boundingBox()).y;
  const statusBox = await pd.locator('.ch-status').boundingBox();
  for (const g of grids) {
    const b = await g.boundingBox();
    assert.ok(b.y + b.height <= panelTop + 1, `поле зрителя уходит под панель (${Math.round(b.y + b.height)} > ${Math.round(panelTop)})`);
  }
  assert.ok(statusBox && statusBox.y + statusBox.height <= panelTop + 1, 'строка зрителя видна');
}
step('зритель на 390×844: оба поля и строка — целиком над панелью');

/* ---------------------------------------------------------- 320 px */

const small = await openPage(max, room.code, { width: 320, height: 568 });
await small.waitForSelector('.bs-row');
for (const page of [pi, pm, pd, small]) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= iw, `страница шире экрана (${sw} > ${iw})`);
}
const gridBox = await small.locator('.bs-grid:not(.mini)').boundingBox();
const rowBox = await small.locator('.bs-row').boundingBox();
const mineBox = await small.locator('.bs-mine .bs-grid').boundingBox();
assert.ok(gridBox.x >= 0 && gridBox.x + gridBox.width <= 320, 'поле соперника по ширине на экране');
assert.ok(rowBox.y + rowBox.height <= 568, `нижний ряд (свой флот и часы) на экране (низ ${Math.round(rowBox.y + rowBox.height)})`);
assert.ok(mineBox.width >= 96 - 1, `свой флот не меньше 96 px (${Math.round(mineBox.width)})`);
const cell = await small.locator('.bs-grid:not(.mini) .bs-cell').first().boundingBox();
assert.ok(cell.width >= 24, `клетка соперника не уже 24 px (${Math.round(cell.width)})`);
step(`на 320×568: без горизонтального скролла, поле соперника ${Math.round(gridBox.width)} px (клетка ${Math.round(cell.width)} px), нижний ряд на экране`);

// Расстановка на 320: лоток и кнопки — не меньше 44 px.
{
  const r2 = app.createGame('battleship', { chatId: String(CHAT), title: 'Клуб', host: { id: 101, tgId: 101, name: 'Иван' }, settings: { base: 0 } });
  const pmax = await openPage(max, r2.code);
  await pmax.getByRole('button', { name: 'Сесть за стол' }).click();
  await until(() => r2.players.length === 2, 'сел');
  const ph = await openPage(ivan, r2.code, { width: 320, height: 568 });
  await ph.getByRole('button', { name: '▶ Начать' }).click();
  await ph.waitForSelector('.bs-tray');
  const [sw, iw] = await ph.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= iw, 'расстановка на 320 — без скролла вбок');
  for (const b of await ph.locator('.bs-tray-ship, .panel .k-btn').all()) {
    const bb = await b.boundingBox();
    assert.ok(bb.height >= 44 && bb.width >= 44, `кнопка меньше 44 px: ${Math.round(bb.width)}×${Math.round(bb.height)}`);
    assert.ok(bb.y + bb.height <= 568, `кнопка ниже экрана: ${await b.textContent()}`);
  }
  step('расстановка на 320×568: лоток и кнопки от 44 px и все на экране');
}

/* ------------------------------------------------- сдача и оба флота */

// Макс промахивается, Иван — тоже, чтобы оба выстрелили (до этого сдаться нельзя).
await shoot(pm, ivanWater[0]);
await until(() => room.match.turn === 0, 'Макс промахнулся');
await pm.locator('.k-icon-btn[aria-label="Меню"]').click();
await pm.getByRole('button', { name: /Сдаться/ }).click();
await pm.locator('.btn.danger:has-text("Сдаться")').click();
await until(() => !!room.match.over, 'Макс сдался');
await pi.waitForSelector('.bs-result.won');
await pi.waitForFunction(() => document.querySelectorAll('.bs-grid:not(.mini) .bs-ship').length === 10);
assert.ok(await enemy(pi).locator('.bs-ship.shown').count() >= 1, 'живые корабли соперника — пунктиром');
await pd.waitForFunction(() => document.querySelectorAll('.bs-ship').length === 20);
step('сдача из меню: у Ивана «Победа», флот Макса открыт целиком (живые — пунктиром); у зрителя — оба флота');

/* ------------------------------------------------ /battleship в группе */

await app.handleUpdate(cmdUpdate(CHAT, ivan, '/battleship', { message_id: 900 }));
await app.settle();
const lobby = app.liveRooms(String(CHAT)).find((r) => r.game === 'battleship' && r.status === 'lobby' && r !== room);
assert.ok(lobby, '/battleship — лобби одной командой');
step('/battleship в группе: лобби одной командой');

/* ------------------------------------------------- против бота: вся партия */

// Паузы бота «как у человека» (до полутора секунд) здесь не нужны — проверяем экран, а не темп.
battleshipGame.bot.delay = () => 40;

async function vsBot(u, size) {
  const tag = `${size.width}×${size.height}`;
  const page = await openPage(u, 'solo', size);
  await page.waitForSelector('.game-card.g-battleship');
  await page.locator('.game-card.g-battleship').click();
  await page.waitForSelector('.sheet .section-label:has-text("Кто стреляет первым")');
  for (const label of ['Я', 'Бот', 'Жребий']) assert.equal(await page.locator('.sheet .seg button', { hasText: new RegExp(`^${label}$`) }).count(), 1, `в форме — «${label}»`);
  await page.locator('.sheet .seg button', { hasText: 'Матрос' }).click();
  await page.locator('.sheet .seg button', { hasText: /^Я$/ }).click();
  await page.getByRole('button', { name: '▶ Играть' }).click();
  await until(() => !!app.soloOf(String(u.id)), 'партия с ботом создана');
  const r = app.soloOf(String(u.id));
  const botP = r.players.find((p) => p.bot);
  assert.equal(botP.name, '🤖 Матрос');
  assert.equal(botP.bot.level, 1);
  await page.waitForSelector('.bs-tray');
  const me = r.match.ids.indexOf(String(u.id));
  const bs = 1 - me;
  await until(() => r.match.ready[bs], 'бот расставил флот и готов');
  await page.getByRole('button', { name: 'Расставить случайно' }).click();
  await until(() => !!r.match.fleets[me], 'флот расставлен');
  await page.waitForFunction(() => !document.querySelector('.panel .k-btn--primary')?.disabled);
  await page.getByRole('button', { name: 'Я готов' }).click();
  await page.waitForSelector('.bs-row');
  assert.equal(r.match.phase, 'battle');
  assert.equal(r.match.turn, me, '«Я» — первым стреляет человек');
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= iw, `${tag}: без горизонтального скролла`);
  const rb = await page.locator('.bs-row').boundingBox();
  assert.ok(rb.y + rb.height <= size.height, `${tag}: нижний ряд на экране (низ ${Math.round(rb.y + rb.height)})`);
  step(`${tag}, против бота: форма («Кто стреляет первым: Я / Бот / Жребий», уровень «Матрос») → бот сам расставил флот → «Случайно», «Я готов» → бой, первым стреляю я`);

  const shootAt = async (c) => {
    const n = r.match.log.length;
    await page.locator(`.bs-grid:not(.mini) .bs-cell[data-c="${c}"]`).click();
    await until(() => r.match.log.length > n, `выстрел в ${c}`);
  };
  const botCells = r.match.fleets[bs].flatMap(shipCells);
  const near = (a, b) => Math.abs((a % 10) - (b % 10)) <= 1 && Math.abs(Math.floor(a / 10) - Math.floor(b / 10)) <= 1;
  const sea = Array.from({ length: 100 }, (_, c) => c).filter((c) => !botCells.some((x) => near(x, c)));
  // Два промаха — бот дважды отвечает сам, через хаб, по своему виду.
  for (const c of sea.slice(0, 2)) {
    await shootAt(c);
    await until(() => r.match.turn === me || !!r.match.over, 'бот отстрелялся', 15000);
  }
  const botShots = r.match.log.filter((x) => x.by === bs).length;
  assert.ok(botShots >= 2, `бот стрелял (${botShots})`);
  await page.waitForFunction((n) => document.querySelectorAll('.bs-grid.mini .bs-cell.miss, .bs-grid.mini .bs-cell.hit, .bs-grid.mini .bs-cell.sunk').length >= n, botShots);
  // В трафике страницы до конца партии нет ни одного живого корабля бота.
  // Своё поле из поиска убрано: свой корабль может стоять там же, где чужой.
  const got = await page.evaluate((mine) => window.__got.map((raw) => {
    const msg = JSON.parse(raw);
    if (msg.state?.match?.boards?.[mine]) msg.state.match.boards[mine].ships = [];
    return JSON.stringify(msg);
  }).join('\n'), me);
  for (const sh of r.match.fleets[bs]) {
    const sunk = shipCells(sh).every((c) => r.match.shots[me].some((x) => x.c === c));
    if (!sunk) assert.ok(!got.includes(JSON.stringify({ x: sh.x, y: sh.y, len: sh.len, dir: sh.dir })), `${tag}: в трафике живой корабль бота`);
  }
  step(`${tag}: два промаха — бот ответил ${botShots} выстрелами, они на моём поле; в трафике страницы ни одного живого корабля бота`);
  // Топлю весь флот бота: попал — стреляю ещё.
  for (const c of botCells) {
    if (r.match.over) break;
    if (r.match.turn !== me) await until(() => r.match.turn === me || !!r.match.over, 'мой ход', 15000);
    if (!r.match.over && !r.match.shots[me].some((x) => x.c === c)) await shootAt(c);
  }
  await until(() => !!r.match.over, 'партия кончилась');
  assert.equal(r.match.over.winner, me, 'победа человека');
  await page.waitForSelector('.bs-result.won');
  await page.getByRole('button', { name: 'Завершить' }).click();
  await page.locator('.sheet .btn.danger:has-text("Завершить")').click();
  await page.waitForSelector('h1:has-text("Итоги")');
  await page.waitForSelector('.hint:has-text("без рейтинга")');
  const again = page.getByRole('button', { name: '▶ Сыграть ещё' });
  const ab = await again.boundingBox();
  assert.ok(ab.y + ab.height <= size.height, `${tag}: «Сыграть ещё» на экране`);
  await again.click();
  await until(() => app.soloOf(String(u.id)) && app.soloOf(String(u.id)) !== r, 'новая партия с ботом');
  const r2 = app.soloOf(String(u.id));
  assert.equal(r2.players.find((p) => p.bot).bot.level, 1, 'тот же уровень');
  assert.equal(r2.settings.first, 'host', 'та же очерёдность');
  await page.waitForSelector('.bs-tray');
  step(`${tag}: потопил флот бота — «Победа»; «Завершить» → итоги «без рейтинга» → «▶ Сыграть ещё» — новая партия с тем же уровнем, снова расстановка`);
  await page.context().close();
}
await vsBot(user(505, 'Пётр'), { width: 390, height: 844 });
await vsBot(user(606, 'Оля'), { width: 320, height: 568 });

assert.deepEqual(problems, [], 'ошибок в консоли страниц нет');
await browser.close();
app.stop?.();
console.log('e2e морского боя: всё сошлось');
process.exit(0);
