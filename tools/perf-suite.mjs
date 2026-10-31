/** L: повторяемые локальные измерения, без .env и сетевого Telegram.
 * node --expose-gc --disable-warning=ExperimentalWarning tools/perf-suite.mjs
 * --runs=3 --seconds=120; stdout JSON, ход выполнения только stderr.
 * Запускать отдельно от тестов. Время не является условием pass/fail.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import WebSocket from 'ws';
import { chromium } from 'playwright';
import { Table, user, initDataFor, botRandom, colorsDecks } from '../bot/harness.js';
import { Store } from '../bot/store.js';
import { GAME_LIST } from '../bot/games/index.js';
import { startServer } from '../bot/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = { runs: 3, seconds: 120 };
for (const arg of process.argv.slice(2)) {
  const m = /^--(runs|seconds)=(\d+)$/.exec(arg);
  assert.ok(m, `Неизвестный параметр: ${arg}`);
  options[m[1]] = Number(m[2]);
}
assert.ok(options.runs >= 1 && options.runs <= 10 && options.seconds >= 5 && options.seconds <= 600);
const clock = { now: () => Date.now(), setTimeout, clearTimeout };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = (xs) => {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], p95: s[Math.ceil(s.length * .95) - 1], max: s.at(-1) };
};
const memory = () => { global.gc?.(); const m = process.memoryUsage(); return { heapMB: m.heapUsed / 1048576, rssMB: m.rss / 1048576 }; };
const identity = (u) => ({ id: String(u.id), tgId: u.id, name: u.first_name, dm: 'ok' });
const versioned = (view, msg) => ({ seq: view.seq, ...(view.match ? { matchNo: view.match.no } : {}), ...msg });

// Только тестовая база. Считаем исполнения подготовленных выражений, включая
// подготовленные позже модулями. Значения параметров и строки SQL не выводим.
function instrumentDB(store) {
  const counts = {}, times = [], prepareTimes = [];
  const wrap = (stmt, key) => new Proxy(stmt, { get(target, prop) {
    const f = Reflect.get(target, prop, target);
    if (typeof f !== 'function') return f;
    if (!['get', 'all', 'run'].includes(prop)) return f.bind(target);
    return (...args) => {
      const start = performance.now();
      try { return f.apply(target, args); }
      finally { counts[`${key}.${prop}`] = (counts[`${key}.${prop}`] || 0) + 1; times.push(performance.now() - start); }
    };
  } });
  for (const [prefix, owner] of [['store', store], ['pay', store.pay], ['support', store.support]]) {
    for (const key of Object.keys(owner.q || {})) owner.q[key] = wrap(owner.q[key], `${prefix}.${key}`);
  }
  const prepare = store.db.prepare.bind(store.db);
  let prepared = 0;
  store.db.prepare = (...args) => {
    const start = performance.now();
    const stmt = prepare(...args);
    prepareTimes.push(performance.now() - start); prepared++;
    return wrap(stmt, 'dynamic');
  };
  return () => ({ executions: times.length, executionMs: stats(times), counts: { ...counts }, preparedAfterStore: prepared, prepareMs: stats(prepareTimes) });
}

async function environment(run, phase) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-L-'));
  const store = new Store(path.join(dir, 'test.db'));
  const dbStats = instrumentDB(store);
  const t = new Table({ clock, store, botRng: botRandom(700 + run), battleshipFleetRand: botRandom(900 + run), colorsDeck: colorsDecks(1000 + run), colorsRand: botRandom(1100 + run), nardyDice: () => [5, 3] });
  const web = startServer({ hub: t.hub, host: '127.0.0.1', port: 0, root: path.join(root, 'miniapp'), log: (...xs) => { t.errors.push(xs.join(' ')); console.error(...xs); } });
  await new Promise((resolve, reject) => { web.server.once('listening', resolve); web.server.once('error', reject); });
  const url = `http://127.0.0.1:${web.server.address().port}`;
  const all = new Set();
  let messages = 0, bytes = 0;
  async function connect(u, room) {
    const start = performance.now();
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws');
    const p = { ws, u, room, state: null, waiter: null };
    all.add(p);
    ws.on('message', (data) => {
      messages++; bytes += data.length;
      const msg = JSON.parse(String(data));
      if (['error', 'fatal'].includes(msg.t)) {
        t.errors.push(`${phase}: ${msg.code}: ${msg.text}`);
        p.waiter?.reject(new Error(`${msg.code}: ${msg.text}`));
      }
      if (msg.t === 'state') { p.state = msg.state; p.waiter?.receive(msg.state); }
    });
    const ready = waitState(p, () => true);
    ws.on('error', (e) => { t.errors.push(e.message); p.waiter?.reject(e); });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', initData: initDataFor(u, { startParam: room.code, clock }) })));
    await ready;
    p.openMs = performance.now() - start;
    return p;
  }
  function waitState(p, predicate) {
    assert.equal(p.waiter, null, 'один ожидаемый ответ на страницу');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('state timeout')), 5000);
      const finish = (err, state) => { clearTimeout(timer); p.waiter = null; err ? reject(err) : resolve(state); };
      p.waiter = { reject: (e) => finish(e), receive: (s) => { if (predicate(s)) finish(null, s); } };
    });
  }
  async function request(p, msg, predicate = () => true) {
    const ready = waitState(p, predicate), start = performance.now();
    p.ws.send(JSON.stringify(versioned(p.state, msg)));
    await ready;
    return performance.now() - start;
  }
  async function disconnect(p) {
    if (p.ws.readyState !== WebSocket.CLOSED) {
      const closed = new Promise((r) => p.ws.once('close', r));
      p.ws.close(); await closed;
    }
    all.delete(p);
  }
  async function cleanup() {
    for (const p of all) p.ws.terminate();
    all.clear();
    await web.close();
    await sleep(30);
    assert.equal(t.hub.sessions, 0, 'после закрытия WS нет сессий');
    for (const room of [...t.app.rooms.values()]) await t.app.dropGame(room);
    await t.app.settle();
    assert.equal(t.app.rooms.size, 0);
    assert.equal(t.app.handles.size, 0, 'после удаления комнат нет игровых таймеров');
    assert.equal(t.hub.byRoom.size, 0);
    t.app.stop(); store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(t.errors, []);
    return { sessions: 0, rooms: 0, timers: 0, subscriptions: 0 };
  }
  return { t, web, url, connect, request, disconnect, cleanup, dbStats, traffic: () => ({ messages, bytes }) };
}

async function humanRoom(e, g, offset) {
  const a = user(offset, 'Первый'), b = user(offset + 1, 'Второй');
  const room = e.t.app.createGame(g.id, { chatId: String(-offset), title: 'Замер', host: identity(a), settings: g.maxPlayers === 2 ? { base: 600 } : { turnSeconds: 60 } });
  assert.ok(!room.error);
  e.t.openRoom(a, room); e.t.openRoom(b, room);
  await e.t.send(b, { t: 'sit' }); await e.t.send(a, { t: 'start' });
  e.t.close(a); e.t.close(b);
  assert.equal(room.status, 'playing');
  return { room, a, b };
}

function humanAction(g, view) {
  if (view.canNext) return { t: 'next' };
  const wait = { kind: g.id === 'battleship' && view.canPlace ? 'place' : 'move' };
  return g.bot.fallback(view, wait);
}

async function browserRun(run) {
  console.error(`browser ${run}/${options.runs}`);
  const e = await environment(run, 'browser');
  const browser = await chromium.launch();
  const results = [];
  let cleaned = false;
  try {
    for (const g of GAME_LIST) for (const cpuRate of [1, 4]) {
      console.error(`  ${g.id}, CPU x${cpuRate}`);
      const { room, a, b } = await humanRoom(e, g, 820000 + run * 1000 + results.length * 2);
      const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
      try {
        const page = await context.newPage();
        page.on('pageerror', (err) => e.t.errors.push(err.message));
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
        const data = initDataFor(a, { startParam: room.code, clock });
        await page.route('**/*', (r) => {
          const u = new URL(r.request().url());
          if (u.origin === e.url) return r.continue();
          if (u.href.startsWith('https://telegram.org/js/telegram-web-app.js')) return r.fulfill({ contentType: 'text/javascript', body: `window.Telegram={WebApp:{initData:${JSON.stringify(data)},initDataUnsafe:{},ready(){},expand(){},onEvent(){},BackButton:{show(){},hide(){},onClick(){}},HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}}}}` });
          e.t.errors.push(`Внешний запрос запрещён: ${u.origin}`); return r.abort();
        });
        await page.addInitScript(() => {
          window.__perf = { long: [], frames: [], render: [], messages: 0, bytes: 0 };
          new PerformanceObserver((list) => { for (const x of list.getEntries()) window.__perf.long.push(x.duration); }).observe({ type: 'longtask', buffered: true });
          let prev;
          function frame(now) { if (prev != null) window.__perf.frames.push(now - prev); prev = now; requestAnimationFrame(frame); }
          requestAnimationFrame(frame);
          const Native = window.WebSocket;
          window.WebSocket = class extends Native {
            constructor(...args) { super(...args); this.addEventListener('message', (ev) => { window.__perf.messages++; window.__perf.bytes += new TextEncoder().encode(ev.data).length; }); }
          };
        });
        const start = performance.now();
        await page.goto(e.url);
        await page.waitForFunction((id) => document.body.dataset.screen === id && !!document.querySelector('.panel'), g.id);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const firstReadyMs = performance.now() - start;
        await page.evaluate(async () => {
          const { bus, send } = await import('/net.js');
          const original = bus.onState;
          bus.onState = (...args) => {
            const start = performance.now(); original(...args);
            window.__perf.render.push(performance.now() - start);
            window.__received?.();
          };
          window.__request = (msg) => new Promise((resolve, reject) => {
            const start = performance.now();
            const timer = setTimeout(() => { window.__received = null; reject(new Error('browser state timeout')); }, 5000);
            window.__received = () => {
              window.__received = null; clearTimeout(timer);
              const stateMs = performance.now() - start;
              requestAnimationFrame(() => requestAnimationFrame(() => resolve({ stateMs, paintedMs: performance.now() - start })));
            };
            if (!send(msg, { lock: false })) { clearTimeout(timer); reject(new Error('send offline')); }
          });
        });
        const refresh = [];
        for (let i = 0; i < 20; i++) refresh.push(await page.evaluate(() => window.__request({ t: 'refresh' })));
        let v = g.view(room, String(a.id));
        // Если первый ход у второго, выполнить его через отдельный настоящий WS.
        if (!humanAction(g, v)) {
          const p = await e.connect(b, room);
          try {
            for (let step = 0; step < 10 && !humanAction(g, v); step++) {
              const msg = humanAction(g, p.state);
              assert.ok(msg, `${g.id}: начальное действие второго доступно`);
              await e.request(p, msg);
              await page.waitForFunction((seq) => document.body.dataset.seq === String(seq), room.seq);
              v = g.view(room, String(a.id));
            }
          } finally { await e.disconnect(p); }
        }
        const action = humanAction(g, v);
        assert.ok(action, `${g.id}: действие человека`);
        const oldSeq = room.seq;
        const actionLatency = await page.evaluate((msg) => window.__request(msg), action);
        assert.ok(room.seq > oldSeq, `${g.id}: действие действительно применено`);
        const raw = await page.evaluate(() => ({ ...window.__perf, resources: performance.getEntriesByType('resource').map((x) => ({ path: new URL(x.name).pathname, transfer: x.transferSize, encoded: x.encodedBodySize })) }));
        const local = raw.resources.filter((r) => !r.path.startsWith('/js/telegram-'));
        results.push({ game: g.id, cpuRate, firstReadyMs, refreshStateMs: stats(refresh.map((x) => x.stateMs)), refreshPaintedMs: stats(refresh.map((x) => x.paintedMs)), action: action.t, actionLatency, renderJSms: stats(raw.render), longTasksMs: stats(raw.long), frameIntervalMs: stats(raw.frames), messages: raw.messages, wsBytes: raw.bytes, resources: local.length, transferBytes: local.reduce((s, r) => s + r.transfer, 0), encodedBytes: local.reduce((s, r) => s + r.encoded, 0), largest: [...local].sort((a, b) => b.encoded - a.encoded).slice(0, 5) });
      } finally { await context.close(); await e.t.app.dropGame(room); }
    }
    const result = { chromium: browser.version(), results, db: e.dbStats(), cleanup: await e.cleanup() };
    cleaned = true;
    return result;
  } catch (err) { console.error(err); throw err; }
  finally { await browser.close(); if (!cleaned) await e.cleanup(); }
}

async function soakRun(run) {
  console.error(`soak ${run}/${options.runs}: ${options.seconds}s, 10 chess + 7 bot tables`);
  const e = await environment(run, 'soak');
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const samples = [], refresh = [], actions = {}, think = {}, restore = [];
  let cleaned = false;
  try {
    for (const g of GAME_LIST) {
      const original = g.bot.decide;
      think[g.id] = [];
      g.bot.decide = async (...args) => { const start = performance.now(); try { return await original(...args); } finally { think[g.id].push(performance.now() - start); } };
      restore.push(() => { g.bot.decide = original; });
    }
    const before = memory(), cpu = process.cpuUsage(), start = performance.now();
    loop.enable();
    const chess = GAME_LIST.find((g) => g.id === 'chess'), peers = [], solos = [];
    for (let i = 0; i < 10; i++) {
      const { room, a, b } = await humanRoom(e, chess, 840000 + run * 100 + i * 2);
      peers.push(await e.connect(a, room), await e.connect(b, room));
    }
    for (const [i, g] of GAME_LIST.entries()) {
      const u = user(850000 + run * 100 + i, 'Человек');
      const room = await e.t.app.createSolo(g.id, identity(u), { level: 1, side: 'white', base: 0, opponents: 2, turnSeconds: 0 });
      assert.ok(!room.error);
      solos.push({ g, p: await e.connect(u, room) }); actions[g.id] = [];
    }
    const reconnect = [];
    let tick = 0;
    const beganLoad = performance.now();
    while (performance.now() - beganLoad < options.seconds * 1000) {
      const beganTick = performance.now();
      refresh.push(...await Promise.all(peers.map((p) => e.request(p, { t: 'refresh' }))));
      for (const { g, p } of solos) {
        if (p.room.status !== 'playing') continue;
        const msg = humanAction(g, p.state);
        if (msg) {
          const seq = p.state.seq;
          actions[g.id].push(await e.request(p, msg, (s) => s.seq > seq));
        }
      }
      // Каждые 10 секунд те же 10 людей закрывают и заново открывают страницу.
      if (tick % 40 === 39) for (let i = 0; i < peers.length; i += 2) {
        const old = peers[i]; await e.disconnect(old);
        peers[i] = await e.connect(old.u, old.room); reconnect.push(peers[i].openMs);
      }
      if (tick % 40 === 0) samples.push({ seconds: (performance.now() - beganLoad) / 1000, ...memory(), sessions: e.t.hub.sessions, timers: e.t.app.handles.size });
      tick++;
      await sleep(Math.max(0, 250 - (performance.now() - beganTick)));
    }
    const wallMs = performance.now() - start, used = process.cpuUsage(cpu), underLoad = memory();
    loop.disable();
    for (const g of GAME_LIST) assert.ok(think[g.id].length > 0, `${g.id}: бот реально решал`);
    const result = { wallMs, cpuMs: (used.user + used.system) / 1000, cpuPercentOneCore: (used.user + used.system) / 10 / wallMs, refreshMs: stats(refresh), reconnectMs: stats(reconnect), actions: Object.fromEntries(Object.entries(actions).map(([k, v]) => [k, stats(v)])), botThinkMs: Object.fromEntries(Object.entries(think).map(([k, v]) => [k, stats(v)])), eventLoopMs: { p50: loop.percentile(50) / 1e6, p95: loop.percentile(95) / 1e6, max: loop.max / 1e6 }, before, underLoad, samples, traffic: e.traffic(), db: e.dbStats() };
    result.cleanup = await e.cleanup(); cleaned = true;
    result.afterCleanup = memory();
    return result;
  } finally {
    loop.disable(); for (const f of restore) f();
    if (!cleaned) await e.cleanup();
  }
}

const output = { version: 1, toolSha256: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'), at: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), node: process.version, os: `${os.platform()} ${os.release()} ${os.arch()}`, cpus: os.cpus().length, options, games: GAME_LIST.map((g) => g.id), browser: [], soak: [] };
for (let run = 1; run <= options.runs; run++) output.browser.push(await browserRun(run));
for (let run = 1; run <= options.runs; run++) output.soak.push(await soakRun(run));
console.log(JSON.stringify(output, null, 2));
