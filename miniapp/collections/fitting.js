/**
 * Примерка. Своё локальное состояние (цвет выбирается здесь и никуда не уходит): ни одного запроса к серверу,
 * текущая партия не меняется. Рубашка — на закрытых картах и в блоке «Так видят друзья»;
 * этот блок существует ТОЛЬКО здесь. Стол и профиль — на образцах.
 */
import { itemById, itemsOfBundle } from './catalog.js';
import { artImg } from './art.js';
import { swatches, colorTitle } from './item.js';

const backs = (h, color, n = 2, cls = '') => h(`div.col-backs${cls ? '.' + cls : ''}`, Array.from({ length: n }, () => artImg(h, 'cardback', color, { cls: 'card-s' })));

function sampleCardback(h, color) {
  return h('section.col-block',
    h('h3.col-cap', 'Рубашка'),
    h('div.col-hero', artImg(h, 'cardback', color, { detail: true, cls: 'hero-card' })),
    h('h3.col-cap', 'Закрытые карты за столом'),
    h('div.col-felt', backs(h, color, 2)),
    h('div.col-friends', { role: 'group', 'aria-label': 'Так видят друзья' },
      h('div.col-cap', 'Так видят друзья'),
      backs(h, color, 2)));
}

function sampleTable(h, color) {
  return h('section.col-block',
    h('h3.col-cap', 'Образец стола'),
    h('div.col-table', { 'aria-label': 'Образец стола' },
      artImg(h, 'table', color, { detail: true, cls: 'orn' }),
      artImg(h, 'table', color, { cls: 'dia' }),
      h('span.col-table-label', 'Банк 1.200')));
}

function sampleProfile(h, color) {
  return h('section.col-block',
    h('h3.col-cap', 'Образец профиля'),
    h('div.col-profile',
      h('span.col-ava', h('span.col-ava-in', 'В'), artImg(h, 'frame', color, { detail: false, cls: 'frame' })),
      h('span.col-pname', 'Вы', artImg(h, 'mark', color, { cls: 'mark' })),
      h('span.col-pstate', 'Лобби · итоги')));
}

export function renderFitting(ctx) {
  const { h } = ctx;
  const id = ctx.route.id;
  const it = itemById(id);
  if (!it) return h('div.col-empty', h('p', 'Такого предмета нет.'));
  const color = ctx.color(id);
  const slots = it.kind === 'bundle' ? itemsOfBundle(id).map((x) => itemById(x).slot) : [it.slot];
  return h('div.col-fit',
    h('p.col-note.strong', 'Это только примерка: она не меняет вашу партию и ничего не отправляет.'),
    h('section.col-block',
      h('h3.col-cap', `Цвет: ${colorTitle(color)}`),
      swatches(h, { value: color, onPick: (c) => ctx.setColor(id, c), label: 'Цвет примерки' })),
    slots.includes('cardback') ? sampleCardback(h, color) : null,
    slots.includes('table') ? sampleTable(h, color) : null,
    slots.includes('profile') ? sampleProfile(h, color) : null,
    h('div.col-actions', h('button.col-btn.secondary', { type: 'button', onclick: () => ctx.back() }, 'Назад к карточке')));
}
