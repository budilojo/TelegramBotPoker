/** Банк и ставка — плоская плашка. `mount({pot, bet?, label?})`. */
import { el } from './dom.js';
import { fmtNum } from '../poker-math.js';

export function mount({ pot, bet = null, label = 'Банк', stack = null } = {}) {
  const root = el('div.tm-pot', { role: 'group', 'aria-label': 'Банк и ставка' });
  root.append(el('span.tm-pot-main', [el('span.tm-pot-k', label), el('b', fmtNum(pot))]));
  if (bet != null) root.append(el('span.tm-pot-bet', [el('span.tm-pot-k', 'Ставка соперника'), el('b', fmtNum(bet))]));
  if (stack != null) root.append(el('span.tm-pot-stack', [el('span.tm-pot-k', 'Ваш стек'), el('b', fmtNum(stack))]));
  return root;
}
export function update(root, props) {
  const fresh = mount(props);
  root.replaceChildren(...fresh.childNodes);
}
