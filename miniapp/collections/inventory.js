/**
 * Инвентарь: вкладки «Карты», «Столы», «Профиль»; база и полученное; цвет; применение и возврат к базе.
 * Подтверждение выбора — только после ответа сервера: до него остаётся прежняя отметка.
 */
import { BASE, ITEMS, itemById } from './catalog.js';
import { baseArt } from './art.js';
import { SLOT_TABS, WHEN, swatches, thumb, btn, itemTitle, colorTitle, stateOf } from './item.js';

const BASE_RATIO = { cardback: '200 / 280', table: '4 / 3', profile: '1 / 1' };

function baseCard(ctx, slot) {
  const { h, store, snap } = ctx;
  const active = snap.choice[slot] == null;
  const busy = snap.busy?.op === 'clear' && snap.busy.slot === slot;
  return h(`article.col-inv${active ? '.on' : ''}`, { 'data-slot': slot, 'data-base': '1' },
    h('div.col-inv-head',
      h('span.col-inv-art', baseArt(h, BASE_RATIO[slot])),
      h('div.col-inv-title', h('h3.col-inv-name', BASE[slot].title), h('p.col-inv-sub', 'Базовое · бесплатно'))),
    h('div.col-inv-body',
      active ? h('span.col-badge.applied', '✓ Применено')
        : btn(h, { text: 'Вернуть базовое', cls: 'secondary', busy, disabled: !!snap.busy || snap.link !== 'ok', onClick: () => store.clear(slot) })));
}

function ownedCard(ctx, it) {
  const { h, store, snap } = ctx;
  const slot = it.slot;
  const c = snap.choice[slot];
  const mine = c?.item === it.id;
  const color = ctx.color(it.id);
  const same = mine && c.color === color;
  const busy = snap.busy?.op === 'apply' && snap.busy.item === it.id;
  const st = stateOf(store, snap, it.id);
  return h(`article.col-inv${mine ? '.on' : ''}`, { 'data-slot': slot, 'data-item': it.id },
    h('div.col-inv-head',
      h('span.col-inv-art', thumb(h, it.id, mine ? c.color : color)),
      h('div.col-inv-title', h('h3.col-inv-name', it.title), h('p.col-inv-sub', `В вашей коллекции · ${colorTitle(color)}`))),
    h('div.col-inv-body',
      swatches(h, { value: color, onPick: (x) => ctx.setColor(it.id, x), label: `Цвет: ${it.title}` }),
      same
        ? h('span.col-badge.' + st.key, { role: 'status' }, (st.key === 'pending' ? '◷ ' : '✓ ') + st.text)
        : btn(h, { text: mine ? 'Сменить цвет' : 'Применить', cls: 'primary', busy, disabled: !!snap.busy || snap.link !== 'ok', onClick: () => store.apply(slot, it.id, color) }),
      !same ? h('p.col-note', WHEN[slot]) : null));
}

function lockedCard(ctx, it) {
  const { h } = ctx;
  return h('article.col-inv.locked', { 'data-slot': it.slot, 'data-item': it.id },
    h('div.col-inv-head',
      h('span.col-inv-art', thumb(h, it.id, ctx.color(it.id))),
      h('div.col-inv-title', h('h3.col-inv-name', it.title), h('p.col-inv-sub', 'Ещё не в вашей коллекции'))),
    h('div.col-inv-body',
      h('button.col-btn.secondary', { type: 'button', onclick: () => ctx.go({ name: 'item', id: it.id }) }, 'Открыть карточку')));
}

export function renderInventory(ctx) {
  const { h, store, snap } = ctx;
  const tab = SLOT_TABS.some(([s]) => s === ctx.route.tab) ? ctx.route.tab : 'cardback';
  const none = snap.owned.length === 0;
  const tabs = h('div.col-tabs', { role: 'tablist', 'aria-label': 'Разделы инвентаря' },
    SLOT_TABS.map(([slot, label]) => h('button.col-tab', {
      type: 'button', role: 'tab', id: `col-tab-${slot}`, 'aria-selected': slot === tab ? 'true' : 'false', 'aria-controls': 'col-tabpanel',
      onclick: () => ctx.replace({ name: 'inventory', tab: slot }),
    }, label)));
  const own = ITEMS.filter((x) => x.kind === 'item' && x.slot === tab);
  const panel = h('div.col-tabpanel', { role: 'tabpanel', id: 'col-tabpanel', 'aria-labelledby': `col-tab-${tab}` },
    baseCard(ctx, tab),
    own.map((it) => (store.own(it.id) ? ownedCard(ctx, it) : lockedCard(ctx, it))),
    none ? h('div.col-empty',
      h('p', 'Пока у вас только базовое оформление — оно всегда доступно.'),
      h('p.col-note', 'Предметы коллекции можно получить для демонстрации на витрине.'),
      h('button.col-btn.primary', { type: 'button', onclick: () => ctx.replace({ name: 'showcase' }) }, 'Открыть коллекции')) : null);
  void itemById; void itemTitle;
  return h('div.col-inventory', tabs, panel,
    none ? null : h('div.col-actions', h('button.col-btn.secondary', { type: 'button', onclick: () => ctx.replace({ name: 'showcase' }) }, 'Открыть коллекции')));
}
