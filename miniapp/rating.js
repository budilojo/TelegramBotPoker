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
import { $app, h, fmt, haptic, showSheet, closeSheet } from './ui.js';
import { bus, send } from './net.js';

let state = null;

export function onState(s) {
  state = s;
  bus.render();
}

const MEDAL = ['🥇', '🥈', '🥉'];
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const games = (n) => `${fmt(n)} ${plural(n, 'партия', 'партии', 'партий')}`;
const when = (at) => new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

export function render() {
  const s = state;
  const chip = (text, on, onclick) => h(`button.rt-chip${on ? '.on' : ''}`, { onclick }, text);

  const box = h('div.lobby.rating',
    h('button.back-link', { onclick: () => send({ t: 'back' }, { lock: false }) }, '← Назад'),
    h('div', h('h1', '🏆 Рейтинг'), h('div.sub', 'Партия кончилась — след остался')),

    h('div.rt-chips', s.games.map((g) => chip(`${g.icon} ${g.title}`, g.id === s.game,
      () => { haptic.tap(); send({ t: 'pick', game: g.id }); }))),
    h('div.rt-chips.small',
      chip('За месяц', s.period === 'month', () => { haptic.tap(); send({ t: 'pick', period: 'month' }); }),
      chip('За всё время', s.period === 'all', () => { haptic.tap(); send({ t: 'pick', period: 'all' }); })),

    s.top.length
      ? h('div.rt-list', s.top.map(row))
      : h('div.hint', s.period === 'month'
        ? 'В этом месяце ещё не играли. Первая же доигранная партия попадёт сюда.'
        : 'Здесь пока пусто. Сыграйте партию до конца — и она появится.'),

    h('div.hint.rt-why', `Очки за место: вышел первым +20, вторым +12, третьим +6, остался дураком −10. `
      + `Ниже нуля не падает. Считаются только доигранные партии, и не больше ${s.perDay} в сутки с одним и тем же составом.`),
  );

  // Своя строка — отдельной плашкой снизу, но только если в списке её не
  // видно: дублировать её на экране незачем, а вот пропасть она не должна.
  const me = s.top.some((r) => r.me) ? null : s.mine;
  const panel = me
    ? h('div.panel.rt-me',
      h('button.rt-row.me.wide', { onclick: () => openWho(me.userId) },
        h('div.rt-place', me.place ? `${me.place}` : '—'),
        h('div.rt-body',
          h('div.rt-name', me.name, h('span.rt-you', ' — вы')),
          h('div.rt-sub', me.place ? `${me.place}-е из ${fmt(me.total)} · ${games(me.played)}` : 'в этом месяце ещё не играли')),
        h('div.rt-points.num', fmt(me.points))))
    : s.mine
      ? null
      : h('div.panel', h('div.hint', 'Вы ещё не сыграли ни одной партии в этой игре.'));

  $app.append(box, ...(panel ? [panel] : []));
  if (s.who) showWho(s.who);
  else if (!s.who && shown) closeSheet();
}

function row(r) {
  return h(`button.rt-row${r.me ? '.me' : ''}`, { onclick: () => openWho(r.userId) },
    h('div.rt-place', r.place <= 3 ? MEDAL[r.place - 1] : `${r.place}`),
    h('div.rt-body',
      h('div.rt-name', r.name, r.me ? h('span.rt-you', ' — вы') : null),
      h('div.rt-sub', `${games(r.played)}${r.wins ? ` · побед ${fmt(r.wins)}` : ''}${r.fools ? ` · дурак ${fmt(r.fools)}` : ''}`)),
    h('div.rt-points.num', fmt(r.points)));
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
