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

const NBSP = ' ';
const fmt = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
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
  if (myTurnNow && !myTurnBefore) haptic.turn();

  // You won something.
  const won = s.hand?.result?.winners?.some((w) => w.seat === mySeat);
  const wonBefore = p?.hand?.no === s.hand?.no && p?.hand?.result?.winners?.some((w) => w.seat === mySeat);
  if (won && !wonBefore) haptic.win();

  if (s.room.notice && s.room.notice !== p?.room?.notice) toast(s.room.notice, 3200);

  // Sheets that no longer make sense close themselves.
  if (openSheet === 'raise' && !s.legal) closeSheet();
  if (openSheet === 'winner' && !s.winnerFlow) closeSheet();
  if (s.winnerFlow?.primary && s.winnerFlow.canDecide && openSheet !== 'winner' && !winnerDismissed(s)) openWinner();

  render();
  if (openSheet && sheetRenderers[openSheet]) sheetRenderers[openSheet]();
  if (!wasConnected) reportVisibility();
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
  else if (state.room.status === 'finished') renderResults();
  else renderTable();
  if (!connected) $app.append(h('div.conn', 'Нет связи — переподключаемся…'));
  tickClocks();
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
        ? h(`div.lseat${p.isMe ? '.me' : ''}`, h('div.av', { style: { '--h': p.hue } }, initial(p.name), p.isHost ? h('span.host-mark', '👑') : null), h('div.nm', p.name))
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

/** Seats around the oval, clockwise from you at the bottom — as at a real table. */
function positions(n, withHero) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = withHero ? (i + 1) / (n + 1) : (i + 0.5) / n;
    const th = Math.PI / 2 + t * 2 * Math.PI;
    out.push({ x: clamp(50 + 43 * Math.cos(th), 13, 87), y: clamp(50 + 45 * Math.sin(th), 10, 90) });
  }
  return out;
}

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

function seatEl(p, pos, s) {
  const h0 = s.hand;
  const win = h0?.result?.winners?.find((w) => w.seat === p.seat);
  const away = ['out', 'left', 'broke', 'wait'].includes(p.status);
  const cls = ['seat', p.isActor && 'turn', (p.folded || p.status === 'fold') && 'folded', away && 'away', win && 'win']
    .filter(Boolean).join('.');

  const av = h('div.av', { style: { '--h': p.hue } }, initial(p.name));
  if (p.isActor && h0?.deadline && s.room.settings.turnSeconds) {
    av.append(ringSvg(h0.deadline, s.room.settings.turnSeconds));
  }
  if (p.isButton) av.append(h('span.dbtn', 'D'));

  let minis = null;
  if (p.cards) {
    minis = h('div.minis.shown', p.cards.map((c) => cardImg(c, isNewShown(p) ? 'deal' : '')));
  } else if (p.inHand && !p.folded && !(h0?.phase === 'complete' && p.mucked)) {
    minis = h('div.minis', backImg(), backImg());
  }

  const plate = win
    ? h('div.plate.win', `+${fmt(win.amount)}`)
    : plateText(p, s)
      ? h(`div.plate.${p.status}`, plateText(p, s))
      : null;

  return h(`div.${cls}`, { style: { left: `${pos.x}%`, top: `${pos.y}%` } },
    av,
    h('div.nm', p.name),
    h('div.stk.num', fmt(p.stack)),
    plate,
    minis,
    p.handName ? h('div.hand-tag', p.handName) : null,
  );
}

function isNewShown(p) {
  const before = prev?.players?.find((x) => x.seat === p.seat);
  return !before?.cards;
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
    h(`div.stage${stageCls ? '.' + stageCls : ''}`, stage),
    h('div.top-meta', meta),
    h('button.icon-btn', { onclick: openMenu, 'aria-label': 'Меню' }, '⋯'),
  );

  // --- the felt
  const ring = s.players.filter((p) => p.role !== 'dealer' && p.status !== 'left');
  const meIdx = ring.findIndex((p) => p.isMe);
  const heroAtTable = meIdx >= 0;
  const others = heroAtTable ? [...ring.slice(meIdx + 1), ...ring.slice(0, meIdx)] : ring;
  const pos = positions(others.length, heroAtTable);

  const table = h('div.table',
    h('div.felt'),
    centerEl(s),
    others.map((p, i) => seatEl(p, pos[i], s)),
  );

  $app.append(top, table, heroEl(s), panelEl(s));
}

function centerEl(s) {
  const hd = s.hand;
  const board = h('div.board');
  const prevBoard = prev?.hand?.no === hd?.no ? prev.hand.board : [];
  if (hd) {
    if (hd.live) {
      for (let i = 0; i < 5; i++) board.append(i < hd.boardSlots ? backImg() : h('div.slot'));
    } else {
      hd.board.forEach((c) => board.append(cardImg(c, prevBoard.includes(c) ? '' : 'deal')));
      for (let i = hd.board.length; i < 5; i++) board.append(h('div.slot'));
    }
  }

  let line = null;
  if (hd?.revealing) line = h('div.result-line', 'Открываем борд…');
  else if (hd?.phase === 'showdown' && hd.live) {
    const d = s.winnerFlow;
    line = h('div.result-line', d?.decider ? `${d.decider} определяет победителя…` : 'Отметьте победителя');
  } else if (hd?.phase === 'complete' && hd.result) line = resultLine(s);
  else if (hd?.currentBet) line = h('div.bet-line', `Ставка ${fmt(hd.currentBet)}`);
  else line = h('div.bet-line', '');

  return h('div.center',
    h('div.pot', h('small', 'POT'), h('b.num', fmt(hd?.pot || 0))),
    board,
    line,
  );
}

function resultLine(s) {
  const r = s.hand.result;
  const name = (seat) => s.players.find((p) => p.seat === seat)?.name ?? '?';
  if (r.kind === 'aborted') return h('div.result-line', 'Раздача прервана — фишки вернулись');
  const parts = r.winners.map((w) => `${name(w.seat)} +${fmt(w.amount)}${w.hand ? ` · ${w.hand}` : ''}`);
  if (r.kind === 'fold' && r.winners[0]) return h('div.result-line', `${name(r.winners[0].seat)} забирает ${fmt(r.winners[0].amount)}`);
  return h('div.result-line', parts.join('\n'));
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
    cards = h('div.hero-cards', backImg(), backImg());
  } else if (me.cards?.length) {
    const fresh = prev?.hand?.no !== hd?.no;
    cards = h('div.hero-cards', me.cards.map((c) => cardImg(c, fresh ? 'deal' : '')));
  } else {
    cards = h('div.hero-cards.none', mine.status === 'out' ? 'Вы пропускаете раздачи' : 'Ждём следующую раздачу');
  }

  const info = h('div.hero-info');
  if (myTurn) info.append(h('div.your-turn', 'ВАШ ХОД', hd.deadline ? h('span.num', { 'data-count': hd.deadline }) : null));
  info.append(h('div.hero-name', mine.name));
  info.append(h('div.hero-stack.num', fmt(mine.stack)));
  const handName = hd?.live ? (mine.inHand ? 'Ваши карты — у вас на руках' : '') : me.handName || '';
  info.append(h('div.hero-hand', handName));
  const note = heroNote(s, mine);
  if (note) info.append(h('div.hero-state', note));

  const cls = ['hero', myTurn && 'turn', mine.folded && hd?.phase !== 'complete' && 'folded'].filter(Boolean).join('.');
  return h(`div.${cls}`, cards, info);
}

function heroNote(s, mine) {
  const hd = s.hand;
  if (!hd) return '';
  if (hd.phase === 'complete') {
    const w = hd.result?.winners?.find((x) => x.seat === mine.seat);
    return w ? `Вы забрали ${fmt(w.amount)}` : '';
  }
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
    if (s.canNext) {
      panel.append(h('button.btn.primary.wide.lg', { onclick: () => { haptic.tap(); send({ t: 'next' }); } },
        'Следующая раздача', s.autoNextAt ? h('small', { 'data-count': s.autoNextAt, 'data-prefix': 'сама через ' }) : null));
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
