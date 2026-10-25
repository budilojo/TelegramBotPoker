/**
 * Настоящий ввод ставки (не «выбор из вариантов»): ползунок + быстрые размеры
 * (1/3, 1/2, 2/3, банк, олл-ин) + поле суммы. Числа с точками.
 *
 * setup: сцена (см. table-seat.js) + { min, max, pot, step?, quick?:[доли] }.
 * Ответ — число (фишки). `result.solution` — верное число: на шкале ставится метка.
 * Всё меняется НА МЕСТЕ (ползунок, поле, подпись): страница не перестраивается.
 */
import { el, flag, keepAboveKeyboard } from './dom.js';
import { sceneEl } from './table-seat.js';
import { fmtNum } from '../poker-math.js';

const QUICK = [[1 / 3, '1/3'], [1 / 2, '1/2'], [2 / 3, '2/3'], [1, 'Банк']];

const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function mount(props = {}) {
  const { setup = {} } = props;
  const min = setup.min ?? 1;
  const max = setup.max ?? Math.max(min, setup.stack ?? 100);
  const step = setup.step ?? Math.max(1, Math.round((max - min) / 200));
  const root = el('div.tm-bet');
  const range = el('input.tm-range', { type: 'range', min, max, step, 'aria-label': 'Размер ставки' });
  const input = el('input.tm-amount', { type: 'text', inputmode: 'numeric', autocomplete: 'off', 'aria-label': 'Сумма ставки', enterkeyhint: 'done' });
  const bounds = el('div.tm-bounds', [el('span', `мин ${fmtNum(min)}`), el('span', `макс ${fmtNum(max)}`)]);
  const mark = el('span.tm-mark', { hidden: '' });
  const track = el('div.tm-rangebox', [range, mark]);
  const quick = el('div.tm-quick');
  const fractions = (setup.quick || QUICK.map((q) => q[0]));
  const labels = new Map(QUICK);
  for (const f of fractions) {
    const amount = clampTo(Math.round((setup.pot ?? 0) * f), min, max);
    quick.append(el('button.tm-q', { type: 'button', 'data-amount': amount }, labels.get(f) || `${Math.round(f * 100)}%`));
  }
  quick.append(el('button.tm-q', { type: 'button', 'data-amount': max }, 'Олл-ин'));

  const send = (v) => root._props.onChange(clampTo(Math.round(v), min, max));
  range.addEventListener('input', () => send(Number(range.value)));
  quick.addEventListener('click', (e) => {
    const b = e.target.closest('.tm-q');
    if (b && !b.disabled) send(Number(b.dataset.amount));
  });
  input.addEventListener('input', () => {
    const digits = input.value.replace(/[^\d]/g, '');
    if (digits) send(Number(digits));
  });
  input.addEventListener('blur', () => { input.value = root._props.value == null ? '' : fmtNum(root._props.value); });
  keepAboveKeyboard(input, root);

  root.append(sceneEl(setup), el('div.tm-betbox', [
    el('label.tm-amount-l', [el('span', 'Ваша ставка'), input]),
    track, bounds, quick,
  ]));
  root._refs = { range, input, mark, quick, min, max };
  update(root, props);
  return root;
}

export function update(root, props = {}) {
  const { value = null, disabled = false, result = null, onChange = () => {} } = props;
  root._props = { value, onChange };
  const { range, input, mark, quick, min, max } = root._refs;
  const v = value == null ? null : clampTo(value, min, max);
  range.value = v ?? min;
  if (document.activeElement !== input) input.value = v == null ? '' : fmtNum(v);
  range.disabled = input.disabled = !!disabled;
  const pct = (x) => ((x - min) / Math.max(1, max - min)) * 100;
  range.style.setProperty('--tm-fill', `${v == null ? 0 : pct(v)}%`);
  for (const b of quick.querySelectorAll('.tm-q')) {
    b.disabled = !!disabled;
    flag(b, 'on', v != null && Number(b.dataset.amount) === v);
  }
  const sol = typeof result?.solution === 'number' ? result.solution : null;
  mark.hidden = sol == null;
  if (sol != null) {
    mark.style.setProperty('--tm-at', `${pct(clampTo(sol, min, max))}%`);
    mark.setAttribute('aria-label', `Верно: ${fmtNum(sol)}`);
    mark.textContent = fmtNum(sol);
  }
}
