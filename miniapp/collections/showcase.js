/**
 * Витрина коллекции «Графит»: три предмета и комплект, отметки владения.
 * Без оплаты: кнопок «купить» здесь нет, цены — демонстрационные и с пометкой.
 */
import { COLLECTION, ITEMS } from './catalog.js';
import { badge, stateOf, thumb, priceNote, slotTitle } from './item.js';
import { noteOf } from './state.js';

export function renderShowcase(ctx) {
  const { h, store, snap } = ctx;
  const card = (it) => {
    const st = stateOf(store, snap, it.id);
    return h(`button.col-card${it.kind === 'bundle' ? '.bundle' : ''}`, { type: 'button', 'data-item': it.id, onclick: () => ctx.go({ name: 'item', id: it.id }) },
      h('span.col-card-art', thumb(h, it.id, ctx.color(it.id))),
      h('span.col-card-body',
        h('span.col-card-name', it.title),
        it.kind === 'item' ? h('span.col-card-sub', slotTitle(it.slot)) : h('span.col-card-sub', 'Рубашка, стол и знак'),
        badge(h, st),
        snap.demo ? h('span.col-card-price', priceNote(it)) : null));
  };
  const items = ITEMS.filter((x) => x.kind === 'item');
  const bundle = ITEMS.find((x) => x.kind === 'bundle');
  return h('div.col-show',
    h('div.col-intro',
      h('div.col-eyebrow', 'Коллекция'),
      h('h2.col-big', COLLECTION.title),
      h('p.col-sub', 'Четыре цвета в каждом предмете. Выбирайте и меняйте в любой момент.'),
      noteOf(snap) ? h('span.col-demo', noteOf(snap)) : null),
    h('div.col-grid', items.map(card)),
    bundle ? card(bundle) : null,
    h('div.col-actions',
      h('button.col-btn.secondary', { type: 'button', onclick: () => ctx.go({ name: 'inventory', tab: 'cardback' }) }, 'Моя коллекция'),
      snap.demo ? null : h('button.col-btn.secondary', { type: 'button', 'data-act': 'purchases', onclick: () => ctx.go({ name: 'purchases' }) }, 'Мои покупки и поддержка')));
}
