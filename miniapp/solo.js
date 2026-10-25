/**
 * Игры с ботами — экран, который открывается из лички бота («Играть с
 * ботом»), без группы. Выбираете игру, уровень и соперников — партия
 * начинается сразу. Одна партия с ботами на человека: новая заменяет прежнюю,
 * а прежнюю можно продолжить отсюда же.
 *
 * Что именно можно выбрать, говорит сервер (`games[].catalog`): уровни и, для
 * покера, типы ботов, блайнды и стек, а ещё уроки «Школы покера» — она
 * живёт в той же форме покера, режимом «Обучение». Страница только рисует.
 */
import { $app, h, haptic, showSheet, closeSheet, refreshSheet, fmt } from './ui.js';
import { bus, send } from './net.js';
import { GAMES } from './games/index.js';
import { schoolItems } from './school.js';
import { openRoute } from './train/route.js';

let state = null;

/** Что спрашивать в партии с ботами — говорит сама игра (`solo` её модуля). */
const soloOf = (id) => GAMES[id]?.solo || {};

export function onState(s) {
  state = s;
  bus.render();
  refreshSheet();
}

const gameIcon = (id) => h(`div.gc-icon.g-${id}`,
  ...(GAMES[id]?.iconCards || []).map((src, i) => h(`img.gi-card.c${i}`, { src, alt: '' })));

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
        h('div.gc-blurb', soloOf(g.id).blurb || g.blurb)),
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
  const S = soloOf(g.id);
  const T = cat.table; // покер: блайнды, стек, рост блайндов
  const st = keep || {
    mode: 'game', level: cat.defaultLevel ?? 1, opponents: Math.min(3, S.max || 1), side: 'white', base: 0, variant: S.variants?.[0][0], pick: false, types: [],
    bb: T?.bb, stack: T?.stack, grow: T?.grow,
  };
  const levels = (cat.levels || []).map((name, i) => [i, name]);

  showSheet('solo-form', () => {
    const seg = (options, key, cls = '') => h(`div.seg${cls}`, options.map(([v, label]) => h(`button${st[key] === v ? '.on' : ''}`, {
      type: 'button',
      // «Тренировка» — не режим шторки, а полный экран страницы (docs/poker-training.md).
      onclick: () => { if (key === 'mode' && v === 'train') { closeSheet(); openRoute('train'); return; } st[key] = v; refreshSheet(); },
    }, label)));
    const fields = [];
    // Покер: «Партия» или «Обучение» (школа). В обучении нет ни уровня, ни
    // соперников — за столом один наставник; уроки выбираются прямо здесь.
    if (cat.school?.length) {
      fields.push(seg([['game', 'Партия'], ['learn', 'Обучение'], ['train', 'Тренировка']], 'mode', '.solo-mode'));
      if (st.mode === 'learn') {
        return h('div', h('h3', `${g.icon} ${g.title} — с ботами`), ...fields,
          ...schoolItems(cat.school, () => openForm(g, st)));
      }
    }
    if (levels.length) fields.push(h('div.section-label', 'Уровень'), seg(levels, 'level', '.wide'));
    if (cat.levelHints?.[st.level]) fields.push(h('div.hint', cat.levelHints[st.level]));
    if (S.duel) {
      fields.push(
        // Подписи — от игры (морской бой: «Кто стреляет первым»); значения те же: white/black/random.
        h('div.section-label', S.sideLabel || 'Ваш цвет'), seg(S.sides || [['white', 'Белые'], ['black', 'Чёрные'], ['random', 'Случайно']], 'side'),
        h('div.section-label', 'Часы'), seg([[0, 'Без часов'], [300, '5 мин'], [600, '10 мин']], 'base'));
    } else {
      const max = cat.maxOpponents || S.max || 1;
      const counts = Array.from({ length: max }, (_, i) => [i + 1, String(i + 1)]);
      fields.push(h('div.section-label', 'Соперников'), seg(counts, 'opponents'));
    }
    if (S.variants) fields.push(h('div.section-label', 'Вариант'), seg(S.variants, 'variant'));
    if (T) {
      fields.push(
        h('div.section-label', 'Блайнды'), seg(T.blinds.map(([sb, bb]) => [bb, `${fmt(sb)}/${fmt(bb)}`]), 'bb'),
        h('div.section-label', 'Стартовый стек'), seg(T.stacks.map((n) => [n, fmt(n)]), 'stack'),
        h('div.section-label', 'Рост блайндов'), seg([['on', 'Растут'], ['off', 'Не растут']], 'grow'));
      if (st.grow === 'on') fields.push(h('div.hint', 'Каждые 10 минут блайнды становятся больше.'));
    }
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
        if (S.duel) Object.assign(settings, { side: st.side, base: st.base });
        else settings.opponents = st.opponents;
        if (S.variants) settings.variant = st.variant;
        if (st.pick) settings.types = st.types.slice(0, st.opponents);
        if (T) Object.assign(settings, { bb: st.bb, stack: st.stack, grow: st.grow });
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
