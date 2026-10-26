/**
 * Вид стола (косметика «Ночной казино-клуб», режим примерки) настоящими браузерами:
 * рубашка меняет картинки карт, сукно — фон, рамка видна на ВАШЕМ круге и не на чужих,
 * звание под ником, реакция набора — пузырём «примерка» только у вас, эффект победы
 * не перехватывает нажатия и выключается («Не показывать эффекты», prefers-reduced-motion),
 * «Снять всё» возвращает как было; примерочная; ничего не уходит на сервер и к другим.
 * 320 и 390 px.
 *
 *   node tools/e2e-look.mjs
 *   SHOTS=1 node tools/e2e-look.mjs   ещё и снимки в preview/look/
 *
 * Chromium с эмуляцией — не настоящий WebView Telegram.
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
import { assertNoJump } from './lib/scroll-probe.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8099);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const CHAT = -100979;
const SHOTS = process.env.SHOTS === '1';
const OUT = path.join(ROOT, 'preview', 'look');
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
const sdk = (u, code) => signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: code }, TOKEN);
/** Страница игрока; всё, что она отправила и получила по сокету, копится в page.sent / page.got. */
async function openPage(u, code, width = 360, height = 740, ctx = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, ...ctx });
  page.sent = [];
  page.got = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => page.sent.push(String(f.payload)));
    ws.on('framereceived', (f) => page.got.push(String(f.payload)));
  });
  page.on('pageerror', (e) => problems.push(`${u.first_name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource.*404/.test(m.text()) && /\/emoji\//.test(m.location()?.url || '')) return;
    problems.push(`${u.first_name}: ${m.text()}`);
  });
  const initData = sdk(u, code);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${PORT}/`);
  return page;
}
const lookCall = (page, fn, arg) => page.evaluate(async ([f, a]) => (await import('/cosmetics/look.js'))[f](a), [fn, arg]);
const applyCall = (page, fn, arg) => page.evaluate(async ([f, a]) => (await import('/cosmetics/apply.js'))[f](a), [fn, arg]);
const srcs = (page, sel) => page.locator(sel).evaluateAll((els) => els.map((e) => e.getAttribute('src')));
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(OUT, `${name}.png`) });
async function noSideways(page, what) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(sw <= iw, `${what}: страница шире экрана (${sw} > ${iw})`);
}
const box = (page, sel) => page.locator(sel).first().boundingBox();
const bg = (page, sel) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).backgroundColor);

for (const [w, hgt] of [[320, 568], [390, 844]]) {
  const chat = CHAT - w;
  await app.handleUpdate(cmdUpdate(chat, ivan, '/newgame', { message_id: w }));
  await app.settle();
  const room = app.room(chat);
  const pi = await openPage(ivan, room.code, w, hgt);
  const pm = await openPage(max, room.code, w, hgt);
  const pd = await openPage(dima, room.code, w, hgt);
  for (const p of [pm, pd]) {
    await p.waitForSelector('.lobby');
    await p.getByRole('button', { name: 'Сесть за стол' }).first().click();
  }
  await until(() => room.players.length === 3, 'трое за столом');
  await pi.getByRole('button', { name: '▶ Начать' }).click();
  await until(() => room.status === 'playing', 'раздача');
  for (const p of [pi, pm, pd]) await p.waitForSelector('.hero-cards img.card');

  const BACK = '/cards/back.svg';
  const backsOf = (p) => srcs(p, '.seat .minis:not(.shown) img.card');
  const feltBefore = await bg(pi, '.felt');
  assert.ok((await backsOf(pi)).length >= 2 && (await backsOf(pi)).every((s) => s === BACK), 'до примерки — стандартная рубашка');

  // ---- рубашка
  const sentBefore = pi.sent.length;
  await lookCall(pi, 'setLook', { cardback: 'nc-back-2' });
  await pi.waitForFunction(() => [...document.querySelectorAll('.seat .minis img.card')].every((e) => e.getAttribute('src').includes('placeholder/back-2.svg')));
  assert.ok((await srcs(pi, '.board img.card')).every((s) => /placeholder\/back-2|\/cards\//.test(s)), 'на борде — своя рубашка или лицо');
  assert.ok((await backsOf(pm)).every((s) => s === BACK), 'у соседа рубашка прежняя');
  step(`${w}px: рубашка «Рулетка» — карты на столе сменились только у Ивана`);

  // ---- сукно
  await lookCall(pi, 'setLook', { felt: 'nc-felt-1' });
  await pi.waitForFunction(() => getComputedStyle(document.querySelector('.felt')).backgroundColor === 'rgb(74, 15, 31)');
  assert.equal(await bg(pm, '.felt'), feltBefore, 'у соседа сукно прежнее');
  step(`${w}px: сукно «Бордовый бархат» — фон стола поменялся только у Ивана`);

  // ---- рамка и звание
  await lookCall(pi, 'setLook', { frame: 'nc-frame-1', title: 'nc-title-1' });
  await pi.waitForSelector('.hero .hero-av .cos-frame');
  assert.equal(await pi.locator('.seat .cos-frame').count(), 0, 'на чужих кругах рамки нет');
  for (const p of [pm, pd]) assert.equal(await p.locator('.cos-frame, .cos-title').count(), 0, 'у соседей ни рамки, ни звания');
  assert.equal((await pi.locator('.hero .cos-title').textContent()).trim(), 'Крупье');
  const avB = await box(pi, '.hero .hero-av');
  const frB = await box(pi, '.hero .hero-av .cos-frame');
  assert.ok(frB.width >= avB.width && frB.height >= avB.height, 'кольцо не меньше круга');
  await noSideways(pi, `${w}px стол с видом`);
  await shot(pi, `table-look-${w}`);
  step(`${w}px: рамка на вашем круге (${Math.round(avB.width)} px), «Крупье» под ником; у чужих — ничего`);

  // ---- реакция набора: только у вас
  await lookCall(pi, 'setLook', { reaction: 'nc-react-1' });
  await pi.locator('.chat-fab').click();
  await pi.waitForSelector('.chat-quick');
  await pi.locator('[data-chat-more]').click();
  await pi.locator('[data-chat-tab="night-club"]').click();
  await pi.locator('.chat-cell[data-rx="nc-react-1"]').click();
  await pi.waitForSelector('.rx-bubble[data-rx-try] .rx-try');
  assert.equal(await pi.locator('.rx-bubble[data-rx-try] .rx-try').textContent(), 'примерка');
  await pm.waitForTimeout(500);
  for (const p of [pm, pd]) assert.equal(await p.locator('.rx-bubble').count(), 0, 'пузыря у соседей нет');
  await shot(pi, `reaction-try-${w}`);
  step(`${w}px: реакция «Джекпот» — пузырь «примерка» только у Ивана`);
  await pi.locator('.chat-close').click();

  // ---- ничего не ушло на сервер и к другим
  const leaked = (p) => [...p.sent, ...p.got].filter((x) => /nc-|cosmetic|night-club/.test(x));
  assert.deepEqual(leaked(pi), [], 'Иван ничего про вид не отправлял');
  assert.deepEqual(leaked(pm).concat(leaked(pd)), [], 'соседи ничего про вид не получали');
  assert.equal(pi.sent.slice(sentBefore).filter((x) => /"t":"(react|chat)"/.test(x)).length, 0, 'ни реакций, ни чата на сервер не ушло');
  step(`${w}px: по сокету про вид — ни слова (ни от Ивана, ни к соседям)`);

  // ---- эффект: на странице того, чей ход (чтобы нажать Fold под дождём)
  const pages = [pi, pm, pd];
  let actor = null;
  for (const p of pages) if (await p.getByRole('button', { name: 'Fold' }).count()) actor = p;
  assert.ok(actor, 'у кого-то есть ход');
  await lookCall(actor, 'setLook', { effect: 'nc-fx-win' });
  assert.equal(await applyCall(actor, 'winFx', {}), true, 'эффект запустился');
  await actor.waitForFunction(() => document.querySelectorAll('#fx .cos-fx').length >= 8);
  const nParticles = await actor.locator('#fx .cos-fx').count();
  assert.ok(nParticles <= 22, `частиц не больше 22 (${nParticles})`);
  const fold = actor.getByRole('button', { name: 'Fold' });
  const under = await fold.evaluate((b) => {
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { ok: top === b || b.contains(top), fxEvents: getComputedStyle(document.getElementById('fx')).pointerEvents };
  });
  assert.equal(under.fxEvents, 'none', 'слой эффектов не ловит нажатия');
  assert.ok(under.ok, 'поверх кнопки Fold ничего нет');
  await actor.waitForTimeout(600);
  await shot(actor, `effect-${w}`);
  await fold.click();
  await actor.getByRole('button', { name: 'Fold' }).waitFor({ state: 'detached' });
  step(`${w}px: «Дождь из фишек» (${nParticles} частиц) идёт, а Fold под ним нажимается`);
  await actor.waitForFunction(() => !document.querySelector('#fx .cos-fx'), null, { timeout: 4000 });

  // ---- «Не показывать эффекты»
  await actor.evaluate(() => localStorage.setItem('fx-off', '1'));
  assert.equal(await applyCall(actor, 'winFx', {}), false, 'при «Не показывать эффекты» дождя нет');
  assert.equal(await actor.locator('#fx .cos-fx').count(), 0);
  await actor.evaluate(() => localStorage.removeItem('fx-off'));
  await actor.locator('.top .icon-btn').click();
  await actor.waitForSelector('[data-fx-toggle="on"]');
  await actor.locator('[data-fx-toggle="on"]').click();
  assert.equal(await actor.evaluate(() => localStorage.getItem('fx-off')), '1', 'пункт меню выключает эффекты');
  assert.equal(await applyCall(actor, 'winFx', {}), false);
  await actor.evaluate(() => localStorage.removeItem('fx-off'));
  step(`${w}px: «Не показывать эффекты» из меню стола выключает дождь`);

  // ---- «Снять всё»
  await lookCall(pi, 'clearLook');
  await pi.waitForFunction(() => ![...document.querySelectorAll('.seat .minis img.card')].some((e) => e.getAttribute('src') !== '/cards/back.svg'));
  await pi.waitForFunction(() => !document.querySelector('.hero .cos-frame, .hero .cos-title'));
  assert.equal(await bg(pi, '.felt'), feltBefore, 'сукно вернулось');
  step(`${w}px: «Снять всё» — рубашка, сукно, рамка и звание как были`);

  for (const p of pages) await noSideways(p, `${w}px`);

  // ---- примерочная (без сервера), поверх страницы зрителя
  const pz = await openPage(zoya, room.code, w, hgt);
  await pz.waitForSelector('#app *');
  await pz.evaluate(async () => {
    const box = document.createElement('div');
    box.id = 'fitroot';
    box.style.cssText = 'position:fixed;inset:0;overflow:auto;background:var(--bg-main);z-index:50';
    document.body.append(box);
    const { renderFitting } = await import('/cosmetics/fitting.js');
    renderFitting(box, { onBack: () => box.remove() });
  });
  await pz.waitForSelector('#fitroot .cos-fit .cf-stage');
  const sentZ = pz.sent.length;
  await lookCall(pz, 'setLook', { bundle: 'nc-bundle' });
  await pz.waitForSelector('#fitroot .cf-hero .cos-frame');
  assert.equal(await pz.locator('#fitroot .cf-seat .cos-frame').count(), 0, 'рамка только у вас');
  assert.ok((await srcs(pz, '#fitroot .cf-mini img.card')).every((s) => s.includes('placeholder/back-1.svg')), 'в примерочной своя рубашка');
  assert.equal((await pz.locator('#fitroot .cos-title').textContent()).trim(), 'Крупье');
  assert.equal(await pz.locator('#fitroot [data-fit-rx]').count(), 3, 'три реакции набора');
  await pz.locator('#fitroot [data-fit-rx="nc-react-2"]').click();
  await pz.waitForSelector('.rx-bubble[data-rx-try]');
  assert.equal(await bg(pz, '#fitroot .cf-felt'), 'rgb(74, 15, 31)', 'сукно бордо');
  await pz.locator('#fitroot [data-fit="fx"]').click();
  await pz.waitForFunction(() => document.querySelectorAll('#fx .cos-fx').length >= 8);
  await noSideways(pz, `${w}px примерочная`);
  assert.ok(await pz.locator('#fitroot').evaluate((e) => e.scrollWidth <= e.clientWidth + 1), 'примерочная не шире экрана');
  await shot(pz, `fitting-${w}`);
  // смена вида правит узлы на месте, прокрутка не прыгает (docs/scroll.md)
  await pz.setViewportSize({ width: w, height: 480 }); // ниже содержимого — чтобы было что прокручивать
  await assertNoJump(pz, { scroller: '#fitroot', label: `примерочная ${w}px` }, async () => {
    await lookCall(pz, 'setLook', { cardback: 'nc-back-2' });
    await pz.waitForSelector('#fitroot .cf-mini img.card[src*="back-2"]');
    await lookCall(pz, 'setLook', { cardback: 'nc-back-1' });
    await pz.waitForSelector('#fitroot .cf-mini img.card[src*="back-1"]');
  });
  await pz.locator('#fitroot [data-fit="clear"]').click();
  await pz.waitForSelector('#fitroot .cf-hero .cos-frame', { state: 'detached' });
  assert.deepEqual(pz.sent.slice(sentZ), [], 'примерочная ничего не отправила на сервер');
  await pz.locator('#fitroot [data-fit="back"]').click();
  assert.equal(await pz.locator('#fitroot').count(), 0, '«Назад» закрыл примерочную');
  step(`${w}px: примерочная — набор виден целиком, рамка только у вас, «Снять всё», «Назад», сервер молчит`);

  // ---- prefers-reduced-motion: дождя нет
  const pr = await openPage(zoya, room.code, w, hgt, { reducedMotion: 'reduce' });
  await pr.waitForSelector('#app *');
  await lookCall(pr, 'setLook', { effect: 'nc-fx-win' });
  assert.equal(await applyCall(pr, 'winFx', {}), false, 'при reduced-motion дождя нет');
  assert.equal(await pr.locator('#fx .cos-fx').count(), 0);
  step(`${w}px: при «уменьшить движение» эффект не запускается`);

  for (const p of [pi, pm, pd, pz, pr]) await p.close();
}

assert.deepEqual(problems, [], 'ошибок в консоли страниц нет');
await browser.close();
await web.close();
app.stop?.();
console.log('e2e вида стола: всё сошлось');
process.exit(0);
