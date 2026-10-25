/**
 * Полоса «ваша доля / нужная доля» + ввод процента или числа.
 *
 * Для kind 'slider': ответ — число в единицах `setup.unit` ('%' или фишки).
 *   setup: сцена + { min, max, step, unit, label, need? (метка нужной доли, %),
 *          markAt? }; `result.solution` — верное число: метка на шкале.
 * `barEl({mine, need})` — просто картинка полосы (для разборов), доли 0…1.
 * Правка на месте: ползунок и поле не пересоздаются.
 */
import { el, flag, keepAboveKeyboard } from './dom.js';
import { sceneEl } from './table-seat.js';
import { fmtNum, fmtDec } from '../poker-math.js';

/** Плоская полоса: заливка — «ваша доля», чёрточка — «нужная». */
export function barEl({ mine = null, need = null, mineLabel = 'Ваша доля', needLabel = 'Нужная доля' } = {}) {
  const pct = (x) => `${Math.max(0, Math.min(1, x)) * 100}%`;
  const bar = el('div.tm-bar', { role: 'img', 'aria-label': `${mineLabel}: ${mine == null ? '—' : fmtDec(mine * 100)} %; ${needLabel}: ${need == null ? '—' : fmtDec(need * 100)} %` }, [
    mine != null ? el('span.tm-bar-fill', { style: { width: pct(mine) } }) : null,
    need != null ? el('span.tm-bar-need', { style: { left: pct(need) } }) : null,
  ]);
  flag(bar, 'enough', mine != null && need != null && mine >= need);
  return el('div.tm-odds', [bar, el('div.tm-odds-cap', [
    mine != null ? el('span', `${mineLabel} ${fmtDec(mine * 100)} %`) : null,
    need != null ? el('span', `${needLabel} ${fmtDec(need * 100)} %`) : null,
  ])]);
}

export function mount(props = {}) {
  const { setup = {} } = props;
  const min = setup.min ?? 0, max = setup.max ?? 100, step = setup.step ?? 1;
  const unit = setup.unit ?? '%';
  const root = el('div.tm-slider');
  const range = el('input.tm-range', { type: 'range', min, max, step, 'aria-label': setup.label || 'Ответ' });
  const input = el('input.tm-amount', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': setup.label || 'Ответ', enterkeyhint: 'done' });
  const mark = el('span.tm-mark', { hidden: '' });
  const bar = el('div.tm-bar');
  bar.append(el('span.tm-bar-fill'));
  const parse = (txt) => {
    const t = txt.replace(',', '.').replace(/[^\d.]/g, '');
    return t === '' || t === '.' ? null : Number(t);
  };
  const send = (v) => root._props.onChange(Math.min(max, Math.max(min, Math.round(v / step) * step)));
  range.addEventListener('input', () => send(Number(range.value)));
  input.addEventListener('input', () => { const n = parse(input.value); if (n != null) send(n); });
  input.addEventListener('blur', () => { input.value = fmt(root._props.value); });
  const fmt = (v) => (v == null ? '' : (Number.isInteger(v) ? fmtNum(v) : fmtDec(v, 1)));
  keepAboveKeyboard(input, root);
  root.append(sceneEl(setup), el('div.tm-betbox', [
    el('label.tm-amount-l', [el('span', setup.label || 'Ваш ответ'), el('span.tm-amount-wrap', [input, unit ? el('span.tm-unit', unit) : null])]),
    el('div.tm-rangebox', [range, mark]),
    el('div.tm-bounds', [el('span', `${fmt(min)}${unit === '%' ? ' %' : ''}`), el('span', `${fmt(max)}${unit === '%' ? ' %' : ''}`)]),
  ]));
  root._refs = { range, input, mark, min, max, fmt };
  update(root, props);
  return root;
}

export function update(root, props = {}) {
  const { value = null, disabled = false, result = null, onChange = () => {} } = props;
  root._props = { value, onChange };
  const { range, input, mark, min, max, fmt } = root._refs;
  range.value = value ?? min;
  if (document.activeElement !== input) input.value = fmt(value);
  range.disabled = input.disabled = !!disabled;
  const pct = (x) => ((x - min) / Math.max(1e-9, max - min)) * 100;
  range.style.setProperty('--tm-fill', `${value == null ? 0 : pct(value)}%`);
  const sol = typeof result?.solution === 'number' ? result.solution : null;
  mark.hidden = sol == null;
  if (sol != null) {
    mark.style.setProperty('--tm-at', `${Math.min(100, Math.max(0, pct(sol)))}%`);
    mark.textContent = fmt(sol);
    mark.setAttribute('aria-label', `Верно: ${fmt(sol)}`);
  }
}
