/** Шкала 0…1 (плоская полоса из токенов). props: { value, label?, tone? ('ok'|'warn') }. */
import { h } from '../../ui.js';

export function mount({ value = 0, label = null, tone = null }) {
  const v = Math.min(1, Math.max(0, Number(value) || 0));
  return h('div.tr-bar', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(v * 100), 'aria-label': label || null },
    h(`div.tr-bar-fill${tone ? '.' + tone : ''}`, { style: { width: `${Math.round(v * 100)}%` } }));
}

export function update(el, { value = 0 }) {
  const v = Math.min(1, Math.max(0, Number(value) || 0));
  el.firstChild.style.width = `${Math.round(v * 100)}%`;
  el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
}
