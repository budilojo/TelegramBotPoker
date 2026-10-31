/**
 * Коллекции: оболочка экранов (витрина → карточка → примерка → получение → инвентарь).
 *
 * Экраны лежат в своём слое поверх страницы (как шторка): серверное состояние страницы они не трогают,
 * партию не меняют. Слой создаётся один раз, прокручиваемый узел не пересоздаётся (docs/scroll.md):
 * при новом состоянии заменяется только содержимое внутри него.
 *
 * Открыть слой можно только из строки «Настроек» и только в демо (`store.visible` — серверное enabled && demo);
 * прямого маршрута, адреса или хэша нет. Если сервер перестал присылать демо — слой закрывается.
 */
import { h, haptic, trapFocus, syncLayers, focusMemo, restoreFocus } from '../ui.js';
import { net, bus, send } from '../net.js';
import { store, DEFAULT_COLOR } from './state.js';
import { itemById, itemsOfBundle } from './catalog.js';
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

const TITLES = { showcase: 'Коллекции', item: 'Карточка', fit: 'Примерка', inventory: 'Моя коллекция', receive: 'Получено', purchases: 'Мои покупки' };

export const isOpen = () => !!root;

/** Цвет предмета: выбранный на сервере, иначе черновик, иначе по умолчанию. */
function colorOf(id) {
  const it = itemById(id);
  const snap = store.snapshot();
  if (it?.kind === 'item' && snap.choice[it.slot]?.item === id && !(id in colors)) return snap.choice[it.slot].color;
  return colors[id] || DEFAULT_COLOR;
}

const ctx = () => ({
  h, store, pay, snap: store.snapshot(), route: stack[stack.length - 1],
  go: (r) => {
    awaiting = null; haptic.soft?.(); stack.push(r);
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
  if (stack.length > 1) { stack.pop(); draw(true); } else close();
}

function build() {
  const el = h('div.col-root', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Коллекции', onkeydown: (e) => trapFocus(e, el, back) });
  const backBtn = h('button.col-back', { type: 'button', 'aria-label': 'Назад', onclick: back, html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>' });
  const title = h('h1.col-title', { tabindex: '-1' });
  const scroll = h('div.col-scroll');
  const foot = h('div.col-foot');
  el.append(h('header.col-head', backBtn, title, h('span.col-head-gap')), scroll, foot);
  document.body.append(el);
  root = { el, title, back: backBtn, scroll, foot };
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
  const focus = focusMemo(root.scroll);
  root.scroll.replaceChildren(body);
  restoreFocus(root.scroll, focus);
  root.foot.replaceChildren(...footNodes(snap));
  root.el.dataset.route = r.name;
  root.el.dataset.link = snap.link;
  if (routeChanged || key !== lastKey) { root.scroll.scrollTop = 0; if (key !== lastKey) root.title.focus({ preventScroll: true }); }
  lastKey = key;
}

/** Реакция на новое состояние: «Получено» после ответа сервера, закрытие при выключенном демо. */
function onStore() {
  const snap = store.snapshot();
  // Покупка подтверждается только состоянием сервера: вещь пришла в «owned» — тогда «Куплено».
  pay.sawOwned(snap.owned);
  if (wasVisible && !snap.visible) { close(); wasVisible = snap.visible; bus.render(); return; }
  if (wasVisible !== snap.visible) { wasVisible = snap.visible; bus.render(); }
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

/** Открыть витрину. Не откроется, если сервер не сказал «демо». */
export function open() {
  if (!store.visible || root) return false;
  stack = [{ name: 'showcase' }];
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
  return true;
}

export function close() {
  if (!root) return;
  const opener = root.opener;
  root.el.remove();
  root = null;
  stack = [];
  awaiting = null;
  syncLayers();
  if (opener?.isConnected) opener.focus({ preventScroll: true });
  bus.syncBack();
}

/** Страница сменила место (стол, группа) — слой закрыть. */
export function onMove() { close(); }

/** Состояние связи и первый запрос `state` на соединение — вызывается из render() страницы. */
export function sync() {
  store.connection(!!net.connected);
  if (net.connected) store.ensureState();
}
