'use strict';
/**
 * Что видит ОДИН человек за шахматным столом. Чистая функция `(room,
 * viewer) -> state`: сервер шлёт результат в Mini App этому человеку и никому
 * другому.
 *
 * Скрытого в шахматах нет — доска у всех на виду, — поэтому «никто не видит
 * чужих карт» здесь выглядит иначе: НИКТО НЕ ПОЛУЧАЕТ ЧУЖИХ ХОДОВ. Законные
 * ходы (`legal`) приходят только тому, чей сейчас ход и кто играет за этот
 * цвет; зрителю и тому, кто ждёт, не приходит ничего, чем можно было бы
 * сходить. Страница — зрение, а не судья: сервер перепроверяет каждый ход.
 *
 * Игроки адресуются по месту (`room.players`), а не по id.
 */
import { sqName, legalMoves, inCheck, kingSquare } from './board.js';
import {
  live, isHost, findPlayer, isSeated, seatedPlayers, startBlocker, colorOfPlayer, mover, leftOf, score, takebackBlocker, askWait,
  MAX_SEATS, controlRu, KIND_RU, SIDE_RU,
} from './rules.js';
import { avatarId } from '../../profile.js';

/** Стабильный цвет аватарки без отправки чьего-либо id (как в покере и дураке). */
function hueOf(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return Math.round((h % 1000) * 137.508) % 360;
}

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };

/** Разница в материале по доске: плюс — у белых. Превращения учтены сами собой. */
function material(b) {
  let d = 0;
  for (const p of b) if (p && p.toLowerCase() !== 'k') d += (p === p.toLowerCase() ? -1 : 1) * VALUE[p.toLowerCase()];
  return d;
}

/** Ходы для фигуры по клеткам: { e2: ['e3','e4'] } и список ходов, где нужно выбрать фигуру. */
function legalFor(m, color) {
  const to = {};
  const promo = new Set();
  for (const mv of legalMoves(m.pos)) {
    const f = sqName(mv.from);
    const t = sqName(mv.to);
    (to[f] ||= []);
    if (!to[f].includes(t)) to[f].push(t);
    if (mv.promo) promo.add(f + t);
  }
  return { color, to, promo: [...promo] };
}

export function chessView(room, viewerId, { now = Date.now(), botUsername = '' } = {}) {
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
    const caps = { w: [], b: [] }; // что съели белые / чёрные
    for (const mv of m.moves) if (mv.cap) caps[mv.cap === mv.cap.toLowerCase() ? 'w' : 'b'].push(mv.cap);
    match = {
      no: m.no,
      board: m.pos.b.slice(),
      turn: m.pos.t,
      whiteSeat: seat(m.white),
      blackSeat: seat(m.black),
      plies: m.moves.length,
      moves: m.moves.map((x) => x.san),
      // Ходы с клетками: по ним страница пересобирает позицию на любом ходу
      // (посмотреть, что сыграл соперник). Это показ, а не правила: ходить по
      // такой позиции нельзя, законные ходы приходят только для текущей.
      log: m.moves.map((x) => ({ san: x.san, from: x.from, to: x.to, promo: x.uci.slice(4) })),
      last: last ? { from: last.from, to: last.to, san: last.san } : null,
      check: inCheck(m.pos) ? sqName(kingSquare(m.pos.b, m.pos.t)) : null,
      captured: caps,
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
    game: 'chess',
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
    // Поделиться — игроку стола и итогом сыгранной партии (отменённая — не итог).
    canShare: !!color && !!m?.over && m.over.kind !== 'aborted',
    // До какого времени (по часам сервера) кнопка «Откат» / «Ничья» на КД: страница
    // показывает обратный отсчёт и сама не даёт нажать раньше.
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
