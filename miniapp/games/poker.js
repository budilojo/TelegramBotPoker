/**
 * The poker table, inside Telegram — one game of the hub.
 *
 * The page is a view, never a judge: every state it shows comes from the
 * server, built for THIS player only (their cards, nobody else's), and every
 * tap is a request the server re-checks against the player's signed identity.
 * Nothing here decides whose turn it is or what is legal — the buttons simply
 * show what the server said is legal right now.
 *
 * One main screen during the game. Everything else (raise sizes, the menu,
 * the dealer's "who won?") slides up over it and goes away.
 *
 * Moved here from app.js as it was; the shell (app.js) now picks the screen.
 */
import {
  tg, $app, h, fmt, clamp, cardImg, backImg, initial, STAGE, haptic, REDUCED, counter, animateOnce, offsetTo,
  flyChips, muck, celebrate, edgeGlow, toast, ringSvg, showSheet, closeSheet, refreshSheet, currentSheet,
} from '../ui.js';
import { net, bus, send, serverNow } from '../net.js';

let state = null;
let prev = null;

/** A new state from the server, and the one before it on this table (or null). */
export function onState(s, p, { wasConnected }) {
  state = s;
  prev = p;
  handleState(wasConnected);
}

/** The whole screen, from the current state. */
export function render() {
  if (state.room.status === 'lobby') renderLobby();
  else if (state.room.status === 'finished' && !inFinale()) renderResults();
  else renderTable();
}

/** Back to the group's list of games — only for a page that came from it. */
function backToHub(s) {
  if (!s.hub) return null;
  return h('button.back-link', { onclick: () => send({ t: 'hub' }, { lock: false }) }, '← Все игры группы');
}

function act(action, amount) {
  haptic.tap();
  closeSheet();
  send({ t: 'act', action, amount, seq: state.seq });
}


/* ------------------------------------------------------------ state flow */

function handleState(wasConnected) {
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
  if (currentSheet() === 'raise' && !s.legal) closeSheet();
  if (currentSheet() === 'winner' && !s.winnerFlow) closeSheet();
  if (s.winnerFlow?.primary && s.winnerFlow.canDecide && currentSheet() !== 'winner' && !winnerDismissed(s)) openWinner();

  trackFinale(s, p);
  bus.render();
  refreshSheet();
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
    setTimeout(() => bus.render(), finale.until - performance.now() + 30);
  }
}
function inFinale() {
  const hd = state.hand;
  if (!finale || !hd || hd.no !== finale.no) return false;
  return hd.revealing || finale.until == null || performance.now() < finale.until;
}

let dismissedFlow = null;
const winnerDismissed = (s) => dismissedFlow === `${s.hand?.no}`;

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
    backToHub(s),
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
  if (net.busy) actions.classList.add('busy');
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
  // All-in: the hands were turned face up before the board ran out (TDA), so
  // there is nothing left to turn over — the winning five light up sooner.
  const handsWereUp = !!prev && prev.hand?.no === hd.no && prev.players.some((x) => x.cards && !x.isMe);
  const best = flip + (handsWereUp ? 400 : 800);
  if (!prev) plan = { flip: 0, best: 0, pay: 0 }; // opened on a finished hand: it is all there already
  else if (showdown) plan = { flip, best, pay: best + 1100 };
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
      if (net.busy) panel.classList.add('busy');
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
      panel.append(animateOnce(h('button.btn.gold.wide.lg', { onclick: () => { finale = null; bus.render(); } }, '🏁 Итоги вечера'),
        `finale:${hd.no}`, [{ transform: 'translateY(18px)', opacity: 0, offset: 0 }], { duration: 420, delay: (planFor(s)?.pay ?? 0) + 900 }));
      return panel;
    }
    if (s.canNext) {
      panel.append(animateOnce(h('button.btn.primary.wide.lg', { onclick: () => { haptic.tap(); send({ t: 'next' }); } },
        'Следующая раздача', s.autoNextAt ? h('small', { 'data-count': s.autoNextAt, 'data-prefix': 'сама через ' }) : null),
      `next:${hd.no}`, [{ transform: 'translateY(18px)', opacity: 0, offset: 0 }], { duration: 420, delay: (planFor(s)?.pay ?? 0) + 900 }));
      if (net.busy) panel.classList.add('busy');
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

/* ------------------------------------------------------------------ sheets */

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
              return refreshSheet();
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
  }, { onDismiss: () => { if (state?.hand) dismissedFlow = `${state.hand.no}`; } });
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
    if (s.hub) item('← Все игры группы', 'стол останется, как есть', () => { closeSheet(); send({ t: 'hub' }, { lock: false }); });

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
      onclick: () => { st[key] = v; refreshSheet(); },
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
