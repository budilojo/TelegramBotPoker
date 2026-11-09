/**
 * Рейтинг: список, своя строка и карточка игрока.
 *
 * Две вещи, ради которых экран устроен именно так:
 *
 *   1. СВОЯ СТРОКА ВИДНА ВСЕГДА. Даже если вы 83-й из 214 — она прилипает
 *      снизу. Без неё это чужая доска почёта, а не ваш рейтинг.
 *   2. ЧИСЛО ОБЪЯСНЕНО. Нажали на себя — видно, из чего оно сложилось:
 *      последние партии, место в каждой и сколько за неё дали.
 *
 * Ни карт, ни ставок, ни того, с кем играли: только места и очки.
 */
import { $app, h, fmt, haptic, initial, showSheet, closeSheet } from './ui.js';
import { bus, send } from './net.js';
import { avatarEl } from './profile.js';

let state = null;
let tablesOn = false;

export function onState(s, prev) {
  state = s;
  if (!prev) {
    tablesOn = !!s.tables;
    if (tablesOn) return askTables(s.game, { quiet: true });
  }
  bus.render();
}

const MEDAL = ['🥇', '🥈', '🥉'];
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const when = (at) => new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

export function render() {
  const s = state;
  if (tablesOn) {
    $app.append(renderRanked(s));
    return;
  }
  const pill = (text, on, onclick) => h(`button.rt-tab${on ? '.on' : ''}`, { onclick }, text);
  const chip = (text, on, onclick) => h(`button.rt-chip${on ? '.on' : ''}`, { onclick }, text);

  const box = h('div.lobby.rating',
    h('button.back-link', { onclick: () => send({ t: 'back' }, { lock: false }) }, '←'),
    h('div.rt-head',
      h('div.rt-head-cup', '🏆'),
      h('div',
        h('h1', 'Рейтинг игроков'),
        h('div.sub', s.scope === 'group'
          ? `Только те, кто играл в${s.groupTitle ? ` «${s.groupTitle}»` : ' этой группе'}`
          : s.publicOnly ? 'Только партии за публичными столами' : 'Кто чего стоит — во всех группах сразу'))),

    s.publicOnly && !s.rankedTablesSoon ? h('button.btn.wide', { onclick: () => {
      tablesOn = true;
      askTables(s.game);
    } }, 'Рейтинговые столы') : null,

    // Где считаем: во всех группах сразу или только в этой. Вкладка «эта
    // группа» есть только у страницы, открытой из группы.
    s.canGroup
      ? h('div.rt-tabs',
        pill('Общий рейтинг', s.scope === 'all', () => { haptic.tap(); send({ t: 'pick', scope: 'all' }); }),
        pill('Эта группа', s.scope === 'group',
          () => { haptic.tap(); send({ t: 'pick', scope: 'group' }); }))
      : null,

    h('div.rt-chips',
      ...s.games.map((g) => chip(g.title, g.id === s.game, () => { haptic.tap(); send({ t: 'pick', game: g.id }); }))),

    h('div.rt-chips',
      chip('За месяц', s.period === 'month', () => { haptic.tap(); send({ t: 'pick', period: 'month' }); }),
      chip('За всё время', s.period === 'all', () => { haptic.tap(); send({ t: 'pick', period: 'all' }); })),

    s.top.length
      ? h('div.rt-list', s.top.map(row))
      : h('div.hint', s.scope === 'group'
        ? 'В этой группе ещё не доигрывали партий. Сыграйте — и список появится.'
        : s.period === 'month'
          ? 'В этом месяце ещё не играли. Первая же доигранная партия попадёт сюда.'
          : 'Здесь пока пусто. Сыграйте партию до конца — и она появится.'),

    h('div.hint.rt-why',
      s.publicOnly ? h('div', 'Партии с друзьями в Telegram-группах проходят вне рейтинга.') : null,
      h('div', 'Места в таблице определяет число зачётных партий. При равенстве выше игрок с большим числом очков.'),
      h('div', 'Очки за место: +20, +12, +6, дальше +3. Если у партии есть проигравший, ему −10. Итог не падает ниже нуля.'),
      h('div', `Считаются доигранные партии, не больше ${s.perDay} в сутки с одним и тем же составом.`)),
  );

  // Своя строка отдельной плашкой снизу — но только если её не видно в
  // списке: дублировать незачем, а пропасть она не должна.
  const me = s.top.some((r) => r.me) ? null : s.mine;
  const panel = me
    ? h('div.panel.rt-me', row({ ...me, me: true, sticky: true }))
    : s.mine ? null : h('div.panel', h('div.hint', 'Вы ещё не сыграли ни одной партии в этой игре.'));

  $app.append(box, ...(panel ? [panel] : []));
  if (s.who) showWho(s.who);
  else if (!s.who && shown) closeSheet();
}

/** Доля побед — то, чем игроки меряются на самом деле. */
const winRate = (r) => (r.played ? `${Math.round((r.wins / r.played) * 100)}%` : '—');
const games = (n) => `${fmt(n)} ${plural(n, 'партия', 'партии', 'партий')}`;
/** Цвет кружка — от имени: у одного человека он всегда один и тот же. */
const hueOf = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.codePointAt(0)) % 360, 7);

function row(r) {
  const place = r.sticky ? (r.place || '—') : r.place;
  return h(`button.rt-row${r.me ? '.me' : ''}`, { onclick: () => openWho(r.userId) },
    h('div.rt-place', r.place <= 3 && !r.sticky ? MEDAL[r.place - 1] : String(place)),
    avatarEl({ name: r.name, hue: hueOf(r.name || r.userId), avatar: r.avatar }, 'rt-av'),
    h('div.rt-body',
      h('div.rt-name', r.name, r.me ? h('span.rt-you', ' — вы') : null),
      h('div.rt-sub', r.sticky && r.total
        ? `${r.place}-е из ${fmt(r.total)} · ${games(r.played)}`
        : `Побед ${winRate(r)}`)),
    h('div.rt-points',
      h('b.num', fmt(r.played)),
      h('small', plural(r.played, 'партия', 'партии', 'партий')),
      h('small', `${fmt(r.points)} очков`)));
}

let shown = null;

function openWho(id) {
  haptic.soft();
  send({ t: 'who', id }, { lock: false });
}

/** Карточка игрока: из чего сложилось его число. */
function showWho(p) {
  shown = p.userId;
  showSheet('who', () => {
    const c = state?.who;
    if (!c) return null;
    return h('div.sheet-box',
      h('div.sheet-title', c.name),
      h('div.rt-big', h('b.num', fmt(c.points)), h('small', c.place ? `${c.place}-е место из ${fmt(c.total)}` : 'пока без места')),
      h('div.rt-stats',
        h('div.rt-stat', h('b.num', fmt(c.played)), h('small', 'партий')),
        h('div.rt-stat', h('b.num', fmt(c.wins)), h('small', 'побед')),
        h('div.rt-stat', h('b.num', fmt(c.fools)), h('small', 'был дураком'))),
      c.last.length
        ? h('div.rt-last', h('div.section-label', 'Последние партии'), c.last.map((x) => h('div.rt-last-row',
          h('span', `${x.place}-е из ${x.of}`),
          h('span.rt-when', when(x.at)),
          h(`b.num.${x.delta > 0 ? 'up' : x.delta < 0 ? 'down' : ''}`, x.sign))))
        : null,
      h('button.btn.wide', { onclick: () => { shown = null; closeSheet(); send({ t: 'who', id: null }, { lock: false }); } }, 'Закрыть'));
  }, {
    // Шторку закрыли свайпом — сказать серверу, чтобы он не присылал её снова.
    onDismiss: () => {
      if (!shown) return;
      shown = null;
      send({ t: 'who', id: null }, { lock: false });
    },
  });
}

/* ------------------------------------------- путь «игра → столы → сесть» */

/**
 * Вкладка «Рейтинг» нижней панели: выбор игры, рейтинговые столы, «Присоединиться».
 *
 * Пока рейтинг закрыт (сервер присылает `ratingSoon`), этого пути нет: ни
 * карточек игр, ни запроса столов, ни кнопки «Присоединиться» — только
 * объяснение. Открыт — берём настоящий список с сервера, и обычных столов в
 * нём нет: сервер отдаёт только те, что сами объявлены рейтинговыми.
 */
let ranked = { game: null, tables: null, loading: false };
let rankedTimer = null;

export function resetRanked({ unsubscribe = false } = {}) {
  if (unsubscribe && ranked.game) send({ t: 'rtables', game: null }, { lock: false });
  tablesOn = false;
  ranked = { game: null, tables: null, loading: false };
  clearTimeout(rankedTimer);
}

export function refreshRanked() {
  if (ranked.game) send({ t: 'rtables', game: ranked.game }, { lock: false });
}

bus.onRanked = (msg) => {
  if (msg.game !== ranked.game) return;
  clearTimeout(rankedTimer);
  ranked = { ...ranked, tables: Array.isArray(msg.tables) ? msg.tables : [], loading: false };
  bus.render();
};

function askTables(game, { quiet = false } = {}) {
  if (!quiet) haptic.soft();
  ranked = { game, tables: null, loading: true };
  clearTimeout(rankedTimer);
  // Ответа нет (отказ или обрыв) — не висеть вечно на «Загружаем…».
  rankedTimer = setTimeout(() => { ranked = { ...ranked, loading: false }; bus.render(); }, 4000);
  send({ t: 'rtables', game }, { lock: false });
  bus.render();
}

export function renderRanked(s) {
  const head = h('div.hub-head', h('h1', 'Рейтинг игроков'), h('div.sub', 'Публичные столы с другими игроками'));
  if (s.ratingSoon) {
    return h('div.lobby.hub.ranked',
      head,
      h('div.set-row.rk-soon',
        h('div.set-body',
          h('div.set-title', 'Пока закрыт', h('span.rt-soon-tag', 'скоро')),
          h('div.set-sub', s.ratingSoon))),
      h('div.hint', 'Публичные столы и таблица лидеров пока закрыты.'));
  }

  const leaderboard = h('button.rt-open', { onclick: () => {
    haptic.tap();
    if (s.kind === 'rating') { resetRanked({ unsubscribe: true }); bus.render(); }
    else send({ t: 'rating', game: ranked.game || undefined }, { lock: false });
  } },
    h('div.rt-cup', '🏆'),
    h('div.rt-open-body', h('div.rt-open-title', 'Таблица лидеров'), h('div.rt-open-sub', 'Места и статистика')),
    h('div.rt-open-go', '›'));
  const games = s.rankGames || s.games || [];
  if (s.rankedTablesSoon) return h('div.lobby.hub.ranked', head, leaderboard,
    h('div.hint', 'Рейтинговые столы пока закрыты.'));
  const sel = ranked.game;
  return h('div.lobby.hub.ranked',
    head,
    leaderboard,
    h('div.section-label', '1. Выберите игру'),
    h('div.rk-games', games.map((g) => h(`button.rt-chip${g.id === sel ? '.on' : ''}`, { 'aria-pressed': g.id === sel ? 'true' : 'false', onclick: () => askTables(g.id) }, g.title))),
    sel ? h('div.section-label', '2. Рейтинговые столы') : null,
    sel ? tablesBlock() : h('div.hint', 'Чтобы сесть за стол, Telegram-группа не нужна.'));
}

function tablesBlock() {
  if (ranked.loading) return h('div.hint', 'Загружаем…');
  if (!ranked.tables) {
    return h('div.hint', 'Не получилось загрузить столы. ', h('button.link', { onclick: () => askTables(ranked.game) }, 'Ещё раз'));
  }
  const tables = ranked.tables;
  const open = h('button.k-btn.k-btn--secondary.k-btn--block', { onclick: () => send({ t: 'rcreate', game: ranked.game }) }, 'Создать стол');
  return h('div.lobby-list',
    tables.length ? null : h('div.hint', 'Свободных столов пока нет. Создайте стол, и его увидят другие игроки.'),
    tables.map(t => h(t.mine ? 'div.lrow.mine' : 'div.lrow',
      h('div.lr-body',
        h('div.lr-title', t.mine ? 'Ваш стол' : t.host ? `Стол · ${t.host}` : 'Стол'),
        h('div.lr-sub', h('b.num', `${t.seated}/${t.max}`), t.detail ? h('span.lr-detail', t.detail) : null)),
      h('button.k-btn.k-btn--primary.k-btn--compact', { onclick: () => { haptic.tap(); send({ t: 'rjoin', code: t.code }); } }, t.mine ? 'Вернуться' : 'Войти'))),
    tables.some(t => t.mine) ? null : open);
}
