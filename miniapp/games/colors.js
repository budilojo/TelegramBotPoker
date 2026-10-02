/**
 * Стол «Радуги» внутри Telegram — одна игра хаба.
 *
 * Как и покерный, и дурацкий, страница — зрение, а не судья: сервер
 * присылает карты ЭТОГО игрока и ходы, законные для него прямо сейчас, и
 * перепроверяет каждый тап. Поднятые в руке карты — просто те, которые
 * сервер назвал играбельными.
 *
 * Чего на макете не видно, а оно и есть игра:
 *
 *   РУКА ВСЕГДА ОТСОРТИРОВАНА и пересчитывается только когда изменилась.
 *   Порядок приходит с сервера готовым (`me.cards` — по цвету, `me.dealt` —
 *   как пришли), поэтому чужой ход не может сдвинуть карту из-под пальца:
 *   одна и та же рука всегда ложится одинаково.
 *
 *   ПОДНЯТЫ РОВНО ТЕ, ЧТО МОЖНО ПОЛОЖИТЬ. Не твой ход — не поднята ни одна,
 *   и вся рука чуть приглушена: это главный признак «сейчас не ты», и его
 *   видно боковым зрением.
 *
 *   ПАЛЕЦ ЗАКРЫВАЕТ КАРТУ ЦЕЛИКОМ. Поэтому нажал и держишь — карта
 *   поднимается над пальцем и увеличивается; отпустил на ней — сыграл, увёл
 *   в сторону — отменил.
 */
import {
  tg, $app, h, clamp, haptic, animateOnce, offsetTo, ringSvg, showSheet, closeSheet,
  refreshSheet, avatar, toast, REDUCED,
} from '../ui.js';
import { net, bus, send } from '../net.js';

let state = null;
let prev = null;
/** Карта под пальцем: { card, i, el, rect, big } — пока палец не отпустили. */
let held = null;
/** Куда прокручен веер — чтобы перерисовка не сбрасывала прокрутку. */
let handScroll = 0;

const TIMERS = [[0, 'Выкл'], [30, '30 с'], [60, '60 с'], [90, '90 с']];
const ORDER_KEY = 'colors.handOrder';

const COLOR_RU = { R: 'красный', Y: 'жёлтый', G: 'зелёный', B: 'синий' };
const SIGN_RU = { S: 'стоп', V: 'разворот', P: '+2' };
/** Фигура цвета — второй признак цвета, не настройка и не украшение. */
const SHAPE = {
  R: '<circle cx="12" cy="12" r="9"/>',
  Y: '<path d="M12 2 22 20H2Z"/>',
  G: '<rect x="3" y="3" width="18" height="18" rx="3"/>',
  B: '<path d="M12 1 23 12 12 23 1 12Z"/>',
};

const isWild = (c) => c === 'WC' || c === 'WF';
const colorOf = (c) => (isWild(c) ? null : c[0]);
const signOf = (c) => (isWild(c) ? c : c.slice(1));
const isNum = (c) => !isWild(c) && /^[0-9]$/.test(signOf(c));
const label = (c) =>
  c === 'WC' ? 'смена цвета'
    : c === 'WF' ? 'смена цвета +4'
      : isNum(c) ? `${COLOR_RU[colorOf(c)]} ${signOf(c)}`
        : `${COLOR_RU[colorOf(c)]} «${SIGN_RU[signOf(c)]}»`;

const cardImg = (code, cls = '') =>
  h(`img.cl-img${cls ? '.' + cls : ''}`, { src: `/colors/${code}.svg`, alt: code, draggable: 'false' });
const backImg = (cls = '') => cardImg('back', cls);

/** Значок фигуры цвета — рядом с названием цвета везде, где цвет называется. */
const shapeIcon = (c, cls = '') =>
  h(`span.cl-shape${cls ? '.' + cls : ''}`, { html: `<svg viewBox="0 0 24 24">${SHAPE[c]}</svg>` });

const handOrder = () => {
  try {
    return localStorage.getItem(ORDER_KEY) === 'dealt' ? 'dealt' : 'color';
  } catch {
    return 'color'; // приватное окно, заблокированное хранилище — порядок по умолчанию
  }
};
const setHandOrder = (v) => {
  try {
    localStorage.setItem(ORDER_KEY, v);
  } catch {
    /* не сохранилось — не беда, работает и так */
  }
};

/* ------------------------------------------------------------------ state */

export function onState(s, p) {
  state = s;
  prev = p;
  if (held && !s.me.cards.includes(held.card)) dropHeld();

  const myMove = !!s.legal?.myTurn;
  const before = p ? !!p.legal?.myTurn : false;
  if (myMove && !before) haptic.turn();
  if (s.room.notice && s.room.notice !== p?.room?.notice) toast(s.room.notice, 3200);

  // Поймали — это чувствуется пальцем, а не читается.
  const caught = s.deal?.events?.some((e) => e.kind === 'caught' && e.targetSeat === s.me.seat);
  const caughtBefore = p?.deal?.events?.some((e) => e.kind === 'caught' && e.targetSeat === s.me.seat);
  if (caught && !caughtBefore) haptic.err();

  const fresh = s.deal?.result && !p?.deal?.result && p?.deal?.no === s.deal.no;
  if (fresh && s.me.inDeal) setTimeout(s.deal.result.loserSeat === s.me.seat ? haptic.err : haptic.win, 300);

  bus.render();
  refreshSheet();
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

function renderLobby() {
  const s = state;
  const me = s.me;
  const seated = s.players.filter((p) => p.seated);
  const slots = [];
  for (let i = 0; i < s.room.maxSeats; i++) {
    const p = seated[i];
    slots.push(p
      ? animateOnce(h(`div.lseat${p.isMe ? '.me' : ''}`, withMark(avatar(p.name, p.hue), p.isHost), h('div.nm', p.name)),
        `cllseat:${p.name}`, [{ transform: 'scale(0.4)', opacity: 0, offset: 0 }], { duration: 450, delay: i * 45 })
      : h('div.lseat.empty', h('div.av', '+'), h('div.nm', 'свободно')));
  }
  const st = s.room.settings;
  const lobby = h('div.lobby',
    backToHub(s),
    h('div', h('h1', '🌈 Радуга'), h('div.sub', `Цветные карты · Игроков ${seated.length}/${s.room.maxSeats}`)),
    h('div.box', h('div.seats-grid.eight', slots)),
    h('div.tags',
      h('span.tag', st.stacking ? '➕ С накоплением' : '➕ Без накопления'),
      h('span.tag', st.turnSeconds ? `⏱ ${st.turnSeconds} с на ход` : 'Без таймера'),
      h('span.tag', '108 карт · по 7')),
    h('div.cl-swatches', ['R', 'Y', 'G', 'B'].map((c) =>
      h(`span.cl-swatch.c${c}`, shapeIcon(c), COLOR_RU[c]))),
    h('div.hint', 'Кладите карту того же цвета, того же числа или того же знака. Сбросил все — вышел; '
      + 'кто остался с картами последним — последний. Осталась одна карта — жмите «Радуга!», иначе поймают.'),
    notifyHint(),
    me.isHost ? h('button.menu-item', { onclick: openSettings }, 'Настройки', h('small', 'накопление, таймер хода')) : null,
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
  toastBelow(null); // в лобби соперников наверху нет — тосту можно как всем
}

/* ------------------------------------------------------------------ table */

function renderTable() {
  const s = state;
  const d = s.deal;
  const top = h('div.top',
    animateOnce(h('div.stage', d ? `ПАРТИЯ ${d.no}` : 'ПАРТИЯ'), `clstage:${d?.no}`,
      [{ transform: 'scale(0.55)', opacity: 0, offset: 0 }], { duration: 420 }),
    h('div.top-meta', d ? [h('span', 'цвет '), colorWord(d.color)] : null),
    h('button.icon-btn', { onclick: openMenu, 'aria-label': 'Меню' }, '⋯'),
  );

  // Остальные — по кругу от соседа слева, как их видно за столом.
  const ring = s.players.filter((p) => p.inDeal || (!d || d.phase === 'over' ? p.seated : false));
  const meIdx = ring.findIndex((p) => p.isMe);
  const others = meIdx >= 0 ? [...ring.slice(meIdx + 1), ...ring.slice(0, meIdx)] : ring;

  const felt = h('div.cl-felt', { 'data-n': others.length },
    h('div.cl-seats', others.map((p) => seatEl(p, s))),
    middleEl(s),
    eventsEl(s),
  );
  $app.append(top, felt, heroEl(s), panelEl(s));
  // Общий тост прибит к верху экрана — а наверху здесь сидят соперники.
  // Опускаем его под их ряд, каким бы тот ни был: вшестером и восьмером он
  // переносится на две строки, и постоянным числом тут не обойтись.
  toastBelow(felt.querySelector('.cl-seats'));
  restoreHandScroll();
}

/** Куда опустить общий тост, чтобы он не накрыл ряд соперников. */
function toastBelow(seats) {
  const px = seats ? Math.round(seats.getBoundingClientRect().bottom) + 10 : 0;
  if (px > 0) document.body.style.setProperty('--cl-toast-top', `${px}px`);
  else document.body.style.removeProperty('--cl-toast-top');
}

const nameAt = (s, seat) => s.players.find((p) => p.seat === seat)?.name ?? '—';

/** Цвет всегда со своей фигурой: называть цвет одним цветом нельзя. */
function colorWord(c) {
  if (!c) return h('b', '—');
  return h(`b.cl-colorword.c${c}`, shapeIcon(c), COLOR_RU[c]);
}

function seatEl(p, s) {
  const d = s.deal;
  const av = avatar(p.name, p.hue);
  if (p.isHost) av.append(h('span.host-mark', '👑'));
  // Тонкое кольцо вместо цифр: цифры нервируют, кольцо считывается боковым зрением.
  if (p.turn && d?.deadline && s.room.settings.turnSeconds) av.append(ringSvg(d.deadline, s.room.settings.turnSeconds));

  const cls = ['cl-seat', p.turn && 'turn', p.alone && 'alone', p.quiet && 'quiet',
    (p.role === 'out' || p.role === 'quit' || !p.inDeal) && 'away', p.role === 'last' && 'last'].filter(Boolean).join('.');
  const sub = p.role === 'quit' ? 'вышел'
    : p.place ? `${p.place}-е место`
      : p.inDeal ? '' : 'со след. партии';
  return h(`div.${cls}`, { 'data-seat': p.seat },
    h('div.pod', av, p.inDeal ? h('span.cl-count.num', String(p.count)) : null),
    h('div.cl-plate', h('div.nm', p.name), sub ? h('div.sub2', sub) : null),
    p.alone ? h(`div.cl-one${p.called ? '.ok' : ''}`, p.called ? '🌈' : '1') : null,
  );
}

/* ------------------------------------------------------------- the middle */

function middleEl(s) {
  const d = s.deal;
  if (!d) return h('div.cl-mid');
  const L = s.legal;
  // «Нечего положить» — колода пульсирует: бей по ней. Ноль раздумий.
  const mustDraw = !!L?.myTurn && !!L?.draw && !L?.play.length;
  const deck = h(`div.cl-deck${mustDraw ? '.pulse' : ''}${d.deck ? '' : '.empty'}`,
    { onclick: mustDraw ? onDrawTap : null },
    d.deck ? h('div.cl-stack', backImg('b2'), backImg('b1'), backImg('b0')) : h('div.cl-deck-empty', 'пусто'),
    h('span.cl-deck-n.num', String(d.deck)));

  const pileTop = animateOnce(cardImg(d.top, 'cl-top'), `cltop:${d.no}:${d.events.at(-1)?.n ?? 0}:${d.top}`, (node) => {
    const from = cardFrom(s);
    const { dx, dy } = offsetTo(node, from);
    return [{ transform: `translate(${dx}px, ${dy}px) scale(0.55) rotate(-14deg)`, opacity: 0.25, offset: 0 }];
  }, { duration: 220 });

  const pile = h('div.cl-pile',
    pileTop,
    // Названный цвет виден на самой куче: после «смены цвета» верхняя карта
    // уже ничего про цвет не говорит.
    isWild(d.top) ? h(`div.cl-chosen.c${d.color}`, shapeIcon(d.color)) : null,
    // Накопление — крупно поверх кучи: сколько прилетит следующему.
    d.pending ? animateOnce(h('div.cl-pending.num', `+${d.pending}`), `clpend:${d.no}:${d.pending}`,
      [{ transform: 'scale(0.4)', opacity: 0, offset: 0 }], { duration: 320 }) : null,
    d.discard ? h('span.cl-discard-n.num', `сброс ${d.discard}`) : null);

  return h('div.cl-mid', dirRing(s), h('div.cl-center', deck, pile));
}

/**
 * Круг направления. «Разворот» объясняется не подписью, а тем, что круг
 * коротко прокручивается в обратную сторону: одна анимация вместо абзаца.
 */
function dirRing(s) {
  const d = s.deal;
  const flipped = prev?.deal?.no === d.no && prev.deal.dir !== d.dir;
  const ring = h('div.cl-dir', { 'data-dir': d.dir > 0 ? 'cw' : 'ccw', html:
    `<svg viewBox="0 0 220 220" aria-hidden="true">
       <path d="M110 18a92 92 0 0 1 92 92" />
       <path d="M110 202a92 92 0 0 1-92-92" />
       <path d="M188 96l14 16 14-16" />
       <path d="M32 124L18 108 4 124" />
     </svg>` });
  if (!flipped) return ring;
  return animateOnce(ring, `cldir:${d.no}:${d.events.at(-1)?.n ?? 0}`,
    [{ transform: `rotate(${d.dir > 0 ? -150 : 150}deg)`, offset: 0 }, { transform: 'rotate(0deg)', offset: 1 }],
    { duration: 400 });
}

/** Откуда прилетела верхняя карта: от своего веера или от аватара соседа. */
function cardFrom(s) {
  const e = [...(s.deal.events || [])].reverse().find((x) => x.kind === 'play' || x.kind === 'out');
  if (!e || e.seat < 0) return null;
  if (e.seat === s.me.seat) return document.querySelector('.cl-hand');
  return document.querySelector(`.cl-seat[data-seat="${e.seat}"] .pod`);
}

/**
 * Лента над кучей: три последних события, затухают. Без неё быстрый ход
 * соперника остаётся незамеченным — при четырёх игроках непонятно, кто ходил.
 */
function eventsEl(s) {
  const d = s.deal;
  if (!d || !d.events.length) return null;
  const rows = d.events.slice(-3).map((e, i, all) =>
    h(`div.cl-ev.a${all.length - 1 - i}`, { key: e.n }, eventText(e, s)));
  return h('div.cl-events', rows);
}

function eventText(e, s) {
  const who = e.seat >= 0 ? nameAt(s, e.seat) : '—';
  switch (e.kind) {
    case 'play': return `${who}: ${label(e.card)}`;
    case 'out': return `${who} вышел — ${label(e.card)}`;
    case 'draw': return `${who} взял карту`;
    case 'empty': return `${who}: брать нечего`;
    case 'take': return `${who} берёт ${e.count}`;
    case 'forced': return `${who} берёт ${e.count} и пропускает`;
    case 'skip': return `${who} пропускает ход`;
    case 'rainbow': return `🌈 ${who}: Радуга!`;
    case 'caught': return `🫵 ${who} поймал ${nameAt(s, e.targetSeat)} — две карты`;
    case 'quit': return `${who} вышел из партии`;
    default: return '';
  }
}

/* --------------------------------------------------------------- the hand */

function heroEl(s) {
  const me = s.me;
  const d = s.deal;
  const L = s.legal;
  if (!me.inDeal) {
    return h('div.hero.cl-hero',
      h('div.cl-role.watch', me.kicked ? 'ХОСТ УДАЛИЛ ВАС' : 'ВЫ СМОТРИТЕ'),
      h('div.cl-hand.none', me.seated ? 'Вас сдадут со следующей партии' : 'Сядьте — сдадут со следующей партии'));
  }
  if (d?.phase === 'over') {
    const rows = s.score.filter((r) => r.games > 0);
    return h('div.hero.cl-hero',
      h(`div.cl-role${d.result?.loserSeat === me.seat ? '.last' : '.won'}`, roleText(s)),
      h('div.cl-score', rows.map((r) => h(`div.cl-sc${r.name === me.name ? '.me' : ''}`,
        h('span', r.name), h('b.num', String(r.wins)))),
        h('div.cl-sc-cap', `вышел первым, раз · партий ${s.history}`)));
  }

  const cards = handOrder() === 'dealt' ? me.dealt : me.cards;
  const playable = new Set(L?.play || []);
  const myMove = !!L?.myTurn;
  const fits = cards.filter((c) => playable.has(c)).length;

  const cardEl = (c, i) => {
    const up = playable.has(c);
    const img = cardImg(c, up ? 'ok' : myMove || !up ? 'no' : '');
    const btn = h(`button.cl-card${up ? '.up' : ''}`, {
      'data-i': i,
      'data-card': c,
      'aria-label': label(c) + (up ? ', можно положить' : ''),
      onpointerdown: up ? (ev) => onHold(ev, c, i) : null,
      // Нажатие на приглушённую карту не делает ничего — и не ругается.
      onclick: up ? null : (ev) => ev.preventDefault(),
    }, img);
    return dealIn(btn, c, i, s);
  };

  const hand = h('div.cl-hand', { 'data-n': cards.length, onscroll: (e) => { handScroll = e.target.scrollLeft; } },
    h('div.cl-fan', { style: { '--n': cards.length } }, cards.map(cardEl)));

  return h(`div.hero.cl-hero${myMove ? '.turn' : ''}`,
    h('div.cl-role-row',
      h(`div.cl-role${myMove ? '.go' : ''}`, roleText(s)),
      // Больше десяти карт в веер не помещаются: счётчик говорит, сколько
      // подходит, и прокручивает к первой подходящей.
      cards.length > 10 && fits
        ? h('button.cl-fits', { onclick: () => scrollToFit(cards, playable) }, `${fits} ${plural(fits, 'подходит', 'подходят', 'подходят')}`)
        : null),
    hand);
}

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

function roleText(s) {
  const d = s.deal;
  const L = s.legal;
  const me = s.me;
  if (d.phase === 'over') {
    if (d.result?.aborted) return 'ПАРТИЯ ПРЕРВАНА';
    if (d.result?.loserSeat === me.seat) return 'ВЫ ПОСЛЕДНИЙ';
    const place = d.result?.places?.indexOf(me.seat) ?? -1;
    return place === 0 ? 'ВЫ ВЫШЛИ ПЕРВЫМ 🎉' : place > 0 ? `ВЫ ${place + 1}-Й` : 'ПАРТИЯ ОКОНЧЕНА';
  }
  if (me.role === 'out') return 'ВЫ ВЫШЛИ — ждём остальных';
  if (!L?.myTurn) return `Ходит ${nameAt(s, d.turnSeat)}`;
  if (d.pending) return `НА ВАС +${d.pending} — кройте или берите`;
  if (d.drawn) return 'ВЗЯЛИ КАРТУ — сыграйте её или передайте ход';
  if (!L.play.length) return 'НЕЧЕГО ПОЛОЖИТЬ — берите из колоды';
  return 'ВАШ ХОД';
}

/** Карта, приехавшая в руку, прилетает на СВОЁ место — видно, куда она встала. */
function dealIn(el, c, i, s) {
  const d = s.deal;
  const had = prev?.deal?.no === d?.no ? [...prev.me.cards] : null;
  if (had) {
    const at = had.indexOf(c);
    if (at >= 0) {
      had.splice(at, 1); // две одинаковых карты — считаем экземплярами
      return el;
    }
  }
  return animateOnce(el, `clin:${d?.no}:${i}:${c}:${s.me.cards.length}`, (node) => {
    const { dx, dy } = offsetTo(node, document.querySelector('.cl-deck'));
    return [{ transform: `translate(${dx}px, ${dy}px) scale(0.6)`, opacity: 0, offset: 0 }, { opacity: 1, offset: 0.4 }];
  }, { duration: 250, delay: had ? 0 : Math.min(i, 7) * 55 });
}

function scrollToFit(cards, playable) {
  const i = cards.findIndex((c) => playable.has(c));
  const el = document.querySelector(`.cl-card[data-i="${i}"]`);
  el?.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', inline: 'center', block: 'nearest' });
  haptic.soft();
}

function restoreHandScroll() {
  const el = document.querySelector('.cl-hand');
  if (el && handScroll) el.scrollLeft = handScroll;
}

/* ---------------------------------------------------------- press and hold */

/**
 * Палец закрывает карту целиком — поэтому карта поднимается НАД пальцем и
 * увеличивается, пока его держат. Отпустил на ней — сыграл; увёл в сторону и
 * отпустил — отменил. Короткий тап проходит тем же путём.
 */
function onHold(ev, card, i) {
  const el = ev.currentTarget;
  if (held) dropHeld();
  // Захват указателя — удобство, а не условие: палец можно увести за край
  // карты и вернуть. Если браузер его не даёт (а он не даёт, например, для
  // программно созданного события), ход всё равно должен доводиться до конца.
  try {
    el.setPointerCapture?.(ev.pointerId);
  } catch {
    /* указателя уже нет — работаем без захвата */
  }
  held = { card, i, el, id: ev.pointerId, rect: el.getBoundingClientRect() };
  el.classList.add('held');
  haptic.soft();
  showHint(card);
  const up = (e) => {
    try {
      el.releasePointerCapture?.(e.pointerId);
    } catch {
      /* захвата и не было */
    }
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', cancel);
    const r = held?.rect;
    const inside = r && e.clientX > r.left - 26 && e.clientX < r.right + 26 && e.clientY > r.top - 90 && e.clientY < r.bottom + 26;
    dropHeld();
    if (inside) playCard(card);
  };
  const cancel = () => dropHeld();
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
}

function dropHeld() {
  held?.el?.classList.remove('held');
  document.querySelector('.cl-hint')?.remove();
  held = null;
}

/** Правило объясняется действием: «Пётр возьмёт 2» прямо под поднятой картой. */
function showHint(card) {
  const s = state;
  const d = s.deal;
  if (!d) return;
  const sign = signOf(card);
  let text = null;
  if (sign === 'P' || card === 'WF') {
    const add = card === 'WF' ? 4 : 2;
    const total = d.pending + add;
    const victim = nextName(s);
    text = `${victim} возьмёт ${total}`;
  } else if (sign === 'S') {
    text = `${nextName(s)} пропустит ход`;
  } else if (sign === 'V') {
    text = d.alive <= 2 ? `${nextName(s)} пропустит ход` : 'ход пойдёт в обратную сторону';
  } else if (card === 'WC') {
    text = 'выберете цвет';
  }
  if (!text) return;
  const hint = h('div.cl-hint', text);
  document.querySelector('.cl-hero')?.append(hint);
}

/** Имя того, кто ходит следующим в текущую сторону. */
function nextName(s) {
  const d = s.deal;
  const ring = s.players.filter((p) => p.inDeal && p.role !== 'out' && p.role !== 'quit');
  if (ring.length < 2) return 'следующий';
  const at = ring.findIndex((p) => p.seat === d.turnSeat);
  if (at < 0) return 'следующий';
  const n = ring.length;
  return ring[(((at + d.dir) % n) + n) % n].name;
}

/* --------------------------------------------------------------- the moves */

function playCard(card) {
  const s = state;
  if (!s.legal?.play?.includes(card)) return;
  if (isWild(card)) return openColorSheet(card);
  haptic.tap();
  send({ t: 'play', card, seq: s.seq });
}

/** Шторка выбора цвета: четыре крупные плашки, на каждой — своя фигура. */
function openColorSheet(card) {
  showSheet('color', () => {
    const s = state;
    if (!s.legal?.play?.includes(card)) return null;
    return h('div.sheet-body.cl-sheet',
      h('h3', card === 'WF' ? 'Смена цвета +4' : 'Смена цвета'),
      h('div.cl-pick', ['R', 'Y', 'G', 'B'].map((c) =>
        h(`button.cl-pick-btn.c${c}`, {
          onclick: () => {
            haptic.tap();
            closeSheet();
            send({ t: 'play', card, color: c, seq: state.seq });
          },
        }, shapeIcon(c, 'big'), h('span', COLOR_RU[c])))),
      h('button.btn.cl-cancel', { onclick: () => closeSheet(true) }, 'Отмена'));
  });
}

function onDrawTap() {
  const s = state;
  if (!s.legal?.draw) return;
  haptic.tap();
  send({ t: 'draw', seq: s.seq });
}

/* --------------------------------------------------------------- the panel */

function panelEl(s) {
  const d = s.deal;
  const L = s.legal;
  const p = h('div.panel.cl-panel');
  if (net.busy) p.classList.add('busy');

  if (d?.phase === 'over') {
    if (s.canNext) p.append(h('button.btn.primary.lg', { onclick: () => { haptic.tap(); send({ t: 'next' }); } }, '🌈 Ещё партию'));
    if (s.me.isHost) p.append(h('button.btn', { onclick: confirmFinish }, 'Завершить игру'));
    if (!s.canNext && !s.me.isHost) p.append(h('div.hint', 'Ждём, пока сдадут следующую.'));
    return p;
  }

  // «Поймал!» — первым: окно пять секунд, и оно важнее всего остального.
  if (L?.catch) {
    p.append(animateOnce(h('button.btn.danger.lg.cl-catch', {
      'data-count': L.catch.until,
      onclick: () => { haptic.tap(); send({ t: 'catch', seq: s.seq }); },
    }, `🫵 Поймал! ${nameAt(s, L.catch.seat)} молчит`), `clcatch:${L.catch.until}`,
    [{ transform: 'scale(0.6)', opacity: 0, offset: 0 }], { duration: 260 }));
  }
  // «Радуга!» — там же, где палец только что нажимал карту, а не в центре экрана.
  if (L?.rainbow) {
    p.append(animateOnce(h('button.btn.rainbow.lg', {
      onclick: () => { haptic.tap(); send({ t: 'rainbow', seq: s.seq }); },
    }, '🌈 Радуга!'), `clrainbow:${d.no}:${s.me.seat}`,
    [{ transform: 'scale(0.6)', opacity: 0, offset: 0 }], { duration: 260 }));
  }
  if (L?.myTurn && L?.draw) {
    p.append(h('button.btn.primary.lg', { onclick: onDrawTap },
      d.pending ? `Взять ${d.pending}` : 'Взять карту'));
  }
  if (L?.pass) p.append(h('button.btn', { onclick: () => { haptic.tap(); send({ t: 'pass', seq: s.seq }); } }, 'Передать ход'));
  // Чей ход — уже сказано заголовком панели. Повторять это второй строкой
  // незачем: на чужом ходу панель просто схлопывается, и руке достаётся
  // больше места.
  if (!p.childElementCount && L?.myTurn) p.append(h('div.cl-wait', 'Нажмите карту в руке'));
  return p;
}

/* -------------------------------------------------------------- the results */

function renderResults() {
  const s = state;
  const rows = s.score.filter((r) => r.games > 0);
  const lines = s.highlights || {};
  $app.append(
    h('div.lobby',
      backToHub(s),
      h('div', h('h1', '🏁 Итоги · Радуга'), h('div.sub', `Партий сыграно: ${s.history}`)),
      h('div.box', rows.length
        ? rows.map((r, i) => h(`div.cl-res${r.name === s.me.name ? '.me' : ''}`,
          h('span.pl.num', String(i + 1)),
          h('div.who', h('div.nm', r.name), lineFor(s, r) ? h('div.sub2', lineFor(s, r)) : null),
          h('b.num', `${r.wins} / ${r.last}`)))
        : h('div.hint', 'Ни одной партии не сыграно.')),
      h('div.hint', 'Слева — место, справа «вышел первым / остался последним».'),
    ),
    h('div.panel', h('button.btn.primary.lg', { onclick: () => send({ t: 'hub' }, { lock: false }) }, 'Все игры группы')),
  );
  void lines;
}

/** Живая строка человека — её прислал сервер, по месту за столом. */
function lineFor(s, row) {
  const p = s.players.find((x) => x.name === row.name);
  return p ? s.highlights?.[String(p.seat)] || '' : '';
}

/* --------------------------------------------------------------- the sheets */

function openMenu() {
  showSheet('menu', () => {
    const s = state;
    const me = s.me;
    return h('div.sheet-body',
      h('h3', '🌈 Радуга'),
      h('button.menu-item', { onclick: openRules }, 'Правила', h('small', 'коротко, по делу')),
      h('button.menu-item', { onclick: openOrder }, 'Порядок карт в руке',
        h('small', handOrder() === 'dealt' ? 'как пришли' : 'по цвету')),
      me.isHost ? h('button.menu-item', { onclick: openSettings }, 'Настройки', h('small', 'накопление, таймер')) : null,
      me.isHost && s.deal?.phase === 'play'
        ? h('button.menu-item.danger', { onclick: confirmAbort }, 'Прервать партию', h('small', 'она не засчитается')) : null,
      me.isHost ? h('button.menu-item.danger', { onclick: confirmFinish }, 'Завершить игру', h('small', 'итоги в группу')) : null,
      h('button.btn', { onclick: () => closeSheet(true) }, 'Закрыть'));
  });
}

/**
 * Переключатель порядка. По умолчанию «по цвету»: фиксированный порядок
 * важнее «красивее» — рука выглядит одинаково от партии к партии, и палец
 * начинает попадать по памяти.
 */
function openOrder() {
  showSheet('order', () => h('div.sheet-body',
    h('h3', 'Порядок карт в руке'),
    h('div.seg',
      [['color', 'По цвету'], ['dealt', 'Как пришли']].map(([v, t]) =>
        h(`button.seg-btn${handOrder() === v ? '.on' : ''}`, {
          onclick: () => { setHandOrder(v); haptic.soft(); bus.render(); refreshSheet(); },
        }, t))),
    h('div.hint', 'По цвету: красный, жёлтый, зелёный, синий — всегда в этом порядке, '
      + 'внутри цвета по возрастанию, особые после цифр, смена цвета в конце. Запоминается на этом телефоне.'),
    h('button.btn', { onclick: () => closeSheet(true) }, 'Готово')));
}

function openRules() {
  showSheet('rules', () => h('div.sheet-body',
    h('h3', 'Правила'),
    h('ul.rules',
      h('li', 'Кладите карту того же цвета, того же числа или того же знака. «Смена цвета» ложится всегда.'),
      h('li', '«+2» — следующий берёт две и пропускает. «Стоп» — пропускает. «Разворот» — ход идёт в обратную сторону (вдвоём это «стоп»).'),
      h('li', 'Нечего положить — возьмите одну из колоды. Подошла — можно сыграть сразу.'),
      h('li', 'Осталась одна карта — жмите «Радуга!». Промолчали пять секунд — любой может поймать, и вы возьмёте две.'),
      h('li', 'Сбросил все — вышел. Кто остался с картами последним, тот и последний.')),
    h('button.btn', { onclick: () => closeSheet(true) }, 'Понятно')));
}

function openSettings() {
  showSheet('settings', () => {
    const s = state;
    if (!s.me.isHost) return null;
    const st = s.room.settings;
    const playing = s.deal?.phase === 'play';
    return h('div.sheet-body',
      h('h3', 'Настройки стола'),
      h('div.field',
        h('label', 'Накопление «+2»'),
        h('div.seg', [[true, 'Вкл'], [false, 'Выкл']].map(([v, t]) =>
          h(`button.seg-btn${st.stacking === v ? '.on' : ''}`, {
            disabled: playing,
            onclick: () => send({ t: 'settings', stacking: v }),
          }, t))),
        h('div.hint', playing ? 'Менять можно между партиями.' : 'Включено: на «+2» можно положить «+2» или «+4», и берёт следующий сумму.')),
      h('div.field',
        h('label', 'Таймер хода'),
        h('div.seg', TIMERS.map(([v, t]) =>
          h(`button.seg-btn${(st.turnSeconds || 0) === v ? '.on' : ''}`, {
            onclick: () => send({ t: 'settings', turnSeconds: v }),
          }, t))),
        h('div.hint', 'Не успел — бот берёт за человека одну карту и передаёт ход.')),
      h('button.btn', { onclick: () => closeSheet(true) }, 'Готово'));
  });
}

function confirmAbort() {
  showSheet('abort', () => h('div.sheet-body',
    h('h3', 'Прервать партию?'),
    h('div.hint', 'Партия не засчитается никому. Карты уйдут в сброс.'),
    h('button.btn.danger.lg', { onclick: () => { closeSheet(); send({ t: 'abort' }); } }, 'Прервать'),
    h('button.btn', { onclick: () => closeSheet(true) }, 'Отмена')));
}

function confirmFinish() {
  showSheet('finish', () => h('div.sheet-body',
    h('h3', 'Завершить игру?'),
    h('div.hint', 'Итоги уйдут в группу. Открытую партию это снимет — она не засчитается.'),
    h('button.btn.danger.lg', { onclick: () => { closeSheet(); send({ t: 'finish' }); } }, 'Завершить'),
    h('button.btn', { onclick: () => closeSheet(true) }, 'Отмена')));
}

export { openSettings, openMenu };
