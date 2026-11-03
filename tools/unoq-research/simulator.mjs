import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import game from '../../bot/games/colors/index.js';
import * as rules from '../../bot/games/colors/rules.js';
import { shuffled } from '../../bot/games/colors/cards.js';
import { points } from '../../bot/rating.js';
import { agent, rng, observe, decide } from './strategies.mjs';

export const LIMIT = 5000;
export const SEATS = 4;
export function seeds(phase, scenario, index) {
  const base = { pilot: 1_000_000, main: 10_000_000, holdout: 100_000_000 }[phase];
  if (!base || scenario < 0 || scenario >= 15 || index < 0 || index >= 10000) throw new Error('Seed range');
  const deal = base + scenario * 20_000 + index;
  return { deal, lineup: (deal ^ 0x34ab98ef) >>> 0,
    decisions: Array.from({ length: SEATS }, (_, i) => (deal ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0) };
}

// Inspect ALL messages each player received, not just the final hand.
export function auditView(v, room, uid) {
  assert.deepEqual([...v.me.cards].sort(), [...room.deal.hands[uid]].sort());
  assert.deepEqual([...v.me.dealt].sort(), [...room.deal.hands[uid]].sort());
  assert.deepEqual(Object.keys(v.players[0]).sort(), [
    'seat','name','hue','avatar','frame','badge','isHost','isMe','seated','inDeal','count','role','turn',
    'alone','called','quiet','place','wins','lasts','games','lastLoser',
  ].sort());
  assert.deepEqual(Object.keys(v.deal).sort(), [
    'no','phase','top','color','dir','deck','discard','turnSeat','pending','pendingKind','drawn','alive','call','events','deadline','result',
  ].sort());
  assert.equal(typeof v.deal.deck, 'number');
  assert.equal(typeof v.deal.discard, 'number');
  // Every card string must occur at an explicitly public or own-hand path.
  const walk = (x, path = '') => {
    if (typeof x === 'string' && /^(?:[RYGB][0-9SVP]|WC|WF)$/.test(x)) {
      assert.match(path, /^(?:me\.(?:cards|dealt)\.\d+|deal\.(?:top|drawn)|deal\.events\.\d+\.card|legal\.play\.\d+)$/);
    } else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) walk(y, path ? `${path}.${k}` : k);
  };
  walk(v);
}

export async function play({ phase = 'pilot', scenario = 0, index = 0, model = 'simple', lineup = 'A',
  maxActions = LIMIT, trace = false, audit = true, onView = null }) {
  const seed = seeds(phase, scenario, index), focalSeat = index % SEATS;
  const deckRng = rng(seed.deal), randInt = n => Math.floor(deckRng() * n);
  const lineRng = rng(seed.lineup);
  let opponents = lineup === 'mix' ? ['A', 'B', 'C'] : Array(3).fill(lineup === 'control' ? 'baseline' : lineup);
  if (lineup === 'mix') for (let i = 2; i > 0; i--) {
    const j = Math.floor(lineRng() * (i + 1)); [opponents[i], opponents[j]] = [opponents[j], opponents[i]];
  }
  const types = [...opponents]; types.splice(focalSeat, 0, model);
  const ids = ['s0', 's1', 's2', 's3'], focal = ids[focalSeat];
  const room = rules.createRoom({ chatId: 'research', code: `r${seed.deal}`, stacking: true,
    turnSeconds: 30, host: { id: ids[0], tgId: 0, name: 'Модель 0' } });
  for (let i = 1; i < SEATS; i++) rules.addPlayer(room, { id: ids[i], tgId: 0, name: `Модель ${i}` });
  const agents = types.map((type, i) => agent(type, seed.decisions[i]));
  let now = 1_800_000_000_000, actions = 0, reactions = 0, views = 0;
  const counts = [0, 0, 0, 0], history = [], hash = createHash('sha256');
  const app = { clock: { now: () => now }, colorsRand: randInt, colorsDeck: () => shuffled(randInt),
    afterAction() {}, afterDeal() {}, afterChange() {}, finishUp() {} };
  const send = async (uid, msg) => {
    let refusal;
    await game.handle({ app, room, uid, msg, session: { user: { id: uid } },
      refuse: (code, message) => { refusal = { code, message }; }, push() {} });
    const row = { uid, msg, refusal: refusal || null };
    hash.update(JSON.stringify(row));
    history.push(row); if (!trace && history.length > 12) history.shift();
    if (refusal) throw new Error(`Rejected: ${JSON.stringify(refusal)}`);
  };
  const result = (status, error = null) => {
    const place = room.deal?.out.indexOf(focal) + 1 || null;
    const completed = status === 'completed';
    const nominal = completed ? points(place - 1, SEATS) : 0;
    return { phase, scenario, index, seed, focalSeat, types, status, error,
      order: completed ? [...room.deal.out] : null, place: completed ? place : null,
      draw: completed && !room.deal.loser, actions, reactions, views, ownActions: counts[focalSeat],
      simulatedSeconds: (now - 1_800_000_000_000) / 1000 + 30,
      ratingActual: 0, nominal, fromZero: Math.max(0, nominal), centered: completed ? nominal - 7 : 0,
      pairwise24: completed ? [12, 4, -4, -12][place - 1] : 0,
      digest: hash.digest('hex'), ...(trace || !completed ? { trace: history } : {}),
      ...(!completed ? { snapshot: rules.serialize(room, now) } : {}) };
  };
  try {
    await send(ids[0], { t: 'start' });
    while (room.deal.phase === 'play' && actions < maxActions) {
      const states = ids.map((id, i) => {
        const v = game.view(room, id, { now });
        if (audit) auditView(v, room, id);
        views++; observe(agents[i], v); onView?.(v, i, agents[i]); return v;
      });
      const shouter = states.findIndex(v => v.legal.shout);
      if (shouter >= 0) {
        now += 400;
        await send(ids[shouter], decide(agents[shouter], states[shouter], 'shout'));
        reactions++; continue;
      }
      const seat = states.findIndex(v => v.legal.myTurn);
      if (seat < 0) throw new Error('No active turn');
      const msg = decide(agents[seat], states[seat]);
      if (!msg) throw new Error('No strategy action');
      now += seat === focalSeat ? 4000 : 1250;
      await send(ids[seat], msg); actions++; counts[seat]++;
    }
    // Audit also all final messages; a leak at the finish is still a leak.
    for (const id of ids) { const v = game.view(room, id, { now }); if (audit) auditView(v, room, id); views++; }
    if (room.deal.phase !== 'over') return result('limit', `Reached ${maxActions} actions`);
    if (room.deal.aborted) return result('aborted', room.deal.abortedWhy);
    assert.equal(new Set(room.deal.out).size, SEATS);
    return result('completed');
  } catch (error) { return result('error', error.stack); }
}
