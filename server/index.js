'use strict';
/**
 * HTTP + WebSocket entry point.
 *
 * The socket protocol is deliberately dumb: clients send intents, the server
 * answers with a full room snapshot. Snapshots are small (a poker table is a
 * handful of players) and make reconnect logic trivial — there is no delta
 * stream to replay, you just get the truth again.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import * as R from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable('x-powered-by');
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    etag: true,
  })
);

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, rooms: R.rooms.size, uptime: process.uptime() })
);

/** Cheap existence probe so the join screen can validate a code before connecting. */
app.get('/api/room/:code', (req, res) => {
  const room = R.findRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
  res.json({
    code: room.code,
    status: room.status,
    players: room.players.length,
    settings: room.settings,
    hostName: room.players.find((p) => p.id === room.hostId)?.name ?? null,
  });
});

app.get('/api/qr', async (req, res) => {
  const data = String(req.query.u || '').slice(0, 512);
  if (!data) return res.status(400).send('missing u');
  try {
    const svg = await QRCode.toString(data, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#0B0E0C', light: '#F2F5F1' },
    });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
  } catch {
    res.status(500).send('qr failed');
  }
});

// Any unknown path is a client-side route (/join/ABCD etc.)
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/* --------------------------------------------------------------- sessions */

/** ws -> { roomCode, playerId } */
const sessions = new Map();
/** roomCode -> Set<ws> */
const roomSockets = new Map();

function socketsOf(code) {
  let s = roomSockets.get(code);
  if (!s) roomSockets.set(code, (s = new Set()));
  return s;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, extra = null) {
  for (const ws of socketsOf(room.code)) {
    const s = sessions.get(ws);
    if (!s) continue;
    send(ws, { t: 'state', state: R.publicState(room, s.playerId), event: extra });
  }
}

function fail(ws, code, message) {
  send(ws, { t: 'error', code, message: message || ERRORS[code] || code });
}

const ERRORS = {
  ROOM_NOT_FOUND: 'Комната не найдена',
  BAD_CODE: 'Неверный код комнаты',
  GAME_FINISHED: 'Игра уже завершена',
  NOT_HOST: 'Только хост может это сделать',
  NOT_YOUR_TURN: 'Сейчас не ваш ход',
  NOT_ENOUGH_CHIPS: 'Недостаточно фишек',
  NOT_ENOUGH_PLAYERS: 'Нужно минимум 2 игрока с фишками',
  BELOW_MIN_RAISE: 'Ставка меньше минимального рейза',
  CANNOT_CHECK: 'Сейчас нельзя сделать check',
  CANNOT_CALL: 'Сейчас нечего коллировать',
  CANNOT_BET: 'Сейчас нельзя открывать ставку',
  CANNOT_RAISE: 'Сейчас нельзя повышать',
  BAD_AMOUNT: 'Некорректная сумма',
  STALE: 'Состояние изменилось — попробуйте ещё раз',
  SESSION_INVALID: 'Сессия недействительна',
  HAND_IN_PROGRESS: 'Раздача ещё идёт',
  NOT_SHOWDOWN: 'Раздача ещё не завершена',
  NO_WINNER_SELECTED: 'Выберите победителя каждого банка',
  NOTHING_TO_UNDO: 'Нечего отменять',
  GAME_PAUSED: 'Игра на паузе',
  NOT_PLAYING: 'Игра ещё не началась',
  CANNOT_KICK_HOST: 'Нельзя удалить хоста',
  NO_PLAYER: 'Игрок не найден',
  DEALER_DECIDES: 'Победителя определяет дилер',
  DEALER_DEALS: 'Следующую раздачу начинает дилер',
  NOT_LEVELS: 'Растущие блайнды выключены',
  LAST_LEVEL: 'Это последний уровень блайндов',
  BAD_ROLE: 'Неизвестная роль',
  RATE_LIMIT: 'Слишком много запросов',
  ROOM_FULL: 'В комнате уже максимум игроков',
};

const MAX_PLAYERS = 10;

/* ------------------------------------------------------------- connection */

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.bucket = { tokens: 40, at: Date.now() };
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    if (!allow(ws)) return fail(ws, 'RATE_LIMIT');
    let msg;
    try {
      msg = JSON.parse(String(raw).slice(0, 4096));
    } catch {
      return;
    }
    try {
      handle(ws, msg);
    } catch (e) {
      console.error('[handle]', msg?.t, e);
      fail(ws, 'SERVER_ERROR', 'Внутренняя ошибка сервера');
    }
  });

  ws.on('close', () => {
    const s = sessions.get(ws);
    sessions.delete(ws);
    if (!s) return;
    socketsOf(s.roomCode).delete(ws);
    const room = R.findRoom(s.roomCode);
    if (!room) return;
    // Only mark offline if no other tab of this player is still open.
    const stillHere = [...socketsOf(s.roomCode)].some(
      (o) => sessions.get(o)?.playerId === s.playerId
    );
    if (!stillHere) {
      R.markConnection(room, s.playerId, false);
      broadcast(room);
    }
  });
});

function allow(ws) {
  const now = Date.now();
  const b = ws.bucket;
  b.tokens = Math.min(40, b.tokens + ((now - b.at) / 1000) * 12);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function attach(ws, room, player) {
  // One live socket per player: a second tab takes over cleanly.
  for (const other of socketsOf(room.code)) {
    if (other !== ws && sessions.get(other)?.playerId === player.id) {
      send(other, { t: 'kicked', reason: 'DUPLICATE_SESSION' });
      other.close();
    }
  }
  sessions.set(ws, { roomCode: room.code, playerId: player.id });
  socketsOf(room.code).add(ws);
  R.markConnection(room, player.id, true);
  send(ws, {
    t: 'session',
    code: room.code,
    playerId: player.id,
    token: player.token,
    lanUrl: LAN_URL,
  });
}

function ctx(ws) {
  const s = sessions.get(ws);
  if (!s) return null;
  const room = R.findRoom(s.roomCode);
  if (!room) return null;
  const player = room.players.find((p) => p.id === s.playerId);
  if (!player) return null;
  return { room, player };
}

/* -------------------------------------------------------------- dispatch  */

function handle(ws, msg) {
  switch (msg.t) {
    case 'ping':
      return send(ws, { t: 'pong', at: Date.now() });

    case 'create': {
      const { room, player } = R.createRoom({
        name: msg.name,
        startingStack: msg.startingStack,
        smallBlind: msg.smallBlind,
        bigBlind: msg.bigBlind,
      });
      attach(ws, room, player);
      console.log(`[room] ${room.code} created by ${player.name}`);
      return broadcast(room);
    }

    case 'join': {
      const room = R.findRoom(msg.code);
      if (!room) return fail(ws, 'ROOM_NOT_FOUND');
      if (room.status === 'finished') return fail(ws, 'GAME_FINISHED');

      // Reclaiming a seat: same name, currently offline. Covers "I cleared my
      // browser data" / "I'm on a different phone now".
      const wanted = R.cleanName(msg.name, '');
      const orphan = room.players.find(
        (p) => !p.connected && p.name.toLowerCase() === wanted.toLowerCase()
      );
      if (orphan) {
        attach(ws, room, orphan);
        send(ws, {
          t: 'toast',
          kind: 'ok',
          text: 'Вы вернулись на своё место',
        });
        return broadcast(room);
      }

      if (room.players.length >= MAX_PLAYERS) return fail(ws, 'ROOM_FULL');
      const player = R.addPlayer(room, msg.name);
      attach(ws, room, player);
      if (player.waiting) {
        send(ws, {
          t: 'toast',
          kind: 'info',
          text: 'Игра уже идёт — вы вступите со следующей раздачи',
        });
      }
      return broadcast(room);
    }

    case 'resume': {
      const room = R.findRoom(msg.code);
      if (!room) return fail(ws, 'ROOM_NOT_FOUND');
      const player = room.players.find(
        (p) => p.id === msg.playerId && p.token === msg.token
      );
      if (!player) return fail(ws, 'SESSION_INVALID');
      attach(ws, room, player);
      return broadcast(room);
    }

    case 'leave': {
      const c = ctx(ws);
      sessions.delete(ws);
      if (!c) return;
      socketsOf(c.room.code).delete(ws);
      R.markConnection(c.room, c.player.id, false);
      return broadcast(c.room);
    }
  }

  // Everything below requires an established session.
  const c = ctx(ws);
  if (!c) return fail(ws, 'SESSION_INVALID');
  const { room, player } = c;
  let r;
  let event = null;

  switch (msg.t) {
    case 'ready':
      r = R.setReady(room, player.id, msg.value);
      break;
    case 'sitOut':
      r = R.setSittingOut(room, player.id, msg.value);
      break;
    case 'rename':
      r = R.renamePlayer(room, player.id, msg.name);
      break;
    case 'start':
      r = R.startGame(room, player.id);
      break;
    case 'action':
      r = R.act(room, player.id, msg.action, msg.amount, msg.seq);
      if (r.ok) event = { kind: 'action', playerId: player.id, action: r.action };
      break;
    case 'selectWinners':
      r = R.selectWinners(room, player.id, msg.potIndex, msg.winners);
      break;
    case 'confirmWinners':
      r = R.confirmWinners(room, player.id, msg.seq);
      if (r.ok) event = { kind: 'payout', payouts: r.payouts };
      break;
    case 'nextHand':
      r = R.nextHand(room, player.id);
      if (r.ok) event = { kind: 'newHand' };
      break;
    case 'pause':
      r = R.setPaused(room, player.id, !!msg.value);
      break;
    case 'setRole':
      r = R.setRole(room, player.id, msg.playerId, msg.role);
      break;
    case 'bumpLevel':
      r = R.bumpLevel(room, player.id);
      break;
    case 'settings':
      r = R.updateSettings(room, player.id, msg.settings);
      break;
    case 'undo':
      // Whoever runs the table can undo — the dealer makes the payout calls.
      if (!R.canRunTable(room, player.id)) r = { error: 'NOT_HOST' };
      else {
        r = R.undo(room);
        if (r.ok) event = { kind: 'undo', label: r.label };
      }
      break;
    case 'adjustStack':
      r = R.adjustStack(room, player.id, msg.playerId, msg.delta);
      break;
    case 'kick':
      r = R.kickPlayer(room, player.id, msg.playerId);
      if (r.ok) {
        for (const other of socketsOf(room.code)) {
          if (sessions.get(other)?.playerId === msg.playerId) {
            send(other, { t: 'kicked', reason: 'REMOVED_BY_HOST' });
            sessions.delete(other);
            socketsOf(room.code).delete(other);
            other.close();
          }
        }
      }
      break;
    case 'transferHost':
      r = R.transferHost(room, player.id, msg.playerId);
      break;
    case 'forceFold':
      r = R.forceFold(room, player.id, msg.playerId);
      break;
    case 'endGame':
      r = R.endGame(room, player.id);
      if (r.ok) event = { kind: 'gameOver' };
      break;
    default:
      return;
  }

  if (r && r.error) {
    fail(ws, r.error);
    // A rejected action must still resync the client that tried it.
    return send(ws, { t: 'state', state: R.publicState(room, player.id) });
  }
  broadcast(room, event);
}

/* ------------------------------------------------------------- background */

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  for (const room of R.rooms.values()) {
    if (R.maybeAutoTransferHost(room)) broadcast(room);
  }
}, 20_000);
heartbeat.unref();

const housekeeping = setInterval(() => {
  R.sweep();
  R.persist();
}, 10_000);
housekeeping.unref();

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(housekeeping);
});

/**
 * The address other phones can actually reach. A host who opened the app on
 * the same machine sees "localhost", which is useless in a QR code, so the
 * server volunteers the LAN address it is listening on.
 */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

export { server, wss };

const LAN_URL = `http://${lanAddress()}:${PORT}`;

R.restore();
server.listen(PORT, '0.0.0.0', () => {
  const lan = lanAddress();
  console.log('');
  console.log('  CHIP TABLE — виртуальные фишки для живого покера');
  console.log('  ------------------------------------------------');
  console.log(`  Этот компьютер : http://localhost:${PORT}`);
  console.log(`  Телефоны в сети: http://${lan}:${PORT}`);
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    R.persist();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
