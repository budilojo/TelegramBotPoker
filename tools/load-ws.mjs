/**
 * Нагрузка на настоящий сервер (аудит, фаза 6 — I и A-5).
 *
 *   node --expose-gc --disable-warning=ExperimentalWarning tools/load-ws.mjs [страниц] [секунд]
 *
 * Сервер — на 127.0.0.1 и случайном порту, Telegram — заглушка, наружу
 * ничего не ходит. Что меряется:
 *   1. N страниц разных людей в 20 столах дурака, каждая шлёт «обновить»
 *      несколько раз в секунду: задержка ответа (p50/p99), память.
 *   2. Одна подпись — тысяча соединений подряд: что держит память на одно.
 *   3. Всё закрыли — сессий 0, память вернулась.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Table, user, initDataFor } from '../bot/harness.js';
import { startServer } from '../bot/server.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'miniapp');
const [N = 400, SECS = 10] = process.argv.slice(2).map(Number);
const mb = () => {
  global.gc?.();
  return (process.memoryUsage().heapUsed / 1048576).toFixed(1);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const row = (k, v) => console.log(`${k.padEnd(52)} ${v}`);

const REAL = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) };
const t = new Table({ clock: REAL });
const rooms = [];
for (let i = 0; i < 20; i++) {
  const host = user(10_000 + i, `Х${i}`);
  t.chatId = -2_000_000 - i;
  await t.cmd(host, '/durak');
  rooms.push(t.durak.code);
}
const srv = await new Promise((resolve) => {
  const web = startServer({ hub: t.hub, port: 0, host: '127.0.0.1', root: ROOT, log: () => {}, onListen: (a) => resolve({ web, port: a.port }) });
});
const url = `ws://127.0.0.1:${srv.port}/ws`;

function page(u, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const p = { ws, waiting: [], lat: [] };
    ws.on('error', () => {});
    ws.on('close', () => reject(new Error('закрыто')));
    ws.on('message', (b) => {
      const m = JSON.parse(String(b));
      if (m.t === 'state' && p.waiting.length) p.lat.push(Date.now() - p.waiting.shift());
      if (m.t === 'fatal') reject(new Error(m.text));
      // Готова — когда пришло состояние и за ним не последовал отказ.
      if (m.t === 'state' && !p.ready) {
        p.ready = true;
        setTimeout(() => resolve(p), 30);
      }
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', initData: initDataFor(u, { startParam: room, clock: REAL }) })));
    setTimeout(() => reject(new Error('страница не открылась')), 10_000);
  });
}

console.log(`=== 1. ${N} страниц в 20 столах, «обновить» 4 раза в секунду, ${SECS} с ===`);
row('память до', `${mb()} МБ`);
const pages = [];
for (let i = 0; i < N; i++) pages.push(await page(user(20_000 + i, `И${i}`), rooms[i % rooms.length]));
row('открыто страниц / сессий в хабе', `${pages.length} / ${t.hub.sessions}`);
row('память с ними', `${mb()} МБ`);
const end = Date.now() + SECS * 1000;
let sent = 0;
while (Date.now() < end) {
  for (const p of pages) {
    p.waiting.push(Date.now());
    p.ws.send('{"t":"refresh"}');
    sent += 1;
  }
  await wait(250);
}
await wait(1000);
const lat = pages.flatMap((p) => p.lat).sort((a, b) => a - b);
row('сообщений отправлено / ответов', `${sent} / ${lat.length}`);
row('задержка ответа p50 / p99 / макс', `${lat[lat.length >> 1]} / ${lat[Math.floor(lat.length * 0.99)]} / ${lat.at(-1)} мс`);
row('память под штормом', `${mb()} МБ`);
for (const p of pages) p.ws.close();
await wait(1000);
row('после закрытия: сессий в хабе', t.hub.sessions);
row('память после закрытия', `${mb()} МБ`);

console.log('\n=== 2. Одна подпись — 1000 попыток соединиться (предел — MAX_PAGES на человека) ===');
const one = user(30_000, 'Один');
const before = Number(mb());
const many = [];
let refused = 0;
for (let i = 0; i < 1000; i++) {
  try {
    many.push(await page(one, rooms[0]));
  } catch {
    refused += 1;
  }
}
row('пущено / отказано', `${many.length} / ${refused}`);
// Разные люди — по странице: столько же соединений, сколько у атакующего было бы без предела.
for (let i = 0; many.length < 1000; i++) many.push(await page(user(40_000 + i, `Л${i}`), rooms[i % rooms.length]));
const after = Number(mb());
row('сессий в хабе', t.hub.sessions);
row('память на одно соединение (куча)', `${(((after - before) * 1024) / 1000).toFixed(1)} КБ`);
// Один ход за столом — и сервер шлёт состояние каждой из тысячи страниц.
const t0 = Date.now();
t.hub.broadcast(t.app.roomByCode(rooms[0]));
row('одна перерисовка стола на 1000 страниц', `${Date.now() - t0} мс`);
for (const p of many) p.ws.terminate();
await wait(1500);
row('после закрытия: сессий в хабе', t.hub.sessions);
row('память после закрытия', `${mb()} МБ`);

await srv.web.close();
t.app.stop();
process.exit(0);
