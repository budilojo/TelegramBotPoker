/** Tiny DOM + formatting helpers. No framework, no build step. */

/** A plain options bag — anything else in that slot is a child, not props. */
const isProps = (v) =>
  v != null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  !(v instanceof Node) &&
  Object.getPrototypeOf(v) === Object.prototype;

/** h('div.card', {onclick}, ...children) — props are optional. */
export function h(spec, ...rest) {
  const props = isProps(rest[0]) ? rest.shift() : null;
  const kids = rest;
  const [tag, ...classes] = String(spec).split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = (el.className + ' ' + v).trim();
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function')
        el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

export const mount = (el, ...kids) => {
  clear(el);
  add(el, kids);
  return el;
};

/** 12450 -> "12 450" (narrow no-break space keeps it tight on phones) */
export function fmt(n) {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '−' : '') + Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export const signed = (n) => (n > 0 ? '+' : '') + fmt(n);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const initials = (name) =>
  String(name || '?')
    .trim()
    .slice(0, 1)
    .toUpperCase() || '?';

/** Short haptic tick — silently ignored where unsupported (iOS Safari). */
export function tick(ms = 8) {
  try {
    navigator.vibrate?.(ms);
  } catch {}
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Animate a number in an element from its current value to `to`. */
export function countTo(el, to, ms = 520) {
  const from = Number(el.dataset.v ?? to);
  el.dataset.v = String(to);
  if (from === to || ms <= 0) {
    el.textContent = fmt(to);
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * eased);
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = fmt(to);
  };
  requestAnimationFrame(step);
}

/** Replay a CSS animation class on an element. */
export function flash(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

export const store = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

export const STREET_RU = {
  preflop: 'Префлоп',
  flop: 'Флоп',
  turn: 'Тёрн',
  river: 'Ривер',
};

export const ACTION_RU = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
  allin: 'All-in',
  'allin-call': 'All-in',
  blind: 'Блайнд',
};

/**
 * Who can still be dealt a hand — the client-side mirror of the server's
 * `canDeal`. The DEALER runs the table and never sits at it, so their chips
 * are not an opponent's chips: counting them would promise a next hand the
 * server is about to end. Every screen asks this one question through here.
 */
export const contenders = (players) =>
  players.filter((p) => p.role !== 'dealer' && p.stack > 0);

const mmss = (ms) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/**
 * The blind clock. The server sends how much of the level is left at snapshot
 * time and the client ticks it down locally, so nobody broadcasts per second.
 * `stateAt` is when that snapshot landed.
 */
export function blindText(state, stateAt) {
  const b = state?.blinds;
  if (!b || b.mode !== 'levels') return '';
  // A queued rise is the more useful thing to show than a clock at zero.
  if (b.pending) return `Блайнды ↑ ${fmt(b.pending.sb)}/${fmt(b.pending.bb)}`;
  const lvl = `Ур. ${b.levelIndex + 1}`;
  if (b.remainingMs == null) return `${lvl} · финальный`;
  const left = b.running ? b.remainingMs - (Date.now() - stateAt) : b.remainingMs;
  return `${lvl} · ${mmss(left)}`;
}

/** "5 игроков" vs "2 игрока" */
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
