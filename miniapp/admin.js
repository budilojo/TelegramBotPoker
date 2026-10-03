/**
 * Пульт владельца: цифры, живые сессии, рассылка, обслуживание.
 *
 * Открывается только тем, чей id стоит в `.env`, — проверяет это сервер, не
 * страница. Здесь нет ни одного имени игрока и ни одной карты: обещание
 * «никто не видит чужих карт» не знает исключений, в том числе для
 * владельца. Игру опознаёт код — им же она и завершается.
 *
 * Всё опасное (завершить игру, завершить все, разослать) спрашивает
 * подтверждение: тап по экрану телефона слишком дешёвый для необратимого.
 */
import { $app, h, fmt, haptic, toast, showSheet, closeSheet, refreshSheet } from './ui.js';
import { bus, send, net } from './net.js';

let state = null;
/** Какая вкладка открыта. Живёт между перерисовками — иначе вкладка «слетала» бы. */
let tab = 'stats';
/** Черновик рассылки: письмо не должно пропадать от того, что пришли новые цифры. */
const draft = { text: '', btnText: '', btnUrl: '', audience: 'all', later: false, at: '' };

export function onState(s) {
  state = s;
  bus.render();
  refreshSheet();
}

const GAME = { poker: '♠️ Покер', durak: '🃏 Дурак' };
const STATUS = { lobby: 'ждут игроков', playing: 'идёт игра', paused: 'пауза' };
const CAST_STATUS = { scheduled: 'запланирована', sending: 'идёт', done: 'ушла', canceled: 'отменена' };

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

const TABS = [
  ['stats', '📊', 'Цифры'],
  ['now', '▶️', 'Сейчас'],
  ['cast', '📣', 'Рассылка'],
  ['tools', '🛠', 'Пульт'],
];

/* ------------------------------------------------------------------ экран */

export function render() {
  const s = state;
  const box = h('div.lobby.admin',
    h('div',
      h('h1', '🛠 Пульт'),
      h('div.sub', s.down.on ? 'Идёт обслуживание — игра стоит' : `Всё работает · ${s.stats.day}`)),
    s.down.on ? downBanner(s) : null,
    h('div.tabs', TABS.map(([id, icon, name]) => h(`button.tab${tab === id ? '.on' : ''}`, {
      onclick: () => { haptic.tap(); tab = id; bus.render(); },
    }, h('span.tab-i', icon), h('span', name)))),
    tab === 'stats' ? statsTab(s) : tab === 'now' ? nowTab(s) : tab === 'cast' ? castTab(s) : toolsTab(s),
  );

  const panel = h('div.panel',
    h('button.btn.primary.wide', { onclick: () => { haptic.tap(); send({ t: 'refresh' }, { lock: false }); } }, 'Обновить'));
  if (net.busy) panel.classList.add('busy');
  $app.append(box, panel);
}

const downBanner = (s) => h('div.down-banner',
  h('div.db-head', '⏸ Обслуживание включено'),
  h('div.db-text', s.down.text || 'Игрокам показан общий текст.'),
  h('button.btn.wide', { onclick: () => setDown(false) }, '▶️ Снять и продолжить игру'));

/* ------------------------------------------------------------- цифры */

function statsTab(s) {
  const p = s.stats.people;
  const g = s.stats.groups;
  const today = s.stats.today;
  const week = s.stats.week;
  const live = s.live;
  // Из вчерашних вернулись сегодня — единственная метрика, по которой видно,
  // игра это на один вечер или на неделю.
  const back = p.yesterday ? Math.round((p.returned / p.yesterday) * 100) : null;

  return h('div',
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
}

/* -------------------------------------------------------- живые сессии */

function nowTab(s) {
  const live = s.live;
  return h('div',
    h('div.tiles',
      tile('игр идёт', live.playing),
      tile('лобби ждут', live.lobbies),
      tile('человек в приложении', live.online),
      tile('групп с играми', live.groups)),
    h('div.section-label', s.sessions.length ? `Открытые сессии: ${fmt(s.sessions.length)}` : 'Открытые сессии'),
    s.sessions.length
      ? h('div.sess-list', s.sessions.map(sessionRow))
      : h('div.hint', 'Сейчас никто не играет.'),
    h('div.hint', 'Имён игроков и карт здесь нет намеренно: игру опознаёт код, а обещание игрокам важнее удобства. ' +
      '«Завершить» закрывает игру как /finish — итоги уйдут в группу.'),
  );
}

const sessionRow = (x) => h(`div.sess.st-${x.status}`,
  h('div.sess-head',
    h('span.sess-game', `${x.icon} ${x.title}`),
    h('span.sess-status', STATUS[x.status] || x.status)),
  h('div.sess-where', x.group || 'группа без названия'),
  h('div.sess-line',
    h('span.num', `${x.seated}/${x.max}`),
    h('span', 'за столом'),
    x.watching ? h('span.sess-dot', '·') : null,
    x.watching ? h('span.num', String(x.watching)) : null,
    x.watching ? h('span', 'смотрят') : null),
  x.detail ? h('div.sess-detail', x.detail) : null,
  h('div.sess-foot',
    h('code.sess-code', x.code),
    h('button.btn.small.danger', { onclick: () => confirmStop(x) }, 'Завершить')));

function confirmStop(x) {
  haptic.tap();
  showSheet('stop', () => h('div',
    h('h3', 'Завершить игру?'),
    h('div.sub', `${x.icon} ${x.title} · ${x.group || 'без названия'} · ${x.seated} за столом`),
    h('div.hint', 'Игроки увидят обычные итоги в группе — как после /finish. Вернуть игру будет нельзя.'),
    h('div.sheet-row',
      h('button.btn.wide', { onclick: () => closeSheet() }, 'Нет'),
      h('button.btn.primary.wide.danger', {
        onclick: () => { closeSheet(); send({ t: 'stop', code: x.code }); },
      }, 'Завершить'))));
}

/* ------------------------------------------------------------ рассылка */

function castTab(s) {
  if (!s.casts) return h('div.hint', 'Рассылка на этом сервере не настроена.');
  const sizes = s.casts.sizes;
  const chosen = sizes[draft.audience] ?? 0;

  const field = (key, label, placeholder, { area = false, type = 'text' } = {}) => {
    const el = h(area ? 'textarea.inp.area' : 'input.inp', {
      placeholder, value: draft[key], ...(area ? { rows: '5' } : { type }),
      oninput: (e) => { draft[key] = e.target.value; },
    });
    return h('label.field', h('span.field-l', label), el);
  };

  return h('div',
    h('div.section-label', 'Кому'),
    h('div.chips', Object.entries(s.casts.audiences).map(([id, what]) => h(`button.chip${draft.audience === id ? '.on' : ''}`, {
      onclick: () => { haptic.tap(); draft.audience = id; bus.render(); },
    }, h('b.num', fmt(sizes[id] ?? 0)), h('span', what)))),

    h('div.section-label', 'Письмо'),
    h('div.box',
      field('text', 'Текст', 'Что рассказать игрокам…', { area: true }),
      field('btnText', 'Кнопка (необязательно)', 'Например: Открыть'),
      field('btnUrl', 'Ссылка кнопки', 'https://…'),
      h('label.check',
        h('input', { type: 'checkbox', checked: draft.later, onchange: (e) => { draft.later = e.target.checked; bus.render(); } }),
        h('span', 'Отправить позже')),
      draft.later
        ? h('label.field', h('span.field-l', 'Когда'), h('input.inp', {
          type: 'datetime-local', value: draft.at, oninput: (e) => { draft.at = e.target.value; },
        }))
        : null),

    h('div.sheet-row.cast-btns',
      h('button.btn.wide', { onclick: () => sendCast({ test: true }) }, 'Сначала себе'),
      h('button.btn.primary.wide', { onclick: () => confirmCast(chosen) }, draft.later ? 'Запланировать' : 'Отправить')),

    h('div.hint', 'В каждом письме — кнопка «🔕 Не присылать такое»: без неё рассылка превращается в спам, ' +
      'из которого один выход — заблокировать бота. Письма уходят 8 в секунду, чтобы Telegram не ограничил бота вместе с игрой. ' +
      'Казино и ставки админка отправить откажется.'),

    castList(s.casts.list),
  );
}

/** Что отправляем на сервер из черновика. Время — в миллисекундах, как везде. */
function castPayload() {
  const at = draft.later && draft.at ? new Date(draft.at).getTime() : 0;
  return { text: draft.text, btnText: draft.btnText, btnUrl: draft.btnUrl, audience: draft.audience, at: Number.isFinite(at) ? at : 0 };
}

function sendCast({ test = false } = {}) {
  haptic.tap();
  if (!draft.text.trim()) return toast('Письмо пустое');
  if (draft.later && !draft.at) return toast('Выберите время отправки');
  send({ t: test ? 'castTest' : 'cast', ...castPayload() });
}

function confirmCast(n) {
  haptic.tap();
  if (!draft.text.trim()) return toast('Письмо пустое');
  showSheet('cast', () => h('div',
    h('h3', draft.later ? 'Запланировать рассылку?' : 'Отправить рассылку?'),
    h('div.sub', `${fmt(n)} ${plural(n, 'человек получит', 'человека получат', 'человек получат')} это письмо`),
    h('div.box.cast-preview', draft.text),
    h('div.hint', 'Отозвать отправленное письмо нельзя. Если ещё не смотрели, как оно выглядит на телефоне, — сначала «Сначала себе».'),
    h('div.sheet-row',
      h('button.btn.wide', { onclick: () => closeSheet() }, 'Отмена'),
      h('button.btn.primary.wide', {
        onclick: () => { closeSheet(); send({ t: 'cast', ...castPayload() }); draft.text = ''; draft.btnText = ''; draft.btnUrl = ''; },
      }, draft.later ? 'Запланировать' : 'Отправить'))));
}

function castList(list) {
  if (!list?.length) return null;
  return h('div',
    h('div.section-label', 'Рассылки'),
    h('div.box', list.map((c) => h(`div.cast-row.cs-${c.status}`,
      h('div.cast-head',
        h('span.cast-when', when(c.at)),
        h('span.cast-status', CAST_STATUS[c.status] || c.status)),
      h('div.cast-text', c.text.length > 90 ? `${c.text.slice(0, 90)}…` : c.text),
      c.status === 'sending' || c.status === 'done' || c.sent
        ? h('div',
          h('div.gr-bar', h('i', { style: { width: `${c.total ? Math.round((c.sent / c.total) * 100) : 0}%` } })),
          h('div.cast-n.num', `${fmt(c.sent)} из ${fmt(c.total)}${c.failed ? ` · не дошло ${fmt(c.failed)}` : ''}`))
        : h('div.cast-n.num', `${fmt(c.total)} ${plural(c.total, 'получатель', 'получателя', 'получателей')}`),
      c.note ? h('div.cast-note', c.note) : null,
      c.status === 'scheduled' || c.status === 'sending'
        ? h('button.btn.small.danger', { onclick: () => { haptic.tap(); send({ t: 'castCancel', id: c.id }); } },
          c.status === 'sending' ? 'Остановить' : 'Отменить')
        : null))));
}

const when = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/* -------------------------------------------------------------- пульт */

function toolsTab(s) {
  // Первый заход берёт текст с сервера, дальше — что набрали: новые цифры не
  // должны стирать недописанную фразу.
  if (downText == null) downText = s.down.text || '';
  const text = h('input.inp', {
    placeholder: 'Что показать игрокам (необязательно)', value: downText,
    oninput: (e) => { downText = e.target.value; },
  });

  return h('div',
    h('div.section-label', 'Обслуживание'),
    h('div.box',
      h('div.tool-head', s.down.on ? '⏸ Сейчас включено' : '▶️ Сейчас выключено'),
      h('div.hint', 'Игра замирает целиком: ни одного хода, ни одной новой игры. Время на ход не тратится — ' +
        'включили на десять минут, у игрока осталось столько же, сколько было. Столы не закрываются: снимете — партия продолжится.'),
      h('label.field', h('span.field-l', 'Текст для игроков'), text),
      s.down.on
        ? h('button.btn.primary.wide', { onclick: () => setDown(false) }, '▶️ Снять обслуживание')
        : h('button.btn.primary.wide.danger', { onclick: () => confirmDown() }, '⏸ Остановить всё')),

    h('div.section-label', 'Завершить все игры'),
    h('div.box',
      h('div.hint', 'Все живые игры закроются с итогами в группы — как будто каждый хост нажал «Завершить». ' +
        'Это для «выключаю сервер надолго»: честные итоги лучше стола, который никогда не оживёт.'),
      h('button.btn.wide.danger', { onclick: () => confirmStopAll(s) },
        `🏁 Завершить все (${fmt(s.live.playing + s.live.lobbies)})`)),

    h('div.section-label', 'Бот'),
    h('div.box',
      h('div.tool-line', h('span', 'Имя бота'), h('b', `@${s.bot || '—'}`)),
      h('div.tool-line', h('span', 'Игр в памяти'), h('b.num', fmt(s.sessions.length))),
      h('div.tool-line', h('span', 'Людей в приложении'), h('b.num', fmt(s.live.online)))),
  );
}

let downText = null;

function confirmDown() {
  haptic.tap();
  showSheet('down', () => h('div',
    h('h3', 'Остановить всё?'),
    h('div.sub', 'Игроки увидят экран «Идёт обслуживание»'),
    h('div.hint', 'Партии не пропадут и время на ход не сгорит. Снять можно этой же кнопкой или командой /resume у админ-бота.'),
    h('div.sheet-row',
      h('button.btn.wide', { onclick: () => closeSheet() }, 'Нет'),
      h('button.btn.primary.wide.danger', { onclick: () => { closeSheet(); setDown(true); } }, 'Остановить'))));
}

function confirmStopAll(s) {
  haptic.tap();
  const n = s.live.playing + s.live.lobbies;
  showSheet('stopAll', () => h('div',
    h('h3', 'Завершить все игры?'),
    h('div.sub', `${fmt(n)} ${plural(n, 'игра закроется', 'игры закроются', 'игр закроется')} с итогами в группы`),
    h('div.hint', 'Отменить это нельзя. Если нужно просто поставить игру на паузу — «Остановить всё» выше.'),
    h('div.sheet-row',
      h('button.btn.wide', { onclick: () => closeSheet() }, 'Нет'),
      h('button.btn.primary.wide.danger', { onclick: () => { closeSheet(); send({ t: 'stopAll' }); } }, 'Завершить все'))));
}

function setDown(on) {
  haptic.tap();
  send({ t: 'maintenance', on, text: downText });
}

/* ---------------------------------------------------------- вспомогательное */

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

/**
 * Живые вкладки: «Сейчас» и идущая рассылка меняются каждую секунду, а
 * состояние админки собирается по запросу. Пять секунд — достаточно часто,
 * чтобы не жать «Обновить», и достаточно редко, чтобы ничего не грузить.
 */
setInterval(() => {
  if (!state || document.hidden) return;
  if (tab === 'now' || state.casts?.sending) send({ t: 'refresh' }, { lock: false });
}, 5000);
