'use strict';
/**
 * Что видит ОДИН человек за столом шашек. Чистая функция `(room, viewer) ->
 * state`: сервер шлёт результат в Mini App этому человеку и никому другому.
 *
 * Скрытого в шашках нет — доска у всех на виду, — поэтому, как в шахматах,
 * НИКТО НЕ ПОЛУЧАЕТ ЧУЖИХ ХОДОВ: законные ходы (`legal`) приходят только тому,
 * чей сейчас ход. Страница — зрение, а не судья: сервер перепроверяет каждый
 * ход.
 *
 * Отличия от шахмат: в ходе — путь серии и побитые шашки; `legal.must` —
 * поля шашек, которым надо бить (страница их помечает).
 */
import { sqName, legalMoves, colorOf, isKing } from './board.js';
import {
  live, isHost, findPlayer, isSeated, seatedPlayers, startBlocker, colorOfPlayer, mover, leftOf, score, takebackBlocker, askWait,
  MAX_SEATS, controlRu, KIND_RU, SIDE_RU,
} from './rules.js';
import { avatarId } from '../../profile.js';

/** Стабильный цвет аватарки без отправки чьего-либо id (как в остальных играх). */
function hueOf(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return Math.round((h % 1000) * 137.508) % 360;
}

/** Сколько у кого шашек и дамок. */
function material(b) {
  const out = { w: { men: 0, kings: 0 }, b: { men: 0, kings: 0 } };
  for (const p of b) if (p) out[colorOf(p)][isKing(p) ? 'kings' : 'men'] += 1;
  return out;
}

/** Ходы того, чей ход: [{ from, to, path, caps }] по именам полей и поля, которым надо бить. */
function legalFor(m, color) {
  const moves = legalMoves(m.pos).map((mv) => ({
    from: sqName(mv.from), to: sqName(mv.to), path: mv.path.map(sqName), caps: mv.caps.map(sqName),
  }));
  const must = [...new Set(moves.filter((x) => x.caps.length).map((x) => x.from))];
  return { color, moves, must };
}

export function checkersView(room, viewerId, { now = Date.now(), botUsername = '' } = {}) {
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
      avatar: avatarId(p.avatar),
      isHost: isHost(room, p.id),
      isMe: p.id === uid,
      seated: isSeated(p),
      color: m ? (m.white === p.id ? 'w' : m.black === p.id ? 'b' : null) : null,
    };
  }).filter(Boolean);

  let match = null;
  if (m) {
    const last = m.moves.at(-1);
    const first = m.moves.length < 2;
    match = {
      no: m.no,
      board: m.pos.b.slice(),
      turn: m.pos.t,
      whiteSeat: seat(m.white),
      blackSeat: seat(m.black),
      plies: m.moves.length,
      moves: m.moves.map((x) => x.n),
      // Ходы с полями: по ним страница пересобирает позицию на любом ходу
      // (посмотреть, что сыграл соперник). Это показ, а не правила.
      log: m.moves.map((x) => ({ n: x.n, from: x.from, to: x.to, path: x.path, caps: x.caps, promo: !!x.promo })),
      last: last ? { from: last.from, to: last.to, path: last.path, caps: last.caps, n: last.n } : null,
      material: material(m.pos.b),
      over: m.over ? { winner: m.over.winner, kind: m.over.kind, why: KIND_RU[m.over.kind] } : null,
      takeback: m.takeback ? { byColor: m.white === m.takeback.by ? 'w' : 'b', mine: m.takeback.by === uid } : null,
      drawOffer: m.drawOffer ? { byColor: m.white === m.drawOffer.by ? 'w' : 'b', mine: m.drawOffer.by === uid } : null,
      clock: {
        timed: room.settings.base > 0,
        first: playing && first,
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
    game: 'checkers',
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
    // Ходы — только тому, чей они. Зрителю и ждущему — ничего.
    legal: mine ? { myTurn: true, ...legalFor(m, color) } : { myTurn: false },
    canResign: player && m.moves.length >= 2,
    canAbort: playing && m.moves.length < 2 && (!!color || isHost(room, uid)),
    canOfferDraw: player && m.moves.length >= 2 && !m.drawOffer,
    canAnswerDraw: player && !!m.drawOffer && m.drawOffer.by !== uid,
    canTakeback: player && !takebackBlocker(room, uid),
    canShare: !!color && !!m?.over && m.over.kind !== 'aborted',
    askUntil: player
      ? { takeback: now + askWait(m, uid, 'takeback', now), draw: now + askWait(m, uid, 'draw', now) }
      : { takeback: 0, draw: 0 },
    canAnswerTakeback: player && !!m.takeback && m.takeback.by !== uid,
    canStart: room.status === 'lobby' && isHost(room, uid) && !startBlocker(room),
    canNext: room.status === 'playing' && !!m && !!m.over && (isSeated(meP) || isHost(room, uid)) && !startBlocker(room),
    score: score(room),
    history: room.history.filter((h) => !h.aborted).length,
  };
}
