'use strict';
/**
 * Что бот пишет в Telegram о партии в нарды (по образцу шахмат и шашек) —
 * чистые функции, чтобы их можно было прижать тестами.
 *
 * - КАРТОЧКА в группе: одна на стол, от хода к ходу не правится (лимиты
 *   Telegram); позиции и кубиков в ней нет — они в приложении.
 * - ИТОГИ серии.
 * - Личное «ваш ход» — что выбросил и сыграл соперник.
 */
import { esc, padEnd } from '../../fmt.js';
import { promoLine } from '../promo.js';
import {
  MAX_SEATS, findPlayer, seatedPlayers, startBlocker, score, live, controlRu, KIND_RU, SIDE_RU,
} from './rules.js';

const nameOf = (room, id) => esc(findPlayer(room, id)?.name ?? '—');
const DOT = { w: '⚪', b: '⚫' };
/** Знак игры. */
export const ICON = '🎲';

export function renderCard(room, { link = null } = {}) {
  const s = room.settings;
  const seated = seatedPlayers(room);
  const lines = [`${ICON} <b>Нарды</b> · ${controlRu(s)}`];
  lines.push(
    `Игроков: <b>${seated.length}/${MAX_SEATS}</b>` +
      (room.status === 'lobby' && seated.length ? ` — ${esc(seated.map((p) => p.name).join(', '))}` : '')
  );
  lines.push('');
  lines.push(...statusLines(room));
  const text = room.status === 'lobby' ? `${ICON} Присоединиться` : `${ICON} Открыть доску`;
  return { text: lines.join('\n'), keyboard: link ? [[{ text, url: link }]] : [] };
}

function statusLines(room) {
  const m = room.match;
  if (room.status === 'finished') return ['🏁 <b>Игра завершена</b> — итоги ниже.'];
  if (room.status === 'lobby') {
    const blocker = startBlocker(room);
    const side = room.settings.side === 'random' ? '' : ` Хост играет ${SIDE_RU[room.settings.side]}.`;
    return ['⏳ <b>Ждём соперника</b>', blocker ? `<i>${esc(blocker)}${side}</i>` : `<i>${nameOf(room, room.hostId)} может начинать.${side}</i>`];
  }
  const out = [];
  if (m) {
    const vs = `${DOT.w} ${nameOf(room, m.white)} — ${DOT.b} ${nameOf(room, m.black)}`;
    if (live(room)) {
      out.push(`▶️ Партия #${m.no} · ${vs}`, 'Идёт игра — доска в приложении.');
    } else {
      const o = m.over;
      out.push(o.kind === 'aborted' ? `Партия #${m.no} отменена`
        : `🏆 Партия #${m.no} — <b>${nameOf(room, o.winner === 'w' ? m.white : m.black)}</b>, ${KIND_RU[o.kind]}`);
    }
  }
  const sc = score(room).filter((r) => r.games > 0);
  if (sc.length) out.push(`Счёт: ${sc.map((r) => `${esc(r.name)} — ${r.wins}`).join(' : ')}`);
  return out;
}

/** «Ваш ход» в личку: что выбросил и сыграл соперник. */
export function renderTurnPing(room) {
  const m = room.match;
  const title = room.title ? ` · ${esc(room.title)}` : '';
  const lines = [`${ICON} <b>Ваш ход</b> · Нарды${title}`];
  const last = m?.log.at(-1);
  if (last) lines.push(`Соперник: ${last.dice.join('-')}${last.notation.length ? ` · ${esc(last.notation.join(' '))}` : ' · ходов не было'}`);
  else lines.push('Вы ходите первым — числами жребия.');
  if (room.turn?.deadline) lines.push('⏱ время на часах идёт');
  return lines.join('\n');
}

export function renderResults(room) {
  const rows = score(room).filter((r) => r.games > 0);
  if (!rows.length) return ['🏁 <b>ИТОГИ · НАРДЫ</b>', '', '<i>Ни одной партии не сыграно.</i>'].join('\n');
  const body = rows.map((r) => `${padEnd(r.name, 14)}${r.wins} · ${r.losses}${r.mars ? ` (марс: ${r.mars})` : ''}`).join('\n');
  const tags = rows
    .filter((r) => r.isHost || r.kicked || r.left)
    .map((r) => `${esc(r.name)} — ${[r.isHost && 'хост', r.kicked ? 'удалён' : r.left && 'вышел'].filter(Boolean).join(', ')}`);
  const played = room.history.filter((h) => !h.aborted).length;
  const top = rows.filter((r) => r.wins === rows[0].wins && r.losses === rows[0].losses);
  const verdict = top.length === rows.length && rows.length > 1 ? 'Серия закончилась вничью.' : `Лучше всех: ${top.map((r) => esc(r.name)).join(', ')}.`;
  return [
    '🏁 <b>ИТОГИ · НАРДЫ</b>',
    '',
    `<pre>${esc(`${padEnd('', 14)}победы · поражения\n${body}`)}</pre>`,
    '',
    `<i>Партий сыграно: ${played}. ${verdict}</i>`,
    ...(tags.length ? ['', `<i>${tags.join('; ')}</i>`] : []),
  ].join('\n');
}

/** «Поделиться» итогом сыгранной партии — то, что и так видно обоим. */
export function shareText(room, userId, { botUsername = '' } = {}) {
  const m = room.match;
  const o = m?.over;
  if (!o || o.kind === 'aborted') return null;
  const white = findPlayer(room, m.white)?.name ?? '—';
  const black = findPlayer(room, m.black)?.name ?? '—';
  const winnerName = o.winner === 'w' ? white : black;
  const n = m.log.length;
  const turns = `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'ход' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'хода' : 'ходов'}`;
  const verdict = `🏆 Победил ${winnerName} — ${KIND_RU[o.kind]}, ${turns}`;
  const head = `${ICON} Нарды: ${white} ⚪ — ⚫ ${black}`;
  const promo = promoLine(botUsername);
  return {
    title: `Нарды: победил ${winnerName}`,
    html: `${esc(head)}\n${esc(verdict)}\n\n${esc(promo)}`,
    plain: `${head}\n${verdict}\n\n${promo}`,
    button: `${ICON} Сыграть со мной`,
  };
}
