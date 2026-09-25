'use strict';
/**
 * End-to-end protocol test: four real WebSocket clients play real hands
 * against the real server. Covers joining, betting, side pots, winner
 * selection, undo, reconnect and host powers.
 *
 * Run: node --test server/protocol.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

process.env.PORT = process.env.TEST_PORT || '4399';
process.env.CHIPTABLE_NO_PERSIST = '1';
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const WSURL = `ws://127.0.0.1:${process.env.PORT}/ws`;

const srv = await import('./index.js');
const R = await import('./rooms.js');
await new Promise((r) => setTimeout(r, 250));

/* ------------------------------------------------------------- test client */

class Client {
  constructor(label) {
    this.label = label;
    this.states = [];
    this.errors = [];
    this.toasts = [];
    this.kicked = null;
    this.session = null;
    this.waiters = [];
  }

  async open() {
    this.ws = new WebSocket(WSURL);
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.t === 'session') this.session = msg;
      if (msg.t === 'state') this.states.push(msg.state);
      if (msg.t === 'error') this.errors.push(msg);
      if (msg.t === 'toast') this.toasts.push(msg);
      if (msg.t === 'kicked') this.kicked = msg;
      this.waiters = this.waiters.filter((w) => !w(msg));
    });
    return this;
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  get state() {
    return this.states[this.states.length - 1];
  }

  /** Resolve as soon as a message matching `pred` arrives. */
  until(pred, ms = 2000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.label}: timeout`)), ms);
      const w = (msg) => {
        if (!pred(msg)) return false;
        clearTimeout(t);
        res(msg);
        return true;
      };
      this.waiters.push(w);
    });
  }

  nextState(ms = 2000) {
    return this.until((m) => m.t === 'state', ms).then((m) => m.state);
  }

  close() {
    return new Promise((r) => {
      this.ws.once('close', r);
      this.ws.close();
    });
  }
}

const settle = () => new Promise((r) => setTimeout(r, 90));

async function setupRoom(names = ['Ваня', 'Макс', 'Дима', 'Саша'], opts = {}) {
  const clients = [];
  const host = await new Client(names[0]).open();
  host.send({
    t: 'create',
    name: names[0],
    startingStack: opts.stack ?? 10000,
    smallBlind: opts.sb ?? 50,
    bigBlind: opts.bb ?? 100,
  });
  await host.nextState();
  clients.push(host);
  const code = host.state.code;

  for (const name of names.slice(1)) {
    const c = await new Client(name).open();
    c.send({ t: 'join', code, name });
    await c.nextState();
    clients.push(c);
  }
  await settle();
  return { code, clients, host };
}

const seatOf = (c, name) => c.state.players.find((p) => p.name === name);
const actorName = (c) =>
  c.state.players.find((p) => p.id === c.state.hand?.actorId)?.name;

/** The client whose turn it is right now. */
function onClock(clients) {
  const s = clients[0].state;
  const id = s.hand?.actorId;
  return clients.find((c) => c.session.playerId === id);
}

async function doAct(clients, action, amount) {
  const c = onClock(clients);
  assert.ok(c, 'somebody must be on the clock');
  const before = clients[0].state.seq;
  c.send({ t: 'action', action, amount, seq: c.state.seq });
  await clients[0].until((m) => m.t === 'state' && m.state.seq !== before);
  await settle();
  return c;
}

/* --------------------------------------------------------------- the tests */

test('HTTP: room lookup works before a socket is opened', async () => {
  const { code, clients } = await setupRoom(['Ваня', 'Макс']);
  const res = await fetch(`${BASE}/api/room/${code}`);
  assert.equal(res.status, 200);
  const info = await res.json();
  assert.equal(info.code, code);
  assert.equal(info.players, 2);
  assert.equal(info.hostName, 'Ваня');

  const missing = await fetch(`${BASE}/api/room/ZZZZ`);
  assert.equal(missing.status, 404);
  await Promise.all(clients.map((c) => c.close()));
});

test('lobby: everyone sees every join in real time', async () => {
  const { clients } = await setupRoom();
  for (const c of clients) {
    assert.equal(c.state.players.length, 4);
    assert.deepEqual(
      c.state.players.map((p) => p.name),
      ['Ваня', 'Макс', 'Дима', 'Саша']
    );
    assert.equal(c.state.status, 'lobby');
  }
  assert.equal(clients[0].state.hostId, clients[0].session.playerId);
  await Promise.all(clients.map((c) => c.close()));
});

test('only the host can start the game', async () => {
  const { clients, host } = await setupRoom();
  clients[1].send({ t: 'start' });
  await clients[1].until((m) => m.t === 'error');
  assert.equal(clients[1].errors.at(-1).code, 'NOT_HOST');
  assert.equal(clients[1].state.status, 'lobby');

  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();
  for (const c of clients) {
    assert.equal(c.state.status, 'playing');
    assert.equal(c.state.hand.no, 1);
  }
  await Promise.all(clients.map((c) => c.close()));
});

test('a full hand plays out and the winner is paid', async () => {
  const { clients, host } = await setupRoom();
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  const s = clients[0].state;
  assert.equal(s.pot, 150, 'blinds are in the pot');
  assert.equal(actorName(clients[0]), 'Саша', 'UTG acts first');

  await doAct(clients, 'raise', 500);
  assert.equal(clients[0].state.pot, 650);
  await doAct(clients, 'call'); // Ваня
  await doAct(clients, 'fold'); // Макс (sb)
  await doAct(clients, 'call'); // Дима (bb)
  assert.equal(clients[0].state.hand.street, 'flop');
  assert.equal(clients[0].state.pot, 1550);

  // Check it down to showdown.
  let guard = 0;
  while (clients[0].state.hand.phase === 'betting' && guard++ < 20) {
    await doAct(clients, 'check');
  }
  const hand = clients[0].state.hand;
  assert.equal(hand.phase, 'showdown');
  assert.equal(hand.pots.length, 1);
  assert.equal(hand.pots[0].amount, 1550);
  assert.equal(hand.pots[0].eligible.length, 3);

  // Any player may tick the winner; everyone sees it.
  const dima = clients[2];
  const winnerId = seatOf(dima, 'Дима').id;
  dima.send({ t: 'selectWinners', potIndex: 0, winners: [winnerId] });
  await dima.nextState();
  await settle();
  assert.deepEqual(clients[1].state.hand.pots[0].winners, [winnerId]);

  dima.send({ t: 'confirmWinners', seq: dima.state.seq });
  await dima.until((m) => m.t === 'state' && m.state.hand.phase === 'complete');
  await settle();

  assert.equal(seatOf(clients[0], 'Дима').stack, 10000 - 500 + 1550);
  assert.equal(
    clients[0].state.players.reduce((a, p) => a + p.stack, 0),
    40000,
    'chips are conserved across the whole table'
  );
  assert.equal(clients[0].state.history[0].no, 1);
  await Promise.all(clients.map((c) => c.close()));
});

test('server rejects an illegal action and the client stays in sync', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс']);
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  const waiting = clients.find((c) => c.session.playerId !== clients[0].state.hand.actorId);
  const seqBefore = waiting.state.seq;
  waiting.send({ t: 'action', action: 'fold', seq: waiting.state.seq });
  await waiting.until((m) => m.t === 'error');
  assert.equal(waiting.errors.at(-1).code, 'NOT_YOUR_TURN');
  await settle();
  assert.equal(waiting.state.seq, seqBefore, 'a rejected action changes nothing');

  const actor = onClock(clients);
  actor.send({ t: 'action', action: 'check', seq: actor.state.seq });
  await actor.until((m) => m.t === 'error');
  assert.equal(actor.errors.at(-1).code, 'CANNOT_CHECK', 'cannot check facing the big blind');
  await Promise.all(clients.map((c) => c.close()));
});

test('a stale seq (double tap) is dropped instead of acting twice', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима']);
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  const actor = onClock(clients);
  const seq = actor.state.seq;
  // Two identical taps race to the server; the second carries a stale seq.
  actor.send({ t: 'action', action: 'call', seq });
  actor.send({ t: 'action', action: 'call', seq });
  await settle();
  await settle();

  assert.ok(
    actor.errors.some((e) => e.code === 'STALE'),
    'the duplicate is rejected as stale'
  );
  const me = actor.state.players.find((p) => p.id === actor.session.playerId);
  assert.equal(me.bet, 100, 'exactly one call was applied');
  await Promise.all(clients.map((c) => c.close()));
});

test('side pots: short stack all-in creates a separate pot', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима'], { stack: 10000 });
  // Give Дима a short stack before the hand starts.
  host.send({ t: 'adjustStack', playerId: seatOf(host, 'Дима').id, delta: -9400 });
  await host.nextState();
  await settle();
  assert.equal(seatOf(host, 'Дима').stack, 600);

  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  // Everyone shoves; Дима is all-in for less.
  await doAct(clients, 'allin');
  await doAct(clients, 'allin');
  await doAct(clients, 'allin');

  const hand = clients[0].state.hand;
  assert.equal(hand.phase, 'showdown');
  assert.ok(hand.pots.length >= 2, 'a side pot exists');
  assert.equal(hand.pots[0].eligible.length, 3, 'everyone plays for the main pot');
  assert.ok(
    !hand.pots[1].eligible.includes(seatOf(clients[0], 'Дима').id),
    'the short stack is not eligible for the side pot'
  );

  // Дима wins the main pot, Ваня the side pot.
  const dimaId = seatOf(clients[0], 'Дима').id;
  const vanyaId = seatOf(clients[0], 'Ваня').id;
  host.send({ t: 'selectWinners', potIndex: 0, winners: [dimaId] });
  await host.nextState();
  for (let i = 1; i < hand.pots.length; i++) {
    host.send({ t: 'selectWinners', potIndex: i, winners: [vanyaId] });
    await host.nextState();
  }
  host.send({ t: 'confirmWinners', seq: host.state.seq });
  await host.until((m) => m.t === 'state' && m.state.hand.phase === 'complete');
  await settle();

  assert.equal(seatOf(host, 'Дима').stack, 1800, 'main pot = 3 x 600');
  assert.equal(
    clients[0].state.players.reduce((a, p) => a + p.stack, 0),
    20600,
    'chips are conserved'
  );
  await Promise.all(clients.map((c) => c.close()));
});

test('reconnect: refreshing the page restores the exact seat and stack', async () => {
  const { code, clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима']);
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();
  await doAct(clients, 'raise', 400);

  const max = clients[1];
  const saved = { ...max.session };
  const stackBefore = max.state.players.find((p) => p.id === saved.playerId).stack;

  await max.close(); // phone locked / tab closed
  await settle();
  assert.equal(
    host.state.players.find((p) => p.id === saved.playerId).connected,
    false,
    'the table sees them drop'
  );

  const back = await new Client('Макс-again').open();
  back.send({ t: 'resume', code, playerId: saved.playerId, token: saved.token });
  await back.nextState();
  await settle();

  const me = back.state.players.find((p) => p.id === saved.playerId);
  assert.equal(me.stack, stackBefore, 'the stack survived');
  assert.equal(me.connected, true);
  assert.equal(back.state.hand.no, 1, 'still in the same hand');
  assert.equal(back.state.code, code);

  await Promise.all([...clients.filter((c) => c !== max), back].map((c) => c.close()));
});

test('a bad token cannot steal a seat', async () => {
  const { code, clients } = await setupRoom(['Ваня', 'Макс']);
  const thief = await new Client('thief').open();
  thief.send({
    t: 'resume',
    code,
    playerId: clients[1].session.playerId,
    token: 'not-the-real-token',
  });
  await thief.until((m) => m.t === 'error');
  assert.equal(thief.errors.at(-1).code, 'SESSION_INVALID');
  await Promise.all([...clients, thief].map((c) => c.close()));
});

test('rejoining by name reclaims an abandoned seat', async () => {
  const { code, clients, host } = await setupRoom(['Ваня', 'Макс']);
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  const maxId = clients[1].session.playerId;
  await clients[1].close(); // cleared browser data, no token left
  await settle();

  const fresh = await new Client('Макс-new-phone').open();
  fresh.send({ t: 'join', code, name: 'Макс' });
  await fresh.nextState();
  await settle();

  assert.equal(fresh.session.playerId, maxId, 'same seat, not a new player');
  assert.equal(fresh.state.players.length, 2, 'no duplicate seat was created');
  await Promise.all([host, fresh].map((c) => c.close()));
});

test('undo rewinds the last action for everybody', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима']);
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  const potBefore = clients[0].state.pot;
  const actorBefore = clients[0].state.hand.actorId;
  const actor = await doAct(clients, 'raise', 900);
  assert.equal(clients[0].state.pot, potBefore + 900);

  // A non-host cannot undo.
  const other = clients.find((c) => c !== host);
  other.send({ t: 'undo' });
  await other.until((m) => m.t === 'error');
  assert.equal(other.errors.at(-1).code, 'NOT_HOST');

  host.send({ t: 'undo' });
  await host.until((m) => m.t === 'state' && m.state.pot === potBefore);
  await settle();

  assert.equal(clients[0].state.pot, potBefore, 'the pot is restored');
  assert.equal(clients[0].state.hand.actorId, actorBefore, 'the clock moves back');
  const who = clients[0].state.players.find((p) => p.id === actor.session.playerId);
  assert.equal(who.bet, who.id === clients[0].state.hand.bbId ? 100 : who.bet, 'bets rolled back');
  assert.equal(
    clients[0].state.players.reduce((a, p) => a + p.stack, 0) + clients[0].state.pot,
    30000
  );
  await Promise.all(clients.map((c) => c.close()));
});

test('pause blocks actions until the host resumes', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс']);
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  host.send({ t: 'pause', value: true });
  await host.until((m) => m.t === 'state' && m.state.status === 'paused');
  await settle();

  const actor = onClock(clients);
  actor.send({ t: 'action', action: 'call', seq: actor.state.seq });
  await actor.until((m) => m.t === 'error');
  assert.equal(actor.errors.at(-1).code, 'GAME_PAUSED');

  host.send({ t: 'pause', value: false });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();
  await doAct(clients, 'call');
  assert.ok(clients[0].state.pot >= 200);
  await Promise.all(clients.map((c) => c.close()));
});

test('host powers: kick, transfer, and manual stack correction', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима']);

  host.send({ t: 'adjustStack', playerId: seatOf(host, 'Макс').id, delta: 2500 });
  await host.nextState();
  await settle();
  assert.equal(seatOf(host, 'Макс').stack, 12500);
  // A top-up must not read as profit at the end of the night.
  assert.equal(seatOf(host, 'Макс').stats.buyIn, 12500);

  host.send({ t: 'transferHost', playerId: seatOf(host, 'Дима').id });
  await host.until((m) => m.t === 'state' && m.state.hostId === seatOf(host, 'Дима').id);
  await settle();
  assert.equal(clients[2].state.hostId, clients[2].session.playerId);

  // Ваня is no longer host and loses the powers.
  host.send({ t: 'kick', playerId: seatOf(host, 'Макс').id });
  await host.until((m) => m.t === 'error');
  assert.equal(host.errors.at(-1).code, 'NOT_HOST');

  clients[2].send({ t: 'kick', playerId: seatOf(clients[2], 'Макс').id });
  await clients[1].until((m) => m.t === 'kicked');
  await settle();
  assert.equal(clients[2].state.players.length, 2);
  await Promise.all([host, clients[2]].map((c) => c.close()));
});

test('joining mid-game waits for the next hand, then is dealt in', async () => {
  const { code, clients, host } = await setupRoom(['Ваня', 'Макс']);
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  const late = await new Client('Саша').open();
  late.send({ t: 'join', code, name: 'Саша' });
  await late.nextState();
  await settle();

  const seat = seatOf(host, 'Саша');
  assert.equal(seat.waiting, true, 'flagged as waiting');
  assert.equal(seat.inHand, false, 'not dealt into the running hand');
  assert.equal(seat.stack, 10000);

  // Finish the hand: heads-up, button folds.
  await doAct(clients, 'fold');
  await settle();
  assert.equal(host.state.hand.phase, 'complete');

  host.send({ t: 'nextHand' });
  await host.until((m) => m.t === 'state' && m.state.hand.no === 2);
  await settle();
  assert.equal(seatOf(host, 'Саша').inHand, true, 'dealt into the next hand');
  assert.equal(seatOf(host, 'Саша').waiting, false);
  await Promise.all([...clients, late].map((c) => c.close()));
});

test('game over: the last player with chips ends the game', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс'], { stack: 300, sb: 50, bb: 100 });
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  await doAct(clients, 'allin');
  await doAct(clients, 'call');
  await settle();

  const hand = clients[0].state.hand;
  assert.equal(hand.phase, 'showdown');
  const winner = hand.pots[0].eligible[0];
  host.send({ t: 'selectWinners', potIndex: 0, winners: [winner] });
  await host.nextState();
  host.send({ t: 'confirmWinners', seq: host.state.seq });
  await host.until((m) => m.t === 'state' && m.state.status === 'finished');
  await settle();

  const res = clients[0].state.results;
  assert.ok(Array.isArray(res) && res.length === 2);
  assert.equal(res[0].stack, 600);
  assert.equal(res[0].net, 300);
  assert.equal(res[1].stack, 0);
  assert.equal(res[1].net, -300);
  await Promise.all(clients.map((c) => c.close()));
});

test('host can end the game early and unfinished bets are returned', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима']);
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();
  await doAct(clients, 'raise', 1200);

  host.send({ t: 'endGame' });
  await host.until((m) => m.t === 'state' && m.state.status === 'finished');
  await settle();

  assert.equal(clients[0].state.pot, 0, 'nothing is stranded in the pot');
  for (const p of clients[0].state.results) {
    assert.equal(p.stack, 10000, 'every stack is back to where it started');
    assert.equal(p.net, 0);
  }
  await Promise.all(clients.map((c) => c.close()));
});

test('a second tab for the same player takes over cleanly', async () => {
  const { code, clients } = await setupRoom(['Ваня', 'Макс']);
  const first = clients[1];
  const second = await new Client('Макс-tab2').open();
  second.send({
    t: 'resume',
    code,
    playerId: first.session.playerId,
    token: first.session.token,
  });
  await first.until((m) => m.t === 'kicked');
  assert.equal(first.kicked.reason, 'DUPLICATE_SESSION');
  await settle();
  assert.equal(
    second.state.players.find((p) => p.id === first.session.playerId).connected,
    true,
    'the player still counts as present'
  );
  await Promise.all([clients[0], second].map((c) => c.close()));
});


/* ------------------------------------------------------------------ roles */

test('roles: host assigns a dealer and everybody sees it immediately', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима']);
  const dimaId = seatOf(host, 'Дима').id;

  host.send({ t: 'setRole', playerId: dimaId, role: 'dealer' });
  await host.until((m) => m.t === 'state' && m.state.dealerRoleId === dimaId);
  await settle();

  for (const c of clients) {
    assert.equal(c.state.players.find((p) => p.id === dimaId).role, 'dealer');
    assert.equal(c.state.dealerRoleId, dimaId);
    assert.equal(c.state.hasDealer, true);
  }
  // The role is separate from the host permission.
  assert.equal(seatOf(host, 'Дима').isHost, false);
  assert.equal(seatOf(host, 'Ваня').isHost, true);
  assert.equal(seatOf(host, 'Ваня').role, 'player');
  await Promise.all(clients.map((c) => c.close()));
});

test('roles: only the host may assign them', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима']);
  clients[1].send({ t: 'setRole', playerId: seatOf(host, 'Дима').id, role: 'dealer' });
  await clients[1].until((m) => m.t === 'error');
  assert.equal(clients[1].errors.at(-1).code, 'NOT_HOST');
  assert.equal(clients[1].state.hasDealer, false);
  await Promise.all(clients.map((c) => c.close()));
});

test('roles: a dealer is never dealt into a hand', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима']);
  const dimaId = seatOf(host, 'Дима').id;
  host.send({ t: 'setRole', playerId: dimaId, role: 'dealer' });
  await host.nextState();
  await settle();

  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  const dima = seatOf(host, 'Дима');
  assert.equal(dima.inHand, false, 'not in the hand');
  assert.equal(dima.stack, 10000, 'never posts a blind');
  assert.equal(host.state.pot, 150, 'only the two players post blinds');
  assert.equal(
    host.state.players.filter((p) => p.inHand).length,
    2,
    'heads-up between the two remaining players'
  );
  await Promise.all(clients.map((c) => c.close()));
});

test('roles: the dealer decides the winner, a player cannot', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима']);
  const dima = clients[2];
  host.send({ t: 'setRole', playerId: dima.session.playerId, role: 'dealer' });
  await host.nextState();
  await settle();

  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  // Heads-up: play it down to a showdown.
  let guard = 0;
  while (clients[0].state.hand.phase === 'betting' && guard++ < 20) {
    const legal = onClock(clients).state.legal;
    await doAct(clients, legal.canCheck ? 'check' : 'call');
  }
  assert.equal(clients[0].state.hand.phase, 'showdown');

  // Макс is a plain player — no say in the payout.
  const winnerId = clients[1].session.playerId;
  clients[1].send({ t: 'selectWinners', potIndex: 0, winners: [winnerId] });
  await clients[1].until((m) => m.t === 'error');
  assert.equal(clients[1].errors.at(-1).code, 'DEALER_DECIDES');
  assert.deepEqual(clients[0].state.hand.pots[0].winners, []);

  // The dealer can.
  const potTotal = clients[0].state.pot;
  const stackBefore = clients[0].state.players.find((p) => p.id === winnerId).stack;
  dima.send({ t: 'selectWinners', potIndex: 0, winners: [winnerId] });
  await dima.nextState();
  await settle();
  assert.deepEqual(clients[0].state.hand.pots[0].winners, [winnerId]);

  dima.send({ t: 'confirmWinners', seq: dima.state.seq });
  await dima.until((m) => m.t === 'state' && m.state.hand.phase === 'complete');
  await settle();
  assert.equal(seatOf(host, 'Макс').stack, stackBefore + potTotal);
  await Promise.all(clients.map((c) => c.close()));
});

test('roles: without a dealer the table still decides together', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс']);
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();
  assert.equal(host.state.hasDealer, false);
  assert.equal(host.state.canDecideWinner, true);
  assert.equal(clients[1].state.canDecideWinner, true);
  await Promise.all(clients.map((c) => c.close()));
});

test('roles: a swap mid-hand waits for the next hand', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима']);
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  const maxId = seatOf(host, 'Макс').id;
  host.send({ t: 'setRole', playerId: maxId, role: 'dealer' });
  await host.nextState();
  await settle();

  assert.equal(seatOf(host, 'Макс').role, 'player', 'still playing this hand');
  assert.equal(seatOf(host, 'Макс').pendingRole, 'dealer', 'but queued');
  assert.equal(seatOf(host, 'Макс').inHand, true);

  // Finish the hand, then deal the next one.
  let guard = 0;
  while (host.state.hand.phase === 'betting' && guard++ < 30) {
    const legal = onClock(clients).state.legal;
    await doAct(clients, legal.canCheck ? 'check' : 'fold');
  }
  if (host.state.hand.phase === 'showdown') {
    host.send({ t: 'selectWinners', potIndex: 0, winners: [host.state.hand.pots[0].eligible[0]] });
    await host.nextState();
    host.send({ t: 'confirmWinners', seq: host.state.seq });
    await host.until((m) => m.t === 'state' && m.state.hand.phase === 'complete');
  }
  await settle();

  host.send({ t: 'nextHand' });
  await host.until((m) => m.t === 'state' && m.state.hand.no === 2);
  await settle();

  assert.equal(seatOf(host, 'Макс').role, 'dealer', 'applied between hands');
  assert.equal(seatOf(host, 'Макс').pendingRole, null);
  assert.equal(seatOf(host, 'Макс').inHand, false);
  await Promise.all(clients.map((c) => c.close()));
});

test('roles: a dealer turned back into a player rejoins next hand', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима']);
  const dimaId = seatOf(host, 'Дима').id;
  host.send({ t: 'setRole', playerId: dimaId, role: 'dealer' });
  await host.nextState();
  await settle();
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();
  assert.equal(seatOf(host, 'Дима').inHand, false);

  // Dealer holds no chips in the hand, so the swap can land right away.
  host.send({ t: 'setRole', playerId: dimaId, role: 'player' });
  await host.nextState();
  await settle();
  assert.equal(seatOf(host, 'Дима').role, 'player');
  assert.equal(seatOf(host, 'Дима').waiting, true, 'joins from the next hand');
  await Promise.all(clients.map((c) => c.close()));
});

test('settings: host edits stacks and blinds in the lobby', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс']);
  host.send({ t: 'settings', settings: { startingStack: 5000, smallBlind: 25, bigBlind: 50 } });
  await host.nextState();
  await settle();

  assert.equal(host.state.settings.startingStack, 5000);
  assert.equal(host.state.settings.smallBlind, 25);
  assert.equal(host.state.settings.bigBlind, 50);
  for (const c of clients) {
    for (const p of c.state.players) {
      assert.equal(p.stack, 5000, 'stacks are re-dealt before the game starts');
      assert.equal(p.stats.buyIn, 5000, 'and so is the buy-in, so P/L stays honest');
    }
  }

  // A non-host cannot.
  clients[1].send({ t: 'settings', settings: { bigBlind: 999 } });
  await clients[1].until((m) => m.t === 'error');
  assert.equal(clients[1].errors.at(-1).code, 'NOT_HOST');
  await Promise.all(clients.map((c) => c.close()));
});

test('settings: a blind change mid-hand waits for the next deal', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс']);
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  host.send({ t: 'settings', settings: { startingStack: 999, smallBlind: 100, bigBlind: 200 } });
  await host.nextState();
  await settle();

  // The hand in progress keeps the price it was dealt at, otherwise the
  // minimum raise would move under the players on the turn and river.
  assert.equal(host.state.settings.smallBlind, 50, 'this hand is untouched');
  assert.equal(host.state.settings.bigBlind, 100);
  assert.deepEqual(host.state.blinds.pending, { sb: 100, bb: 200 }, 'queued instead');
  assert.equal(host.state.settings.startingStack, 10000, 'starting stack is frozen');
  assert.equal(
    host.state.players.reduce((a, p) => a + p.stack, 0) + host.state.pot,
    20000,
    'nobody gained or lost chips from a settings change'
  );

  // Finish the hand and deal the next one: now they land.
  await doAct(clients, 'fold');
  await settle();
  host.send({ t: 'nextHand' });
  await host.until((m) => m.t === 'state' && m.state.hand.no === 2);
  await settle();

  assert.equal(host.state.settings.smallBlind, 100, 'applied at the next deal');
  assert.equal(host.state.settings.bigBlind, 200);
  assert.equal(host.state.blinds.pending, null);
  assert.equal(host.state.pot, 300, 'the new blinds are what got posted');
  await Promise.all(clients.map((c) => c.close()));
});

test('roles: the dealer can undo a payout', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима']);
  const dima = clients[2];
  host.send({ t: 'setRole', playerId: dima.session.playerId, role: 'dealer' });
  await host.nextState();
  await settle();
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  let guard = 0;
  while (clients[0].state.hand.phase === 'betting' && guard++ < 20) {
    const legal = onClock(clients).state.legal;
    await doAct(clients, legal.canCheck ? 'check' : 'call');
  }
  const potBefore = clients[0].state.pot;
  const winnerId = clients[1].session.playerId;
  const stackBefore = clients[0].state.players.find((p) => p.id === winnerId).stack;

  dima.send({ t: 'selectWinners', potIndex: 0, winners: [winnerId] });
  await dima.nextState();
  dima.send({ t: 'confirmWinners', seq: dima.state.seq });
  await dima.until((m) => m.t === 'state' && m.state.hand.phase === 'complete');
  await settle();
  assert.equal(
    clients[0].state.players.find((p) => p.id === winnerId).stack,
    stackBefore + potBefore
  );

  dima.send({ t: 'undo' });
  await dima.until((m) => m.t === 'state' && m.state.hand.phase === 'showdown');
  await settle();
  assert.equal(
    clients[0].state.players.find((p) => p.id === winnerId).stack,
    stackBefore,
    'the payout was rolled back for everyone'
  );
  await Promise.all(clients.map((c) => c.close()));
});


test('roles: a table left short is recoverable, not thrown away', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима']);
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  // Play the hand out so roles can be applied between hands.
  let guard = 0;
  while (host.state.hand.phase === 'betting' && guard++ < 30) {
    const legal = onClock(clients).state.legal;
    await doAct(clients, legal.canCheck ? 'check' : 'fold');
  }
  if (host.state.hand.phase === 'showdown') {
    host.send({ t: 'selectWinners', potIndex: 0, winners: [host.state.hand.pots[0].eligible[0]] });
    await host.nextState();
    host.send({ t: 'confirmWinners', seq: host.state.seq });
    await host.until((m) => m.t === 'state' && m.state.hand.phase === 'complete');
  }
  await settle();

  // One dealer plus one player stepping away leaves a single seat filled.
  host.send({ t: 'setRole', playerId: seatOf(host, 'Макс').id, role: 'dealer' });
  await host.nextState();
  await settle();
  clients[2].send({ t: 'sitOut', value: true });
  await clients[2].nextState();
  await settle();

  host.send({ t: 'nextHand' });
  await host.until((m) => m.t === 'error');
  assert.equal(host.errors.at(-1).code, 'NOT_ENOUGH_PLAYERS');
  assert.notEqual(host.state.status, 'finished', 'a fixable setup does not end the game');
  assert.equal(seatOf(host, 'Макс').role, 'dealer', 'the role change still went through');

  // Coming back to the table fixes it.
  clients[2].send({ t: 'sitOut', value: false });
  await clients[2].nextState();
  await settle();
  host.send({ t: 'nextHand' });
  await host.until((m) => m.t === 'state' && m.state.hand.no === 2);
  await settle();
  assert.equal(host.state.status, 'playing');
  assert.equal(seatOf(host, 'Макс').inHand, false, 'the dealer sits out the hand');
  await Promise.all(clients.map((c) => c.close()));
});

test('roles: leaving only one player really does end the game', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс']);
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();
  await doAct(clients, 'fold');
  await settle();

  host.send({ t: 'setRole', playerId: seatOf(host, 'Макс').id, role: 'dealer' });
  await host.nextState();
  await settle();

  host.send({ t: 'nextHand' });
  await host.until((m) => m.t === 'state' && m.state.status === 'finished');
  await settle();
  assert.ok(Array.isArray(host.state.results));
  await Promise.all(clients.map((c) => c.close()));
});

test('roles: naming a new dealer hands the role over instead of cloning it', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима', 'Саша']);
  const dimaId = seatOf(host, 'Дима').id;
  const sashaId = seatOf(host, 'Саша').id;

  host.send({ t: 'setRole', playerId: dimaId, role: 'dealer' });
  await host.until((m) => m.t === 'state' && m.state.dealerRoleId === dimaId);
  await settle();

  // "Назначить другого дилера" moves the role — it never seats a second one.
  host.send({ t: 'setRole', playerId: sashaId, role: 'dealer' });
  await host.until((m) => m.t === 'state' && m.state.dealerRoleId === sashaId);
  await settle();

  for (const c of clients) {
    const dealers = c.state.players.filter((p) => p.role === 'dealer');
    assert.equal(dealers.length, 1, 'exactly one dealer at the table');
    assert.equal(dealers[0].id, sashaId);
    // Everybody must name the *new* dealer, not the one who handed it over.
    assert.equal(c.state.dealerRoleId, sashaId);
    assert.equal(c.state.players.find((p) => p.id === dimaId).role, 'player');
  }

  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();
  assert.equal(seatOf(host, 'Дима').inHand, true, 'the old dealer is back on the felt');
  assert.equal(seatOf(host, 'Саша').inHand, false, 'the new dealer does not take a seat');
  await Promise.all(clients.map((c) => c.close()));
});

test('roles: a handover queued mid-hand replaces the one already queued', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима', 'Саша']);
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  const maxId = seatOf(host, 'Макс').id;
  const dimaId = seatOf(host, 'Дима').id;

  host.send({ t: 'setRole', playerId: maxId, role: 'dealer' });
  await host.nextState();
  await settle();
  assert.equal(seatOf(host, 'Макс').pendingRole, 'dealer', 'queued, not applied mid-hand');

  // The host changes their mind before the hand is over.
  host.send({ t: 'setRole', playerId: dimaId, role: 'dealer' });
  await host.nextState();
  await settle();
  assert.equal(seatOf(host, 'Макс').pendingRole, null, 'the first promotion is dropped');
  assert.equal(seatOf(host, 'Дима').pendingRole, 'dealer');

  let guard = 0;
  while (host.state.hand.phase === 'betting' && guard++ < 30) {
    const legal = onClock(clients).state.legal;
    await doAct(clients, legal.canCheck ? 'check' : 'fold');
  }
  if (host.state.hand.phase === 'showdown') {
    host.send({ t: 'selectWinners', potIndex: 0, winners: [host.state.hand.pots[0].eligible[0]] });
    await host.nextState();
    host.send({ t: 'confirmWinners', seq: host.state.seq });
    await host.until((m) => m.t === 'state' && m.state.hand.phase === 'complete');
  }
  await settle();

  host.send({ t: 'nextHand' });
  await host.until((m) => m.t === 'state' && m.state.hand.no === 2);
  await settle();

  const dealers = host.state.players.filter((p) => p.role === 'dealer');
  assert.equal(dealers.length, 1, 'only one promotion lands');
  assert.equal(dealers[0].id, dimaId);
  assert.equal(seatOf(host, 'Макс').role, 'player', 'the dropped promotion never applied');
  assert.equal(seatOf(host, 'Макс').inHand, true);
  await Promise.all(clients.map((c) => c.close()));
});


test('roles: with a dealer assigned, players cannot start the next hand', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима', 'Саша']);
  const sasha = clients[3];
  host.send({ t: 'setRole', playerId: sasha.session.playerId, role: 'dealer' });
  await host.until((m) => m.t === 'state' && m.state.hasDealer);
  await settle();

  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  // Fold it out so the hand settles without a showdown.
  let guard = 0;
  while (host.state.hand.phase === 'betting' && guard++ < 30) {
    const legal = onClock(clients).state.legal;
    await doAct(clients, legal.canCheck ? 'check' : 'fold');
  }
  if (host.state.hand.phase === 'showdown') {
    sasha.send({ t: 'selectWinners', potIndex: 0, winners: [host.state.hand.pots[0].eligible[0]] });
    await sasha.nextState();
    sasha.send({ t: 'confirmWinners', seq: sasha.state.seq });
    await sasha.until((m) => m.t === 'state' && m.state.hand.phase === 'complete');
  }
  await settle();
  const handNo = host.state.hand.no;

  // A plain player must not post blinds while the dealer is still shuffling.
  clients[1].send({ t: 'nextHand' });
  await clients[1].until((m) => m.t === 'error');
  assert.equal(clients[1].errors.at(-1).code, 'DEALER_DEALS');
  assert.equal(host.state.hand.no, handNo, 'nothing was dealt');

  // The dealer can.
  sasha.send({ t: 'nextHand' });
  await sasha.until((m) => m.t === 'state' && m.state.hand.no === handNo + 1);
  await settle();
  assert.equal(host.state.status, 'playing');
  await Promise.all(clients.map((c) => c.close()));
});

test('without a dealer the table still advances itself', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс', 'Дима']);
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();
  assert.equal(host.state.hasDealer, false);

  let guard = 0;
  while (host.state.hand.phase === 'betting' && guard++ < 30) {
    const legal = onClock(clients).state.legal;
    await doAct(clients, legal.canCheck ? 'check' : 'fold');
  }
  if (host.state.hand.phase === 'showdown') {
    host.send({ t: 'selectWinners', potIndex: 0, winners: [host.state.hand.pots[0].eligible[0]] });
    await host.nextState();
    host.send({ t: 'confirmWinners', seq: host.state.seq });
    await host.until((m) => m.t === 'state' && m.state.hand.phase === 'complete');
  }
  await settle();

  // Any player may nudge a dealerless table along — unchanged behaviour.
  clients[2].send({ t: 'nextHand' });
  await clients[2].until((m) => m.t === 'state' && m.state.hand.no === 2);
  await settle();
  assert.equal(host.state.status, 'playing');
  await Promise.all(clients.map((c) => c.close()));
});


/* ----------------------------------------------------------- blind levels */

/** Fast-forward the level clock without waiting out a real level. */
function ageLevel(code, ms) {
  const room = R.rooms.get(code);
  room.level.elapsedMs += ms;
}

test('blinds: levels are off by default and the ladder is generated', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс'], { sb: 25, bb: 50 });
  assert.equal(host.state.blinds.mode, 'fixed', 'a fixed game unless asked');

  host.send({ t: 'settings', settings: { blindMode: 'levels', levelMinutes: 20 } });
  await host.until((m) => m.t === 'state' && m.state.blinds.mode === 'levels');
  await settle();

  const b = host.state.blinds;
  assert.equal(b.levelIndex, 0);
  assert.ok(b.levelCount >= 8, 'a ladder long enough for an evening');
  assert.deepEqual(b.next, { sb: 50, bb: 100 }, 'the second level doubles the first');
  assert.equal(b.levelMinutes, 20);
  // The clock does not run in the lobby.
  assert.equal(b.running, false);
  await Promise.all(clients.map((c) => c.close()));
});

test('blinds: a level that runs out raises them at the next deal, not inside one', async () => {
  const { code, clients, host } = await setupRoom(['Ваня', 'Макс'], { sb: 25, bb: 50 });
  host.send({ t: 'settings', settings: { blindMode: 'levels', levelMinutes: 20 } });
  await host.nextState();
  await settle();

  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();
  assert.equal(host.state.blinds.running, true, 'the clock starts with the game');
  assert.equal(host.state.pot, 75, 'first hand is played at 25/50');

  // The level expires while a hand is in progress.
  ageLevel(code, 21 * 60_000);
  assert.equal(host.state.settings.bigBlind, 50, 'the hand in progress is untouched');

  await doAct(clients, 'fold');
  await settle();
  host.send({ t: 'nextHand' });
  await host.until((m) => m.t === 'state' && m.state.hand.no === 2);
  await settle();

  assert.equal(host.state.blinds.levelIndex, 1, 'the ladder stepped');
  assert.equal(host.state.settings.smallBlind, 50);
  assert.equal(host.state.settings.bigBlind, 100);
  assert.equal(host.state.pot, 150, 'the new blinds are the ones posted');
  assert.ok(
    host.state.blinds.remainingMs > 19 * 60_000,
    'the new level gets a full clock'
  );
  await Promise.all(clients.map((c) => c.close()));
});

test('blinds: a long hand steps one level, never two', async () => {
  const { code, clients, host } = await setupRoom(['Ваня', 'Макс'], { sb: 25, bb: 50 });
  host.send({ t: 'settings', settings: { blindMode: 'levels', levelMinutes: 20 } });
  await host.nextState();
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  // Three levels' worth of time passes during one slow hand.
  ageLevel(code, 61 * 60_000);
  await doAct(clients, 'fold');
  await settle();
  host.send({ t: 'nextHand' });
  await host.until((m) => m.t === 'state' && m.state.hand.no === 2);
  await settle();

  assert.equal(host.state.blinds.levelIndex, 1, 'one step, so nobody is ambushed');
  assert.equal(host.state.settings.bigBlind, 100);
  await Promise.all(clients.map((c) => c.close()));
});

test('blinds: pausing the game pauses the level clock', async () => {
  const { code, clients, host } = await setupRoom(['Ваня', 'Макс'], { sb: 25, bb: 50 });
  host.send({ t: 'settings', settings: { blindMode: 'levels', levelMinutes: 20 } });
  await host.nextState();
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  ageLevel(code, 10 * 60_000);
  host.send({ t: 'pause', value: true });
  await host.until((m) => m.t === 'state' && m.state.status === 'paused');
  await settle();
  assert.equal(host.state.blinds.running, false, 'a smoke break does not burn a level');
  const frozen = host.state.blinds.remainingMs;

  await new Promise((r) => setTimeout(r, 250));
  host.send({ t: 'ready', value: true }); // any message to force a fresh snapshot
  await host.nextState();
  await settle();
  assert.equal(
    host.state.blinds.remainingMs,
    frozen,
    'the clock did not move while paused'
  );

  host.send({ t: 'pause', value: false });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();
  assert.equal(host.state.blinds.running, true, 'and picks up where it left off');
  await Promise.all(clients.map((c) => c.close()));
});

test('blinds: the host can raise the level early, players cannot', async () => {
  const { clients, host } = await setupRoom(['Ваня', 'Макс'], { sb: 25, bb: 50 });
  host.send({ t: 'settings', settings: { blindMode: 'levels', levelMinutes: 20 } });
  await host.nextState();
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  clients[1].send({ t: 'bumpLevel' });
  await clients[1].until((m) => m.t === 'error');
  assert.equal(clients[1].errors.at(-1).code, 'NOT_HOST');
  assert.equal(host.state.blinds.levelIndex, 0);

  host.send({ t: 'bumpLevel' });
  await host.until((m) => m.t === 'state' && m.state.blinds.levelIndex === 1);
  await settle();
  assert.deepEqual(host.state.blinds.pending, { sb: 50, bb: 100 }, 'still waits for the deal');
  assert.equal(host.state.settings.bigBlind, 50, 'the current hand keeps its price');
  await Promise.all(clients.map((c) => c.close()));
});

test('blinds: a fixed game refuses to bump and never moves on its own', async () => {
  const { code, clients, host } = await setupRoom(['Ваня', 'Макс'], { sb: 25, bb: 50 });
  host.send({ t: 'start' });
  await host.until((m) => m.t === 'state' && m.state.status === 'playing');
  await settle();

  host.send({ t: 'bumpLevel' });
  await host.until((m) => m.t === 'error');
  assert.equal(host.errors.at(-1).code, 'NOT_LEVELS');

  ageLevel(code, 90 * 60_000);
  await doAct(clients, 'fold');
  await settle();
  host.send({ t: 'nextHand' });
  await host.until((m) => m.t === 'state' && m.state.hand.no === 2);
  await settle();
  assert.equal(host.state.settings.bigBlind, 50, 'fixed means fixed');
  assert.equal(host.state.blinds.mode, 'fixed');
  await Promise.all(clients.map((c) => c.close()));
});

test('teardown: the server shuts down cleanly', async () => {
  for (const ws of srv.wss.clients) ws.terminate();
  srv.wss.close();
  srv.server.closeAllConnections?.();
  await new Promise((r) => srv.server.close(r));
});
