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
import { mount as mountGrid } from './range-grid.js';

const POSITIONS = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];

/** Позиции за столом шестиместного стола: вы, открывший рейзом, дилер. Картинка к тексту задания. */
function positionsEl({ hero, position, opener, openTo, you }) {
  // `you` — вы сидите здесь, а `opener` — тот, на кого смотрим (его диапазон закрашивают): 3-бет, чтение диапазона.
  const me = you || (typeof hero === 'string' ? hero : position);
  const row = el('div.tm-positions', { role: 'group', 'aria-label': 'Позиции за столом' });
  for (const p of POSITIONS) {
    const mark = p === me ? 'вы' : p === opener ? (you ? '3-бет' : openTo ? `рейз ${fmtNum(openTo)}` : 'рейз') : p === 'BTN' ? 'дилер' : '';
    const chip = el(`div.tm-pos-chip${p === me ? '.me' : ''}${p === opener ? '.op' : ''}`, { 'aria-label': `${p}${mark ? `, ${mark}` : ''}` }, el('b', p), mark ? el('small', mark) : null);
    row.append(chip);
  }
  return row;
}

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
    ...(s.bet ? [el('div.tm-seat-bet', `Ставка ${fmtNum(s.bet)}`)] : []),
  );
  return root;
}

/**
 * Сцена задания: места, борд, банк, ваши карты, история. Без выбора ответа.
 * Понимает обе записи: `hero:[карты]` (математика) и `hole:[карты]` + `hero:'BTN'` (префлоп,
 * стек и банк в BB). `grid` — показать готовую матрицу `setup.grid` (режим readonly).
 */
export function sceneEl(setup = {}, { grid = false } = {}) {
  const root = el('div.tm-scene');
  const cards = Array.isArray(setup.hero) ? setup.hero : Array.isArray(setup.hole) ? setup.hole : null;
  if (typeof setup.hero === 'string' || setup.position || setup.opener || setup.you) root.append(positionsEl(setup));
  if (setup.seats?.length) root.append(el('div.tm-seats', setup.seats.map(seatEl)));
  if (setup.board) root.append(mountBoard({ board: setup.board, street: setup.street, mark: setup.mark || [] }));
  const mid = el('div.tm-mid');
  if (setup.stackBB != null && setup.pot != null) {
    mid.append(el('div.tm-pot.bb', { role: 'group', 'aria-label': 'Банк в больших блайндах' },
      el('span.tm-pot-main', el('span.tm-pot-k', 'Банк'), el('b', `${fmtNum(setup.pot)} BB`)),
      setup.toCall ? el('span.tm-pot-bet', el('span.tm-pot-k', 'Доплатить'), el('b', `${fmtNum(setup.toCall)} BB`)) : null,
      el('span.tm-pot-stack', el('span.tm-pot-k', 'Стек'), el('b', `${fmtNum(setup.stackBB)} BB`))));
  } else if (setup.pot != null) mid.append(mountPot({ pot: setup.pot, bet: setup.bet ?? null, stack: setup.stack ?? null }));
  if (cards?.length) mid.append(el('div.tm-hero', [el('span.tm-hero-k', 'Ваши карты'), el('div.tm-hero-cards', cards.map((c) => cardEl(c)))]));
  root.append(mid);
  if (typeof setup.history === 'string') root.append(el('p.tm-hist', setup.history));
  else if (setup.history?.length) root.append(el('ol.tm-history', setup.history.map((t) => el('li', t))));
  if (grid && setup.grid?.mode === 'readonly') root.append(el('div.tm-grid', mountGrid({ setup: { grid: setup.grid }, value: null, disabled: true })));
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
