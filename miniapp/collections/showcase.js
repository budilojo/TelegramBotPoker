/** Public storefront, including when sales are off. Prices come only from server offers. */
import { filteredItems, gameNames } from './shop-model.js';
import { badge, stateOf, thumb, slotTitle } from './item.js';
import { noteOf } from './state.js';
export function renderShowcase(ctx) {
  const { h, store, snap } = ctx;
  const items = filteredItems(ctx.filters);
  return h('div.col-show',
    h('div.col-intro', noteOf(snap) ? h('span.col-note', noteOf(snap)) : null,
      Object.values(snap.sources).some(s => s.includes('owner')) ? h('p.col-note', 'Доступ владельца · новые вещи бесплатно') : null),
    h('p.col-note', { role: 'status', 'data-result-count': items.length }, `Найдено: ${items.length}`),
    items.length ? h('div.col-grid', items.map(it => h(`button.col-card${it.kind === 'bundle' ? '.bundle' : ''}`, {
      type: 'button', 'data-item': it.id, onclick: () => ctx.go({ name: 'item', id: it.id }) },
      h('span.col-card-art', thumb(h, it.id, ctx.color(it.id))),
      h('span.col-card-body', h('span.col-card-name', it.title),
        h('span.col-card-sub', it.kind === 'bundle' ? `Комплект · ${it.includes.length} предметов` : slotTitle(it.slot)),
        h('span.col-card-sub', gameNames(it)), badge(h, stateOf(store, snap, it.id)),
        it.price === null ? h('span.col-card-price', 'Цена не утверждена') : null))))
      : h('div.col-empty', h('p', 'По этим фильтрам ничего нет.'), h('button.col-btn.secondary', { type: 'button', onclick: () => ctx.setFilters({ game: '', category: '', collection: '' }) }, 'Сбросить фильтры')),
    h('div.col-actions', h('button.col-btn.secondary', { type: 'button', onclick: () => ctx.go({ name: 'inventory' }) }, 'Мои вещи'),
      h('button.col-btn.secondary', { type: 'button', 'data-act': 'purchases', onclick: () => ctx.go({ name: 'purchases' }) }, 'Мои покупки и поддержка')));
}
