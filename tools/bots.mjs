/**
 * Dev helper: fills a room with bot players so one person can test a table
 * meant for five.
 *
 *   node tools/bots.mjs ABCD                     три бота, победителя выбираете вы
 *   node tools/bots.mjs ABCD --auto              стол играет сам, без вас
 *   node tools/bots.mjs ABCD --auto --wild       + олл-ины, то есть сайд-поты
 *   node tools/bots.mjs ABCD Макс Дима Саша Лёша  свои имена
 *
 * --auto lets the bots settle hands and deal the next one, but only when the
 * server actually allows it. Make yourself DEALER and they stand down — that
 * is exactly the flow you want to test by hand.
 */
import { WebSocket } from 'ws';

const argv = process.argv.slice(2);
const AUTO = argv.includes('--auto');
const WILD = argv.includes('--wild');
const rest = argv.filter((a) => !a.startsWith('--'));
const CODE = (rest[0] || '').toUpperCase();
const NAMES = rest.slice(1).length ? rest.slice(1) : ['Макс', 'Дима', 'Саша'];

if (!CODE) {
  console.error('usage: node tools/bots.mjs <КОД КОМНАТЫ> [--auto] [--wild] [имена...]');
  process.exit(1);
}

const HOST = process.env.HOST_URL || 'ws://127.0.0.1:3000/ws';
const DELAY = Number(process.env.BOT_DELAY ?? 900);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.random() * ms * 0.6;

/** Exactly one bot runs the table; the rest only play their own hands. */
let runner = null;
/** Guards so each hand is settled once and dealt once, whatever arrives. */
const handled = { settled: -1, dealt: -1 };

function bot(name) {
  const ws = new WebSocket(HOST);
  let me = null;
  let busy = false;
  let settling = false;

  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));

  ws.on('open', () => send({ t: 'join', code: CODE, name }));

  ws.on('message', async (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.t === 'session') {
      me = msg.playerId;
      if (!runner) runner = me;
      console.log(`[${name}] сел за стол`);
      return;
    }
    if (msg.t === 'error') {
      // STALE just means another bot got there first — not worth printing.
      if (msg.code !== 'STALE') console.log(`[${name}] ${msg.code}`);
      return;
    }
    if (msg.t !== 'state') return;
    const s = msg.state;

    if (s.status === 'lobby') {
      if (!s.players.find((p) => p.id === me)?.ready) send({ t: 'ready', value: true });
      return;
    }
    if (s.status !== 'playing') return;

    const self = s.players.find((p) => p.id === me);
    if (self?.role === 'dealer') return dealerDuties(s, self);

    // --- betting ---------------------------------------------------------
    if (s.hand?.phase === 'betting' && s.hand.actorId === me && s.legal && !busy) {
      busy = true;
      await wait(jitter(DELAY));
      act(s);
      busy = false;
      return;
    }

    if (AUTO) await settle(s, self);
  });

  function act(s) {
    const L = s.legal;
    let action = 'check';
    let amount;

    if (WILD && (L.canBet || L.canRaise) && Math.random() < 0.12) {
      action = 'allin'; // the only way side pots ever show up on their own
    } else if (!L.canCheck) {
      action = L.toCall > L.stack / 3 ? 'fold' : 'call';
    } else if (L.canBet && Math.random() < (WILD ? 0.4 : 0.25)) {
      action = 'bet';
      amount = Math.min(L.maxTotal, Math.max(L.minTotal, Math.round(L.potTotal / 2)));
    }
    console.log(`[${name}] ${action}${amount ? ' ' + amount : ''}`);
    send({ t: 'action', action, amount, seq: s.seq });
  }

  /** A bot handed the DEALER role still has to run the table. */
  async function dealerDuties(s, self) {
    if (!AUTO || settling) return;
    settling = true;
    await settle(s, self);
    settling = false;
  }

  /** Close the hand out and deal the next one, when the server permits it. */
  async function settle(s, self) {
    // Only the elected bot touches the table, and only once per hand.
    if (me !== runner && self?.role !== 'dealer') return;
    const no = s.hand?.no ?? -1;

    if (s.hand?.phase === 'showdown' && s.canDecideWinner) {
      if (handled.settled === no) return;
      if (s.hand.pots.every((p) => p.winners.length)) return;
      handled.settled = no;
      await wait(jitter(700)); // leave a human first refusal
      for (let i = 0; i < s.hand.pots.length; i++) {
        const pot = s.hand.pots[i];
        if (pot.winners.length) continue;
        const pick = pot.eligible[Math.floor(Math.random() * pot.eligible.length)];
        send({ t: 'selectWinners', potIndex: i, winners: [pick] });
        await wait(120);
      }
      await wait(200);
      console.log(`[${name}] подтверждает победителя`);
      send({ t: 'confirmWinners' });
      return;
    }

    if (s.hand?.phase === 'complete') {
      if (handled.dealt === no) return;
      // Mirrors the server: with a dealer at the table, only they deal.
      const mayDeal = !s.hasDealer || self?.role === 'dealer' || self?.isHost;
      if (!mayDeal) return;
      handled.dealt = no;
      await wait(jitter(1200));
      send({ t: 'nextHand' });
    }
  }

  ws.on('close', () => console.log(`[${name}] отключился`));
  ws.on('error', (e) => console.error(`[${name}]`, e.message));
  return ws;
}

const sockets = NAMES.map(bot);
console.log(
  `Боты в комнате ${CODE}: ${NAMES.join(', ')}` +
    (AUTO ? ' · играют сами' : ' · победителя отмечаете вы') +
    (WILD ? ' · с олл-инами' : '')
);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    sockets.forEach((ws) => ws.close());
    process.exit(0);
  });
}
