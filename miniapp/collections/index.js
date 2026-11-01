/**
 * Коллекции: оболочка экранов (витрина → карточка → примерка → получение → инвентарь).
 *
 * Экраны лежат в своём слое поверх страницы (как шторка): серверное состояние страницы они не трогают,
 * партию не меняют. Слой создаётся один раз, прокручиваемый узел не пересоздаётся (docs/scroll.md):
 * при новом состоянии заменяется только содержимое внутри него.
 *
 * Основной вход — вкладка «Магазин»; за столом — пункт меню. Прежняя строка настроек
 * и ссылки collections ведут сюда же. Покупки и права подтверждает сервер, примерка локальная.
 */
import { h, haptic, trapFocus, syncLayers, focusMemo, restoreFocus } from '../ui.js';
import { net, bus, send } from '../net.js';
import { store, DEFAULT_COLOR } from './state.js';
import { itemById, itemsOfBundle, COLLECTIONS } from './catalog.js';
import { GAMES, CATEGORIES, filteredItems, collectionOf } from './shop-model.js';
import * as nav from '../nav.js';
import { renderShowcase } from './showcase.js';
import { renderItem, itemTitle, btn } from './item.js';
import { renderFitting } from './fitting.js';
import { renderInventory } from './inventory.js';
import { renderReceive } from './receive.js';
import { pay } from './pay.js';
import { renderPurchases, renderDoc, docTitle } from './purchase.js';

store.attach({ send: (m) => send(m, { lock: false }) });
bus.onCollections = (msg) => store.handle(msg);
/** Окно оплаты — только встроенное окно Telegram; нет метода — честный отказ, ничего не списано. */
const openInvoice = (url, cb) => {
  const wa = window.Telegram?.WebApp;
  if (typeof wa?.openInvoice !== 'function') return false;
  try { wa.openInvoice(url, cb); return true; } catch { return false; }
};
pay.attach({ send: (m) => send(m, { lock: false }), openInvoice });
bus.onPay = (msg) => pay.handle(msg);

let root = null; // { el, title, back, scroll, foot }
let stack = [];
let colors = {}; // черновик выбранного цвета по предмету (только у себя, на сервер не уходит)
let awaiting = null; // id, выдачу которого ждём: после ответа покажем «Получено»
let lastKey = '';
let wasVisible = false;
let entryChecked = false;
let filters = { game: '', category: '', collection: '' };
const positions = new Map();
const savePosition = () => { if (root && stack.length) { stack.at(-1).scroll = root.scroll.scrollTop; stack.at(-1).focus = document.activeElement?.closest('[data-item]')?.dataset.item; } };

const TITLES = { showcase: 'Магазин', item: 'Карточка', fit: 'Примерка', inventory: 'Мои вещи', receive: 'Получено', purchases: 'Мои покупки' };

export const isOpen = () => !!root;

/** Цвет предмета: выбранный на сервере, иначе черновик, иначе по умолчанию. */
function colorOf(id) {
  const it = itemById(id);
  const snap = store.snapshot();
  if (it?.collection) return 'default';
  if (it?.kind === 'item' && snap.choice[it.slot]?.item === id && !(id in colors)) return snap.choice[it.slot].color;
  return colors[id] || DEFAULT_COLOR;
}

const ctx = () => ({
  h, store, pay, snap: store.snapshot(), route: stack[stack.length - 1], filters,
  setFilters: (patch) => {
    filters = { ...filters, ...patch };
    if (patch.game !== undefined && filters.collection && !filteredItems({ game: filters.game, collection: filters.collection }).length) filters.collection = '';
    if ((patch.game !== undefined || patch.collection !== undefined) && filters.category && !filteredItems(filters).length) filters.category = '';
    stack.at(-1).scroll = 0; root.scroll.scrollTop = 0; draw(false);
  },
  setGame: (game) => { stack.at(-1).game = game; draw(false); },
  go: (r) => {
    savePosition(); awaiting = null; haptic.soft?.(); stack.push(r);
    if (r.name === 'purchases') pay.loadHistory();
    if (r.name === 'doc') pay.loadTerms();
    draw(true);
  },
  replace: (r) => { awaiting = null; stack[stack.length - 1] = r; draw(true); },
  back,
  color: colorOf,
  setColor: (id, c) => { colors[id] = c; draw(false); },
  grant: (id) => { if (store.grant(id)) awaiting = id; },
});

export function back() {
  awaiting = null;
  haptic.soft?.();
  if (stack.length > 1) { stack.pop(); draw(true); bus.syncBack(); } else close();
}

function build() {
  const el = h('div.col-root', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Магазин', onkeydown: (e) => trapFocus(e, el, back) });
  const backBtn = h('button.col-back', { type: 'button', 'aria-label': 'Назад', onclick: back, html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>' });
  const title = h('h1.col-title', { tabindex: '-1' });
  const scroll = h('div.col-scroll');
  const foot = h('div.col-foot');
  const returning = h('div.col-return');
  const navigation = h('div.col-navigation');
  el.append(h('header.col-head', backBtn, title, h('span.col-head-gap')), returning, scroll, foot, navigation);
  document.body.append(el);
  root = { el, title, back: backBtn, scroll, foot, returning, navigation };
}

function shopControls(c) {
  const { snap } = c;
  const select = (key, title, options) => h('label.col-filter', h('span', title), h('select', {
    'aria-label': title, 'data-filter': key, onchange: e => c.setFilters({ [key]: e.target.value }),
  }, options.map(([id, text]) => h('option', { value: id, selected: filters[key] === id }, text))));
  const scoped = filteredItems({ game: filters.game, collection: filters.collection });
  return h('div.col-controls',
    h('div.col-tabs', { 'aria-label': 'Магазин' }, [['showcase', 'Каталог'], ['inventory', 'Мои вещи']].map(([name, title]) => h('button.col-tab', {
      type: 'button', 'aria-pressed': String(c.route.name === name), onclick: () => {
        savePosition(); positions.set(c.route.name, c.route.scroll || 0); stack = [{ name, scroll: positions.get(name) || 0 }]; draw(true);
      },
    }, title))),
    select('game', 'Игра', [['', 'Все игры'], ...GAMES]),
    c.route.name === 'showcase' ? h('div.col-filters',
      select('category', 'Категория', [['', 'Все категории'], ...CATEGORIES.filter(([id]) => filteredItems({ category: id }, scoped).length)]),
      select('collection', 'Коллекция', [['', 'Все коллекции'], ...COLLECTIONS.filter(x => filteredItems({ game: filters.game }).some(it => collectionOf(it) === x.id)).map(x => [x.id, x.title])])) : null,
    !snap.visible && snap.loaded ? h('p.col-note', 'Магазин на этом сервере недоступен. Переоткройте Mini App или повторите позже.') : null);
}

function screenOf(c) {
  switch (c.route.name) {
    case 'item': return renderItem(c);
    case 'fit': return renderFitting(c);
    case 'inventory': return renderInventory(c);
    case 'receive': return renderReceive(c);
    case 'purchases': return renderPurchases(c);
    case 'doc': return renderDoc(c);
    default: return renderShowcase(c);
  }
}

/** Заглушка загрузки: те же размеры, что у настоящих карточек, чтобы экран не прыгал. */
function skeleton() {
  return h('div.col-skel', { 'aria-busy': 'true', 'aria-label': 'Загрузка' },
    h('div.col-skel-block.tall'), h('div.col-skel-block'), h('div.col-skel-block'), h('div.col-skel-block'));
}

function footNodes(snap) {
  const out = [];
  if (snap.link === 'offline') {
    out.push(h('div.col-alert', { role: 'alert' },
      h('span.col-alert-text', 'Нет связи — переподключаемся. Ничего не потеряно: показано последнее известное.'),
      snap.loaded ? null : h('button.col-btn.secondary', { type: 'button', onclick: () => store.retry() }, 'Повторить')));
  } else if (snap.error) {
    out.push(h('div.col-alert', { role: 'alert' },
      h('span.col-alert-text', snap.error.text),
      h('span.col-alert-actions',
        snap.error.again ? h('button.col-btn.secondary', { type: 'button', 'data-act': 'retry', onclick: () => store.retry() }, 'Повторить') : null,
        h('button.col-btn.ghost', { type: 'button', 'data-act': 'dismiss', onclick: () => store.dismissError() }, 'Закрыть'))));
  }
  return out;
}

function draw(routeChanged) {
  if (!root) return;
  const snap = store.snapshot();
  const c = ctx();
  const r = c.route;
  root.title.textContent = r.name === 'item' || r.name === 'fit' ? itemTitle(r.id) : r.name === 'doc' ? docTitle(r.id)
    : r.name === 'receive' && r.bought ? 'Куплено' : TITLES[r.name] || 'Коллекции';
  let body;
  if (!snap.loaded) {
    body = snap.link === 'offline'
      ? h('div.col-empty.offline', h('p', 'Нет связи с сервером.'), h('p.col-note', 'Коллекции появятся, когда связь вернётся. Ничего не выдано.'), btn(h, { text: 'Повторить', cls: 'primary', onClick: () => store.retry() }))
      : skeleton();
  } else body = screenOf(c);
  const key = `${r.name}|${r.id || ''}|${r.tab || ''}`;
  const previousScroll = root.scroll.scrollTop;
  const focused = document.activeElement;
  const control = focused?.closest('[data-filter],.col-tab,.col-btn,.col-back');
  const controlKey = control?.dataset.filter;
  const controlText = control?.textContent;
  const focus = focusMemo(root.scroll);
  root.scroll.replaceChildren(...(['showcase', 'inventory'].includes(r.name) ? [shopControls(c), body] : [body]));
  restoreFocus(root.scroll, focus);
  if (!routeChanged && control) {
    const target = controlKey ? root.scroll.querySelector(`[data-filter="${controlKey}"]`) : [...root.scroll.querySelectorAll('button')].find(b => b.textContent === controlText && !b.disabled);
    target?.focus({ preventScroll: true });
  }
  root.foot.replaceChildren(...footNodes(snap));
  if (root.el.contains(focused) === false && !routeChanged && focused !== document.body && !root.el.contains(document.activeElement)) root.title.focus({ preventScroll: true });
  root.el.dataset.route = r.name;
  root.el.dataset.link = snap.link;
  if (routeChanged || key !== lastKey) {
    root.scroll.scrollTop = r.scroll || 0;
    const target = r.focus && root.scroll.querySelector(`[data-item="${r.focus}"]`);
    (target || root.title).focus({ preventScroll: true });
  } else root.scroll.scrollTop = previousScroll;
  const room = net.state?.room;
  const inside = net.state?.lobbies?.find(l => l.inside);
  root.returning.replaceChildren(...(room || inside ? [h('button.col-btn.secondary', { type: 'button', 'data-act': 'return-table', onclick: () => { close(); if (!room && inside) send({ t: 'join', code: inside.code }); } }, 'Вернуться к столу')] : []));
  root.navigation.replaceChildren(...(nav.showsBar(net.state) ? [nav.bar(net.state, { active: 'shop', onPick: tab => { if (tab === 'shop') return; close(); nav.go(tab, net.state); } })] : []));
  lastKey = key;
}

/** Реакция на новое состояние: «Получено» после ответа сервера, закрытие при выключенном демо. */
function onStore() {
  const snap = store.snapshot();
  // Покупка подтверждается только состоянием сервера: вещь пришла в «owned» — тогда «Куплено».
  pay.sawOwned(snap.owned);
  if (wasVisible && !snap.visible) { close(); wasVisible = snap.visible; bus.render(); return; }
  if (wasVisible !== snap.visible) { wasVisible = snap.visible; bus.render(); }
  if (snap.loaded && net.state && !entryChecked) {
    entryChecked = true;
    if (snap.visible) {
      const match = location.hash.match(/^#\/?collections(?:\/(item|fit|inventory|showcase)(?:\/([a-z0-9-]+))?)?$/);
      const query = new URLSearchParams(location.search);
      if (match || query.has('collections')) open(match?.[1] && match[1] !== 'showcase' ? { name: match[1], id: match[2] } : null);
    }
  }
  if (!root) return;
  if (awaiting && !snap.busy && !snap.error) {
    // С ошибкой «ждём» остаётся: «Повторить» может ещё довести выдачу до «Получено». Уход с экрана сбрасывает ожидание.
    const id = awaiting;
    awaiting = null;
    if (store.own(id)) {
      const ids = itemsOfBundle(id).length ? itemsOfBundle(id) : [id];
      stack = [{ name: 'showcase' }, { name: 'receive', ids }];
      draw(true);
      return;
    }
  }
  draw(false);
}
store.subscribe(onStore);
window.addEventListener('hashchange', () => {
  if (!/^#\/?collections(?:\/|$)/.test(location.hash)) return;
  entryChecked = false;
  close();
  onStore();
});

/** Покупка: «Куплено» — после подтверждения сервера; остальное — перерисовать карточку. */
function onPay() {
  if (!root) return;
  const ph = pay.phase;
  if (ph.name === 'done') {
    const ids = itemsOfBundle(ph.item).length ? itemsOfBundle(ph.item) : [ph.item];
    pay.reset();
    stack = [{ name: 'showcase' }, { name: 'receive', ids, bought: true }];
    draw(true);
    return;
  }
  draw(false);
}
pay.subscribe(onPay);

/** Открыть магазин; неизвестные права показывают загрузку, а не успех. */
export function open(route = null) {
  if (root) return false;
  stack = [{ name: 'showcase', scroll: positions.get('showcase') || 0 }];
  // Old entry points may still supply an item or inventory route; unknown ids get a readable empty screen.
  if (route && ['item', 'fit', 'inventory', 'purchases'].includes(route.name)) stack.push(route);
  colors = {};
  awaiting = null;
  lastKey = '';
  pay.reset();
  const opener = document.activeElement;
  build();
  root.opener = opener;
  syncLayers();
  bus.syncBack();
  draw(true);
  root.back.focus({ preventScroll: true });
  store.refresh();
  if (route?.name === 'purchases') pay.loadHistory();
  bus.render();
  return true;
}

export function close(redraw = true) {
  if (!root) return;
  const opener = root.opener;
  savePosition();
  if (['showcase', 'inventory'].includes(stack.at(-1)?.name)) positions.set(stack.at(-1).name, root.scroll.scrollTop);
  root.el.remove();
  root = null;
  stack = [];
  awaiting = null;
  syncLayers();
  bus.syncBack();
  if (redraw) {
    bus.render();
    const selector = opener?.dataset.tab ? `.nav-tab[data-tab="${CSS.escape(opener.dataset.tab)}"]`
      : opener?.dataset.entry ? `[data-entry="${CSS.escape(opener.dataset.entry)}"]` : 'button[aria-label="Меню"],.nav-tab[aria-current="page"]';
    (opener?.isConnected ? opener : document.querySelector(selector))?.focus({ preventScroll: true });
  }
}

/** Страница сменила место (стол, группа) — слой закрыть. */
export function onMove() { close(false); }

/** Состояние связи и первый запрос `state` на соединение — вызывается из render() страницы. */
let lastPageState = null;
export function sync() {
  store.connection(!!net.connected);
  if (net.connected) store.ensureState();
  if (net.state !== lastPageState) {
    lastPageState = net.state;
    if (root) draw(false);
  }
}
