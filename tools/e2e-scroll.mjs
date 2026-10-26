/**
 * «Прыжки» экрана: нажатия внутри прокрученной шторки или экрана не должны
 * сдвигать прокрутку и пересоздавать прокручиваемый узел (docs/scroll.md).
 *
 *   node tools/e2e-scroll.mjs            # проверка, падает при скачке
 *   SCROLL_TABLE=1 node tools/e2e-scroll.mjs   # только таблица «экран → действие → скачок», без падения
 *
 * Экраны: форма «Игры с ботами» (покер и шахматы), «Новое лобби» покера в хабе
 * группы, «Настройки стола» хоста. Окна 320×568 и 390×844. Telegram — заглушка,
 * браузер — Chromium с эмуляцией телефона: клавиатуру и жесты настоящего
 * iOS/Android WebView это не воспроизводит.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { Store } from '../bot/store.js';
import { startServer } from '../bot/server.js';
import { TelegramStub, cmdUpdate, dmUpdate, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';
import { measure } from './lib/scroll-probe.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8097);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const TABLE_ONLY = !!process.env.SCROLL_TABLE;
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

const ivan = user(101, 'Иван');
const api = new TelegramStub();
const app = new App({ api, store: new Store(':memory:'), botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${PORT}`, miniAppName: 'table' });
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));
api.dmOpen.add('101');
await app.handleUpdate(dmUpdate(ivan, '/start'));
await app.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: -9001, type: 'supergroup', title: 'Первая' }, from: ivan, text: '/game', date: Math.floor(Date.now() / 1000) } });
await app.settle();
await app.handleUpdate(cmdUpdate(-9002, ivan, '/newgame', { message_id: 2 }));
await app.settle();
const lobbyCode = app.room(-9002).code;

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
const rows = [];

async function open(startParam, size, who = ivan) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: who, start_param: startParam }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  return page;
}

/** Нажатие на кнопку внутри шторки по точному тексту. */
const press = (page, text) => page.locator('.sheet button', { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) }).first();

/**
 * Один замер. `must` — экран обязан прокручиваться при этом окне (иначе проверка
 * ничего не доказывает и это ошибка самой проверки).
 */
async function probe(page, screen, tag, scroller, label, target, { must = false, at = 'middle' } = {}) {
  const isLoc = typeof target?.click === 'function';
  const m = await measure(page, { scroller, at, target: isLoc ? target : null }, isLoc ? () => target.click() : target);
  const bad = [];
  if (m.error) bad.push(m.error);
  else {
    if (m.recreated) bad.push('скроллер пересоздан');
    if (m.jumped) bad.push(`прыжок ${m.before}→${m.after} (отклонение ${m.deviation})`);
    if (m.focusLost) bad.push('потерян фокус');
    if (must && !m.scrollable) bad.push('экран не прокручивается — проверка пустая');
  }
  if (process.env.SCROLL_DEBUG && bad.length) console.log(JSON.stringify(m));
  rows.push({ screen: `${screen} · ${tag}`, label, scrollable: !!m.scrollable, ok: bad.length === 0, bad: bad.join('; ') });
}

const SIZES = [[320, 568], [390, 844]];

try {
  for (const size of SIZES) {
    const tag = `${size[0]}×${size[1]}`;
    const short = size[1] < 600; // на низком окне форма покера точно длиннее экрана

    /* ---- Игры с ботами: форма покера ---- */
    {
      const page = await open('solo', size);
      await page.waitForSelector('h1:has-text("Игры с ботами")');
      await page.locator('.game-card.g-poker').click();
      await page.waitForSelector('.sheet .seg.solo-mode');
      await page.waitForTimeout(400);
      const S = 'форма «Игры с ботами» · покер';
      await probe(page, S, tag, '.sheet', 'блайнды 100/200', press(page, '100/200'), { must: short });
      await probe(page, S, tag, '.sheet', 'стек 20.000', press(page, '20.000'), { must: short });
      await probe(page, S, tag, '.sheet', 'рост блайндов «Не растут»', press(page, 'Не растут'), { must: short });
      await probe(page, S, tag, '.sheet', 'рост блайндов «Растут»', press(page, 'Растут'), { must: short });
      await probe(page, S, tag, '.sheet', 'число соперников 5', press(page, '5'), { must: short });
      await probe(page, S, tag, '.sheet', 'уровень (сегмент «Уровень»)', page.locator('.sheet .seg.wide button').nth(1), { must: short });
      await probe(page, S, tag, '.sheet', 'характеры → «Выбрать самому»', press(page, 'Выбрать самому'), { must: short });
      // «Обучение» и «Тренировка» теперь не вкладки шторки, а переход на свой экран
      // (closeSheet + openRoute): там шторки нет. Их экраны проверит часть 3.
      await page.close();
    }

    /* ---- Игры с ботами: форма шахмат ---- */
    {
      const page = await open('solo', size);
      await page.waitForSelector('h1:has-text("Игры с ботами")');
      await page.locator('.game-card.g-chess').click();
      await page.waitForSelector('.sheet .seg');
      await page.waitForTimeout(400);
      const S = 'форма «Игры с ботами» · шахматы';
      await probe(page, S, tag, '.sheet', 'часы 10 мин', press(page, '10 мин'), { must: short });
      await probe(page, S, tag, '.sheet', 'цвет «Чёрные»', press(page, 'Чёрные'), { must: short });
      await page.close();
    }

    /* ---- Хаб группы: «Новое лобби» покера ---- */
    {
      const page = await open('', size);
      await page.waitForSelector('h1:has-text("Ваши группы")');
      await page.locator('.lrow', { hasText: 'Первая' }).getByRole('button', { name: 'Открыть' }).click();
      await page.waitForSelector('h1:has-text("Выберите игру")');
      await page.locator('.game-card.g-poker').click();
      await page.waitForSelector('.sheet .seg');
      await page.waitForTimeout(400);
      const S = 'хаб группы · новое лобби покера';
      await probe(page, S, tag, '.sheet', 'таймер хода 60 с', press(page, '60 с'), { must: short });
      await probe(page, S, tag, '.sheet', 'карты «Настоящие»', press(page, '🃏 Настоящие'), { must: short });
      await page.close();
    }

    /* ---- Лобби покера: настройки стола хоста ---- */
    {
      const page = await open(lobbyCode, size);
      await page.waitForSelector('.lobby');
      await page.getByRole('button', { name: /Настройки стола/ }).click();
      await page.waitForSelector('.sheet h3:has-text("Настройки стола")');
      await page.waitForTimeout(400);
      const S = 'лобби покера · настройки стола';
      await probe(page, S, tag, '.sheet', 'рост блайндов «Растут»', press(page, 'Растут'), { must: short });
      await probe(page, S, tag, '.sheet', 'уровень каждые 20 мин', press(page, '20 мин'), { must: short });
      await probe(page, S, tag, '.sheet', 'таймер хода 90 с', press(page, '90 с'), { must: short });
      await probe(page, S, tag, '.sheet', 'рост блайндов «Не растут»', press(page, 'Не растут'), { must: short });
      await page.close();
    }

    /* ---- Сам экран (не шторка): пришло новое состояние с сервера, пока лобби прокручено ---- */
    {
      const page = await open(lobbyCode, size);
      await page.waitForSelector('.lobby');
      const friend = await open(lobbyCode, size, user(202 + SIZES.indexOf(size), 'Друг'));
      await friend.waitForSelector('.lobby');
      const S = 'лобби покера · сам экран';
      // Хост сидит; ниже на экране добавим длинное, чтобы было что прокручивать.
      await page.setViewportSize({ width: size[0], height: 380 }); // низкое окно: лобби точно длиннее экрана
      await probe(page, S, tag, '.lobby', 'друг сел за стол (пришло состояние)', async () => {
        await friend.getByRole('button', { name: 'Сесть за стол' }).click();
        await page.waitForSelector(`text=${2 + SIZES.indexOf(size)}/8`);
      }, { at: 'bottom', must: true });
      await friend.close();
      await page.close();
    }
  }
} finally {
  const w = Math.max(...rows.map((r) => r.screen.length));
  for (const r of rows) console.log(`${r.ok ? 'ок   ' : 'СКАЧОК'} ${r.screen.padEnd(w)} | ${r.label}${r.ok ? '' : ` — ${r.bad}`}`);
  await browser.close();
  web.server.close();
}
const failed = rows.filter((r) => !r.ok);
if (problems.length) console.log('ошибки консоли:', problems);
console.log(`\nпроверено нажатий: ${rows.length}, со скачком: ${failed.length}`);
if (!TABLE_ONLY && (failed.length || problems.length)) process.exit(1);
process.exit(0);
