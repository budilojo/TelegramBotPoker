/**
 * The durak table, inside Telegram — one game of the hub.
 *
 * Like the poker table, the page is a view and never a judge: the server
 * sends THIS player's own cards and the moves that are legal for them right
 * now, and re-checks every tap. The cards lit up in your hand are simply the
 * ones the server said you may play.
 *
 *   your cards — a fan at the bottom, big: tap to pick one, tap again to play
 *   (a defender taps the card on the table to cover it);
 *   the table — attack/defence pairs; the pack with the trump under it; the
 *   discard, face down;
 *   the others round the top of the table — how many cards, and what they
 *   are doing: ⚔ attacking, 🛡 defending, taking, «пас», out.
 */
import {
  tg, $app, h, clamp, cardImg, backImg, haptic, animateOnce, centerOf, offsetTo, spawn, edgeGlow, celebrate,
  toast, ringSvg, showSheet, closeSheet, refreshSheet, avatar, REDUCED,
} from '../ui.js';
import { net, bus, send } from '../net.js';

let state = null;
let prev = null;
/** The card picked in your hand (first tap), or null. */
let picked = null;

const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_RU = { J: 'В', Q: 'Д', K: 'К', A: 'Т' };
const label = (c) => `${RANK_RU[c.slice(0, -1)] || c.slice(0, -1)}${SUIT[c.slice(-1)]}`;
const TIMERS = [[0, 'Выкл'], [30, '30 с'], [60, '60 с'], [90, '90 с']];

export function onState(s, p) {
  state = s;
  prev = p;
  const me = s.me;
  if (picked && !me.cards.includes(picked)) picked = null;

  const myMove = mustAct(s);
  const before = p ? mustAct(p) : false;
  if (myMove && !before) haptic.turn();
  if (s.room.notice && s.room.notice !== p?.room?.notice) toast(s.room.notice, 3200);
  const fool = s.deal?.result?.foolSeat;
  const fresh = s.deal?.result && !p?.deal?.result && p?.deal?.no === s.deal.no;
  if (fresh && fool === me.seat) setTimeout(haptic.err, 300);
  else if (fresh && me.inDeal) setTimeout(haptic.win, 300);

  bus.render();
  refreshSheet();
  if (p) motion(p, s, { myMoveStarted: myMove && !before });
}

/** Is the game waiting for me? */
function mustAct(s) {
  const L = s.legal;
  if (!L || !s.deal || s.deal.phase !== 'play') return false;
  if (L.lead) return true;
  if (s.me.seat === s.deal.defenderSeat && !s.deal.taking && !s.deal.covered) return true;
  return !!L.pass;
}

export function render() {
  const s = state;
  if (s.room.status === 'lobby') return renderLobby();
  if (s.room.status === 'finished') return renderResults();
  renderTable();
}

/* ------------------------------------------------------------------ lobby */

function backToHub(s) {
  if (!s.hub) return null;
  return h('button.back-link', { onclick: () => send({ t: 'hub' }, { lock: false }) }, '← Все игры группы');
}

function renderLobby() {
  const s = state;
  const me = s.me;
  const seated = s.players.filter((p) => p.seated);
  const slots = [];
  for (let i = 0; i < s.room.maxSeats; i++) {
    const p = seated[i];
    slots.push(p
      ? animateOnce(h(`div.lseat${p.isMe ? '.me' : ''}`, withMark(avatar(p.name, p.hue), p.isHost), h('div.nm', p.name)),
        `dklseat:${p.name}`, [{ transform: 'scale(0.4)', opacity: 0, offset: 0 }], { duration: 450, delay: i * 45 })
      : h('div.lseat.empty', h('div.av', '+'), h('div.nm', 'свободно')));
  }
  const st = s.room.settings;
  const lobby = h('div.lobby',
    backToHub(s),
    h('div',
      h('h1', '🃏 Дурак'),
      h('div.sub', `${s.room.variantName} · Игроков ${seated.length}/${s.room.maxSeats}`)),
    h('div.box', h('div.seats-grid.six', slots)),
    h('div.tags',
      h('span.tag', st.variant === 'perevodnoy' ? '↪ Переводной' : '➕ Подкидной'),
      h('span.tag', st.turnSeconds ? `⏱ ${st.turnSeconds} с на ход` : 'Без таймера'),
      h('span.tag', '36 карт · по 6')),
    h('div.hint', st.variant === 'perevodnoy'
      ? 'Переводной: пока ни одна карта не побита, отбивающийся может перевести атаку картой того же достоинства.'
      : 'Подкидной: подкидывают все, кроме отбивающегося, — карты тех достоинств, что уже на столе.'),
    notifyHint(),
    me.isHost ? h('button.menu-item', { onclick: openSettings }, 'Настройки', h('small', 'вариант, таймер хода')) : null,
    me.isHost ? h('button.menu-item', { onclick: openMenu }, 'Хост', h('small', 'удалить, передать')) : null,
  );
  const actions = h('div.panel');
  if (me.kicked) actions.append(h('div.hint', 'Хост удалил вас из этой игры.'));
  else if (me.seated) actions.append(h('button.btn', { onclick: () => send({ t: 'leave' }) }, 'Встать'));
  else actions.append(h('button.btn.primary.lg', { onclick: () => { haptic.tap(); send({ t: 'sit' }); } }, 'Сесть за стол'));
  if (me.isHost) {
    actions.append(h('button.btn.primary.lg', { disabled: !s.canStart, onclick: () => { haptic.tap(); send({ t: 'start' }); } },
      '▶ Начать', s.canStart ? null : h('small', s.room.startBlocker || 'ждём игроков')));
  }
  if (net.busy) actions.classList.add('busy');
  $app.append(lobby, actions);
}

const withMark = (av, host) => {
  if (host) av.append(h('span.host-mark', '👑'));
  return av;
};

function notifyHint() {
  const s = state;
  if (s.me.notify || !s.bot) return null;
  return h('div.hint', '🔔 Чтобы бот напомнил, когда ваш ход, а приложение закрыто, — ',
    h('a', { href: '#', onclick: (e) => { e.preventDefault(); tg.openTelegramLink(`https://t.me/${s.bot}?start=notify`); } }, 'нажмите Start у бота'), '.');
}

/* ------------------------------------------------------------------ table */

const PLATE = { attacker: '⚔ ХОДИТ', defender: '🛡 ОТБИВАЕТСЯ', taking: 'БЕРЁТ', out: 'ВЫШЕЛ', fool: '🤡 ДУРАК' };

function seatEl(p, s) {
  const d = s.deal;
  // After the game only the durak is marked: everybody else simply is not one.
  const role = d?.phase === 'play' ? p.role : d?.result && !d.result.aborted && p.role === 'fool' ? 'fool' : null;
  let text = PLATE[role] || '';
  let kind = role || '';
  if (role === 'thrower' || (role === 'attacker' && (d.covered || d.taking))) {
    if (p.passed) [text, kind] = ['ПАС', 'passed'];
    else if (p.waiting) [text, kind] = [role === 'attacker' && !d.taking ? '⚔ БИТО?' : 'ДУМАЕТ', 'thinking'];
    else if (role === 'thrower') [text, kind] = ['', ''];
  }
  const waitingOnThem = d?.phase === 'play' && (
    (role === 'defender' && !d.covered) || (d.table.length === 0 && role === 'attacker') || p.waiting);
  const av = avatar(p.name, p.hue);
  if (p.isHost) av.append(h('span.host-mark', '👑'));
  if (p.lastFool && d?.phase === 'play') av.append(h('span.fool-mark', '🤡'));
  if (waitingOnThem && d.deadline && s.room.settings.turnSeconds) av.append(ringSvg(d.deadline, s.room.settings.turnSeconds));

  const n = p.count;
  const fan = n ? h('div.dk-backs', Array.from({ length: Math.min(n, 5) }, (_, i) => backImg(`b${i}`))) : null;
  const cls = ['dk-seat', waitingOnThem && 'turn', role === 'defender' || role === 'taking' ? 'def' : '', role === 'attacker' ? 'att' : '',
    (role === 'out' || (!p.inDeal && d?.phase === 'play')) && 'away', role === 'fool' && 'fool'].filter(Boolean).join('.');
  return h(`div.${cls}`, { 'data-seat': p.seat },
    h('div.pod', av, fan, n ? h('span.dk-count.num', String(n)) : null),
    h('div.info', h('div.nm', p.name), h('div.sub2', p.games ? `дурак ${p.fools}` : p.inDeal ? '' : 'со след. партии')),
    text ? animateOnce(h(`div.plate.${kind || 'in'}${text.length > 9 ? '.long' : ''}`, text), `dkplate:${d?.no}:${d?.bout}:${p.seat}:${text}`,
      [{ transform: 'scale(0.55)', opacity: 0, offset: 0 }], { duration: 300 }) : null,
  );
}

function stage(s) {
  const d = s.deal;
  if (!d) return ['ПАРТИЯ', ''];
  if (d.phase === 'over') return [d.result?.aborted ? 'ПРЕРВАНА' : 'ИТОГ', 'show'];
  return [`ПАРТИЯ ${d.no}`, ''];
}

function renderTable() {
  const s = state;
  const d = s.deal;
  const [st, stCls] = stage(s);
  const top = h('div.top',
    animateOnce(h(`div.stage${stCls ? '.' + stCls : ''}`, st), `dkstage:${d?.no}:${st}`, [{ transform: 'scale(0.55)', opacity: 0, offset: 0 }], { duration: 420 }),
    h('div.top-meta', s.room.variantName, d ? [' · козырь ', h(`b.suit.s${d.trump}`, SUIT[d.trump])] : null),
    h('button.icon-btn', { onclick: openMenu, 'aria-label': 'Меню' }, '⋯'),
  );

  // The others, clockwise from your left — as you would see them round a table.
  const ring = s.players.filter((p) => p.inDeal || (!d || d.phase === 'over' ? p.seated : false));
  const meIdx = ring.findIndex((p) => p.isMe);
  const others = meIdx >= 0 ? [...ring.slice(meIdx + 1), ...ring.slice(0, meIdx)] : ring;

  const felt = h('div.dk-felt', { 'data-n': others.length },
    h('div.dk-cloth'),
    middleEl(s),
    others.map((p) => seatEl(p, s)),
  );
  $app.append(top, felt, heroEl(s), panelEl(s));
  layoutHand();
  layoutDurak();
}

/* ---------------------------------------------------------- the middle */

function middleEl(s) {
  const d = s.deal;
  const mid = h('div.dk-mid');
  if (!d) return mid;

  // The pack: its size, and the trump face up under it.
  const stock = h('div.dk-stock',
    h('div.dk-deck', d.talon > 0
      ? [h('div.dk-trump', cardImg(d.trumpCard)), d.talon > 1 ? backImg('deck') : null, h('span.dk-deck-n.num', String(d.talon))]
      : h(`div.dk-trump-suit.s${d.trump}`, SUIT[d.trump], h('small', d.trumpHolderSeat >= 0 && d.talon === 0 && !s.deal.last ? `козырь ${label(d.trumpCard)}` : 'козырь'))),
    h('div.dk-discard', d.discard > 0 ? [backImg('d0'), d.discard > 2 ? backImg('d1') : null, h('span.dk-deck-n.num', `бито ${d.discard}`)] : h('span.dk-empty', 'сброс')),
  );

  const me = s.me;
  const L = s.legal;
  const iDefend = d.phase === 'play' && me.seat === d.defenderSeat && !d.taking;
  const pickTargets = iDefend && picked ? (L?.defend?.[picked] || []) : [];
  const pairs = h('div.dk-pairs', { 'data-n': d.table.length },
    d.table.map((x, i) => {
      const target = pickTargets.includes(i);
      const a = animateOnce(cardImg(x.a, 'att'), `dka:${d.no}:${d.bout}:${i}:${x.a}`, (node) => {
        const from = fromSeat(x.by, s);
        const { dx, dy } = offsetTo(node, from);
        return [{ transform: `translate(${dx}px, ${dy}px) scale(0.6) rotate(-12deg)`, opacity: 0.2, offset: 0 }];
      }, { duration: 420 });
      const def = x.d ? animateOnce(cardImg(x.d, 'def'), `dkd:${d.no}:${d.bout}:${i}:${x.d}`, (node) => {
        const { dx, dy } = offsetTo(node, fromSeat(x.dby, s));
        return [{ transform: `translate(${dx}px, ${dy}px) scale(0.6) rotate(20deg)`, opacity: 0.2, offset: 0 }];
      }, { duration: 420 }) : null;
      return h(`button.dk-pair${target ? '.target' : ''}${x.d ? '.covered' : ''}`, {
        'data-i': i,
        onclick: () => onTableTap(i),
        'aria-label': x.d ? `${label(x.a)} побита ${label(x.d)}` : `${label(x.a)} — не побита`,
      }, a, def);
    }));

  return h('div.dk-mid', stock, pairs, h('div.dk-line', lineText(s)));
}

/** Where a card on the table came from: that player's seat, or your own hand. */
function fromSeat(seat, s) {
  if (seat === s.me.seat) return document.querySelector('.dk-hand');
  return document.querySelector(`.dk-seat[data-seat="${seat}"] .pod`);
}

const nameAt = (s, seat) => s.players.find((p) => p.seat === seat)?.name ?? '—';

function lineText(s) {
  const d = s.deal;
  if (d.phase === 'over') {
    if (d.result?.aborted) return 'Партия прервана — не засчитывается';
    if (d.result?.draw) return '🤝 Ничья: карты кончились у всех разом';
    return `🤡 Дурак — ${nameAt(s, d.result.foolSeat)}`;
  }
  const att = nameAt(s, d.attackerSeat);
  const def = nameAt(s, d.defenderSeat);
  if (!d.table.length) return `Ходит ${att} · отбивается ${def}`;
  if (d.taking) return `${def} берёт — можно подкинуть вдогонку`;
  if (d.covered) return `${def} отбился — подкидывайте или «Бито»`;
  return `${def} отбивается`;
}

/* ------------------------------------------------------------- your hand */

function heroEl(s) {
  const me = s.me;
  const d = s.deal;
  const L = s.legal;
  if (!me.inDeal) {
    return h('div.hero.dk-hero',
      h('div.dk-role.watch', me.kicked ? 'ХОСТ УДАЛИЛ ВАС' : 'ВЫ СМОТРИТЕ'),
      h('div.dk-hand.none', me.seated ? 'Вас сдадут со следующей партии' : 'Сядьте — сдадут со следующей партии'));
  }
  const role = roleText(s);
  if (d?.phase === 'over') {
    const rows = s.score.filter((r) => r.games > 0);
    return h('div.hero.dk-hero',
      h(`div.dk-role${role.kind ? '.' + role.kind : ''}`, role.text),
      h('div.dk-score', rows.map((r) => h(`div.dk-sc${r.name === me.name ? '.me' : ''}`, h('span', r.name), h('b.num', String(r.fool)))),
        h('div.dk-sc-cap', `дурак, раз · партий ${s.history}`)));
  }
  const myMove = mustAct(s);
  const playable = new Set([...(L?.attack || []), ...Object.keys(L?.defend || {}), ...(L?.transfer || [])]);
  const cards = me.cards;
  const cardEl = (c, k) => {
    const img = cardImg(c, [playable.has(c) ? 'ok' : myMove || playable.size ? 'no' : '', picked === c ? 'picked' : '', c.slice(-1) === d?.trump ? 'trump' : ''].filter(Boolean).join('.'));
    const btn = h('button.dk-card', { onclick: () => onHandTap(c), 'aria-label': label(c), 'data-card': c }, img);
    return dealIn(btn, c, k, s);
  };
  // A big hand (a few takes) goes in two rows before the cards turn into
  // slivers too thin for a thumb (~28 px of each card showing).
  const rows = twoRows(cards.length) ? [cards.slice(0, Math.ceil(cards.length / 2)), cards.slice(Math.ceil(cards.length / 2))] : [cards];
  let k = 0;
  const hand = h('div.dk-hand', { 'data-n': cards.length },
    cards.length ? rows.map((row) => h('div.dk-row', row.map((c) => cardEl(c, k++)))) : h('div.dk-empty-hand', 'Карт нет'));
  const cls = ['hero', 'dk-hero', myMove && 'turn'].filter(Boolean).join('.');
  return h(`div.${cls}`,
    h(`div.dk-role${myMove ? '.go' : ''}${role.kind ? '.' + role.kind : ''}`, role.text,
      myMove && d?.deadline ? h('span.num', { 'data-count': d.deadline, style: { marginLeft: '8px' } }) : null),
    hand);
}

function twoRows(n) {
  if (n <= 6) return false;
  const W = Math.min(innerWidth, 520);
  const cw = clamp(W * 0.165, 52, 70);
  return (W - 40 - cw) / (n - 1) < 28;
}

/** A card that arrived in your hand flies in from the pack (or from the table, if you took). */
function dealIn(el, c, k, s) {
  const d = s.deal;
  const had = prev?.deal?.no === d?.no ? new Set(prev.me.cards) : null;
  if (had?.has(c)) return el;
  const fromTable = !!had && prev.deal.table.some((x) => x.a === c || x.d === c);
  const key = `dkin:${d?.no}:${c}:${d?.bout ?? 'end'}`;
  return animateOnce(el, key, (node) => {
    const src = fromTable ? document.querySelector('.dk-pairs') : document.querySelector('.dk-deck');
    const { dx, dy } = offsetTo(node, src);
    return [{ transform: `translate(${dx}px, ${dy}px) scale(0.5) rotate(${fromTable ? 0 : -20}deg)`, opacity: 0, offset: 0 }, { opacity: 1, offset: 0.25 }];
  }, { duration: 520, delay: had ? 0 : k * 70 });
}

function roleText(s) {
  const d = s.deal;
  const L = s.legal;
  const me = s.me;
  if (d.phase === 'over') {
    if (d.result?.aborted) return { text: 'ПАРТИЯ ПРЕРВАНА' };
    if (d.result?.foolSeat === me.seat) return { text: '🤡 ВЫ ДУРАК', kind: 'fool' };
    return { text: d.result?.draw ? 'НИЧЬЯ' : 'ВЫ НЕ ДУРАК 🎉', kind: 'won' };
  }
  if (me.role === 'out') return { text: 'ВЫ ВЫШЛИ — ждём остальных', kind: 'out' };
  if (L?.lead) return { text: `ВЫ ХОДИТЕ · на ${nameAt(s, d.defenderSeat)}`, kind: 'att' };
  if (me.seat === d.defenderSeat) {
    if (d.taking) return { text: 'ВЫ БЕРЁТЕ', kind: 'def' };
    if (d.covered) return { text: 'ВЫ ОТБИЛИСЬ — ждём «бито»', kind: 'def' };
    return { text: 'ВЫ ОТБИВАЕТЕСЬ', kind: 'def' };
  }
  if (L?.attack?.length) return { text: d.taking ? 'МОЖНО ПОДКИНУТЬ ВДОГОНКУ' : 'МОЖНО ПОДКИНУТЬ', kind: 'att' };
  if (L?.pass) return { text: `НЕЧЕГО ПОДКИНУТЬ? — «${L.passLabel.toUpperCase()}»`, kind: 'att' };
  if (!d.table.length) return { text: `Ходит ${nameAt(s, d.attackerSeat)}` };
  return { text: me.role === 'attacker' ? 'ВЫ ХОДИТЕ' : 'ВЫ ПОДКИДЫВАЕТЕ' };
}

/* --------------------------------------------------------------- taps */

function onHandTap(c) {
  const s = state;
  const L = s.legal;
  if (!L) return;
  const d = s.deal;
  const iDefend = s.me.seat === d.defenderSeat && !d.taking;
  if (picked !== c) {
    picked = c;
    haptic.soft();
    bus.render();
    // One possible target: say where it goes before the second tap.
    return;
  }
  // The second tap on the same card plays it.
  if (iDefend) {
    const targets = L.defend?.[c] || [];
    if (targets.length === 1) return play({ t: 'defend', card: c, target: targets[0] });
    if (targets.length > 1) return toast('Тапните по карте на столе, которую кроете');
    if (L.transfer?.includes(c)) return toast('Перевести — кнопкой «Перевести»');
    haptic.err();
    return toast(`${label(c)} здесь ничего не бьёт`);
  }
  if (L.attack?.includes(c)) return play({ t: 'attack', card: c });
  // Not legal: let the server say why, in words — it knows the rule that stops it.
  return play({ t: 'attack', card: c });
}

function onTableTap(i) {
  const s = state;
  const d = s.deal;
  if (!picked || s.me.seat !== d.defenderSeat || d.taking) return;
  play({ t: 'defend', card: picked, target: i });
}

function play(msg) {
  haptic.tap();
  picked = null;
  send({ ...msg, seq: state.seq });
}

/* --------------------------------------------------------------- panel */

function panelEl(s) {
  const d = s.deal;
  const me = s.me;
  const L = s.legal;
  const panel = h('div.panel');
  const note = (...kids) => {
    panel.className = 'panel note';
    panel.append(...kids.filter(Boolean));
    return panel;
  };
  if (d?.phase === 'over') {
    if (!me.seated && !me.kicked) {
      panel.append(h('button.btn.primary.wide.lg', { onclick: () => { haptic.tap(); send({ t: 'sit' }); } }, 'Сесть за стол', h('small', 'со следующей партии')));
      return panel;
    }
    if (s.canNext) {
      panel.append(animateOnce(h('button.btn.primary.wide.lg', { onclick: () => { haptic.tap(); send({ t: 'next' }); } }, 'Следующая партия'),
        `dknext:${d.no}`, [{ transform: 'translateY(18px)', opacity: 0, offset: 0 }], { duration: 420, delay: 700 }));
      if (net.busy) panel.classList.add('busy');
      return panel;
    }
    return note(s.room.startBlocker || 'Ждём следующую партию…');
  }
  if (!me.inDeal) {
    if (!me.seated && !me.kicked) {
      panel.append(h('button.btn.primary.wide.lg', { onclick: () => { haptic.tap(); send({ t: 'sit' }); } }, 'Сесть за стол', h('small', 'со следующей партии')));
      return panel;
    }
    return note(lineText(s));
  }
  if (L) {
    if (L.take) panel.append(h('button.btn.danger', { onclick: () => play({ t: 'take' }) }, 'ВЗЯТЬ'));
    if (L.transfer?.length) {
      panel.append(h('button.btn.gold', { onclick: () => {
        const card = L.transfer.includes(picked) ? picked : L.transfer.length === 1 ? L.transfer[0] : null;
        if (!card) return toast('Выберите карту для перевода');
        play({ t: 'transfer', card });
      } }, 'ПЕРЕВЕСТИ', h('small', L.transfer.length === 1 ? label(L.transfer[0]) : 'картой того же достоинства')));
    }
    if (L.pass) panel.append(h(`button.btn.${L.passLabel === 'Бито' ? 'primary' : ''}`, { onclick: () => play({ t: 'pass' }) }, L.passLabel.toUpperCase()));
  }
  if (panel.children.length) {
    [...panel.children].forEach((b, i) => animateOnce(b, `dkbtn:${d.no}:${d.bout}:${d.table.length}:${d.taking}:${i}:${b.textContent}`,
      [{ transform: 'translateY(18px) scale(0.92)', opacity: 0, offset: 0 }], { duration: 340, delay: 40 + i * 50 }));
    if (net.busy) panel.classList.add('busy');
    return panel;
  }
  if (L?.lead) return note(picked ? 'Ещё тап по карте — сходить ею' : 'Ваш ход: тап по карте — выбрать, второй — сходить');
  if (me.role === 'out') return note('Вы вышли из партии — ждём остальных');
  if (me.seat === d.defenderSeat && !d.taking && !d.covered) return note('Выберите карту и тапните по карте на столе, которую кроете');
  if (L?.attack?.length) return note(picked ? 'Ещё тап по карте — подкинуть' : 'Подкинуть — два тапа по карте');
  if (!d.table.length) return note('Ждём первый ход…');
  return note('Ждём, пока ', h('b', nameAt(s, d.defenderSeat)), d.taking ? ' заберёт карты' : ' отобьётся');
}

/* ------------------------------------------------------------- motion */

/** What happened between two states, told with motion: бито to the discard, a take to the taker. */
function motion(p, s, { myMoveStarted }) {
  if (REDUCED) return;
  if (myMoveStarted) edgeGlow();
  const d = s.deal;
  const pd = p.deal;
  if (!d || !pd || pd.no !== d.no) return;
  const last = d.last;
  if (last && last.bout === pd.bout && pd.table.length && (!d.table.length || d.bout !== pd.bout)) {
    const from = document.querySelector('.dk-pairs');
    const at = from ? centerOf(from) : null;
    const to = last.kind === 'beaten'
      ? document.querySelector('.dk-discard')
      : last.defenderSeat === s.me.seat ? document.querySelector('.dk-hand') : document.querySelector(`.dk-seat[data-seat="${last.defenderSeat}"] .pod`);
    if (at && to) {
      const b = centerOf(to);
      for (let i = 0; i < Math.min(last.n, 8); i++) {
        spawn('img.card.fx-card.dk-fly', { x: at.x + (i - last.n / 2) * 8, y: at.y }, [
          { transform: `rotate(${(i - 3) * 6}deg)`, opacity: 1 },
          { transform: `translate(${b.x - at.x}px, ${b.y - at.y}px) rotate(${last.kind === 'beaten' ? 90 : 0}deg) scale(0.55)`, opacity: 0.2 },
        ], { duration: 560, delay: i * 45, easing: 'cubic-bezier(0.5, 0, 0.3, 1)' }, { src: '/cards/back.svg', alt: '' });
      }
    }
  }
  // Somebody else drew: backs fly from the pack to them.
  const deck = document.querySelector('.dk-deck');
  if (deck && pd.talon > d.talon) {
    for (const x of s.players) {
      if (x.isMe) continue;
      const was = p.players.find((y) => y.seat === x.seat);
      const got = x.count - (was?.count ?? 0);
      if (got <= 0 || last?.kind === 'taken' && last.defenderSeat === x.seat) continue;
      const to = document.querySelector(`.dk-seat[data-seat="${x.seat}"] .pod`);
      if (!to) continue;
      const a = centerOf(deck);
      const b = centerOf(to);
      for (let i = 0; i < Math.min(got, 6); i++) {
        spawn('img.card.fx-card', a, [
          { transform: 'scale(0.8)', opacity: 1 },
          { transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) scale(0.4)`, opacity: 0.1 },
        ], { duration: 480, delay: 200 + i * 60 }, { src: '/cards/back.svg', alt: '' });
      }
    }
  }
  // The end of a game: the durak's seat — or yours — gets the spotlight.
  if (d.result && !pd.result && !d.result.aborted && d.result.foolSeat >= 0) {
    const el = d.result.foolSeat === s.me.seat ? document.querySelector('.dk-role') : document.querySelector(`.dk-seat[data-seat="${d.result.foolSeat}"] .av`);
    celebrate(el, { sparks: 10, delay: 200 });
  }
}

/* --------------------------------------------------------- the layout */

/*
 * The others sit on the upper arc of an oval; the pack, the table and the
 * line under it take the middle. Worked out in pixels from the size the felt
 * really has, and scaled together (--u) until nothing touches anything —
 * checked by `npm run layout` for 2 to 6 players on a dozen screens.
 */
const SEAT_W = 92;
const SEAT_H = 86;
const EDGE = 4;
const ARC = { 1: [270], 2: [222, 318], 3: [198, 270, 342], 4: [192, 244, 296, 348], 5: [186, 228, 270, 312, 354] };

function layoutDurak() {
  const f = $app.querySelector('.dk-felt');
  if (!f) return;
  const W = f.clientWidth;
  const H = f.clientHeight;
  const seats = [...f.querySelectorAll('.dk-seat')];
  const mid = f.querySelector('.dk-mid');
  const cloth = f.querySelector('.dk-cloth');
  const apply = (u) => {
    f.style.setProperty('--u', u.toFixed(3));
    const sw = SEAT_W * u;
    const sh = SEAT_H * u;
    const rx = Math.max(0, W / 2 - EDGE - sw / 2);
    const top = EDGE + sh / 2;
    const ry = Math.max(0, Math.min(H * 0.34, H / 2 - top));
    const cy = top + ry;
    const angles = ARC[seats.length] || seats.map((_, k) => 180 + (k + 0.5) * (180 / seats.length));
    seats.forEach((el, k) => {
      const th = (angles[k] * Math.PI) / 180;
      el.style.left = `${(W / 2 + rx * Math.cos(th)).toFixed(1)}px`;
      el.style.top = `${(cy + ry * Math.sin(th)).toFixed(1)}px`;
    });
    // The middle: under the top seat, above the bottom edge.
    const upper = seats.length ? Math.min(...angles.map((a) => cy + ry * Math.sin((a * Math.PI) / 180))) + sh / 2 + 6 : EDGE;
    const midTop = seats.length === 0 ? EDGE : Math.min(upper, H * 0.42);
    mid.style.top = `${midTop.toFixed(1)}px`;
    mid.style.bottom = `${EDGE}px`;
    Object.assign(cloth.style, { left: `${(W / 2 - rx - sw / 4).toFixed(1)}px`, width: `${(2 * rx + sw / 2).toFixed(1)}px`, top: `${(top - sh / 4).toFixed(1)}px`, bottom: '2px' });
    return !crowded(f);
  };
  const MIN = 0.55;
  let hi = clamp(W / 380, MIN, 1.12);
  if (apply(hi)) return;
  let lo = MIN;
  if (!apply(lo)) return;
  for (let i = 0; i < 6; i++) {
    const m = (lo + hi) / 2;
    if (apply(m)) lo = m;
    else hi = m;
  }
  const step = Math.max(MIN, Math.floor(lo * 20) / 20);
  if (!apply(step)) apply(lo);
}

/** Your hand as a fan that always fits: cards overlap just as much as the width needs. */
function layoutHand() {
  const hand = $app.querySelector('.dk-hand');
  if (!hand || hand.classList.contains('none')) return;
  const rows = [...hand.querySelectorAll('.dk-row')];
  const first = hand.querySelector('.dk-card');
  if (!first) return;
  const cw = first.getBoundingClientRect().width;
  const avail = hand.clientWidth - 6;
  const perRow = Math.max(...rows.map((r) => r.children.length));
  const need = perRow * cw;
  // A little overlap even when there is room — a hand, not a row of tiles.
  const ov = perRow > 1 ? Math.max(cw * 0.14, (need - avail) / (perRow - 1)) : 0;
  hand.style.setProperty('--ov', `${Math.min(ov, cw * 0.82).toFixed(1)}px`);
}

/** Does any seat touch the middle, another seat, or the edge? Measured, not guessed. */
function crowded(f) {
  const hit = (a, b, gap) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > -gap && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > -gap;
  const box = (el) => el.getBoundingClientRect();
  const fr = box(f);
  const middle = [...f.querySelectorAll('.dk-stock > *, .dk-pair, .dk-line')].filter((el) => el.textContent.trim() || el.querySelector('img') || el.classList.contains('dk-pair')).map((el) => {
    if (!el.classList.contains('dk-line')) return box(el);
    const r = document.createRange();
    r.selectNodeContents(el);
    return r.getBoundingClientRect();
  });
  for (const m of middle) if (m.bottom > fr.bottom + 1 || m.left < fr.left - 1 || m.right > fr.right + 1) return true;
  const seats = [...f.querySelectorAll('.dk-seat')].map((el) => [...el.querySelectorAll('.pod, .info, .plate, .dk-backs img, .dk-count')].map(box));
  for (let i = 0; i < seats.length; i++) {
    for (const p of seats[i]) {
      if (p.left < fr.left + 1 || p.right > fr.right - 1 || p.top < fr.top || p.bottom > fr.bottom) return true;
      if (middle.some((m) => hit(p, m, 4))) return true;
      for (let j = i + 1; j < seats.length; j++) if (seats[j].some((q) => hit(p, q, 2))) return true;
    }
  }
  return false;
}

const relayout = () => {
  layoutHand();
  layoutDurak();
};
window.addEventListener('resize', relayout);
tg?.onEvent?.('viewportChanged', relayout);

/* ------------------------------------------------------------- results */

function renderResults() {
  const s = state;
  const rows = s.score.filter((r) => r.games > 0);
  const box = h('div.lobby',
    h('div', h('h1', '🏁 Итоги'), h('div.sub', `Дурак · партий сыграно: ${s.history}${s.draws ? `, ничьих: ${s.draws}` : ''}`)),
    h('div.box', rows.length
      ? rows.map((r, i) => h('div.res-row',
          h('span.n', i === 0 ? '🏆 ' : '', r.name, r.isHost ? ' 👑' : '', r.kicked ? ' · удалён' : r.left ? ' · вышел' : ''),
          h('span.s.num', `${r.games} ${r.games === 1 ? 'партия' : r.games < 5 ? 'партии' : 'партий'}`),
          h(`span.pl.num.${r.fool ? 'down' : 'up'}`, `дурак ${r.fool}`)))
      : h('div.hint', 'Ни одной партии не сыграно.')),
    h('div.hint', 'Итоги бот отправил и в группу.'),
  );
  $app.append(box, h('div.panel', h('button.btn.primary.wide.lg', { onclick: () => tg.close() }, 'Закрыть')));
}

/* --------------------------------------------------------------- sheets */

function openMenu() {
  haptic.soft();
  showSheet('menu', () => {
    const s = state;
    const me = s.me;
    const d = s.deal;
    const live = d?.phase === 'play';
    const items = [];
    const item = (text, sub, onclick, cls = '') => items.push(h(`button.menu-item${cls ? '.' + cls : ''}`, { onclick }, text, sub ? h('small', sub) : null));
    if (s.hub) item('← Все игры группы', 'игра останется, как есть', () => { closeSheet(); send({ t: 'hub' }, { lock: false }); });
    if (me.seated && !live) item('Встать из-за стола', 'со следующей партии вас не сдадут', () => { closeSheet(); send({ t: 'leave' }); });
    else if (!me.seated && !me.kicked) item('Сесть за стол', 'со следующей партии', () => { closeSheet(); send({ t: 'sit' }); });
    if (!me.notify && s.bot) item('🔔 Напоминать о ходе', 'нажмите Start у бота', () => tg.openTelegramLink(`https://t.me/${s.bot}?start=notify`));
    item('Правила', s.room.variantName, openRules);
    if (me.isHost) {
      items.push(h('div.section-label', 'Хост'));
      item('Настройки', 'вариант, таймер хода', openSettings);
      if (live) item('Прервать партию', 'не засчитается; например, кто-то уснул', () => confirmAbort(), 'danger');
      item('Передать права хоста', null, () => openPlayers('host'));
      item('Удалить игрока', live ? 'партия прервётся' : null, () => openPlayers('kick'));
      if (s.room.status !== 'lobby') item('Завершить игру', 'итоги — всем и в группу', () => confirmFinish(), 'danger');
    }
    return h('div', h('h3', 'Меню'), h('div.sub', `🃏 Дурак · ${s.room.variantName}`), h('div.menu-list', items));
  });
}

function openRules() {
  showSheet('rules', () => h('div',
    h('h3', 'Правила'),
    h('div.rules',
      h('p', '36 карт, по 6 каждому. Козырь — открытая карта под колодой. Первым ходит младший козырь, дальше — «под дурака».'),
      h('p', 'Отбиться — старшей картой той же масти или козырем. Подкидывают все, кроме отбивающегося, — карты тех достоинств, что на столе; в отбое не больше 6 карт и не больше, чем карт у отбивающегося.'),
      h('p', 'Всё побито и все сказали «пас» — бито, отбившийся ходит. Взял — пропускает ход. Добирают до 6: атаковавший, остальные по кругу, отбивавшийся последним.'),
      state.room.settings.variant === 'perevodnoy'
        ? h('p', 'Переводной: пока ни одна карта не побита, можно перевести атаку картой того же достоинства — если у следующего хватает карт.')
        : null,
      h('p', 'Колода кончилась — кто без карт, вышел. Последний с картами — дурак.')),
  ));
}

function openSettings() {
  const st = { ...state.room.settings };
  const live = state.deal?.phase === 'play';
  showSheet('settings', () => {
    const seg = (options, key, disabled) => h('div.seg', options.map(([v, text]) => h(`button${st[key] === v ? '.on' : ''}`, {
      disabled, onclick: () => { st[key] = v; refreshSheet(); },
    }, text)));
    return h('div',
      h('h3', 'Настройки'),
      h('div.section-label', 'Вариант'),
      live ? h('div.hint', 'Вариант меняется между партиями.') : seg([['podkidnoy', 'Подкидной'], ['perevodnoy', 'Переводной']], 'variant'),
      h('div.section-label', 'Таймер хода'),
      seg(TIMERS, 'turnSeconds'),
      h('div.hint', { style: { marginTop: '6px' } }, 'Не успел: отбивающийся берёт, подкидывающие пасуют; начать отбой — бот ходит младшей некозырной.'),
      h('button.btn.primary.wide.lg', { style: { marginTop: '16px', width: '100%' }, onclick: () => {
        send({ t: 'settings', turnSeconds: st.turnSeconds, ...(live ? {} : { variant: st.variant }) });
        closeSheet();
      } }, 'Сохранить'),
    );
  });
}

function confirmAbort() {
  showSheet('abort', () => h('div',
    h('h3', 'Прервать партию?'),
    h('div.sub', 'Она не засчитается. Карты — в сброс, потом можно сдать новую.'),
    h('div.grid2',
      h('button.btn', { onclick: () => closeSheet() }, 'Отмена'),
      h('button.btn.danger', { onclick: () => { closeSheet(); send({ t: 'abort' }); } }, 'Прервать')),
  ));
}

function confirmFinish() {
  showSheet('finish', () => h('div',
    h('h3', 'Завершить игру?'),
    h('div.sub', 'Незаконченная партия не засчитается. Итоги увидят все и группа.'),
    h('div.grid2',
      h('button.btn', { onclick: () => closeSheet() }, 'Отмена'),
      h('button.btn.danger', { onclick: () => { closeSheet(); send({ t: 'finish' }); } }, 'Завершить')),
  ));
}

function openPlayers(kind) {
  const titles = { host: 'Передать права хоста', kick: 'Удалить игрока' };
  showSheet(`players-${kind}`, () => {
    const list = state.players.filter((p) => !p.isMe && (p.seated || p.inDeal));
    return h('div',
      h('h3', titles[kind]),
      h('div.sub', kind === 'kick' ? 'Если идёт партия — она прервётся и не засчитается.' : 'Хост меняет настройки и завершает игру.'),
      h('div.menu-list', list.map((p) => h(`button.menu-item${kind === 'kick' ? '.danger' : ''}`, {
        onclick: () => { send({ t: kind, seat: p.seat }, { lock: false }); closeSheet(); },
      }, p.name, h('small', p.games ? `дурак ${p.fools} из ${p.games}` : 'ещё не играл')))),
    );
  });
}

