/**
 * Шахматы внутри Telegram — первая дуэль хаба: двое за одной доской.
 *
 * Как и за остальными столами, страница — зрение, а не судья. Сервер присылает
 * позицию, часы и ходы, законные для ЭТОГО человека прямо сейчас (`legal`):
 * тому, чей не ход, и зрителю не приходит ни одного. Страница подсвечивает
 * именно эти клетки и шлёт ход по подписанному каналу; сервер проверяет его
 * заново, и если страница ошиблась (запоздалый тап, чужая очередь), честно
 * возвращает настоящую позицию.
 *
 * Синхронизация. Сервер шлёт новое состояние по WebSocket после каждого хода
 * любого из двоих — и тому, кто сходил, и сопернику, и зрителям. Часы едут
 * сроком (`clock.deadline`, по часам сервера): страница лишь отсчитывает его
 * вниз через `tickClocks`, а остановить, продлить и сбросить может только
 * новое состояние. Ход, пока ждёт ответа сервера, повторно не шлётся.
 *
 * Управление: тап по своей фигуре — выбрать, тап по подсвеченной клетке —
 * сходить. Пешка у края — шторка «в кого превратить».
 */
import {
  tg, $app, h, haptic, toast, showSheet, closeSheet, refreshSheet, avatar, animateOnce, REDUCED, EASE,
} from '../ui.js';
import { net, bus, send, serverNow } from '../net.js';

/** Идентификатор запроса: повтор того же тапа сервер узнаёт и не плодит лобби. */
const newReqId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

let state = null;
let prev = null;
/** Выбранная клетка со своей фигурой, или null. */
let sel = null;
/** Фигура в руке: { from, id, x0, y0, moved, pc, cell, rect, hover, board } — пока палец не отпущен. */
let drag = null;
/** Свой ход, уже положенный на доску рукой: когда сервер его подтвердит, второй раз не двигаем. */
let ownMove = null;
/** На каком состоянии ход уже показан анимацией — перерисовка того же состояния не повторяет её. */
let animatedSeq = null;
/** Когда закончилось перетаскивание: клик, который за ним следует, — не тап. */
let droppedAt = null;
/**
 * Просмотр: сколько полуходов от начала показано на доске, или null — идёт
 * сама партия. Только показ: ходить по прошлой позиции нельзя, и страница ей
 * не верит — законные ходы сервер присылает лишь для настоящей.
 */
let viewPly = null;

const FILES = 'abcdefgh';
const PIECE_RU = { p: 'пешка', n: 'конь', b: 'слон', r: 'ладья', q: 'ферзь', k: 'король' };
const BASES = [[0, 'Нет'], [60, '1'], [180, '3'], [300, '5'], [600, '10'], [900, '15'], [1800, '30']];
const INCS = [[0, '0'], [2, '+2 с'], [3, '+3 с'], [5, '+5 с'], [10, '+10 с']];
const SIDES = [['random', 'Случайно'], ['white', 'Белые'], ['black', 'Чёрные']];
const COLOR_RU = { w: 'белые', b: 'чёрные' };

const img = (code, cls = '') => h(`img.ch-pc${cls ? '.' + cls : ''}`, { src: `/chess/${code}.svg`, alt: '', draggable: 'false' });
/** 'N' → 'wN', 'n' → 'bN': файл фигуры. */
const code = (p) => (p === p.toLowerCase() ? 'b' : 'w') + p.toUpperCase();
const isMineColor = (p, color) => !!p && (p === p.toLowerCase() ? 'b' : 'w') === color;
const sqOf = (file, rank) => FILES[file] + (rank + 1);

const clock = (ms) => {
  const sec = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

/* ---------------------------------------------------------------- просмотр */

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
const idxOf = (name) => FILES.indexOf(name[0]) + (Number(name[1]) - 1) * 8;

function startBoard() {
  const b = Array(64).fill('');
  START.split('/').forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (/[1-8]/.test(ch)) f += Number(ch);
      else b[(7 - i) * 8 + f++] = ch;
    }
  });
  return b;
}

/**
 * Позиция после `n` полуходов, собранная из записи (клетки откуда–куда).
 * Это только показ, не правила: рокировку узнаём по ходу короля на две
 * клетки, взятие на проходе — по пешке, ушедшей по диагонали на пустую.
 */
function replay(log, n) {
  const b = startBoard();
  for (let i = 0; i < n; i++) {
    const { from, to, promo } = log[i];
    const f = idxOf(from);
    const t = idxOf(to);
    const p = b[f];
    const white = p === p.toUpperCase();
    if (p.toUpperCase() === 'K' && Math.abs(t - f) === 2) {
      const rookFrom = t > f ? t + 1 : t - 2;
      const rookTo = t > f ? t - 1 : t + 1;
      b[rookTo] = b[rookFrom];
      b[rookFrom] = '';
    }
    if (p.toUpperCase() === 'P' && (f & 7) !== (t & 7) && !b[t]) b[t + (white ? -8 : 8)] = '';
    b[t] = promo ? (white ? promo.toUpperCase() : promo) : p;
    b[f] = '';
  }
  return b;
}

/** Что показывать на доске: настоящую позицию или прошлую. */
function shown() {
  const m = state.match;
  if (viewPly === null) return { board: m.board, last: m.last, check: m.check, reviewing: false, ply: m.plies };
  const mv = viewPly ? m.log[viewPly - 1] : null;
  return { board: replay(m.log, viewPly), last: mv, check: null, reviewing: true, ply: viewPly };
}

function goto(n) {
  const total = state.match.plies;
  viewPly = n >= total ? null : Math.max(0, n);
  sel = null;
  bus.render();
}

/* ------------------------------------------------------------------ state */

/** Ждёт ли партия меня? */
const myMove = (s) => !!s?.legal?.myTurn;

export function onState(s, p) {
  state = s;
  prev = p;
  drag = null; // пришла новая позиция: то, что было в руке, уже не про неё
  // Другая партия — смотреть снова текущее; откат укоротил запись — не стоять на несуществующем ходе.
  if (!p?.match || p.match.no !== s.match?.no || (viewPly !== null && viewPly >= (s.match?.plies ?? 0))) viewPly = null;
  // Выбор живёт ровно до смены позиции или очереди: чужой ход его снимает.
  if (sel && (!myMove(s) || s.match?.plies !== p?.match?.plies || s.match?.no !== p?.match?.no)) sel = null;

  if (myMove(s) && !(p && myMove(p))) haptic.turn();
  // Итог и предложение ничьей уже написаны на самом экране — второй раз тостом не нужно,
  // он к тому же закрывает плашку соперника.
  const said = !!s.match?.over || s.canAnswerDraw || s.match?.drawOffer?.mine || s.canAnswerTakeback || s.match?.takeback?.mine;
  if (s.room.notice && s.room.notice !== p?.room?.notice && !said) toast(s.room.notice, 3200);
  // Партия закончилась на глазах: победа и поражение — пальцем, а не словом.
  const over = s.match?.over;
  if (over && !(p?.match?.over && p.match.no === s.match.no) && s.me.color) {
    setTimeout(over.winner == null ? haptic.soft : over.winner === s.me.color ? haptic.win : haptic.err, 300);
  }
  bus.render();
  refreshSheet();
  // Соперник просит вернуть ход — окно поверх доски, а не только строка под ней:
  // на ответ ждут двое, и промолчать «случайно» не должно получаться.
  if (s.canAnswerTakeback && !p?.canAnswerTakeback) {
    haptic.turn();
    openTakebackSheet();
  }
}

export function render() {
  const s = state;
  if (s.room.status === 'lobby') return renderLobby();
  if (s.room.status === 'finished') return renderResults();
  renderTable();
}

/* ------------------------------------------------------------------ lobby */

const backToHub = (s) => (s.hub
  ? h('button.back-link', { onclick: () => send({ t: 'hub' }, { lock: false }) }, s.hubLabel || '← Все игры группы')
  : null);

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
  const slots = [0, 1].map((i) => {
    const p = seated[i];
    return p
      ? animateOnce(h(`div.lseat${p.isMe ? '.me' : ''}`, withMark(avatar(p.name, p.hue), p.isHost), h('div.nm', p.name)),
        `chlseat:${p.name}`, [{ transform: 'scale(0.4)', opacity: 0, offset: 0 }], { duration: 450, delay: i * 45 })
      : h('div.lseat.empty', h('div.av', '+'), h('div.nm', 'свободно'));
  });
  const st = s.room.settings;
  const lobby = h('div.lobby',
    backToHub(s),
    h('div', h('h1', '♟ Шахматы'), h('div.sub', `${s.room.control} · Игроков ${seated.length}/2`)),
    h('div.box', h('div.seats-grid.duo', slots)),
    h('div.tags',
      h('span.tag', st.base ? `⏱ ${s.room.control}` : 'Без часов'),
      h('span.tag', `Цвет хоста: ${s.room.sideName}`)),
    h('div.hint', 'Партия на двоих. Остальные из группы смогут её смотреть.'),
    notifyHint(),
    me.isHost ? h('button.menu-item', { onclick: openSettings }, 'Настройки', h('small', 'часы, цвет')) : null,
    me.isHost ? h('button.menu-item', { onclick: () => openPlayers('host') }, 'Хост', h('small', 'удалить, передать')) : null,
    s.hub && !s.solo ? h('button.menu-item', { onclick: newLobby }, '+ Новое лобби', h('small', 'ещё один стол с теми же настройками')) : null,
  );
  const actions = h('div.panel');
  if (me.kicked) actions.append(h('div.hint', 'Хост удалил вас из этой игры.'));
  else if (me.seated) actions.append(h('button.btn', { onclick: () => send({ t: 'leave' }) }, 'Встать'));
  else if (seated.length >= 2) actions.append(h('div.hint', 'Оба места заняты — вы можете смотреть партию.'));
  else actions.append(h('button.btn.primary.lg', { onclick: () => { haptic.tap(); send({ t: 'sit' }); } }, 'Сесть за доску'));
  if (me.isHost) {
    actions.append(h('button.btn.primary.lg', { disabled: !s.canStart, onclick: () => { haptic.tap(); send({ t: 'start' }); } },
      '▶ Начать', s.canStart ? null : h('small', s.room.startBlocker || 'ждём соперника')));
  }
  if (net.busy) actions.classList.add('busy');
  $app.append(lobby, actions);
}

/* ------------------------------------------------------------------ table */

function renderTable() {
  const s = state;
  const m = s.match;
  if (!m) return $app.append(h('div.boot', h('div', 'Ждём начала партии…')));
  const mine = s.me.color; // null — зритель: смотрит со стороны белых
  const bottom = mine || 'w';
  const top = bottom === 'w' ? 'b' : 'w';

  const root = h('div.ch',
    h('div.ch-head',
      s.hub ? h('button.k-icon-btn', { 'aria-label': s.solo ? 'Игры с ботами' : 'Все игры группы', onclick: () => send({ t: 'hub' }, { lock: false }) }, backIcon()) : h('span.ch-head-gap'),
      h('div.ch-title', `Шахматы · ${s.room.control}`, h('small', `Партия ${m.no}${s.room.title ? ' · ' + s.room.title : ''}`)),
      h('button.k-icon-btn', { 'aria-label': 'Меню', onclick: openMenu }, dotsIcon())),
    playerBar(top),
    h('div.ch-board-wrap', boardEl(bottom)),
    playerBar(bottom),
    statusEl(),
    navEl(),
    movesEl(),
  );
  const actions = actionsEl();
  $app.append(root, actions);
  const strip = root.querySelector('.ch-moves');
  if (strip) strip.scrollTop = strip.scrollHeight; // свежие ходы — внизу
  slideLastMove(root.querySelector('.ch-board'));
}

/**
 * Ход — не прыжок: фигура скользит с прежней клетки на новую (и ладья при
 * рокировке). Только когда ровно один ход назад позиция была другой, ход не
 * наш (свой, положенный рукой, уже на месте) и состояние показывается впервые.
 */
function slideLastMove(board) {
  const s = state;
  const m = s.match;
  const was = prev?.match;
  const fresh = animatedSeq !== s.seq;
  animatedSeq = s.seq;
  if (!fresh || REDUCED || viewPly !== null || !board || !m.last || !was || was.no !== m.no || m.plies !== was.plies + 1) return;
  if (ownMove && ownMove.no === m.no && ownMove.plies === m.plies) { ownMove = null; return; }
  slide(board, m.last.from, m.last.to);
  if (m.last.san.startsWith('O-O')) {
    const rank = m.turn === 'w' ? '8' : '1'; // сходил тот, чей ход теперь не наступил
    const [a, b] = m.last.san.startsWith('O-O-O') ? ['a', 'd'] : ['h', 'f'];
    slide(board, a + rank, b + rank);
  }
}

function slide(board, from, to) {
  const a = board.querySelector(`[data-sq="${from}"]`);
  const pc = board.querySelector(`[data-sq="${to}"] .ch-pc`);
  if (!a || !pc) return;
  const ra = a.getBoundingClientRect();
  const rb = pc.parentElement.getBoundingClientRect();
  // zIndex в обоих кадрах: скользящая фигура идёт поверх остальных, а не под ними.
  pc.animate([
    { transform: `translate(${ra.left - rb.left}px, ${ra.top - rb.top}px)`, zIndex: 5 },
    { transform: 'none', zIndex: 5 },
  ], { duration: 200, easing: EASE });
}

const backIcon = () => h('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>' });
const dotsIcon = () => h('span', { html: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>' });

/** Плашка игрока: кто, чьи фигуры съел и сколько на часах. */
function playerBar(color) {
  const s = state;
  const m = s.match;
  const p = s.players.find((x) => x.color === color);
  const live = !m.over;
  const turn = live && m.turn === color;
  const eaten = m.captured[color]; // что съел этот цвет — фигуры соперника
  const lead = color === 'w' ? m.material : -m.material;
  const away = p && !p.seated;
  return h(`div.ch-bar${turn ? '.turn' : ''}${away ? '.away' : ''}`, { 'data-color': color },
    p ? avatar(p.name, p.hue, 'sm') : h('div.av.sm', '?'),
    h('div.ch-who',
      h('div.ch-name', p ? p.name : '—', p?.isMe ? h('small', ' · вы') : null),
      h('div.ch-eaten', ...eaten.map((x) => img(code(x), 'mini')), lead > 0 ? h('span.ch-lead.num', `+${lead}`) : null)),
    clockEl(color, turn));
}

/** Часы: у идущей стороны — отсчёт до срока сервера, у стоящей — остаток. */
function clockEl(color, running) {
  const c = state.match.clock;
  const over = !!state.match.over;
  if (!c.timed && !(running && c.first)) return h('div.ch-clock.off', { 'aria-hidden': 'true' }, '');
  if (running && c.deadline) {
    return h('div.ch-clock.run.num', { 'data-count': c.deadline, 'data-prefix': c.first ? '⏱ ' : '' }, `${c.first ? '⏱ ' : ''}${clock(c.left)}`);
  }
  // Часы стоят: свои остатки (а у ходящего без срока — остаток на паузе).
  const ms = running && !over ? c.left : c[color];
  return h(`div.ch-clock.num${running ? '.run' : ''}`, clock(ms));
}

function boardEl(bottom) {
  const s = state;
  const flip = bottom === 'b';
  const v = shown();
  const board = h(`div.ch-board${flip ? '.flip' : ''}`, { role: 'grid', 'aria-label': 'Шахматная доска' });
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const rank = flip ? r : 7 - r;
      const file = flip ? 7 - f : f;
      const name = sqOf(file, rank);
      const piece = v.board[rank * 8 + file];
      const dark = (file + rank) % 2 === 0;
      const cls = ['ch-sq', dark ? 'dark' : 'light'];
      // Откуда сошла фигура — заметнее, чем куда пришла: по пустой клетке глаз
      // находит «здесь что-то было», а по фигуре — «вот она».
      if (v.last?.from === name) cls.push('last-from');
      if (v.last?.to === name) cls.push('last-to');
      if (v.check === name) cls.push('check');
      const label = `${name}${piece ? `, ${isMineColor(piece, 'w') ? 'белая' : 'чёрная'} ${PIECE_RU[piece.toLowerCase()]}` : ''}`;
      board.append(h(`button.${cls.join('.')}`, { type: 'button', 'aria-label': label, 'data-sq': name, onclick: () => tapSquare(name) },
        piece ? img(code(piece)) : null));
    }
  }
  paintMarks(board);
  // Перетаскивание: один набор обработчиков на всю доску, а не по клетке.
  board.addEventListener('pointerdown', (e) => dragStart(e, board));
  board.addEventListener('pointermove', dragMove);
  board.addEventListener('pointerup', dragEnd);
  board.addEventListener('pointercancel', dragCancel);

  // Рамка с буквами и цифрами ВНЕ клеток: по ней читается «куда сходил соперник».
  // Буква и цифра клеток последнего хода подсвечены — достаточно глянуть на край.
  const hot = new Set([v.last?.from, v.last?.to].filter(Boolean));
  const hotFile = new Set([...hot].map((n) => n[0]));
  const hotRank = new Set([...hot].map((n) => n[1]));
  const order = flip ? [...FILES].reverse() : [...FILES];
  const ranks = (flip ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1]);
  return h('div.ch-frame',
    h('div.ch-ranks', ranks.map((n) => h(`span${hotRank.has(String(n)) ? '.hot' : ''}`, String(n)))),
    board,
    h('span'),
    h('div.ch-files', order.map((c) => h(`span${hotFile.has(c) ? '.hot' : ''}`, c))));
}

/**
 * Метки «сюда можно»: точка в центре пустой клетки, рамка на съедобной и на
 * выбранной фигуре. Красятся по `sel` и по тому, что сказал сервер (`legal`),
 * без перестройки доски — поэтому годятся и посреди перетаскивания.
 */
function paintMarks(board) {
  const L = state.legal;
  const targets = sel && L.myTurn && viewPly === null ? new Set(L.to[sel] || []) : new Set();
  for (const cell of board.querySelectorAll('.ch-sq')) {
    const name = cell.dataset.sq;
    cell.classList.toggle('sel', sel === name);
    cell.classList.toggle('dot', targets.has(name) && !cell.querySelector('.ch-pc'));
    cell.classList.toggle('cap', targets.has(name) && !!cell.querySelector('.ch-pc'));
  }
}

/* ------------------------------------------------------- перетаскивание */

const DRAG_PX = 6;

function dragStart(e, board) {
  if (e.button > 0 || net.busy || drag || viewPly !== null) return; // мышью — только левой; в просмотре ходить нельзя
  const L = state.legal;
  if (!L.myTurn) return;
  const cell = e.target.closest?.('.ch-sq');
  const from = cell?.dataset.sq;
  const pc = cell?.querySelector('.ch-pc');
  if (!pc || !L.to[from]) return; // не своя фигура или ей некуда ходить: это обычный тап
  drag = { from, id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, pc, cell, rect: cell.getBoundingClientRect(), hover: null, board };
}

/** Фигура под пальцем; на сенсорном экране — чуть выше него, чтобы палец её не закрывал. */
const lift = (e, d) => (e.pointerType === 'touch' ? -d.rect.height * 0.55 : 0);

function dragMove(e) {
  const d = drag;
  if (!d || e.pointerId !== d.id) return;
  if (!d.moved) {
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_PX) return;
    d.moved = true;
    sel = d.from;
    paintMarks(d.board);
    d.board.setPointerCapture?.(e.pointerId);
    d.pc.classList.add('drag');
    haptic.soft();
  }
  const cx = d.rect.left + d.rect.width / 2;
  const cy = d.rect.top + d.rect.height / 2;
  const dy = lift(e, d);
  d.pc.style.transform = `translate(${e.clientX - cx}px, ${e.clientY - cy + dy}px) scale(1.15)`;
  const over = document.elementFromPoint(e.clientX, e.clientY + dy)?.closest('.ch-sq');
  const target = over && state.legal.to[d.from]?.includes(over.dataset.sq) ? over : null;
  if (target !== d.hover) {
    d.hover?.classList.remove('hover');
    target?.classList.add('hover');
    d.hover = target;
  }
}

function dragEnd(e) {
  const d = drag;
  if (!d || e.pointerId !== d.id) return;
  drag = null;
  d.hover?.classList.remove('hover');
  if (!d.moved) return; // тап без движения — дальше сработает click
  droppedAt = performance.now();
  const over = document.elementFromPoint(e.clientX, e.clientY + lift(e, d))?.closest('.ch-sq');
  const to = over?.dataset.sq;
  if (to && to !== d.from && state.legal.to[d.from]?.includes(to)) {
    if (state.legal.promo.includes(d.from + to)) {
      springBack(d); // фигура ещё не ушла: сначала выбор, в кого превратиться
      return openPromo(d.from, to);
    }
    // Положить фигуру на клетку сразу, не дожидаясь сервера; он подтвердит ход
    // новым состоянием, и оно перерисует доску честно.
    over.querySelector('.ch-pc')?.remove();
    over.append(d.pc);
    d.pc.classList.remove('drag');
    d.pc.style.transform = '';
    ownMove = { no: state.match.no, plies: state.match.plies + 1 };
    sel = null;
    paintMarks(d.board);
    haptic.tap();
    if (!send({ t: 'move', from: d.from, to, ply: state.match.plies })) bus.render(); // нет связи: вернуть позицию
    return;
  }
  springBack(d); // отпустили не туда: фигура возвращается, выбор остаётся — можно тапнуть клетку
}

function springBack(d) {
  d.pc.style.transition = REDUCED ? 'none' : 'transform 150ms ease-out';
  d.pc.style.transform = '';
  setTimeout(() => {
    d.pc.classList.remove('drag');
    d.pc.style.transition = '';
  }, 170);
}

function dragCancel(e) {
  const d = drag;
  if (!d || e.pointerId !== d.id) return;
  drag = null;
  d.hover?.classList.remove('hover');
  if (d.moved) springBack(d);
}

function tapSquare(name) {
  const s = state;
  if (droppedAt !== null && performance.now() - droppedAt < 350) return; // это хвост перетаскивания, а не тап
  if (net.busy || viewPly !== null) return; // ответ на прошлый ход ещё не пришёл
  const L = s.legal;
  if (!L.myTurn) {
    if (sel) { sel = null; bus.render(); }
    return;
  }
  const m = s.match;
  const idx = (FILES.indexOf(name[0])) + (Number(name[1]) - 1) * 8;
  const piece = m.board[idx];
  if (sel && L.to[sel]?.includes(name)) return playMove(sel, name);
  if (isMineColor(piece, L.color) && L.to[name]) {
    sel = sel === name ? null : name;
    haptic.tap();
  } else {
    sel = null;
  }
  bus.render();
}

function playMove(from, to) {
  const s = state;
  if (s.legal.promo.includes(from + to)) return openPromo(from, to);
  sel = null;
  haptic.tap();
  send({ t: 'move', from, to, ply: s.match.plies });
}

/** Пешка дошла до края: выбор фигуры. */
function openPromo(from, to) {
  const color = state.legal.color;
  const ply = state.match.plies;
  showSheet('promo', () => h('div',
    h('h3', 'В кого превратить пешку?'),
    h('div.ch-promo', ['q', 'r', 'b', 'n'].map((k) => h('button.ch-promo-btn', {
      type: 'button',
      'aria-label': PIECE_RU[k],
      onclick: () => { closeSheet(); sel = null; haptic.tap(); send({ t: 'move', from, to, promo: k, ply }); },
    }, img((color === 'w' ? 'w' : 'b') + k.toUpperCase()), h('small', PIECE_RU[k])))),
    h('button.btn.wide', { style: { marginTop: '12px', width: '100%' }, onclick: () => closeSheet() }, 'Отмена'),
  ));
}

/** Строка под доской: чей ход, шах, чем кончилось. */
function statusEl() {
  const s = state;
  const m = s.match;
  const me = s.me.color;
  if (m.over) {
    const o = m.over;
    const text = o.kind === 'aborted' ? 'Партия отменена'
      : o.winner == null ? `Ничья — ${o.why}`
        : `${o.winner === me ? 'Вы выиграли' : me ? 'Вы проиграли' : `Победа: ${COLOR_RU[o.winner]}`} — ${o.why}`;
    return h(`div.ch-status.over${o.winner && o.winner === me ? '.won' : ''}`, text);
  }
  if (viewPly !== null) return h('div.ch-status.review', 'Вы смотрите прошлую позицию — ходить пока нельзя');
  if (s.canAnswerTakeback) {
    return h('div.ch-status.offer',
      h('span', 'Соперник просит вернуть свой ход'),
      h('div.ch-offer-btns',
        h('button.k-btn.k-btn--primary.k-btn--compact', { onclick: () => { haptic.tap(); send({ t: 'takeback' }); } }, 'Разрешить'),
        h('button.k-btn.k-btn--secondary.k-btn--compact', { onclick: () => send({ t: 'declinetb' }) }, 'Отказать')));
  }
  if (m.takeback?.mine) return h('div.ch-status', 'Вы просите вернуть ход — ждём ответа');
  if (s.canAnswerDraw) {
    return h('div.ch-status.offer',
      h('span', 'Соперник предлагает ничью'),
      h('div.ch-offer-btns',
        h('button.k-btn.k-btn--primary.k-btn--compact', { onclick: () => { haptic.tap(); send({ t: 'draw' }); } }, 'Принять'),
        h('button.k-btn.k-btn--secondary.k-btn--compact', { onclick: () => send({ t: 'decline' }) }, 'Отклонить')));
  }
  if (m.drawOffer?.mine) return h('div.ch-status', 'Вы предложили ничью — ждём ответа');
  if (myMove(s)) return h('div.ch-status.mine', m.check ? 'Шах! Ваш ход' : 'Ваш ход');
  if (!me) return h('div.ch-status', `Ходят ${COLOR_RU[m.turn]}${m.check ? ' — шах' : ''}`);
  return h('div.ch-status', m.check ? 'Вам поставили шах — ждите ход соперника' : 'Ход соперника');
}

/**
 * Одна строка под статусом: листалка по записи и последний ход словами и
 * буквами — «Артём: e7 → e5 · e5». По буквам рамки доски и этой строке видно,
 * куда пошёл соперник, даже если глаз пропустил, как скользила фигура.
 * Листалка — только показ: в начало, назад, вперёд, к текущей.
 */
function navEl() {
  const s = state;
  const m = s.match;
  if (!m.plies) return h('div.ch-nav.empty');
  const at = viewPly ?? m.plies;
  const mv = m.log[at - 1];
  const color = at % 2 === 1 ? 'w' : 'b'; // кто сделал этот ход
  const p = s.players.find((x) => x.color === color);
  const who = viewPly !== null ? `Ход ${Math.ceil(at / 2)}` : p?.isMe ? 'Вы' : p?.name ?? COLOR_RU[color];
  const text = at ? h('span.ch-sub', `${who}: `, h('b', `${mv.from} → ${mv.to}`), ` · ${mv.san}`) : h('span.ch-sub', 'Начало партии');
  const btn = (label, aria, to, off) => h('button.k-icon-btn.ch-nav-btn', { type: 'button', 'aria-label': aria, disabled: off, onclick: () => { haptic.tap(); goto(to); } }, label);
  return h('div.ch-nav',
    btn('⏮', 'В начало партии', 0, at === 0),
    btn('◀', 'Ход назад', at - 1, at === 0),
    text,
    btn('▶', 'Ход вперёд', at + 1, viewPly === null),
    btn('⏭', 'К текущей позиции', m.plies, viewPly === null));
}

/** Запись партии: «1. e4 e5 2. Nf3». Тап по ходу — посмотреть позицию после него. */
function movesEl() {
  const m = state.match;
  if (!m.moves.length) return h('div.ch-moves.empty', 'Ходов ещё нет');
  const out = [];
  const at = viewPly ?? m.plies;
  m.moves.forEach((san, i) => {
    if (i % 2 === 0) out.push(h('span.ch-n', `${i / 2 + 1}.`));
    out.push(h(`button.ch-mv${i + 1 === at ? '.cur' : ''}`, { type: 'button', onclick: () => { haptic.tap(); goto(i + 1); } }, san));
  });
  return h('div.ch-moves', { 'aria-label': 'Записанные ходы' }, ...out);
}

function actionsEl() {
  const s = state;
  const m = s.match;
  const panel = h('div.panel');
  if (m.over) {
    if (s.canNext) panel.append(h('button.k-btn.k-btn--primary.k-btn--block', { onclick: () => { haptic.tap(); send({ t: 'next' }); } }, '▶ Ещё партия'));
    if (s.canShare) panel.append(h('button.k-btn.k-btn--secondary.k-btn--block', { onclick: shareResult }, 'Поделиться'));
    if (s.me.isHost || s.me.seated) panel.append(h('button.k-btn.k-btn--secondary.k-btn--block', { onclick: confirmFinish }, 'Завершить'));
    return panel;
  }
  if (!s.me.color) {
    panel.classList.add('note');
    panel.append(h('span', 'Вы смотрите партию — ходят ', h('b', 'двое')));
    return panel;
  }
  // Три кнопки: откат, ничья и «сдаться» — а до второго хода вместо сдачи отмена партии.
  panel.append(
    askBtn('Откат', s.askUntil.takeback, s.canTakeback, 'takeback'),
    askBtn('Ничья', s.askUntil.draw, s.canOfferDraw, 'draw'),
    s.canAbort
      ? h('button.k-btn.k-btn--secondary.k-btn--block', { onclick: confirmAbort }, 'Отменить')
      : h('button.k-btn.k-btn--secondary.k-btn--block', { disabled: !s.canResign, onclick: confirmResign }, 'Сдаться'));
  if (net.busy) panel.classList.add('busy');
  return panel;
}

/**
 * Окно «Вернуть ход?». Живёт, пока просьба висит: build() возвращает null,
 * когда на неё ответили или она погасла (соперник сходил) — окно закрывается
 * само. Закрыли в сторону — строка под доской с теми же кнопками остаётся.
 */
function openTakebackSheet() {
  showSheet('takeback', () => {
    const s = state;
    if (!s.canAnswerTakeback) return null;
    const by = s.match.takeback.byColor;
    const log = s.match.log;
    let at = -1;
    for (let i = log.length - 1; i >= 0; i--) if ((i % 2 === 0 ? 'w' : 'b') === by) { at = i; break; }
    const who = s.players.find((x) => x.color === by)?.name ?? 'Соперник';
    return h('div',
      h('h3', 'Вернуть ход?'),
      h('div.sub', `${who} просит вернуть ${at >= 0 ? `ход ${log[at].san} (${log[at].from} → ${log[at].to})` : 'свой ход'}. Позиция и часы вернутся к тому моменту.`),
      h('div.grid2',
        h('button.btn', { onclick: () => { closeSheet(); send({ t: 'declinetb' }); } }, 'Отказать'),
        h('button.btn.primary', { onclick: () => { closeSheet(); haptic.tap(); send({ t: 'takeback' }); } }, 'Разрешить')));
  });
}

/** «Поделиться итогом»: сервер готовит сообщение, Telegram даёт выбрать чат (net.js → ui.js:openShare). */
function shareResult() {
  haptic.tap();
  send({ t: 'share' }, { lock: false });
}

/** «+ Новое лобби»: та же игра и настройки, ты — хост. Доступно со страницы, открытой из хаба группы. */
function newLobby() {
  haptic.tap();
  send({ t: 'again', reqId: newReqId() });
}

/**
 * Кнопка просьбы (откат, ничья) с КД: пока сервер не разрешил просить снова
 * (`askUntil`, по часам сервера), она выключена и показывает секунды. Это
 * подсказка, а не защита: сервер всё равно откажет и объяснит.
 */
function askBtn(label, until, allowed, msg) {
  const left = until - serverNow();
  const b = h('button.k-btn.k-btn--secondary.k-btn--block', {
    'data-cd': msg, 'data-until': String(until), 'data-label': label, 'data-enabled': allowed ? '1' : '0',
    disabled: !allowed || left > 0,
    onclick: () => { haptic.tap(); send({ t: msg }); },
  }, left > 0 ? `${label} · ${Math.ceil(left / 1000)}` : label);
  return b;
}

/** Секунды на кнопках с КД идут сами — без перерисовки доски (она сорвала бы перетаскивание). */
function tickCooldowns() {
  const now = serverNow();
  for (const b of document.querySelectorAll('[data-cd]')) {
    const left = Number(b.dataset.until) - now;
    const cooling = left > 0;
    const text = cooling ? `${b.dataset.label} · ${Math.ceil(left / 1000)}` : b.dataset.label;
    if (b.textContent !== text) b.textContent = text;
    b.disabled = cooling || b.dataset.enabled !== '1';
  }
}
setInterval(tickCooldowns, 400);

/* ------------------------------------------------------------- results */

function renderResults() {
  const s = state;
  const rows = s.score.filter((r) => r.games > 0);
  const box = h('div.lobby',
    h('div', h('h1', '🏁 Итоги'), h('div.sub', `Шахматы · партий сыграно: ${s.history}`)),
    h('div.box', rows.length
      ? rows.map((r, i) => h('div.res-row',
        h('span.n', i === 0 && rows.length > 1 && (r.wins !== rows[1].wins || r.losses !== rows[1].losses) ? '🏆 ' : '', r.name,
          r.isHost ? ' 👑' : '', r.kicked ? ' · удалён' : r.left ? ' · вышел' : ''),
        h('span.s.num', `${r.wins} · ${r.draws} · ${r.losses}`),
        h('span.pl.num', `${r.games} ${r.games === 1 ? 'партия' : r.games < 5 ? 'партии' : 'партий'}`)))
      : h('div.hint', 'Ни одной партии не сыграно.')),
    h('div.hint', 'Победы · ничьи · поражения. Итоги бот отправил и в группу.'),
  );
  $app.append(box, h('div.panel',
    state.canShare ? h('button.k-btn.k-btn--secondary.k-btn--block', { onclick: shareResult }, 'Поделиться') : null,
    state.hub && !state.solo ? h('button.k-btn.k-btn--secondary.k-btn--block', { onclick: newLobby }, '+ Новое лобби') : null,
    h('button.btn.primary.wide.lg', { onclick: () => tg.close() }, 'Закрыть')));
}

/* --------------------------------------------------------------- sheets */

function openMenu() {
  haptic.soft();
  showSheet('menu', () => {
    const s = state;
    const me = s.me;
    const m = s.match;
    const live = !!m && !m.over;
    const items = [];
    const item = (text, sub, onclick, cls = '') => items.push(h(`button.menu-item${cls ? '.' + cls : ''}`, { onclick }, text, sub ? h('small', sub) : null));
    if (s.hub) item(s.hubLabel || '← Все игры группы', 'партия останется, как есть', () => { closeSheet(); send({ t: 'hub' }, { lock: false }); });
    if (s.hub && !s.solo) item('+ Новое лобби', 'ещё один стол с теми же настройками', () => { closeSheet(); newLobby(); });
    if (me.seated && !live) item('Встать из-за стола', 'место освободится', () => { closeSheet(); send({ t: 'leave' }); });
    else if (!me.seated && !me.kicked && s.players.filter((p) => p.seated).length < 2) item('Сесть за доску', 'со следующей партии', () => { closeSheet(); send({ t: 'sit' }); });
    if (!me.notify && s.bot) item('🔔 Напоминать о ходе', 'нажмите Start у бота', () => tg.openTelegramLink(`https://t.me/${s.bot}?start=notify`));
    item('Правила и часы', s.room.control, openRules);
    if (me.isHost) {
      items.push(h('div.section-label', 'Хост'));
      if (!live) item('Настройки', 'часы, цвет', openSettings);
      item('Передать права хоста', null, () => openPlayers('host'));
      item('Удалить игрока', live ? 'партия отменится' : null, () => openPlayers('kick'));
      if (s.room.status !== 'lobby') item('Завершить игру', 'итоги — всем и в группу', confirmFinish, 'danger');
    }
    return h('div', h('h3', 'Меню'), h('div.sub', `♟ Шахматы · ${s.room.control}`), h('div.menu-list', items));
  });
}

function openRules() {
  showSheet('rules', () => h('div',
    h('h3', 'Правила и часы'),
    h('div.rules',
      h('p', 'Обычные шахматы по правилам ФИДЕ: рокировка, взятие на проходе, превращение пешки.'),
      h('p', 'Часы у каждого свои; ваше время идёт, пока ваш ход, после хода к нему прибавляется бонус. Упал флажок — проиграли, кроме случая, когда у соперника не осталось сил для мата: тогда ничья.'),
      h('p', 'Пока оба не сделали по ходу, на первый ход — минута. Не пришёл — партия отменяется без результата.'),
      h('p', 'Ничью предлагают кнопкой «Ничья»; соперник принимает или отклоняет. Сама наступает при пате, повторении позиции три раза, правиле 50 ходов и нехватке материала.'),
      h('p', 'В рейтинг идёт победа и поражение; ничья и отменённая партия очков не дают.')),
  ));
}

function openSettings() {
  const st = { ...state.room.settings };
  showSheet('settings', () => {
    const seg = (options, key) => h('div.seg', options.map(([v, text]) => h(`button${st[key] === v ? '.on' : ''}`, {
      onclick: () => { st[key] = v; if (key === 'base' && v === 0) st.inc = 0; refreshSheet(); },
    }, text)));
    return h('div',
      h('h3', 'Настройки'),
      h('div.section-label', 'Время на партию, минут'),
      seg(BASES, 'base'),
      st.base ? h('div.section-label', 'Прибавка за ход') : null,
      st.base ? seg(INCS, 'inc') : null,
      h('div.section-label', 'Цвет хоста'),
      seg(SIDES, 'side'),
      h('div.hint', { style: { marginTop: '6px' } }, 'Следующая партия серии — с обратными цветами.'),
      h('button.btn.primary.wide.lg', { style: { marginTop: '16px', width: '100%' }, onclick: () => {
        send({ t: 'settings', base: st.base, inc: st.inc, side: st.side });
        closeSheet();
      } }, 'Сохранить'),
    );
  });
}

function confirmResign() {
  showSheet('resign', () => h('div',
    h('h3', 'Сдаться?'),
    h('div.sub', 'Партия будет засчитана как поражение.'),
    h('div.grid2',
      h('button.btn', { onclick: () => closeSheet() }, 'Продолжить'),
      h('button.btn.danger', { onclick: () => { closeSheet(); send({ t: 'resign' }); } }, 'Сдаться')),
  ));
}

function confirmAbort() {
  showSheet('abort', () => h('div',
    h('h3', 'Отменить партию?'),
    h('div.sub', 'Пока никто не сходил по два раза, партию можно отменить: результата и рейтинга не будет.'),
    h('div.grid2',
      h('button.btn', { onclick: () => closeSheet() }, 'Нет'),
      h('button.btn.danger', { onclick: () => { closeSheet(); send({ t: 'abort' }); } }, 'Отменить')),
  ));
}

function confirmFinish() {
  showSheet('finish', () => h('div',
    h('h3', 'Завершить игру?'),
    h('div.sub', 'Идущая партия не засчитается. Итоги увидят оба и группа.'),
    h('div.grid2',
      h('button.btn', { onclick: () => closeSheet() }, 'Отмена'),
      h('button.btn.danger', { onclick: () => { closeSheet(); send({ t: 'finish' }); } }, 'Завершить')),
  ));
}

function openPlayers(kind) {
  const titles = { host: 'Передать права хоста', kick: 'Удалить игрока' };
  showSheet(`players-${kind}`, () => {
    const list = state.players.filter((p) => !p.isMe && p.seated);
    return h('div',
      h('h3', titles[kind]),
      h('div.sub', kind === 'kick' ? 'Если идёт партия — она отменится.' : 'Хост меняет настройки и завершает игру.'),
      list.length
        ? h('div.menu-list', list.map((p) => h(`button.menu-item${kind === 'kick' ? '.danger' : ''}`, {
          onclick: () => { send({ t: kind, seat: p.seat }, { lock: false }); closeSheet(); },
        }, p.name)))
        : h('div.hint', 'Кроме вас, за доской никого нет.'),
    );
  });
}

/** Что спрашивают при создании стола. Рисует форму хаб, решает — игра. */
export const lobby = {
  defaults: { base: 600, inc: 0, side: 'random' },
  fields: (st, { seg, h: hh }) => [
    hh('div.section-label', 'Время на партию, минут'),
    seg(BASES, 'base'),
    st.base ? hh('div.section-label', 'Прибавка за ход') : null,
    st.base ? seg(INCS, 'inc') : null,
    hh('div.section-label', 'Ваш цвет'),
    seg(SIDES, 'side'),
    hh('div.hint', { style: { marginTop: '6px' } }, 'Игра на двоих: можно открыть несколько столов сразу — у каждого свой соперник.'),
  ].filter(Boolean),
};

/** Партия с ботом: цвет и часы вместо числа соперников. */
export const solo = { duel: true, blurb: 'Соперник — шахматный движок, от новичка до мастера' };

/** Чем игра подписана в хабе: белый конь и чёрный ферзь. */
export const iconCards = ['/chess/wN.svg', '/chess/bQ.svg'];
