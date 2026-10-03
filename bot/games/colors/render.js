'use strict';
/**
 * Что бот пишет в Telegram про «UNOQ» — чистые функции, как покерные и
 * дурацкие, чтобы их можно было прибить тестами.
 *
 * - КАРТОЧКА в группе: одна на игру, правится на месте. Кто играет, что
 *   происходит, чей ход, счёт серии.
 * - ИТОГИ серии: места, и по живой строке на человека.
 * - Личный толчок тому, кого игра ждёт, а приложение у него закрыто.
 *
 * Ни одна из них не называет карту из чьей-либо руки. ТЕКУЩИЙ ЦВЕТ сказать
 * можно — он лежит на столе в открытую, — а больше ничего.
 */
import { esc, padEnd } from '../../fmt.js';
import { MAX_SEATS, TITLE, findPlayer, seatedPlayers, startBlocker, score, highlights, alive } from './rules.js';
import { COLOR_RU, COLOR_SHAPE, SHAPE_RU } from './cards.js';

const nameOf = (room, id) => esc(findPlayer(room, id)?.name ?? '—');
/** «зелёный (квадрат)» — цвет всегда с фигурой: цветом одним называть нельзя. */
const colorWords = (c) => (c ? `${COLOR_RU[c]} (${SHAPE_RU[COLOR_SHAPE[c]]})` : '—');

export function renderCard(room, { link = null } = {}) {
  const s = room.settings;
  const seated = seatedPlayers(room);
  const lines = [`🎨 <b>UNOQ</b> · цветные карты`];
  lines.push(
    `Игроков: <b>${seated.length}/${MAX_SEATS}</b>` +
      (room.status !== 'finished' && seated.length && (room.status === 'lobby' || room.deal?.phase !== 'play')
        ? ` — ${esc(seated.map((p) => p.name).join(', '))}`
        : '')
  );
  if (s.turnSeconds) lines.push(`⏱ ${s.turnSeconds} с на ход`);
  lines.push('');
  lines.push(...statusLines(room));

  const text = room.status === 'lobby' ? '🎨 Присоединиться' : '🎨 Открыть стол';
  return { text: lines.join('\n'), keyboard: link ? [[{ text, url: link }]] : [] };
}

function statusLines(room) {
  const d = room.deal;
  if (room.status === 'finished') return ['🏁 <b>Игра завершена</b> — итоги ниже.'];
  if (room.status === 'lobby') {
    const blocker = startBlocker(room);
    return [
      '⏳ <b>Ожидание игроков</b>',
      blocker ? `<i>${esc(blocker)}</i>` : `<i>${nameOf(room, room.hostId)} может начинать.</i>`,
    ];
  }
  const out = [];
  if (d?.phase === 'play') {
    out.push(`▶️ Партия #${d.no} · в колоде ${d.deck.length} · цвет ${colorWords(d.color)}`);
    const turn = d.turn ? `🎯 <b>${nameOf(room, d.turn)}</b> ходит` : '';
    const pend = d.pending ? ` · на столе +${d.pending}` : '';
    out.push(turn + pend);
    const one = alive(d).filter((id) => d.hands[id].length === 1).map((id) => nameOf(room, id));
    if (one.length) out.push(`✋ Одна карта: ${one.join(', ')}`);
  } else if (d) {
    if (d.aborted) out.push(`Партия #${d.no} прервана${d.abortedWhy ? ` — ${esc(d.abortedWhy)}` : ''}. Не засчитывается.`);
    else if (d.loser) out.push(`🏁 Партия #${d.no}: последний — <b>${nameOf(room, d.loser)}</b>`);
    else out.push(`🏁 Партия #${d.no} закончилась`);
  }
  const sc = score(room).filter((r) => r.games > 0);
  if (sc.length) out.push(`Счёт: ${sc.map((r) => `${esc(r.name)} — ${r.wins}`).join(', ')}`);
  return out.filter(Boolean);
}

/* -------------------------------------------------------------- your turn */

/** Личный толчок. Короткий: его читают с экрана блокировки. Никогда не карта. */
export function renderTurnPing(room, p, wait) {
  const d = room.deal;
  const title = room.title ? ` · ${esc(room.title)}` : '';
  const lines = [];
  if (wait?.kind === 'pending') {
    lines.push(
      `➕ <b>На вас +${d.pending}</b> · UNOQ${title}`,
      `Кройте или берите ${d.pending} · цвет ${colorWords(d.color)}`
    );
  } else {
    lines.push(
      `🎨 <b>Ваш ход</b> · UNOQ${title}`,
      `Цвет ${colorWords(d.color)} · в колоде ${d.deck.length}`
    );
  }
  const one = alive(d).filter((id) => d.hands[id].length === 1 && id !== p.id).map((id) => esc(findPlayer(room, id)?.name ?? '—'));
  if (one.length) lines.push(`⚠️ Одна карта у: ${one.join(', ')}`);
  if (room.turn?.deadline) lines.push('⏱ время на ход ограничено');
  return lines.join('\n');
}

/* ---------------------------------------------------------------- results */

export function renderResults(room) {
  const rows = score(room).filter((r) => r.games > 0);
  const played = room.history.filter((h) => !h.aborted);
  if (!rows.length) {
    return [`🏁 <b>ИТОГИ · ${TITLE.toUpperCase()}</b>`, '', '<i>Ни одной партии не сыграно.</i>'].join('\n');
  }
  const body = rows.map((r) => `${padEnd(r.name, 14)}выиграл ${r.wins} · последний ${r.last}`).join('\n');
  const lines = highlights(room);
  // Живая строка на человека — то, что люди обсуждают, а не таблица.
  const live = room.players
    .filter((p) => lines[p.id])
    .map((p) => `${esc(p.name)} — ${esc(lines[p.id])}`);
  const tags = rows
    .filter((r) => r.isHost || r.kicked || r.left)
    .map((r) => `${esc(r.name)} — ${[r.isHost && 'хост', r.kicked ? 'удалён' : r.left && 'вышел'].filter(Boolean).join(', ')}`);
  const best = rows.filter((r) => r.wins === rows[0].wins).map((r) => esc(r.name));
  return [
    `🏁 <b>ИТОГИ · ${TITLE.toUpperCase()}</b>`,
    '',
    `<pre>${esc(body)}</pre>`,
    ...(live.length ? ['', live.join('\n')] : []),
    '',
    `<i>Партий сыграно: ${played.length}. Чаще всех выходил первым: ${best.join(', ')}.</i>`,
    ...(tags.length ? ['', `<i>${tags.join('; ')}</i>`] : []),
  ].join('\n');
}
