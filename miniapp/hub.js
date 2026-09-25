/**
 * The first screen of a group's hub: what to play, and what is already open
 * in this group. Opened by «🎮 Выбрать игру» under /play (`startapp=g_<code>`).
 *
 * Big cards for the games, a short settings sheet, «Создать лобби». The
 * lobby gets its own card in the group, and this page steps into it.
 */
import { $app, h, haptic, showSheet, closeSheet, refreshSheet } from './ui.js';
import { bus, send } from './net.js';

let state = null;

export function onState(s) {
  state = s;
  bus.render();
  refreshSheet();
}

const STATUS = { lobby: 'ждут игроков', playing: 'идёт игра', paused: 'пауза' };

export function render() {
  const s = state;
  const box = h('div.lobby.hub',
    h('div',
      h('h1', '🎮 Во что играем?'),
      h('div.sub', s.group.title || 'Игры этой группы')),
    h('div.game-cards', s.games.map((g) => h(`button.game-card.g-${g.id}`, { onclick: () => openCreate(g) },
      h('div.gc-icon', g.icon),
      h('div.gc-body',
        h('div.gc-title', g.title),
        h('div.gc-blurb', g.blurb),
        h('div.gc-players', `${g.min}–${g.max} игроков`)),
      h('div.gc-go', '→')))),
    h('div.section-label', 'Открытые игры в группе'),
    s.lobbies.length
      ? h('div.lobby-list', s.lobbies.map(lobbyRow))
      : h('div.hint', 'Пока ничего не открыто — выберите игру выше и создайте лобби. Друзья присоединятся по его карточке в группе или отсюда.'),
  );
  $app.append(box);
}

function lobbyRow(l) {
  const join = l.status === 'lobby' && !l.inside;
  return h(`div.lrow${l.mine ? '.mine' : ''}`,
    h('div.lr-icon', l.icon),
    h('div.lr-body',
      h('div.lr-title', l.title, l.host ? h('span.lr-host', ` · ${l.host}`) : null),
      h('div.lr-sub', h('b.num', `${l.seated}/${l.max}`), ` · ${STATUS[l.status] || ''}`, l.detail ? ` · ${l.detail}` : ''),
      l.names.length ? h('div.lr-names', l.names.join(', ')) : null),
    h(`button.btn.sm${join ? '.primary' : ''}`, { onclick: () => { haptic.tap(); send({ t: 'join', code: l.code }); } },
      join ? 'Присоединиться' : 'Открыть'));
}

/* ---------------------------------------------------- «Новое лобби» */

const TIMERS = [[0, 'Выкл'], [30, '30 с'], [60, '60 с'], [90, '90 с']];

function openCreate(g) {
  haptic.soft();
  const st = g.id === 'poker'
    ? { startingStack: 10000, smallBlind: 25, bigBlind: 50, turnSeconds: 0, cards: 'virtual' }
    : { variant: 'podkidnoy', turnSeconds: 0 };

  showSheet('create', () => {
    const seg = (options, key) => h('div.seg', options.map(([v, label]) => h(`button${st[key] === v ? '.on' : ''}`, {
      onclick: () => { st[key] = v; refreshSheet(); },
    }, label)));
    const numField = (label, key) => h('div.field', h('label', label),
      h('input.num', { type: 'number', inputmode: 'numeric', value: st[key], oninput: (e) => (st[key] = Number(e.target.value)) }));

    const fields = g.id === 'poker'
      ? [
          numField('Стартовый стек', 'startingStack'),
          numField('Малый блайнд', 'smallBlind'),
          numField('Большой блайнд', 'bigBlind'),
          h('div.section-label', 'Таймер хода'),
          seg([...TIMERS, [120, '2 мин']], 'turnSeconds'),
          h('div.section-label', 'Карты'),
          seg([['virtual', '🤖 Раздаёт бот'], ['live', '🃏 Настоящие']], 'cards'),
        ]
      : [
          h('div.section-label', 'Вариант'),
          seg([['podkidnoy', 'Подкидной'], ['perevodnoy', 'Переводной']], 'variant'),
          h('div.hint', { style: { marginTop: '6px' } }, st.variant === 'perevodnoy'
            ? 'Пока ни одна карта не побита, отбивающийся может перевести атаку картой того же достоинства на следующего.'
            : 'Подкидывают все, кроме отбивающегося, — карты тех достоинств, что уже на столе.'),
          h('div.section-label', 'Таймер хода'),
          seg(TIMERS, 'turnSeconds'),
          h('div.hint', { style: { marginTop: '6px' } }, 'Не успел: отбивающийся берёт, подкидывающие пасуют.'),
        ];

    return h('div',
      h('h3', `${g.icon} ${g.title} — новое лобби`),
      h('div.sub', 'Вы будете хостом. В группе появится карточка лобби — друзья присоединятся по ней.'),
      ...fields,
      h('button.btn.primary.wide.lg', { style: { marginTop: '16px', width: '100%' }, onclick: () => {
        haptic.tap();
        send({ t: 'create', game: g.id, settings: { ...st } });
        closeSheet();
      } }, 'Создать лобби'),
    );
  });
}
