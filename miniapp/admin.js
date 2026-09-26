/**
 * Админка: цифры по игре. Открывается кнопкой из `/admin` в личке и только
 * тем, чей id стоит в `.env` — проверяет это сервер, не страница.
 *
 * Здесь нет ни одного имени, ни одной карты и ни одного чужого сообщения:
 * только счётчики. Это не бережливость, а то же правило, что и за столом, —
 * приложение не показывает того, чего человеку видеть не положено.
 */
import { $app, h, fmt, haptic, toast } from './ui.js';
import { bus, send, net } from './net.js';

let state = null;

export function onState(s) {
  state = s;
  bus.render();
}

const GAME = { poker: '♠️ Покер', durak: '🃏 Дурак' };
const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

/** Плитка с одним числом и подписью. */
const tile = (label, value, note = null, cls = '') =>
  h(`div.tile${cls ? '.' + cls : ''}`,
    h('div.tile-n.num', typeof value === 'number' ? fmt(value) : value),
    h('div.tile-l', label),
    note ? h('div.tile-note', note) : null);

export function render() {
  const s = state;
  const p = s.stats.people;
  const g = s.stats.groups;
  const today = s.stats.today;
  const week = s.stats.week;
  const live = s.live;

  // Из вчерашних вернулись сегодня — единственная метрика, по которой видно,
  // игра это на один вечер или на неделю.
  const back = p.yesterday ? Math.round((p.returned / p.yesterday) * 100) : null;

  const box = h('div.lobby.admin',
    h('div',
      h('h1', '📊 Цифры'),
      h('div.sub', `Сегодня ${s.stats.day}`)),

    h('div.section-label', 'Сейчас в игре'),
    h('div.tiles',
      tile('человек в приложении', live.online),
      tile('игр идёт', live.playing, Object.entries(live.byGame).map(([k, n]) => `${GAME[k] || k}: ${n}`).join(' · ') || null),
      tile('лобби ждут', live.lobbies),
      tile('групп с играми', live.groups)),

    h('div.section-label', 'Люди'),
    h('div.tiles',
      tile('всего', p.total),
      tile('сегодня', p.today, p.fresh ? `новых: ${fmt(p.fresh)}` : null),
      tile('за неделю', p.week),
      tile('вернулись', back == null ? '—' : `${back}%`,
        p.yesterday ? `${fmt(p.returned)} из ${fmt(p.yesterday)} вчерашних` : 'вчера никого не было',
        back != null && back >= 40 ? 'good' : '')),

    h('div.section-label', 'Партии'),
    h('div.tiles',
      tile('сегодня', today.rounds, `${fmt(today.games)} ${plural(today.games, 'игра', 'игры', 'игр')}`),
      tile('за неделю', week.rounds, `${fmt(week.games)} ${plural(week.games, 'игра', 'игры', 'игр')}`),
      tile('лобби собрано', week.created, 'за неделю'),
      tile('доиграно до итогов', week.finished, 'за неделю')),

    byGameTable(week.byGame),
    chart(s.stats.days, 'rounds', 'Партии по дням', 'rounds'),
    chart(s.stats.days, 'people', 'Люди по дням', 'people'),

    h('div.section-label', 'Группы'),
    h('div.tiles',
      tile('всего', g.total),
      tile('активных за неделю', g.week)),

    h('div.hint', 'Считается обезличенно: только числа. Имён, карт и переписки здесь нет и не будет.'),
  );

  const panel = h('div.panel',
    h('button.btn.primary.wide', { onclick: () => { haptic.tap(); send({ t: 'refresh' }, { lock: false }); } }, 'Обновить'));
  if (net.busy) panel.classList.add('busy');
  $app.append(box, panel);
}

/** Какая игра сколько собрала за неделю — строками, чтобы было видно долю. */
function byGameTable(byGame) {
  const rows = Object.entries(byGame).sort((a, b) => b[1].rounds - a[1].rounds);
  if (!rows.length) return null;
  const max = Math.max(...rows.map(([, v]) => v.rounds));
  return h('div',
    h('div.section-label', 'По играм за неделю'),
    h('div.box', rows.map(([id, v]) => h('div.game-row',
      h('div.gr-head',
        h('span.gr-name', GAME[id] || id),
        h('span.gr-n.num', `${fmt(v.rounds)} · ${fmt(v.games)} ${plural(v.games, 'игра', 'игры', 'игр')}`)),
      h('div.gr-bar', h('i', { style: { width: `${Math.round((v.rounds / max) * 100)}%` } }))))));
}

/**
 * Две недели по дням — по одному графику на величину.
 *
 * Партии и люди НЕ кладутся в одно поле: у них разные шкалы, и общая картинка
 * рисовала бы связь, которой в данных нет. Два графика рядом честнее и
 * читаются так же быстро.
 *
 * По одной величине на график — значит, легенда не нужна: что нарисовано,
 * сказано в заголовке. Подписано только самое большое значение и последний
 * день; тап по столбику говорит остальное.
 */
function chart(days, key, title, cls) {
  if (!days?.length) return null;
  const vals = days.map((d) => d[key]);
  const max = Math.max(1, ...vals);
  const peak = vals.lastIndexOf(max);
  const last = days.length - 1;
  const word = key === 'rounds' ? ['партия', 'партии', 'партий'] : ['человек', 'человека', 'человек'];
  const say = (d) => `${d.day}: ${fmt(d[key])} ${plural(d[key], ...word)}`;

  return h('div',
    h('div.section-label', title),
    h('div.box',
      h(`div.chart.${cls}`, days.map((d, i) => {
        const tall = Math.round((d[key] / max) * 100);
        // Подпись — только у пика и у последнего дня, и только если есть что
        // сказать: число над каждым столбиком читать никто не будет.
        const label = (i === peak || (i === last && i !== peak)) && d[key] ? h('b.num', fmt(d[key])) : null;
        return h('button.bar', {
          title: say(d),
          'aria-label': say(d),
          onclick: () => toast(say(d)),
        }, label, h('i', { style: { height: `${Math.max(d[key] ? 3 : 0, tall)}%` } }));
      })),
      h('div.chart-foot', h('span', days[0].day.slice(5)), h('span', days[last].day.slice(5)))));
}
