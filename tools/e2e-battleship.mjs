/**
 * Морской бой настоящими браузерами: расстановка перетаскиванием и тапом,
 * поворот, «нельзя — касание», «Случайно», «Я готов»; бой — выстрел в два
 * шага (клетка → «Огонь»), ранил, убил, мимо; что видно сопернику и
 * зрителю; 320 px; сдача и оба флота открыты в конце.
 *
 *   DRAFT_GAMES=1 node tools/e2e-battleship.mjs     (так его запускает npm run e2e)
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
import { shipCells } from '../bot/games/battleship/board.js';

if (process.env.DRAFT_GAMES !== '1') {
  console.error('морской бой пока черновик: запускайте с DRAFT_GAMES=1 (npm run e2e так и делает)');
  process.exit(1);
}

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
  const out = await pi.locator('.bs-hint').boundingBox();
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
assert.equal(await pi.getByRole('button', { name: 'Я готов' }).isDisabled(), true, 'пока не все — «Я готов» выключена');
assert.equal(room.match.fleets[0], null, 'черновик на странице, серверу ещё ничего не ушло');
step('тап по лотку → тап по клетке — тоже ставит; «Я готов» ждёт, пока на поле все десять');

await pi.getByRole('button', { name: 'Очистить' }).click();
assert.equal(await placedOn(pi), 0);
await pi.getByRole('button', { name: 'Случайно' }).click();
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
await pm.getByRole('button', { name: 'Случайно' }).click();
await until(() => !!room.match.fleets[1], 'флот Макса');
await pm.waitForFunction(() => document.querySelectorAll('.bs-grid:not(.mini) .bs-ship').length === 10);
await pm.getByRole('button', { name: 'Я готов' }).click();
await until(() => room.match.phase === 'battle', 'бой начался');
await pi.waitForSelector('.bs-fire');
await pm.waitForSelector('.bs-fire');
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
  await page.waitForSelector(`.bs-grid:not(.mini) .bs-cell[data-c="${c}"].aim`);
  assert.equal(room.match.log.length, n, 'тап по клетке не стреляет — только выбирает');
  await page.getByRole('button', { name: 'Огонь' }).click();
  await until(() => room.match.log.length === n + 1, `выстрел в ${c}`);
}

// Первый шаг — выбор: прицел и адрес крупно; второй — «Огонь».
const target = maxCells[0];
await enemyCell(pi, target).click();
await pi.waitForSelector('.bs-cell.aim');
const LET = 'АБВГДЕЖЗИК';
const want = `${LET[target % 10]}${Math.floor(target / 10) + 1}`;
assert.equal((await pi.locator('.bs-addr').textContent()).trim(), want, 'адрес цели — крупно');
// Тап по другой клетке — прицел переезжает, выстрела нет.
await enemyCell(pi, water[0]).click();
await pi.waitForSelector(`.bs-cell.aim[data-c="${water[0]}"]`);
assert.equal(room.match.log.length, 0, 'выбор — не выстрел');
await enemyCell(pi, target).click();
await pi.getByRole('button', { name: 'Огонь' }).click();
await until(() => room.match.log.length === 1, 'первый выстрел');
assert.equal(room.match.log[0].r === 'miss', false, 'попал');
await pi.waitForSelector(`.bs-grid:not(.mini) .bs-cell[data-c="${target}"].hit, .bs-grid:not(.mini) .bs-cell[data-c="${target}"].sunk`);
const fireMsg = await pi.evaluate(() => window.__sent.filter((m) => m.t === 'fire'));
assert.equal(fireMsg.length, 1);
assert.equal(fireMsg[0].cell, target);
step(`тап — прицел и адрес «${want}» крупно; другой тап — прицел переехал, выстрела нет; «Огонь» — выстрел`);

// Добить корабль целиком — «убил»: рамка вокруг корабля, клетки вокруг — пустые.
const ship = room.match.fleets[1].find((s) => shipCells(s).includes(target));
for (const c of shipCells(ship)) if (!room.match.shots[0].some((x) => x.c === c)) await shoot(pi, c);
await pi.waitForFunction(() => document.querySelectorAll('.bs-grid:not(.mini) .bs-ship.sunk').length === 1);
assert.ok(await enemy(pi).locator('.bs-cell.around').count() >= 3, 'вокруг убитого — точки');
assert.equal(await enemy(pi).locator('.bs-ship').count(), 1, 'на поле соперника — только потопленный корабль');
// В клетку около убитого — не выбрать.
await enemyCell(pi, await enemy(pi).locator('.bs-cell.around').first().getAttribute('data-c').then(Number)).click();
await pi.waitForSelector('#toast.show:has-text("Рядом с потопленным")');
step(`убил ${ship.len}-палубный: рамка вокруг корабля, клетки вокруг — точки; туда не прицелиться`);

// Мимо — ход у Макса; у Макса на своём поле — точка.
await shoot(pi, water[1]);
assert.equal(room.match.turn, 1);
await pm.waitForSelector('.ch-status.mine');
await pm.waitForSelector(`.bs-grid.mini .bs-cell[data-c="${water[1]}"].miss`).catch(() => null);
const maxMineMiss = await pm.locator(`.bs-grid.mini .bs-cell.miss`).count();
assert.equal(maxMineMiss, 1, 'Макс видит промах Ивана на своём поле');
assert.equal(await pm.locator('.bs-grid.mini .bs-ship').count(), 10, 'свой флот — весь');
await pi.waitForSelector('.ch-status:has-text("Стреляет соперник")');
assert.equal(await pi.getByRole('button', { name: 'Огонь' }).isDisabled(), true, 'не в свой ход «Огонь» выключен');
step('мимо — ход у Макса; у Макса на своём поле точка; у Ивана «Огонь» выключен');

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
await small.waitForSelector('.bs-fire');
for (const page of [pi, pm, pd, small]) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= iw, `страница шире экрана (${sw} > ${iw})`);
}
const fireBox = await small.locator('.bs-fire').boundingBox();
const gridBox = await small.locator('.bs-grid:not(.mini)').boundingBox();
assert.ok(fireBox.height >= 44 && fireBox.width >= 44, `«Огонь» не меньше 44 px (${Math.round(fireBox.width)}×${Math.round(fireBox.height)})`);
assert.ok(fireBox.y + fireBox.height <= 568, `«Огонь» на экране (низ ${Math.round(fireBox.y + fireBox.height)})`);
assert.ok(gridBox.x >= 0 && gridBox.x + gridBox.width <= 320, 'поле по ширине на экране');
const cell = await small.locator('.bs-grid:not(.mini) .bs-cell').first().boundingBox();
step(`на 320×568: без горизонтального скролла, поле и «Огонь» на экране (клетка ${Math.round(cell.width)} px — потому выстрел в два шага, «Огонь» ${Math.round(fireBox.width)}×${Math.round(fireBox.height)})`);

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
const ivanCells = room.match.fleets[0].flatMap(shipCells);
const ivanWater = Array.from({ length: 100 }, (_, c) => c).filter((c) => !ivanCells.includes(c));
await enemyCell(pm, ivanWater[0]).click();
await pm.getByRole('button', { name: 'Огонь' }).click();
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

assert.deepEqual(problems, [], 'ошибок в консоли страниц нет');
await browser.close();
app.stop?.();
console.log('e2e морского боя: всё сошлось');
process.exit(0);
