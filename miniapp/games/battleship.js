/**
 * Морской бой — ЗАГЛУШКА экрана (этап 1 плана: правила и сервер).
 *
 * Сервер игры готов и проверен тестами; настоящий экран (расстановка,
 * два поля, выстрел в два шага) — этап 2 (docs/plan-battleship.md). Пока
 * здесь только надпись и возврат к играм группы, чтобы реестр игр был
 * полным и хаб не ломался.
 */
import { $app, h } from '../ui.js';
import { send } from '../net.js';

let state = null;

export function onState(s) {
  state = s;
}

export function render() {
  const s = state;
  $app.append(h('div.lobby',
    s?.hub ? h('button.back-link', { onclick: () => send({ t: 'hub' }, { lock: false }) }, s.hubLabel || '← Все игры группы') : null,
    h('h1', '🚢 Морской бой'),
    h('div.hint', 'Экран игры ещё делается.')));
}

export const lobby = {
  defaults: { base: 600, inc: 0 },
  fields: (st, { h: hh }) => [hh('div.hint', 'Морской бой на двоих. Кто стреляет первым — решит жребий.')],
};

export const solo = { duel: true, blurb: 'Морской бой против бота' };

/** Чем игра подписана в хабе (картинки появятся вместе с экраном). */
export const iconCards = [];
