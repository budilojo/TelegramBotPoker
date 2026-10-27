/**
 * Экран после получения: что получено, переключатели применения, переход в инвентарь.
 * Попадаем сюда только после ответа сервера (index.js). Само получение выбор не меняет:
 * переключатели стоят в положении сервера и меняются только его ответом.
 */
import { itemById, itemsOfBundle } from './catalog.js';
import { DEMO_NOTE, itemTitle, thumb, WHEN, colorTitle, btn } from './item.js';

export function renderReceive(ctx) {
  const { h, store, snap } = ctx;
  const ids = ctx.route.ids.filter((x) => itemById(x)?.kind === 'item');
  const rows = ids.map((id) => {
    const it = itemById(id);
    const c = snap.choice[it.slot];
    const on = c?.item === id;
    const color = on ? c.color : ctx.color(id);
    const busy = snap.busy && (snap.busy.slot === it.slot);
    const toggle = h('button.col-switch', {
      type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'data-item': id,
      'aria-label': `Применить: ${it.title}`,
      disabled: (snap.busy || snap.link !== 'ok') ? true : null,
      'aria-busy': busy ? 'true' : null,
      onclick: () => (on ? store.clear(it.slot) : store.apply(it.slot, id, color)),
    }, h('span.col-switch-knob', { 'aria-hidden': 'true' }), h('span.col-sr', on ? 'Включено' : 'Выключено'));
    return h('li.col-recv-row',
      h('span.col-recv-art', thumb(h, id, color)),
      h('span.col-recv-body',
        h('span.col-recv-name', it.title),
        h('span.col-recv-sub', on ? (snap.pending[it.slot] ? WHEN[it.slot] : 'Применено') : `Цвет: ${colorTitle(color)} · не применено`)),
      toggle);
  });
  return h('div.col-recv',
    h('div.col-intro',
      h('div.col-eyebrow', 'Добавлено в коллекцию'),
      h('h2.col-big', ids.length > 1 ? 'Коллекция «Графит»' : itemTitle(ids[0])),
      h('span.col-demo', DEMO_NOTE),
      h('p.col-sub', 'Получение само ничего не включает. Включите переключатель, если хотите применить предмет.')),
    h('section.col-block', h('h3.col-cap', 'Состав'), h('ul.col-list.recv', rows)),
    h('div.col-actions',
      btn(h, { text: 'Перейти в инвентарь', cls: 'primary', onClick: () => ctx.replace({ name: 'inventory', tab: itemById(ids[0]).slot }) }),
      h('button.col-btn.secondary', { type: 'button', onclick: () => ctx.replace({ name: 'showcase' }) }, 'К витрине')));
}
void itemsOfBundle;
