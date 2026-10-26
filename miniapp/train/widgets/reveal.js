/**
 * «Диапазон на матрице» в разборе: после ответа показывает диапазон(ы), о которых шла речь, а рука
 * из задания обведена рамкой. `reveal` — `{ grids: [{ title, ref, mark? }] }`, где `ref` в форме
 * ответа матрицы (массив рук или { рука: частота }). Первая матрица открыта, остальные свёрнуты.
 * Матрица только для чтения; перерисовки при нажатиях нет (строится один раз).
 */
import { el } from './dom.js';
import { mount as mountGrid } from './range-grid.js';
import { cellNote } from '../ranges/cell-note.js';

export function mount(reveal) {
  // Пустой диапазон (например, «Call с SB против CO» — SB там не коллирует) не рисуем: пустая матрица сбивает.
  const size = (r) => (Array.isArray(r) ? r.length : Object.keys(r || {}).length);
  const grids = reveal?.grids?.filter((g) => g && g.ref && size(g.ref) > 0) || [];
  if (!grids.length) return null;
  const root = el('div.tm-reveal');
  grids.forEach((g, i) => {
    const box = el('details.tm-reveal-item', { open: i === 0 ? '' : null }, el('summary', g.title || 'Диапазон'));
    box.append(mountGrid({ setup: { grid: { mode: 'readonly', ref: g.ref, mark: g.mark || [] } }, value: null, disabled: true }));
    // Нажатие на руку — короткий разбор: сколько комбинаций, входит ли в диапазон. Правит только эту строку.
    const note = el('p.tm-cell-note', { 'aria-live': 'polite' }, 'Нажмите на любую клетку — расскажу, входит ли рука в этот диапазон.');
    box.append(note);
    box.addEventListener('click', (e) => {
      const c = e.target.closest?.('[data-h]');
      if (!c) return;
      note.textContent = cellNote(c.dataset.h, g.ref, { title: g.title || 'диапазон' });
    });
    root.append(box);
  });
  return root;
}
