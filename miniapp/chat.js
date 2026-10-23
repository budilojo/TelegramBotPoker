/**
 * Чат за столом и единый вход «чат и реакции» — клиент. Сервер: bot/chat.js.
 *
 * Вход ОДИН — круглая кнопка внизу экрана игры (`.chat-fab`) с бейджем
 * непрочитанных. Она живёт в своём слое поверх экрана (вне #app: перерисовка
 * игры её не стирает) и сама находит свободное место у нижнего края, чтобы не
 * лежать на картах, доске и кнопках хода (`placeFab`). Играм от неё нужна одна
 * строка — пункт меню `chatMenuItem(s)`; кнопки в шапке больше нет.
 *
 * Нажатие открывает компактную нижнюю панель: история, быстрый ряд реакций
 * (+ «ещё» — наборы по категориям), поле ввода. Игру панель НЕ блокирует
 * (затемнения нет), а в шапке панели видно «Ваш ход» и таймер. Клавиатуру
 * ведёт `--kb` из ui.js и `visualViewport`.
 *
 * Сообщение — всегда текст: рисуем через `textContent`/`h()`, ссылок нет.
 */
import { h, haptic, avatar, closeSheet } from './ui.js';
import { avatarEl } from './profile.js';
import { net, bus, send } from './net.js';
import {
  reactionsOff, setReactionsOff, canReact, reactionSets, quickReactions, sendReaction, face, hooks, reactionLabel, reactCooling,
} from './reactions.js';

const MAX_LEN = 300;
const HISTORY = 50;
const SHOW_COUNT_AT = 40; // счётчик символов — когда осталось не больше стольких
const COLLAPSE_CHARS = 220;

const st = {
  room: null, // код стола, к которому относится история
  log: [],
  unread: 0,
  open: false,
  sets: false, // раскрыты ли «ещё» (наборы реакций)
  tab: 0,
  atBottom: true,
  sending: false,
  err: '',
};

let root = null; // слой поверх экрана
let fab = null;
let badge = null;
let panel = null;
let ui = {}; // части панели

const $app = () => document.getElementById('app');
const S = () => net.state;
const game = () => S()?.game || 'poker';

/** Есть ли чат у этого телефона сейчас: сидит за столом, не партия с ботами, не выключен. */
function available() {
  const s = S();
  return !!s?.room && !s.solo && canReact(s) && !reactionsOff() && !net.fatal;
}

const myTurn = (s) => !!s && (s.legal ? s.legal.myTurn ?? true : false);
const deadlineOf = (s) => s?.hand?.deadline ?? s?.deal?.deadline ?? s?.clock?.deadline ?? s?.legal?.deadline ?? null;

/* --------------------------------------------------------------- данные */

/** Ушли за другой стол — история и панель прежнего стола не нужны. */
let wasConnected = false;
function syncRoom() {
  const code = S()?.room?.code || null;
  // Связь пропадала и вернулась — пока нас не было, в чате могли писать.
  const reconnected = net.connected && !wasConnected;
  wasConnected = net.connected;
  if (code === st.room && !(reconnected && code)) return;
  if (code !== st.room) {
    st.room = code;
    st.log = [];
    st.unread = 0;
    st.sending = false;
    st.err = '';
    if (st.open) closePanel();
  }
  if (code && available()) send({ t: 'chat-sync' }, { lock: false });
  paintBadge();
}

const nameOf = (m) => (S()?.players || []).find((p) => p.seat === m.seat)?.name || m.name || 'Игрок';
const hueOf = (m) => (S()?.players || []).find((p) => p.seat === m.seat)?.hue ?? 200;
const isMine = (m) => S()?.me?.seat === m.seat;

function markRead() {
  if (st.unread > 0) {
    st.unread = 0;
    send({ t: 'chat-read' }, { lock: false });
  }
  paintBadge();
}

function pushLine(line) {
  st.log.push(line);
  if (st.log.length > HISTORY) st.log.splice(0, st.log.length - HISTORY);
}

bus.onChat = (msg) => {
  syncRoom();
  if (msg.t === 'chat-sync') {
    st.log = Array.isArray(msg.log) ? msg.log.slice(-HISTORY) : [];
    st.unread = msg.unread | 0;
    if (st.open) {
      renderLog(true);
      markRead();
    }
  } else if (msg.t === 'chat') {
    if (reactionsOff()) return;
    pushLine(msg.m);
    st.unread = msg.unread | 0;
    if (isMine(msg.m) && st.sending) {
      st.sending = false;
      if (ui.input) {
        ui.input.value = '';
        growInput();
      }
      paintSend();
    }
    if (st.open) {
      appendLine(msg.m);
      markRead();
    }
  } else if (msg.t === 'chat-unread') {
    st.unread = msg.unread | 0;
    if (st.open && st.unread > 0) markRead();
  }
  paintBadge();
};

/** Реакция пришла — маленькой строкой в историю (сервер хранит то же самое для тех, кто зайдёт позже). */
hooks.react = ({ seat, id }) => {
  if (!available()) return;
  const line = { k: 'r', seat, react: id, name: nameOf({ seat }), at: Date.now() };
  pushLine(line);
  if (st.open) appendLine(line);
};
hooks.manifest = () => {
  if (st.open) renderReactions();
};

// Отказ чата объясняется под полем ввода — тост поверх панели не нужен.
bus.hideToast = (msg) => st.open && typeof msg.code === 'string' && msg.code.startsWith('CHAT_');

const prevError = bus.onError;
bus.onError = (msg) => {
  prevError(msg);
  if (typeof msg.code === 'string' && msg.code.startsWith('CHAT_')) {
    st.sending = false;
    st.err = msg.text || '';
    paintErr();
    paintSend();
  }
};

/* ------------------------------------------------------------- кнопка */

const bubbleIcon = () => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 3.5V17H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.8');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
};

function ensureRoot() {
  if (root?.isConnected) return;
  badge = h('span.chat-badge', { 'aria-hidden': 'true' });
  fab = h('button.chat-fab', { type: 'button', 'data-chat-fab': '', onclick: openPanel }, bubbleIcon(), badge);
  root = h('div.chat-root', { id: 'chat-root' }, fab);
  document.body.append(root);
}

function paintBadge() {
  if (!badge) return;
  const n = st.unread;
  badge.textContent = n > 9 ? '9+' : String(n || '');
  badge.hidden = !n;
  fab?.setAttribute('aria-label', n ? `Чат и реакции, непрочитанных: ${n}` : 'Чат и реакции');
}

/**
 * Где лежит кнопка. Идём от нижнего правого угла вверх (потом то же слева) и
 * берём первое место, где под всеми девятью точками кнопки нет содержимого игры:
 * кнопок, картинок, значков и небольших блоков (плашки, панели, подписи).
 * Большое — сукно, фон — кнопке не помеха.
 */
function blocks(el, tier) {
  if (!el || el === document.documentElement || el === document.body || el.id === 'app') return false;
  if (el.closest('button, a, input, textarea, select, svg, canvas, img, [role="button"]')) return true;
  // Надпись: у элемента есть свой текст (подсказка «Выберите шашку…», имя, число).
  if (tier >= 1 && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return true;
  if (tier < 2) return false;
  const r = el.getBoundingClientRect();
  return r.width * r.height < innerWidth * innerHeight * 0.3;
}

function freeAt(x, y, size, tier) {
  const pts = [];
  for (const fx of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) pts.push([x + fx * size, y + fy * size]);
  for (const [px, py] of pts) {
    const els = document.elementsFromPoint(Math.min(innerWidth - 1, Math.max(0, px)), Math.min(innerHeight - 1, Math.max(0, py)));
    for (const el of els) {
      if (el.closest('#chat-root, .rx-layer, #fx, #toast')) continue;
      if (blocks(el, tier)) return false;
      break; // самый верхний «настоящий» элемент не мешает
    }
  }
  return true;
}

export function placeFab() {
  if (!fab) return;
  const size = fab.offsetWidth || 48;
  const vw = document.documentElement.clientWidth;
  const vh = (window.visualViewport?.height || innerHeight) - 0;
  const m = 8;
  const bottomLimit = vh - size - m - 0;
  const topLimit = Math.max(m, Math.round(vh * 0.4));
  fab.style.visibility = 'hidden';
  let best = null;
  // Сначала — место, свободное от всего содержимого; нет такого — от кнопок,
  // картинок и надписей; совсем плотный экран (лобби с текстом) — хотя бы от
  // нажимного: поверх абзаца, но не поверх кнопки.
  search: for (const tier of [2, 1, 0]) {
    for (const x of [vw - size - m, m]) {
      for (let y = bottomLimit; y >= topLimit; y -= 6) {
        if (freeAt(x, y, size, tier)) {
          best = { x, y };
          break search;
        }
      }
    }
  }
  fab.style.visibility = '';
  // Свободного места нет совсем — у нижнего правого угла: хотя бы предсказуемо.
  if (!best) best = { x: vw - size - m, y: bottomLimit };
  fab.style.left = `${Math.round(best.x)}px`;
  fab.style.top = `${Math.round(best.y)}px`;
}

let placeTimer = 0;
function syncDock() {
  syncRoom();
  const on = available();
  if (on) ensureRoot();
  if (root) root.hidden = !on;
  if (!on) {
    if (st.open) closePanel();
    return;
  }
  paintBadge();
  paintHead();
  if (!st.open) {
    clearTimeout(placeTimer);
    placeTimer = setTimeout(() => requestAnimationFrame(placeFab), 60);
  }
}

/* ------------------------------------------------------------- панель */

function openPanel() {
  if (st.open || !available()) return;
  haptic.soft();
  st.open = true;
  st.err = '';
  buildPanel();
  root.append(panel);
  root.classList.add('open');
  fit();
  renderLog(true);
  renderReactions();
  paintHead();
  paintSend();
  paintErr();
  send({ t: 'chat-sync' }, { lock: false });
  markRead();
  // Экран игры под панелью может меняться без перерисовки — шапку («Ваш ход») обновляем сами.
  headTimer = setInterval(() => {
    if (!available()) return closePanel();
    paintHead();
  }, 1000);
}
let headTimer = 0;

function closePanel() {
  if (!st.open) return;
  st.open = false;
  st.sets = false;
  clearInterval(headTimer);
  ui.input?.blur();
  panel?.remove();
  root?.classList.remove('open');
  ui = {};
  if (root) placeFab();
}

function buildPanel() {
  ui = {};
  ui.turn = h('div.chat-turn', { hidden: true });
  ui.log = h('div.chat-log', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Сообщения стола' });
  ui.newer = h('button.chat-new', { type: 'button', hidden: true, onclick: () => scrollDown(true) }, 'новые ↓');
  ui.sets = h('div.chat-sets', { hidden: true });
  ui.quick = h('div.chat-quick');
  ui.err = h('div.chat-err', { role: 'alert' });
  ui.count = h('span.chat-count', { hidden: true });
  ui.input = h('textarea.chat-input', {
    rows: 1, maxlength: String(MAX_LEN), placeholder: 'Сообщение…', enterkeyhint: 'send', autocomplete: 'off', autocapitalize: 'sentences', 'aria-label': 'Сообщение',
    oninput: () => {
      growInput();
      paintSend();
      if (st.err) {
        st.err = '';
        paintErr();
      }
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    },
  });
  ui.send = h('button.chat-send', { type: 'submit', disabled: true }, 'Отправить');
  const form = h('form.chat-form', { onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('div.chat-field', ui.input, ui.count), ui.send);
  const head = h('div.chat-head',
    h('div.chat-grip', { 'aria-hidden': 'true' }),
    h('div.chat-bar',
      h('div.chat-title', 'Чат стола'),
      ui.turn,
      h('button.chat-close', { type: 'button', onclick: closePanel }, 'К игре')));
  panel = h('div.chat-panel', { role: 'dialog', 'aria-label': 'Чат и реакции' },
    head, h('div.chat-main', ui.log, ui.newer), ui.sets, ui.quick, ui.err, form);
  ui.head = head;
  swipe(head);
  const log = ui.log;
  const newer = ui.newer;
  log.addEventListener('scroll', () => {
    st.atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    if (st.atBottom) newer.hidden = true;
  });
}

/** Свайп вниз за шапку — закрыть. */
function swipe(head) {
  let y0 = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    y0 = e.clientY;
    head.setPointerCapture?.(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (y0 == null) return;
    panel.style.setProperty('--dy', `${Math.max(0, e.clientY - y0)}px`);
  });
  const end = (e) => {
    if (y0 == null) return;
    const dy = e.clientY - y0;
    y0 = null;
    panel.style.removeProperty('--dy');
    if (dy > 70) closePanel();
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', () => {
    y0 = null;
    panel?.style.removeProperty('--dy');
  });
}

/** Высота панели: половина видимой области; над клавиатурой — вся видимая (`--kb` ведёт ui.js). */
function fit() {
  if (!panel) return;
  const vv = window.visualViewport;
  const avail = Math.round(vv?.height || innerHeight);
  const kb = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--kb'), 10) || 0;
  panel.style.setProperty('--chat-h', `${kb > 0 ? avail - 8 : Math.round(avail * 0.5)}px`);
  panel.classList.toggle('kb', kb > 0);
  if (st.atBottom) scrollDown();
}

/** «Ваш ход» и таймер в шапке панели — чтобы не проспать, пока читаешь. */
function paintHead() {
  if (!ui.turn) return;
  const s = S();
  const mine = myTurn(s) && s?.room?.status !== 'finished';
  const dl = mine ? deadlineOf(s) : null;
  ui.turn.hidden = !mine;
  if (!mine) return ui.turn.replaceChildren();
  ui.turn.replaceChildren(...['Ваш ход', dl ? h('span.num', { 'data-count': dl }) : null].filter(Boolean));
}

function paintErr() {
  if (ui.err) ui.err.textContent = st.err;
}

function growInput() {
  const el = ui.input;
  if (!el) return;
  el.style.height = 'auto';
  const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
  const pad = parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom);
  el.style.height = `${Math.min(el.scrollHeight, Math.round(line * 3 + pad))}px`;
  const left = MAX_LEN - [...el.value].length;
  ui.count.hidden = left > SHOW_COUNT_AT;
  ui.count.textContent = String(left);
  ui.count.classList.toggle('over', left <= 0);
}

function paintSend() {
  if (!ui.send) return;
  ui.send.disabled = !ui.input.value.trim() || st.sending;
}

function submit() {
  const text = ui.input.value;
  if (!text.trim() || st.sending) return;
  if ([...text].length > MAX_LEN) {
    st.err = `Слишком длинно: в сообщении не больше ${MAX_LEN} символов.`;
    return paintErr();
  }
  if (!send({ t: 'chat', text }, { lock: false })) return;
  st.sending = true;
  st.err = '';
  paintErr();
  paintSend();
  haptic.tap();
  // Нет ни ответа, ни отказа — не держим кнопку вечно.
  setTimeout(() => {
    if (!st.sending) return;
    st.sending = false;
    paintSend();
  }, 4000);
}

/* ------------------------------------------------------------ история */

const timeOf = (at) => {
  try {
    return new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
};

/** Аватар автора: из набора профиля (T), если человек ещё за столом; иначе инициал. */
function authorAvatar(m, name) {
  const p = (S()?.players || []).find((x) => x.seat === m.seat);
  return p ? avatarEl(p) : avatar(name, hueOf(m));
}

function lineEl(m) {
  const name = nameOf(m);
  if (m.k === 'r') {
    return h('div.chat-react', { 'data-chat-react': m.react, 'aria-label': `${name}: ${reactionLabel(m.react)}` },
      h('span.chat-react-name', `${name}:`), face(m.react, 'sm'));
  }
  const mine = isMine(m);
  const long = m.text.length > COLLAPSE_CHARS || m.text.split('\n').length > 6;
  const text = h(`div.chat-text${long ? '.collapsed' : ''}`, m.text); // только текст: ни разметки, ни ссылок
  const more = long ? h('button.chat-more-text', { type: 'button', onclick: () => {
    const open = text.classList.toggle('collapsed');
    more.textContent = open ? 'Показать полностью' : 'Свернуть';
  } }, 'Показать полностью') : null;
  return h(`div.chat-msg${mine ? '.mine' : ''}`, { 'data-chat-msg': m.n ?? '' },
    mine ? null : authorAvatar(m, name),
    h('div.chat-body',
      mine ? null : h('div.chat-name', name),
      text, more,
      h('div.chat-time', timeOf(m.at))));
}

function emptyEl() {
  return h('div.chat-empty', 'Пока тихо. Напишите первым — увидят только игроки за этим столом.');
}

function renderLog(bottom) {
  if (!ui.log) return;
  if (!st.log.length) {
    ui.log.replaceChildren(emptyEl());
    return;
  }
  ui.log.replaceChildren(...st.log.map(lineEl));
  if (bottom) scrollDown();
}

function appendLine(m) {
  if (!ui.log) return;
  ui.log.querySelector('.chat-empty')?.remove();
  const wasBottom = st.atBottom || isMine(m);
  ui.log.append(lineEl(m));
  while (ui.log.children.length > HISTORY) ui.log.firstChild.remove();
  if (wasBottom) scrollDown();
  else ui.newer.hidden = false;
}

function scrollDown(smooth = false) {
  if (!ui.log) return;
  ui.log.scrollTo({ top: ui.log.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  st.atBottom = true;
  ui.newer.hidden = true;
}

/* ------------------------------------------------------------ реакции */

function pickBtn(it, cls) {
  const b = h(`button.${cls}`, {
    type: 'button', 'data-rx-pick': it.id, 'data-rx': it.id, 'aria-label': it.label || reactionLabel(it.id),
    onclick: () => {
      if (sendReaction(it.id)) {
        st.sets = false;
        renderReactions();
      }
    },
  }, face(it.id), cls === 'chat-cell' ? h('span.rx-label', it.label || reactionLabel(it.id)) : null);
  if (reactCooling()) b.classList.add('cool');
  return b;
}

function renderReactions() {
  if (!ui.quick) return;
  const sets = reactionSets(game());
  ui.quick.replaceChildren(
    ...quickReactions(game()).map((it) => pickBtn(it, 'chat-q')),
    h('button.chat-q.chat-q-more', {
      type: 'button', 'aria-expanded': String(st.sets), 'data-chat-more': '',
      onclick: () => {
        st.sets = !st.sets;
        renderReactions();
      },
    }, st.sets ? 'Скрыть' : 'ещё'));
  ui.sets.hidden = !st.sets;
  if (!st.sets) return ui.sets.replaceChildren();
  if (st.tab >= sets.length) st.tab = 0;
  const cur = sets[st.tab] || sets[0];
  ui.sets.replaceChildren(
    sets.length > 1 ? h('div.chat-tabs', { role: 'tablist' }, sets.map((x, i) => h('button.chat-tab', {
      type: 'button', role: 'tab', 'aria-selected': String(i === st.tab), 'data-chat-tab': x.id,
      onclick: () => {
        st.tab = i;
        renderReactions();
      },
    }, x.title))) : null,
    h('div.chat-grid', cur.items.map((it) => pickBtn(it, 'chat-cell'))));
}

/* ----------------------------------------------------- меню и привязка */

/** Пункт меню стола: чат и реакции на этом телефоне — показывать или нет. Только тому, кто за столом. */
export function chatMenuItem(s) {
  if (!canReact(s) || s.solo) return null;
  const off = reactionsOff();
  return h('button.menu-item', {
    'data-rx-toggle': off ? 'off' : 'on',
    onclick: () => {
      setReactionsOff(!off);
      haptic.soft();
      closeSheet();
      closePanel();
      syncDock();
      bus.render();
    },
  }, off ? 'Показывать чат и реакции' : 'Не показывать чат и реакции', h('small', off ? 'сейчас скрыты на этом телефоне' : 'только у вас; другие игроки их видят'));
}

/* Кнопку надо перекладывать, когда экран перерисован или окно изменилось. */
let watching = false;
function watch() {
  if (watching) return;
  const app = $app();
  if (!app) return;
  watching = true;
  let t = 0;
  const later = () => {
    clearTimeout(t);
    t = setTimeout(syncDock, 80);
  };
  new MutationObserver(later).observe(app, { childList: true });
  window.addEventListener('resize', () => {
    later();
    fit();
  });
  window.visualViewport?.addEventListener('resize', fit);
  window.visualViewport?.addEventListener('scroll', fit);
  document.addEventListener('pointerdown', (e) => {
    // Тап вне панели — вернуться к игре; сам тап при этом доходит до игры.
    if (st.open && !e.target.closest('#chat-root, #sheet-root, #toast')) closePanel();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && st.open) closePanel();
  });
  later();
}
watch();
