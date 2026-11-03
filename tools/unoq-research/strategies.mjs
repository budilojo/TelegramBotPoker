// Research only. No imports from the application to these files.
import { decideColors } from '../../bot/games/colors/bot.js';
import { COLORS, isWild, colorOf, signOf } from '../../bot/games/colors/cards.js';

export const VERSION = 'unoq-research-1';
export const MODELS = ['simple', 'baseline', 'adaptive'];
export const LINEUPS = ['A', 'B', 'C', 'mix', 'control'];
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function agent(type, seed) {
  return { type, random: rng(seed), spec: { level: 1 }, memory: { n: 0, color: null, voids: {}, preference: {} } };
}

// Receives EVERY own view, including observations between turns. No room/spec of others.
export function observe(a, v) {
  if (a.type !== 'adaptive') return;
  const m = a.memory;
  for (const e of v.deal.events) {
    if (e.n <= m.n) continue;
    if (['draw', 'take', 'forced', 'caught'].includes(e.kind)) {
      const seat = e.kind === 'caught' ? e.targetSeat : e.seat;
      const prev = m.voids[seat] || {};
      for (const c of Object.keys(prev)) prev[c] *= 0.5;
      if (e.kind === 'draw' && m.color) prev[m.color] = 0.75; // evidence, NOT certainty about new card
      else for (const c of Object.keys(prev)) prev[c] *= 0.3;
      m.voids[seat] = prev;
    }
    if (e.color) {
      if (['play', 'out'].includes(e.kind)) {
        const pref = m.preference[e.seat] ||= {};
        pref[e.color] = (pref[e.color] || 0) + 1;
        if (m.voids[e.seat]) m.voids[e.seat][e.color] = 0;
      }
      m.color = e.color;
    }
    m.n = e.n;
  }
  m.color = v.deal.color;
}

function neighbors(v) {
  const ring = v.players.filter(p => p.inDeal && !['out', 'quit'].includes(p.role));
  const i = ring.findIndex(p => p.isMe), n = ring.length, d = v.deal.dir;
  return [ring[(i + d + n) % n], ring[(i - d + n) % n], n];
}

// Independent baseline: one-step remaining-hand connectivity, no production scoring/memory.
function baseline(v, r) {
  const l = v.legal;
  if (!l.play.length) return { t: l.pass ? 'pass' : 'draw', seq: v.seq };
  const candidates = [];
  for (const card of l.play) {
    const hand = [...v.me.cards]; hand.splice(hand.indexOf(card), 1);
    for (const color of isWild(card) ? COLORS : [colorOf(card)]) {
      const connected = hand.filter(c => isWild(c) || colorOf(c) === color || (!isWild(card) && signOf(c) === signOf(card))).length;
      const flexible = hand.filter(isWild).length;
      candidates.push({ card, color, score: connected + flexible * 1.2 + r() * 0.01 });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const c = candidates[0];
  return { t: 'play', card: c.card, ...(isWild(c.card) ? { color: c.color } : {}), seq: v.seq };
}

function styled(a, v) {
  const l = v.legal, hand = v.me.cards, [next, prev, n] = neighbors(v);
  if (!l.play.length) return { t: l.pass ? 'pass' : 'draw', seq: v.seq };
  const adaptive = a.type === 'adaptive', attack = a.type === 'B';
  const candidates = [];
  for (const card of l.play) {
    const rest = [...hand]; rest.splice(rest.indexOf(card), 1);
    for (const color of isWild(card) ? COLORS : [colorOf(card)]) {
      const count = rest.filter(c => colorOf(c) === color).length;
      const sign = signOf(card), reverse = sign === 'V' && n > 2;
      const target = reverse ? prev : next;
      const offensive = ['S', 'P', 'WF'].includes(sign) || (sign === 'V' && n <= 2);
      let score = count * (attack ? 1.4 : 2.5);
      score += isWild(card) ? (rest.length <= 1 ? 8 : attack ? -3 : -14) : 1;
      if (offensive) score += (attack ? 5 : 0.5) + (next?.count <= 2 ? 19 : 0);
      if (reverse) score += (next?.count <= 2 ? 10 : 0) - (prev?.count <= 2 ? 12 : 0);
      if (a.type === 'C' && rest.length <= 3) {
        score += rest.filter(c => isWild(c) || colorOf(c) === color || signOf(c) === sign).length * 3;
      }
      if (adaptive && target) {
        const voidWeight = a.memory.voids[target.seat]?.[color] || 0;
        const pref = a.memory.preference[target.seat] || {};
        const total = Object.values(pref).reduce((s, x) => s + x, 0);
        // Exploit only public tendencies: starve observed colors, redirect threat,
        // pressure predictable wild-hoarding before the opponent can finish.
        score += voidWeight * 10 - (total ? (pref[color] || 0) / total * 4 : 0);
        if (offensive && next?.count <= 4) score += 9;
        if (card === 'WF' && next?.count <= 3) score += 18;
      }
      candidates.push({ card, color, score: score + a.random() * 0.02 });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  const c = candidates[0];
  return { t: 'play', card: c.card, ...(isWild(c.card) ? { color: c.color } : {}), seq: v.seq };
}

export function decide(a, v, kind = 'turn') {
  if (kind === 'shout') return v.legal.shout ? { t: 'shout' } : null;
  if (kind === 'catch') return v.legal.catch ? { t: 'catch' } : null;
  if (!v.legal.myTurn) return null;
  if (a.type === 'A') return decideColors(v, a.spec, { kind: v.deal.pending ? 'pending' : 'turn' }, a.random);
  if (a.type === 'baseline') return baseline(v, a.random);
  if (a.type === 'simple') {
    const card = v.legal.play[0];
    return card ? { t: 'play', card, ...(isWild(card) ? { color: 'R' } : {}), seq: v.seq }
      : { t: v.legal.pass ? 'pass' : 'draw', seq: v.seq };
  }
  if (['B', 'C', 'adaptive'].includes(a.type)) return styled(a, v);
  throw new Error(`Unknown strategy ${a.type}`);
}
