/** Личная витрина без оплаты. Свои отметки и цена приходят только с сервера. */
import { h, $app, fmt, showSheet, closeSheet, currentSheet, toast, tg } from '../ui.js';
import { bus, send } from '../net.js';
import { ITEMS, SETS, itemById, itemsOfSet } from '../cosmetics/catalog.js';

// TEMP(L): включить после появления и проверки look.js + fitting.js агента M в git.
export const FITTING_READY = false;
const HONEST = 'Оплаты пока нет — мы проверяем, что вам интересно. Нажав «Хочу», вы ничего не покупаете.';
const KINDS = { cardback: 'Рубашка карт', felt: 'Сукно', frame: 'Рамка аватара', reaction: 'Реакция', effect: 'Эффект победы', title: 'Звание', bundle: 'Набор · 10 вещей' };
let opened = false, variant = null, wanted = new Set(), error = '', pendingView = null;
let grid = null, detail = null, fitting = null, current = null, selected = null, cleanupFitting = null;

export const isShopOpen = () => opened;
const request = (msg) => send({ t: 'shop', ...msg }, { lock: false });
export const reconnectShop = () => { if (opened) request({ op: 'mine' }); };

bus.onShop = (msg) => {
  error = msg.error?.text || '';
  if (!msg.error) { variant = msg.variant; wanted = new Set(msg.wanted); }
  patch();
  if (!msg.error && pendingView) {
    const id = pendingView; pendingView = null;
    request({ op: 'interest', item: id, action: 'view', variant });
  }
};

export function openShop() {
  opened = true; variant = null; error = ''; pendingView = null;
  grid = buildGrid(); detail = null; selected = null; current = grid;
  request({ op: 'mine' });
  bus.render();
  tg?.BackButton?.show?.();
}

export function resetShop() {
  cleanupFitting?.(); cleanupFitting = null;
  opened = false; grid = detail = fitting = current = selected = null; pendingView = null;
}

export function backShop() {
  if (!opened) return false;
  if (currentSheet() === 'shop-reset') { closeSheet(); return true; }
  closeSheet();
  if (fitting) {
    cleanupFitting?.(); cleanupFitting = null; fitting = null; current = detail;
  } else if (detail) { detail = null; selected = null; current = grid; }
  else { resetShop(); tg?.BackButton?.hide?.(); }
  bus.render();
  return true;
}

/** Живой скроллер сохраняется даже при обновлении серверного состояния. */
export function renderShop() {
  if (!current) return;
  if (current.isConnected) $app.append(h('div.lobby', { 'data-self': current.dataset.self }));
  else $app.append(current);
}

function header(title, back = '← Назад') {
  return h('div.shop-head', h('button.k-btn.k-btn--ghost', { onclick: backShop }, back), h('h1.k-section', title));
}
function note() { return h('p.shop-note', HONEST); }
function errorBox() { return h('div.shop-error', { role: 'alert' }, error); }
function price(item) { return h('div.shop-price.num', { 'data-price': item.id }, variant ? `${fmt(item.stars[variant])} Stars` : 'Цена загружается…'); }

// TEMP: до подключения картинок владельца берём готовые SVG без запросов отсутствующих PNG.
function art(item, large = false) {
  if (item.kind === 'title') return h('div.shop-art.shop-title', item.title);
  return h('img.shop-art', { src: item.placeholder, alt: '', draggable: 'false', ...(large ? {} : { loading: 'lazy' }) });
}

function wantButton(item) {
  return h('button.k-btn.k-btn--primary.shop-want', {
    'data-want': item.id, 'data-wanted': wanted.has(item.id) ? '1' : '0', disabled: !variant || wanted.has(item.id),
    onclick: () => request({ op: 'interest', item: item.id, action: 'want', variant }),
  }, wanted.has(item.id) ? 'Вы хотите ✓' : 'Хочу');
}

function patch() {
  for (const root of [grid, detail]) {
    if (!root) continue;
    for (const el of root.querySelectorAll('[data-price]')) {
      const item = itemById(el.dataset.price);
      el.textContent = variant ? `${fmt(item.stars[variant])} Stars` : 'Цена загружается…';
    }
    for (const el of root.querySelectorAll('[data-want]')) {
      el.disabled = !variant || wanted.has(el.dataset.want);
      el.dataset.wanted = wanted.has(el.dataset.want) ? '1' : '0';
      el.textContent = wanted.has(el.dataset.want) ? 'Вы хотите ✓' : 'Хочу';
    }
    root.querySelector('.shop-error').textContent = error;
  }
}

function openItem(item) {
  selected = item; error = '';
  detail = h('div.lobby.shop.shop-detail', { 'data-self': `shop-${item.id}` },
    header(item.title, '← Магазин'), errorBox(),
    h('div.shop-large-art', art(item, true)),
    h('div.shop-note', 'Временный эскиз · окончательные картинки готовятся'),
    h('div.shop-kind', KINDS[item.kind]), h('p', item.blurb),
    item.kind === 'bundle' ? h('ul.shop-contents', item.items.map((id) => h('li', itemById(id).title))) : null,
    price(item),
    h('div.shop-actions', h('button.k-btn.k-btn--secondary', { onclick: () => tryOn(item), disabled: !FITTING_READY }, 'Примерить'), wantButton(item)),
    !FITTING_READY ? h('p.shop-note', 'Примерочная готовится — скоро можно будет посмотреть вещь за столом.') : null,
    note(), h('p.shop-note', 'Примерку видите только вы, на этом телефоне. Она не меняет правила игры.'));
  current = detail;
  if (variant) request({ op: 'interest', item: item.id, action: 'view', variant });
  else pendingView = item.id;
  bus.render();
}

async function tryOn(item) {
  try {
    const [look, sample] = await Promise.all([import('../cosmetics/look.js'), import('../cosmetics/fitting.js')]);
    if (!opened || selected !== item) return;
    const patchLook = {};
    for (const piece of item.kind === 'bundle' ? item.items.map(itemById) : [item]) {
      if (piece.kind !== 'reaction' && !patchLook[piece.kind]) patchLook[piece.kind] = piece.id;
    }
    look.setLook(patchLook);
    const host = h('div.shop-fitting-host');
    fitting = h('div.lobby.shop.shop-fitting', { 'data-self': 'shop-fitting' },
      header('Примерочная', '← К вещи'),
      h('p.shop-note', 'Примерка только на этом телефоне. Оплаты нет.'), host);
    current = fitting; bus.render();
    const result = sample.renderFitting(host, { onBack: backShop, item });
    cleanupFitting = typeof result === 'function' ? result : null;
    if (item.kind === 'reaction') look.previewFor(item);
  } catch {
    toast('Примерочная пока недоступна. Попробуйте позже.');
  }
}

function confirmReset() {
  showSheet('shop-reset', () => h('div.shop-confirm',
    h('h3', 'Сбросить мои отметки?'),
    h('p', 'Удалим ваши просмотры и «Хочу» из счётчиков магазина. Примерка останется.'),
    h('div.shop-actions',
      h('button.k-btn.k-btn--secondary', { onclick: () => closeSheet() }, 'Отмена'),
      h('button.k-btn.k-btn--primary', { onclick: () => { closeSheet(); request({ op: 'reset', confirm: true }); } }, 'Сбросить'))));
}

function buildGrid() {
  return h('div.lobby.shop', { 'data-self': 'shop' },
    header('Магазин', '← Настройки'), h('p.shop-note', 'Отмечайте понравившееся. Оплаты нет.'), errorBox(),
    [...SETS].sort((a, b) => a.order - b.order).map((set) => h('section.shop-set',
      h('h2.k-section', set.title), h('p.shop-note', set.blurb),
      h('p.shop-note', 'Пока показываем эскизы. Примерка видна только вам.'),
      h('div.shop-grid', itemsOfSet(set.id).map((item) => h('article.shop-card',
        h('button.shop-item', { 'data-item': item.id, onclick: () => openItem(item), 'aria-label': item.title },
          art(item), h('span.shop-kind', KINDS[item.kind]), h('span.shop-name', item.title)),
        price(item), wantButton(item)))))),
    note(), h('button.k-btn.k-btn--secondary', { onclick: confirmReset }, 'Сбросить мои отметки'));
}

/** Пульт: карточки вместо широкой таблицы, чтобы всё помещалось на 320 px. */
export function demandReport(rows = []) {
  return h('section.shop-report', h('div.section-label', 'Магазин: спрос'),
    h('p.shop-note', 'Уникальные люди за всё время. Повторы не увеличивают счётчики; сброс удаляет свои данные. Доля «Хочу» — от просмотров.'),
    ITEMS.map((item) => h('div.box', h('h3.shop-name', item.title), ['a', 'b'].map((variant) => {
      const row = rows.find((r) => r.item === item.id && r.variant === variant);
      return h('div.shop-demand-row',
        h('b', `${variant.toUpperCase()} · ${fmt(item.stars[variant])} Stars`),
        h('span', `Просмотры: ${fmt(row?.views || 0)} · Хочу: ${fmt(row?.wants || 0)} · ${String(row?.percent || 0).replace('.', ',')} %`));
    }))), h('p.shop-note', 'При малом числе игроков проценты дают только подсказку. Это интерес, а не покупки.'));
}
