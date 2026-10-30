/**
 * Покупка на карточке, «Мои покупки» и документы. Логика — pay.js (чистая), здесь только экраны.
 * Путь: вещь → «Примерить» → состав, цена, условия → «Купить» → окно Telegram → «Куплено» → «Надеть».
 * Цена — только та, что прислал сервер; без цены кнопки «Купить» нет.
 */
import { itemById, itemsOfBundle } from './catalog.js';
import { ORDER_STATE } from './pay-protocol.js';
import { PAY_TEXT } from './pay.js';

const stars = (n) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} ⭐`;
const DOCS = [['terms-of-purchase', 'Условия покупки'], ['refund-rules', 'Правила возврата'], ['privacy-policy', 'Политика данных']];

/** Блок покупки на карточке (вещь ещё не своя). */
export function buyBlock(ctx, it) {
  const { h, snap, pay } = ctx;
  const shop = snap.shop;
  const out = [];
  const ids = it.kind === 'bundle' ? itemsOfBundle(it.id) : [it.id];
  const have = ids.filter((x) => snap.owned.includes(x));
  if (have.length) {
    out.push(h('p.col-note', { role: 'status' }, `Уже есть: ${have.map((x) => itemById(x).title).join(', ')}. Комплект целиком сейчас не продаётся — купите недостающие вещи по одной, из состава ниже.`));
    return out;
  }
  const price = shop?.open ? shop.offers?.[it.id]?.price : null;
  if (!price) {
    out.push(h('p.col-note', { role: 'status' }, shop?.open ? 'Эта вещь пока не продаётся.' : 'Покупки пока закрыты. Примерить можно.'));
    return out;
  }
  const ph = pay.phase;
  const mine = ph.item === it.id;
  const busy = pay.busy();
  out.push(h('section.col-block.col-buy', { 'aria-label': 'Покупка' },
    h('h3.col-cap', 'Что вы получаете'),
    h('ul.col-terms',
      h('li', it.kind === 'bundle' ? 'Три вещи: рубашка, стол и знак профиля' : it.title),
      h('li', 'Пока работает приложение, все 4 цвета — меняйте когда угодно'),
      h('li', 'Только оформление: на ходы, шансы, время и рейтинг не влияет'),
      h('li', 'Возврат полностью звёздами при ошибке, двойной оплате или если вещь не появилась')),
    h('p.col-price-line', h('span.col-price-big', stars(price)), shop.test ? h('span.col-tag', 'Тестовая среда') : null),
    h('div.col-doc-links', DOCS.slice(0, 2).map(([id, title]) => h('button.col-btn.ghost', { type: 'button', 'data-doc': id, onclick: () => ctx.go({ name: 'doc', id }) }, title))),
    h('p.col-note', `Нажимая «Купить», вы подтверждаете, что прочитали и принимаете Условия покупки версии ${shop.terms || '—'}.`),
    h('button.col-btn.primary', {
      type: 'button', 'data-act': 'buy', disabled: busy || snap.link !== 'ok' ? true : null, 'aria-busy': mine && busy ? 'true' : null,
      onclick: () => pay.buy(it.id),
    }, !mine || !busy ? `Купить за ${stars(price)}` : ph.name === 'asking' ? PAY_TEXT.asking : ph.name === 'invoice' ? 'Окно оплаты открыто' : 'Ждём подтверждения…'),
    h('p.col-note', `Оплата — окном Telegram. Условия версии ${shop.terms || '—'}.`)));
  if (mine && ph.name !== 'idle' && ph.name !== 'asking') {
    const text = ph.name === 'confirming' ? (ph.slow ? PAY_TEXT.slow : PAY_TEXT.confirming) : ph.name === 'invoice' ? PAY_TEXT.invoice : ph.text;
    out.push(h(`div.col-pay-status.${ph.name}`, { role: ph.name === 'error' || ph.name === 'failed' ? 'alert' : 'status' },
      h('span', text),
      ph.order ? h('span.col-note', `Заказ ${ph.order}`) : null,
      ph.name === 'confirming' && ph.slow ? h('button.col-btn.secondary', { type: 'button', onclick: () => ctx.go({ name: 'purchases' }) }, 'Поддержка') : null));
  }
  return out;
}

/** «Мои покупки»: номер, вещь, сумма, дата, состояние; кнопка поддержки. */
export function renderPurchases(ctx) {
  const { h, pay } = ctx;
  const list = pay.history;
  const sup = pay.support;
  const rows = list == null ? h('div.col-skel', { 'aria-busy': 'true', 'aria-label': 'Загрузка' }, h('div.col-skel-block'), h('div.col-skel-block'))
    : list.length === 0 ? h('div.col-empty', h('p', 'Покупок пока нет.'))
      : h('ul.col-list', list.map((o) => (o.state === 'gift'
        // Выдано владельцем: не покупка — ни цены, ни номера заказа, только пометка.
        ? h('li.col-order', { 'data-gift': o.id },
          h('span.col-row-title', itemById(o.item)?.title || o.item),
          h('span.col-order-meta', new Date(o.at).toLocaleDateString('ru-RU')),
          h('span.col-badge.owned', ORDER_STATE.gift))
        : h('li.col-order', { 'data-order': o.id },
          h('span.col-row-title', itemById(o.item)?.title || o.item),
          h('span.col-order-meta', `${stars(o.price)} · ${new Date(o.at).toLocaleDateString('ru-RU')}${o.test ? ' · тест' : ''}`),
          h('span.col-order-meta', `Заказ ${o.id}`),
          h('span.col-badge.' + (o.state === 'paid' ? 'owned' : 'partial'), ORDER_STATE[o.state] || o.state)))));
  return h('div.col-purchases',
    h('section.col-block', h('h3.col-cap', 'Мои покупки'), rows),
    h('section.col-block',
      h('h3.col-cap', 'Поддержка'),
      h('p.col-note', 'Если вещь не появилась, списалось дважды или нужен возврат — нажмите кнопку: бот пришлёт в личку контакт поддержки и номера ваших заказов. То же — командой /paysupport.'),
      h('button.col-btn.secondary', { type: 'button', 'data-act': 'support', disabled: ctx.snap.link !== 'ok' ? true : null, onclick: () => pay.askSupport() }, 'Написать в поддержку'),
      sup ? h('p.col-note', { role: 'status' }, sup.text) : null,
      pay.bot ? h('button.col-btn.secondary', { type: 'button', 'data-act': 'support-chat', onclick: () => window.Telegram?.WebApp?.openTelegramLink?.(`https://t.me/${pay.bot}?start=support`) }, 'Написать в поддержку — чат с ботом') : null),
    h('section.col-block', h('h3.col-cap', 'Документы'),
      h('div.col-doc-links', DOCS.map(([id, title]) => h('button.col-btn.ghost', { type: 'button', 'data-doc': id, onclick: () => ctx.go({ name: 'doc', id }) }, title)))));
}

/** Текст документа как есть (без разметки), со статусом. Проект называется проектом. */
export function renderDoc(ctx) {
  const { h, pay } = ctx;
  const d = pay.terms?.[ctx.route.id];
  if (!pay.terms) return h('div.col-skel', { 'aria-busy': 'true', 'aria-label': 'Загрузка' }, h('div.col-skel-block.tall'));
  if (!d) return h('div.col-empty', h('p', 'Документ не найден.'));
  const draft = !/^Действует(?![А-Яа-яЁё])/.test(d.status || '');
  return h('div.col-doc',
    draft ? h('p.col-note.strong', { role: 'note' }, 'Это проект документа: он ещё не действует.') : null,
    h('p.col-note', `Версия ${d.version || '—'}`),
    h('pre.col-doc-text', d.text.replace(/\*\*|`/g, '')));
}

export const docTitle = (id) => DOCS.find(([x]) => x === id)?.[1] || 'Документ';
