/**
 * kind 'cards': «коснитесь карт-аутов». Показывает сцену (ваши карты, борд),
 * ниже — набор карт-кандидатов `setup.pool` (нужные и ловушки); касание
 * отмечает/снимает карту. Ответ — отсортированный массив карт (целые 0…51).
 * `result.solution` — массив верных карт: в разборе видно, какие отмечены
 * верно (ok), пропущены (miss), лишние (extra). Всё — правкой классов на месте.
 */
import { el, flag } from './dom.js';
import { cardEl } from './card-el.js';
import { sceneEl } from './table-seat.js';
import { cardName } from '../poker-math.js';

export function mount(props = {}) {
  const { setup = {} } = props;
  const root = el('div.tm-cards');
  const pool = el('div.tm-pool', { role: 'group', 'aria-label': 'Выберите карты' });
  for (const c of setup.pool || []) {
    pool.append(el('button.tm-pick', {
      type: 'button', 'data-card': c, 'aria-pressed': 'false', 'aria-label': cardName(c),
      onclick: () => {
        const cur = new Set(root._props.value || []);
        if (cur.has(c)) cur.delete(c); else cur.add(c);
        root._props.onChange([...cur].sort((a, b) => a - b));
      },
    }, cardEl(c)));
  }
  root.append(sceneEl(setup), el('div.tm-pool-cap', setup.hint || 'Коснитесь нужных карт'), pool, el('div.tm-count'));
  root._refs = { pool };
  update(root, props);
  return root;
}

export function update(root, props = {}) {
  const { value = [], disabled = false, result = null, onChange = () => {} } = props;
  root._props = { value, onChange };
  const chosen = new Set(value || []);
  const sol = new Set(Array.isArray(result?.solution) ? result.solution : []);
  for (const b of root._refs.pool.querySelectorAll('.tm-pick')) {
    const c = Number(b.dataset.card);
    b.setAttribute('aria-pressed', chosen.has(c) ? 'true' : 'false');
    b.disabled = !!disabled || !!result;
    flag(b, 'on', chosen.has(c));
    flag(b, 'ok', !!result && chosen.has(c) && sol.has(c));
    flag(b, 'extra', !!result && chosen.has(c) && !sol.has(c));
    flag(b, 'miss', !!result && !chosen.has(c) && sol.has(c));
  }
  root.querySelector('.tm-count').textContent = `Отмечено: ${chosen.size}`;
}
