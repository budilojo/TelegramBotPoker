/** Старый локальный вид не перекрывает серверное оформление. Chromium/TelegramStub, не телефон. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { startServer } from '../bot/server.js';
import { TelegramStub, cmdUpdate, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.E2E_PORT || 8099);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const OUT = path.join(ROOT, 'preview/cosmetics-v2-a');
fs.mkdirSync(OUT, { recursive: true });
const api = new TelegramStub();
const app = new App({ api, collectionsDemo: true, minIntervalMs: 0, runoutStepMs: 0 });
const hub = new Hub(app, { botToken: TOKEN }); app.attachHub(hub);
const web = startServer({ hub, port: PORT, host: '127.0.0.1', root: path.join(ROOT, 'miniapp'), log() {} });
await new Promise((r) => web.server.once('listening', r));
const browser = await chromium.launch();
const errors = [];
const legacy = { cardback: 'nc-back-2', felt: null, frame: 'nc-frame-2', title: 'nc-title-1', effect: null, reactions: [] };
const allLegacy = { cardback: 'nc-back-2', felt: 'nc-felt-1', frame: 'nc-frame-2', title: 'nc-title-1', effect: 'nc-fx-win', reactions: ['nc-react-1'] };
const wait = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 30)); } assert.fail('состояние не пришло'); };
async function open(u, code, width, saved = null) {
  const p = await browser.newPage({ viewport: { width, height: width === 320 ? 568 : 844 } });
  p.sent = []; p.got = [];
  p.on('websocket', (ws) => { ws.on('framesent', (f) => p.sent.push(String(f.payload))); ws.on('framereceived', (f) => p.got.push(String(f.payload))); });
  p.on('pageerror', (e) => errors.push(e.message));
  const data = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: u, start_param: code }, TOKEN);
  await p.addInitScript((raw) => { if (raw && !localStorage.getItem('cosmetics-look')) localStorage.setItem('cosmetics-look', JSON.stringify(raw)); }, saved);
  await p.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.Telegram={WebApp:{initData:${JSON.stringify(data)},initDataUnsafe:{start_param:${JSON.stringify(code)}},ready(){},expand(){},disableVerticalSwipes(){},onEvent(){},setHeaderColor(){},setBackgroundColor(){},setBottomBarColor(){},BackButton:{show(){},hide(){},onClick(){}},HapticFeedback:{impactOccurred(){},selectionChanged(){},notificationOccurred(){}}}};` }));
  await p.goto(`http://127.0.0.1:${PORT}/`);
  return p;
}
const send = (p, msg) => p.evaluate(async (m) => (await import('/net.js')).send(m, { lock: false }), msg);
const setLocal = (p, value) => p.evaluate(async (v) => { (await import('/cosmetics/look.js')).setLook(v); (await import('/net.js')).send({ t: 'refresh' }, { lock: false }); }, value);
const noLegacy = async (p) => {
  assert.equal(await p.locator('.cos-frame, .cos-title, .cos-back, .cos-fx').count(), 0, 'архивные украшения не рисуются в живой партии');
  assert.equal(await p.locator('img[src*="/cosmetics/"]').count(), 0, 'архивные SVG не загружаются в партию');
};
try {
  for (const width of [320, 390]) {
    const alice = user(101 + width, 'Алиса'); const bob = user(202 + width, 'Боб'); const watcher = user(303 + width, 'Зритель');
    await app.handleUpdate(cmdUpdate(-100979 - width, alice, '/newgame'));
    await app.settle();
    const room = app.room(-100979 - width);
    const a = await open(alice, room.code, width, legacy);
    const b = await open(bob, room.code, width);
    const w = await open(watcher, room.code, width);
    await b.getByRole('button', { name: 'Сесть за стол', exact: true }).click();
    await wait(() => room.players.length === 2);
    await a.getByRole('button', { name: '▶ Начать' }).click();
    for (const p of [a, b, w]) await p.waitForSelector('.felt');
    await a.waitForSelector('.hero-cards img');
    await a.waitForTimeout(1500); // закончить исходную анимацию перед снимком
    await a.screenshot({ path: path.join(OUT, `${process.env.SHOT_PREFIX || 'after'}-${width}.png`) });
    // До исправления: этот assert воспроизводит кольцо/КРУПЬЕ с IMG_4367.
    await noLegacy(a);
    const felt = await a.locator('.felt').evaluate((e) => getComputedStyle(e).backgroundColor);
    const faces = await a.locator('.hero-cards img').evaluateAll((xs) => xs.map((x) => x.getAttribute('src')));
    assert.ok(faces.every((s) => /\/cards\/(?!back)/.test(s)), 'свои лица карт прежние');
    assert.deepEqual(await a.locator('.seat .minis img').evaluateAll((xs) => xs.map((x) => x.getAttribute('src'))), ['/cards/back.svg', '/cards/back.svg'], 'нынешняя базовая рубашка сохранена');
    await setLocal(a, allLegacy);
    await a.waitForTimeout(150);
    // Даже оставшиеся CSS-переменные от старого пути не перекрашивают живое сукно.
    await a.evaluate(() => { document.documentElement.dataset.cosFelt = 'nc-felt-1'; document.documentElement.style.setProperty('--cos-felt', '#4a0f1f'); });
    await noLegacy(a);
    assert.equal(await a.locator('.felt').evaluate((e) => getComputedStyle(e).backgroundColor), felt);
    assert.equal(await a.evaluate(async () => (await import('/ui.js')).backImg().getAttribute('src')), '/cards/back.svg');
    assert.equal(await a.evaluate(async () => (await import('/reactions.js')).reactionSets('poker').some((s) => s.id === 'night-club')), false);
    const saved = await a.evaluate(() => localStorage.getItem('cosmetics-look'));
    await a.reload(); await a.waitForSelector('.felt'); await noLegacy(a);
    assert.equal(await a.evaluate(() => localStorage.getItem('cosmetics-look')), saved, 'архивный выбор не стирается');
    for (const p of [a, b, w]) {
      await noLegacy(p);
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(![...p.sent, ...p.got].some((s) => /nc-|cosmetics-look/.test(s)), 'архив не уходит в сеть');
    }
    // Сосуществование: Графит от сервера, локальная «примерка» не перекрывает его.
    const uid = String(alice.id);
    app.store.collDemoGrant(uid, 'graphit-table', Date.now());
    app.store.collChoiceSet(uid, 'table', 'graphit-table', 'petrol', Date.now());
    await a.getByRole('button', { name: 'Fold', exact: true }).count().then(async (n) => {
      if (n) await a.getByRole('button', { name: 'Fold', exact: true }).click();
      else await b.getByRole('button', { name: 'Fold', exact: true }).click();
    });
    await wait(() => room.hand?.phase === 'complete');
    await send(a, { t: 'next' });
    for (const p of [a, b, w]) await p.waitForSelector('[data-gr-table="petrol"]');
    await setLocal(a, allLegacy); await a.waitForTimeout(150);
    await noLegacy(a);
    assert.equal(await a.locator('[data-gr-table="petrol"]').count(), 1);
    await a.waitForTimeout(1500);
    await a.screenshot({ path: path.join(OUT, `graphit-${width}.png`) });
    // Недоступная с UI архивная примерочная остаётся изолированным образцом.
    await a.evaluate(async () => {
      const box = document.createElement('div'); box.id = 'archive-fit'; document.body.append(box);
      (await import('/cosmetics/fitting.js')).renderFitting(box);
    });
    await a.waitForSelector('#archive-fit .cos-frame');
    assert.equal(await a.locator('#archive-fit .cos-title').innerText(), 'КРУПЬЕ');
    assert.equal(await a.locator('.hero .cos-frame, .hero .cos-title').count(), 0);
    await a.evaluate(() => document.getElementById('archive-fit').remove());
    for (const p of [a, b, w]) await p.close();
    console.log(`OK ${width}: старый выбор сохранён, живой вид классический/Графит, два игрока + зритель, reload и локальная примерка`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close(); await web.close(); app.stop(); app.store.close();
}
