'use strict';
/**
 * Что бот пишет в Telegram о морском бое — чистые функции, чтобы их можно
 * было прижать тестами.
 *
 * Ни здесь, ни где-либо ещё в Telegram флотов нет: ни клеток, ни «попал в
 * трёхпалубный». Карточка в группе говорит только, что идёт бой и кто
 * выиграл; итоги — счёт серии; «ваш ход» — куда выстрелил соперник по ВАШЕМУ
 * полю (это вы и так увидите на своём поле).
 */
import { esc, padEnd } from '../../fmt.js';
import { promoLine } from '../promo.js';
import { addr } from './board.js';
import {
  MAX_SEATS, findPlayer, seatedPlayers, startBlocker, score, live, controlRu, KIND_RU, RESULT_RU,
} from './rules.js';

const nameOf = (room, id) => esc(findPlayer(room, id)?.name ?? '—');
/** Знак игры. */
export const ICON = '🚢';

export function renderCard(room, { link = null } = {}) {
  const s = room.settings;
  const seated = seatedPlayers(room);
  const lines = [`${ICON} <b>Морской бой</b> · ${controlRu(s)}`];
  lines.push(
    `Игроков: <b>${seated.length}/${MAX_SEATS}</b>` +
      (room.status === 'lobby' && seated.length ? ` — ${esc(seated.map((p) => p.name).join(', '))}` : '')
  );
  lines.push('');
  lines.push(...statusLines(room));
  const text = room.status === 'lobby' ? `${ICON} Присоединиться` : `${ICON} Открыть поле`;
  return { text: lines.join('\n'), keyboard: link ? [[{ text, url: link }]] : [] };
}

function statusLines(room) {
  const m = room.match;
  if (room.status === 'finished') return ['🏁 <b>Игра завершена</b> — итоги ниже.'];
  if (room.status === 'lobby') {
    const blocker = startBlocker(room);
    return ['⏳ <b>Ждём соперника</b>', blocker ? `<i>${esc(blocker)}</i>` : `<i>${nameOf(room, room.hostId)} может начинать.</i>`];
  }
  const out = [];
  if (m) {
    const vs = `${nameOf(room, m.ids[0])} — ${nameOf(room, m.ids[1])}`;
    if (live(room)) {
      out.push(`▶️ Партия #${m.no} · ${vs}`, m.phase === 'place' ? 'Расставляют флот — в приложении.' : 'Идёт бой — поле в приложении.');
    } else {
      const o = m.over;
      out.push(o.kind === 'aborted' ? `Партия #${m.no} отменена`
        : `🏆 Партия #${m.no} — <b>${nameOf(room, m.ids[o.winner])}</b>, ${KIND_RU[o.kind]}`);
    }
  }
  const sc = score(room).filter((r) => r.games > 0);
  if (sc.length) out.push(`Счёт: ${sc.map((r) => `${esc(r.name)} — ${r.wins}`).join(' : ')}`);
  return out;
}

/**
 * «Ваш ход» в личку. Расстановка — просьба расставить флот. В бою — куда
 * выстрелил соперник по вашему полю: это ваш флот, вам его знать можно.
 */
export function renderTurnPing(room, p, w) {
  const m = room.match;
  const title = room.title ? ` · ${esc(room.title)}` : '';
  if (w?.kind === 'place' || m?.phase === 'place') {
    return [`${ICON} <b>Расставьте флот</b> · Морской бой${title}`, 'Бой начнётся, когда оба будут готовы. На расстановку — 2 минуты.'].join('\n');
  }
  const lines = [`${ICON} <b>Ваш ход</b> · Морской бой${title}`];
  const last = m?.log.at(-1);
  if (!last) lines.push('Вы стреляете первым — по жребию.');
  else if (String(m.ids[last.by]) !== String(p?.id)) lines.push(`Соперник: ${addr(last.c)} — ${RESULT_RU[last.r]}`);
  else lines.push('Вы попали — стреляйте ещё.');
  if (room.turn?.deadline) lines.push('⏱ время на часах идёт');
  return lines.join('\n');
}

export function renderResults(room) {
  const rows = score(room).filter((r) => r.games > 0);
  if (!rows.length) return ['🏁 <b>ИТОГИ · МОРСКОЙ БОЙ</b>', '', '<i>Ни одной партии не сыграно.</i>'].join('\n');
  const body = rows.map((r) => `${padEnd(r.name, 14)}${r.wins} · ${r.losses}`).join('\n');
  const tags = rows
    .filter((r) => r.isHost || r.kicked || r.left)
    .map((r) => `${esc(r.name)} — ${[r.isHost && 'хост', r.kicked ? 'удалён' : r.left && 'вышел'].filter(Boolean).join(', ')}`);
  const played = room.history.filter((h) => !h.aborted).length;
  const top = rows.filter((r) => r.wins === rows[0].wins && r.losses === rows[0].losses);
  const verdict = top.length === rows.length && rows.length > 1 ? 'Серия закончилась вничью.' : `Лучше всех: ${top.map((r) => esc(r.name)).join(', ')}.`;
  return [
    '🏁 <b>ИТОГИ · МОРСКОЙ БОЙ</b>',
    '',
    `<pre>${esc(`${padEnd('', 14)}победы · поражения\n${body}`)}</pre>`,
    '',
    `<i>Партий сыграно: ${played}. ${verdict}</i>`,
    ...(tags.length ? ['', `<i>${tags.join('; ')}</i>`] : []),
  ].join('\n');
}

const shotsRu = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'выстрел' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'выстрела' : 'выстрелов'}`;

/** «Поделиться» итогом сыгранной партии: кто кого и за сколько выстрелов — без расстановок. */
export function shareText(room, userId, { botUsername = '' } = {}) {
  const m = room.match;
  const o = m?.over;
  if (!o || o.kind === 'aborted') return null;
  const a = findPlayer(room, m.ids[0])?.name ?? '—';
  const b = findPlayer(room, m.ids[1])?.name ?? '—';
  const winnerName = o.winner === 0 ? a : b;
  const verdict = `🏆 Победил ${winnerName} — ${KIND_RU[o.kind]}, ${shotsRu(m.log.length)}`;
  const head = `${ICON} Морской бой: ${a} — ${b}`;
  const promo = promoLine(botUsername);
  return {
    title: `Морской бой: победил ${winnerName}`,
    html: `${esc(head)}\n${esc(verdict)}\n\n${esc(promo)}`,
    plain: `${head}\n${verdict}\n\n${promo}`,
    button: `${ICON} Сыграть со мной`,
  };
}
