'use strict';
/**
 * Что бот пишет в Telegram о шахматной партии — чистые функции, как и у
 * остальных игр, чтобы их можно было прижать тестами.
 *
 * - КАРТОЧКА в группе: одна на стол, правится на месте. Кто играет, чей ход,
 *   сколько ходов сыграно, счёт серии.
 * - ИТОГИ серии.
 * - Личное напоминание тому, кого ждёт партия, если приложение закрыто.
 *
 * Доска у всех на виду, поэтому секретов здесь нет; но позицию в чат и не
 * шлём — её смотрят в приложении, а в карточке только последний ход записью.
 */
import { esc, padEnd } from '../../fmt.js';
import {
  MAX_SEATS, findPlayer, seatedPlayers, startBlocker, score, live, mover, controlRu, KIND_RU, SIDE_RU,
} from './rules.js';

const nameOf = (room, id) => esc(findPlayer(room, id)?.name ?? '—');
const COLOR_RU = { w: 'белые', b: 'чёрные' };
const DOT = { w: '⚪', b: '⚫' };

/** «12. Nf3» — номер хода и запись; для хода чёрных «12… Nf6». */
const moveText = (m) => {
  const last = m.moves.at(-1);
  if (!last) return null;
  const n = Math.ceil(m.moves.length / 2);
  return `${n}${m.moves.length % 2 ? '.' : '…'} ${esc(last.san)}`;
};

export function renderCard(room, { link = null } = {}) {
  const s = room.settings;
  const seated = seatedPlayers(room);
  const lines = [`♟ <b>Шахматы</b> · ${controlRu(s)}`];
  lines.push(
    `Игроков: <b>${seated.length}/${MAX_SEATS}</b>` +
      (room.status === 'lobby' && seated.length ? ` — ${esc(seated.map((p) => p.name).join(', '))}` : '')
  );
  lines.push('');
  lines.push(...statusLines(room));
  const text = room.status === 'lobby' ? '♟ Присоединиться' : '♟ Открыть доску';
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
      // Карточка НЕ меняется от хода к ходу: каждая правка — запрос к Telegram, а
      // в блице их набралось бы по две в секунду на стол (лимит группы — около
      // двадцати в минуту, и страдали бы карточки других игр). Позиция и чей ход —
      // в приложении и в личном «ваш ход».
      out.push(`▶️ Партия #${m.no} · ${vs}`, 'Идёт игра — доска в приложении.');
      if (m.drawOffer) out.push(`🤝 ${nameOf(room, m.drawOffer.by)} предлагает ничью`);
    } else {
      const o = m.over;
      const head = o.kind === 'aborted' ? `Партия #${m.no} отменена` :
        o.winner ? `🏆 Партия #${m.no} — <b>${nameOf(room, o.winner === 'w' ? m.white : m.black)}</b>, ${KIND_RU[o.kind]}` :
          `🤝 Партия #${m.no} — ничья: ${KIND_RU[o.kind]}`;
      out.push(head);
    }
  }
  const sc = score(room).filter((r) => r.games > 0);
  if (sc.length) out.push(`Счёт: ${sc.map((r) => `${esc(r.name)} — ${r.wins}`).join(' : ')}`);
  return out;
}

/* -------------------------------------------------------------- your turn */

/** Короткое личное напоминание — читается на экране блокировки. Позиции не раскрывает больше, чем запись хода. */
export function renderTurnPing(room, p) {
  const m = room.match;
  const title = room.title ? ` · ${esc(room.title)}` : '';
  const lines = [`♟ <b>Ваш ход</b> · Шахматы${title}`];
  const mv = m && moveText(m);
  lines.push(mv ? `Соперник: ${mv}` : 'Вы играете белыми — ходите первым.');
  if (room.turn?.deadline) lines.push('⏱ время на часах идёт');
  return lines.join('\n');
}

/* ---------------------------------------------------------------- results */

export function renderResults(room) {
  const rows = score(room).filter((r) => r.games > 0);
  if (!rows.length) return ['🏁 <b>ИТОГИ · ШАХМАТЫ</b>', '', '<i>Ни одной партии не сыграно.</i>'].join('\n');
  const body = rows.map((r) => `${padEnd(r.name, 14)}${r.wins} · ${r.draws} · ${r.losses}`).join('\n');
  const tags = rows
    .filter((r) => r.isHost || r.kicked || r.left)
    .map((r) => `${esc(r.name)} — ${[r.isHost && 'хост', r.kicked ? 'удалён' : r.left && 'вышел'].filter(Boolean).join(', ')}`);
  const played = room.history.filter((h) => !h.aborted).length;
  const top = rows.filter((r) => r.wins === rows[0].wins && r.losses === rows[0].losses);
  const verdict = top.length === rows.length && rows.length > 1 ? 'Серия закончилась вничью.' : `Лучше всех: ${top.map((r) => esc(r.name)).join(', ')}.`;
  return [
    '🏁 <b>ИТОГИ · ШАХМАТЫ</b>',
    '',
    `<pre>${esc(`${padEnd('', 14)}победы · ничьи · поражения\n${body}`)}</pre>`,
    '',
    `<i>Партий сыграно: ${played}. ${verdict}</i>`,
    ...(tags.length ? ['', `<i>${tags.join('; ')}</i>`] : []),
  ].join('\n');
}

/* ----------------------------------------------------------- поделиться */

/**
 * Что игрок отправит в чужой чат от своего имени после партии. Пишет только
 * то, что и так видно обоим игрокам: имена, чем кончилась, длину партии, —
 * и строку рекламы: что это за бот и куда идти.
 *
 * Без рода и «я»: «победил Иван», а не «я победил» — сообщение уходит от
 * имени того, кто нажал, и это может быть как победитель, так и проигравший.
 *
 * Делимся итогом СЫГРАННОЙ партии: отменённая — не итог.
 *
 * @returns {{ title: string, html: string, plain: string, button: string } | null}
 */
export function shareText(room, userId, { botUsername = '' } = {}) {
  const m = room.match;
  const o = m?.over;
  if (!o || o.kind === 'aborted') return null;
  const white = findPlayer(room, m.white)?.name ?? '—';
  const black = findPlayer(room, m.black)?.name ?? '—';
  const moves = Math.ceil(m.moves.length / 2);
  const winnerName = o.winner ? (o.winner === 'w' ? white : black) : null;
  const how = KIND_RU[o.kind];
  const n = `${moves} ${moves === 1 ? 'ход' : moves < 5 ? 'хода' : 'ходов'}`;
  const verdict = winnerName ? `🏆 Победил ${winnerName} — ${how}, ${n}` : `🤝 Ничья — ${how}, ${n}`;
  const head = `♟ Шахматы: ${white} ⚪ — ⚫ ${black}`;
  const promo = `Играем в шахматы, дурака, покер и UNOQ прямо в Telegram${botUsername ? ` — @${botUsername}` : ''}`;
  return {
    title: winnerName ? `Шахматы: победил ${winnerName}` : 'Шахматы: ничья',
    html: `${esc(head)}\n${esc(verdict)}\n\n${esc(promo)}`,
    plain: `${head}\n${verdict}\n\n${promo}`,
    button: '♟ Сыграть со мной',
  };
}
