/**
 * Зонд «карты уехали»: игра с ботами (покер и дурак) в настоящем браузере
 * на экране iPhone, с помехами — замедленный процессор, смена размера окна
 * посреди анимаций, уход в фон и обратно, быстрые серии состояний. После
 * каждого шага ждём, пока анимации закончатся, и меряем КАЖДУЮ карту стола
 * и руки: целиком в окне, не прозрачна, не перекрыта.
 *
 *   node tools/cards-probe.mjs [poker|durak] [шагов]
 *
 * Переменные: ENGINE=webkit (движок iPhone; `npx playwright install webkit`),
 * OPP=1…N или 99 (соперников; 99 — сколько можно), VP=390x700 (окно),
 * SIZES=1 (масштаб и ширина карт на каждом шаге), WHY=1 (почему стол
 * «тесный» и что даёт свежий пересчёт), SHOTS=1 (снимок каждого шага в preview/).
 *
 * Разведочный инструмент (не входит в npm test и npm run e2e): им найдена
 * причина «карты отдаляются» — 2026-10-21, docs/brain/decisions/017.
 * Охраняет найденное не он, а tools/e2e.mjs и tools/e2e-durak.mjs
 * (tools/cards-in-place.mjs).
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { startServer } from '../bot/server.js';
import { TelegramStub, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8097);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const GAME = process.argv[2] || 'poker';
const STEPS = Number(process.argv[3] || 60);
const require = createRequire(import.meta.url);
const pw = require('playwright');
const ENGINE = process.env.ENGINE || 'chromium';

const ivan = user(101, 'Иван');
const api = new TelegramStub();
const app = new App({ api, botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 300, webappUrl: `http://localhost:${PORT}`, miniAppName: 'table' });
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);
const web = startServer({ hub, port: PORT, root: path.join(ROOT, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));

const sdkStub = (initData) => `
  window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: 'solo' },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(e, f){ (window.__tgev ||= {})[e] = f; }, openTelegramLink(){},
    BackButton: { show(){}, hide(){}, onClick(){} },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  } };`;

const browser = await pw[ENGINE].launch();
const [VW, VH] = (process.env.VP || '390x844').split('x').map(Number);
const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 3, ...(ENGINE === 'webkit' ? { isMobile: true, hasTouch: true } : {}) });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
const cdp = ENGINE === 'chromium' ? await ctx.newCDPSession(page) : { send: async () => {} };
const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: ivan, start_param: 'solo' }, TOKEN);
await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
await page.goto(`http://localhost:${PORT}/`);
await page.waitForSelector('h1:has-text("Игры с ботами")');
await page.getByRole('button', { name: GAME === 'poker' ? /Покер/ : /Дурак/ }).first().click();
if (process.env.OPP) {
  const seg = page.locator('.section-label:has-text("Соперников") + *').locator('button');
  await seg.nth(Number(process.env.OPP) === 99 ? (await seg.count()) - 1 : Number(process.env.OPP) - 1).click();
}
await page.getByRole('button', { name: '▶ Играть' }).click();
await page.waitForSelector(GAME === 'poker' ? '.table' : '.dk-felt');

/** In the page: every card on the table and in the hand is inside the window, visible and on top. */
const measure = () => page.evaluate(() => {
  const bad = [];
  const W = innerWidth;
  const H = innerHeight;
  for (const img of document.querySelectorAll('#app img.card')) {
    const r = img.getBoundingClientRect();
    const where = img.closest('.board') ? 'стол' : img.closest('.hero-cards, .dk-hand') ? 'рука' : img.closest('.dk-pairs') ? 'стол' : img.closest('.minis') ? 'место' : 'другое';
    if (where === 'другое') continue;
    const id = `${where} ${img.alt}`;
    if (r.width < 4) { bad.push(`${id}: ширина ${r.width}`); continue; }
    if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) bad.push(`${id}: за краем ${r.left.toFixed(0)},${r.top.toFixed(0)}–${r.right.toFixed(0)},${r.bottom.toFixed(0)}`);
    let op = 1;
    for (let e = img; e && e !== document.body; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    if (op < 0.3) bad.push(`${id}: прозрачность ${op.toFixed(2)}`);
    const cs = getComputedStyle(img);
    const tf = cs.transform;
    if (tf !== 'none') {
      const m = new DOMMatrix(tf);
      if (Math.abs(m.e) > 12 || Math.abs(m.f) > 12 || Math.hypot(m.a, m.b) < 0.9) bad.push(`${id}: transform ${tf}`);
    }
  }
  const t = document.querySelector('.table, .dk-felt');
  const w = (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().width || 0);
  const size = `u=${t?.style.getPropertyValue('--u')} стол=${w('.board img.card, .dk-pair img.att')} рука=${w('.hero-cards img.card, .dk-hand img.card')} на столе ${document.querySelectorAll('.board img.card, .dk-pairs img.card').length}`;
  return { bad, size, anims: document.getAnimations().length };
});

async function settle() {
  for (let i = 0; i < 100; i++) {
    const n = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' || a.playState === 'paused' && a.currentTime < (a.effect?.getComputedTiming().endTime ?? 0)).length);
    if (!n) return;
    await page.waitForTimeout(100);
  }
}

async function act() {
  if (GAME === 'poker') {
    const btn = page.locator('.panel button', { hasText: /^(Check|Call|Следующая раздача|Fold anyway\?)/ }).first();
    if (await btn.count()) await btn.click({ timeout: 500 }).catch(() => {});
    const more = page.locator('button', { hasText: /Ещё раз|Сыграть ещё|Новая игра/ }).first();
    if (await more.count()) await more.click({ timeout: 500 }).catch(() => {});
  } else {
    const ok = page.locator('.dk-hand .dk-card:has(img.ok)').first();
    if (await ok.count()) {
      await ok.click({ timeout: 500 }).catch(() => {});
      await ok.click({ timeout: 500 }).catch(() => {});
      const tgt = page.locator('.dk-pair.target').first();
      if (await tgt.count()) await tgt.click({ timeout: 500 }).catch(() => {});
    } else {
      const btn = page.locator('.panel button', { hasText: /бито|взять|следующая партия|пас|ещё/i }).first();
      if (await btn.count()) await btn.click({ timeout: 500 }).catch(() => {});
    }
  }
}

const SIZES = [[390, 844], [390, 600], [320, 568], [390, 844], [375, 667]];
const report = [];
for (let i = 0; i < STEPS; i++) {
  const mode = i % 5;
  if (mode === 0) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await act();
  await page.waitForTimeout(40 + (i * 37) % 200);
  if (mode === 1 || mode === 3) {
    // Окно меняется посреди анимации (шапка Telegram, клавиатура, поворот).
    const [w, hgt] = SIZES[i % SIZES.length];
    await page.setViewportSize({ width: w, height: hgt });
    await page.evaluate(() => window.__tgev?.viewportChanged?.({ isStateStable: false }));
    await page.waitForTimeout(60);
    await page.setViewportSize({ width: VW, height: VH });
    await page.evaluate(() => window.__tgev?.viewportChanged?.({ isStateStable: true }));
  }
  if (mode === 2) {
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
  if (mode === 4) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await settle();
  const m = await measure();
  if (process.env.SIZES) console.log(`шаг ${i}: ${m.size}`);
  if (process.env.WHY) console.log('   после resize:', await page.evaluate(() => { window.dispatchEvent(new Event('resize')); const t = document.querySelector('.table, .dk-felt'); return t?.style.getPropertyValue('--u') + ' карта ' + Math.round(document.querySelector('.board img.card, .dk-pair img.att')?.getBoundingClientRect().width || 0); }));
  if (process.env.WHY && GAME === 'poker') console.log('   почему тесно:', await page.evaluate(() => {
    const t = document.querySelector('.table'); if (!t) return '';
    const hit = (a, b, gap) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > -gap && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > -gap;
    const box = (el) => el.getBoundingClientRect();
    const tr = box(t);
    const out = [];
    const middle = [t.querySelector('.pot'), t.querySelector('.board')].filter(Boolean).map(box);
    const line = t.querySelector('.result-line, .bet-line');
    if (line?.textContent.trim()) { const r = document.createRange(); r.selectNodeContents(line); middle.push(r.getBoundingClientRect()); }
    const ms = t.querySelector('.minis.shown'); if (ms) out.push(`карты места: верх ${ms.getBoundingClientRect().top.toFixed(1)}, стол ${tr.top.toFixed(1)}`);
    for (const el of t.querySelectorAll('.seat')) for (const x of el.querySelectorAll('.pod, .minis, .info, .plate')) {
      const p = box(x); const nm = el.querySelector('.nm')?.textContent + ' ' + x.className;
      if (p.left < tr.left + 2 || p.right > tr.right - 2 || p.top < tr.top + 1 || p.bottom > tr.bottom - 1) out.push(`${nm}: край (${p.top.toFixed(0)} vs ${tr.top.toFixed(0)})`);
      middle.forEach((m, k) => hit(p, m, 4) && out.push(`${nm}: середина ${k}`));
    }
    return out.join('; ');
  }));
  if (process.env.SHOTS) await page.screenshot({ path: path.join(ROOT, 'preview', `probe-${GAME}-step${i}.png`) });
  if (m.bad.length) {
    report.push({ i, mode, bad: m.bad });
    await page.screenshot({ path: path.join(ROOT, 'preview', `probe-${GAME}-${i}.png`) }).catch(() => {});
    console.log(`шаг ${i} (помеха ${mode}):`, m.bad.join('; '));
  }
}
const sr = app.soloOf("101"); console.log(`раздача/партия #${sr?.hand?.no ?? sr?.deal?.no}, seq ${sr?.seq}`); console.log(`${GAME}: шагов ${STEPS}, плохих ${report.length}`, problems.length ? `ошибки страницы: ${problems.join(' | ')}` : '');
await browser.close();
await web.close();
app.stop?.();
process.exit(0);
