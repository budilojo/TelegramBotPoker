/** Безопасный локальный ориентир I→L: только loopback, временная SQLite, TelegramStub.
 * node --expose-gc --disable-warning=ExperimentalWarning tools/perf-baseline.mjs
 * Три повтора, без параллельных тестов. Не измеряет ёмкость продакшена.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { chromium } from 'playwright';
import { Table, user, initDataFor } from '../bot/harness.js';
import { Store } from '../bot/store.js';
import { startServer } from '../bot/server.js';

const clock = { now: () => Date.now(), setTimeout, clearTimeout };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.ceil(s.length * .95) - 1)], max: s.at(-1) };
};
const heap = () => { global.gc?.(); return process.memoryUsage().heapUsed / 1048576; };
const runs = [];
for (let run = 1; run <= 3; run++) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check2-perf-'));
  const t0 = performance.now();
  const t = new Table({ clock, store: new Store(path.join(dir, 'test.db')) });
  const startupMs = performance.now() - t0;
  const rooms = [];
  const peers = [];
  let web, browser;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const cpu = process.cpuUsage();
  const start = performance.now();
  const before = heap();
  let messages = 0, bytes = 0;
  const connect = async (u, room) => {
    const began = performance.now();
    const ws = new WebSocket(`ws://127.0.0.1:${web.server.address().port}/ws`);
    const p = { ws, inbox: [], request: null, u, room };
    peers.push(p);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('hello timeout')), 5000);
      ws.on('error', reject);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', initData: initDataFor(u, { startParam: room.code, clock }) })));
      ws.on('message', (b) => {
        messages++; bytes += b.length;
        const m = JSON.parse(String(b));
        p.inbox.push(m);
        if (m.t === 'fatal' || m.t === 'error') { clearTimeout(timer); reject(new Error(m.text)); }
        if (m.t === 'state') {
          clearTimeout(timer); resolve();
          if (p.request) { const r = p.request; p.request = null; r(m); }
        }
      });
    });
    p.openMs = performance.now() - began;
    return p;
  };
  const request = (p, msg) => new Promise((resolve, reject) => {
    const began = performance.now();
    const timer = setTimeout(() => reject(new Error(`state timeout ${msg.t}`)), 5000);
    p.request = (m) => { clearTimeout(timer); resolve({ ms: performance.now() - began, m }); };
    p.ws.send(JSON.stringify(msg));
  });
  try {
    web = startServer({ hub: t.hub, port: 0, host: '127.0.0.1', root: path.resolve('miniapp'), log: () => {} });
    await new Promise((r) => web.server.once('listening', r));
    loop.enable();
    for (let i = 0; i < 10; i++) {
      const a = user(810000 + i * 2, 'Первый'), b = user(810001 + i * 2, 'Второй');
      const room = t.app.createGame('chess', { chatId: String(-810000 - i), title: 'Замер', host: { id: String(a.id), tgId: a.id, name: a.first_name }, settings: { base: 0 } });
      t.openRoom(a, room); t.openRoom(b, room);
      await t.send(b, { t: 'sit' }); await t.send(a, { t: 'start' });
      t.close(a); t.close(b);
      rooms.push({ room, a, b });
      await connect(a, room); await connect(b, room);
    }
    const open = stat(peers.map((p) => p.openMs));
    const underLoad = heap();
    const refresh = [];
    for (let k = 0; k < 20; k++) {
      const r = await Promise.all(peers.map((p) => request(p, { t: 'refresh' })));
      refresh.push(...r.map((x) => x.ms));
      await sleep(250); // четыре обновления/секунду на страницу
    }
    const action = [];
    for (const p of peers.filter((_, i) => i % 2 === 0)) {
      const r = await request(p, { t: 'move', from: 'e2', to: 'e4', ply: 0 });
      assert.equal(p.room.match.moves.length, 1);
      action.push(r.ms);
    }
    const reconnect = [];
    for (const p of [...peers].filter((_, i) => i % 2 === 0)) {
      p.ws.close();
      await new Promise((r) => p.ws.once('close', r));
      reconnect.push((await connect(p.u, p.room)).openMs);
    }
    // Холодный браузерный контекст каждого повтора, кэш отключён новым контекстом.
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 320, height: 568 } });
    const idata = initDataFor(rooms[0].a, { startParam: rooms[0].room.code, clock });
    await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.Telegram={WebApp:{initData:${JSON.stringify(idata)},initDataUnsafe:{},ready(){},expand(){},onEvent(){},BackButton:{show(){},hide(){},onClick(){}},HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}}}}` }));
    const browserStart = performance.now();
    await page.goto(`http://127.0.0.1:${web.server.address().port}/`);
    await page.waitForSelector('.ch-board');
    const firstBoardMs = performance.now() - browserStart;
    const resources = await page.evaluate(() => performance.getEntriesByType('resource').map((r) => ({ name: new URL(r.name).pathname, bytes: r.transferSize, ms: r.duration })));
    await browser.close(); browser = null;
    for (const p of peers) p.ws.terminate();
    await sleep(100);
    assert.equal(t.hub.sessions, 0);
    const dbSave = [];
    for (let k = 0; k < 100; k++) {
      const now = performance.now(); t.app.save(rooms[k % 10].room); dbSave.push(performance.now() - now);
    }
    const used = process.cpuUsage(cpu);
    runs.push({ run, startupMs, wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000, heapMB: { before, underLoad, afterClose: heap() }, rssMB: process.memoryUsage().rss / 1048576, wsOpenMs: open, refreshMs: stat(refresh), actionToStateMs: stat(action), reconnectMs: stat(reconnect), dbSaveMs: stat(dbSave), eventLoopMs: { median: loop.percentile(50) / 1e6, p95: loop.percentile(95) / 1e6, max: loop.max / 1e6 }, messages, bytes, sessionsAfterClose: t.hub.sessions, firstBoardMs, resources });
    assert.deepEqual(t.errors, []);
  } finally {
    loop.disable();
    await browser?.close();
    for (const p of peers) p.ws.terminate();
    await web?.close(); t.app.stop(); t.app.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version, os: `${os.platform()} ${os.release()} ${os.arch()}`, cpus: os.cpus().length, workload: '10 шахматных столов, 20 WS, 400 refresh/run за 5с, 10 ходов, 10 reconnect, 100 SQLite save, браузер 320×568; 3 повтора', limitations: 'Нет ботов и долгого прогона; CPU/RSS только Node, loopback и прогретые файлы ОС; firstBoard без загрузки Chromium, Telegram SDK заглушён; L дополнит профили ботов и длительности.', runs }, null, 2));
