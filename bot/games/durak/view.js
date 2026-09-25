'use strict';
/**
 * What ONE person sees at a durak game. A pure function `(room, viewer) ->
 * state` that the server sends to that person's Mini App and to nobody else.
 *
 * "Nobody sees somebody else's cards" is enforced here, by leaving out:
 *
 *   - your cards — to you, and only to you;
 *   - everybody else's hand — as a NUMBER of cards, never the cards;
 *   - the pack — as a number; its order never leaves the server;
 *   - the discard — as a number: it is face down (rule 10);
 *   - what is public at a real table stays public: the cards on the table,
 *     the trump under the pack, and who took it when six were dealt.
 *
 * Players are addressed by seat index (their place in `room.players`).
 */
import {
  isHost, findPlayer, isSeated, seatedPlayers, startBlocker, legalFor, boutLimit, allCovered, waitingThrowers,
  score, MAX_SEATS, VARIANT_RU,
} from './rules.js';
import { sortHand } from './cards.js';

/** A stable colour for an avatar, without sending anybody's id (same as poker's). */
function hueOf(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return Math.round((h % 1000) * 137.508) % 360;
}

/** What the plate under a player says: their part in this bout. */
function roleOf(d, id) {
  if (!d || !d.order.includes(id)) return null;
  if (d.phase === 'over') {
    if (d.aborted) return null;
    if (d.fool === id) return 'fool';
    return 'out';
  }
  if (d.out.includes(id)) return 'out';
  if (id === d.defender) return d.bout.taking ? 'taking' : 'defender';
  if (id === d.attacker) return 'attacker';
  return 'thrower';
}

/**
 * @param viewerId  the Telegram id from a VERIFIED initData — never from the page
 */
export function durakView(room, viewerId, { now = Date.now(), botUsername = '' } = {}) {
  const uid = String(viewerId);
  const d = room.deal;
  const meP = findPlayer(room, uid);
  const seat = (id) => room.players.findIndex((p) => p.id === id);
  const playing = !!d && d.phase === 'play';
  const passed = playing ? new Set(d.bout.passed) : new Set();
  const waitingOn = playing ? new Set(waitingThrowers(d)) : new Set();

  const players = room.players.map((p, i) => {
    const inDeal = !!d && d.order.includes(p.id) && !d.aborted;
    if (!inDeal && !isSeated(p)) return null; // gone, and not in the game on the table
    const role = roleOf(d?.aborted ? null : d, p.id);
    return {
      seat: i,
      name: p.name,
      hue: hueOf(p.id),
      isHost: isHost(room, p.id),
      isMe: p.id === uid,
      seated: isSeated(p),
      inDeal,
      // The size of a hand is public at any table; the hand itself is not.
      count: inDeal ? d.hands[p.id].length : 0,
      role,
      passed: playing && (role === 'thrower' || role === 'attacker') && passed.has(p.id),
      waiting: waitingOn.has(p.id),
      fools: p.stats.fool,
      games: p.stats.games,
      lastFool: room.lastFool === p.id,
    };
  }).filter(Boolean);

  const mine = d && !d.aborted && d.order.includes(uid) ? sortHand(d.hands[uid], d.trump) : [];
  const legal = playing ? legalFor(room, uid) : null;
  const myRole = d ? roleOf(d.aborted ? null : d, uid) : null;

  return {
    game: 'durak',
    seq: room.seq,
    now,
    bot: botUsername,
    room: {
      code: room.code,
      title: room.title || '',
      status: room.status,
      maxSeats: MAX_SEATS,
      seated: seatedPlayers(room).length,
      gameNo: room.gameNo,
      settings: { variant: room.settings.variant, turnSeconds: room.settings.turnSeconds || 0 },
      variantName: VARIANT_RU[room.settings.variant],
      notice: room.notice || null,
      hostName: findPlayer(room, room.hostId)?.name ?? null,
      startBlocker: room.status !== 'finished' ? startBlocker(room) : null,
    },
    me: {
      seat: seat(uid),
      name: meP?.name ?? null,
      seated: isSeated(meP),
      isHost: isHost(room, uid),
      kicked: !!meP?.kicked,
      inDeal: !!d && !d.aborted && d.order.includes(uid),
      role: myRole,
      notify: meP?.dm === 'ok',
      cards: mine,
    },
    players,
    deal: d
      ? {
          no: d.no,
          phase: d.phase,
          variant: d.variant,
          trump: d.trump,
          trumpCard: d.trumpCard,
          trumpHolderSeat: d.trumpHolder ? seat(d.trumpHolder) : -1,
          talon: d.talon.length,
          discard: d.discard.length,
          table: d.table.map((x) => ({ a: x.a, d: x.d, by: seat(x.by), dby: x.dby ? seat(x.dby) : -1 })),
          taking: playing && d.bout.taking,
          covered: playing && allCovered(d),
          attackerSeat: playing ? seat(d.attacker) : -1,
          defenderSeat: playing ? seat(d.defender) : -1,
          bout: playing ? d.bout.no : null,
          limit: playing ? boutLimit(d) : 0,
          last: d.last ? { kind: d.last.kind, defenderSeat: seat(d.last.defender), n: d.last.n, bout: d.last.bout } : null,
          deadline: playing && room.turn?.deadline ? room.turn.deadline : null,
          result: d.phase === 'over'
            ? { foolSeat: d.fool ? seat(d.fool) : -1, draw: !!d.draw, aborted: !!d.aborted }
            : null,
        }
      : null,
    legal,
    canStart: room.status === 'lobby' && isHost(room, uid) && !startBlocker(room),
    canNext: room.status === 'playing' && !!d && d.phase === 'over' && (isSeated(meP) || isHost(room, uid)) && !startBlocker(room),
    score: score(room).map((r) => ({ name: r.name, fool: r.fool, games: r.games, isHost: r.isHost, kicked: r.kicked, left: r.left })),
    history: room.history.filter((h) => !h.aborted).length,
    draws: room.history.filter((h) => h.draw).length,
  };
}
