'use strict';
/**
 * HTTP + WebSocket for the Mini App. Thin on purpose: the protocol lives in
 * hub.js, the game in room.js. This file only moves bytes.
 *
 *   GET  /            the Mini App (miniapp/index.html)
 *   GET  /<file>      its scripts, styles and the 53 card pictures
 *   GET  /health      for an uptime check
 *   WS   /ws          the table: first message MUST be
 *                     { t:'hello', initData, room } — anything else closes it
 *
 * Static files are indexed once at start-up and served from that list only,
 * so no path from a request ever reaches the file system.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

/** Messages a page may send per second before it is cut off. */
const MAX_RATE = 30;

function indexFiles(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (TYPES[path.extname(e.name)]) {
        files.set('/' + path.relative(root, abs).split(path.sep).join('/'), abs);
      }
    }
  };
  walk(root);
  return files;
}

/**
 * @param hub   the Hub
 * @param root  directory with the Mini App (index.html and friends)
 */
export function startServer({ hub, port, root, host = '0.0.0.0', log = console.error, onListen } = {}) {
  const files = indexFiles(root);

  const server = http.createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://local').pathname;
    } catch {
      /* keep '/' */
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    if (pathname === '/health') {
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, sessions: hub.sessions }));
      return;
    }
    const file = files.get(pathname === '/' ? '/index.html' : pathname);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': TYPES[ext],
      // Card pictures never change for a given name; the app itself should be
      // picked up fresh after every restart of the bot.
      'cache-control': ext === '.svg' || ext === '.png' ? 'public, max-age=86400' : 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://local').pathname;
    } catch {
      /* refused below */
    }
    if (pathname !== '/ws') return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    let session = null;
    let window = { at: Date.now(), n: 0 };
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    const send = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    // One message at a time per page: a second tap waits for the first to
    // be fully applied, exactly like the updates grammY feeds the bot.
    let chain = Promise.resolve();
    ws.on('message', (buf) => {
      const now = Date.now();
      if (now - window.at > 1000) window = { at: now, n: 0 };
      if (++window.n > MAX_RATE) return void ws.close(4008, 'too many messages');

      chain = chain.then(async () => {
        let msg;
        try {
          msg = JSON.parse(String(buf));
        } catch {
          return send({ t: 'error', code: 'BAD_REQUEST', text: 'Не понял запрос.' });
        }
        if (msg?.t === 'ping') return send({ t: 'pong' });
        if (!session) {
          if (msg?.t !== 'hello') return void ws.close(4001, 'hello first');
          const r = hub.open(msg, send);
          if (r.error) {
            send({ t: 'fatal', code: r.error, text: r.text });
            return void ws.close(4003, r.error);
          }
          session = r.session;
          return;
        }
        await hub.handle(session, msg);
      }).catch((err) => log('[ws]', err?.message || err));
    });

    ws.on('close', () => {
      if (session) hub.close(session);
    });
  });

  // Dead phones do not say goodbye: ping everyone, drop whoever stays silent.
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  beat.unref?.();

  server.listen(port, host, () => onListen?.(server.address()));

  return {
    server,
    wss,
    close: () =>
      new Promise((resolve) => {
        clearInterval(beat);
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}
