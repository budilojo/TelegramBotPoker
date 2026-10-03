/**
 * What every screen of the Mini App shares: a tiny DOM builder, numbers as
 * 1.000.000, card pictures, haptics, motion (rolling counters, one-shot
 * animations, things in flight), the toast, the bottom sheets and the
 * clocks. No game in here — the hub, the poker table and the durak table
 * all build on it.
 */

export const tg = window.Telegram?.WebApp || null;
export const $app = document.getElementById('app');
const $sheets = document.getElementById('sheet-root');
const $toast = document.getElementById('toast');

/* ---------------------------------------------------------------- helpers */

/** h('div.a.b', {attrs}, ...children) — a tiny DOM builder. */
export function h(tag, attrs, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    kids.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') {
      // CSS custom properties (--h) only take setProperty; plain keys go straight in.
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
        else el.style[sk] = sv;
      }
    }
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** 1000000 -> "1.000.000": the same grouping as the bot's messages in the group. */
export const fmt = (n) => {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '−' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
};
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const cardImg = (code, cls = '') => h(`img.card${cls ? '.' + cls : ''}`, { src: `/cards/${code}.svg`, alt: code, draggable: 'false' });
export const backImg = (cls = '') => cardImg('back', cls);
export const initial = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();
export const STAGE = { preflop: 'PRE-FLOP', flop: 'FLOP', turn: 'TURN', river: 'RIVER' };

export const haptic = {
  tap: () => tg?.HapticFeedback?.impactOccurred?.('medium'),
  soft: () => tg?.HapticFeedback?.selectionChanged?.(),
  turn: () => tg?.HapticFeedback?.notificationOccurred?.('warning'),
  win: () => tg?.HapticFeedback?.notificationOccurred?.('success'),
  err: () => tg?.HapticFeedback?.notificationOccurred?.('error'),
};

/* ----------------------------------------------------------------- motion */

/*
 * The whole screen is rebuilt from every state the server sends, so motion
 * cannot live in the DOM. It lives here, keyed by WHAT is moving (this hand's
 * second board card, this seat's stack): a rebuilt element picks up the same
 * animation where the old one left off instead of restarting or snapping.
 */
export const REDUCED = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
export const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const $fx = document.getElementById('fx');

/** Numbers that roll to their new value: stacks, the pot. */
const counters = new Map(); // key -> { value, from, to, t0, dur, delay }
let raf = 0;

/** The value to print for `key` right now; starts rolling toward `target` if it moved. */
export function countTo(key, target, { up = {}, down = {} } = {}) {
  let c = counters.get(key);
  if (!c) {
    counters.set(key, { value: target, to: target });
    return target;
  }
  if (c.to !== target) {
    const o = target > c.value ? up : down;
    Object.assign(c, { from: c.value, to: target, t0: performance.now(), dur: o.dur ?? 400, delay: o.delay ?? 0 });
    if (REDUCED) c.value = target;
    else if (!raf) raf = requestAnimationFrame(rollCounters);
  }
  return c.value;
}

export function rollCounters(now) {
  raf = 0;
  let busy = false;
  for (const [key, c] of counters) {
    if (c.value === c.to) continue;
    const p = clamp((now - c.t0 - c.delay) / c.dur, 0, 1);
    c.value = p >= 1 ? c.to : c.from + (c.to - c.from) * easeOut(p);
    const rising = c.to > c.from && p > 0 && p < 1;
    for (const el of document.querySelectorAll(`[data-ctr="${key}"]`)) {
      el.textContent = fmt(c.value);
      el.classList.toggle('up', rising);
    }
    if (c.value !== c.to) busy = true;
  }
  if (busy) raf = requestAnimationFrame(rollCounters);
}

/** A counting number element. */
export const counter = (tag, key, target, opts) => h(tag, { 'data-ctr': key }, fmt(countTo(key, target, opts)));

/** One-shot animations, keyed so a rebuilt element continues instead of replaying. */
const started = new Map(); // key -> start time
let queued = [];

/** Animate `el` once per `key`; `frames` may be a function of the laid-out page. */
export function animateOnce(el, key, frames, opts) {
  if (!REDUCED && el) queued.push({ el, key, frames, opts });
  return el;
}

/**
 * Run after the screen is in the DOM: positions exist, and animations attach
 * to live nodes. `still`: the first picture after opening the table shows
 * things as they are — a hand dealt a minute ago is not dealt again.
 */
export function flushAnimations({ still = false } = {}) {
  const now = performance.now();
  for (const { el, key, frames, opts } of queued) {
    if (!el.isConnected) continue;
    let t0 = started.get(key);
    if (t0 == null) started.set(key, (t0 = still ? -Infinity : now));
    const elapsed = now - t0;
    if (elapsed >= (opts.delay || 0) + opts.duration) continue;
    const a = el.animate(typeof frames === 'function' ? frames(el) : frames, { easing: EASE, fill: 'backwards', ...opts });
    a.currentTime = elapsed;
  }
  // Forget only what is no longer on screen: forgetting a key that is would play it again.
  if (started.size > 400) {
    const onScreen = new Set(queued.map((q) => q.key));
    for (const k of started.keys()) if (!onScreen.has(k)) started.delete(k);
  }
  queued = [];
}

/** Centre of an element, in viewport pixels. */
export function centerOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Offset from `el` to `target`, for "fly in from there" keyframes. */
export function offsetTo(el, target) {
  if (!target) return { dx: 0, dy: -40 };
  const a = centerOf(el);
  const b = centerOf(target);
  return { dx: b.x - a.x, dy: b.y - a.y };
}

/** Something drawn on the effects layer, above the table, gone when it has played. */
export function spawn(tag, at, frames, opts, attrs = null) {
  if (REDUCED || !$fx) return null;
  const el = h(tag, attrs);
  el.style.left = `${at.x}px`;
  el.style.top = `${at.y}px`;
  $fx.append(el);
  // 'forwards', not 'both': an effect waiting for its turn must not sit on screen.
  const a = el.animate(frames, { easing: EASE, fill: 'forwards', ...opts });
  a.onfinish = () => el.remove();
  a.oncancel = () => el.remove();
  return el;
}

/** Chips flying from one place to another in a little arc. */
export function flyChips(fromEl, toEl, { n = 4, delay = 0, dur = 620, stagger = 60 } = {}) {
  if (!fromEl || !toEl) return;
  const a = centerOf(fromEl);
  const b = centerOf(toEl);
  for (let i = 0; i < n; i++) {
    const jx = (Math.random() - 0.5) * 22;
    const jy = (Math.random() - 0.5) * 12;
    const mx = (b.x - a.x) / 2 + jx;
    const my = (b.y - a.y) / 2 - 26 + jy;
    spawn(`div.fx-chip.c${i % 3}`, a, [
      { transform: 'translate(0, 0) scale(0.5)', opacity: 0 },
      { transform: `translate(${mx}px, ${my}px) scale(1)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) scale(0.85)`, opacity: 1, offset: 0.88 },
      { transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) scale(0.3)`, opacity: 0 },
    ], { duration: dur, delay: delay + i * stagger, easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)' });
  }
}

/** A player folds: their two cards slide into the middle and vanish. */
export function muck(fromEl, toEl) {
  if (!fromEl || !toEl) return;
  const a = centerOf(fromEl);
  const b = centerOf(toEl);
  [-1, 1].forEach((side, i) => {
    spawn('img.card.fx-card', { x: a.x + side * 6, y: a.y + 14 }, [
      { transform: `rotate(${side * 8}deg)`, opacity: 0.95 },
      { transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) rotate(${side * 40 + 90}deg) scale(0.6)`, opacity: 0 },
    ], { duration: 520, delay: i * 50, easing: 'cubic-bezier(0.5, 0, 0.75, 0)' }, { src: '/cards/back.svg', alt: '' });
  });
}

/** A gold ring and sparks around a winner. */
export function celebrate(el, { sparks = 0, delay = 0 } = {}) {
  if (!el) return;
  const c = centerOf(el);
  spawn('div.fx-burst', c, [
    { transform: 'scale(0.3)', opacity: 0.95 },
    { transform: 'scale(2.6)', opacity: 0 },
  ], { duration: 900, delay });
  for (let i = 0; i < sparks; i++) {
    const ang = (i / sparks) * Math.PI * 2 + Math.random() * 0.4;
    const dist = 38 + Math.random() * 34;
    spawn('div.fx-spark', c, [
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: `translate(${Math.cos(ang) * dist}px, ${Math.sin(ang) * dist}px) scale(0.2)`, opacity: 0 },
    ], { duration: 750 + Math.random() * 250, delay: delay + Math.random() * 120, easing: 'cubic-bezier(0.1, 0.8, 0.3, 1)' });
  }
}

/** Your turn: the edges of the screen breathe green once. */
export function edgeGlow() {
  spawn('div.fx-edge', { x: 0, y: 0 }, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 1100 });
}

let toastTimer = null;
export function toast(text, ms = 2600) {
  $toast.textContent = text;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), ms);
}

/* ------------------------------------------------------------------ clocks */

/** Deadlines tick on the page; the server keeps the real time (`now` is its clock). */
export function tickClocks(now) {
  for (const el of document.querySelectorAll('[data-count]')) {
    const left = Math.max(0, Number(el.dataset.count) - now);
    const sec = Math.ceil(left / 1000);
    el.textContent = `${el.dataset.prefix || ''}${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    el.closest('.your-turn, .dk-role')?.classList.toggle('urgent', left > 0 && left < 10_000);
  }
  for (const svg of document.querySelectorAll('svg.ring')) {
    const total = Number(svg.dataset.total) || 1;
    const left = Math.max(0, Number(svg.dataset.deadline) - now);
    const C = 2 * Math.PI * 25;
    svg.firstChild.setAttribute('stroke-dashoffset', (C * (1 - left / total)).toFixed(2));
    svg.classList.toggle('low', left < 10_000);
  }
}

/** A ring around an avatar that runs down with the turn timer. */
export function ringSvg(deadline, total) {
  const C = 2 * Math.PI * 25;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('viewBox', '0 0 54 54');
  svg.dataset.deadline = deadline;
  svg.dataset.total = total * 1000;
  const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.setAttribute('cx', 27);
  c.setAttribute('cy', 27);
  c.setAttribute('r', 25);
  c.setAttribute('stroke-dasharray', C.toFixed(2));
  svg.append(c);
  return svg;
}

/* ------------------------------------------------------------------ sheets */

/*
 * Everything that is not the main screen slides up over it and goes away.
 * `build()` is called again whenever a new state arrives, so a sheet always
 * shows the truth; returning null closes it.
 */
let openSheet = null;
let sheetOpts = {};
export const sheetRenderers = {};

/** The name of the sheet on screen, or null. */
export const currentSheet = () => openSheet;

export function showSheet(name, build, opts = {}) {
  openSheet = name;
  sheetOpts = opts;
  sheetRenderers[name] = () => {
    if (openSheet !== name) return;
    const body = build();
    if (!body) return closeSheet();
    $sheets.replaceChildren(
      h('div.backdrop', { onclick: () => closeSheet(true) }),
      h('div.sheet', h('div.grab'), body),
    );
  };
  sheetRenderers[name]();
}

/** @param byUser  swiped or tapped away (then `onDismiss` is told) */
export function closeSheet(byUser = false) {
  if (byUser) sheetOpts.onDismiss?.();
  openSheet = null;
  sheetOpts = {};
  $sheets.replaceChildren();
}

/** Redraw the open sheet from the current state. */
export function refreshSheet() {
  if (openSheet && sheetRenderers[openSheet]) sheetRenderers[openSheet]();
}

/** Initials in a coloured circle — the same avatar at every table. */
export const avatar = (name, hue, cls = '') => h(`div.av${cls ? '.' + cls : ''}`, { style: { '--h': hue } }, initial(name));
