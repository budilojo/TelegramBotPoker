/**
 * Смайлики во время игры — клиент. Сервер: bot/reactions.js.
 *
 * Что отсюда берут экраны игр (по одной строке в каждом):
 *   reactButton(state)   — кнопка «смайлик» в шапке стола (или null);
 *   reactMenuItem()      — пункт меню «Показывать / не показывать смайлики».
 * Остальное модуль делает сам: шторка 4×4, отправка `{t:'react', id}`,
 * пузырь над тем, кто прислал, бледная кнопка, пока «подождите».
 *
 * КАРТИНКИ. Смайлик — `miniapp/emoji/<id>.png` (512×512, прозрачный фон).
 * Пока файла нет — запасной юникод-эмодзи из таблицы ниже: чтобы подключить
 * нарисованные, достаточно положить файлы, код не меняется. Всё грузится со
 * своего сервера — ничего с внешних доменов.
 *
 * Список id, порядок и подписи совпадают с bot/reactions.js — это сверяет
 * тест (bot/reactions.test.js).
 */
import { h, showSheet, closeSheet, haptic, REDUCED } from './ui.js';
import { net, bus, send, serverNow } from './net.js';

export const REACTIONS = [
  { id: 'gg', label: 'Хорошая игра', emoji: '👍' },
  { id: 'wow', label: 'Ого!', emoji: '😮' },
  { id: 'haha', label: 'Ха-ха', emoji: '😂' },
  { id: 'sad', label: 'Не повезло', emoji: '😢' },
  { id: 'think', label: 'Думаю', emoji: '🤔' },
  { id: 'fire', label: 'Огонь!', emoji: '🔥' },
  { id: 'bluff', label: 'Блеф?', emoji: '😏' },
  { id: 'allin', label: 'Ва-банк', emoji: '💰' },
  { id: 'thanks', label: 'Спасибо', emoji: '🙏' },
  { id: 'sorry', label: 'Прости', emoji: '😅' },
  { id: 'hello', label: 'Привет', emoji: '👋' },
  { id: 'angry', label: 'Злюсь', emoji: '😠' },
  { id: 'facepalm', label: 'Ну как так', emoji: '🤦' },
  { id: 'cool', label: 'Красавчик', emoji: '😎' },
  { id: 'wait', label: 'Жду', emoji: '⏳' },
  { id: 'cheers', label: 'Ура!', emoji: '🎉' },
];
const BY_ID = new Map(REACTIONS.map((r) => [r.id, r]));

/** Те же пределы, что на сервере: раз в 3 с, шесть в минуту. Сервер всё равно проверит сам. */
const GAP_MS = 3_000;
const PER_MIN = 6;
/** Сколько висит пузырь. */
const SHOW_MS = 3_000;

/* ------------------------------------------------------- «не показывать» */

const OFF_KEY = 'reactions-off';
export function reactionsOff() {
  try {
    return localStorage.getItem(OFF_KEY) === '1';
  } catch {
    return false;
  }
}
function setOff(on) {
  try {
    if (on) localStorage.setItem(OFF_KEY, '1');
    else localStorage.removeItem(OFF_KEY);
  } catch {
    /* приватный режим: настройка проживёт до перезагрузки — и только */
  }
  if (on) for (const el of bubbles.values()) el.remove();
  if (on) bubbles.clear();
}

/** Пункт для меню стола: включить или выключить смайлики на этом телефоне. */
export function reactMenuItem() {
  const off = reactionsOff();
  return h('button.menu-item', {
    'data-rx-toggle': off ? 'off' : 'on',
    onclick: () => {
      setOff(!off);
      haptic.soft();
      closeSheet();
      bus.render();
    },
  }, off ? 'Показывать смайлики' : 'Не показывать смайлики', h('small', off ? 'сейчас скрыты на этом телефоне' : 'только у вас; другие их видят'));
}

/* ------------------------------------------------------------ картинки */

/** id → 'missing': файла нет, дальше рисуем запасной эмодзи без запроса. */
const missing = new Set();

/** Картинка смайлика или запасной эмодзи, если файла нет. */
function face(id, cls) {
  const r = BY_ID.get(id);
  const fallback = () => h(`span.rx-face.rx-emoji${cls ? '.' + cls : ''}`, { 'aria-hidden': 'true' }, r?.emoji || '🙂');
  if (missing.has(id)) return fallback();
  const img = h(`img.rx-face${cls ? '.' + cls : ''}`, { src: `/emoji/${id}.png`, alt: '', draggable: 'false' });
  img.addEventListener('error', () => {
    missing.add(id);
    img.replaceWith(fallback());
  }, { once: true });
  return img;
}

/* ------------------------------------------------------- лимит на кнопке */

/** Мои отправки за последнюю минуту — чтобы кнопка бледнела сразу, не дожидаясь отказа. */
let mine = [];
/** До какого времени (по часам сервера) кнопка бледная. */
let coolUntil = 0;
let coolTimer = null;

function localWait(now) {
  mine = mine.filter((at) => now - at < 60_000);
  if (!mine.length) return 0;
  const gap = mine.at(-1) + GAP_MS - now;
  const full = mine.length >= PER_MIN ? mine[mine.length - PER_MIN] + 60_000 - now : 0;
  return Math.max(0, gap, full);
}

function cool(ms) {
  coolUntil = Math.max(coolUntil, serverNow() + ms);
  paintCool();
}

function paintCool() {
  const left = coolUntil - serverNow();
  for (const b of document.querySelectorAll('.rx-btn')) b.classList.toggle('cool', left > 0);
  clearTimeout(coolTimer);
  if (left > 0) coolTimer = setTimeout(paintCool, left + 30);
}

/* ------------------------------------------------------------ кнопка */

/** Сидит ли этот телефон за столом — только участники шлют смайлики. */
const canReact = (s) => !!s?.me && s.me.seated !== false && s.me.seat >= 0 && !s.me.kicked;

/** Кнопка «смайлик» для шапки стола; null — если не за столом или смайлики выключены. */
export function reactButton(s) {
  syncRoom();
  if (reactionsOff() || !canReact(s)) return null;
  const btn = h('button.rx-btn', { type: 'button', 'aria-label': 'Смайлики', onclick: openPicker },
    h('span.rx-emoji.rx-btn-face', { 'aria-hidden': 'true' }, '🙂'));
  if (coolUntil > serverNow()) btn.classList.add('cool');
  return btn;
}

function openPicker() {
  haptic.soft();
  showSheet('reactions', () => h('div',
    h('h3', 'Смайлики'),
    h('div.sub', 'Увидят все за столом'),
    h('div.rx-grid', REACTIONS.map((r) => h('button.rx-cell', {
      type: 'button',
      'data-rx': r.id,
      'aria-label': r.label,
      onclick: () => pick(r.id),
    }, face(r.id), h('span.rx-label', r.label)))),
  ));
}

function pick(id) {
  const now = serverNow();
  const wait = localWait(now);
  closeSheet();
  if (wait > 0) {
    cool(wait);
    bus.onNotice(`Не так часто — подождите ${Math.max(1, Math.ceil(wait / 1000))} с.`);
    return;
  }
  if (!send({ t: 'react', id }, { lock: false })) return;
  haptic.tap();
  mine.push(now);
  const next = localWait(now);
  if (next > 0) cool(next);
}

/* ------------------------------------------------------------- пузырь */

/** Слой для пузырей — вне #app: перерисовка экрана их не стирает. */
let layer = null;
function layerEl() {
  if (layer?.isConnected) return layer;
  layer = h('div#rx-layer.rx-layer', { 'aria-live': 'polite' });
  document.body.append(layer);
  return layer;
}

/** место → пузырь на экране (новый смайлик того же человека заменяет старый). */
const bubbles = new Map();

/**
 * Где сидит этот человек на экране. Порядок: явная метка экрана
 * (`data-react-seat`), место за столом (покер, дурак, UNOQ — `data-seat`),
 * плашка в дуэли (по цвету или стороне), своя рука, и, если ничего не
 * нашлось, — кнопка смайликов.
 */
function anchorOf(seat, s) {
  const app = document.getElementById('app');
  const q = (sel) => app?.querySelector(sel) || null;
  const p = (s?.players || []).find((x) => x.seat === seat);
  const mine = s?.me?.seat === seat;
  const direct = q(`[data-react-seat="${seat}"]`) || q(`[data-seat="${seat}"]`);
  if (direct) return direct.querySelector('.av') || direct;
  if (p?.color) {
    const bar = q(`.ch-bar[data-color="${p.color}"]`);
    if (bar) return bar.querySelector('.av') || bar;
  }
  if (p?.side != null) {
    const bar = q(`.ch-bar[data-side="${p.side}"]`);
    if (bar) return bar.querySelector('.av') || bar;
  }
  if (mine) {
    const hand = q('.hero, .dk-hand, .cl-hand');
    if (hand) return hand;
  }
  return q('.rx-btn') || app;
}

/** Поставить пузырь над (или под, если сверху нет места) тем, кто прислал. */
function place(el, anchor) {
  const r = anchor.getBoundingClientRect();
  const size = el.offsetWidth || 56;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const gap = 4;
  // Плашка дуэли и рука — широкие: пузырь ложится рядом с аватаром или над
  // левым краем руки, не на доску и не на карты в центре.
  const wide = r.width > size * 3;
  let x = wide ? r.left + gap : r.left + r.width / 2 - size / 2;
  let y = r.top - size - gap;
  if (anchor.classList.contains('av') && anchor.closest('.ch-bar')) {
    x = r.right + gap;
    y = r.top + r.height / 2 - size / 2;
  } else if (y < 8) y = r.bottom + gap;
  x = Math.min(Math.max(8, x), vw - size - 8);
  y = Math.min(Math.max(8, y), vh - size - 8);
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
}

/** Ушли за другой стол — пузыри со старого убрать. */
let shownAt = null;
function syncRoom() {
  const code = net.state?.room?.code || null;
  if (code === shownAt) return;
  for (const el of bubbles.values()) el.remove();
  bubbles.clear();
  shownAt = code;
}

function showBubble({ seat, id }) {
  if (reactionsOff() || !BY_ID.has(id)) return;
  const s = net.state;
  if (!s?.room) return;
  syncRoom();
  bubbles.get(seat)?.remove();
  const name = (s.players || []).find((x) => x.seat === seat)?.name;
  const el = h(`div.rx-bubble${REDUCED ? '.still' : ''}`, {
    'data-rx-seat': seat,
    'data-rx': id,
    role: 'img',
    'aria-label': `${name ? name + ': ' : ''}${BY_ID.get(id).label}`,
  }, face(id, 'big'));
  layerEl().append(el);
  place(el, anchorOf(seat, s));
  bubbles.set(seat, el);
  setTimeout(() => {
    if (bubbles.get(seat) !== el) return;
    bubbles.delete(seat);
    if (REDUCED) return void el.remove();
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  }, SHOW_MS);
}

/* ------------------------------------------------------------- связь */

bus.onReact = showBubble;
bus.onError = (msg) => {
  if (msg.code === 'REACT_WAIT' && msg.wait > 0) cool(msg.wait);
};
