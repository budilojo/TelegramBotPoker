/** D: storefront to fitting/equip/clear/table. All HTTP/WS local, all Telegram/payment APIs stubbed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { Table, user, initDataFor, TEST_TOKEN } from '../bot/harness.js';
import { GAME_LIST } from '../bot/games/index.js';
import { startServer } from '../bot/server.js';
import { itemById } from '../miniapp/collections/catalog.js';
const H = user(700201001, 'Владелец'), B = user(700201002, 'Друг'), S = user(700201003, 'Зритель');
const t = new Table({ admins: [String(H.id)], nardyDice: () => [5, 3], battleshipFleetRand: () => .37 });
const web = startServer({ hub: t.hub, port: 0, host: '127.0.0.1', root: path.resolve('miniapp'), log: () => {} });
await new Promise(r => web.server.once('listening', r));
const url = `http://127.0.0.1:${web.server.address().port}`, browser = await chromium.launch();
const out = path.resolve('docs/cosmetics-v2/reports/shop-screens'); fs.mkdirSync(out, { recursive: true });
const problems = [];
const teeth = process.env.SHOP_TEETH === '1';
const sdk = data => `window.Telegram={WebApp:{initData:${JSON.stringify(data)},initDataUnsafe:{start_param:new URLSearchParams(${JSON.stringify(data)}).get('start_param')},ready(){},expand(){},close(){},disableVerticalSwipes(){},setHeaderColor(){},setBackgroundColor(){},setBottomBarColor(){},onEvent(){},openTelegramLink(){},BackButton:{show(){},hide(){},onClick(f){window.__back=f}},HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}}}};
window.__sent=[];window.__heldCol=[];const WS=window.WebSocket;window.WebSocket=class extends WS{constructor(...a){super(...a);window.__ws=this}send(m){window.__sent.push(JSON.parse(m));super.send(m)}set onmessage(f){super.onmessage=e=>{if(window.__holdCol&&JSON.parse(e.data).t==='col')window.__heldCol.push(()=>f(e));else f(e)}}};`;
async function open(who, code, width, reduced = false, holdCol = false) {
  const context = await browser.newContext({ viewport: { width, height: width === 320 ? 568 : 844 }, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  if (holdCol) await page.addInitScript(() => window.__holdCol = true);
  const frames = []; page.on('pageerror', e => problems.push(e.message));
  page.on('websocket', ws => ws.on('framereceived', ({ payload }) => frames.push(JSON.parse(String(payload)))));
  await page.route('https://telegram.org/**', r => r.fulfill({ contentType: 'text/javascript', body: sdk(initDataFor(who, { startParam: code, clock: t.clock, token: TEST_TOKEN })) }));
  await page.goto(url); await page.waitForSelector('.lobby,.game-card');
  return { page, context, frames };
}
async function until(f, label) { const end = Date.now() + 7000; while (!await f()) { if (Date.now() > end) throw Error(label); await new Promise(r => setTimeout(r, 25)); } }
const send = (p, m) => p.evaluate(async m => (await import('/net.js')).send(m, { lock: false }), m);
const back = p => p.evaluate(() => window.__back());
const shot = async (p, name) => { if (teeth) return; if (name.includes('-return-')) await p.waitForFunction(() => !document.querySelector('#toast.show')); await p.waitForTimeout(100); await p.screenshot({ path: path.join(out, `${name}.png`) }); };
async function layout(p, label) {
  const r = await p.evaluate(() => {
    const root = document.querySelector('.col-root');
    return { wide: root.scrollWidth > innerWidth || [...root.querySelectorAll('*')].some(e => e.getBoundingClientRect().right > innerWidth + 1),
      small: [...root.querySelectorAll('button,select')].filter(e => e.getClientRects().length && (e.getBoundingClientRect().height < 44 || e.getBoundingClientRect().width < 44)).map(e => e.textContent.slice(0, 40)),
      unnamed: [...root.querySelectorAll('button,select')].filter(e => !e.getAttribute('aria-label') && !e.textContent.trim()).map(e => e.outerHTML) };
  });
  assert.equal(r.wide, false, `${label}: horizontal overflow`); assert.deepEqual(r.small, [], `${label}: targets >=44`); assert.deepEqual(r.unnamed, [], `${label}: names`);
  const offScale = await p.evaluate(() => [...document.querySelectorAll('.col-root *')].flatMap(e => {
    const cs = getComputedStyle(e); if (!e.getClientRects().length) return [];
    const out = [];
    if ([...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && ![12,14,16,20,24,32].includes(parseFloat(cs.fontSize))) out.push(`font ${e.className}: ${cs.fontSize}`);
    for (const key of ['borderTopLeftRadius','borderBottomRightRadius']) if (!cs[key].includes('%') && ![0,6,8,12,20,999].includes(parseFloat(cs[key]))) out.push(`radius ${e.className}: ${cs[key]}`);
    if (cs.backgroundImage.includes('gradient') || cs.boxShadow !== 'none') out.push(`effect ${e.className}`);
    return out;
  }));
  assert.deepEqual(offScale, [], `${label}: design tokens, flat UI`);
}
async function select(p, key, val) { await p.locator(`[data-filter="${key}"]`).selectOption(val); }
async function tab(p, name) { await p.locator('.col-controls').getByRole('button', { name, exact: true }).click(); }
async function card(p, id) { await p.locator(`.col-card[data-item="${id}"]`).click(); await p.waitForSelector('.col-item'); }
try {
 console.log('Chromium', browser.version());
 for (const width of teeth ? [320] : [320, 390]) {
  t.chatId = -94000 - width; await t.cmd(H, '/game'); const code = `g_${t.group.code}`;
  const host = await open(H, code, width, width === 320), guest = await open(B, code, width);
  const p = host.page, b = guest.page;
  try {
   await p.locator('.nav-tab[data-tab="shop"]').click(); await p.waitForSelector('.col-show');
   assert.equal(await p.locator('.col-card').count(), 64); assert.equal(await p.locator('.col-root .nav-tab').count(), 4);
   assert.equal(await p.locator('.nav-tab[data-tab="shop"]').getAttribute('aria-current'), 'page');
   assert.match(await p.locator('.col-show').innerText(), /Доступ владельца/);
   assert.equal(await p.locator('[data-result-count]').count(), 1, 'catalog count uses its own attribute');
   assert.equal(await p.locator('[data-result-count]').innerText(), 'Найдено: 64', 'catalog count is not a clock');
   await layout(p, 'catalog'); await shot(p, `catalog-${width}`);
   // Native filters support keyboard; category options are populated, no empty sections.
   await select(p, 'game', 'chess'); await select(p, 'category', 'boards'); await select(p, 'collection', 'sever');
   assert.equal(await p.locator('.col-card').count(), 1);
   await p.locator('[data-filter="collection"]').focus(); await p.keyboard.press('Tab');
   assert.ok(await p.evaluate(() => document.activeElement.tagName === 'BUTTON'));
   await card(p, 'sever-chess-board'); await layout(p, 'item'); await shot(p, `item-${width}`);
   await p.getByRole('button', { name: 'Примерить', exact: true }).click(); await p.waitForSelector('[data-sample="chess"]');
   assert.equal(await p.locator('.col-sample-grid img').count(), 32); await layout(p, 'fitting'); await shot(p, `fitting-${width}`);
   await back(p); await p.waitForSelector('.col-item'); await back(p); await p.waitForSelector('.col-show');
   assert.equal(await p.locator('[data-filter="collection"]').inputValue(), 'sever');
   assert.equal(await p.locator('[data-filter="game"]').inputValue(), 'chess');
   assert.equal(await p.evaluate(() => document.activeElement.dataset.item), 'sever-chess-board');
   await select(p, 'game', ''); await select(p, 'collection', ''); await select(p, 'category', '');
   await p.locator('.col-scroll').evaluate(e => e.scrollTop = 1100);
   const chosen = p.locator('.col-card[data-item="obsidian-frame"]'); await chosen.scrollIntoViewIfNeeded();
   const scroll = await p.locator('.col-scroll').evaluate(e => e.scrollTop); await chosen.click(); await back(p);
   assert.equal(await p.locator('.col-scroll').evaluate(e => e.scrollTop), scroll, 'scroll preserved');
   // Await real server ack; inject transport delay only, then send identical packet over actual WS.
   await card(p, 'sever-frame');
   await p.evaluate(async () => { const { store } = await import('/collections/state.js'); store.attach({ send: m => { window.__held = m; return true; } }); });
   const prior = structuredClone(t.app.collections.choiceOf(H.id));
   await p.getByRole('button', { name: 'Надеть', exact: true }).click();
   assert.match(await p.locator('.col-item').innerText(), /Ждём ответ сервера/); assert.deepEqual(t.app.collections.choiceOf(H.id), prior);
   assert.equal(await p.getByRole('button', { name: 'Надето', exact: true }).count(), 0, 'no optimistic success');
   await p.evaluate(async () => { const net = await import('/net.js'), { store } = await import('/collections/state.js'); store.attach({ send: m => net.send(m, { lock: false }) }); net.send(window.__held, { lock: false }); });
   await p.getByRole('button', { name: 'Надето', exact: true }).waitFor();
   assert.equal(t.app.collections.choiceOf(H.id).frame.item, 'sever-frame');
   await p.getByRole('button', { name: 'Снять', exact: true }).click(); await p.getByRole('button', { name: 'Надеть', exact: true }).waitFor();
   assert.notEqual(t.app.collections.choiceOf(H.id).frame?.item, 'sever-frame');
   // Refusal from actual server: UI has stale owned, verified owner config no longer grants it.
   t.app.admins.delete(String(H.id));
   await p.getByRole('button', { name: 'Надеть', exact: true }).click();
   await p.waitForSelector('.col-alert'); assert.match(await p.locator('.col-alert').innerText(), /коллекц|принадлеж|получ|предмет/i);
   assert.equal(await p.getByRole('button', { name: 'Надето', exact: true }).count(), 0);
   t.app.admins.add(String(H.id)); t.app.collections.pushState(H.id);
   await p.locator('[data-act="dismiss"]').click();
   // Real reconnect while overlay is open preserves route and authoritative inventory.
   await p.evaluate(() => window.__ws.close()); await until(() => p.locator('.col-root').getAttribute('data-link').then(x => x === 'offline'), 'offline');
   assert.equal(await p.getByRole('button', { name: 'Надеть', exact: true }).isDisabled(), true);
   await until(() => p.locator('.col-root').getAttribute('data-link').then(x => x === 'ok'), 'reconnect');
   await p.getByRole('button', { name: 'Надеть', exact: true }).click(); await p.getByRole('button', { name: 'Надето', exact: true }).waitFor();
   await back(p); await tab(p, 'Мои вещи'); await select(p, 'game', 'chess');
   assert.match(await p.locator('.col-inventory').innerText(), /Надето сейчас/); assert.match(await p.locator('.col-inventory').innerText(), /Доступ владельца/);
   await layout(p, 'inventory'); await shot(p, `inventory-${width}`);
   await p.locator('.nav-tab[data-tab="rating"]').click(); await p.waitForSelector('.ranked'); assert.match(await p.locator('.ranked').innerText(), /скоро/i);
   await p.locator('.nav-tab[data-tab="shop"]').click(); await tab(p, 'Каталог');
   // Bundle action is atomic and preserves Graphit data; server validates all nine rights.
   await select(p, 'game', ''); await select(p, 'category', 'bundles'); await select(p, 'collection', 'orbita');
   await card(p, 'orbita-bundle'); await p.getByRole('button', { name: 'Надеть комплект', exact: true }).click();
   await until(() => itemById('orbita-bundle').includes.every(id => t.app.collections.choiceOf(H.id)[itemById(id).slot]?.item === id), 'bundle');
   assert.equal(await p.locator('.col-list li').count(), 9);
   await back(p); await back(p);
   // Ordinary visitor: public preview off, neither equip nor buy, empty inventory.
   await b.locator('.nav-tab[data-tab="shop"]').click(); await b.waitForSelector('.col-show'); await card(b, 'sever-frame');
   assert.equal(await b.getByRole('button', { name: 'Надеть', exact: true }).count(), 0); assert.equal(await b.locator('[data-act="buy"]').count(), 0);
   assert.match(await b.locator('.col-item').innerText(), /Цена не утверждена/);
   const before = t.app.store.collChoices(B.id), sent = await b.evaluate(() => window.__sent.length);
   await b.getByRole('button', { name: 'Примерить', exact: true }).click(); await b.waitForSelector('.col-sample-profile');
   await b.getByRole('combobox', { name: 'Игра для примерки' }).selectOption('nardy');
   assert.deepEqual(await b.evaluate(n => window.__sent.slice(n), sent), [], 'fitting sends nothing');
   assert.deepEqual(t.app.store.collChoices(B.id), before); assert.deepEqual(t.app.collections.ownedItems(B.id), []);
   await back(b); await back(b); await tab(b, 'Мои вещи'); assert.match(await b.locator('.col-inventory').innerText(), /Пока у вас только базовое/);
   await shot(b, `empty-${width}`); await layout(b, 'empty');
   // Legacy/programmatic item entry still opens new store; broken image remembers fallback across redraw.
   await b.evaluate(async () => (await import('/collections/index.js')).close());
   let failedRequests = 0;
   b.on('request', r => { if (r.url().endsWith('/sever-chess-board-preview.svg')) failedRequests++; });
   await b.route('**/sever-chess-board-preview.svg', r => r.fulfill({ status: 404, body: '' }));
   await b.evaluate(async () => (await import('/collections/index.js')).open({ name: 'fit', id: 'sever-chess-board' }));
   await b.waitForSelector('[data-art="sever-chess-board"].fallback'); assert.equal(await b.locator('.col-sample .col-art-base').isVisible(), false, 'failed ornament leaves classic board without extra marks'); await layout(b, 'fallback'); await shot(b, `fallback-${width}`);
   await b.getByRole('combobox', { name: 'Игра для примерки' }).selectOption('chess');
   await b.waitForTimeout(100);
   assert.equal(failedRequests, 1, 'failed SVG never retries on redraw');
   assert.equal(await b.locator('[data-art="sever-chess-board"] img').count(), 0);
   await b.evaluate(async () => (await import('/collections/index.js')).close());
   await b.evaluate(async () => (await import('/collections/index.js')).open({ name: 'item', id: 'unknown-id' })); assert.match(await b.locator('.col-empty').innerText(), /Такого предмета нет/);
   if (!teeth) {
    await b.goto(`${url}/?collections=1&demo=1&admin=1&owned=sever-frame#collections/item/sever-frame`); await b.waitForSelector('.col-item');
    assert.equal(await b.getByRole('button', { name: 'Надеть', exact: true }).count(), 0, 'URL parameters never grant rights');
    assert.equal(await b.evaluate(async () => (await import('/collections/state.js')).store.own('sever-frame')), false);
    await b.goto(`${url}/#collections/item/graphit-table`); await b.waitForSelector('.col-item');
    assert.match(await b.locator('.col-item').innerText(), /Стол «Графит»/); assert.equal(await b.locator('[data-act="buy"]').count(), 0);
    await b.evaluate(async () => (await import('/collections/index.js')).close());
    await b.evaluate(async () => { const cat = await import('/collections/catalog.js'); cat.itemById('sever-frame').title = 'Очень длинное название рамки профиля для проверки переноса текста и доступного имени'; (await import('/collections/index.js')).open({ name: 'item', id: 'sever-frame' }); });
    await layout(b, 'long title'); await shot(b, `long-${width}`);
    const loading = await open(B, code, width, true, true);
    try {
     await loading.page.locator('.nav-tab[data-tab="shop"]').click(); await loading.page.waitForSelector('.col-skel');
     assert.equal(await loading.page.locator('.col-card').count(), 0); await shot(loading.page, `loading-${width}`);
     await loading.page.evaluate(() => { window.__holdCol = false; window.__heldCol.splice(0).forEach(f => f()); });
     await loading.page.waitForSelector('.col-show'); assert.equal(await loading.page.locator('.col-card').count(), 64);
    } finally { await loading.context.close(); }
   }
   console.log(`store ${width}: catalog/filters/scroll/focus, ack/clear/refusal/reconnect, bundle, off/owner, fallback OK`);
  } finally { await host.context.close(); await guest.context.close(); }
 }
 // Seven games: menu -> store -> personal and shared equip -> return, then pending and frozen room.
 let n = 0;
 for (const width of teeth ? [] : [320, 390]) for (const g of GAME_LIST) {
  t.chatId = -95000 - ++n; await t.cmd(H, '/game'); t.openHub(H); await t.send(H, { t: 'create', game: g.id, settings: {} });
  const room = t.app.roomByCode(t.page(H).session.code); t.openRoom(B, room); await t.send(B, { t: 'sit' });
  // New room starts with clean shared slots, retaining rights.
  t.app.collections.limits.clear(); for (const slot of Object.keys(t.app.collections.choiceOf(H.id))) t.app.store.collChoiceClear(H.id, slot); await t.app.settle();
  const host = await open(H, room.code, width), other = await open(B, room.code, width), spy = await open(S, room.code, width), p = host.page;
  try {
   await send(p, { t: 'start' }); await until(() => room.status === 'playing', 'playing');
   if (g.id === 'battleship') for (const x of [p, other.page]) { await send(x, { t: 'random' }); await x.waitForTimeout(50); await send(x, { t: 'ready' }); }
   const turn = structuredClone(room.turn), look = structuredClone(room.look), count = room.players.length;
   await p.getByRole('button', { name: 'Меню', exact: true }).click(); await p.locator('[data-act="shop"]').click(); await p.waitForSelector('.col-show');
   await p.locator('[data-filter="game"]').selectOption(g.id); await select(p, 'collection', 'sever'); await select(p, 'category', 'profile');
   t.app.collections.limits.clear(); await card(p, 'sever-frame'); await p.getByRole('button', { name: 'Надеть', exact: true }).click(); await p.getByRole('button', { name: 'Надето', exact: true }).waitFor();
   assert.match(await p.locator('.col-item').innerText(), /Применится со следующей партии/); await back(p);
   const slot = ['poker', 'durak'].includes(g.id) ? 'table' : g.id === 'colors' ? 'unoq-cardback' : g.id === 'battleship' ? 'battleship-panel' : `${g.id}-board`;
   await select(p, 'category', ['poker', 'durak'].includes(g.id) ? 'tables' : g.id === 'colors' ? 'cards' : 'boards');
   await card(p, `sever-${slot}`); await p.getByRole('button', { name: 'Примерить', exact: true }).click();
   await p.waitForSelector('.col-fit'); await layout(p, `${g.id} fit`); await shot(p, `${g.id}-fit-${width}`); await back(p);
   await p.getByRole('button', { name: 'Надеть', exact: true }).click(); await p.getByRole('button', { name: 'Надето', exact: true }).waitFor();
   assert.deepEqual(room.turn, turn); assert.deepEqual(room.look, look); assert.equal(room.players.length, count);
   assert.equal(await p.locator('[data-act="return-table"]').count(), 1);
   await p.locator('[data-act="return-table"]').click(); assert.equal(await p.locator('.col-root').count(), 0);
   assert.equal(await p.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Меню', 'return restores focus to game menu');
   assert.deepEqual(room.turn, turn); assert.deepEqual(room.look, look);
   await shot(p, `${g.id}-return-${width}`);
   // All received packets: no decoration/private data leaked to other viewer.
   for (const x of [other, spy]) for (const m of x.frames.filter(m => m.t === 'state')) {
    assert.doesNotMatch(JSON.stringify(m), /"(?:owned|sources|telegram_payment_charge_id|holes|fleets|initData)"/);
   }
   console.log(`${g.id} ${width}: menu/fitting/personal/shared/pending/return keeps seats+clocks+snapshot`);
  } finally { for (const x of [host, other, spy]) await x.context.close(); await t.app.dropGame(room); }
 }
 assert.deepEqual(problems, []); assert.deepEqual(t.errors, []);
 console.log('D shop e2e OK', out);
} finally { t.app.stop(); await browser.close(); await web.close(); }
