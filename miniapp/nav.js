/**
 * Нижняя навигация: Игры · Рейтинг · Настройки.
 *
 * Только на экранах хаба: «мои группы», игры группы, «Игры с ботами» и таблица
 * рейтинга. За столом (лобби, партия, итоги), в пульте владельца, под шторкой
 * и при открытой клавиатуре панели нет — доска и кнопки действий ничего не
 * теряют.
 *
 * «Игры» не придумывает свой экран: это тот, что сервер уже показывает
 * (группа, «мои группы» или игры с ботами). «Рейтинг» и «Настройки» — экраны
 * самой страницы поверх него: сервер о них не знает, а шаг «назад» к играм
 * ничего не запрашивает.
 */
import { $app, h, haptic, tg } from './ui.js';
import { bus, send } from './net.js';
import { renderRanked, resetRanked } from './rating.js';
import { openShop } from './shop/index.js';
import { renderProfileSettings } from './profile.js';

/** На каких состояниях сервера панель есть. */
const KINDS = new Set(['home', 'hub', 'solo', 'rating']);

/** Экран страницы поверх состояния сервера: null | 'ranked' | 'settings'. */
let view = null;

export const showsBar = (s) => !!s && KINDS.has(s.kind);

/** Состояние сменило «место» (стол, другая группа) — свой экран закрыть. */
export function onMove() {
  view = null;
  resetRanked();
}

export function activeTab(s) {
  if (view === 'settings') return 'settings';
  if (view === 'ranked' || s.kind === 'rating') return 'rating';
  return 'games';
}

function scrollTop() {
  const el = $app.querySelector('.lobby');
  el?.scrollTo?.({ top: 0, behavior: 'smooth' });
}

function go(tab, s) {
  haptic.soft();
  const now = activeTab(s);
  if (tab === now) return scrollTop();
  if (tab === 'games') {
    view = null;
    resetRanked();
    if (s.kind === 'rating') return void send({ t: 'back' }, { lock: false });
    return bus.render();
  }
  if (tab === 'rating') {
    view = s.kind === 'rating' ? null : 'ranked';
    return bus.render();
  }
  view = 'settings';
  bus.render();
}

/* ------------------------------------------------------------- значки */

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  games: svg('<rect x="3" y="7" width="12" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/>'),
  rating: svg('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3"/>'),
  settings: svg('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>'),
};
const TABS = [['games', 'Игры'], ['rating', 'Рейтинг'], ['settings', 'Настройки']];

export function bar(s) {
  const active = activeTab(s);
  return h('nav.nav', { 'aria-label': 'Разделы' },
    TABS.map(([id, label]) => h(`button.nav-tab${id === active ? '.on' : ''}`, {
      'aria-current': id === active ? 'page' : null,
      'data-tab': id,
      onclick: () => go(id, s),
    },
    h('span.nav-ico', { html: ICONS[id] }),
    h('span.nav-label', label))));
}

/* ----------------------------------------------------------- свои экраны */

/** Нарисовать свой экран вместо серверного, если он открыт. Вернёт true, если нарисовал. */
export function renderView(s) {
  if (!view || !showsBar(s)) return false;
  $app.append(view === 'settings' ? settings(s) : renderRanked(s));
  return true;
}

/** Экран профиля живёт в одном и том же элементе: его перерисовывают на каждое состояние, а поле ввода терять нельзя. */
const profileBox = h('div.pf-host');

function settings(s) {
  return h('div.lobby.hub.settings',
    h('div.hub-head', h('h1', 'Настройки'), h('div.sub', 'Этот телефон и бот')),

    h('section.set-block',
      h('div.section-label', 'Профиль'),
      (renderProfileSettings(profileBox), profileBox)),

    h('section.set-block', h('button.k-btn.k-btn--secondary', { onclick: openShop }, 'Магазин')),

    s.bot ? h('section.set-block',
      h('div.section-label', 'Уведомления бота'),
      h('div.set-row.col',
        h('div.set-body',
          h('div.set-title', 'Напоминание «ваш ход»'),
          h('div.set-sub', 'Бот напишет в личку, когда подошла ваша очередь, а приложение закрыто. Если не приходит — откройте бота и нажмите Start.')),
        h('button.btn.sm', { onclick: () => { haptic.tap(); tg?.openTelegramLink?.(`https://t.me/${s.bot}?start=notify`); } }, 'Открыть бота'))) : null,

    h('section.set-block',
      h('div.section-label', 'О приложении'),
      h('div.set-row', h('div.set-body',
        h('div.set-title', 'Фишки и очки — виртуальные'),
        h('div.set-sub', 'Денег в играх нет. Играть можно только с участниками своей группы и с ботами.')))));
}

/* ------------------------------------------------------------ клавиатура */

// Открытая клавиатура панель не прячет «подвинув», а убирает: иначе она
// занимала бы пол-экрана над клавиатурой.
let typing = false;
function syncKeyboard() {
  const vv = window.visualViewport;
  const shrunk = vv && window.innerHeight - vv.height > 140;
  document.body.classList.toggle('kb-open', !!(shrunk || typing));
}
window.visualViewport?.addEventListener('resize', syncKeyboard);
document.addEventListener('focusin', (e) => { typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || ''); syncKeyboard(); });
document.addEventListener('focusout', () => { typing = false; syncKeyboard(); });
