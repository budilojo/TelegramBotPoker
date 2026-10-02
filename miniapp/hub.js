/**
 * The first screen of a group's hub: what to play, and what is already open
 * in this group. Opened by «🎮 Выбрать игру» under /game (`startapp=g_<code>`).
 *
 * Big cards for the games, a short settings sheet, «Создать лобби». The
 * lobby gets its own card in the group, and this page steps into it.
 */
import { $app, h, haptic, showSheet, closeSheet, refreshSheet } from './ui.js';
import { bus, send } from './net.js';
import { lobby as pokerLobby, iconCards as pokerIcon } from './games/poker.js';
import { lobby as durakLobby, iconCards as durakIcon } from './games/durak.js';
import { lobby as colorsLobby, iconCards as colorsIcon } from './games/colors.js';

/** Форма «новое лобби» у каждой игры своя — хаб берёт её у игры. */
const LOBBY = { poker: pokerLobby, durak: durakLobby, colors: colorsLobby };
const ICON = { poker: pokerIcon, durak: durakIcon, colors: colorsIcon };

let state = null;

export function onState(s) {
  state = s;
  bus.render();
  refreshSheet();
}

const STATUS = { lobby: 'ждут игроков', playing: 'идёт игра', paused: 'пауза' };

export function render() {
  const s = state;
  if (s.kind === 'home') return renderHome(s);
  // Сколько столов этой игры уже открыто в группе: «во что играют» полезнее,
  // чем «сколько игроков влезет» — второе и так написано под названием.
  const live = (id) => s.lobbies.filter((l) => l.game === id).length;

  const box = h('div.lobby.hub',
    s.home ? h('button.back-link', { onclick: () => send({ t: 'home' }, { lock: false }) }, '← Мои группы') : null,
    h('div.hub-head',
      h('h1', 'Выберите игру', h('span.hh-2', 'из группы')),
      h('div.sub', s.group.title ? `Играйте с участниками «${s.group.title}»` : 'Играйте с участниками группы')),

    h('div.game-cards', s.games.map((g) => gameRow(g, live(g.id)))),

    h('button.rt-open', { onclick: () => { haptic.tap(); send({ t: 'rating' }, { lock: false }); } },
      h('div.rt-cup', '🏆'),
      h('div.rt-open-body',
        h('div.rt-open-title', 'Рейтинг игроков'),
        h('div.rt-open-sub', 'Лидеры и своя статистика')),
      h('div.rt-open-go', '›')),

    h('div.section-label', 'Открытые игры'),
    s.lobbies.length
      ? h('div.lobby-list', s.lobbies.map(lobbyRow))
      : h('div.hint', 'Пока ничего не открыто — выберите игру выше и создайте лобби. Друзья присоединятся по его карточке в группе или отсюда.'),
    h('div.hub-foot', 'Играть можно только с участниками группы'),
  );
  $app.append(box);
}

/** Две карты веером — значок игры. Берём из той же колоды, что и за столом. */
/** Какими картами подписана игра, говорит сама игра. */
const gameIcon = (id) => h(`div.gc-icon.g-${id}`,
  ...(ICON[id] || ICON.poker).map((src, i) => h(`img.gi-card.c${i}`, { src, alt: '' })));

function gameRow(g, live) {
  const on = true; // в списке только то, во что уже можно играть
  return h(`button.game-card.g-${g.id}`, { onclick: () => openCreate(g) },
    gameIcon(g.id),
    h('div.gc-body',
      h('div.gc-title', g.title),
      h('div.gc-blurb', g.blurb),
      h('div.gc-players', live ? `сейчас открыто: ${live}` : `${g.min}–${g.max} игроков`)),
    h(`span.gc-btn${on ? '.on' : ''}`, 'Играть'));
}

/** Opened without a group (the bot's profile, a button in private): your groups. */
function renderHome(s) {
  $app.append(h('div.lobby.hub',
    h('div', h('h1', '🎮 Ваши группы'), h('div.sub', 'Где играем?')),
    h('div.lobby-list', s.groups.map((g) => h('div.lrow',
      h('div.lr-icon', '👥'),
      h('div.lr-body',
        h('div.lr-title', g.title),
        h('div.lr-sub', g.live ? `открыто игр: ${g.live}` : 'сейчас ничего не открыто')),
      h('button.btn.sm.primary', { onclick: () => { haptic.tap(); send({ t: 'group', code: g.code }); } }, 'Открыть')))),
    h('button.rt-open', { onclick: () => { haptic.tap(); send({ t: 'rating' }, { lock: false }); } },
      h('span', '🏆 Рейтинг'),
      h('small', 'кто чего стоит — за месяц и за всё время')),
    h('div.hint', 'Здесь группы, где вы писали боту или играли. Новая группа — добавьте бота и напишите там /game.'),
  ));
}

function lobbyRow(l) {
  const join = l.status === 'lobby' && !l.inside;
  return h(`div.lrow${l.mine ? '.mine' : ''}`,
    gameIcon(l.game),
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
  // Какие настройки у стола, знает сама игра: хаб их только рисует. Иначе
  // каждая новая игра получала бы чужую форму — так UNOQ однажды и спросил
  // у людей «подкидной или переводной».
  const form = LOBBY[g.id];
  const st = { ...(form?.defaults || { turnSeconds: 0 }) };

  showSheet('create', () => {
    const seg = (options, key) => h('div.seg', options.map(([v, label]) => h(`button${st[key] === v ? '.on' : ''}`, {
      onclick: () => { st[key] = v; refreshSheet(); },
    }, label)));
    const numField = (label, key) => h('div.field', h('label', label),
      h('input.num', { type: 'number', inputmode: 'numeric', value: st[key], oninput: (e) => (st[key] = Number(e.target.value)) }));

    const fields = form ? form.fields(st, { seg, numField, TIMERS, h }) : [];

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

