/**
 * Выбор одного варианта (kind 'pick'). props: { setup:{options:[{id,label}]},
 * value, disabled, onChange(id), result }. Нажатие правит классы НА МЕСТЕ —
 * список не перестраивается (экран не «подпрыгивает»). После разбора
 * (result) верный вариант помечен, выбранный неверный — тоже.
 */
import { h } from '../../ui.js';

export function mount(props) {
  const { setup, onChange } = props;
  const el = h('div.tr-choice', { role: 'radiogroup' },
    setup.options.map((o) => h('button.tr-opt', {
      type: 'button', role: 'radio', 'data-id': o.id,
      onclick: () => { if (el.dataset.locked) return; onChange?.(o.id); },
    }, h('span.tr-opt-mark'), h('span.tr-opt-label', o.label))));
  update(el, props);
  return el;
}

export function update(el, { value = null, disabled = false, result = null, setup }) {
  if (disabled || result) el.dataset.locked = '1'; else delete el.dataset.locked;
  const right = result ? result.solution : null;
  for (const b of el.querySelectorAll('.tr-opt')) {
    const id = b.dataset.id;
    b.setAttribute('aria-checked', String(id === value));
    b.classList.toggle('on', id === value && !result);
    b.classList.toggle('right', !!result && id === right);
    b.classList.toggle('wrong', !!result && id === value && id !== right);
    b.disabled = !!result;
  }
}
