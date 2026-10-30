'use strict';
/**
 * Что видит ОДИН человек за столом морского боя. Чистая функция
 * `(room, viewer) -> state`, и ЕДИНСТВЕННОЕ место, где флоты выходят из
 * комнаты наружу.
 *
 *   До конца партии чужого флота нет ни в каком виде. Игрок получает:
 *     - своё поле: свой флот целиком и куда стрелял соперник;
 *     - поле соперника: только результаты СВОИХ выстрелов («мимо»,
 *       «ранил», «убил»), потопленные корабли целиком и пустые клетки
 *       вокруг них (так их и отмечают на бумаге);
 *     - про расстановку соперника — один признак «готов / расставляет».
 *   Зритель получает только отметки выстрелов на обоих полях — ни одного
 *   корабля, даже потопленного (его клетки и так отмечены «убил»).
 *
 *   Когда партия кончилась — открываются оба флота: посмотреть и
 *   убедиться, что всё было честно.
 *
 * Чужой флот здесь читается ровно в двух местах — `sunkOf` (какие корабли
 * потоплены) и `marks` (какие попадания стали «убил»); оба отвечают только
 * про клетки, в которые уже стреляли.
 */
import { sunkShips, halo, shipCells } from './board.js';
import {
  live, isHost, findPlayer, isSeated, seatedPlayers, startBlocker, sideOf, mover, leftOf, score, fleetLeft, firstPhase,
  MAX_SEATS, controlRu, KIND_RU, RESULT_RU, PLACE_MS,
} from './rules.js';
import { avatarId } from '../../profile.js';

function hueOf(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return Math.round((h % 1000) * 137.508) % 360;
}

const copyShip = (s) => ({ x: s.x, y: s.y, len: s.len, dir: s.dir });

/** Потопленные корабли поля стороны `s` — по выстрелам соперника в него. */
function sunkOf(m, s) {
  const fleet = m.fleets[s];
  if (!fleet) return [];
  return sunkShips(fleet, new Set(m.shots[1 - s].map((x) => x.c)));
}

/** Отметки на поле стороны `s`: куда стреляли и что вышло; клетки потопленных — «убил». */
function marks(m, s, sunk) {
  const dead = new Set(sunk.flatMap(shipCells));
  return m.shots[1 - s].map((x) => ({ c: x.c, r: dead.has(x.c) ? 'sunk' : x.r }));
}

/**
 * Одно поле — поле стороны `s` — глазами смотрящего.
 * `own` — смотрит хозяин; `player` — смотрит игрок партии; `over` — партия кончилась.
 */
function boardView(m, s, { own, player, over }) {
  const sunk = sunkOf(m, s);
  const around = new Set();
  for (const ship of sunk) for (const c of halo(ship)) around.add(c);
  for (const x of m.shots[1 - s]) around.delete(x.c);
  const fleet = own || over ? m.fleets[s] : null;
  return {
    side: s,
    ready: !!m.ready[s],
    shots: marks(m, s, sunk),
    around: [...around].sort((a, b) => a - b),
    // Корабли: свой — весь; чужой — только потопленные (и то не зрителю); в конце — все.
    ships: fleet ? fleet.map(copyShip) : player ? sunk.map(copyShip) : [],
    left: fleetLeft(sunk),
  };
}

export function battleshipView(room, viewerId, { now = Date.now(), botUsername = '' } = {}) {
  const uid = String(viewerId);
  const m = room.match;
  const meP = findPlayer(room, uid);
  const seat = (id) => room.players.findIndex((p) => p.id === id);
  const side = sideOf(room, uid);
  const playing = !!live(room);

  const players = room.players.map((p, i) => {
    const inMatch = !!m && m.ids.includes(p.id);
    if (!inMatch && !isSeated(p)) return null;
    return {
      seat: i,
      name: p.name,
      hue: hueOf(p.id),
      avatar: avatarId(p.avatar),
      isHost: isHost(room, p.id),
      isMe: p.id === uid,
      seated: isSeated(p),
      side: m ? (m.ids[0] === p.id ? 0 : m.ids[1] === p.id ? 1 : null) : null,
    };
  }).filter(Boolean);

  let match = null;
  if (m) {
    const over = !!m.over;
    const battle = m.phase === 'battle';
    const opts = (s) => ({ own: side === s, player: side != null, over });
    match = {
      no: m.no,
      phase: m.phase,
      mySide: side,
      // Кто стреляет первым — объявляется, когда начался бой.
      first: battle ? m.first : null,
      turn: battle && !over ? m.turn : null,
      boards: [boardView(m, 0, opts(0)), boardView(m, 1, opts(1))],
      log: m.log.map((x) => ({ by: x.by, c: x.c, r: x.r })),
      shots: m.log.length,
      over: over ? { winner: m.over.winner, kind: m.over.kind, why: KIND_RU[m.over.kind] } : null,
      clock: {
        timed: room.settings.base > 0,
        place: playing && m.phase === 'place',
        first: playing && battle && firstPhase(m),
        bank: m.clock.slice(),
        mover: playing && battle ? mover(m) : null,
        left: playing ? leftOf(room, now) : 0,
        deadline: playing && room.turn?.deadline ? room.turn.deadline : null,
        placeMs: PLACE_MS,
      },
    };
  }

  const placing = side != null && playing && m.phase === 'place' && !m.ready[side];
  const mine = side != null && playing && m.phase === 'battle' && mover(m) === side;

  return {
    game: 'battleship',
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
      settings: { base: room.settings.base, inc: room.settings.inc },
      control: controlRu(room.settings),
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
      side,
      notify: meP?.dm === 'ok',
    },
    players,
    match,
    results: RESULT_RU,
    // Выстрел — только тому, чей ход.
    legal: mine ? { myTurn: true, canFire: true } : { myTurn: false },
    canPlace: placing,
    canReady: placing && !!m.fleets[side],
    canResign: side != null && playing && !firstPhase(m),
    canAbort: playing && firstPhase(m) && (side != null || isHost(room, uid)),
    canShare: side != null && !!m?.over && m.over.kind !== 'aborted',
    canStart: room.status === 'lobby' && isHost(room, uid) && !startBlocker(room),
    canNext: room.status === 'playing' && !!m && !!m.over && (isSeated(meP) || isHost(room, uid)) && !startBlocker(room),
    score: score(room).map(({ id, ...row }) => row),
    history: room.history.filter((h) => !h.aborted).length,
  };
}
