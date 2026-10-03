'use strict';
/**
 * What the bot writes in Telegram about a durak game — pure functions, like
 * the poker ones, so they can be pinned down by tests.
 *
 * - The group CARD: one per game, edited in place. Who is in, what is
 *   happening, who attacks whom, the score of the series.
 * - The RESULTS of the series: who was the durak how many times.
 * - A private nudge for somebody the game is waiting for, whose app is closed.
 *
 * Not one of them names a card from anybody's hand. The trump SUIT is said —
 * it lies face up on every table — and nothing more.
 */
import { esc, padEnd } from '../../fmt.js';
import { MAX_SEATS, VARIANT_RU, findPlayer, seatedPlayers, startBlocker, score, allCovered } from './rules.js';
import { SUIT_SIGN, SUIT_RU } from './cards.js';

const nameOf = (room, id) => esc(findPlayer(room, id)?.name ?? '—');

export function renderCard(room, { link = null } = {}) {
  const s = room.settings;
  const seated = seatedPlayers(room);
  const lines = [`🃏 <b>Дурак</b> · ${VARIANT_RU[s.variant]}`];
  lines.push(
    `Игроков: <b>${seated.length}/${MAX_SEATS}</b>` +
      (room.status !== 'finished' && seated.length && (room.status === 'lobby' || room.deal?.phase !== 'play') ? ` — ${esc(seated.map((p) => p.name).join(', '))}` : '')
  );
  if (s.turnSeconds) lines.push(`⏱ ${s.turnSeconds} с на ход`);
  lines.push('');
  lines.push(...statusLines(room));

  const text = room.status === 'lobby' ? '🃏 Присоединиться' : '🃏 Открыть стол';
  return { text: lines.join('\n'), keyboard: link ? [[{ text, url: link }]] : [] };
}

function statusLines(room) {
  const d = room.deal;
  if (room.status === 'finished') return ['🏁 <b>Игра завершена</b> — итоги ниже.'];
  if (room.status === 'lobby') {
    const blocker = startBlocker(room);
    return ['⏳ <b>Ожидание игроков</b>', blocker ? `<i>${esc(blocker)}</i>` : `<i>${nameOf(room, room.hostId)} может начинать.</i>`];
  }
  const out = [];
  if (d?.phase === 'play') {
    out.push(`▶️ Партия #${d.no} · в колоде ${d.talon.length} · козырь ${SUIT_SIGN[d.trump]}`);
    if (!d.table.length) out.push(`⚔️ <b>${nameOf(room, d.attacker)}</b> ходит · 🛡 ${nameOf(room, d.defender)} отбивается`);
    else if (d.bout.taking) out.push(`🛡 <b>${nameOf(room, d.defender)}</b> берёт`);
    else if (allCovered(d)) out.push(`🛡 <b>${nameOf(room, d.defender)}</b> отбился — подкидывают или «бито»`);
    else out.push(`⚔️ ${nameOf(room, d.attacker)} → 🛡 <b>${nameOf(room, d.defender)}</b> отбивается`);
  } else if (d) {
    // The reason is worth a line; the app's other notices may name a card
    // (the lowest trump shown, the timer's lead) and stay out of the group.
    if (d.aborted) out.push(`Партия #${d.no} прервана${d.abortedWhy ? ` — ${esc(d.abortedWhy)}` : ''}. Не засчитывается.`);
    else if (d.fool) out.push(`🤡 Дурак партии #${d.no} — <b>${nameOf(room, d.fool)}</b>`);
    else out.push(`🤝 Партия #${d.no} — ничья`);
  }
  const sc = score(room).filter((r) => r.games > 0);
  if (sc.length) out.push(`Счёт: ${sc.map((r) => `${esc(r.name)} — ${r.fool}`).join(', ')}`);
  return out;
}

/* -------------------------------------------------------------- your turn */

/** The private nudge. Short: it is read on a lock screen. Never a card. */
export function renderTurnPing(room, p, wait) {
  const d = room.deal;
  const title = room.title ? ` · ${esc(room.title)}` : '';
  const tail = `в колоде ${d.talon.length} · козырь ${SUIT_RU[d.trump]}`;
  const lines = [];
  if (wait?.kind === 'lead') {
    lines.push(`👉 <b>Ваш ход</b> · Дурак${title}`, `Вы ходите, отбивается ${nameOf(room, d.defender)} · ${tail}`);
  } else if (wait?.kind === 'defend') {
    const n = d.table.filter((x) => !x.d).length;
    lines.push(`🛡 <b>Отбивайтесь</b> · Дурак${title}`, `${nameOf(room, d.attacker)} ходит на вас: ${n} ${n === 1 ? 'карта' : n < 5 ? 'карты' : 'карт'} · ${tail}`);
  } else {
    lines.push(
      `➕ <b>Можно подкинуть</b> · Дурак${title}`,
      d.bout.taking ? `${nameOf(room, d.defender)} берёт — подкиньте вдогонку или «пас»` : `${nameOf(room, d.defender)} отбился — подкиньте или «пас»`
    );
  }
  if (room.turn?.deadline) lines.push('⏱ время на ход ограничено');
  return lines.join('\n');
}

/* ---------------------------------------------------------------- results */

export function renderResults(room) {
  const rows = score(room).filter((r) => r.games > 0);
  const played = room.history.filter((h) => !h.aborted);
  const draws = played.filter((h) => h.draw).length;
  if (!rows.length) {
    return ['🏁 <b>ИТОГИ · ДУРАК</b>', '', '<i>Ни одной партии не сыграно.</i>'].join('\n');
  }
  const body = rows.map((r) => `${padEnd(r.name, 14)}дурак ${r.fool}`).join('\n');
  const tags = rows
    .filter((r) => r.isHost || r.kicked || r.left)
    .map((r) => `${esc(r.name)} — ${[r.isHost && 'хост', r.kicked ? 'удалён' : r.left && 'вышел'].filter(Boolean).join(', ')}`);
  const best = rows.filter((r) => r.fool === rows[0].fool).map((r) => esc(r.name));
  return [
    '🏁 <b>ИТОГИ · ДУРАК</b>',
    '',
    `<pre>${esc(body)}</pre>`,
    '',
    `<i>Партий сыграно: ${played.length}${draws ? `, ничьих: ${draws}` : ''}. Реже всех дураком: ${best.join(', ')}.</i>`,
    ...(tags.length ? ['', `<i>${tags.join('; ')}</i>`] : []),
  ].join('\n');
}

