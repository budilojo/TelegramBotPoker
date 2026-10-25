/**
 * Борд: пять мест, карты выкладываются по улицам (флоп 3, тёрн 4, ривер 5).
 * `mount({board, street?, mark?:Set|Array карт, tappable?, onTap?, dim?})`.
 *   mark    — карты, которые подсветить как ауты;
 *   tappable — карты борда можно коснуться (onTap(card)).
 * Рендер точечный: `update(el, props)` меняет только классы и картинки.
 */
import { el, flag } from './dom.js';
import { cardEl } from './card-el.js';

const STREETS = ['', '', '', 'Флоп', 'Тёрн', 'Ривер'];

export function mount(props = {}) {
  const root = el('div.tm-board', { role: 'group', 'aria-label': 'Общие карты' });
  const row = el('div.tm-board-row');
  for (let i = 0; i < 5; i++) row.append(el('div.tm-slot'));
  root.append(row, el('div.tm-board-cap'));
  update(root, props);
  return root;
}

export function update(root, { board = [], street = null, mark = [], onTap = null } = {}) {
  const marked = new Set(mark);
  const slots = root.querySelectorAll('.tm-slot');
  slots.forEach((slot, i) => {
    const card = board[i];
    const have = card != null;
    if (have && slot.dataset.card !== String(card)) {
      slot.replaceChildren(cardEl(card));
      slot.dataset.card = String(card);
    }
    if (!have && slot.dataset.card) { slot.replaceChildren(); delete slot.dataset.card; }
    flag(slot, 'empty', !have);
    flag(slot, 'mark', have && marked.has(card));
    slot.onclick = have && onTap ? () => onTap(card) : null;
  });
  root.querySelector('.tm-board-cap').textContent = street ?? STREETS[board.length] ?? '';
}
