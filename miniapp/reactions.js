/**
 * Смайлики во время игры — клиент. Сервер: bot/reactions.js.
 *
 * С волны 2 у смайликов нет своей кнопки: вход один — «чат и реакции» внизу
 * экрана (miniapp/chat.js). Здесь остаётся то, что не про кнопку:
 *   — набор: `miniapp/emoji/manifest.json` (агент R) → наборы и «быстрый ряд»
 *     для этой игры; манифеста нет — прежние 16 реакций с запасными эмодзи;
 *   — отправка `{t:'react', id}` и «подождите N с» (лимит 3 с / 6 в минуту);
 *   — пузырь над тем, кто прислал;
 *   — общий переключатель «Не показывать чат и реакции» (`reactionsOff`).
 *
 * КАРТИНКИ. Смайлик — `miniapp/emoji/<file из манифеста>`. Нет файла — запасной
 * юникод-эмодзи. Всё грузится со своего сервера.
 *
 * Список id, порядок и подписи запасного набора совпадают с bot/reactions.js —
 * это сверяет тест (bot/reactions.test.js).
 */
import { h, haptic, REDUCED } from './ui.js';
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

/** Сидит ли этот телефон за столом — только участники шлют смайлики и пишут в чат. */
export const canReact = (s) => !!s?.me && s.me.seated !== false && s.me.seat >= 0 && !s.me.kicked;

const OFF_KEY = 'reactions-off'; // тот же ключ, что у переключателя смайликов волны 1: выбор людей сохраняется
export function reactionsOff() {
  try {
    return localStorage.getItem(OFF_KEY) === '1' || offFallback;
  } catch {
    return offFallback;
  }
}
/** Включить или выключить чат и реакции на этом телефоне. */
export function setReactionsOff(on) {
  try {
    if (on) localStorage.setItem(OFF_KEY, '1');
    else localStorage.removeItem(OFF_KEY);
    offFallback = false;
  } catch {
    offFallback = on; // приватный режим: настройка проживёт до перезагрузки — и только
  }
  if (on) for (const el of bubbles.values()) el.remove();
  if (on) bubbles.clear();
}
let offFallback = false;

/* ------------------------------------------------------------- набор */

/** { sets: [{id,title,games,items:[{id,file,label,quick}]}] } из манифеста; null — нет файла. */
let manifest = null;
let manifestAsked = false;
function loadManifest() {
  if (manifestAsked) return;
  manifestAsked = true;
  fetch('/emoji/manifest.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
      if (Array.isArray(m?.sets)) {
        manifest = m;
        hooks.manifest?.();
      }
    })
    .catch(() => {});
}

/** Наборы для этой игры: [{ id, title, items: [{ id, label, file? , quick }] }]. */
export function reactionSets(game) {
  loadManifest();
  if (!manifest) return [{ id: 'universal', title: 'Реакции', items: REACTIONS.map((r) => ({ id: r.id, label: r.label, quick: ['gg', 'haha', 'wow', 'sad', 'think'].includes(r.id) })) }];
  return manifest.sets
    .filter((x) => x.games === '*' || (Array.isArray(x.games) && x.games.includes(game)))
    .map((x) => ({ id: x.id, title: x.title, items: (x.items || []).filter((i) => BY_ID.has(i.id)) }))
    .filter((x) => x.items.length);
}

/** Быстрый ряд: до пяти реакций с пометкой `quick`. */
export function quickReactions(game) {
  const all = reactionSets(game).flatMap((x) => x.items);
  const q = all.filter((i) => i.quick).slice(0, 5);
  return q.length ? q : all.slice(0, 5);
}

/** Подпись реакции для чтения вслух и истории. */
export const reactionLabel = (id) => {
  for (const x of manifest?.sets || []) for (const i of x.items || []) if (i.id === id && i.label) return i.label;
  return BY_ID.get(id)?.label || '';
};

/* ------------------------------------------------------------ картинки */

/** id → 'missing': файла нет, дальше рисуем запасной эмодзи без запроса. */
const missing = new Set();

function fileOf(id) {
  for (const x of manifest?.sets || []) for (const i of x.items || []) if (i.id === id && i.file) return i.file;
  return `${id}.png`;
}

/** Картинка смайлика или запасной эмодзи, если файла нет. */
export function face(id, cls) {
  const r = BY_ID.get(id);
  const file = fileOf(id);
  const fallback = () => h(`span.rx-face.rx-emoji${cls ? '.' + cls : ''}`, { 'aria-hidden': 'true' }, r?.emoji || '🙂');
  if (missing.has(id)) return fallback();
  const img = h(`img.rx-face${cls ? '.' + cls : ''}`, { src: `/emoji/${file}`, alt: '', draggable: 'false', loading: 'lazy' });
  img.addEventListener('error', () => {
    missing.add(id);
    img.replaceWith(fallback());
  }, { once: true });
  return img;
}

/* ------------------------------------------------------- лимит и отправка */

/** Мои отправки за последнюю минуту — чтобы подсказать «подождите» сразу, не дожидаясь отказа. */
let mine = [];
/** До какого времени (по часам сервера) реакции «остывают». */
let coolUntil = 0;

function localWait(now) {
  mine = mine.filter((at) => now - at < 60_000);
  if (!mine.length) return 0;
  const gap = mine.at(-1) + GAP_MS - now;
  const full = mine.length >= PER_MIN ? mine[mine.length - PER_MIN] + 60_000 - now : 0;
  return Math.max(0, gap, full);
}

function cool(ms) {
  coolUntil = Math.max(coolUntil, serverNow() + ms);
  for (const b of document.querySelectorAll('[data-rx-pick]')) b.classList.toggle('cool', ms > 0);
  setTimeout(() => {
    if (coolUntil > serverNow()) return;
    for (const b of document.querySelectorAll('[data-rx-pick]')) b.classList.remove('cool');
  }, ms + 30);
}

/** Реакции сейчас «остывают» (бледные, но нажимаются: тап объяснит, сколько ждать). */
export const reactCooling = () => coolUntil > serverNow();

/** Отправить реакцию. Возвращает true, если ушла. */
export function sendReaction(id) {
  const now = serverNow();
  const wait = localWait(now);
  if (wait > 0) {
    cool(wait);
    bus.onNotice(`Не так часто — подождите ${Math.max(1, Math.ceil(wait / 1000))} с.`);
    return false;
  }
  if (!send({ t: 'react', id }, { lock: false })) return false;
  haptic.tap();
  mine.push(now);
  const next = localWait(now);
  if (next > 0) cool(next);
  return true;
}

/* ------------------------------------------------------------- пузырь */

/** Слой для пузырей — вне #app: перерисовка экрана их не стирает. */
let layer = null;
function layerEl() {
  if (layer?.isConnected) return layer;
  // `h` понимает только `тег.класс`: `div#id` — недопустимое имя тега, createElement падает.
  layer = h('div.rx-layer', { id: 'rx-layer', 'aria-live': 'polite' });
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
  return q('.chat-fab') || app;
}

/** Пузырь у плашки дуэли — поменьше: плашка ниже большого пузыря. */
const anchorInBar = (seat, s) => !!anchorOf(seat, s)?.closest?.('.ch-bar');

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
  const bar = anchor.closest('.ch-bar');
  if (bar) {
    // Дуэль: справа от аватара, по высоте — в пределах плашки, чтобы не
    // заходить ни на доску, ни на соседнюю плашку.
    const b = bar.getBoundingClientRect();
    x = r.right + gap;
    y = Math.max(b.top, Math.min(r.top + r.height / 2 - size / 2, b.bottom - size));
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
  hooks.react?.({ seat, id });
  const s = net.state;
  if (!s?.room) return;
  syncRoom();
  bubbles.get(seat)?.remove();
  const name = (s.players || []).find((x) => x.seat === seat)?.name;
  const el = h(`div.rx-bubble${REDUCED ? '.still' : ''}`, {
    'data-rx-seat': seat,
    'data-rx': id,
    role: 'img',
    'aria-label': `${name ? name + ': ' : ''}${reactionLabel(id)}`,
  }, face(id, anchorInBar(seat, s) ? '' : 'big'));
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

/** Крючки для chat.js: реакция пришла (ложится в историю чата). */
export const hooks = { react: null, manifest: null };


bus.onReact = showBubble;
bus.onError = (msg) => {
  if (msg.code === 'REACT_WAIT' && msg.wait > 0) cool(msg.wait);
};
