'use strict';
/**
 * Что видит ОДИН человек за столом «UNOQ». Чистая функция
 * `(room, viewer) -> state`, которую сервер отправляет этому человеку и
 * больше никому.
 *
 * «Никто не видит чужих карт» держится здесь — тем, что сюда не попадает:
 *
 *   - своя рука — только своему хозяину;
 *   - чужая рука — ЧИСЛОМ карт, никогда картами;
 *   - колода — числом; её порядок не покидает сервер;
 *   - сброс — числом: он лежит рубашкой вверх, как и в дураке;
 *   - что лежит на виду, на виду и остаётся: верхняя карта кучи, названный
 *     цвет, сторона хода и сколько карт висит по накоплению.
 *
 * Лента событий называет карту только тогда, когда её положили на кучу — то
 * есть когда её и так увидели все. «Взял карту» — это событие без карты.
 *
 * Люди адресуются номером места (позицией в `room.players`).
 */
import {
  isHost, findPlayer, isSeated, seatedPlayers, startBlocker, legalFor, alive, score, highlights,
  MAX_SEATS, MIN_PLAYERS, CALL_MS, SHOUT,
} from './rules.js';
import { sortHand, COLOR_SHAPE, COLORS } from './cards.js';

/** Устойчивый цвет аватара, не выдающий ничьего id (как в покере и дураке). */
function hueOf(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return Math.round((h % 1000) * 137.508) % 360;
}

/** Что написано на плашке под человеком: его роль в этой партии. */
function roleOf(d, id) {
  if (!d || !d.order.includes(id)) return null;
  if (d.quit.includes(id)) return 'quit';
  if (d.phase === 'over') {
    if (d.aborted) return null;
    if (d.loser === id) return 'last';
    return 'out';
  }
  if (d.out.includes(id)) return 'out';
  if (d.turn === id) return 'turn';
  return null;
}

/**
 * @param viewerId  Telegram-id из ПРОВЕРЕННОЙ подписи — никогда со страницы
 */
export function colorsView(room, viewerId, { now = Date.now(), botUsername = '' } = {}) {
  const uid = String(viewerId);
  const d = room.deal;
  const meP = findPlayer(room, uid);
  const seat = (id) => room.players.findIndex((p) => p.id === id);
  const playing = !!d && d.phase === 'play';
  const inDealOf = (id) => !!d && d.order.includes(id) && !d.aborted;

  const players = room.players.map((p, i) => {
    const inDeal = inDealOf(p.id);
    if (!inDeal && !isSeated(p)) return null; // ушёл и в партии на столе не участвует
    return {
      seat: i,
      name: p.name,
      hue: hueOf(p.id),
      isHost: isHost(room, p.id),
      isMe: p.id === uid,
      seated: isSeated(p),
      inDeal,
      // Сколько карт в руке — это видно за любым столом; какие именно — нет.
      count: inDeal ? d.hands[p.id].length : 0,
      role: roleOf(d?.aborted ? null : d, p.id),
      turn: playing && d.turn === p.id,
      // Осталась одна карта — красная рамка; промолчал — рамка мигает.
      alone: inDeal && playing && d.hands[p.id].length === 1,
      called: inDeal && playing && d.call?.id === p.id && d.call.called,
      quiet: inDeal && playing && !!d.call && d.call.id === p.id && !d.call.called && now - d.call.at < CALL_MS,
      place: d && !d.aborted && d.out.includes(p.id) ? d.out.indexOf(p.id) + 1 : 0,
      wins: p.stats.wins,
      lasts: p.stats.last,
      games: p.stats.games,
      lastLoser: room.lastLoser === p.id,
    };
  }).filter(Boolean);

  const myHand = inDealOf(uid) ? d.hands[uid] : [];
  // Наружу не уходит ни одного чужого id: кого можно поймать — это МЕСТО.
  const raw = d ? legalFor(room, uid, { now }) : null;
  const legal = raw ? { ...raw, catch: raw.catch ? { seat: seat(raw.catch.id), until: raw.catch.until } : null } : null;

  return {
    game: 'colors',
    seq: room.seq,
    now,
    bot: botUsername,
    room: {
      code: room.code,
      title: room.title || '',
      status: room.status,
      maxSeats: MAX_SEATS,
      minSeats: MIN_PLAYERS,
      seated: seatedPlayers(room).length,
      gameNo: room.gameNo,
      settings: { stacking: !!room.settings.stacking, turnSeconds: room.settings.turnSeconds || 0 },
      notice: room.notice || null,
      hostName: findPlayer(room, room.hostId)?.name ?? null,
      startBlocker: room.status !== 'finished' ? startBlocker(room) : null,
      callMs: CALL_MS,
      shout: SHOUT, // что кричат на последней карте — словами сервера
      shapes: COLOR_SHAPE, // фигура цвета — часть карты, не настройка
      colors: COLORS,
    },
    me: {
      seat: seat(uid),
      name: meP?.name ?? null,
      seated: isSeated(meP),
      isHost: isHost(room, uid),
      kicked: !!meP?.kicked,
      inDeal: inDealOf(uid),
      notify: meP?.dm === 'ok',
      // Рука приходит дважды: в постоянном порядке (цвета — всегда одни и те
      // же, по возрастанию) и в том, в каком карты приходили. Переключатель
      // «по цвету / как пришли» живёт на телефоне и ничего не спрашивает у
      // сервера. Обе — свои же карты, так что лишнего это не говорит никому.
      cards: sortHand(myHand),
      dealt: [...myHand],
    },
    players,
    deal: d
      ? {
          no: d.no,
          phase: d.phase,
          top: d.top, // верхняя карта кучи лежит в открытую
          color: d.color,
          dir: d.dir,
          deck: d.deck.length,
          discard: d.discard.length,
          turnSeat: playing && d.turn ? seat(d.turn) : -1,
          pending: d.pending,
          pendingKind: d.pendingKind,
          drawn: playing && d.turn === uid ? d.drawn : null, // своя взятая карта — своему
          alive: playing ? alive(d).length : 0,
          call: d.call && playing
            ? { seat: seat(d.call.id), called: d.call.called, until: d.call.at + CALL_MS }
            : null,
          events: d.events.slice(-3).map((e) => ({
            n: e.n,
            kind: e.kind,
            seat: e.by != null ? seat(e.by) : -1,
            targetSeat: e.target != null ? seat(e.target) : -1,
            card: e.card ?? null, // только та, что легла на кучу
            color: e.color ?? null,
            count: e.count ?? 0,
          })),
          deadline: playing && room.turn?.deadline ? room.turn.deadline : null,
          result: d.phase === 'over'
            ? {
                loserSeat: d.loser ? seat(d.loser) : -1,
                aborted: !!d.aborted,
                why: d.abortedWhy || null,
                places: d.aborted ? [] : d.out.map((id) => seat(id)),
              }
            : null,
        }
      : null,
    legal,
    canStart: room.status === 'lobby' && isHost(room, uid) && !startBlocker(room),
    canNext: room.status === 'playing' && !!d && d.phase === 'over' && (isSeated(meP) || isHost(room, uid)) && !startBlocker(room),
    score: score(room).map((r) => ({ name: r.name, wins: r.wins, last: r.last, games: r.games, isHost: r.isHost, kicked: r.kicked, left: r.left })),
    highlights: Object.fromEntries(
      Object.entries(highlights(room)).map(([id, line]) => [String(seat(id)), line]).filter(([s]) => s !== '-1')
    ),
    history: room.history.filter((h) => !h.aborted).length,
  };
}
