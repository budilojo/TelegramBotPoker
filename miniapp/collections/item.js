/**
 * Карточка предмета или комплекта и общие детали экранов коллекций
 * (переключатель цвета, отметки, кнопки, подписи). Остальные экраны берут их отсюда.
 *
 * Выбранный цвет понятен без различения цвета: светлый нейтральный контур + галочка + слово «выбран».
 * Цены — демонстрационные (SPEC), только в демо и всегда с пометкой.
 */
import { COLORS, COLLECTION, BASE, itemById, itemsOfBundle } from './catalog.js';
import { artImg } from './art.js';
import { DEMO_NOTE } from './state.js';
export { DEMO_NOTE };
export const SLOT_TABS = [['cardback', 'Карты'], ['table', 'Столы'], ['profile', 'Профиль']];

export const colorTitle = (id) => COLORS.find((c) => c.id === id)?.title || '';

/** Назначение — одной фразой. Рубашка — только для покера. */
export const PURPOSE = {
  cardback: 'Рубашка закрытых карт за покерным столом. Друзья видят оформление ваших закрытых карт.',
  table: 'Оформление стола, который создаёте вы: покер и дурак. Его видят все за этим столом.',
  profile: 'Рамка аватара и знак рядом с именем в лобби и в итогах игры. Их видят участники.',
  bundle: 'Три предмета одной коллекции: рубашка, стол и знак профиля.',
};
export const WHERE = { cardback: 'Покер', table: 'Покер и дурак', profile: 'Лобби и итоги' };
export const WHEN = {
  cardback: 'Применится со следующей раздачи',
  table: 'Применится со следующей раздачи',
  profile: 'Применится сразу',
};

export const slotTitle = (slot) => SLOT_TABS.find(([s]) => s === slot)?.[1] || '';
export const itemTitle = (id) => itemById(id)?.title || id;

/** Короткая вещь: «99 Stars · демонстрационная цена». Цена из каталога, ничего не придумываем. */
export const priceNote = (it) => `${it.price} Stars · цена демонстрационная`;

/** Отметка состояния предмета для витрины и карточки. */
export function stateOf(store, snap, id) {
  const it = itemById(id);
  if (!it) return { key: 'none', text: '' };
  if (it.kind === 'bundle') {
    const have = itemsOfBundle(id).filter((x) => snap.owned.includes(x)).length;
    const all = itemsOfBundle(id).length;
    if (have === all) return { key: 'owned', text: 'В вашей коллекции' };
    if (have > 0) return { key: 'partial', text: `Получено ${have} из ${all}` };
    return { key: 'free', text: 'Доступно' };
  }
  const c = snap.choice[it.slot];
  if (c?.item === id) return snap.pending[it.slot] ? { key: 'pending', text: WHEN[it.slot] } : { key: 'applied', text: 'Применено' };
  if (snap.owned.includes(id)) return { key: 'owned', text: 'В вашей коллекции' };
  return { key: 'free', text: 'Доступно' };
}

/** Плашка-отметка. Значок в тексте — чтобы состояние не держалось на цвете. */
export function badge(h, state) {
  const mark = { owned: '✓ ', applied: '✓ ', pending: '◷ ', partial: '◐ ', free: '' }[state.key] || '';
  return h(`span.col-badge.${state.key}`, mark + state.text);
}

/** Одна из четырёх подписанных кнопок цвета; выбранная — контур и галочка. */
export function swatches(h, { value, onPick, disabled = false, label = 'Цвет', owned = 'Входит в предмет' }) {
  const group = h('div.col-swatches', { role: 'radiogroup', 'aria-label': label });
  for (const c of COLORS) {
    const on = c.id === value;
    const b = h('button.col-sw', {
      type: 'button',
      role: 'radio',
      'aria-checked': on ? 'true' : 'false',
      'data-color': c.id,
      disabled: disabled || null,
      onclick: () => { if (!on) onPick(c.id); },
    },
    h('span.col-sw-chip', { style: { background: c.bg, '--ink': c.ink }, 'aria-hidden': 'true' }),
    h('span.col-sw-name', c.title),
    h('span.col-check', { 'aria-hidden': 'true', html: on ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' : '' }),
    on ? h('span.col-sr', ' (выбран)') : null);
    group.append(b);
  }
  void owned;
  return group;
}

/** Кнопка с занятостью: пока ждём ответ — «Ждём ответ…», повторное нажатие невозможно. */
export function btn(h, { text, cls = '', onClick, disabled = false, busy = false, aria }) {
  return h(`button.col-btn${cls ? '.' + cls : ''}`, {
    type: 'button',
    disabled: disabled || busy || null,
    'aria-busy': busy ? 'true' : null,
    'aria-disabled': disabled || busy ? 'true' : null,
    onclick: (e) => { if (disabled || busy) return e.preventDefault(); onClick?.(e); },
    ...(aria ? { 'aria-label': aria } : {}),
  }, busy ? 'Ждём ответ сервера…' : text);
}

/** Картинка предмета (миниатюра) в выбранном цвете. */
export function thumb(h, id, color) {
  const it = itemById(id);
  if (!it) return artImg(h, 'x', color, {});
  const kind = it.kind === 'bundle' ? 'bundle' : `thumb-${it.slot}`;
  return artImg(h, kind, color, { cls: `thumb-${it.kind === 'bundle' ? 'bundle' : it.slot}` });
}

/** Крупная картинка предмета. */
export function hero(h, id, color) {
  const it = itemById(id);
  if (it?.kind === 'bundle') return artImg(h, 'bundle', color, { cls: 'hero-bundle' });
  if (it?.slot === 'cardback') return artImg(h, 'cardback', color, { detail: true, cls: 'hero-card' });
  if (it?.slot === 'table') return artImg(h, 'thumb-table', color, { cls: 'hero-table' });
  return artImg(h, 'frame', color, { detail: true, cls: 'hero-frame' });
}

/** Состав комплекта: три строки с отметкой «в коллекции / не получено». */
export function composition(h, snap, onOpen) {
  return h('ul.col-list', itemsOfBundle('graphit-bundle').map((id) => {
    const owned = snap.owned.includes(id);
    return h('li', h('button.col-row', { type: 'button', onclick: () => onOpen(id) },
      h('span.col-row-title', itemTitle(id)),
      h('span.col-row-state', owned ? '✓ В вашей коллекции' : 'Не получено')));
  }));
}

/** Описание карточки предмета; то, что одинаково для предмета и комплекта. */
export function facts(h, id) {
  const it = itemById(id);
  if (!it) return null;
  const slot = it.kind === 'bundle' ? 'bundle' : it.slot;
  return h('div.col-facts',
    h('p.col-purpose', PURPOSE[slot]),
    h('div.col-tags',
      h('span.col-tag', 'Навсегда'),
      it.kind === 'item' ? h('span.col-tag', WHERE[it.slot]) : null,
      h('span.col-tag', 'Все 4 цвета включены')));
}

export { BASE, COLLECTION };

/* ------------------------------------------------------------ экран карточки */

/**
 * Карточка предмета/комплекта. `ctx` — из index.js: { h, store, snap, go, color, setColor, route }.
 * Выдача — только запросом к серверу; успех покажет `index.js` после ответа (экран «Получено»).
 */
export function renderItem(ctx) {
  const { h, store, snap } = ctx;
  const id = ctx.route.id;
  const it = itemById(id);
  if (!it) return h('div.col-empty', h('p', 'Такого предмета нет.'));
  const color = ctx.color(id);
  const st = stateOf(store, snap, id);
  const bundle = it.kind === 'bundle';
  const own = store.own(id);
  const partial = bundle && st.key === 'partial';
  const waiting = !!snap.busy;
  const grantBusy = snap.busy?.op === 'grant' && snap.busy.item === id;
  const locked = snap.link !== 'ok' || !snap.visible;

  const actions = [];
  actions.push(btn(h, { text: 'Примерить', cls: 'secondary', onClick: () => ctx.go({ name: 'fit', id }), disabled: locked && !snap.loaded }));
  if (own) {
    actions.push(h('div.col-owned', { role: 'status' }, '✓ Уже в вашей коллекции'));
    actions.push(btn(h, { text: 'Открыть в инвентаре', cls: 'secondary', onClick: () => ctx.go({ name: 'inventory', tab: bundle ? 'cardback' : it.slot }) }));
  } else if (partial) {
    const miss = store.missing(id).map(itemTitle).join(', ');
    actions.push(h('p.col-note', { role: 'status' }, `Уже есть: ${itemsOfBundle(id).filter((x) => snap.owned.includes(x)).map(itemTitle).join(', ')}. Не хватает: ${miss}.`));
    actions.push(btn(h, { text: 'Получить комплект', disabled: true }));
    actions.push(h('p.col-note', 'Получить весь комплект сразу сейчас нельзя: цена дополнения комплекта ещё не утверждена. Получите недостающие предметы по одному — откройте их из состава ниже.'));
  } else {
    actions.push(btn(h, { text: 'Получить для демонстрации', cls: 'primary', busy: grantBusy, disabled: locked || waiting, onClick: () => ctx.grant(id) }));
    actions.push(h('p.col-note.demo', DEMO_NOTE));
  }

  return h('div.col-item',
    h('div.col-hero', hero(h, id, color)),
    h('div.col-titlebar', h('h2.col-name', it.title), badge(h, st)),
    facts(h, id),
    // Цвет: у комплекта его нет — у каждого предмета свой (внутри состава).
    bundle ? null : h('section.col-block',
      h('h3.col-cap', 'Цвет'),
      swatches(h, { value: color, onPick: (c) => ctx.setColor(id, c), label: `Цвет: ${it.title}` }),
      h('p.col-note', 'Выберите цвет — картинка изменится. Все 4 цвета входят в предмет, доплаты за цвет нет.')),
    bundle ? h('section.col-block',
      h('h3.col-cap', 'Состав'),
      composition(h, snap, (x) => ctx.go({ name: 'item', id: x }))) : null,
    snap.demo ? h('p.col-price', priceNote(it)) : null,
    h('div.col-actions', actions));
}
