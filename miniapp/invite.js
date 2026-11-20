/**
 * «Пригласить» на пустом месте за столом. Кнопка есть только когда сервер
 * разрешил (`state.canInvite`: есть свободное место, партия не идёт, это не стол
 * с ботами, не турнир и не рейтинговый стол). Нажатие — просьба серверу; он
 * готовит сообщение со ссылкой на стол, а Telegram даёт выбрать чат
 * (net.js → ui.js:openShare, там же запасной путь «скопировать ссылку»).
 */
import { h, haptic } from './ui.js';
import { send } from './net.js';

export function invite() {
  haptic.tap();
  send({ t: 'invite' }, { lock: false });
}

/** Пустое место: кнопка «Пригласить», если можно, иначе просто «свободно». */
export function emptySeat(state) {
  if (!state?.canInvite) return h('div.lseat.empty', h('div.av', '+'), h('div.nm', 'свободно'));
  // Сетка в 4 колонки (покер, UNOQ) на 320 px даёт месту ~58 px: «Пригласить» там слипается
  // с соседним, поэтому подпись короче; для чтецов и подсказки — полное «Пригласить за стол».
  const tight = (state.room?.maxSeats ?? 0) > 6;
  return h('button.lseat.empty.invite', { type: 'button', onclick: invite, 'aria-label': 'Пригласить за стол' },
    h('div.av', '+'), h('div.nm', tight ? 'Позвать' : 'Пригласить'));
}
