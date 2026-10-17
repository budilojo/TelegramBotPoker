/**
 * Игры с ботами — экран, который открывается из лички бота («Играть с
 * ботом»), без группы. Выбираете игру, уровень и соперников — партия
 * начинается сразу. Одна партия с ботами на человека: новая заменяет прежнюю,
 * а прежнюю можно продолжить отсюда же.
 *
 * Что именно можно выбрать, говорит сервер (`games[].catalog`): уровни и, для
 * покера, типы ботов. Страница только рисует.
 */
import { $app, h, haptic, showSheet, closeSheet, refreshSheet } from './ui.js';
import { bus, send } from './net.js';
import { iconCards as pokerIcon } from './games/poker.js';
import { iconCards as durakIcon } from './games/durak.js';
import { iconCards as colorsIcon } from './games/colors.js';
import { iconCards as chessIcon } from './games/chess.js';

let state = null;

const ICON = { poker: pokerIcon, durak: durakIcon, colors: colorsIcon, chess: chessIcon };
const MAX_OPPONENTS = { poker: 7, durak: 5, colors: 7, chess: 1 };
const BLURB = {
  chess: 'Соперник — шахматный движок, от новичка до мастера',
  poker: 'От 1 до 7 соперников, у каждого свой характер',
  durak: 'Подкидной или переводной, до пяти соперников',
  colors: 'Цветные карты, до семи соперников',
};

export function onState(s) {
  state = s;
  bus.render();
  refreshSheet();
}

const gameIcon = (id) => h(`div.gc-icon.g-${id}`,
  ...(ICON[id] || []).map((src, i) => h(`img.gi-card.c${i}`, { src, alt: '' })));

export function render() {
  const s = state;
  $app.append(h('div.lobby.hub.solo',
    s.groups ? h('button.back-link', { onclick: () => send({ t: 'home' }, { lock: false }) }, '← Мои группы') : null,
    h('div.hub-head',
      h('h1', 'Игры с ботами'),
      h('div.sub', 'Без группы и без ожидания: выберите игру и соперников. В рейтинг не идёт — это тренировка.')),
    s.resume
      ? h('button.k-btn.k-btn--primary.k-btn--block.solo-resume', { onclick: () => { haptic.tap(); send({ t: 'resume' }); } },
        `▶ Продолжить: ${s.resume.icon} ${s.resume.title}`)
      : null,
    h('div.game-cards', s.games.map((g) => h(`button.game-card.g-${g.id}`, { onclick: () => openForm(g) },
      gameIcon(g.id),
      h('div.gc-body',
        h('div.gc-title', g.title),
        h('div.gc-blurb', BLURB[g.id] || g.blurb)),
      h('span.gc-go', '›')))),
    s.groups
      ? null
      : h('div.hint', 'Играть с друзьями — в группе: добавьте бота в группу и напишите там /game.'),
  ));
}

/* ----------------------------------------------------------- форма игры */

function openForm(g, keep = null) {
  if (!keep) haptic.soft();
  const cat = g.catalog || {};
  const st = keep || { level: cat.defaultLevel ?? 1, opponents: Math.min(3, MAX_OPPONENTS[g.id] || 1), side: 'white', base: 0, variant: 'podkidnoy', pick: false, types: [] };
  const levels = (cat.levels || []).map((name, i) => [i, name]);

  showSheet('solo-form', () => {
    const seg = (options, key, cls = '') => h(`div.seg${cls}`, options.map(([v, label]) => h(`button${st[key] === v ? '.on' : ''}`, {
      type: 'button',
      onclick: () => { st[key] = v; refreshSheet(); },
    }, label)));
    const fields = [];
    if (levels.length) fields.push(h('div.section-label', 'Уровень'), seg(levels, 'level', '.wide'));
    if (cat.levelHints?.[st.level]) fields.push(h('div.hint', cat.levelHints[st.level]));
    if (g.id === 'chess') {
      fields.push(
        h('div.section-label', 'Ваш цвет'), seg([['white', 'Белые'], ['black', 'Чёрные'], ['random', 'Случайно']], 'side'),
        h('div.section-label', 'Часы'), seg([[0, 'Без часов'], [300, '5 мин'], [600, '10 мин']], 'base'));
    } else {
      const max = MAX_OPPONENTS[g.id] || 1;
      const counts = Array.from({ length: max }, (_, i) => [i + 1, String(i + 1)]);
      fields.push(h('div.section-label', 'Соперников'), seg(counts, 'opponents'));
    }
    if (g.id === 'durak') fields.push(h('div.section-label', 'Вариант'), seg([['podkidnoy', 'Подкидной'], ['perevodnoy', 'Переводной']], 'variant'));
    if (cat.types?.length) {
      fields.push(h('div.section-label', 'Характеры соперников'), seg([[false, 'Случайные'], [true, 'Выбрать самому']], 'pick'));
      if (st.pick) {
        fields.push(h('div.menu-list.solo-seats', Array.from({ length: st.opponents }, (_, i) => {
          const t = cat.types.find((x) => x.id === st.types[i]);
          return h('button.menu-item', { type: 'button', onclick: () => pickType(g, st, i) },
            `Соперник ${i + 1}: ${t ? t.name : 'случайный'}`, h('small', t ? t.blurb : 'нажмите, чтобы выбрать характер'));
        })));
      }
    }
    return h('div',
      h('h3', `${g.icon} ${g.title} — с ботами`),
      ...fields,
      h('button.btn.primary.wide.lg', { style: { marginTop: '16px', width: '100%' }, onclick: () => {
        haptic.tap();
        const settings = { level: st.level };
        if (g.id === 'chess') Object.assign(settings, { side: st.side, base: st.base });
        else settings.opponents = st.opponents;
        if (g.id === 'durak') settings.variant = st.variant;
        if (st.pick) settings.types = st.types.slice(0, st.opponents);
        send({ t: 'play', game: g.id, settings });
        closeSheet();
      } }, '▶ Играть'),
    );
  });
}

/** Выбор характера бота для одного места. */
function pickType(g, st, seat) {
  const types = g.catalog.types;
  showSheet('solo-type', () => h('div',
    h('h3', `Соперник ${seat + 1}`),
    h('div.sub', 'Характер — как бот играет. Уровень — насколько хорошо он это делает.'),
    h('div.menu-list', [{ id: null, name: 'Случайный', blurb: 'любой из характеров ниже' }, ...types].map((t) => h('button.menu-item', {
      type: 'button',
      onclick: () => { st.types[seat] = t.id; openForm(g, st); },
    }, t.name, h('small', t.blurb)))),
  ));
}
