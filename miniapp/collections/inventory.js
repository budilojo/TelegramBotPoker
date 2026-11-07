/** Inventory contains only server-confirmed rights. Slots remain independent. */
import { ITEMS, SLOTS, itemById } from './catalog.js';
import { baseArt } from './art.js';
import { thumb, btn, slotTitle, swatches, stateOf } from './item.js';
import { personal, gamesOf, sourceText } from './shop-model.js';
export function renderInventory(ctx) {
  const { h, snap, store } = ctx, game = ctx.filters.game;
  const slots = SLOTS.filter(slot => ITEMS.some(it => it.slot === slot && (!game || gamesOf(it).includes(game))));
  const owned = ITEMS.filter(it => it.kind === 'item' && snap.owned.includes(it.id) && (!game || gamesOf(it).includes(game)));
  const remaining = owned.filter(it => snap.choice[it.slot]?.item !== it.id);
  function card(it) {
    const color = ctx.color(it.id), same = snap.choice[it.slot]?.item === it.id && snap.choice[it.slot]?.color === color;
    const busy = !!snap.busy, locked = busy || snap.link !== 'ok' || (!!it.collection && snap.v !== 2);
    const st = stateOf(store, snap, it.id);
    return h(`article.col-inv${same ? '.on' : ''}`, { 'data-slot': it.slot, 'data-item': it.id },
      h('div.col-inv-head', h('span.col-inv-art', thumb(h, it.id, color)),
        h('div.col-inv-title', h('h3.col-inv-name', it.title), h('p.col-inv-sub', sourceText(snap.sources[it.id])))),
      h('div.col-inv-body',
        it.collection ? null : swatches(h, { value: color, onPick: c => ctx.setColor(it.id, c), label: `Цвет: ${it.title}` }),
        same ? h(`span.col-badge.${st.key}`, { role: 'status' }, st.text)
          : btn(h, { text: snap.choice[it.slot]?.item === it.id ? 'Сменить цвет' : 'Надеть', cls: 'primary', busy: snap.busy?.item === it.id, disabled: locked, onClick: () => store.apply(it.slot, it.id, color) }),
        same ? btn(h, { text: 'Снять', cls: 'secondary', disabled: locked, onClick: () => store.clear(it.slot) }) : null,
        h('p.col-note', snap.pending[it.slot] ? 'Применится со следующей партии' : 'В лобби — сразу; в начатой партии — со следующей партии'),
        btn(h, { text: 'Примерить', cls: 'secondary', onClick: () => ctx.go({ name: 'fit', id: it.id }) })));
  }
  const current = slot => {
    // Effective paired Graphit profile may supply either component until explicitly cleared.
    const entry = ['frame', 'badge'].includes(slot) ? snap.appearance[slot] : snap.choice[slot];
    const it = itemById(entry?.item);
    if (it && snap.owned.includes(it.id)) {
      if (it.slot === slot) return card(it);
      return h('article.col-inv', { 'data-slot': slot }, h('h3.col-inv-name', it.title),
        h('p.col-note', 'Часть знака «Графит»'), btn(h, { text: 'Снять', disabled: !!snap.busy || snap.link !== 'ok' || snap.v !== 2, onClick: () => store.clear(slot) }));
    }
    return h('article.col-inv.on', { 'data-slot': slot, 'data-base': '1' },
      h('div.col-inv-head', h('span.col-inv-art', baseArt(h, '1 / 1')), h('h3.col-inv-name', 'Классика')),
      h('span.col-badge.applied', '✓ Базовое оформление'),
      snap.pending[slot] ? h('p.col-note', 'Применится со следующей партии') : null);
  };
  return h('div.col-inventory',
    h('p.col-note.strong', 'Личное оформление видят другие игроки. Общий стол выбирает хост. Вы можете сочетать разные коллекции.'),
    h('section.col-block', h('h2.col-name', 'Надето сейчас'), slots.map(slot => h('section.col-block',
      h('h3.col-cap', `${slotTitle(slot)} · ${personal(slot) ? 'Личное' : 'Общая тема хоста'}`), current(slot)))),
    !owned.length ? h('div.col-empty', h('p', 'Пока у вас только базовое оформление — оно всегда доступно.'))
      : remaining.length ? h('section.col-block', h('h2.col-name', 'Ваши вещи'), remaining.map(card)) : null,
    h('div.col-actions', snap.shopEnabled
      ? btn(h, { text: 'Открыть коллекции', cls: 'secondary', onClick: () => ctx.replace({ name: 'showcase' }) })
      : btn(h, { text: 'Мои покупки и поддержка', cls: 'secondary', onClick: () => ctx.go({ name: 'purchases' }) })));
}
