/**
 * Стенд UX-симуляции «новичок»: настоящий сервер, сокет и страница, Telegram —
 * заглушка, токен одноразовый (как в tools/e2e-*.mjs). Ничего не чинит и не
 * оценивает: пробует жест и записывает, что РЕАЛЬНО произошло — какая команда
 * ушла на сервер, что изменилось на экране и какие слова увидел человек.
 *
 * Записанное сверяется с tools/ux-sim-baseline.json: изменилось управление —
 * прогон красный. Намеренную перемену записывают флагом --update.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { App } from '../../bot/app.js';
import { Hub } from '../../bot/hub.js';
import { startServer } from '../../bot/server.js';
import { TelegramStub, cmdUpdate, user } from '../../bot/tg-stub.js';
import { signInitData } from '../../bot/webapp-auth.js';

export { user, cmdUpdate };
export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE = path.join(ROOT, 'tools', 'ux-sim-baseline.json');

const require = createRequire(import.meta.url);
function playwright() {
  try { return require('playwright'); } catch { return require('/opt/node22/lib/node_modules/playwright'); }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(cond, what, ms = 8000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`);
    await sleep(20);
  }
}

/** Служебные сообщения страницы: это не действия человека. */
const NOISE = new Set(['hello', 'visible', 'chat-sync', 'chat-read', 'ping', 'ux', 'refresh']);

const sdkStub = (initData) => `
  window.__sent = []; window.__toasts = []; window.__opened = []; window.__shared = [];
  window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: new URLSearchParams(${JSON.stringify(initData)}).get('start_param') },
    ready(){}, expand(){}, close(){ window.__closed = true; }, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(u){ window.__opened.push(u); },
    shareMessage(id, cb){ window.__shared.push(id); cb && cb(true); },
    BackButton: { show(){ window.__back = true; }, hide(){ window.__back = false; }, onClick(f){ window.__backClick = f; } },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  } };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) { try { window.__sent.push(JSON.parse(data)); } catch {} return send.call(this, data); };
  addEventListener('DOMContentLoaded', () => {
    const t = document.getElementById('toast');
    if (t) new MutationObserver(() => { if (t.textContent && window.__toasts.at(-1) !== t.textContent) window.__toasts.push(t.textContent); })
      .observe(t, { childList: true, characterData: true, subtree: true });
  });`;

export async function createStand({ port = Number(process.env.E2E_PORT || 10211), miniapp = process.env.UX_SIM_MINIAPP || path.join(ROOT, 'miniapp') } = {}) {
  const api = new TelegramStub();
  const app = new App({ api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${port}`, miniAppName: 'table' });
  const token = `0:${crypto.randomBytes(16).toString('hex')}`;
  const hub = new Hub(app, { botToken: token });
  app.attachHub(hub);
  const web = startServer({ hub, port, root: miniapp, log: () => {} });
  await new Promise((r) => web.server.once('listening', r));
  const browser = await playwright().chromium.launch();
  const problems = [];
  let chat = -200000;
  const contexts = new Set();

  async function page(u, start, { width = 390, height = 844, touch = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: 'reduce' });
    contexts.add(ctx);
    const p = await ctx.newPage();
    p.setDefaultTimeout(8000);
    p.on('pageerror', (e) => problems.push(`${u.first_name}: ${e.message}`));
    p.on('console', (m) => m.type() === 'error' && problems.push(`${u.first_name}: ${m.text()}`));
    const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: start }, token);
    await p.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
    await p.goto(`http://localhost:${port}/`);
    return p;
  }

  const nextChat = () => String(--chat);

  /** Стол игры: хост и гости открывают страницы, садятся и (если start) начинают — кнопками. */
  async function table(game, { names = ['Иван', 'Макс'], settings = null, start = true, touch = false, width } = {}) {
    const users = names.map((n, i) => user(1000 + i, n));
    const room = app.createGame(game, { chatId: nextChat(), title: 'Клуб', host: { id: users[0].id, tgId: users[0].id, name: users[0].first_name }, settings });
    if (room.error) throw new Error(`стол ${game}: ${room.error}`);
    const pages = [];
    for (let i = 0; i < users.length; i++) {
      const p = await page(users[i], room.code, { touch, ...(width ? { width } : {}) });
      await p.waitForSelector('.lobby');
      if (i > 0) {
        await p.getByRole('button', { name: /^Сесть за/ }).first().click();
        await until(() => room.players.length === i + 1, `${names[i]} сел`);
      }
      pages.push(p);
    }
    if (start) {
      await pages[0].getByRole('button', { name: /▶ Начать/ }).click();
      await until(() => room.status === 'playing', 'партия началась');
      await sleep(250);
    }
    return { room, users, pages, byId: (id) => pages[users.findIndex((u) => String(u.id) === String(id))] };
  }

  async function closeAll() {
    for (const c of contexts) await c.close().catch(() => {});
    contexts.clear();
  }

  async function close() {
    await closeAll();
    await browser.close();
    await web.close?.();
    web.server.close?.();
  }

  return { app, api, hub, page, table, nextChat, problems, closeAll, close };
}

/* ------------------------------------------------------------------ жесты */

/** Точка на элементе: по умолчанию центр; в веере карт видна только левая кромка. */
export async function point(page, selector, at = null) {
  const loc = page.locator(selector).first();
  await loc.waitFor();
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  return at ? { x: b.x + at.x, y: b.y + at.y } : { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

export async function tapAt(page, p, { touch = false } = {}) {
  if (touch) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
  await sleep(180);
}

export async function drag(page, from, to, { touch = false } = {}) {
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + ((to.x - from.x) * i) / 6, y: from.y + ((to.y - from.y) * i) / 6 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
  }
  await sleep(220);
}

/** Что ушло на сервер с момента отметки (без служебного). */
const mark = (page) => page.evaluate(() => { window.__toasts.length = 0; return window.__sent.length; });
async function since(page, from) {
  await sleep(120);
  return page.evaluate(([n, noise]) => ({
    sent: window.__sent.slice(n).filter((m) => !noise.includes(m.t)).map((m) => (m.t === 'act' ? `act:${m.action}` : m.t === 'shop' ? `shop:${m.op}` : m.t)),
    toast: window.__toasts.at(-1) ?? null,
    opened: window.__opened.length,
  }), [from, [...NOISE]]);
}

/** Сделать `act` и записать исход. `look` — что изменилось на самой странице (локальный выбор и т. п.). */
export async function observe(page, act, look = null) {
  const n = await mark(page);
  await act();
  const r = await since(page, n);
  const out = { отправлено: r.sent.length ? r.sent.join('+') : '—' };
  if (r.toast) out.слова = r.toast;
  if (look) out.экран = await look(page);
  return out;
}

export const text = (page, selector) => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ').replace(/(⏱ )?\b\d{1,2}:\d\d\b/g, '⏱') || null, selector);
export const count = (page, selector) => page.locator(selector).count();
export const sheetTitle = (page) => text(page, '#sheet-root h3');
export const buttonsOf = (page, selector) => page.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.getBoundingClientRect().height > 0)
  .map((e) => `${(e.firstChild?.textContent || e.textContent).replace(/\s+/g, ' ').trim()}${e.disabled ? ' (выкл)' : ''}`), selector);

/* ------------------------------------------------------------------ эталон */

/**
 * Прогнать сценарии и сверить с эталоном. `scenarios` — [имя, async fn(stand) → объект].
 * Упавший сценарий — тоже расхождение (новичок упёрся там, где раньше проходил).
 */
export async function runSim(group, scenarios) {
  const update = process.argv.includes('--update');
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  const all = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
  const base = all[group] || {};
  const got = {};
  const stand = await createStand();
  let bad = 0;
  for (const [name, fn] of scenarios) {
    if (only && !name.includes(only)) continue;
    try {
      got[name] = JSON.parse(JSON.stringify(await fn(stand)));
    } catch (e) {
      if (process.env.UX_SIM_TRACE) console.log(e.stack);
      got[name] = { сбой: e.message.split('\n')[0] };
    }
    await stand.closeAll();
    const same = isDeepStrictEqual(got[name], base[name]);
    console.log(`${update ? '·' : same ? '✓' : '✗'} ${group} / ${name}`);
    if (update || !same) console.log(`    ${JSON.stringify(got[name])}`);
    if (!update && !same) {
      bad++;
      console.log(`    было: ${JSON.stringify(base[name])}`);
    }
    if (got[name].сбой) { console.log(`    СБОЙ: ${got[name].сбой}`); if (update) bad++; }
  }
  if (!Object.keys(got).length) { bad++; console.log(`ни один сценарий не подошёл под --only=${only}`); }
  if (stand.problems.length) { bad++; console.log(`ошибки страницы:\n  ${[...new Set(stand.problems)].join('\n  ')}`); }
  await stand.close();
  if (update && !bad) {
    all[group] = only ? { ...base, ...got } : got;
    fs.writeFileSync(BASELINE, `${JSON.stringify(all, null, 1)}\n`);
    console.log(`эталон записан: ${group}`);
  }
  console.log(bad ? `КРАСНО: расхождений ${bad}` : `зелено: ${Object.keys(got).length} сценариев`);
  process.exit(bad ? 1 : 0);
}
