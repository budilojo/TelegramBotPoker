/**
 * Морской бой внутри Telegram — дуэль по образцу нард и шахмат: шапка,
 * плашки с часами, лобби, меню, итоги — общие (`.ch-*` из chess.css); своё —
 * поле 10×10, лоток с кораблями и прицел.
 *
 * Страница — зрение и руки, но не судья и не хранилище чужого. Сервер
 * присылает только свой вид (bot/games/battleship/view.js): свой флот, куда
 * стрелял соперник, и результаты своих выстрелов. Чужого флота на странице
 * нет до конца партии — показывать нечего, даже если очень захотеть.
 *
 * РАССТАНОВКА. Корабли — в лотке под полем. Перетащите корабль на поле: он
 * примагничивается к клеткам; там, где ставить нельзя (касание, даже углом),
 * клетки помечены крестиком в пунктире. Тап по кораблю на поле — повернуть,
 * утащить с поля — вернуть в лоток. Можно и без перетаскивания: тап по
 * кораблю в лотке, потом по клетке. «Случайно» расставляет сервер, «Я
 * готов» отправляет флот на проверку и запирает его.
 *
 * БОЙ — выстрел в два шага: тап выбирает клетку (на ней прицел, её адрес
 * крупно рядом с кнопкой), «Огонь» стреляет. На 320 px клетка около 28 px —
 * меньше нормальной зоны нажатия, а промах в соседнюю клетку необратим.
 *
 * Отметки различаются не только цветом: мимо — точка, около потопленного —
 * точка поменьше, ранил — крест на светлой клетке, убит — тёмная клетка со
 * светлым крестом и обводка всего корабля.
 */
import {
  tg, $app, h, haptic, toast, showSheet, closeSheet, refreshSheet, avatar, animateOnce,
} from '../ui.js';
import { net, bus, send } from '../net.js';
import { reactOn, reactSlot, reactMenuItem } from '../reactions.js';

const newReqId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const N = 10;
const LETTERS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И', 'К'];
/** Флот по местам в лотке: длинные первыми — в том же порядке сервер хранит флот. */
const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const DECKS_RU = { 4: 'четырёхпалубный', 3: 'трёхпалубный', 2: 'двухпалубный', 1: 'однопалубный' };
const RESULT_RU = { miss: 'мимо', hit: 'ранил', sunk: 'убил' };
const BASES = [[0, 'Нет'], [180, '3'], [300, '5'], [600, '10'], [900, '15']];
const INCS = [[0, '0'], [2, '+2 с'], [5, '+5 с'], [10, '+10 с']];

let state = null;
/** Выбранная цель в бою (клетка 0…99) или null. */
let aim = null;
/** Черновик расстановки: корабль на каждое место лотка (или null), с какой партии и какой флот сервера уже принят. */
let draft = { no: null, ships: FLEET.map(() => null), server: '' };
/** Выбранный в лотке размер корабля (тап по лотку → тап по клетке). */
let pick = null;
/** Корабль в руке: { slot, len, dir, grab, from, id, x0, y0, moved, cand }. */
let drag = null;

/* ------------------------------------------------------------ геометрия */

const xOf = (c) => c % N;
const yOf = (c) => Math.floor(c / N);
const addr = (c) => `${LETTERS[xOf(c)]}${yOf(c) + 1}`;
const cellsOf = (s) => Array.from({ length: s.len }, (_, i) => (s.dir === 'h' ? (s.y * N + s.x + i) : ((s.y + i) * N + s.x)));
const inField = (s) => s.x >= 0 && s.y >= 0 && (s.dir === 'h' ? s.x + s.len <= N && s.y < N : s.y + s.len <= N && s.x < N);
function around(c) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = xOf(c) + dx;
      const y = yOf(c) + dy;
      if ((dx || dy) && x >= 0 && y >= 0 && x < N && y < N) out.push(y * N + x);
    }
  }
  return out;
}
/** Корабль `s` встаёт к остальным (кроме места `skip`): в поле, без наложений и касаний. */
function fits(s, skip = -1) {
  if (!inField(s)) return false;
  const busy = new Set();
  draft.ships.forEach((o, i) => {
    if (!o || i === skip) return;
    for (const c of cellsOf(o)) {
      busy.add(c);
      for (const n of around(c)) busy.add(n);
    }
  });
  return cellsOf(s).every((c) => !busy.has(c));
}
/** Держать корабль в поле: при перетаскивании он прилипает к краю, а не вываливается. */
function clampShip(s) {
  const maxX = s.dir === 'h' ? N - s.len : N - 1;
  const maxY = s.dir === 'v' ? N - s.len : N - 1;
  return { ...s, x: Math.max(0, Math.min(maxX, s.x)), y: Math.max(0, Math.min(maxY, s.y)) };
}
const shipKey = (list) => JSON.stringify((list || []).map((s) => [s.x, s.y, s.len, s.dir]));
const placedAll = () => draft.ships.every(Boolean);

const clock = (ms) => {
  const sec = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

/* ------------------------------------------------------------------ state */

const myTurn = (s) => !!s?.legal?.myTurn;
/** Что смотрящий знает о поле стороны `side`: отметки и клетки «около потопленного». */
function known(board) {
  const marks = new Map(board.shots.map((x) => [x.c, x.r]));
  return { marks, around: new Set(board.around) };
}

export function onState(s, p) {
  state = s;
  drag = null;
  const m = s.match;
  // Новая партия — новый черновик; с сервера — флот, который он хранит (после «Случайно» или перезапуска).
  if (!m || draft.no !== m.no) {
    draft = { no: m?.no ?? null, ships: FLEET.map(() => null), server: '' };
    pick = null;
    aim = null;
  }
  if (m && m.phase === 'place' && m.mySide != null) {
    const mine = m.boards[m.mySide].ships;
    const key = shipKey(mine);
    if (mine.length && key !== draft.server) {
      draft.ships = FLEET.map((len, i) => (mine[i] && mine[i].len === len ? { ...mine[i] } : null));
      draft.server = key;
    }
  }
  // Цель, о которой уже всё известно, — больше не цель.
  if (aim != null && (!myTurn(s) || isKnownEnemy(aim))) aim = null;
  if (myTurn(s) && !(p && myTurn(p))) haptic.turn();
  // Выстрелы и так видны на поле — во всплывашку только остальное.
  const n = s.room.notice;
  // На расстановке всё и так написано на экране (кто готов, сколько времени) — без всплывашек.
  if (n && n !== p?.room?.notice && !m?.over && m?.phase !== 'place' && !/ — (мимо|ранил|убил)$/.test(n)) toast(n, 3200);
  const over = m?.over;
  if (over && !(p?.match?.over && p.match.no === m.no) && m.mySide != null && over.kind !== 'aborted') {
    setTimeout(over.winner === m.mySide ? haptic.win : haptic.err, 300);
  }
  bus.render();
  refreshSheet();
}

function isKnownEnemy(c) {
  const m = state?.match;
  if (!m || m.mySide == null) return false;
  const k = known(m.boards[1 - m.mySide]);
  return k.marks.has(c) || k.around.has(c);
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
        `bslseat:${p.name}`, [{ transform: 'scale(0.4)', opacity: 0, offset: 0 }], { duration: 450, delay: i * 45 })
      : h('div.lseat.empty', h('div.av', '+'), h('div.nm', 'свободно'));
  });
  const st = s.room.settings;
  const lobby = h('div.lobby',
    backToHub(s),
    h('div', h('h1', '🚢 Морской бой'), h('div.sub', `${s.room.control} · Игроков ${seated.length}/2`)),
    h('div.box', h('div.seats-grid.duo', slots)),
    h('div.tags', h('span.tag', st.base ? `⏱ ${s.room.control}` : 'Без часов'), h('span.tag', 'Расстановка — 2 минуты')),
    h('div.hint', 'Партия на двоих. Каждый тайно расставляет флот, кто стреляет первым — решит жребий. Остальные из группы смогут смотреть — только выстрелы, без кораблей.'),
    notifyHint(),
    me.isHost ? h('button.menu-item', { onclick: openSettings }, 'Настройки', h('small', 'часы')) : null,
    me.isHost ? h('button.menu-item', { onclick: () => openPlayers('host') }, 'Хост', h('small', 'удалить, передать')) : null,
    s.hub && !s.solo ? h('button.menu-item', { onclick: newLobby }, '+ Новое лобби', h('small', 'ещё один стол с теми же настройками')) : null,
  );
  const actions = h('div.panel');
  if (me.kicked) actions.append(h('div.hint', 'Хост удалил вас из этой игры.'));
  else if (me.seated) actions.append(h('button.btn', { onclick: () => send({ t: 'leave' }) }, 'Встать'));
  else if (seated.length >= 2) actions.append(h('div.hint', 'Оба места заняты — вы можете смотреть партию.'));
  else actions.append(h('button.btn.primary.lg', { onclick: () => { haptic.tap(); send({ t: 'sit' }); } }, 'Сесть за стол'));
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

function head(sub = null) {
  const s = state;
  const m = s.match;
  return h(`div.ch-head${reactOn(s) ? '.rx' : ''}`,
    s.hub ? h('button.k-icon-btn', { 'aria-label': s.solo ? 'Игры с ботами' : 'Все игры группы', onclick: () => send({ t: 'hub' }, { lock: false }) }, backIcon()) : h('span.ch-head-gap'),
    h('div.ch-title', `Морской бой · ${s.room.control}`, h('small', sub || `Партия ${m.no}${s.room.title ? ' · ' + s.room.title : ''}`)),
    reactSlot(s, h('button.k-icon-btn', { 'aria-label': 'Меню', onclick: openMenu }, dotsIcon())));
}

function renderTable() {
  const s = state;
  const m = s.match;
  if (!m) return $app.append(h('div.boot', h('div', 'Ждём начала партии…')));
  if (m.phase === 'place' && !m.over) return renderPlace();
  return renderBattle();
}

const playerOf = (side) => state.players.find((p) => p.side === side) || null;
const afloat = (board) => Object.values(board.left).reduce((a, n) => a + n, 0);

/** Часы стороны: идут — отсчётом; стоят — банком; без часов — пусто (место держим). */
function clockEl(side, running) {
  const c = state.match.clock;
  if (!c.timed && !(running && c.first)) return h('div.ch-clock.off', { 'aria-hidden': 'true' }, '');
  if (running && c.deadline) {
    return h('div.ch-clock.run.num', { 'data-count': c.deadline, 'data-prefix': c.first ? '⏱ ' : '' }, `${c.first ? '⏱ ' : ''}${clock(c.left)}`);
  }
  return h(`div.ch-clock.num${running ? '.run' : ''}`, clock(c.bank[side]));
}

/** Плашка игрока: кто, сколько кораблей на плаву, часы. */
function playerBar(side, { extra = null } = {}) {
  const m = state.match;
  const p = playerOf(side);
  const turn = !m.over && m.turn === side;
  const b = m.boards[side];
  return h(`div.ch-bar${turn ? '.turn' : ''}${p && !p.seated ? '.away' : ''}`, { 'data-side': String(side) },
    p ? avatar(p.name, p.hue, 'sm') : h('div.av.sm', '?'),
    h('div.ch-who',
      h('div.ch-name', p ? p.name : '—', p?.isMe ? h('small', ' · вы') : null),
      h('div.ch-eaten.bs-meta', h('span.num', extra || `на плаву ${afloat(b)} из 10`))),
    clockEl(side, turn));
}

/**
 * Поле. `marks` — отметки выстрелов, `around` — пусто около потопленных,
 * `ships` — корабли (свои, потопленные чужие, в конце — все), `mode`:
 *   'aim'   — поле соперника в бою: клетки — кнопки, тап выбирает цель;
 *   'place' — своё поле на расстановке: тянуть и поворачивать корабли;
 *   'view'  — только смотреть.
 */
function boardEl({ board, mode, mini = false, spec = false, label, dead = new Set(), shown = false, last = null, preview = null }) {
  const k = known(board);
  const grid = h(`div.bs-grid${mini ? '.mini' : ''}`, { role: 'grid', 'aria-label': label });
  const shipCells = new Map();
  board.ships.forEach((s, i) => cellsOf(s).forEach((c) => shipCells.set(c, i)));
  for (let c = 0; c < N * N; c++) {
    const r = k.marks.get(c);
    const cls = ['bs-cell'];
    if (r) cls.push(r);
    else if (k.around.has(c)) cls.push('around');
    if (shipCells.has(c)) cls.push('deck');
    if (aim === c && mode === 'aim') cls.push('aim');
    if (last === c) cls.push('last');
    if (preview?.cells.has(c)) cls.push(preview.ok ? 'pv' : 'pv-bad');
    const what = r ? RESULT_RU[r] : k.around.has(c) ? 'пусто, рядом потопленный' : shipCells.has(c) ? 'корабль' : mode === 'aim' ? 'не стреляли' : 'вода';
    const attrs = { 'data-c': String(c), 'aria-label': `${addr(c)}, ${what}`, role: 'gridcell' };
    grid.append(mode === 'aim'
      ? h(`button.${cls.join('.')}`, { ...attrs, type: 'button', onclick: () => tapAim(c) })
      : h(`div.${cls.join('.')}`, attrs));
  }
  // Корабли — поверх воды, под отметками: рамка целиком на корабль.
  board.ships.forEach((s, i) => {
    const sunk = dead.has(i);
    const cls = ['bs-ship', s.dir];
    if (sunk) cls.push('sunk');
    else if (shown) cls.push('shown');
    if (mode === 'place' && drag && drag.moved && drag.slot === i) cls.push('lifted');
    grid.append(h(`div.${cls.join('.')}`, { style: { '--x': s.x, '--y': s.y, '--len': s.len }, 'aria-hidden': 'true' }));
  });
  const frame = h(`div.bs-frame${mini ? '.mini' : ''}${spec ? '.spec' : ''}`,
    h('div.bs-corner'),
    h('div.bs-files', LETTERS.map((l) => h('span', l))),
    h('div.bs-ranks', Array.from({ length: N }, (_, i) => h('span.num', String(i + 1)))),
    grid);
  if (mode === 'place') {
    grid.addEventListener('pointerdown', (e) => dragFromBoard(e));
    grid.addEventListener('pointermove', dragMove);
    grid.addEventListener('pointerup', dragEnd);
    grid.addEventListener('pointercancel', dragCancel);
  }
  return frame;
}

/** Номера потопленных кораблей поля: корабль потоплен, если все его клетки — «убил». */
function deadOf(board) {
  const k = known(board);
  const out = new Set();
  board.ships.forEach((s, i) => { if (cellsOf(s).every((c) => k.marks.get(c) === 'sunk')) out.add(i); });
  return out;
}

/* ----------------------------------------------------------- расстановка */

function renderPlace() {
  const s = state;
  const m = s.match;
  const me = m.mySide;
  const foeSub = me == null ? null : `Партия ${m.no} · ${m.boards[1 - me].ready ? 'соперник готов' : 'соперник расставляет'}`;
  const root = h('div.ch.bs.placing', head(foeSub));
  if (me == null) {
    // Зритель: только кто готов. Кораблей нет ни одного — и не будет до конца партии.
    root.append(
      h('div.ch-status', 'Игроки тайно расставляют флот'),
      h('div.bs-ready-list', [0, 1].map((side) => h('div.bs-ready', playerOf(side)?.name ?? '—', h('b', m.boards[side].ready ? ' — готов' : ' — расставляет')))));
    $app.append(root, h('div.panel.note', h('span', 'Вы смотрите партию — флоты никому, кроме хозяев, не видны')));
    return;
  }
  const foe = m.boards[1 - me];
  const locked = m.boards[me].ready;
  const left = m.clock.deadline
    ? h('span.num', { 'data-count': m.clock.deadline, 'data-prefix': '⏱ ' }, `⏱ ${clock(m.clock.left)}`)
    : null;
  if (locked) {
    root.append(
      h('div.ch-status', foe.ready ? 'Флот заперт · соперник готов' : 'Флот заперт · ждём соперника', left ? ' · ' : null, left),
      boardEl({ board: m.boards[me], mode: 'view', label: 'Ваш флот' }),
      h('div.hint.bs-hint', foe.ready ? 'Сейчас начнётся бой.' : 'Бой начнётся, когда соперник нажмёт «Я готов».'));
    const panel = h('div.panel');
    if (s.canAbort) panel.append(h('button.k-btn.k-btn--secondary.k-btn--block', { onclick: confirmAbort }, 'Отменить партию'));
    $app.append(root, panel);
    return;
  }
  // Своё поле — из черновика: что лежит на поле сейчас, а не то, что когда-то прислал сервер.
  const board = { ...m.boards[me], ships: draft.ships.filter(Boolean), shots: [], around: [] };
  const preview = drag?.moved && drag.cand ? { cells: new Set(cellsOf(drag.cand)), ok: drag.ok } : null;
  root.append(
    h('div.ch-status', placedAll() ? 'Все на месте — «Я готов»' : 'Расставьте флот', left ? ' · ' : null, left),
    boardEl({ board, mode: 'place', label: 'Ваше поле: расстановка', preview }),
    trayEl(),
    h('div.hint.bs-hint', 'Тяните корабль на поле; тап — повернуть, с поля — в лоток. Корабли не касаются даже углами.'));
  const panel = h('div.panel',
    h('button.k-btn.k-btn--secondary.k-btn--block', { onclick: () => { haptic.tap(); pick = null; send({ t: 'random' }); } }, 'Случайно'),
    h('button.k-btn.k-btn--secondary.k-btn--block', { disabled: !draft.ships.some(Boolean), onclick: clearDraft }, 'Очистить'),
    h('button.k-btn.k-btn--primary.k-btn--block', { disabled: !placedAll(), onclick: sendReady }, 'Я готов'));
  if (net.busy) panel.classList.add('busy');
  $app.append(root, panel);
}

/** Лоток: по кнопке на размер — рисунок корабля и сколько ещё не поставлено. */
function trayEl() {
  const tray = h('div.bs-tray', { role: 'group', 'aria-label': 'Корабли, которые ещё не на поле' });
  for (const len of [4, 3, 2, 1]) {
    const slots = FLEET.map((l, i) => (l === len && !draft.ships[i] ? i : -1)).filter((i) => i >= 0);
    const btn = h(`button.bs-tray-ship${pick === len ? '.on' : ''}${slots.length ? '' : '.done'}`, {
      type: 'button',
      'data-len': String(len),
      disabled: !slots.length,
      'aria-label': `${DECKS_RU[len]}, осталось ${slots.length}`,
      'aria-pressed': pick === len ? 'true' : 'false',
      onclick: (e) => {
        // Клик, которым кончилось перетаскивание этого корабля, — не выбор.
        if (e.currentTarget.dataset.dragged) return void delete e.currentTarget.dataset.dragged;
        pick = pick === len ? null : len;
        haptic.tap();
        bus.render();
      },
    }, h('span.bs-shape', Array.from({ length: len }, () => h('i'))), h('span.num', `×${slots.length}`));
    btn.addEventListener('pointerdown', (e) => dragFromTray(e, len));
    btn.addEventListener('pointermove', dragMove);
    btn.addEventListener('pointerup', dragEnd);
    btn.addEventListener('pointercancel', dragCancel);
    tray.append(btn);
  }
  return tray;
}

function clearDraft() {
  haptic.tap();
  draft.ships = FLEET.map(() => null);
  pick = null;
  bus.render();
}

function sendReady() {
  if (!placedAll()) return;
  haptic.tap();
  // Флот — целиком, проверяет сервер; «готов» — следом, тем же порядком.
  send({ t: 'place', ships: draft.ships.map((s) => ({ x: s.x, y: s.y, len: s.len, dir: s.dir })) });
  send({ t: 'ready' });
}

/** Клетка поля под пальцем (или null, если палец не над полем). */
function cellAt(x, y) {
  const grid = document.querySelector('.bs-grid:not(.mini)');
  if (!grid) return null;
  const r = grid.getBoundingClientRect();
  if (x < r.left || y < r.top || x >= r.right || y >= r.bottom) return null;
  const cx = Math.min(N - 1, Math.floor(((x - r.left) / r.width) * N));
  const cy = Math.min(N - 1, Math.floor(((y - r.top) / r.height) * N));
  return cy * N + cx;
}

/** Тап по клетке на расстановке: по кораблю — повернуть; по воде — поставить выбранный в лотке. */
function tapPlace(c) {
  const slot = draft.ships.findIndex((s) => s && cellsOf(s).includes(c));
  if (slot >= 0) return rotate(slot);
  if (pick == null) return toast('Выберите корабль в лотке — или перетащите его на поле', 2400);
  const free = FLEET.findIndex((l, i) => l === pick && !draft.ships[i]);
  if (free < 0) return;
  const at = { x: xOf(c), y: yOf(c), len: pick };
  const s = [{ ...at, dir: 'h' }, { ...at, dir: 'v' }].find((x) => fits(x, free));
  if (!s) return toast('Сюда не встанет: край поля или соседний корабль', 2400);
  draft.ships[free] = s;
  haptic.tap();
  if (!FLEET.some((l, i) => l === pick && !draft.ships[i])) pick = null;
  bus.render();
}

function rotate(slot) {
  const s = draft.ships[slot];
  if (s.len === 1) return;
  const r = { ...s, dir: s.dir === 'h' ? 'v' : 'h' };
  if (!fits(r, slot)) return toast('Повернуть не выходит: мешает край поля или соседний корабль', 2400);
  draft.ships[slot] = r;
  haptic.tap();
  bus.render();
}

const DRAG_PX = 6;
function dragFromBoard(e) {
  if (e.button > 0 || drag) return;
  const c = cellAt(e.clientX, e.clientY);
  if (c == null) return;
  const slot = draft.ships.findIndex((s) => s && cellsOf(s).includes(c));
  if (slot < 0) {
    drag = { tapOnly: c, id: e.pointerId, x0: e.clientX, y0: e.clientY };
    return;
  }
  const s = draft.ships[slot];
  const grab = cellsOf(s).indexOf(c);
  drag = { slot, len: s.len, dir: s.dir, grab, from: s, id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, cand: null, ok: false, el: e.currentTarget };
}
function dragFromTray(e, len) {
  if (e.button > 0 || drag) return;
  const slot = FLEET.findIndex((l, i) => l === len && !draft.ships[i]);
  if (slot < 0) return;
  drag = { slot, len, dir: 'h', grab: 0, from: null, id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, cand: null, ok: false, el: e.currentTarget };
}
function dragMove(e) {
  const d = drag;
  if (!d || e.pointerId !== d.id || d.tapOnly != null) return;
  if (!d.moved) {
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_PX) return;
    d.moved = true;
    d.el.setPointerCapture?.(e.pointerId);
    haptic.soft();
  }
  const c = cellAt(e.clientX, e.clientY);
  let cand = null;
  if (c != null) {
    const x = xOf(c) - (d.dir === 'h' ? d.grab : 0);
    const y = yOf(c) - (d.dir === 'v' ? d.grab : 0);
    cand = clampShip({ x, y, len: d.len, dir: d.dir });
  }
  const key = cand ? shipKey([cand]) : '';
  if (key === (d.cand ? shipKey([d.cand]) : '')) return;
  d.cand = cand;
  d.ok = !!cand && fits(cand, d.slot);
  paintPreview();
}
/** Подсветка «куда встанет» — без перерисовки всего экрана: палец не должен терять корабль. */
function paintPreview() {
  const d = drag;
  const cells = d?.cand ? new Set(cellsOf(d.cand)) : new Set();
  for (const el of document.querySelectorAll('.bs-grid:not(.mini) .bs-cell')) {
    const c = Number(el.dataset.c);
    el.classList.toggle('pv', cells.has(c) && d.ok);
    el.classList.toggle('pv-bad', cells.has(c) && !d.ok);
  }
  if (d?.from) {
    const i = d.slot;
    document.querySelectorAll('.bs-grid:not(.mini) .bs-ship')[draft.ships.filter(Boolean).indexOf(draft.ships[i])]?.classList.add('lifted');
  }
}
function dragEnd(e) {
  const d = drag;
  if (!d || e.pointerId !== d.id) return;
  drag = null;
  if (d.tapOnly != null) {
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_PX * 2) tapPlace(d.tapOnly);
    return;
  }
  if (!d.moved) {
    // Не тащили — это тап. По кораблю на поле — повернуть; по лотку — выбрать (сделает onclick).
    if (d.from) tapPlace(cellsOf(d.from)[d.grab]);
    return;
  }
  if (!d.from) d.el.dataset.dragged = '1';
  if (!d.cand) {
    // Утащили с поля — корабль вернулся в лоток.
    if (d.from) draft.ships[d.slot] = null;
  } else if (d.ok) {
    draft.ships[d.slot] = d.cand;
    haptic.tap();
  } else {
    haptic.err();
    toast('Так нельзя: корабли не касаются даже углами', 2400);
  }
  bus.render();
}
function dragCancel(e) {
  if (!drag || e.pointerId !== drag.id) return;
  drag = null;
  bus.render();
}

/* -------------------------------------------------------------------- бой */

function renderBattle() {
  const s = state;
  const m = s.match;
  const me = m.mySide;
  const root = h('div.ch.bs', head());
  const lastShot = m.log.at(-1) || null;
  if (me == null) {
    // Зритель: два поля одно под другим, только отметки выстрелов (корабли — лишь в конце партии).
    root.classList.add('watch');
    root.append(
      h('div.bs-pair', [0, 1].map((side) => h('div.bs-col',
        playerBar(side),
        boardEl({ board: m.boards[side], mode: 'view', spec: true, label: `Поле ${playerOf(side)?.name ?? ''}`, dead: deadOf(m.boards[side]), shown: !!m.over, last: lastShot && lastShot.by !== side ? lastShot.c : null })))),
      statusEl());
    $app.append(root, m.over ? overPanel() : h('div.panel.note', h('span', 'Вы смотрите партию — стреляют ', h('b', 'двое'))));
    return;
  }
  const foe = 1 - me;
  const foeBoard = m.boards[foe];
  const myBoard = m.boards[me];
  root.append(
    playerBar(foe),
    boardEl({
      board: foeBoard, mode: m.over ? 'view' : 'aim', label: 'Поле соперника', dead: deadOf(foeBoard), shown: !!m.over,
      last: lastShot && lastShot.by === me ? lastShot.c : null,
    }),
    h('div.bs-status', statusEl()),
    h('div.bs-row',
      h('div.bs-mine',
        boardEl({ board: myBoard, mode: 'view', mini: true, label: 'Ваш флот', dead: deadOf(myBoard), last: lastShot && lastShot.by === foe ? lastShot.c : null }),
        h('div.bs-caption', 'Ваш флот', h('span.num', ` · ${afloat(myBoard)}/10`))),
      m.over ? resultEl() : aimEl()));
  $app.append(root);
  if (m.over) $app.append(overPanel());
}

/** Прицел: адрес выбранной клетки крупно, «Огонь», свои часы. */
function aimEl() {
  const s = state;
  const m = s.match;
  const mine = myTurn(s);
  return h('div.bs-aim',
    h('div.bs-aim-head', h('span', 'Ваши часы'), clockEl(m.mySide, m.turn === m.mySide)),
    h('div.bs-addr.num', { 'aria-live': 'polite', 'aria-label': aim == null ? 'цель не выбрана' : `цель ${addr(aim)}` }, aim == null ? '—' : addr(aim)),
    h('button.k-btn.k-btn--primary.k-btn--block.bs-fire', { disabled: !mine || aim == null, onclick: fire }, 'Огонь'));
}

function resultEl() {
  const m = state.match;
  const o = m.over;
  const won = o.kind !== 'aborted' && o.winner === m.mySide;
  return h(`div.bs-aim.bs-result${won ? '.won' : ''}`,
    h('div.bs-addr', o.kind === 'aborted' ? 'Отменена' : won ? 'Победа' : 'Поражение'),
    h('div.hint', o.kind === 'aborted' ? 'Не засчитывается. Оба флота открыты.' : 'Оба флота открыты — живые корабли соперника пунктиром.'));
}

function statusEl() {
  const s = state;
  const m = s.match;
  const me = m.mySide;
  const last = m.log.at(-1);
  const name = (side) => playerOf(side)?.name ?? '—';
  if (m.over) {
    const o = m.over;
    const text = o.kind === 'aborted' ? 'Партия отменена'
      : me == null ? `Победил ${name(o.winner)} — ${o.why}`
      : `${o.winner === me ? 'Вы выиграли' : 'Вы проиграли'} — ${o.why}`;
    return h(`div.ch-status.over${me != null && o.winner === me ? '.won' : ''}`, text);
  }
  const lastText = last ? `${addr(last.c)} — ${RESULT_RU[last.r]}` : '';
  if (me == null) return h('div.ch-status', `Стреляет ${name(m.turn)}${last ? ` · ${name(last.by)}: ${lastText}` : ''}`);
  if (myTurn(s)) {
    const again = last && last.by === me && last.r !== 'miss' ? `${RESULT_RU[last.r][0].toUpperCase()}${RESULT_RU[last.r].slice(1)}! Стреляйте ещё · ` : '';
    return h('div.ch-status.mine', again, aim == null ? 'Выберите клетку на поле соперника' : `Цель ${addr(aim)} — жмите «Огонь»`);
  }
  return h('div.ch-status', `Стреляет соперник${last && last.by !== me ? ` · ${lastText}` : ''}`);
}

function tapAim(c) {
  if (net.busy) return;
  if (!myTurn(state)) return toast('Сейчас стреляет соперник', 1800);
  if (isKnownEnemy(c)) return toast(state.match.boards[1 - state.match.mySide].around.includes(c) ? 'Рядом с потопленным кораблей не бывает' : 'Сюда вы уже стреляли', 1800);
  aim = aim === c ? null : c;
  haptic.tap();
  bus.render();
}

function fire() {
  if (aim == null || net.busy || !myTurn(state)) return;
  haptic.tap();
  const cell = aim;
  aim = null;
  send({ t: 'fire', cell, shot: state.match.shots });
}

function overPanel() {
  const s = state;
  const panel = h('div.panel');
  if (s.canNext) panel.append(h('button.k-btn.k-btn--primary.k-btn--block', { onclick: () => { haptic.tap(); send({ t: 'next' }); } }, '▶ Ещё партия'));
  if (s.canShare) panel.append(h('button.k-btn.k-btn--secondary.k-btn--block', { onclick: shareResult }, 'Поделиться'));
  if (s.me.isHost || s.me.seated) panel.append(h('button.k-btn.k-btn--secondary.k-btn--block', { onclick: confirmFinish }, 'Завершить'));
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
    h('div', h('h1', '🏁 Итоги'), h('div.sub', `Морской бой · партий сыграно: ${s.history}`)),
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
    if (live && s.canAbort) item('Отменить партию', 'пока каждый не выстрелил — без результата', confirmAbort, 'danger');
    if (live && s.canResign) item('Сдаться', 'партия засчитается как поражение', confirmResign, 'danger');
    if (me.seated && !live) item('Встать из-за стола', 'место освободится', () => { closeSheet(); send({ t: 'leave' }); });
    else if (!me.seated && !me.kicked && s.players.filter((p) => p.seated).length < 2) item('Сесть за стол', 'со следующей партии', () => { closeSheet(); send({ t: 'sit' }); });
    if (!me.notify && s.bot) item('🔔 Напоминать о ходе', 'нажмите Start у бота', () => tg.openTelegramLink(`https://t.me/${s.bot}?start=notify`));
    item('Правила и часы', s.room.control, openRules);
    if (me.isHost) {
      items.push(h('div.section-label', 'Хост'));
    items.push(reactMenuItem(s));
      if (!live) item('Настройки', 'часы', openSettings);
      item('Передать права хоста', null, () => openPlayers('host'));
      item('Удалить игрока', live ? 'партия отменится' : null, () => openPlayers('kick'));
      if (s.room.status !== 'lobby') item('Завершить игру', 'итоги — всем и в группу', confirmFinish, 'danger');
    }
    return h('div', h('h3', 'Меню'), h('div.sub', `🚢 Морской бой · ${s.room.control}`), h('div.menu-list', items));
  });
}

function openRules() {
  showSheet('rules', () => h('div',
    h('h3', 'Правила и часы'),
    h('div.rules',
      h('p', 'Поле 10×10: буквы А…К слева направо, числа 1…10 сверху вниз. Флот: один четырёхпалубный, два трёхпалубных, три двухпалубных, четыре однопалубных. Корабли не касаются друг друга, даже углами.'),
      h('p', 'Расстановка — тайная и проверяется сервером; на неё 2 минуты. Не успели — сервер поставит флот за вас. Кто стреляет первым — жребий.'),
      h('p', 'Выстрел — в два шага: выберите клетку, потом «Огонь». Попали — стреляете ещё; мимо — ход соперника. Потопленный корабль открывается целиком, клетки вокруг него отмечаются пустыми.'),
      h('p', 'Мимо — точка; рядом с потопленным — точка поменьше; ранил — крест на светлой клетке; убил — тёмная клетка со светлым крестом и рамка вокруг корабля.'),
      h('p', 'Кто первым потопил весь флот соперника — выиграл; ничьей нет. Первый выстрел — за минуту; дальше часы партии, прибавка — когда ход переходит. Упал флажок — проигрыш.'),
      h('p', 'Чужого флота до конца партии не видно никому: ни сопернику, ни зрителям. В конце открываются оба.')),
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
      h('button.btn.primary.wide.lg', { style: { marginTop: '16px', width: '100%' }, onclick: () => {
        send({ t: 'settings', base: st.base, inc: st.inc });
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
    h('div.sub', 'Пока каждый не выстрелил, партию можно отменить: результата и рейтинга не будет.'),
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
        : h('div.hint', 'Кроме вас, за столом никого нет.'),
    );
  });
}

/** Что спрашивают при создании стола. */
export const lobby = {
  defaults: { base: 600, inc: 0 },
  fields: (st, { seg, h: hh }) => [
    hh('div.section-label', 'Время на партию, минут'),
    seg(BASES, 'base'),
    st.base ? hh('div.section-label', 'Прибавка за ход') : null,
    st.base ? seg(INCS, 'inc') : null,
    hh('div.hint', { style: { marginTop: '6px' } }, 'Морской бой на двоих. Флот каждый расставляет тайно, кто стреляет первым — решит жребий.'),
  ].filter(Boolean),
};

/** Партия с ботом: часы вместо числа соперников (бот — этап 3). */
export const solo = { duel: true, blurb: 'Морской бой против бота' };

/** Чем игра подписана в хабе: корабль и попадание. */
export const iconCards = ['/battleship/ship.svg', '/battleship/hit.svg'];
