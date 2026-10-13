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
  tg, $app, h, haptic, toast, showSheet, closeSheet, refreshSheet, avatar, animateOnce,
} from '../ui.js';
import { net, bus, send } from '../net.js';

let state = null;
let prev = null;
/** Выбранная клетка со своей фигурой, или null. */
let sel = null;

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

/* ------------------------------------------------------------------ state */

/** Ждёт ли партия меня? */
const myMove = (s) => !!s?.legal?.myTurn;

export function onState(s, p) {
  state = s;
  prev = p;
  // Выбор живёт ровно до смены позиции или очереди: чужой ход его снимает.
  if (sel && (!myMove(s) || s.match?.plies !== p?.match?.plies || s.match?.no !== p?.match?.no)) sel = null;

  if (myMove(s) && !(p && myMove(p))) haptic.turn();
  // Итог и предложение ничьей уже написаны на самом экране — второй раз тостом не нужно,
  // он к тому же закрывает плашку соперника.
  const said = !!s.match?.over || s.canAnswerDraw || s.match?.drawOffer?.mine;
  if (s.room.notice && s.room.notice !== p?.room?.notice && !said) toast(s.room.notice, 3200);
  // Партия закончилась на глазах: победа и поражение — пальцем, а не словом.
  const over = s.match?.over;
  if (over && !(p?.match?.over && p.match.no === s.match.no) && s.me.color) {
    setTimeout(over.winner == null ? haptic.soft : over.winner === s.me.color ? haptic.win : haptic.err, 300);
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
  ? h('button.back-link', { onclick: () => send({ t: 'hub' }, { lock: false }) }, '← Все игры группы')
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
      s.hub ? h('button.k-icon-btn', { 'aria-label': 'Все игры группы', onclick: () => send({ t: 'hub' }, { lock: false }) }, backIcon()) : h('span.ch-head-gap'),
      h('div.ch-title', `Шахматы · ${s.room.control}`, h('small', `Партия ${m.no}${s.room.title ? ' · ' + s.room.title : ''}`)),
      h('button.k-icon-btn', { 'aria-label': 'Меню', onclick: openMenu }, dotsIcon())),
    playerBar(top),
    h('div.ch-board-wrap', boardEl(bottom)),
    playerBar(bottom),
    statusEl(),
    movesEl(),
  );
  const actions = actionsEl();
  $app.append(root, actions);
  const strip = root.querySelector('.ch-moves');
  if (strip) strip.scrollTop = strip.scrollHeight; // свежие ходы — внизу
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
  const m = s.match;
  const flip = bottom === 'b';
  const L = s.legal;
  const targets = sel && L.myTurn ? new Set(L.to[sel] || []) : new Set();
  const board = h(`div.ch-board${flip ? '.flip' : ''}`, { role: 'grid', 'aria-label': 'Шахматная доска' });
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const rank = flip ? r : 7 - r;
      const file = flip ? 7 - f : f;
      const name = sqOf(file, rank);
      const piece = m.board[rank * 8 + file];
      const dark = (file + rank) % 2 === 0;
      const cls = ['ch-sq', dark ? 'dark' : 'light'];
      if (m.last && (m.last.from === name || m.last.to === name)) cls.push('last');
      if (m.check === name) cls.push('check');
      if (sel === name) cls.push('sel');
      if (targets.has(name)) cls.push(piece ? 'cap' : 'dot');
      const label = `${name}${piece ? `, ${isMineColor(piece, 'w') ? 'белая' : 'чёрная'} ${PIECE_RU[piece.toLowerCase()]}` : ''}`;
      const cell = h(`button.${cls.join('.')}`, { type: 'button', 'aria-label': label, 'data-sq': name, onclick: () => tapSquare(name) },
        piece ? img(code(piece)) : null,
        // Координаты — только по краям и мелко: это подсказка, а не разметка.
        f === 0 ? h('i.ch-rank', String(rank + 1)) : null,
        r === 7 ? h('i.ch-file', FILES[file]) : null);
      board.append(cell);
    }
  }
  return board;
}

function tapSquare(name) {
  const s = state;
  if (net.busy) return; // ответ на прошлый ход ещё не пришёл
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
  if (s.canAnswerDraw) {
    return h('div.ch-status.offer',
      h('span', 'Соперник предлагает ничью'),
      h('div.ch-offer-btns',
        h('button.k-btn.k-btn--primary.k-btn--compact', { onclick: () => { haptic.tap(); send({ t: 'draw' }); } }, 'Принять'),
        h('button.k-btn.k-btn--secondary.k-btn--compact', { onclick: () => send({ t: 'decline' }) }, 'Отклонить')));
  }
  if (m.drawOffer?.mine) return h('div.ch-status', 'Вы предложили ничью — ждём ответа');
  const first = m.clock.first;
  if (myMove(s)) return h('div.ch-status.mine', m.check ? 'Шах! Ваш ход' : first && m.plies < 2 ? 'Ваш ход — походите, пока соперник не ушёл' : 'Ваш ход');
  if (!me) return h('div.ch-status', `Ходят ${COLOR_RU[m.turn]}${m.check ? ' — шах' : ''}`);
  return h('div.ch-status', m.check ? 'Вам поставили шах — ждите ход соперника' : 'Ход соперника');
}

/** Запись партии: «1. e4 e5 2. Nf3», последний ход выделен. */
function movesEl() {
  const m = state.match;
  if (!m.moves.length) return h('div.ch-moves.empty', 'Ходов ещё нет');
  const out = [];
  m.moves.forEach((san, i) => {
    if (i % 2 === 0) out.push(h('span.ch-n', `${i / 2 + 1}.`));
    out.push(h(`span.ch-mv${i === m.moves.length - 1 ? '.last' : ''}`, san));
  });
  return h('div.ch-moves', { 'aria-label': 'Записанные ходы' }, ...out);
}

function actionsEl() {
  const s = state;
  const m = s.match;
  const panel = h('div.panel');
  if (m.over) {
    if (s.canNext) panel.append(h('button.k-btn.k-btn--primary.k-btn--block', { onclick: () => { haptic.tap(); send({ t: 'next' }); } }, '▶ Ещё партия'));
    if (s.me.isHost || s.me.seated) panel.append(h('button.k-btn.k-btn--secondary.k-btn--block', { onclick: confirmFinish }, 'Завершить игру'));
    return panel;
  }
  if (!s.me.color) {
    panel.classList.add('note');
    panel.append(h('span', 'Вы смотрите партию — ходят ', h('b', 'двое')));
    return panel;
  }
  if (s.canAbort) panel.append(h('button.k-btn.k-btn--secondary.k-btn--block', { onclick: confirmAbort }, 'Отменить партию'));
  panel.append(
    h('button.k-btn.k-btn--secondary.k-btn--block', { disabled: !s.canOfferDraw, onclick: () => { haptic.tap(); send({ t: 'draw' }); } }, 'Ничья'),
    h('button.k-btn.k-btn--secondary.k-btn--block', { disabled: !s.canResign, onclick: confirmResign }, 'Сдаться'));
  if (net.busy) panel.classList.add('busy');
  return panel;
}

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
  $app.append(box, h('div.panel', h('button.btn.primary.wide.lg', { onclick: () => tg.close() }, 'Закрыть')));
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
    if (s.hub) item('← Все игры группы', 'партия останется, как есть', () => { closeSheet(); send({ t: 'hub' }, { lock: false }); });
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

/** Чем игра подписана в хабе: белый конь и чёрный ферзь. */
export const iconCards = ['/chess/wN.svg', '/chess/bQ.svg'];
