/**
 * Стол: места игроков, банк, борд, история ходов; для kind 'table' — ещё и
 * выбор действия.
 *
 * setup (общий вид «сцены», его понимают все виджеты X):
 *   hero:[карты], board:[карты], pot, bet?, stack?,
 *   seats:[{ pos:'BTN', name:'Вы', stack, bet?, hero?, folded?, dealer? }],
 *   history:['Префлоп: BTN рейз 3 BB, вы колл'], street?, mark?
 *
 * Ответ kind 'table' — id варианта из setup.options; для многоходовой раздачи
 * (setup.steps) — массив id по шагам (шаг открывается после ответа на прошлый).
 */
import { el, flag } from './dom.js';
import { cardEl } from './card-el.js';
import { mount as mountBoard } from './board.js';
import { mount as mountPot } from './pot.js';
import { fmtNum } from '../poker-math.js';

/** Одно место за столом. */
export function seatEl(s) {
  const root = el('div.tm-seat', { 'aria-label': `${s.name || s.pos}, стек ${fmtNum(s.stack ?? 0)}` });
  flag(root, 'hero', s.hero);
  flag(root, 'folded', s.folded);
  root.append(
    el('div.tm-seat-top', [
      el('span.tm-pos', s.pos || ''),
      el('span.tm-seat-name', s.name || ''),
      s.dealer ? el('span.tm-dealer', { 'aria-label': 'Дилер' }, 'D') : null,
    ]),
    el('div.tm-seat-stack', `Стек ${fmtNum(s.stack ?? 0)}`),
    s.bet ? el('div.tm-seat-bet', `Ставка ${fmtNum(s.bet)}`) : null,
  );
  return root;
}

/** Сцена задания: места, борд, банк, ваши карты, история. Без выбора ответа. */
export function sceneEl(setup = {}) {
  const root = el('div.tm-scene');
  if (setup.seats?.length) root.append(el('div.tm-seats', setup.seats.map(seatEl)));
  if (setup.board) root.append(mountBoard({ board: setup.board, street: setup.street, mark: setup.mark || [] }));
  const mid = el('div.tm-mid');
  if (setup.pot != null) mid.append(mountPot({ pot: setup.pot, bet: setup.bet ?? null, stack: setup.stack ?? null }));
  if (setup.hero?.length) mid.append(el('div.tm-hero', [el('span.tm-hero-k', 'Ваши карты'), el('div.tm-hero-cards', setup.hero.map((c) => cardEl(c)))]));
  root.append(mid);
  if (setup.history?.length) root.append(el('ol.tm-history', setup.history.map((t) => el('li', t))));
  return root;
}

function optionsEl(options, onPick) {
  return el('div.tm-options', { role: 'group' }, options.map((o) =>
    el('button.tm-opt', { type: 'button', 'data-id': o.id, onclick: () => onPick(o.id) }, o.label)));
}

/** Раскрасить кнопки на месте: выбранный, верный, неверный, недоступные. */
function paintOptions(group, value, locked, solution) {
  const ok = new Set(Array.isArray(solution) ? solution : solution != null ? [solution] : []);
  for (const b of group.querySelectorAll('.tm-opt')) {
    const id = b.dataset.id;
    b.setAttribute('aria-pressed', value === id ? 'true' : 'false');
    b.disabled = !!locked;
    flag(b, 'right', solution != null && ok.has(id));
    flag(b, 'wrong', solution != null && value === id && !ok.has(id));
  }
}

export function mount(props = {}) {
  const root = el('div.tm-table');
  update(root, props);
  return root;
}

/** Структура строится, только когда меняется задание или открылся новый шаг; нажатие красит кнопки на месте. */
export function update(root, props) {
  const { setup = {}, value = null, disabled = false, onChange = () => {}, result = null } = props;
  const picks = Array.isArray(value) ? value : [];
  const shown = setup.steps ? (result ? setup.steps.length : Math.min(setup.steps.length, picks.length + 1)) : 0;
  const key = `${result ? 'r' : 'q'}:${shown}`;
  if (root._setup !== setup || root._key !== key) {
    root._setup = setup; root._key = key;
    const frag = [sceneEl(setup)];
    if (setup.steps) {
      setup.steps.slice(0, shown).forEach((st, i) => {
        frag.push(el('section.tm-step', { 'data-step': i }, [
          el('h4.tm-step-h', st.title || `Решение ${i + 1}`),
          st.text ? el('p.tm-step-t', st.text) : null,
          st.board ? mountBoard({ board: st.board, street: st.street }) : null,
          st.pot != null ? mountPot({ pot: st.pot, bet: st.bet ?? null }) : null,
          optionsEl(st.options, (id) => {
            const cur = root._props.value;
            const next = (Array.isArray(cur) ? cur : []).slice(0, i);
            next[i] = id;
            root._props.onChange(next);
          }),
        ]));
      });
    } else if (setup.options) {
      frag.push(optionsEl(setup.options, (id) => root._props.onChange(id)));
    }
    root.replaceChildren(...frag);
  }
  root._props = { value, onChange };
  if (setup.steps) {
    root.querySelectorAll('.tm-step').forEach((sec) => {
      const i = Number(sec.dataset.step);
      paintOptions(sec.querySelector('.tm-options'), picks[i] ?? null, disabled || !!result || i < picks.length - 1, result ? result.solution?.[i] : null);
    });
  } else if (setup.options) {
    paintOptions(root.querySelector('.tm-options'), value, disabled, result ? result.solution : null);
  }
}
