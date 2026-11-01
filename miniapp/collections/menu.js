/** Shared entry for all seven game menus. Opening never sends hub/stand/leave. */
import { h, closeSheet } from '../ui.js';
export function shopMenuItem() {
  return h('button.menu-item', { 'data-act': 'shop', onclick: () => {
    closeSheet(); import('./index.js').then(m => m.open());
  } }, 'Магазин и мои вещи', h('small', 'примерка и оформление · партия продолжается'));
}
