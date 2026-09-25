/**
 * The poker table, inside Telegram.
 *
 * The page is a view, never a judge: every state it shows comes from the
 * server, built for THIS player only (their cards, nobody else's), and every
 * tap is a request the server re-checks against the player's signed identity.
 * Nothing here decides whose turn it is or what is legal — the buttons simply
 * show what the server said is legal right now.
 *
 * One main screen during the game. Everything else (raise sizes, the menu,
 * the dealer's "who won?") slides up over it and goes away.
 */

const tg = window.Telegram?.WebApp || null;
const $app = document.getElementById('app');
const $sheets = document.getElementById('sheet-root');
const $toast = document.getElementById('toast');

/* ---------------------------------------------------------------- helpers */

/** h('div.a.b', {attrs}, ...children) — a tiny DOM builder. */
function h(tag, attrs, ...kids) {
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
const fmt = (n) => {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '−' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const cardImg = (code, cls = '') => h(`img.card${cls ? '.' + cls : ''}`, { src: `/cards/${code}.svg`, alt: code, draggable: 'false' });
const backImg = (cls = '') => cardImg('back', cls);
const initial = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();
const STAGE = { preflop: 'PRE-FLOP', flop: 'FLOP', turn: 'TURN', river: 'RIVER' };

const haptic = {
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
const REDUCED = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const $fx = document.getElementById('fx');

/** Numbers that roll to their new value: stacks, the pot. */
const counters = new Map(); // key -> { value, from, to, t0, dur, delay }
let raf = 0;

/** The value to print for `key` right now; starts rolling toward `target` if it moved. */
function countTo(key, target, { up = {}, down = {} } = {}) {
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

function rollCounters(now) {
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
const counter = (tag, key, target, opts) => h(tag, { 'data-ctr': key }, fmt(countTo(key, target, opts)));

/** One-shot animations, keyed so a rebuilt element continues instead of replaying. */
const started = new Map(); // key -> start time
let queued = [];

/** Animate `el` once per `key`; `frames` may be a function of the laid-out page. */
function animateOnce(el, key, frames, opts) {
  if (!REDUCED && el) queued.push({ el, key, frames, opts });
  return el;
}

/**
 * Run after the screen is in the DOM: positions exist, and animations attach
 * to live nodes. `still`: the first picture after opening the table shows
 * things as they are — a hand dealt a minute ago is not dealt again.
 */
function flushAnimations({ still = false } = {}) {
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
function centerOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Offset from `el` to `target`, for "fly in from there" keyframes. */
function offsetTo(el, target) {
  if (!target) return { dx: 0, dy: -40 };
  const a = centerOf(el);
  const b = centerOf(target);
  return { dx: b.x - a.x, dy: b.y - a.y };
}

/** Something drawn on the effects layer, above the table, gone when it has played. */
function spawn(tag, at, frames, opts, attrs = null) {
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
function flyChips(fromEl, toEl, { n = 4, delay = 0, dur = 620, stagger = 60 } = {}) {
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
function muck(fromEl, toEl) {
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
function celebrate(el, { sparks = 0, delay = 0 } = {}) {
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
function edgeGlow() {
  spawn('div.fx-edge', { x: 0, y: 0 }, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 1100 });
}

let toastTimer = null;
function toast(text, ms = 2600) {
  $toast.textContent = text;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), ms);
}

/* ------------------------------------------------------------ connection */

const initData = tg?.initData || '';
const roomCode = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('room') || '';

let ws = null;
let connected = false;
let fatal = null;
let retry = 0;
let state = null;
let prev = null;
let clockOffset = 0; // server time − our time
let busy = false;
let busyTimer = null;

const serverNow = () => Date.now() + clockOffset;

function connect() {
  const url = location.origin.replace(/^http/, 'ws') + '/ws';
  ws = new WebSocket(url);
  ws.onopen = () => {
    retry = 0;
    ws.send(JSON.stringify({ t: 'hello', initData, room: roomCode }));
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.t === 'state') {
      const wasConnected = connected;
      connected = true;
      prev = state;
      state = msg.state;
      clockOffset = state.now - Date.now();
      setBusy(false);
      onState(wasConnected);
    } else if (msg.t === 'error') {
      setBusy(false);
      haptic.err();
      toast(msg.text || 'Не получилось');
    } else if (msg.t === 'fatal' || msg.t === 'gone') {
      fatal = msg.text || 'Стол недоступен.';
      render();
    }
  };
  ws.onclose = () => {
    const was = connected;
    connected = false;
    if (fatal) return;
    if (was) render();
    retry = Math.min(retry + 1, 5);
    setTimeout(connect, [0, 500, 1000, 2000, 4000, 8000][retry]);
  };
}

function send(msg, { lock = true } = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast('Нет связи — переподключаемся…');
    return false;
  }
  ws.send(JSON.stringify(msg));
  if (lock) setBusy(true);
  return true;
}

/** One request at a time: a second tap never races the first. */
function setBusy(on) {
  busy = on;
  clearTimeout(busyTimer);
  if (on) busyTimer = setTimeout(() => setBusy(false), 4000);
  document.querySelector('.panel')?.classList.toggle('busy', on);
}

function act(action, amount) {
  haptic.tap();
  closeSheet();
  send({ t: 'act', action, amount, seq: state.seq });
}

/** Telegram tells us when the app goes to the background: then the bot may nudge. */
function reportVisibility() {
  const visible = !document.hidden;
  if (ws?.readyState === WebSocket.OPEN && state) send({ t: 'visible', visible }, { lock: false });
}
document.addEventListener('visibilitychange', reportVisibility);
tg?.onEvent?.('activated', reportVisibility);
tg?.onEvent?.('deactivated', () => ws?.readyState === WebSocket.OPEN && send({ t: 'visible', visible: false }, { lock: false }));

/* ------------------------------------------------------------ state flow */

function onState(wasConnected) {
  const s = state;
  const p = prev;
  const mySeat = s.me.seat;

  // Your turn: say it with the body, not only with pixels.
  const myTurnNow = s.hand && s.hand.actorSeat === mySeat && mySeat >= 0;
  const myTurnBefore = p?.hand && p.hand.actorSeat === p.me.seat && p.hand.no === s.hand?.no;
  if (myTurnNow && !myTurnBefore) {
    haptic.turn();
    turnId++;
  }

  // You won something.
  const won = s.hand?.result?.winners?.some((w) => w.seat === mySeat);
  const wonBefore = p?.hand?.no === s.hand?.no && p?.hand?.result?.winners?.some((w) => w.seat === mySeat);
  if (won && !wonBefore) setTimeout(haptic.win, (planFor(s)?.pay ?? 0) + 400); // not before the cards say so

  if (s.room.notice && s.room.notice !== p?.room?.notice) toast(s.room.notice, 3200);

  // Sheets that no longer make sense close themselves.
  if (openSheet === 'raise' && !s.legal) closeSheet();
  if (openSheet === 'winner' && !s.winnerFlow) closeSheet();
  if (s.winnerFlow?.primary && s.winnerFlow.canDecide && openSheet !== 'winner' && !winnerDismissed(s)) openWinner();

  trackFinale(s, p);
  render();
  if (openSheet && sheetRenderers[openSheet]) sheetRenderers[openSheet]();
  if (!wasConnected) reportVisibility();
  if (p) motionFor(p, s, { myTurnStarted: myTurnNow && !myTurnBefore });
}

let turnId = 0;

/** Where a seat's chips live on screen: the hero panel for you, the seat otherwise. */
function stackEl(seat) {
  if (seat === state?.me?.seat) return document.querySelector('.hero-stack');
  return document.querySelector(`.seat[data-seat="${seat}"] .stk`);
}

/**
 * What just happened, told with motion: chips into the pot, cards into the
 * muck, the pot pushed to whoever won it. Worked out from the difference
 * between the previous state and this one — the server sends states, not events.
 */
function motionFor(p, s, { myTurnStarted }) {
  if (REDUCED || s.room.status === 'lobby') return;
  const hd = s.hand;
  const ph = p.hand;
  const potEl = document.querySelector('.pot');
  if (myTurnStarted) edgeGlow();
  if (!hd || !ph || ph.no !== hd.no) return;

  // Chips went in: they came from whoever was on the clock.
  const chipsIn = hd.pot > ph.pot && ph.phase === 'betting' && ph.actorSeat != null;
  if (chipsIn) {
    const mover = s.players.find((x) => x.seat === ph.actorSeat);
    flyChips(stackEl(ph.actorSeat), potEl, { n: mover?.allIn ? 7 : 3 });
  }

  // Folds: two cards into the middle.
  for (const x of s.players) {
    const was = p.players.find((y) => y.seat === x.seat);
    if (was?.inHand && !was.folded && x.folded && x.seat !== s.me.seat) {
      muck(document.querySelector(`.seat[data-seat="${x.seat}"]`), document.querySelector('.board'));
    }
  }

  // The pot goes to the winners — once, when the result is first known.
  const paidBefore = ph.phase === 'complete' && ph.result && !ph.revealing;
  const paidNow = hd.phase === 'complete' && hd.result && !hd.revealing;
  if (paidNow && !paidBefore && hd.result.kind !== 'aborted') {
    for (const w of hd.result.winners) {
      const target = stackEl(w.seat);
      const lead = Math.max(planFor(s)?.pay ?? 120, chipsIn ? 520 : 120); // the last call lands in the pot first
      flyChips(potEl, target, { n: 6, delay: lead, stagger: 55 });
      celebrate(w.seat === s.me.seat ? target : target?.closest('.seat')?.querySelector('.av'), { sparks: w.seat === s.me.seat ? 14 : 0, delay: lead + 420 });
    }
  }
}

/*
 * The hand that ends the game is played out on the table like any other —
 * board, hands, the winning five, the chips — and only then do the results
 * of the evening take over. Only for a finale you watched happen: opening
 * the app on a game that ended an hour ago goes straight to the results.
 */
let finale = null; // { no, until }
function trackFinale(s, p) {
  const hd = s.hand;
  if (s.room.status !== 'finished' || !hd || hd.phase !== 'complete') return;
  if (p && p.room.status !== 'finished' && hd.result?.kind !== 'aborted') finale = { no: hd.no, until: null };
  if (finale?.no === hd.no && finale.until == null && hd.result && !hd.revealing) {
    finale.until = performance.now() + (planFor(s)?.pay ?? 0) + 3400;
    setTimeout(render, finale.until - performance.now() + 30);
  }
}
function inFinale() {
  const hd = state.hand;
  if (!finale || !hd || hd.no !== finale.no) return false;
  return hd.revealing || finale.until == null || performance.now() < finale.until;
}

let dismissedFlow = null;
const winnerDismissed = (s) => dismissedFlow === `${s.hand?.no}`;

/* -------------------------------------------------------------- rendering */

function render() {
  $app.replaceChildren();
  if (!tg || !initData) {
    $app.append(h('div.fatal', h('h2', 'Откройте стол из Telegram'), h('div', 'Это мини-приложение работает внутри Telegram: нажмите «Открыть стол» в группе.')));
    return;
  }
  if (fatal) {
    $app.append(h('div.fatal', h('div.boot-logo', '♠'), h('h2', fatal), h('button.btn.primary', { style: { padding: '0 24px' }, onclick: () => tg.close() }, 'Закрыть')));
    return;
  }
  if (!state) {
    $app.append(h('div.boot', h('div.boot-logo', '♠'), h('div', 'Подключаемся к столу…')));
    return;
  }
  if (state.room.status === 'lobby') renderLobby();
  else if (state.room.status === 'finished' && !inFinale()) renderResults();
  else renderTable();
  if (!connected) $app.append(h('div.conn', 'Нет связи — переподключаемся…'));
  tickClocks();
  flushAnimations({ still: !prev });
}

/* ----------------------------------------------------------------- lobby */

function renderLobby() {
  const s = state;
  const me = s.me;
  const seated = s.players.filter((p) => p.role === 'player' && p.status !== 'left');
  const dealer = s.players.find((p) => p.role === 'dealer');
  const slots = [];
  for (let i = 0; i < s.room.maxSeats; i++) {
    const p = seated[i];
    slots.push(
      p
        ? animateOnce(
          h(`div.lseat${p.isMe ? '.me' : ''}`, h('div.av', { style: { '--h': p.hue } }, initial(p.name), p.isHost ? h('span.host-mark', '👑') : null), h('div.nm', p.name)),
          `lseat:${p.name}`, [{ transform: 'scale(0.4)', opacity: 0, offset: 0 }], { duration: 450, delay: i * 45 })
        : h('div.lseat.empty', h('div.av', '+'), h('div.nm', 'свободно'))
    );
  }
  const st = s.room.settings;
  const tags = [
    `Стек ${fmt(st.startingStack)}`,
    `Блайнды ${fmt(st.smallBlind)}/${fmt(st.bigBlind)}`,
    st.turnSeconds ? `⏱ ${st.turnSeconds} с на ход` : 'Без таймера',
    s.room.cards === 'live' ? '🃏 Настоящие карты' : '🤖 Карты раздаёт бот',
  ];

  const lobby = h('div.lobby',
    h('div',
      h('h1', '♠️ Покерная комната'),
      h('div.sub', s.room.title ? `${s.room.title} · ` : '', `Игроков ${seated.length}/${s.room.maxSeats}`)),
    h('div.box', h('div.seats-grid', slots)),
    h('div.tags', tags.map((t) => h('span.tag', t))),
    s.room.cards === 'live'
      ? h('div.hint', dealer ? `Дилер — ${dealer.name}: раздаёт настоящие карты и отмечает победителя.` : 'Дилер не назначен — победителя отметит любой за столом. Назначить: ⋯ → Роли.')
      : null,
    notifyHint(),
    me.isHost ? h('button.menu-item', { onclick: openSettings }, 'Настройки стола', h('small', 'стек, блайнды, таймер, карты')) : null,
    me.isHost ? h('button.menu-item', { onclick: openMenu }, 'Хост', h('small', 'роли, удалить, передать')) : null,
  );

  const actions = h('div.panel');
  if (me.kicked) actions.append(h('div.hint', 'Хост удалил вас из этой игры.'));
  else if (me.seated && !me.sittingOut) actions.append(h('button.btn', { onclick: () => send({ t: 'leave' }) }, 'Встать'));
  else actions.append(h('button.btn.primary.lg', { onclick: () => { haptic.tap(); send({ t: 'sit' }); } }, 'Сесть за стол'));
  if (me.isHost) {
    actions.append(
      h('button.btn.primary.lg', { disabled: !s.canStart, onclick: () => { haptic.tap(); send({ t: 'start' }); } },
        '▶ Начать', s.canStart ? null : h('small', s.room.startBlocker || 'ждём игроков'))
    );
  }
  if (busy) actions.classList.add('busy');
  $app.append(lobby, actions);
}

function notifyHint() {
  const s = state;
  if (s.me.notify || !s.bot) return null;
  return h('div.hint', '🔔 Чтобы бот напомнил, когда ваш ход, а стол закрыт, — ',
    h('a', { href: '#', onclick: (e) => { e.preventDefault(); tg.openTelegramLink(`https://t.me/${s.bot}?start=notify`); } }, 'нажмите Start у бота'), '.');
}

/* ----------------------------------------------------------------- table */

function plateText(p, s) {
  const a = p.amount ? ` ${fmt(p.amount)}` : '';
  switch (p.status) {
    case 'turn': return 'ХОД';
    case 'bet': return `BET${a}`;
    case 'raise': return `RAISE${a}`;
    case 'call': return `CALL${a}`;
    case 'check': return 'CHECK';
    case 'fold': return 'FOLD';
    case 'allin': return `ALL-IN${a}`;
    case 'sb': return `SB${a}`;
    case 'bb': return `BB${a}`;
    case 'wait': return 'ЖДЁТ';
    case 'out': return 'ПРОПУСК';
    case 'broke': return 'БЕЗ ФИШЕК';
    case 'left': return 'ВЫШЕЛ';
    default: return s.hand?.phase === 'complete' && p.mucked ? 'НЕ ПОКАЗАЛ' : '';
  }
}

/*
 * The end of a hand, in order: the last card lands, the hands turn over, the
 * winning five light up — and only then do the chips go to the winner. Worked
 * out once per hand, on the state that first carries the result, so every
 * redraw after it keeps the same clock.
 */
const plans = new Map();
function planFor(s) {
  const hd = s.hand;
  if (!hd || hd.phase !== 'complete' || !hd.result || hd.revealing) return null;
  let plan = plans.get(hd.no);
  if (plan) return plan;
  const showdown = hd.result.winners.some((w) => w.best);
  // Did the last board card arrive with the result? Then it lands first.
  const lastCardNow = !!prev && prev.hand?.no === hd.no && (prev.hand.board?.length ?? 0) < hd.board.length;
  const flip = lastCardNow ? 700 : 0;
  if (!prev) plan = { flip: 0, best: 0, pay: 0 }; // opened on a finished hand: it is all there already
  else if (showdown) plan = { flip, best: flip + 800, pay: flip + 1900 };
  else plan = { flip: 0, best: 0, pay: 150 };
  plans.set(hd.no, plan);
  if (plans.size > 30) plans.delete(plans.keys().next().value);
  return plan;
}

/** The winning five of every winner — board cards and their own — as card codes. */
function bestOf(s) {
  const hd = s.hand;
  const all = new Set();
  const bySeat = new Map();
  if (hd?.phase === 'complete' && !hd.revealing) {
    for (const w of hd.result?.winners || []) {
      if (!w.best) continue;
      bySeat.set(w.seat, new Set(w.best));
      for (const c of w.best) all.add(c);
    }
  }
  return { all, bySeat, judged: all.size > 0 };
}

/** A card at the showdown: part of the winning five lifts up in gold, the rest go dark. */
function judge(img, isBest, key, plan) {
  if (isBest) {
    img.classList.add('best');
    animateOnce(img, `best:${key}`, [{ translate: '0 0', boxShadow: '0 3px 8px rgba(0, 0, 0, 0.35)', offset: 0 }], { duration: 600, delay: plan.best });
  } else {
    img.classList.add('dim');
    animateOnce(img, `dim:${key}`, [{ filter: 'none', offset: 0 }], { duration: 500, delay: plan.best });
  }
  return img;
}

/** Stacks fall fast when chips go in, and roll up slowly — once the chips arrive — when a pot comes back. */
function stackMotion(s) {
  const plan = planFor(s);
  return { up: { dur: 1400, delay: plan ? plan.pay + 450 : 520 }, down: { dur: 350 } };
}
const stackKey = (p) => `stk:${p.seat}:${p.name}`;

/** Where each seat is in the dealing order this hand: the deal goes round the table twice. */
let dealOrder = new Map();
function dealIn(el, hd, seat, k) {
  const i = dealOrder.get(seat) ?? 0;
  return animateOnce(el, `deal:${hd.no}:${seat}:${k}`, (node) => {
    const { dx, dy } = offsetTo(node, document.querySelector('.board'));
    return [{ transform: `translate(${dx}px, ${dy}px) rotate(${k ? 28 : -28}deg) scale(0.45)`, opacity: 0, offset: 0 }, { opacity: 1, offset: 0.2 }];
  }, { duration: 520, delay: (k * dealOrder.size + i) * 75 });
}

function seatEl(p, s) {
  const h0 = s.hand;
  const win = h0?.result?.winners?.find((w) => w.seat === p.seat);
  const plan = planFor(s) || { flip: 0, best: 0, pay: 0 };
  const best = bestOf(s);
  const away = ['out', 'left', 'broke', 'wait'].includes(p.status);
  const cls = ['seat', p.isActor && 'turn', (p.folded || p.status === 'fold') && 'folded', away && 'away', win && 'win']
    .filter(Boolean).join('.');

  const av = h('div.av', { style: { '--h': p.hue } }, initial(p.name));
  if (win) {
    animateOnce(av, `winav:${h0.no}:${p.seat}`,
      [{ borderColor: 'rgba(0, 0, 0, 0.5)', boxShadow: '0 4px 10px rgba(0, 0, 0, 0.45)', offset: 0 }], { duration: 500, delay: plan.best });
  }
  if (p.isActor && h0?.deadline && s.room.settings.turnSeconds) {
    av.append(ringSvg(h0.deadline, s.room.settings.turnSeconds));
  }
  if (p.isButton) av.append(h('span.dbtn', 'D'));

  let minis = null;
  if (p.cards) {
    // Shown at the showdown: the cards turn over right on top of the avatar.
    minis = h('div.minis.shown', p.cards.map((c, k) => {
      const img = animateOnce(cardImg(c), `show:${h0.no}:${p.seat}:${k}`,
        [{ transform: 'perspective(300px) rotateY(90deg) scale(0.9)', offset: 0 }], { duration: 460, delay: plan.flip + k * 110 });
      return best.judged ? judge(img, !!best.bySeat.get(p.seat)?.has(c), `${h0.no}:s${p.seat}:${c}`, plan) : img;
    }));
  } else if (p.inHand && !p.folded && !(h0?.phase === 'complete' && p.mucked)) {
    minis = h('div.minis', [0, 1].map((k) => dealIn(backImg(), h0, p.seat, k)));
  }

  // At the end of a hand the plate says how it ended for this player: the
  // pot they took, the hand they showed, or that they did not show.
  let text = plateText(p, s);
  let kind = p.status;
  if (h0?.phase === 'complete' && !win && p.handName) {
    text = p.handName;
    kind = 'hand';
  }
  const plate = win
    ? animateOnce(h(`div.plate.win${fmt(win.amount).length > 8 ? '.long' : ''}`, `+${fmt(win.amount)}`), `winplate:${h0.no}:${p.seat}`,
      [{ transform: 'translateY(10px) scale(0.3)', opacity: 0, offset: 0 }, { transform: 'scale(1.25)', opacity: 1, offset: 0.6 }],
      { duration: 700, delay: plan.pay + 400 })
    : text
      ? animateOnce(h(`div.plate.${kind}${text.length > 14 ? '.xlong' : text.length > 11 ? '.long' : ''}`, text), `plate:${h0?.no}:${h0?.street}:${p.seat}:${text}`,
        [{ transform: 'scale(0.55)', opacity: 0, offset: 0 }], { duration: 320, delay: h0?.phase === 'complete' ? plan.flip : 0 })
      : null;

  // A fixed-size box: where it goes is worked out by layoutTable().
  return h(`div.${cls}`, { 'data-seat': p.seat },
    h('div.pod', av, minis),
    h('div.info', h('div.nm', p.name), counter('div.stk.num', stackKey(p), p.stack, stackMotion(s))),
    plate,
  );
}

function ringSvg(deadline, total) {
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

function stageLabel(s) {
  const hd = s.hand;
  if (s.room.status === 'paused') return ['ПАУЗА', 'paused'];
  if (!hd) return ['—', ''];
  if (hd.revealing) return ['ALL-IN', 'show'];
  if (hd.phase === 'showdown') return ['SHOWDOWN', 'show'];
  if (hd.phase === 'complete') return [hd.result?.kind === 'fold' ? 'ИТОГ' : 'SHOWDOWN', 'show'];
  return [STAGE[hd.street] || hd.street, ''];
}

function renderTable() {
  const s = state;
  const hd = s.hand;
  const me = s.me;
  const [stage, stageCls] = stageLabel(s);

  const meta = [];
  if (hd) meta.push(h('b', `#${hd.no}`));
  meta.push(` · ${fmt(s.room.settings.smallBlind)}/${fmt(s.room.settings.bigBlind)}`);
  if (s.room.level) meta.push(` · ур. ${s.room.level}`);
  if (s.room.pendingBlinds) meta.push(` → ${fmt(s.room.pendingBlinds.sb)}/${fmt(s.room.pendingBlinds.bb)}`);
  if (s.room.cards === 'live') meta.push(s.room.dealerName ? ` · 🃏 ${s.room.dealerName}` : ' · 🃏 настоящие карты');

  const top = h('div.top',
    animateOnce(h(`div.stage${stageCls ? '.' + stageCls : ''}`, stage), `stage:${hd?.no}:${stage}`,
      [{ transform: 'scale(0.55)', opacity: 0, offset: 0 }], { duration: 420 }),
    h('div.top-meta', meta),
    h('button.icon-btn', { onclick: openMenu, 'aria-label': 'Меню' }, '⋯'),
  );

  // --- the felt
  const ring = s.players.filter((p) => p.role !== 'dealer' && p.status !== 'left');
  const meIdx = ring.findIndex((p) => p.isMe);
  const heroAtTable = meIdx >= 0;
  const others = heroAtTable ? [...ring.slice(meIdx + 1), ...ring.slice(0, meIdx)] : ring;
  dealOrder = new Map([...others, ...(heroAtTable ? [ring[meIdx]] : [])].map((p, i) => [p.seat, i]));

  const r = hd?.phase === 'complete' && !hd.revealing ? hd.result : null;
  const table = h('div.table', { 'data-hero': heroAtTable ? '1' : '0', 'data-lines': r?.kind === 'showdown' ? Math.max(1, resultRows(r).length) : 1 },
    h('div.felt'),
    centerEl(s),
    others.map((p) => seatEl(p, s)),
  );

  $app.append(top, table, heroEl(s), panelEl(s));
  layoutTable();
}

/* ---------------------------------------------------------- table layout */

/*
 * Where everything on the felt goes is worked out here, in pixels, from the
 * size the table actually has — not in fixed percentages, which on a short
 * screen put the top seat right on top of the pot. Seats sit on the rail of
 * an oval that keeps them inside the table; the board takes the width left
 * between the side seats; and if anything still touches anything, seats and
 * cards shrink together (--u) until nothing does.
 */
const SEAT_W = 104; // the widest thing in a seat: its plate
const SEAT_H = 90;
const EDGE = 4;

/*
 * Where the others sit around you, clockwise from your left, in degrees on
 * the oval (0 = right, 90 = down to you, 270 = the far side). Chosen like a
 * poker client's seat map: while there is room, nobody sits level with the
 * board, so the board can stay wide. With seven others somebody has to.
 */
const SEAT_MAP = {
  1: [270],
  2: [210, 330],
  3: [212, 270, 328],
  4: [150, 228, 312, 30],
  5: [148, 208, 270, 332, 32],
  6: [138, 202, 246, 294, 338, 42],
  7: [135, 180, 225, 270, 315, 0, 45],
};

function seatSpots(W, H, n, withHero, u) {
  const sw = SEAT_W * u;
  const sh = SEAT_H * u;
  const rx = Math.max(0, W / 2 - EDGE - sw / 2);
  const ry = Math.max(0, H / 2 - EDGE - sh / 2);
  const spots = [];
  for (let k = 0; k < n; k++) {
    const deg = withHero && SEAT_MAP[n] ? SEAT_MAP[n][k] : 90 + ((withHero ? (k + 1) / (n + 1) : (k + 0.5) / n) * 360);
    const th = (deg * Math.PI) / 180;
    spots.push({ x: W / 2 + rx * Math.cos(th), y: H / 2 + ry * Math.sin(th) });
  }
  return { spots, rx, ry, sw, sh };
}

/** The widest board cards that still pass between the seats level with the board. */
function boardCardWidth(W, H, u, geo, lines) {
  let cw = 48 * u;
  for (let i = 0; i < 3; i++) {
    const ch = (30 + 12 + 17 * lines) * u + cw * 1.4;
    const boardTop = H / 2 - ch / 2 + 36 * u;
    const boardBottom = boardTop + cw * 1.4;
    let half = W / 2 - EDGE;
    for (const p of geo.spots) {
      const dx = Math.abs(p.x - W / 2);
      if (dx < geo.sw / 2 + 24) continue; // right above or below the middle: a matter for --u, not for the cards
      if (p.y - geo.sh / 2 < boardBottom + 6 && p.y + geo.sh / 2 > boardTop - 6) half = Math.min(half, dx - geo.sw / 2 - 6);
    }
    cw = clamp(Math.min(48 * u, (2 * half - 16) / 5), 18, 56);
  }
  return cw;
}

function layoutTable() {
  const t = $app.querySelector('.table');
  if (!t) return;
  const W = t.clientWidth;
  const H = t.clientHeight;
  const seats = [...t.querySelectorAll('.seat')];
  const felt = t.querySelector('.felt');
  const withHero = t.dataset.hero === '1';
  const lines = Number(t.dataset.lines) || 1;
  const apply = (u) => {
    const geo = seatSpots(W, H, seats.length, withHero, u);
    const cw = boardCardWidth(W, H, u, geo, lines);
    t.style.setProperty('--u', u.toFixed(3));
    t.style.setProperty('--card-w', `${cw.toFixed(1)}px`);
    seats.forEach((el, k) => {
      el.style.left = `${geo.spots[k].x.toFixed(1)}px`;
      el.style.top = `${geo.spots[k].y.toFixed(1)}px`;
    });
    // The felt is the oval the seats sit on: each seat half on the rail.
    Object.assign(felt.style, {
      left: `${(W / 2 - geo.rx).toFixed(1)}px`,
      top: `${(H / 2 - geo.ry).toFixed(1)}px`,
      width: `${(2 * geo.rx).toFixed(1)}px`,
      height: `${(2 * geo.ry).toFixed(1)}px`,
    });
    return !crowded(t);
  };
  // The biggest scale at which nothing touches: two at a table have room
  // to be big even on a short screen, eight need to be small. Never below
  // 0.6: past that names stop being readable, and a table that small is
  // better slightly crowded than illegible.
  const MIN = 0.6;
  let hi = clamp(W / 390, MIN, 1.12);
  if (apply(hi)) return;
  let lo = MIN;
  if (!apply(lo)) return; // cannot fit at all: keep the smallest
  for (let i = 0; i < 6; i++) {
    const mid = (lo + hi) / 2;
    if (apply(mid)) lo = mid;
    else hi = mid;
  }
  // In steps of 0.05, so the table does not breathe every time a plate
  // changes from CALL to RAISE 16.000.000.
  const step = Math.max(MIN, Math.floor(lo * 20) / 20);
  if (!apply(step)) apply(lo);
}

/** Does any seat touch the middle, another seat, or the edge? Measured, not guessed — with room to breathe. */
function crowded(t) {
  const hit = (a, b, gap) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > -gap && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > -gap;
  const box = (el) => el.getBoundingClientRect();
  const tr = box(t);
  const middle = [t.querySelector('.pot'), t.querySelector('.board')].filter(Boolean).map(box);
  // The winning five lift out of the board (.card.best): count them lifted.
  if (middle[1]) middle[1] = { left: middle[1].left, right: middle[1].right, top: middle[1].top - 9, bottom: middle[1].bottom };
  const line = t.querySelector('.result-line, .bet-line');
  if (line?.textContent.trim()) {
    const range = document.createRange();
    range.selectNodeContents(line);
    middle.push(range.getBoundingClientRect());
  }
  // Boxes, not the cards inside them: a card in flight must not shrink the table.
  const seats = [...t.querySelectorAll('.seat')].map((el) => [...el.querySelectorAll('.pod, .minis, .info, .plate')].map(box));
  for (let i = 0; i < seats.length; i++) {
    for (const p of seats[i]) {
      if (p.left < tr.left + 2 || p.right > tr.right - 2 || p.top < tr.top + 1 || p.bottom > tr.bottom - 1) return true;
      if (middle.some((m) => hit(p, m, 4))) return true;
      for (let j = i + 1; j < seats.length; j++) if (seats[j].some((q) => hit(p, q, 2))) return true;
    }
  }
  return false;
}

window.addEventListener('resize', layoutTable);
tg?.onEvent?.('viewportChanged', layoutTable);

/** A board card lands: dealt from above and turned face up. The flop comes one card after another. */
function boardCard(el, hd, i) {
  return animateOnce(el, `board:${hd.no}:${i}`,
    [{ transform: 'translateY(-26px) perspective(500px) rotateY(100deg) scale(0.8)', opacity: 0, offset: 0 }, { opacity: 1, offset: 0.35 }],
    { duration: 560, delay: i < 3 ? i * 170 : 0 });
}

function centerEl(s) {
  const hd = s.hand;
  const board = h('div.board');
  if (hd) {
    if (hd.live) {
      for (let i = 0; i < 5; i++) board.append(i < hd.boardSlots ? boardCard(backImg(), hd, i) : h('div.slot'));
    } else {
      const best = bestOf(s);
      const plan = planFor(s);
      hd.board.forEach((c, i) => {
        const img = boardCard(cardImg(c), hd, i);
        board.append(best.judged && plan ? judge(img, best.all.has(c), `${hd.no}:b:${c}`, plan) : img);
      });
      for (let i = hd.board.length; i < 5; i++) board.append(h('div.slot'));
    }
  }

  let line = null;
  if (hd?.revealing) line = h('div.result-line', 'Открываем борд…');
  else if (hd?.phase === 'showdown' && hd.live) {
    const d = s.winnerFlow;
    line = h('div.result-line', d?.decider ? `${d.decider} определяет победителя…` : 'Отметьте победителя');
  } else if (hd?.phase === 'complete' && hd.result) {
    line = animateOnce(resultLine(s), `result:${hd.no}`, [{ transform: 'translateY(8px) scale(0.9)', opacity: 0, offset: 0 }],
      { duration: 450, delay: Math.max(250, planFor(s)?.best ?? 0) });
  }
  else if (hd?.currentBet) line = h('div.bet-line', `Ставка ${fmt(hd.currentBet)}`);
  else line = h('div.bet-line', '');

  // Once the result is known the pot is pushed to the winners: it drains while their stacks fill.
  const paid = hd?.phase === 'complete' && hd.result && !hd.revealing;
  return h('div.center',
    h('div.pot', h('small', 'POT'),
      counter('b.num', `pot:${hd?.no ?? 0}`, paid ? 0 : hd?.pot || 0,
        { up: { dur: 500, delay: 320 }, down: { dur: 900, delay: (planFor(s)?.pay ?? 100) + 250 } })),
    board,
    line,
  );
}

function resultLine(s) {
  const r = s.hand.result;
  const name = (seat) => s.players.find((p) => p.seat === seat)?.name ?? '?';
  if (r.kind === 'aborted') return h('div.result-line', 'Раздача прервана — фишки вернулись');
  if (r.kind === 'fold' && r.winners[0]) return h('div.result-line', `${name(r.winners[0].seat)} забирает ${fmt(r.winners[0].amount)}`);
  return h('div.result-line', resultRows(r).map((g) => `${g.names.map(name).join(' и ')} +${fmt(g.amount)}${g.hand ? ` · ${g.hand}` : ''}`).join('\n'));
}

/** One row per outcome: a pot split between equal hands is one row — «Lev и Иван +500 · Стрит». */
function resultRows(r) {
  const rows = [];
  for (const w of r.winners) {
    const same = rows.find((g) => g.amount === w.amount && g.hand === w.hand);
    if (same) same.names.push(w.seat);
    else rows.push({ names: [w.seat], amount: w.amount, hand: w.hand });
  }
  return rows;
}

function heroEl(s) {
  const me = s.me;
  const hd = s.hand;
  const mine = s.players.find((p) => p.isMe);

  if (me.role === 'dealer') {
    return h('div.hero',
      h('div.hero-cards.none', '🃏'),
      h('div.hero-info', h('div.hero-name', 'Вы дилер'), h('div.hero-hand', dealerHint(s)), h('div.hero-state', 'Карты раздаёте вы, фишки считает бот.')));
  }
  if (!me.seated || !mine) {
    return h('div.hero',
      h('div.hero-cards.none', 'Вы смотрите'),
      h('div.hero-info', h('div.hero-name', me.kicked ? 'Хост удалил вас из игры' : 'Вы не за столом'), h('div.hero-state', me.kicked ? '' : 'Сядьте — раздача придёт со следующей.')));
  }

  const myTurn = hd && hd.actorSeat === me.seat;
  let cards;
  if (hd && hd.live && mine.inHand) {
    cards = h('div.hero-cards', [0, 1].map((k) => dealIn(backImg(), hd, me.seat, k)));
  } else if (me.cards?.length) {
    const best = bestOf(s);
    const plan = planFor(s);
    cards = h('div.hero-cards', me.cards.map((c, k) => {
      const img = dealIn(cardImg(c), hd, me.seat, k);
      return best.judged && plan ? judge(img, !!best.bySeat.get(me.seat)?.has(c), `${hd.no}:me:${c}`, plan) : img;
    }));
  } else {
    cards = h('div.hero-cards.none', mine.status === 'out' ? 'Вы пропускаете раздачи' : 'Ждём следующую раздачу');
  }

  const info = h('div.hero-info');
  if (myTurn) {
    const urgent = hd.deadline && hd.deadline - serverNow() < 10_000;
    info.append(animateOnce(h(`div.your-turn${urgent ? '.urgent' : ''}`, 'ВАШ ХОД', hd.deadline ? h('span.num', { 'data-count': hd.deadline }) : null),
      `yt:${turnId}`, [{ transform: 'scale(0.5)', opacity: 0, offset: 0 }, { transform: 'scale(1.12)', opacity: 1, offset: 0.6 }], { duration: 420 }));
  }
  info.append(h('div.hero-name', mine.name));
  // Your balance, and what the last pot added to it — rolling up as the chips arrive.
  const won = hd?.phase === 'complete' && !hd.revealing ? hd.result?.winners?.find((w) => w.seat === mine.seat) : null;
  info.append(h('div.hero-stack-row',
    counter('div.hero-stack.num', stackKey(mine), mine.stack, stackMotion(s)),
    won ? animateOnce(h('span.gain.num', `+${fmt(won.amount)}`), `gain:${hd.no}`,
      [{ transform: 'translate(-10px, 12px) scale(0.3)', opacity: 0, offset: 0 }, { transform: 'scale(1.3)', opacity: 1, offset: 0.55 }],
      { duration: 750, delay: (planFor(s)?.pay ?? 80) + 400 }) : null));
  const handName = hd?.live ? (mine.inHand ? 'Ваши карты — у вас на руках' : '') : me.handName || '';
  info.append(h('div.hero-hand', handName));
  const note = heroNote(s, mine);
  if (note) info.append(h('div.hero-state', note));

  const folded = mine.folded && hd?.phase !== 'complete';
  if (folded) animateOnce(cards, `fold:${hd.no}`, [{ transform: 'translateY(0)', opacity: 1, filter: 'none', offset: 0 }, { transform: 'translateY(-14px) rotate(-4deg)', opacity: 0.7, offset: 0.4 }], { duration: 480 });
  const cls = ['hero', myTurn && 'turn', folded && 'folded'].filter(Boolean).join('.');
  return h(`div.${cls}`, cards, info);
}

function heroNote(s, mine) {
  const hd = s.hand;
  if (!hd) return '';
  if (hd.phase === 'complete') return ''; // a win is the gold "+N" next to the balance
  if (mine.folded) return 'Вы сбросили — ждём конца раздачи';
  if (mine.allIn) return 'Вы в олл-ине — ходить больше не нужно';
  if (mine.bet) return `Ваша ставка ${fmt(mine.bet)}`;
  return '';
}

function dealerHint(s) {
  const hd = s.hand;
  if (!hd) return '';
  if (hd.phase === 'showdown') return 'Вскрытие — отметьте победителя';
  if (hd.phase === 'complete') return 'Соберите карты и перетасуйте';
  return { preflop: 'Раздайте по 2 карты', flop: 'Выложите флоп — 3 карты', turn: 'Выложите тёрн', river: 'Выложите ривер' }[hd.street] || '';
}

function panelEl(s) {
  const hd = s.hand;
  const me = s.me;
  const L = s.legal;
  const panel = h('div.panel');
  const note = (...kids) => {
    panel.className = 'panel note';
    panel.append(...kids.filter((k) => k != null && k !== false));
    return panel;
  };
  const actorName = hd ? s.players.find((p) => p.seat === hd.actorSeat)?.name : null;

  if (s.room.status === 'paused') {
    if (me.isHost) {
      panel.append(h('button.btn.primary.wide', { onclick: () => send({ t: 'resume' }) }, '▶ Продолжить игру'));
      return panel;
    }
    return note('⏸ Пауза — хост продолжит игру');
  }
  // Not at the table (a spectator, or sat out): the one thing to offer is a seat.
  const mine = s.players.find((p) => p.isMe);
  const inThisHand = mine?.inHand && hd && hd.phase !== 'complete';
  if (!me.kicked && me.role !== 'dealer' && (!me.seated || (me.sittingOut && !inThisHand))) {
    panel.append(h('button.btn.primary.wide', { onclick: () => { haptic.tap(); send({ t: 'sit' }); } },
      me.seated ? 'Вернуться за стол' : 'Сесть за стол', h('small', 'со следующей раздачи')));
    return panel;
  }

  if (hd?.phase === 'betting') {
    if (L) {
      if (L.toCall > 0) panel.append(h('button.btn.danger', { onclick: () => act('fold') }, 'FOLD'));
      if (L.canCheck) panel.append(h('button.btn.primary', { onclick: () => act('check') }, 'CHECK'));
      else if (L.canCall) {
        panel.append(h('button.btn.primary', { onclick: () => act('call') },
          `CALL ${fmt(L.callAmount)}`, L.isCallAllIn ? h('small', 'это весь стек') : null));
      }
      if (L.canBet || L.canRaise) panel.append(h('button.btn.gold', { onclick: openRaise }, L.canBet ? 'BET' : 'RAISE'));
      [...panel.children].forEach((b, i) => animateOnce(b, `btn:${turnId}:${i}`,
        [{ transform: 'translateY(18px) scale(0.92)', opacity: 0, offset: 0 }], { duration: 380, delay: 60 + i * 60 }));
      if (busy) panel.classList.add('busy');
      return panel;
    }
    if (mine?.folded) return note('Вы сбросили — ждём конца раздачи');
    if (mine?.allIn) return note('Вы в олл-ине — ждём вскрытия');
    return note('Ход: ', h('b', actorName || '—'), hd.deadline ? h('span.num', { 'data-count': hd.deadline, style: { marginLeft: '8px' } }) : null);
  }

  if (hd?.phase === 'showdown' && hd.live) {
    if (s.winnerFlow?.canDecide) {
      panel.append(h('button.btn.gold.wide.lg', { onclick: openWinner }, '🏆 Кто выиграл?'));
      return panel;
    }
    return note(s.winnerFlow?.decider ? `${s.winnerFlow.decider} определяет победителя…` : 'Отмечают победителя…');
  }

  if (hd?.phase === 'complete') {
    if (hd.revealing) return note('Открываем борд…');
    if (s.room.status === 'finished') {
      panel.append(animateOnce(h('button.btn.gold.wide.lg', { onclick: () => { finale = null; render(); } }, '🏁 Итоги вечера'),
        `finale:${hd.no}`, [{ transform: 'translateY(18px)', opacity: 0, offset: 0 }], { duration: 420, delay: (planFor(s)?.pay ?? 0) + 900 }));
      return panel;
    }
    if (s.canNext) {
      panel.append(animateOnce(h('button.btn.primary.wide.lg', { onclick: () => { haptic.tap(); send({ t: 'next' }); } },
        'Следующая раздача', s.autoNextAt ? h('small', { 'data-count': s.autoNextAt, 'data-prefix': 'сама через ' }) : null),
      `next:${hd.no}`, [{ transform: 'translateY(18px)', opacity: 0, offset: 0 }], { duration: 420, delay: (planFor(s)?.pay ?? 0) + 900 }));
      if (busy) panel.classList.add('busy');
      return panel;
    }
    if (s.room.cards === 'live' && s.room.dealerName) return note(`Следующую раздачу начнёт ${s.room.dealerName}`);
    return note('Ждём следующую раздачу…');
  }
  return note('');
}

/* ---------------------------------------------------------------- results */

function renderResults() {
  const rows = state.results || [];
  const box = h('div.lobby',
    h('div', h('h1', '🏁 Итоги'), h('div.sub', `Раздач сыграно: ${state.room.handNo}`)),
    h('div.box', rows.map((r) => h('div.res-row',
      h('span.n', r.name, r.isHost ? ' 👑' : '', r.role === 'dealer' ? ' · дилер' : '', r.kicked ? ' · удалён' : ''),
      h('span.s.num', fmt(r.stack)),
      h(`span.pl.num.${r.net > 0 ? 'up' : r.net < 0 ? 'down' : ''}`, r.net > 0 ? `+${fmt(r.net)}` : r.net < 0 ? `−${fmt(-r.net)}` : '0'),
    ))),
    h('div.hint', 'Итоги вечера бот отправил и в группу.'),
  );
  $app.append(box, h('div.panel', h('button.btn.primary.wide.lg', { onclick: () => tg.close() }, 'Закрыть')));
}

/* ------------------------------------------------------------------ clocks */

/** Deadlines tick on the page; the server keeps the real time. */
function tickClocks() {
  const now = serverNow();
  for (const el of document.querySelectorAll('[data-count]')) {
    const left = Math.max(0, Number(el.dataset.count) - now);
    const sec = Math.ceil(left / 1000);
    el.textContent = `${el.dataset.prefix || ''}${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    el.closest('.your-turn')?.classList.toggle('urgent', left > 0 && left < 10_000);
  }
  for (const svg of document.querySelectorAll('svg.ring')) {
    const total = Number(svg.dataset.total) || 1;
    const left = Math.max(0, Number(svg.dataset.deadline) - now);
    const C = 2 * Math.PI * 25;
    svg.firstChild.setAttribute('stroke-dashoffset', (C * (1 - left / total)).toFixed(2));
    svg.classList.toggle('low', left < 10_000);
  }
}
setInterval(tickClocks, 250);

/* ------------------------------------------------------------------ sheets */

let openSheet = null;
const sheetRenderers = {};

function showSheet(name, build) {
  openSheet = name;
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

function closeSheet(byUser = false) {
  if (byUser && openSheet === 'winner' && state?.hand) dismissedFlow = `${state.hand.no}`;
  openSheet = null;
  $sheets.replaceChildren();
}

/* --- raise: two taps for a size, a third only for the whole stack */

let allinArmed = false;
function openRaise() {
  haptic.soft();
  allinArmed = false;
  const L0 = state.legal;
  let value = clamp(L0.presets.find((p) => p.kind === 'size')?.total ?? L0.minTotal, L0.minTotal, L0.maxTotal);

  showSheet('raise', () => {
    const L = state.legal;
    if (!L || !(L.canBet || L.canRaise)) return null;
    value = clamp(value, L.minTotal, L.maxTotal);
    const verb = L.canBet ? 'bet' : 'raise';
    const word = L.canBet ? 'BET' : 'RAISE';

    const sizes = h('div.grid2', L.presets.map((p) => {
      if (p.kind === 'allin') {
        return h(`button.btn.size-btn.${allinArmed ? 'danger' : 'gold'}`, {
          onclick: () => {
            if (!allinArmed) {
              allinArmed = true;
              haptic.soft();
              return sheetRenderers.raise();
            }
            act('allin');
          },
        }, allinArmed ? 'Точно весь стек?' : 'ALL-IN', h('b.num', fmt(p.total)));
      }
      return h('button.btn.size-btn', { onclick: () => act(verb, p.total) }, p.label, h('b.num', fmt(p.total)));
    }));

    const amountEl = h(`div.amount.num${value >= L.maxTotal ? '.max' : ''}`, fmt(value));
    const sub = h('div.amount-sub');
    const confirm = h('button.btn.primary.wide.lg');
    const sync = () => {
      amountEl.textContent = fmt(value);
      amountEl.classList.toggle('max', value >= L.maxTotal);
      slider.style.setProperty('--pct', `${L.maxTotal === L.minTotal ? 100 : ((value - L.minTotal) / (L.maxTotal - L.minTotal)) * 100}%`);
      sub.textContent = value >= L.maxTotal ? 'Весь стек' : `Добавите ${fmt(value - L.myBet)} · останется ${fmt(L.stack - (value - L.myBet))}`;
      confirm.textContent = value >= L.maxTotal ? `ALL-IN ${fmt(value)}` : `${word} ДО ${fmt(value)}`;
    };
    const step = Math.max(1, Math.round(state.room.settings.bigBlind / 2));
    const slider = h('input.slider', {
      type: 'range', min: L.minTotal, max: L.maxTotal, step: 1, value,
      oninput: (e) => {
        const v = Number(e.target.value);
        value = v >= L.maxTotal - step / 2 ? L.maxTotal : v <= L.minTotal ? L.minTotal : Math.round(v / step) * step;
        value = clamp(value, L.minTotal, L.maxTotal);
        sync();
      },
    });
    confirm.onclick = () => {
      if (value >= L.maxTotal) {
        if (!allinArmed) {
          allinArmed = true;
          confirm.textContent = `Точно ALL-IN ${fmt(value)}?`;
          confirm.className = 'btn danger wide lg';
          return;
        }
        return act('allin');
      }
      act(verb, value);
    };
    sync();
    return h('div',
      h('h3', L.canBet ? 'Ставка' : 'Рейз'),
      h('div.sub', `от ${fmt(L.minTotal)} до ${fmt(L.maxTotal)} · сумма — сколько всего будет перед вами`),
      sizes,
      amountEl, sub, slider, confirm,
    );
  });
}

/* --- the dealer's "who won?" — pot by pot, then the engine's own split */

function openWinner() {
  haptic.soft();
  showSheet('winner', () => {
    const f = state.winnerFlow;
    if (!f) return null;
    const name = (seat) => state.players.find((p) => p.seat === seat)?.name ?? '?';
    const hue = (seat) => state.players.find((p) => p.seat === seat)?.hue ?? 0;

    if (f.review) {
      return h('div',
        h('h3', 'Распределение'),
        h('div.sub', 'Фишки двигаются только после подтверждения.'),
        f.pots.map((pot) => h('div.review-row',
          h('span', pot.label, ' · ', h('span.num', fmt(pot.amount))),
          h('span', pot.refund ? `${name(pot.winners[0])} (возврат)` : pot.winners.map(name).join(' + ')))),
        h('div.section-label', 'На руки'),
        f.preview.map((x) => h('div.pay-row', h('span', x.name), h('span.num', `+${fmt(x.amount)}`))),
        h('div.grid2', { style: { marginTop: '14px' } },
          h('button.btn', { onclick: () => send({ t: 'potBack' }) }, '← Назад'),
          h('button.btn.primary', { disabled: !f.canDecide, onclick: () => { haptic.tap(); send({ t: 'confirm', seq: state.seq }); } }, '✅ Подтвердить')),
      );
    }

    const pot = f.pots[f.potIndex];
    const at = f.steps.indexOf(f.potIndex);
    return h('div',
      h('h3', 'Кто выиграл?'),
      h('div.sub', `${pot.label} · ${fmt(pot.amount)}`, f.steps.length > 1 ? ` · банк ${at + 1} из ${f.steps.length}` : '',
        ' — можно отметить нескольких, банк разделится'),
      h('div.pick-grid', pot.eligible.map((seat) => h(`button.pick${pot.winners.includes(seat) ? '.on' : ''}`, {
        onclick: () => { haptic.soft(); send({ t: 'pick', pot: f.potIndex, seat }, { lock: false }); },
      }, h('div.av', { style: { '--h': hue(seat) } }, initial(name(seat))), name(seat)))),
      h('div.grid2',
        h('button.btn', { disabled: at <= 0, onclick: () => send({ t: 'potBack' }) }, '← Назад'),
        h('button.btn.primary', { disabled: !pot.winners.length, onclick: () => send({ t: 'potNext' }) }, at + 1 < f.steps.length ? 'Далее →' : 'Итог →')),
    );
  });
}

/* --- menu */

function openMenu() {
  haptic.soft();
  showSheet('menu', () => {
    const s = state;
    const me = s.me;
    const items = [];
    const item = (label, sub, onclick, cls = '') => items.push(h(`button.menu-item${cls ? '.' + cls : ''}`, { onclick }, label, sub ? h('small', sub) : null));

    if (me.seated && !me.sittingOut && me.role === 'player' && s.room.status !== 'lobby') {
      item('Встать из-за стола', me.inHand && !me.folded ? 'ваши карты будут сброшены' : 'пропускать раздачи', () => { closeSheet(); send({ t: 'leave' }); });
    } else if (!me.kicked && me.role !== 'dealer' && (me.sittingOut || !me.seated)) {
      item('Сесть за стол', 'со следующей раздачи', () => { closeSheet(); send({ t: 'sit' }); });
    }
    if (!me.notify && s.bot) item('🔔 Напоминать о ходе', 'нажмите Start у бота', () => tg.openTelegramLink(`https://t.me/${s.bot}?start=notify`));

    if (me.isHost) {
      items.push(h('div.section-label', 'Хост'));
      item('Настройки стола', 'блайнды, таймер, карты', openSettings);
      if (s.room.status !== 'lobby') item('Докупка', 'стартовый стек игроку', () => openPlayers('rebuy'));
      if (s.room.cards === 'live') item('Роли', 'кто дилер', openRoles);
      item('Передать права хоста', null, () => openPlayers('host'));
      item('Удалить игрока', 'фишки в банке останутся в банке', () => openPlayers('kick'));
      if (s.room.status === 'playing') item('Пауза', 'остановит таймеры', () => { closeSheet(); send({ t: 'pause' }); });
      if (s.room.status === 'paused') item('Продолжить игру', null, () => { closeSheet(); send({ t: 'resume' }); });
      item('Отменить последнее действие хоста', 'ставки и карты не отменяются', () => { closeSheet(); send({ t: 'undo' }); });
      if (s.room.status !== 'lobby') item('Завершить игру', 'итоги — всем и в группу', () => confirmFinish(), 'danger');
    }
    return h('div', h('h3', 'Меню'), h('div.sub', s.room.title || 'Покерная комната'), h('div.menu-list', items));
  });
}

function confirmFinish() {
  showSheet('finish', () => h('div',
    h('h3', 'Завершить игру?'),
    h('div.sub', 'Незаконченная раздача отменится, фишки вернутся владельцам. Итоги увидят все.'),
    h('div.grid2',
      h('button.btn', { onclick: () => closeSheet() }, 'Отмена'),
      h('button.btn.danger', { onclick: () => { closeSheet(); send({ t: 'finish' }); } }, 'Завершить')),
  ));
}

function openPlayers(kind) {
  const titles = { rebuy: 'Докупка', host: 'Передать права хоста', kick: 'Удалить игрока' };
  showSheet(`players-${kind}`, () => {
    const s = state;
    const list = s.players.filter((p) => (kind === 'rebuy' ? p.role === 'player' : !p.isMe) && p.status !== 'left');
    const step = s.room.settings.startingStack;
    return h('div',
      h('h3', titles[kind]),
      h('div.sub', kind === 'rebuy' ? `+${fmt(step)} фишек — идёт и в стек, и в бай-ин` : kind === 'kick' ? 'Фишки в банке останутся в банке, результат — в итогах.' : 'Хост управляет настройками и завершением игры.'),
      h('div.menu-list', list.map((p) => h(`button.menu-item${kind === 'kick' ? '.danger' : ''}`, {
        onclick: () => {
          send({ t: kind, seat: p.seat }, { lock: false });
          if (kind !== 'rebuy') closeSheet();
        },
      }, p.name, h('small.num', kind === 'rebuy' ? `${fmt(p.stack)} → ${fmt(p.stack + step)}` : fmt(p.stack))))),
    );
  });
}

function openRoles() {
  showSheet('roles', () => {
    const s = state;
    return h('div',
      h('h3', 'Роли'),
      h('div.sub', 'Дилер раздаёт настоящие карты, не играет и отмечает победителя. Дилер один.'),
      h('div.menu-list', s.players.filter((p) => p.status !== 'left').map((p) => h('button.menu-item', {
        onclick: () => send({ t: 'role', seat: p.seat, role: p.role === 'dealer' ? 'player' : 'dealer' }, { lock: false }),
      }, p.name, h('small', p.role === 'dealer' ? '🃏 дилер' : p.pendingRole === 'dealer' ? '→ дилер со следующей раздачи' : 'игрок')))),
    );
  });
}

function openSettings() {
  const s0 = state;
  const st = { ...s0.room.settings, cards: s0.room.cards };
  const inLobby = s0.room.status === 'lobby';
  const midHand = s0.hand && s0.hand.phase !== 'complete';
  showSheet('settings', () => {
    const numField = (label, key, disabled) => h('div.field', h('label', label),
      h('input.num', { type: 'number', inputmode: 'numeric', value: st[key], disabled, oninput: (e) => (st[key] = Number(e.target.value)) }));
    const seg = (options, key) => h('div.seg', options.map(([v, label]) => h(`button${st[key] === v ? '.on' : ''}`, {
      onclick: () => { st[key] = v; sheetRenderers.settings(); },
    }, label)));
    return h('div',
      h('h3', 'Настройки стола'),
      h('div.sub', inLobby ? 'До старта можно менять всё.' : 'Блайнды — со следующей раздачи. Стек после старта не меняется.'),
      numField('Стартовый стек', 'startingStack', !inLobby),
      numField('Малый блайнд', 'smallBlind'),
      numField('Большой блайнд', 'bigBlind'),
      h('div.section-label', 'Таймер хода'),
      seg([[0, 'Выкл'], [30, '30 с'], [60, '60 с'], [90, '90 с'], [120, '2 мин']], 'turnSeconds'),
      h('div.hint', { style: { marginTop: '6px' } }, 'Не успел — чек, если можно, иначе фолд. С таймером раздачи идут сами.'),
      h('div.section-label', 'Карты'),
      midHand ? h('div.hint', 'Режим карт меняется между раздачами.') : seg([['virtual', '🤖 Раздаёт бот'], ['live', '🃏 Настоящие']], 'cards'),
      h('button.btn.primary.wide.lg', { style: { marginTop: '16px', width: '100%' }, onclick: () => {
        const patch = { t: 'settings', smallBlind: st.smallBlind, bigBlind: st.bigBlind, turnSeconds: st.turnSeconds };
        if (inLobby) patch.startingStack = st.startingStack;
        if (!midHand) patch.cards = st.cards;
        send(patch);
        closeSheet();
      } }, 'Сохранить'),
    );
  });
}

/* ------------------------------------------------------------------ start */

if (tg) {
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.(); // the raise slider must not close the app
  try {
    tg.setHeaderColor?.('#0a0f0c');
    tg.setBackgroundColor?.('#0a0f0c');
    tg.setBottomBarColor?.('#0a0f0c');
  } catch {
    /* older clients */
  }
}
render();
if (tg && initData) connect();
