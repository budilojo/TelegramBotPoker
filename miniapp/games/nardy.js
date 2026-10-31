/**
 * Нарды (длинные) внутри Telegram — дуэль по образцу шахмат и шашек: плашки
 * с часами, лобби, меню, итоги — общие; своё — доска из 24 пунктов и кубики.
 *
 * Страница — зрение, а не судья, и уж точно не кубики. «Бросить» шлёт
 * только просьбу (`{t:'roll'}` — без чисел); числа приходят с сервера и у
 * обоих одинаковые. Шаги, которые можно сыграть (`legal.next`: с какого
 * пункта, на какое число, куда), сервер присылает только тому, чей ход, и
 * проверяет каждый заново.
 *
 * Доска — глазами того, кто смотрит: своя голова вверху справа, путь идёт
 * влево по верхнему ряду и вправо по нижнему (против часовой стрелки), дом —
 * нижняя правая четверть. Номера пунктов одни на обоих: у белых голова 1,
 * дом 19…24; у чёрных голова 13, дом 7…12 (чёрному доска показана
 * перевёрнутой — его голова тоже наверху справа). Зритель смотрит глазами белых.
 *
 * Управление: тап по пункту со своей шашкой — точки с числом кубика там,
 * куда можно сыграть; тап по точке — шаг. Перетаскивание пальцем — то же.
 * «Отменить» возвращает шаг, «Готово» отдаёт ход.
 */
import {
  tg, $app, h, haptic, toast, showSheet, closeSheet, refreshSheet, avatar, animateOnce, REDUCED,
} from '../ui.js';
import { dropItem } from '../drop.js';
import { net, bus, send } from '../net.js';
import { avatarEl } from '../profile.js';
import { chatMenuItem } from '../chat.js';

const newReqId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

let state = null;
let prev = null;
/** Выбранный пункт (абсолютный 0…23) со своей шашкой, или null. */
let sel = null;
/** Шашка в руке: { from, id, x0, y0, moved, pc, board, hover }. */
let drag = null;
let droppedAt = null;
/** Кубики на каком броске уже «прокатились» — чтобы анимация шла один раз. */
let rolledAt = null;

const BASES = [[0, 'Нет'], [180, '3'], [300, '5'], [600, '10'], [900, '15'], [1800, '30']];
const INCS = [[0, '0'], [3, '+3 с'], [5, '+5 с'], [10, '+10 с'], [15, '+15 с']];
const SIDES = [['random', 'Случайно'], ['white', 'Белые'], ['black', 'Чёрные']];
const COLOR_RU = { w: 'белые', b: 'чёрные' };

/* ------------------------------------------------------------ геометрия */

const idx = (c, p) => (c === 'w' ? p : (p + 12) % 24);
const abs = (c, i) => (c === 'w' ? i : (i + 12) % 24);
const pointNo = (_c, p) => p + 1; // номера общие: голова белых 1, чёрных 13
const countOf = (b, p, c) => Math.max(0, b[p] * (c === 'w' ? 1 : -1));
const colorAt = (b, p) => (b[p] > 0 ? 'w' : b[p] < 0 ? 'b' : null);
const img = (c, cls = '') => h(`img.nd-pc${cls ? '.' + cls : ''}`, { src: `/checkers/${c}.svg`, alt: '', draggable: 'false' });

const clock = (ms) => {
  const sec = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

/* ------------------------------------------------------------------ state */

const myMove = (s) => !!s?.legal?.myTurn;

export function onState(s, p) {
  state = s;
  prev = p;
  drag = null;
  if (sel && (!myMove(s) || !(s.legal.next || []).some((x) => x.from === sel))) sel = null;
  if (myMove(s) && !(p && myMove(p))) haptic.turn();
  const said = !!s.match?.over;
  if (s.room.notice && s.room.notice !== p?.room?.notice && !said) toast(s.room.notice, 3200);
  const over = s.match?.over;
  if (over && !(p?.match?.over && p.match.no === s.match.no) && s.me.color) {
    setTimeout(over.winner === s.me.color ? haptic.win : haptic.err, 300);
  }
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
      ? animateOnce(h(`div.lseat${p.isMe ? '.me' : ''}`, withMark(avatarEl(p), p.isHost), h('div.nm', p.name)),
        `ndlseat:${p.name}`, [{ transform: 'scale(0.4)', opacity: 0, offset: 0 }], { duration: 450, delay: i * 45 })
      : h('div.lseat.empty', h('div.av', '+'), h('div.nm', 'свободно'));
  });
  const st = s.room.settings;
  const lobby = h('div.lobby',
    backToHub(s),
    h('div', h('h1', '🎲 Нарды'), h('div.sub', `Длинные · ${s.room.control} · Игроков ${seated.length}/2`)),
    h('div.box', h('div.seats-grid.duo', slots)),
    h('div.tags',
      h('span.tag', st.base ? `⏱ ${s.room.control}` : 'Без часов'),
      h('span.tag', `Цвет хоста: ${s.room.sideName}`)),
    h('div.hint', 'Партия на двоих. Кто ходит первым — решат кости. Остальные из группы смогут смотреть.'),
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

const backIcon = () => h('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>' });
const dotsIcon = () => h('span', { html: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>' });

function renderTable() {
  const s = state;
  const m = s.match;
  if (!m) return $app.append(h('div.boot', h('div', 'Ждём начала партии…')));
  const view = s.me.color || 'w';
  const top = view === 'w' ? 'b' : 'w';
  const root = h('div.ch.nd',
    h('div.ch-head',
      s.hub ? h('button.k-icon-btn', { 'aria-label': s.solo ? 'Игры с ботами' : 'Все игры группы', onclick: () => send({ t: 'hub' }, { lock: false }) }, backIcon()) : h('span.ch-head-gap'),
      h('div.ch-title', `Нарды · ${s.room.control}`, h('small', `Партия ${m.no}${s.room.title ? ' · ' + s.room.title : ''}`)),
      h('button.k-icon-btn', { 'aria-label': 'Меню', onclick: openMenu }, dotsIcon())),
    playerBar(top),
    boardEl(view),
    playerBar(view),
    diceEl(view),
    statusEl(),
  );
  paintMarks(root);
  $app.append(root, actionsEl());
}

/** Плашка игрока: кто, сколько снял, сколько пути осталось, часы. */
function playerBar(color) {
  const s = state;
  const m = s.match;
  const p = s.players.find((x) => x.color === color);
  const turn = !m.over && m.turn === color;
  return h(`div.ch-bar${turn ? '.turn' : ''}${p && !p.seated ? '.away' : ''}`, { 'data-color': color },
    p ? avatarEl(p, 'sm') : h('div.av.sm', '?'),
    h('div.ch-who',
      h('div.ch-name', p ? p.name : '—', p?.isMe ? h('small', ' · вы') : null),
      h('div.ch-eaten.nd-meta', img(color, 'mini'), h('span.num', `снято ${m.off[color]} · путь ${m.pips[color]}`))),
    clockEl(color, turn));
}

function clockEl(color, running) {
  const c = state.match.clock;
  const over = !!state.match.over;
  if (!c.timed && !(running && c.first)) return h('div.ch-clock.off', { 'aria-hidden': 'true' }, '');
  if (running && c.deadline) {
    return h('div.ch-clock.run.num', { 'data-count': c.deadline, 'data-prefix': c.first ? '⏱ ' : '' }, `${c.first ? '⏱ ' : ''}${clock(c.left)}`);
  }
  const ms = running && !over ? c.left : c[color];
  return h(`div.ch-clock.num${running ? '.run' : ''}`, clock(ms));
}

/**
 * Пункты по местам на экране, слева направо. Верхний ряд — путь 11…0 (голова
 * справа), нижний — путь 12…23 (дом справа): против часовой стрелки.
 */
function layout(view) {
  const top = [];
  const bottom = [];
  for (let col = 0; col < 12; col++) {
    top.push(abs(view, 11 - col));
    bottom.push(abs(view, 12 + col));
  }
  return { top, bottom };
}

/** Куда можно сыграть с выбранного пункта: пункт (или -1 — снять) → шаги. */
function targetsOf(from) {
  const out = new Map();
  if (from == null || !myMove(state)) return out;
  for (const s of state.legal.next || []) {
    if (s.from !== from) continue;
    if (!out.has(s.to)) out.set(s.to, []);
    out.get(s.to).push(s);
  }
  return out;
}
const canStartFrom = (p) => myMove(state) && (state.legal.next || []).some((s) => s.from === p);

function boardEl(view) {
  const s = state;
  const m = s.match;
  const { top, bottom } = layout(view);
  const last = m.log.at(-1);
  const lastFrom = new Set((last?.steps || []).map((x) => x.from));
  const lastTo = new Set((last?.steps || []).map((x) => x.to).filter((x) => x >= 0));
  const point = (p, row) => {
    const c = colorAt(m.board, p);
    const n = c ? countOf(m.board, p, c) : 0;
    const shown = Math.min(n, 5);
    const stack = Array.from({ length: shown }, (_, i) => (i === shown - 1 && n > 5 ? h('span.nd-stack-top', img(c), h('b.nd-count.num', String(n))) : img(c)));
    const cls = ['nd-pt', row, (idx(view, p) % 2 ? 'b' : 'a')];
    if (lastFrom.has(p)) cls.push('last-from');
    if (lastTo.has(p)) cls.push('last-to');
    const label = `пункт ${pointNo(view, p)}${n ? `, ${n} ${c === 'w' ? 'белых' : 'чёрных'}` : ', пусто'}`;
    return h(`button.${cls.join('.')}`, { type: 'button', 'data-p': String(p), 'aria-label': label, onclick: () => tapPoint(p) },
      h('span.nd-no.num', String(pointNo(view, p))),
      h('span.nd-stack', ...stack));
  };
  const half = (list, row) => [h('div.nd-half', list.slice(0, 6).map((p) => point(p, row))), h('div.nd-bar'), h('div.nd-half', list.slice(6).map((p) => point(p, row)))];
  const board = h('div.nd-board', { role: 'grid', 'aria-label': 'Доска для нардов' },
    h('div.nd-row.up', ...half(top, 'up')),
    h('div.nd-mid'),
    h('div.nd-row.down', ...half(bottom, 'down')));
  const wrap = h('div.nd-wrap', board);
  board.addEventListener('pointerdown', (e) => dragStart(e, wrap.closest('.nd') || wrap));
  board.addEventListener('pointermove', dragMove);
  board.addEventListener('pointerup', dragEnd);
  board.addEventListener('pointercancel', dragCancel);
  return wrap;
}

/** Метки: выбранный пункт, точки с числом там, куда можно, кольцо на своих пунктах с ходом. */
function paintMarks(wrap) {
  const targets = targetsOf(sel);
  for (const el of wrap.querySelectorAll('[data-p]')) {
    const p = Number(el.dataset.p);
    el.classList.toggle('sel', sel === p);
    el.classList.toggle('can', sel == null && p >= 0 && canStartFrom(p));
    const t = targets.get(p);
    el.classList.toggle('dot', !!t);
    el.querySelector('.nd-die')?.remove();
    if (t) {
      const badge = h('span.nd-die.num', t.map((x) => x.die).join('·'));
      // В полосе «снять» число — сразу за словами, а не поверх счёта.
      if (p < 0) el.firstChild.after(badge);
      else el.append(badge);
    }
  }
  wrap.querySelector('.nd-off')?.classList.toggle('show', targets.has(-1));
}

/* ---------------------------------------------------------- ходы рукой */

function tapPoint(p) {
  const s = state;
  if (droppedAt !== null && performance.now() - droppedAt < 350) return;
  if (net.busy || !myMove(s)) return;
  const t = targetsOf(sel).get(p);
  if (t) return play(t[0]);
  if (p >= 0 && canStartFrom(p)) {
    sel = sel === p ? null : p;
    haptic.tap();
  } else {
    if (p >= 0 && colorAt(s.match.board, p) === s.legal.color && s.legal.phase === 'move') toast('Отсюда сейчас не сыграть — точки покажут, куда можно', 2200);
    sel = null;
  }
  bus.render();
}

function play(step) {
  sel = null;
  haptic.tap();
  send({ t: 'move', from: step.from, die: step.die, turn: state.match.turns });
  bus.render();
}

const DRAG_PX = 6;
function dragStart(e, wrap) {
  if (e.button > 0 || net.busy || drag || !myMove(state)) return;
  const pt = e.target.closest?.('.nd-pt');
  const from = pt ? Number(pt.dataset.p) : null;
  if (from == null || !canStartFrom(from)) return;
  const pcs = pt.querySelectorAll('.nd-pc');
  const pc = pcs[pcs.length - 1];
  if (!pc) return;
  drag = { from, id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, pc, wrap, hover: null };
}
function dragMove(e) {
  const d = drag;
  if (!d || e.pointerId !== d.id) return;
  if (!d.moved) {
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_PX) return;
    d.moved = true;
    sel = d.from;
    paintMarks(d.wrap);
    d.wrap.querySelector('.nd-board').setPointerCapture?.(e.pointerId);
    d.pc.classList.add('drag');
    haptic.soft();
  }
  d.pc.style.transform = `translate(${e.clientX - d.x0}px, ${e.clientY - d.y0}px) scale(1.15)`;
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-p]');
  const ok = over && targetsOf(d.from).has(Number(over.dataset.p)) ? over : null;
  if (ok !== d.hover) {
    d.hover?.classList.remove('hover');
    ok?.classList.add('hover');
    d.hover = ok;
  }
}
function dragEnd(e) {
  const d = drag;
  if (!d || e.pointerId !== d.id) return;
  drag = null;
  d.hover?.classList.remove('hover');
  if (!d.moved) return;
  droppedAt = performance.now();
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-p]');
  const t = over && targetsOf(d.from).get(Number(over.dataset.p));
  d.pc.classList.remove('drag');
  d.pc.style.transform = '';
  if (t) return play(t[0]);
}
function dragCancel(e) {
  const d = drag;
  if (!d || e.pointerId !== d.id) return;
  drag = null;
  d.pc.classList.remove('drag');
  d.pc.style.transform = '';
}

/* -------------------------------------------------------------- кубики */

const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function dieFace(n, cls = '') {
  return h(`span.nd-dicef${cls}`, { 'aria-label': `кубик ${n}` },
    ...Array.from({ length: 9 }, (_, i) => h(`i${PIPS[n].includes(i) ? '.on' : ''}`)));
}

/**
 * Кубики хода: несыгранные — яркие, сыгранные — бледные и зачёркнутые. Рядом
 * — «⤓ Снять»: цель для снятия с доски, когда снять можно (в том же ряду,
 * чтобы экран не прыгал по высоте).
 */
function diceEl(view) {
  const m = state.match;
  const off = h('button.nd-off', { type: 'button', 'data-p': '-1', onclick: () => tapPoint(-1), 'aria-label': `снять шашку с доски, снято ${m.off[view]} из 15` },
    h('span', '⤓ Снять'));
  if (!m.dice || m.over) return h('div.nd-dice.empty', off);
  const all = m.dice[0] === m.dice[1] ? [m.dice[0], m.dice[0], m.dice[0], m.dice[0]] : m.dice.slice();
  const left = m.diceLeft.slice();
  const faces = all.map((n) => {
    const i = left.indexOf(n);
    const used = i < 0;
    if (!used) left.splice(i, 1);
    return dieFace(n, used ? '.used' : '');
  });
  const box = h('div.nd-dice', h('span.nd-faces', { 'aria-label': `кубики ${m.dice.join(' и ')}` }, ...faces), off);
  // Бросок — один раз «прокатить»: числа уже с сервера, это только глазам.
  const k = `${m.no}:${m.turns}:${m.dice.join()}`;
  if (rolledAt !== k) {
    rolledAt = k;
    if (!REDUCED && !m.played.length) for (const f of faces) f.animate([{ transform: 'rotate(-200deg) scale(0.6)' }, { transform: 'none' }], { duration: 380, easing: 'ease-out' });
  }
  return box;
}

/* -------------------------------------------------------- строка и кнопки */

function statusEl() {
  const s = state;
  const m = s.match;
  const me = s.me.color;
  if (m.over) {
    const o = m.over;
    const text = o.kind === 'aborted' ? 'Партия отменена'
      : `${o.winner === me ? 'Вы выиграли' : me ? 'Вы проиграли' : `Победа: ${COLOR_RU[o.winner]}`} — ${o.why}`;
    return h(`div.ch-status.over${o.winner && o.winner === me ? '.won' : ''}`, text);
  }
  if (myMove(s)) {
    const L = s.legal;
    if (L.phase === 'roll') return h('div.ch-status.mine', 'Ваш ход — бросайте кубики');
    if (L.phase === 'done') return h('div.ch-status.mine', 'Ход сыгран — «Готово» или «Вернуть» шаг');
    return h('div.ch-status.mine', sel == null ? 'Выберите шашку — с кольцом можно ходить' : 'Куда: число на точке — какой кубик');
  }
  const last = m.log.at(-1);
  const who = s.players.find((x) => x.color === m.turn);
  const lastText = last ? ` · ${last.c === me ? 'вы' : 'соперник'}: ${last.dice.join('-')} ${last.notation.join(' ') || 'без хода'}` : '';
  if (!me) return h('div.ch-status', `Ходят ${COLOR_RU[m.turn]}${lastText}`);
  return h('div.ch-status', `Ход соперника${who ? ` (${who.name})` : ''}${m.played.length ? `: ${m.played.map((x) => x.text).join(' ')}` : ''}`);
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
  const L = s.legal;
  if (L.myTurn && L.canRoll) {
    panel.append(h('button.k-btn.k-btn--primary.k-btn--block.nd-roll', { onclick: () => { haptic.tap(); send({ t: 'roll' }); } }, '🎲 Бросить'));
  } else {
    panel.append(
      h('button.k-btn.k-btn--secondary.k-btn--block', { disabled: !L.myTurn || !L.canUndo, onclick: () => { haptic.tap(); sel = null; send({ t: 'undo' }); } }, 'Вернуть'),
      h('button.k-btn.k-btn--primary.k-btn--block', { disabled: !L.myTurn || !L.canEnd, onclick: () => { haptic.tap(); send({ t: 'end' }); } }, 'Готово'));
  }
  panel.append(s.canAbort
    ? h('button.k-btn.k-btn--secondary.k-btn--block', { onclick: confirmAbort }, 'Отменить')
    : h('button.k-btn.k-btn--secondary.k-btn--block', { disabled: !s.canResign, onclick: confirmResign }, 'Сдаться'));
  if (net.busy) panel.classList.add('busy');
  return panel;
}

function shareResult() {
  haptic.tap();
  send({ t: 'share' }, { lock: false });
}

function newLobby() {
  haptic.tap();
  send({ t: 'again', reqId: newReqId() });
}

/* ------------------------------------------------------------- results */

function renderResults() {
  const s = state;
  const rows = s.score.filter((r) => r.games > 0);
  const box = h('div.lobby',
    h('div', h('h1', '🏁 Итоги'), h('div.sub', `Нарды · партий сыграно: ${s.history}`)),
    h('div.box', rows.length
      ? rows.map((r, i) => h('div.res-row',
        h('span.n', i === 0 && rows.length > 1 && r.wins !== rows[1].wins ? '🏆 ' : '', r.name,
          r.isHost ? ' 👑' : '', r.kicked ? ' · удалён' : r.left ? ' · вышел' : ''),
        h('span.s.num', `${r.wins} · ${r.losses}`),
        h('span.pl.num', `${r.games} ${r.games === 1 ? 'партия' : r.games < 5 ? 'партии' : 'партий'}`)))
      : h('div.hint', 'Ни одной партии не сыграно.')),
    h('div.hint', 'Победы · поражения. Итоги бот отправил и в группу.'),
  );
  $app.append(box, h('div.panel',
    state.canShare ? h('button.k-btn.k-btn--secondary.k-btn--block', { onclick: shareResult }, 'Поделиться') : null,
    (state.hub && !state.solo) || state.canRematch ? h('button.k-btn.k-btn--secondary.k-btn--block', { onclick: newLobby }, '+ Новое лобби') : null,
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
    if (m) item('История бросков', `${m.rolls.length} — всё, что выпадало в партии`, openRolls);
    if (me.seated && !live) item('Встать из-за стола', 'место освободится', () => { closeSheet(); send({ t: 'leave' }); });
    else if (!me.seated && !me.kicked && s.players.filter((p) => p.seated).length < 2) item('Сесть за доску', 'со следующей партии', () => { closeSheet(); send({ t: 'sit' }); });
    if (!me.notify && s.bot) item('🔔 Напоминать о ходе', 'нажмите Start у бота', () => tg.openTelegramLink(`https://t.me/${s.bot}?start=notify`));
    item('Правила и часы', s.room.control, openRules);
    items.push(chatMenuItem(s));
    if (me.isHost) {
      items.push(h('div.section-label', 'Хост'));
      if (!live) item('Настройки', 'часы, цвет', openSettings);
      item('Передать права хоста', null, () => openPlayers('host'));
      item('Удалить игрока', live ? 'партия отменится' : null, () => openPlayers('kick'));
      if (s.room.status !== 'lobby') item('Завершить игру', 'итоги — всем и в группу', confirmFinish, 'danger');
      dropItem(item);
    }
    return h('div', h('h3', 'Меню'), h('div.sub', `🎲 Нарды · ${s.room.control}`), h('div.menu-list', items));
  });
}

/** Все броски партии — по порядку, с тем, что ими сыграно. Видно обоим. */
function openRolls() {
  showSheet('rolls', () => {
    const s = state;
    const m = s.match;
    const name = (c) => s.players.find((x) => x.color === c)?.name ?? COLOR_RU[c];
    // Первый ход играется числами жребия, у каждого следующего — свой бросок: k-й бросок — k-й ход.
    const said = (k) => (m.log[k] ? m.log[k].notation.join(' ') || 'без хода' : '…');
    const rows = m.rolls.map((r, k) => (r.start
      ? h('div.res-row', h('span.n', `Жребий · ходит ${name(m.first)}`), h('span.s.num', `${r.start.w} : ${r.start.b}`), h('span.pl', said(0)))
      : h('div.res-row', h('span.n', name(r.c)), h('span.s.num', r.dice.join('-')), h('span.pl', said(k)))));
    return h('div', h('h3', 'История бросков'), h('div.sub', 'Кубики бросает сервер; здесь всё, что выпало в этой партии.'),
      h('div.box.nd-rolls', rows.length ? rows : h('div.hint', 'Бросков ещё не было.')));
  });
}

function openRules() {
  showSheet('rules', () => h('div',
    h('h3', 'Правила и часы'),
    h('div.rules',
      h('p', 'Длинные нарды по правилам Федерации нард России. У каждого 15 шашек на «голове»; ходят в одну сторону, по кругу, против часовой стрелки, к себе в дом (у белых — пункты 19…24, у чёрных — 7…12) и там снимают. Голова белых — пункт 1, голова чёрных — 13.'),
      h('p', 'Кто ходит первым — решают кости: у кого больше, тот и ходит этими числами. Потом каждый в свой ход жмёт «Бросить» — кубики бросает сервер, оба видят одно и то же.'),
      h('p', 'Каждое число — отдельный ход шашки; дубль — четыре хода. На пункт соперника вставать нельзя. С головы за ход — одна шашка; только второй игрок на первом броске 3-3, 4-4 или 6-6 снимает две.'),
      h('p', 'Сыграть надо оба числа, если можно; если только одно — большее. Нечем ходить — ход переходит сам. Нельзя ставить шесть шашек подряд так, чтобы запереть все шашки соперника.'),
      h('p', 'Снимать можно, когда все 15 дома. Кто первым снял все — выиграл; ничьей нет.'),
      h('p', 'Пока не нажали «Готово», шаг можно вернуть. Часы — на весь ход, прибавка после «Готово». Упал флажок — проиграли.')),
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
      h('button.btn.primary.wide.lg', { style: { marginTop: '16px', width: '100%' }, onclick: () => {
        if (!send({ t: 'settings', base: st.base, inc: st.inc, side: st.side })) return;
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
    h('div.sub', 'Пока каждый не сходил, партию можно отменить: результата и рейтинга не будет.'),
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

/** Что спрашивают при создании стола. */
export const lobby = {
  defaults: { base: 600, inc: 0, side: 'random' },
  fields: (st, { seg, h: hh }) => [
    hh('div.section-label', 'Время на партию, минут'),
    seg(BASES, 'base'),
    st.base ? hh('div.section-label', 'Прибавка за ход') : null,
    st.base ? seg(INCS, 'inc') : null,
    hh('div.section-label', 'Ваш цвет'),
    seg(SIDES, 'side'),
    hh('div.hint', { style: { marginTop: '6px' } }, 'Длинные нарды на двоих. Кто ходит первым — решат кости.'),
  ].filter(Boolean),
};

/** Партия с ботом: цвет и часы вместо числа соперников. */
export const solo = { duel: true, blurb: 'Длинные нарды против бота, от новичка до мастера' };

/** Чем игра подписана в хабе: белая и чёрная шашки. */
export const iconCards = ['/checkers/w.svg', '/checkers/b.svg'];
