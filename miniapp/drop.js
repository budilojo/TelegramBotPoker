/**
 * «Удалить игру» — кнопка хоста вместо команды /cancel. Спрашивает подтверждение:
 * стол исчезнет у всех, итогов и рейтинга за неоконченную партию не будет.
 * Сервер всё равно пускает только хоста.
 */
import { h, showSheet, closeSheet } from './ui.js';
import { send } from './net.js';

export function confirmDrop() {
  showSheet('drop', () => h('div',
    h('h3', 'Удалить игру?'),
    h('div.sub', 'Стол исчезнет у всех, итогов в группу не будет, рейтинг за неоконченную партию не начислится. Нужны итоги — выберите «Завершить игру».'),
    h('div.grid2',
      h('button.btn', { onclick: () => closeSheet() }, 'Не удалять'),
      h('button.btn.danger', { onclick: () => { closeSheet(); send({ t: 'drop' }, { lock: false }); } }, 'Удалить'))));
}

/** Строка меню хоста. `item(label, sub, onclick, cls)` — своя у каждой игры. */
export const dropItem = (item) => item('Удалить игру', 'без итогов и рейтинга', confirmDrop, 'danger');
