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

let state = null;

export function onState(s) {
  state = s;
  bus.render();
}

const MEDAL = ['🥇', '🥈', '🥉'];
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const when = (at) => new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

export function render() {
  const s = state;
  const pill = (text, on, onclick) => h(`button.rt-tab${on ? '.on' : ''}`, { onclick }, text);
  const chip = (text, on, onclick) => h(`button.rt-chip${on ? '.on' : ''}`, { onclick }, text);

  const box = h('div.lobby.rating',
    h('button.back-link', { onclick: () => send({ t: 'back' }, { lock: false }) }, '←'),
    h('div.rt-head',
      h('div.rt-head-cup', '🏆'),
      h('div',
        h('h1', 'Рейтинг игроков'),
        h('div.sub', 'Кто чего стоит — за месяц и за всё время'))),

    h('div.rt-tabs', s.games.map((g) => pill(g.title, g.id === s.game,
      () => { haptic.tap(); send({ t: 'pick', game: g.id }); }))),

    h('div.rt-chips',
      chip('За месяц', s.period === 'month', () => { haptic.tap(); send({ t: 'pick', period: 'month' }); }),
      chip('За всё время', s.period === 'all', () => { haptic.tap(); send({ t: 'pick', period: 'all' }); })),

    s.top.length
      ? h('div.rt-list', s.top.map(row))
      : h('div.hint', s.period === 'month'
        ? 'В этом месяце ещё не играли. Первая же доигранная партия попадёт сюда.'
        : 'Здесь пока пусто. Сыграйте партию до конца — и она появится.'),

    h('div.hint.rt-why',
      h('div', 'Очки за место: первым +20, вторым +12, третьим +6, дураком −10. Ниже нуля не падает.'),
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
    h('div.av.rt-av', { style: { '--h': hueOf(r.name || r.userId) } }, initial(r.name)),
    h('div.rt-body',
      h('div.rt-name', r.name, r.me ? h('span.rt-you', ' — вы') : null),
      h('div.rt-sub', r.sticky && r.total
        ? `${r.place}-е из ${fmt(r.total)} · ${games(r.played)}`
        : `${games(r.played)} · побед ${winRate(r)}`)),
    h('div.rt-points',
      h('b.num', fmt(r.points)),
      h('small', 'очков')));
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
