'use strict';
/**
 * Что видит ОДИН человек за столом нардов. Чистая функция `(room, viewer)
 * -> state`.
 *
 * Скрытого нет: доска, кубики, сыгранные шаги и все броски партии видны
 * обоим и зрителям. Как в шахматах и шашках, НИКТО НЕ ПОЛУЧАЕТ ЧУЖИХ ХОДОВ:
 * допустимые шаги (`legal.next`), «Бросить», «Отменить», «Готово» — только
 * тому, чей ход. Будущих кубиков нет ни у кого: их ещё не бросали.
 */
import { pips, stepText, diceList } from './board.js';
import {
  live, isHost, findPlayer, isSeated, seatedPlayers, startBlocker, colorOfPlayer, mover, leftOf, score, turnState,
  MAX_SEATS, controlRu, KIND_RU, SIDE_RU,
} from './rules.js';

function hueOf(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return Math.round((h % 1000) * 137.508) % 360;
}

/** Какие числа хода ещё не сыграны. */
function diceLeft(t) {
  if (!t.dice) return [];
  const left = diceList(t.dice);
  for (const s of t.played) left.splice(left.indexOf(s.die), 1);
  return left;
}

export function nardyView(room, viewerId, { now = Date.now(), botUsername = '' } = {}) {
  const uid = String(viewerId);
  const m = room.match;
  const meP = findPlayer(room, uid);
  const seat = (id) => room.players.findIndex((p) => p.id === id);
  const color = colorOfPlayer(room, uid);
  const playing = !!live(room);

  const players = room.players.map((p, i) => {
    const inMatch = !!m && (m.white === p.id || m.black === p.id);
    if (!inMatch && !isSeated(p)) return null;
    return {
      seat: i,
      name: p.name,
      hue: hueOf(p.id),
      isHost: isHost(room, p.id),
      isMe: p.id === uid,
      seated: isSeated(p),
      color: m ? (m.white === p.id ? 'w' : m.black === p.id ? 'b' : null) : null,
    };
  }).filter(Boolean);

  let match = null;
  let st = null;
  if (m) {
    st = playing ? turnState(m) : null;
    const t = m.turn;
    match = {
      no: m.no,
      board: m.pos.b.slice(),
      off: { ...m.pos.off },
      turn: t.c,
      first: m.first,
      dice: t.dice ? t.dice.slice() : null,
      diceLeft: diceLeft(t),
      played: t.played.map((s) => ({ ...s, text: stepText(t.c, s) })),
      phase: st ? st.phase : null,
      log: m.log.map((x) => ({ c: x.c, dice: x.dice, notation: x.notation, steps: x.steps, auto: !!x.auto })),
      rolls: m.rolls,
      turns: m.log.length,
      pips: { w: pips(m.pos, 'w'), b: pips(m.pos, 'b') },
      over: m.over ? { winner: m.over.winner, kind: m.over.kind, why: KIND_RU[m.over.kind], mars: !!m.over.mars } : null,
      clock: {
        timed: room.settings.base > 0,
        first: playing && m.log.length < 2,
        w: m.clock.w,
        b: m.clock.b,
        mover: playing ? mover(m) : null,
        left: playing ? leftOf(room, now) : 0,
        deadline: playing && room.turn?.deadline ? room.turn.deadline : null,
      },
    };
  }

  const mine = !!color && playing && mover(m) === color;
  const player = !!color && playing;

  return {
    game: 'nardy',
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
      settings: { base: room.settings.base, inc: room.settings.inc, side: room.settings.side },
      control: controlRu(room.settings),
      sideName: SIDE_RU[room.settings.side],
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
      color,
      notify: meP?.dm === 'ok',
    },
    players,
    match,
    // Шаги, «Бросить», «Отменить», «Готово» — только тому, чей ход.
    legal: mine
      ? { myTurn: true, color, phase: st.phase, next: st.next.map((s) => ({ ...s })), canRoll: st.phase === 'roll', canUndo: st.canUndo, canEnd: st.canEnd }
      : { myTurn: false },
    canResign: player && m.log.length >= 2,
    canAbort: playing && m.log.length < 2 && (!!color || isHost(room, uid)),
    canShare: !!color && !!m?.over && m.over.kind !== 'aborted',
    canStart: room.status === 'lobby' && isHost(room, uid) && !startBlocker(room),
    canNext: room.status === 'playing' && !!m && !!m.over && (isSeated(meP) || isHost(room, uid)) && !startBlocker(room),
    score: score(room),
    history: room.history.filter((h) => !h.aborted).length,
  };
}
