'use strict';
/**
 * The few things the bot still writes in Telegram. Pure functions
 * `room -> { text, keyboard }`, which is what makes the snapshot tests
 * possible. The table itself lives in the Mini App.
 *
 * - The group CARD: one per game, edited in place, never re-sent on its own.
 *   It answers "is there a game, how many are in, what is happening, whose
 *   turn is it" for people who have not opened the table — and carries the
 *   button that opens it.
 * - The RESULTS of the evening.
 * - A private "👉 your turn" for a player whose table is closed.
 *
 * None of them ever contains a hole card. The card shows the stage of the
 * hand, not the board: the board belongs to the table.
 */
import { results } from '../server/game.js';
import { num, signed, esc, padEnd, padStart, hhmmss, STREET_RU } from './fmt.js';
import { MAX_SEATS, dealers, isLive, roleOf, findPlayer, startBlocker } from './room.js';
import { resultOf } from './view.js';

const NAME_W = 10;
const STACK_W = 8;

/* ------------------------------------------------------------------- card */

/**
 * @param link  where "🃏 Открыть стол" leads (null — no button: the bot's
 *              username is unknown, which only happens in odd test setups)
 */
export function renderCard(room, { link = null } = {}) {
  const s = room.settings;
  const seated = room.players.filter((p) => !p.kicked && !p.left && roleOf(p) === 'player');
  const host = findPlayer(room, room.hostId);
  const lines = ['♠️ <b>Покерная комната</b>'];

  lines.push(
    `Игроков: <b>${seated.length}/${MAX_SEATS}</b>` +
      (room.status === 'lobby' && seated.length ? ` — ${esc(seated.map((p) => p.name).join(', '))}` : '')
  );
  lines.push(
    `Стек ${num(s.startingStack)} · блайнды ${num(s.smallBlind)}/${num(s.bigBlind)}` +
      (room.pendingBlinds ? ` → ${num(room.pendingBlinds.sb)}/${num(room.pendingBlinds.bb)}` : '') +
      (s.turnSeconds ? ` · ⏱ ${s.turnSeconds} с на ход` : '')
  );
  const d = dealers(room)[0];
  lines.push(isLive(room) ? `🃏 Настоящие карты${d ? ` · дилер ${esc(d.name)}` : ''}` : '🤖 Карты раздаёт бот');
  lines.push('');
  lines.push(...statusLines(room, host));

  const keyboard = link ? [[{ text: '🃏 Открыть стол', url: link }]] : [];
  return { text: lines.join('\n'), keyboard };
}

function statusLines(room, host) {
  const h = room.hand;
  if (room.status === 'finished') return ['🏁 <b>Игра завершена</b> — итоги ниже.'];
  if (room.status === 'lobby') {
    const blocker = startBlocker(room);
    return [
      '⏳ <b>Ожидание игроков</b>',
      blocker ? `<i>${esc(blocker)}</i>` : `<i>${esc(host?.name ?? 'Хост')} может начинать.</i>`,
    ];
  }
  const out = [];
  if (room.status === 'paused') out.push('⏸ <b>Пауза</b>');
  if (!h) return out;

  const stage = h.phase === 'betting' ? STREET_RU[h.street] : h.phase === 'showdown' ? 'ВСКРЫТИЕ' : 'ЗАВЕРШЕНА';
  if (room.status !== 'paused') out.push(`▶️ Идёт игра · раздача #${h.no} · ${stage}`);
  else out.push(`Раздача #${h.no} · ${stage}`);

  if (h.phase === 'betting' && room.status === 'playing') {
    const actor = findPlayer(room, h.actorId);
    if (actor) out.push(`👉 Ход: <b>${esc(actor.name)}</b>`);
  }
  if (h.phase === 'showdown' && h.live) {
    const dl = dealers(room)[0];
    out.push(`🃏 ${dl ? `${esc(dl.name)} определяет` : 'Стол определяет'} победителя`);
  }
  if (h.phase === 'complete') {
    const r = resultOf(room);
    if (r?.kind === 'aborted') out.push('Раздача прервана — фишки вернулись владельцам.');
    else if (r) {
      const name = (seat) => esc(room.players[seat]?.name ?? '?');
      for (const w of r.winners) {
        out.push(`🏆 <b>${name(w.seat)}</b> +${num(w.amount)}` +
          (w.hand ? ` · ${esc(w.hand)}` : r.kind === 'fold' ? ' — остальные сбросили' : ''));
      }
    } else {
      out.push('🃏 Открываем борд…');
    }
  }
  if (room.notice) out.push(`<i>${esc(room.notice)}</i>`);
  return out;
}

/* -------------------------------------------------------------- your turn */

/** The private nudge. Short: it is read on a lock screen. */
export function renderTurnPing(room, p) {
  const h = room.hand;
  const bits = [];
  const toCall = Math.max(0, (h.currentBet || 0) - (p.bet || 0));
  bits.push(toCall > 0 ? `колл ${num(Math.min(toCall, p.stack))}` : 'можно чекнуть');
  bits.push(`банк ${num(room.players.reduce((sum, x) => sum + (x.committed || 0), 0))}`);
  const lines = [
    `👉 <b>Ваш ход</b>${room.title ? ` · ${esc(room.title)}` : ''}`,
    `Раздача #${h.no} · ${STREET_RU[h.street] || ''} · ${bits.join(' · ')}`,
  ];
  if (room.turn?.deadline) {
    lines.push(`⏱ до ${hhmmss(room.turn.deadline)} — потом ${toCall > 0 ? 'фолд' : 'чек'}`);
  }
  return lines.join('\n');
}

/* ---------------------------------------------------------------- results */

export function renderResults(room) {
  // The engine already derives net and host from the same numbers it paid
  // out with; re-deriving them here would be a second source of truth. Only
  // the ordering differs: at the end of the evening, who is up matters more
  // than who has the biggest pile.
  const byId = new Map(room.players.map((p) => [p.id, p]));
  const rows = results(room)
    .filter((r) => r.role !== 'dealer' || r.handsPlayed > 0 || r.net !== 0)
    .map((r) => ({
      name: r.name,
      isHost: r.isHost,
      kicked: !!byId.get(r.id)?.kicked,
      left: !!byId.get(r.id)?.left,
      stack: r.stack,
      net: r.net,
      hands: r.handsPlayed,
      pots: r.potsWon,
      biggest: r.biggestPot,
    }))
    .sort((a, b) => b.net - a.net || b.stack - a.stack);

  const body = rows
    .map(
      (r) =>
        padEnd(r.name, NAME_W + 2) +
        padStart(num(r.stack), STACK_W) +
        padStart(signed(r.net), STACK_W + 1)
    )
    .join('\n');

  const extra = rows
    .map((r) => {
      const tags = [];
      if (r.isHost) tags.push('хост');
      if (r.kicked) tags.push('удалён');
      else if (r.left) tags.push('вышел');
      const t = tags.length ? ` (${tags.join(', ')})` : '';
      return `${esc(r.name)}${t}: раздач ${r.hands}, банков ${r.pots}, крупнейший ${num(r.biggest)}`;
    })
    .join('\n');

  const d = room.players.filter((p) => roleOf(p) === 'dealer').map((p) => esc(p.name));
  const sum = rows.reduce((s, r) => s + r.net, 0);
  return [
    '🏁 <b>ИТОГИ</b>',
    '',
    `<pre>${esc(body)}</pre>`,
    '',
    `<i>${extra}</i>`,
    ...(d.length ? ['', `<i>Дилер: ${d.join(', ')}</i>`] : []),
    '',
    `<i>Раздач сыграно: ${room.handNo}. Сумма P/L: ${signed(sum)} — должна быть 0.</i>`,
  ].join('\n');
}
