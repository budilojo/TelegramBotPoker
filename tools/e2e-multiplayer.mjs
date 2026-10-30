/** J: четыре независимых контекста на игру, две страницы одной личности.
 * Настоящие HTTP/WS/клиент; Telegram и часы — заглушки. Только localhost. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Table, user, initDataFor, TEST_TOKEN } from '../bot/harness.js';
import { GAME_LIST } from '../bot/games/index.js';
import { startServer } from '../bot/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = new Table({ nardyDice: () => [5, 3], battleshipFleetRand: () => 0.37 });
const web = startServer({ hub: t.hub, port: Number(process.env.E2E_PORT || 8241), host: '127.0.0.1', root: path.join(root, 'miniapp'), log: () => {} });
await new Promise((r) => web.server.once('listening', r));
const url = `http://127.0.0.1:${web.server.address().port}`;
const browser = await chromium.launch();
const problems = [];
const H = user(101, 'Хост');
const B = user(202, 'Гость');
const S = user(303, 'Зритель');
const sdk = (data) => `const NativeWS=window.WebSocket;window.WebSocket=class extends NativeWS{constructor(...args){super(...args);(window.__sockets ||= []).push(this)}};window.Telegram={WebApp:{initData:${JSON.stringify(data)},initDataUnsafe:{start_param:new URLSearchParams(${JSON.stringify(data)}).get('start_param')},ready(){},expand(){},close(){},disableVerticalSwipes(){},setHeaderColor(){},setBackgroundColor(){},setBottomBarColor(){},onEvent(){},openTelegramLink(){},BackButton:{show(){},hide(){},onClick(f){window.__back=f;}},HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}}}};`;
async function open(who, group, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const frames = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    const m = JSON.parse(String(payload));
    frames.push(m); // все кадры, сохраняются и при переподключении
  }));
  const data = initDataFor(who, { startParam: `g_${group.code}`, clock: t.clock, token: TEST_TOKEN });
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdk(data) }));
  await page.goto(url);
  await page.waitForSelector('.game-card');
  return { context, page, frames, who };
}
const send = (p, msg) => p.page.evaluate(async (msg) => (await import('/net.js')).send(msg, { lock: false }), msg);
const state = (p) => p.page.evaluate(async () => (await import('/net.js')).net.state);
async function until(fn, label) {
  const end = Date.now() + 6000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`Не дождались: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function tableAt(p, code) { await until(async () => (await state(p))?.room?.code === code, `стол ${code}`); }
try {
  let chat = -91000;
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }].filter((v) => !process.env.MULTI_WIDTH || v.width === Number(process.env.MULTI_WIDTH))) for (const g of GAME_LIST.filter((g) => !process.env.MULTI_GAME || g.id === process.env.MULTI_GAME)) {
    t.chatId = --chat;
    await t.cmd(H, '/game');
    const group = t.group;
    const pages = [];
    try {
      for (const u of [H, H, B, S]) pages.push(await open(u, group, viewport));
      const [h, same, b, spy] = pages;
      const create = { t: 'create', game: g.id, settings: g.maxPlayers === 2 ? { base: 60 } : { turnSeconds: 30 }, reqId: 'j-browser' };
      await Promise.all([send(h, create), send(same, create)]);
      await until(() => t.app.roomsOf(chat).length === 1, 'одно лобби');
      const room = t.app.roomsOf(chat)[0];
      for (const p of [h, same]) await tableAt(p, room.code);
      for (const p of [b, spy]) { await send(p, { t: 'join', code: room.code }); await tableAt(p, room.code); }
      await b.page.getByRole('button', { name: /^Сесть за (стол|доску)$/ }).click();
      await until(() => room.players.length === 2, 'соперник сел');
      await h.page.getByRole('button', { name: '▶ Начать', exact: true }).click();
      for (const p of pages) await until(async () => (await state(p))?.room?.status === 'playing', 'начало у всех');
      assert.equal((await state(h)).me.seat, (await state(same)).me.seat);
      assert.equal((await state(spy)).me.seated, false);
      const playing = structuredClone(room.hand || room.deal || room.match);
      const turn = structuredClone(room.turn);
      // Настройки/рейтинг через навигацию настоящей страницы.
      await h.page.evaluate(() => window.__back());
      await h.page.waitForSelector('.back-to-table');
      await h.page.locator('.nav-tab[data-tab="settings"]').click();
      await h.page.waitForSelector('h1:has-text("Настройки")');
      await h.page.locator('.nav-tab[data-tab="rating"]').click();
      await h.page.locator('.nav-tab[data-tab="games"]').click();
      await h.page.locator('.back-to-table').click();
      await tableAt(h, room.code);
      assert.deepEqual(room.hand || room.deal || room.match, playing);
      assert.deepEqual(room.turn, turn);
      // Настоящий обрыв WS: страница восстанавливает стол по hello.
      const received = same.frames.length;
      await same.page.evaluate(() => window.__sockets.at(-1).close());
      await until(() => same.frames.slice(received).some((m) => m.state?.room?.code === room.code), 'автоматический reconnect к тому же столу');
      await tableAt(same, room.code);
      assert.deepEqual(room.turn, turn);
      // Reload — повторный вход из карточки группы, без автоматического занятия второго места.
      await same.page.reload();
      // Подпись группы сначала открывает хаб; клиент помнит выбранный стол.
      await until(async () => ['hub', undefined].includes((await state(same))?.kind) || (await state(same))?.game === g.id, 'повторный вход');
      if (!(await state(same))?.room) { await send(same, { t: 'join', code: room.code }); }
      await tableAt(same, room.code);
      assert.equal((await state(same)).me.seat, (await state(h)).me.seat);
      assert.equal(room.players.length, 2);
      assert.deepEqual(room.turn, turn);
      // Пакет из текущей страницы обязан нести seq. Это проверяет именно net.send,
      // а не вручную собранный тестом правильный пакет.
      const heard = [];
      const original = t.hub.handle.bind(t.hub);
      t.hub.handle = async (session, msg) => { heard.push(structuredClone(msg)); return original(session, msg); };
      try {
        const expectedSeq = (await state(same)).seq;
        await send(same, { t: 'settings', ...(g.maxPlayers === 2 ? { base: 180 } : { turnSeconds: 60 }) });
        await until(() => heard.some((m) => m.t === 'settings'), 'пакет настроек');
        assert.equal(heard.find((m) => m.t === 'settings').seq, expectedSeq, 'клиент передал версию стола');
        if (room.match) assert.equal(heard.find((m) => m.t === 'settings').matchNo, room.match.no, 'клиент передал номер партии');
        await send(same, { t: 'settings', seq: -1 });
        await until(() => heard.filter((m) => m.t === 'settings').length === 2, 'явная версия пакета');
        assert.equal(heard.at(-1).seq, -1, 'явная версия исходного действия не перезаписана');
      } finally { t.hub.handle = original; }
      for (const p of pages) {
        const stream = JSON.stringify(p.frames);
        assert.doesNotMatch(stream, /"(?:holes|fleets|initData|tgId|telegram_payment_charge_id|pay_order)"/);
        assert.doesNotMatch(stream, /"hands":\{/);
        for (const s of p.frames.filter((m) => m.t === 'state' && m.state.game).map((m) => m.state)) {
          if (g.maxPlayers === 2) for (const row of s.score) assert.equal(row.id, undefined);
          if (p.who === S) {
            assert.equal(s.me.seated, false);
            if (s.me.cards) assert.deepEqual(s.me.cards, []);
            if (g.maxPlayers === 2) assert.deepEqual(s.legal, { myTurn: false });
            if (s.match?.boards) for (const board of s.match.boards) assert.deepEqual(board.ships, []);
          }
        }
        assert.ok(p.frames.some((m) => m.state?.game === g.id && m.state.room.status === 'playing'));
        assert.ok(await p.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
      if (process.env.SHOTS) await h.page.screenshot({ path: path.join(root, 'preview', `multiplayer-${g.id}-${viewport.width}.png`) });
      console.log(`J ${g.id} ${viewport.width}: четыре контекста, создание/роль/разделы/reload/весь поток — ок`);
      await t.app.dropGame(room);
    } finally { for (const p of pages) await p.context.close(); }
  }
  assert.deepEqual(t.errors, []);
  assert.deepEqual(problems, []);
} finally {
  t.app.stop();
  await browser.close();
  await web.close();
}
console.log('J multiplayer: всё сошлось (TelegramStub, не телефоны).');
