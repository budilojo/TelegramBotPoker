/**
 * «Прыжки» экрана на новых разделах волны 3 (часть 3 задания агента Z, выполнил K):
 * «Обучение», «Тренировка» (список направлений, упражнение каждого из восьми направлений,
 * разбор, «Мой прогресс»), выбор уровня и диагностика, матрица 13×13 внутри упражнения.
 *
 *   node tools/e2e-scroll-train.mjs               # проверка, падает при скачке
 *   SCROLL_TABLE=1 node tools/e2e-scroll-train.mjs   # только таблица, без падения
 *   SHOTS=1 node tools/e2e-scroll-train.mjs          # снимки в preview/wave3/
 *
 * Окна 320×568 и 390×844; перед замером окно делается ниже (как в e2e-scroll.mjs) — иначе
 * на коротком экране нечего прокручивать и проверка ничего не доказывает.
 * Прокрутку никто не восстанавливает руками: смотрим, что узел-скроллер тот же и позиция на месте.
 * Это Chromium с эмуляцией телефона, а не iOS/Android WebView: клавиатуру и жесты Telegram он не воспроизводит.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { Store } from '../bot/store.js';
import { startServer } from '../bot/server.js';
import { TelegramStub, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';
import { measure } from './lib/scroll-probe.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8097);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const TABLE_ONLY = !!process.env.SCROLL_TABLE;
const SHOTS = process.env.SHOTS === '1' ? path.join(ROOT, 'preview', 'wave3') : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
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
const SIZES = [[320, 568], [390, 844]];
const TRACKS = ['preflop', 'ranges', 'outs', 'potodds', 'postflop', 'readrange', 'hands', 'advanced'];

async function open(size, who = ivan) {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: who, start_param: 'solo' }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('h1:has-text("Игры с ботами")');
  page.ctx = ctx;
  return page;
}

const shot = (page, name, tag) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}-${tag}.png`) });

/** Найти прокручиваемый предок узла и пометить его — дальше он называется `[data-scr]`. */
async function markScroller(page, from) {
  return page.evaluate((from) => {
    document.querySelectorAll('[data-scr]').forEach((e) => e.removeAttribute('data-scr'));
    let el = document.querySelector(from);
    while (el && el !== document.documentElement) {
      const o = getComputedStyle(el).overflowY;
      if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 1) { el.setAttribute('data-scr', '1'); return true; }
      el = el.parentElement;
    }
    const d = document.scrollingElement;
    return d.scrollHeight > d.clientHeight + 1 ? 'document' : false;
  }, from);
}

/**
 * Один замер. Если экран при этом окне не прокручивается — проверка пустая; это не провал
 * (на некоторых экранах содержимое короткое), но в таблице помечено «не прокручивается».
 */
async function probe(page, screen, tag, from, label, act, { must = false, by = null, intended = false } = {}) {
  // `act` — локатор (нажать на него) или функция; `by` — локатор, который перед замером ставят в середину экрана.
  const isLoc = typeof act?.click === 'function';
  const target = isLoc ? act : by;
  const action = isLoc ? () => act.click() : act;
  const marked = await markScroller(page, from);
  const scroller = marked === 'document' ? 'document' : marked ? '[data-scr]' : null;
  if (!scroller) {
    rows.push({ screen: `${screen} · ${tag}`, label, scrollable: false, ok: !must, bad: must ? 'экран не прокручивается — проверка пустая' : '' });
    await action();
    return;
  }
  let y0 = null;
  const act2 = async () => { if (target) { const bb = await target.boundingBox({ timeout: 300 }).catch(() => null); y0 = bb ? bb.y : null; } await action(); };
  const m = await measure(page, { scroller, at: 'middle', target }, act2);
  // Высота над нажатой кнопкой могла измениться: тогда браузер сам держит её на месте (scroll anchoring) и
  // scrollTop другой. Для игрока важно, не уехала ли сама кнопка — смотрим её положение на экране.
  let visual = null;
  if (m.jumped && y0 != null && target) { const bb = await target.boundingBox({ timeout: 300 }).catch(() => null); if (bb) visual = Math.round(bb.y - y0); }
  const bad = [];
  if (m.error) bad.push(m.error);
  else {
    if (m.recreated) bad.push('скроллер пересоздан');
    if (m.jumped && !intended && !(visual != null && Math.abs(visual) <= 2)) bad.push(`прыжок ${m.before}→${m.after} (отклонение ${m.deviation}${visual != null ? `; кнопка сдвинулась на ${visual}px` : ''})`);
    if (m.focusLost) bad.push('потерян фокус');
  }
  rows.push({ screen: `${screen} · ${tag}`, label: label + (intended && m.jumped ? ' [прокрутка по замыслу]' : (m.jumped && visual != null && Math.abs(visual) <= 2 ? ' [браузер держит кнопку на месте]' : '')), scrollable: !!m.scrollable, ok: bad.length === 0, bad: bad.join('; ') });
}

const setValue = (page, sel, v) => page.locator(sel).first().evaluate((el, v) => {
  el.value = String(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, v);

/** Нажать всё нужное для ответа в упражнении; возвращает вид виджета (для таблицы). */
/** На экране не должно быть служебных слов (так в упражнении однажды появилось слово «null» под кнопкой). */
async function noJunk(page, screen, tag, when) {
  const txt = await page.evaluate(() => document.body.innerText);
  const m = txt.match(/\b(null|undefined|NaN)\b|\[object \w+\]/);
  if (m && process.env.JUNK_DEBUG) console.log('JUNK', await page.evaluate(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (/\b(null|undefined|NaN)\b/.test(n.textContent)) return n.parentElement.outerHTML.slice(0, 300) + ' << ' + n.parentElement.parentElement.className; }));
  rows.push({ screen: `${screen} · ${tag}`, label: `нет служебных слов (${when})`, scrollable: true, ok: !m, bad: m ? `на экране «${m[0]}»` : '' });
}

async function answer(page, screen, tag, kind) {
  const from = '.tr-body';
  if (await page.locator('.tr-body .rg').count()) {
    kind = 'range';
    await probe(page, screen, tag, from, 'матрица: тап по клетке AA', page.locator('[data-h="AA"]').first());
    await probe(page, screen, tag, from, 'матрица: набор «Пары»', page.locator('[data-preset="pairs"]'));
    await probe(page, screen, tag, from, 'матрица: «Крупно» вкл', page.locator('button[aria-label="Увеличить матрицу"]'));
    await probe(page, screen, tag, from, 'матрица: «Крупно» выкл', page.locator('button[aria-label="Увеличить матрицу"]'));
    await probe(page, screen, tag, from, 'матрица: режим рисования протяжкой', page.locator('button[aria-label="Режим рисования протяжкой"]'));
    await page.locator('button[aria-label="Режим рисования протяжкой"]').click();
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (ov > 0) problems.push(`${screen} ${tag}: горизонтальный скролл ${ov}px на матрице`);
  } else if (await page.locator('.tr-body .tm-pick').count()) {
    kind = 'cards';
    const n = await page.locator('.tr-body .tm-pick').count();
    for (let i = 0; i < Math.min(n, 5); i++) {
      if (!(await page.locator('[data-go="check"]').isDisabled())) break;
      await probe(page, screen, tag, from, `карты: выбор карты ${i + 1}`, page.locator('.tr-body .tm-pick').nth(i));
    }
  } else if (await page.locator('.tr-body .tm-bet').count()) {
    kind = 'bet';
    await probe(page, screen, tag, from, 'ставка: быстрая кнопка', page.locator('.tr-body .tm-q').first());
    await probe(page, screen, tag, from, 'ставка: ползунок', () => setValue(page, '.tr-body .tm-range', 0), { by: page.locator('.tr-body .tm-range').first() });
  } else if (await page.locator('.tr-body .tm-slider').count()) {
    kind = 'slider';
    await probe(page, screen, tag, from, 'число: ползунок', () => setValue(page, '.tr-body .tm-range', 1), { by: page.locator('.tr-body .tm-range').first() });
  } else if (await page.locator('.tr-body .tm-table').count()) {
    kind = 'table';
    for (let i = 0; i < 6 && await page.locator('[data-go="check"]').isDisabled(); i++) {
      const opts = page.locator('.tr-body .tm-step').last().locator('.tm-opt');
      const opt = (await opts.count()) ? opts.first() : page.locator('.tr-body .tm-opt').first();
      await probe(page, screen, tag, from, `раздача: решение ${i + 1}`, opt);
    }
  } else if (await page.locator('.tr-body .tr-opt').count()) {
    kind = 'pick';
    await probe(page, screen, tag, from, 'выбор варианта', page.locator('.tr-body .tr-opt').nth(1));
  }
  return kind;
}

try {
  for (const size of SIZES) {
    const tag = `${size[0]}×${size[1]}`;
    const low = (page) => page.setViewportSize({ width: size[0], height: 360 });
    const full = (page) => page.setViewportSize({ width: size[0], height: size[1] });
    const page = await open(size);

    /* ---- вход: форма покера → «Тренировка»; первый заход — выбор уровня ---- */
    await page.locator('.game-card.g-poker').click();
    await page.waitForSelector('.sheet .seg.solo-mode');
    await page.locator('.sheet .seg.solo-mode button', { hasText: 'Тренировка' }).click();
    await page.waitForSelector('[data-pl=zero]');
    await shot(page, '1-pl-cards', tag);
    await low(page);
    const S1 = 'выбор уровня (три карточки)';
    await probe(page, S1, tag, '.pl', 'нажатие серой карточки «по истории»', () => page.locator('[data-pl=history]').dispatchEvent('click'));
    await full(page);

    /* ---- диагностика ---- */
    await page.locator('[data-pl=quiz]').click();
    await page.waitForSelector('.pl-prompt').catch(async (e) => { console.log((await page.locator('body').innerText()).slice(0, 500)); throw e; });
    await shot(page, '2-pl-quiz', tag);
    await low(page);
    let n = 0;
    while (await page.locator('.pl-prompt').count()) {
      n += 1;
      if (n > 14) break;
      if (n === 1) await probe(page, 'диагностика · задание', tag, '.pl', 'выбор варианта (следующий вопрос — новый экран, начинается сверху)', page.locator('.pl-opt').first(), { intended: true });
      else if (n === 2) await probe(page, 'диагностика · задание', tag, '.pl', '«Не знаю» (следующий вопрос — новый экран)', page.locator('.pl-skip'), { intended: true });
      else if (await page.locator('.pl-opt').count()) await page.locator('.pl-opt').first().click();
      else await page.locator('.pl-skip').click();
      await page.waitForTimeout(80);
    }
    await page.waitForSelector('.pl-rows');
    await full(page); await shot(page, '3-pl-result', tag); await low(page);
    await probe(page, 'диагностика · итог', tag, '.pl', 'уровень навыка «+»', page.locator('[data-pm="math+"]'));
    await probe(page, 'диагностика · итог', tag, '.pl', 'уровень навыка «−»', page.locator('[data-pm="math-"]'));
    await full(page);
    await page.locator('[data-pl=confirm]').click();
    await page.waitForSelector('h1:has-text("Тренировка")');
    await noJunk(page, 'Тренировка · список направлений', tag, 'главная');
    await shot(page, '4-train-home', tag);

    /* ---- список направлений ---- */
    await low(page);
    await page.locator('.tr-track[data-track="outs"]').click();
    await page.waitForSelector('.tr-levels');
    await noJunk(page, 'Тренировка · направление', tag, 'направление');
    await shot(page, '5-track', tag);
    for (const lv of [3, 1]) await probe(page, 'Тренировка · направление', tag, '.tr', `сложность: уровень ${lv}`, () => page.locator(`.tr-levels button[data-level="${lv}"]`).dispatchEvent('click'), { must: true });
    await page.locator('.back-link', { hasText: 'Тренировка' }).click();
    await page.waitForSelector('.tr-track');
    await full(page);

    /* ---- упражнение каждого из восьми направлений ---- */
    const kinds = {};
    for (const track of TRACKS) {
      await page.locator(`.tr-track[data-track="${track}"]`).click();
      await page.waitForSelector('.tr-levels');
      // «Постфлоп» берём со 2 уровня: там задания на размер ставки (вид «bet»), на 1-м их нет.
      if (track === 'postflop') await page.locator('.tr-levels button[data-level="2"]').dispatchEvent('click');
      await page.waitForTimeout(150);
      await page.locator('[data-go="start"]').click();
      await page.waitForSelector('.tr-ex');
      const S = `упражнение «${track}»`;
      const seen = new Set();
      for (let i = 0; i < 3; i++) {
        await page.waitForSelector('.tr-ex .tr-prompt');
        await low(page);
        await noJunk(page, S, tag, 'задание');
        const k = await answer(page, S, tag, null);
        seen.add(k || '?');
        await full(page);
        if (i === 0) await shot(page, `6-ex-${track}`, tag);
        if (await page.locator('[data-go="check"]').isDisabled()) { rows.push({ screen: `${S} · ${tag}`, label: 'ответ не набирается — «Проверить» выключена', scrollable: true, ok: false, bad: `вид ${k}` }); break; }
        await low(page);
        await probe(page, S, tag, '.tr-body', 'кнопка «Проверить» → разбор (экран подводит к разбору)', page.locator('[data-go="check"]'), { intended: true });
        await page.waitForSelector('.tr-explain');
        await noJunk(page, S, tag, 'разбор');
        if (i === 0) { await full(page); await shot(page, `7-review-${track}`, tag); await low(page); }
        if (i === 1 && await page.locator('[data-go="lesson"]').count()) {
          // ошибка → «Изучить тему» → урок → «Вернуться к заданию»
          const prompt = await page.locator('.tr-prompt').innerText();
          await page.locator('[data-go="lesson"]').click();
          await page.waitForSelector('.ln-lesson');
          await full(page); await shot(page, `8-lesson-from-error-${track}`, tag);
          await page.getByRole('button', { name: 'Вернуться к заданию' }).first().click();
          await page.waitForSelector('.tr-ex .tr-prompt');
          const again = await page.locator('.tr-prompt').innerText();
          if (again !== prompt) rows.push({ screen: `${S} · ${tag}`, label: 'вернулись к заданию', scrollable: true, ok: false, bad: 'задание другое, не то же самое' });
          else rows.push({ screen: `${S} · ${tag}`, label: '«Изучить тему» → урок → «Вернуться к заданию»: то же задание', scrollable: true, ok: true, bad: '' });
          await full(page);
          break;
        }
        await full(page);
        await page.locator('[data-go="next"]').click();
      }
      kinds[track] = [...seen];
      // выйти из подхода
      await page.waitForSelector('.tr-back');
      await page.locator('.tr-back').click();
      if (await page.locator('.sheet [data-go="leave"]').count()) await page.locator('.sheet [data-go="leave"]').click();
      await page.waitForSelector('.tr-levels');
      await page.locator('.back-link', { hasText: 'Тренировка' }).click();
      await page.waitForSelector('.tr-track');
    }
    console.log(`виды заданий, которые встретились (${tag}):`, JSON.stringify(kinds));

    /* ---- «Мой прогресс» ---- */
    await page.locator('[data-go="stats"]').click();
    await page.waitForSelector('h1:has-text("Мой прогресс")');
    await noJunk(page, 'Мой прогресс', tag, 'после подхода');
    await shot(page, '9-stats', tag);
    await page.locator('.back-link').first().click();
    await page.waitForSelector('.tr-track');

    /* ---- «Определить уровень заново» ---- */
    await page.locator('[data-go="placement"]').click();
    await page.waitForSelector('[data-pl=zero]');
    await low(page);
    await probe(page, 'выбор уровня заново', tag, '.pl', 'нажатие серой карточки', () => page.locator('[data-pl=history]').dispatchEvent('click'));
    await full(page);
    await page.close();

    /* ---- «Обучение» ---- */
    const L = await open(size);
    await L.locator('.game-card.g-poker').click();
    await L.waitForSelector('.sheet .seg.solo-mode');
    await L.locator('.sheet .seg.solo-mode button', { hasText: 'Обучение' }).click();
    await L.waitForSelector('.learn h1:has-text("Обучение")');
    await noJunk(L, 'Обучение · курс', tag, 'список');
    await shot(L, '10-learn-home', tag);
    await low(L);
    await probe(L, 'Обучение · курс', tag, '.lobby', 'открыть урок «Правило 2 и 4»', L.locator('.ln-lesson-item', { hasText: 'Правило 2 и 4' }));
    await L.waitForSelector('.ln-lesson input[type=range]');
    await full(L); await noJunk(L, 'Обучение · урок', tag, 'урок'); await shot(L, '11-lesson', tag); await low(L);
    await probe(L, 'Обучение · урок', tag, '.lobby', 'ползунок (интерактивный пример)', () => L.locator('.ln-lesson input[type=range]').first().evaluate((el) => { el.value = '12'; el.dispatchEvent(new Event('input', { bubbles: true })); }), { must: true });
    await probe(L, 'Обучение · урок', tag, '.lobby', 'ответ в «Проверьте себя»', L.locator('.ln-option').first(), { must: true });
    await L.page?.close?.();
    await full(L);
    await L.close();
  }
} catch (e) {
  rows.push({ screen: 'сценарий', label: String(e.message).split('\n')[0], scrollable: true, ok: false, bad: 'сценарий оборвался' });
  console.error(e);
} finally {
  const w = Math.max(...rows.map((r) => r.screen.length));
  for (const r of rows) console.log(`${r.ok ? (r.scrollable ? 'ок   ' : 'ок(не прокручивается)') : 'СКАЧОК'} ${r.screen.padEnd(w)} | ${r.label}${r.ok ? '' : ` — ${r.bad}`}`);
  await browser.close();
  web.server.close();
}
const failed = rows.filter((r) => !r.ok);
if (problems.length) console.log('ошибки консоли:', [...new Set(problems)]);
console.log(`\nпроверено нажатий: ${rows.length}, со скачком или сбоем: ${failed.length}`);
if (!TABLE_ONLY && (failed.length || problems.length)) process.exit(1);
process.exit(0);
