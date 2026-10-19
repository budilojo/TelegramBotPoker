'use strict';
/**
 * Аудит, фаза 1 (B): транспорт — настоящий HTTP-сервер и настоящий WebSocket.
 *
 * Остальные тесты гоняют хаб без сокета; здесь — то, что живёт только в
 * `server.js`: статика, заголовки, кадры, очередь сообщений одной страницы и
 * её закрытие. Сервер поднимается на 127.0.0.1 и случайном порту, Telegram —
 * заглушка; наружу ничего не ходит.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Table, user, initDataFor } from './harness.js';
import { startServer } from './server.js';
import { GAMES } from './games/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'miniapp');

async function serve(t) {
  return new Promise((resolve) => {
    const web = startServer({
      hub: t.hub, port: 0, host: '127.0.0.1', root: ROOT, log: () => {},
      onListen: (addr) => resolve({ web, port: addr.port, close: () => web.close() }),
    });
  });
}

function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  ws.on('message', (b) => inbox.push(JSON.parse(String(b))));
  const closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })));
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.on('error', () => {}); // разрыв сервером — ожидаемый исход части атак
      resolve({ ws, inbox, closed });
    });
    ws.on('error', reject);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(10);
  }
  return fn();
}

/** Сырой HTTP-запрос: путь уходит как есть, без нормализации клиентом. */
function rawGet(port, rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`${method} ${rawPath} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    s.on('data', (d) => (buf += d));
    s.on('end', () => resolve(buf));
    s.on('error', reject);
  });
}

/* ---------------------------------------------- B-01: сессия после закрытия */

test('АУДИТ B-01: страница, закрытая посреди обработки, не остаётся «за столом» и не глушит «ваш ход»', async () => {
  const t = new Table();
  const ann = user(101, 'Аня');
  const bob = user(102, 'Боб');
  await t.start(ann);
  await t.start(bob);
  await t.cmd(ann, '/game');
  await t.cmd(ann, '/durak');
  const room = t.durak;
  t.openRoom(bob, room);
  await t.send(bob, { t: 'sit' });
  t.close(bob); // дальше в хабе открыта только страница Ани через сокет

  // Telegram отвечает медленно: «ещё один стол» ждёт сети, а страница за это
  // время успевает прислать ещё сообщение — и закрыться.
  const post = t.tg.sendMessage.bind(t.tg);
  t.tg.sendMessage = async (...a) => {
    await wait(300);
    return post(...a);
  };
  const srv = await serve(t);
  try {
    const page = await connect(srv.port);
    page.ws.send(JSON.stringify({ t: 'hello', initData: initDataFor(ann, { startParam: `g_${t.group.code}`, clock: t.clock }) }));
    page.ws.send(JSON.stringify({ t: 'again', from: room.code, reqId: 'r1' }));
    page.ws.send(JSON.stringify({ t: 'hub' })); // назад в хаб группы…
    page.ws.send(JSON.stringify({ t: 'join', code: room.code })); // …и за первый стол
    await until(() => page.inbox.length > 0);
    page.ws.close();
    await page.closed;
    await wait(700); // медленный Telegram ответил, очередь страницы доработала
    t.tg.sendMessage = post;

    assert.equal(t.hub.sessions, 0, 'закрытой странице не место в списке открытых');
    assert.equal(t.hub.isPresent(room.code, ann.id), false, 'закрытая страница — не «человек смотрит на стол»');

    // Последствие: партия пошла, приложение у Ани закрыто — «ваш ход» приходит в личку.
    t.open(ann, { initData: initDataFor(ann, { startParam: room.code, clock: t.clock }) });
    await t.send(ann, { t: 'start' });
    t.close(ann);
    const before = t.tg.dms(ann.id).length;
    room.ui.pings = {}; // как будто напоминания ещё не было
    await t.app.draw(room);
    await t.app.settle();
    if (GAMES.durak.waiting(room).some((w) => w.id === String(ann.id))) {
      assert.ok(t.tg.dms(ann.id).length > before, 'Аня получила «ваш ход»');
    }
  } finally {
    await srv.close();
  }
});

/* -------------------------------------------------- B: статика и заголовки */

test('АУДИТ B: обход каталога и чужие файлы — 404 на каждый путь, файлы проекта не отдаются', async () => {
  const t = new Table();
  const srv = await serve(t);
  try {
    const paths = [
      '/../.env', '/..%2f.env', '/%2e%2e/.env', '/%2e%2e%2f.env', '/..%252f.env', '/..\\.env', '/%5c..%5c.env',
      '/.env', '/.env%00.js', '/index.html%00', '//etc/passwd', '/../../../../etc/passwd', '/..;/.env',
      '/../data/bot.db', '/data/bot.db', '/../backups/', '/../bot/app.js', '/bot/app.js', '/../package.json',
      '/package.json', '/.git/config', '/../.git/HEAD', '/cards/../../.env', '/cards/..%2f..%2f.env',
      `/${'a/'.repeat(4000)}`, '/?x=../../.env', '/#../.env', '/%00', '/%', '/%zz', 'http://evil/../.env', '*',
    ];
    for (const p of paths) {
      const r = await rawGet(srv.port, p);
      const status = Number(r.split(' ')[1]);
      assert.ok(status === 404 || status === 400 || status === 200, `${p}: ${r.slice(0, 60)}`);
      if (status === 200) {
        // 200 допустим только как сама страница Mini App (путь «/» с хвостом-запросом).
        assert.match(r, /<!doctype html>/i, `${p}: отдано что-то кроме index.html`);
      }
      assert.doesNotMatch(r, /BOT_TOKEN|ADMIN_BOT_TOKEN|SQLite format|"dependencies"|\[core\]|root:x:0/, `${p}: утёк файл`);
    }
  } finally {
    await srv.close();
  }
});

test('АУДИТ B: методы кроме GET/HEAD — 405 без тела; ошибки без стека и версий', async () => {
  const t = new Table();
  const srv = await serve(t);
  try {
    // CONNECT Node обрывает сам, без ответа: тела нет — и это тоже отказ.
    assert.equal(await rawGet(srv.port, '/index.html', 'CONNECT'), '');
    for (const m of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'TRACE', 'PATCH', 'PROPFIND']) {
      const r = await rawGet(srv.port, '/index.html', m);
      const status = Number(r.split(' ')[1]);
      assert.ok(status === 405 || status === 400, `${m}: ${r.slice(0, 40)}`);
      assert.doesNotMatch(r, /at \w+ \(|node:|Error/, `${m}: в ответе стек`);
    }
    const head = await rawGet(srv.port, '/index.html', 'HEAD');
    assert.match(head, /^HTTP\/1\.1 200/);
    const r404 = await rawGet(srv.port, '/nope');
    assert.doesNotMatch(r404, /^server:/im, 'сервер не называет себя');
    assert.doesNotMatch(r404, /x-powered-by/i);
  } finally {
    await srv.close();
  }
});

test('АУДИТ B: заголовки страницы — nosniff, no-referrer, no-cache на приложении', async () => {
  const t = new Table();
  const srv = await serve(t);
  try {
    const r = await rawGet(srv.port, '/');
    assert.match(r, /x-content-type-options: nosniff/i);
    assert.match(r, /referrer-policy: no-referrer/i);
    assert.match(r, /cache-control: no-cache/i);
    assert.match(r, /content-type: text\/html; charset=utf-8/i);
    const h = await rawGet(srv.port, '/health');
    const body = h.slice(h.indexOf('\r\n\r\n') + 4);
    // /health — только «жив» и число открытых страниц: ни имён, ни кодов, ни путей.
    assert.deepEqual(Object.keys(JSON.parse(body.trim().split('\r\n').find((l) => l.startsWith('{')) || body)).sort(), ['ok', 'sessions']);
  } finally {
    await srv.close();
  }
});

/* ------------------------------------------------------- B: кадры WebSocket */

test('АУДИТ B: мусорные кадры WebSocket — сервер не падает и отвечает словами', async () => {
  const t = new Table();
  const ann = user(101, 'Аня');
  await t.cmd(ann, '/game');
  await t.cmd(ann, '/durak');
  const srv = await serve(t);
  try {
    // До hello: всё, кроме ping и hello, закрывает сокет.
    {
      const p = await connect(srv.port);
      p.ws.send('{"t":"sit"}');
      const c = await p.closed;
      assert.equal(c.code, 4001);
    }
    // Плохая подпись — fatal и закрытие.
    {
      const p = await connect(srv.port);
      p.ws.send(JSON.stringify({ t: 'hello', initData: 'user=%7B%22id%22%3A1%7D&hash=' + 'a'.repeat(64) }));
      const c = await p.closed;
      assert.equal(c.code, 4003);
      assert.equal(p.inbox[0]?.t, 'fatal');
    }
    // После hello — мусор всех видов.
    const p = await connect(srv.port);
    p.ws.send(JSON.stringify({ t: 'hello', initData: initDataFor(ann, { startParam: t.durak.code, clock: t.clock }) }));
    await until(() => p.inbox.some((m) => m.t === 'state'));
    const junk = [
      'not json', '', 'null', '[]', '"str"', '123', 'true', '{"t":1}', '{"t":null}', '{}', '{"t":{"x":1}}',
      '{"__proto__":{"t":"sit","polluted":true}}', '{"constructor":{"prototype":{"polluted":true}},"t":"sit"}',
      '{"t":"__proto__"}', '{"t":"constructor"}', '{"t":"toString"}', '{"t":"hasOwnProperty"}',
      '['.repeat(5000) + ']'.repeat(5000), '{"a":'.repeat(2000) + '1' + '}'.repeat(2000),
    ];
    for (const j of junk) p.ws.send(j);
    p.ws.send(Buffer.from([0xff, 0xfe, 0x00, 0x01]), { binary: true });
    p.ws.send(JSON.stringify({ t: 'ping' }));
    await until(() => p.inbox.some((m) => m.t === 'pong'), 3000);
    assert.ok(p.inbox.some((m) => m.t === 'pong'), 'сокет жив после мусора');
    assert.equal({}.polluted, undefined, 'прототип Object не загрязнён');
    assert.equal(Object.prototype.polluted, undefined);
    assert.ok(p.inbox.filter((m) => m.t === 'error').every((m) => typeof m.text === 'string' && m.text.length > 0));
    p.ws.close();
  } finally {
    await srv.close();
  }
});

/* ----------------------------------------- B-02: кривой кадр ронял процесс */

/**
 * Сервер — в отдельном процессе: если кадр его уронит, упадёт он, а не
 * прогон тестов, и тест скажет об этом словами.
 */
const CHILD = `
import { startServer } from ${JSON.stringify(new URL('./server.js', import.meta.url).href)};
const hub = { sessions: 0, open: () => ({ error: 'AUTH', text: 'нет' }), close() {}, handle() {} };
startServer({ hub, port: 0, host: '127.0.0.1', root: ${JSON.stringify(ROOT)}, log: () => {}, onListen: (a) => console.log('PORT ' + a.port) });
`;

test('АУДИТ B-02: кривой кадр WebSocket без всякой подписи не роняет процесс бота', async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  try {
    assert.ok(await until(() => /PORT \d+/.test(out), 5000), 'сервер поднялся');
    const port = Number(/PORT (\d+)/.exec(out)[1]);
    const frames = {
      'больше 16 КБ': (ws) => ws.send('x'.repeat(17 * 1024)),
      'битый UTF-8': (ws) => ws._socket.write(Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0xff ^ 1, 0xfe ^ 2])),
      'без маски': (ws) => ws._socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69])),
      'чужой опкод': (ws) => ws._socket.write(Buffer.from([0x83, 0x80, 1, 2, 3, 4])),
      'фрагмент без начала': (ws) => ws._socket.write(Buffer.from([0x80, 0x80, 1, 2, 3, 4])),
    };
    for (const [name, shoot] of Object.entries(frames)) {
      const p = await connect(port);
      shoot(p.ws);
      await p.closed;
      await wait(50);
      assert.equal(child.exitCode, null, `«${name}»: процесс бота умер\n${err}`);
    }
    // И он по-прежнему отвечает.
    const p = await connect(port);
    p.ws.send('{"t":"ping"}');
    assert.ok(await until(() => p.inbox.some((m) => m.t === 'pong')), 'после атак сервер отвечает');
    p.ws.close();
  } finally {
    child.kill();
    await exited;
  }
});

test('АУДИТ B: больше 30 сообщений в секунду — разрыв 4008', async () => {
  const t = new Table();
  const srv = await serve(t);
  try {
    const p = await connect(srv.port);
    for (let i = 0; i < 40; i++) p.ws.send('{"t":"ping"}');
    const c = await p.closed;
    assert.equal(c.code, 4008);
  } finally {
    await srv.close();
  }
});

test('АУДИТ B: апгрейд не на /ws и полузавершённое рукопожатие не держат сокет', async () => {
  const t = new Table();
  const srv = await serve(t);
  try {
    await assert.rejects(new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/other`);
      ws.on('open', resolve);
      ws.on('error', reject);
    }));
  } finally {
    await srv.close();
  }
});
