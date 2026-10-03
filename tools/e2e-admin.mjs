/**
 * Пульт владельца настоящим браузером: вкладки, живые сессии, «остановить
 * всё», рассылка с отложенной отправкой.
 *
 *   node tools/e2e-admin.mjs
 *
 * Два окна одновременно: у Ивана (он в ADMINS) — пульт, у Макса — стол. Всё,
 * что владелец нажимает, тут же проверяется на второй странице: игрок должен
 * увидеть экран обслуживания сам, без перезагрузки, и вернуться к столу,
 * когда обслуживание снимут.
 *
 * Тот же сервер, сокет и хаб, что в проде; Telegram — заглушка, токен —
 * одноразовый. Нужен Playwright с Chromium, как для tools/e2e.mjs.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { Broadcaster } from '../bot/broadcast.js';
import { Store } from '../bot/store.js';
import { startServer } from '../bot/server.js';
import { TelegramStub, cmdUpdate, dmUpdate, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8094);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const CHAT = -100779;

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

const ivan = user(101, 'Иван'); // он же владелец
const max = user(202, 'Макс');
const dima = user(303, 'Дима');

const api = new TelegramStub();
const store = new Store(':memory:');
const app = new App({
  api, store, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0,
  webappUrl: `http://localhost:${PORT}`, miniAppName: 'table', admins: ['101'],
});
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);
app.casts = new Broadcaster({ app });
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));

const step = (s) => console.log(`· ${s}`);

/**
 * Дождаться всплывашки С НУЖНЫМ ТЕКСТОМ.
 *
 * Не `waitForSelector('#toast.show')`: всплывашка висит 2,6 секунды, и на
 * быстрой машине предыдущая ещё на экране — проверка ловит её и радуется
 * чужому тексту. Ждать надо именно тот текст, которого добиваемся.
 */
async function toastSaid(page, re, what) {
  await page.waitForFunction(
    (src) => {
      const el = document.querySelector('#toast');
      return !!el && el.classList.contains('show') && new RegExp(src).test(el.textContent || '');
    },
    re.source,
    { timeout: 6000 }
  ).catch(async () => {
    const seen = await page.locator('#toast').innerText().catch(() => '');
    throw new Error(`не дождались всплывашки «${what || re}» — на экране «${seen}»`);
  });
}
async function until(cond, what, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/* --------------------------------------------------- игра, которую видно */

// Все трое нажали Start в личке — только таким бот и может написать.
for (const u of [ivan, max, dima]) {
  api.dmOpen.add(String(u.id));
  await app.handleUpdate(dmUpdate(u, '/start'));
}
await app.handleUpdate(cmdUpdate(CHAT, ivan, '/newgame', { message_id: 1 }));
await app.settle();
const room = app.room(CHAT);
step(`стол в группе создан: ${room.code}`);

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
const problems = [];
const pages = [];
async function openPage(u, startParam) {
  const page = await browser.newPage({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => problems.push(`${u.first_name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${u.first_name}: ${m.text()}`));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: startParam }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  pages.push(page);
  return page;
}

const pm = await openPage(max, room.code);
await pm.waitForSelector('h1');
await pm.getByRole('button', { name: 'Сесть за стол' }).click();
await until(() => room.players.length === 2, 'Макс сел');

const pa = await openPage(ivan, 'admin');
await pa.waitForSelector('h1:has-text("Пульт")');
assert.equal(await pa.locator('.tab').count(), 4, 'четыре вкладки');
step('Иван открыл пульт: Цифры · Сейчас · Рассылка · Пульт');

/* ------------------------------------------------------ вкладка «Сейчас» */

await pa.locator('.tab', { hasText: 'Сейчас' }).click();
await pa.waitForSelector('.sess');
const sessText = await pa.locator('.sess').first().innerText();
assert.match(sessText, /Покер/);
assert.ok(sessText.includes(room.code), 'код игры на месте — им её и завершают');
for (const name of ['Макс', 'Дима']) assert.ok(!sessText.includes(name), `в сессии есть имя ${name}`);
step('«Сейчас»: одна сессия — покер, группа, 2 за столом, код; ни одного имени игрока');

/* --------------------------------------------------- остановить всё и снять */

await pa.locator('.tab', { hasText: 'Пульт' }).click();
await pa.locator('.inp').first().fill('Обновляем дурака, 5 минут');
await pa.getByRole('button', { name: 'Остановить всё' }).click();
await pa.waitForSelector('.sheet');
await pa.locator('.sheet').getByRole('button', { name: 'Остановить', exact: true }).click();
await until(() => app.down, 'обслуживание включено');

await pm.waitForSelector('.down');
assert.match(await pm.locator('.down-text').innerText(), /Обновляем дурака/);
step('у Макса сам собой появился экран «Идёт обслуживание» с текстом владельца');

// Кнопок стола на этом экране нет вовсе — нажать нечего.
assert.equal(await pm.locator('.panel .btn').count(), 0, 'на экране обслуживания нет кнопок стола');
await pa.waitForSelector('.down-banner');

await pa.locator('.down-banner').getByRole('button', { name: /Снять/ }).click();
await until(() => !app.down, 'обслуживание снято');
await pm.waitForSelector('.hero, .lobby');
step('снял — Макс снова за столом, без перезагрузки');

/* ----------------------------------------------------------- рассылка */

await pa.locator('.tab', { hasText: 'Рассылка' }).click();
await pa.waitForSelector('.chips .chip');
assert.equal(await pa.locator('.chip').count(), 3, 'три аудитории');
assert.match(await pa.locator('.chip.on').innerText(), /3/, 'в «все» — трое, кто нажимал Start');

await pa.locator('.inp.area').fill('В субботу играем в дурака!');
await pa.getByRole('button', { name: 'Сначала себе' }).click();
await until(() => api.dms(101).some((x) => x.includes('В субботу')), 'письмо себе');
assert.equal(api.dms(202).some((x) => x.includes('В субботу')), false, 'остальным — ничего');
step('«Сначала себе»: письмо ушло только владельцу');

// Казино админка отправить откажется — запрет вшит, а не договорённость.
await pa.locator('.inp.area').fill('Лучшее казино для наших игроков');
await pa.getByRole('button', { name: 'Отправить', exact: true }).click();
await pa.waitForSelector('.sheet');
await pa.locator('.sheet').getByRole('button', { name: 'Отправить', exact: true }).click();
await toastSaid(pa, /казино/, 'отказ про казино');
assert.equal(store.broadcasts(5).length, 0, 'и рассылки не создалось');
step('казино не уходит: отказ объясняет, какое слово мешает');

await pa.locator('.inp.area').fill('В субботу играем в дурака!');
await pa.getByRole('button', { name: 'Отправить', exact: true }).click();
await pa.waitForSelector('.sheet');
assert.match(await pa.locator('.sheet').innerText(), /получат это письмо|получит это письмо/);
await pa.locator('.sheet').getByRole('button', { name: 'Отправить', exact: true }).click();
await until(() => api.dms(202).some((x) => x.includes('В субботу')), 'рассылка дошла до Макса');
await until(() => api.dms(303).some((x) => x.includes('В субботу')), 'и до Димы');

const letter = [...api.messages.values()].filter((m) => m.chatId === '202').at(-1);
assert.ok(letter.markup.inline_keyboard.flat().some((b) => b.callback_data === 'ads:off'), 'кнопка «не присылать» в письме');
step('рассылка ушла всем троим, в каждом письме — «не присылать такое»');

await until(() => store.broadcasts(1)[0]?.status === 'done', 'рассылка закончилась');
await pa.locator('.tab', { hasText: 'Цифры' }).click();
await pa.locator('.tab', { hasText: 'Рассылка' }).click();
await pa.waitForSelector('.cast-row');
assert.match(await pa.locator('.cast-row').first().innerText(), /ушла/);
step('в списке рассылок: ушла, столько-то из столько-то');

/* ------------------------------------------------ отложенная и отмена */

await pa.locator('.inp.area').fill('Через неделю турнир');
await pa.locator('.check input').check();
await pa.waitForSelector('input[type="datetime-local"]');
const later = new Date(Date.now() + 3 * 3600_000);
const pad = (n) => String(n).padStart(2, '0');
await pa.locator('input[type="datetime-local"]').fill(
  `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T${pad(later.getHours())}:${pad(later.getMinutes())}`
);
await pa.getByRole('button', { name: 'Запланировать' }).first().click();
await pa.waitForSelector('.sheet');
await pa.locator('.sheet').getByRole('button', { name: 'Запланировать' }).click();
await until(() => store.broadcasts(5).some((c) => c.status === 'scheduled'), 'рассылка запланирована');
step('отложенная рассылка запланирована на три часа вперёд');

await pa.locator('.cast-row.cs-scheduled').getByRole('button', { name: 'Отменить' }).click();
await until(() => store.broadcasts(5).every((c) => c.status !== 'scheduled'), 'отменена');
assert.equal(api.dms(202).some((x) => x.includes('турнир')), false, 'и ни одного письма про турнир');
step('отменил — не ушло ничего');

/* ------------------------------------------------------ завершить все */

await pa.locator('.tab', { hasText: 'Пульт' }).click();
await pa.getByRole('button', { name: /Завершить все/ }).click();
await pa.waitForSelector('.sheet');
await pa.locator('.sheet').getByRole('button', { name: 'Завершить все' }).click();
await until(() => room.status === 'finished', 'все игры завершены');
assert.match(api.groupTexts(CHAT).join('\n'), /ИТОГИ/, 'итоги ушли в группу, стол не пропал молча');
step('«завершить все»: игра закрыта, итоги в группе');

/* ------------------------------------------------------------- вёрстка */

for (const page of pages) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= iw, `страница шире экрана (${sw} > ${iw})`);
}
assert.deepEqual(problems, [], 'ошибок в консоли страниц нет');

await browser.close();
await web.close();
app.stop();
store.close();
console.log('e2e пульта: всё сошлось');
process.exit(0);
