import { h, tg, showSheet, toast } from './ui.js';
import { net, initData } from './net.js';
import { clearUX, session as storage } from './storage.js';
import { activeRoute } from './train/route.js';
import { activeTab } from './nav.js';
let info, recording = false, sid = null, lastPlace = '', pendingCreate = false;
try { sid = storage.getItem('research-session'); } catch {}
async function api(op, data = {}) {
  const r = await fetch('/ux', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...data, op, initData }), keepalive: op === 'event' });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error);
  return result;
}
const screen = () => {
  if (!net.state) return 'boot';
  const route = activeRoute();
  if (route) return route.name === 'learn' ? 'learn' : 'train';
  const tab = activeTab(net.state);
  if (tab === 'settings') return 'settings';
  if (tab !== 'games') return 'other';
  return ['home', 'hub', 'solo', 'room'].includes(net.state.kind) ? net.state.kind : 'other';
};
let queue = Promise.resolve();
function event(name, extra = {}) {
  if (!recording || !sid) return;
  const session = sid;
  queue = queue.then(() => api('event', { session, name, screen: screen(), ...extra })).catch(() => {});
}
function restart(clear = false) {
  if (clear) clearUX();
  // Telegram's signed room link stays immutable. UX-only launch hint asks the existing home route.
  storage.setItem('first-launch', '1');
  location.assign('/');
}
const action = fn => async () => { try { await fn(); } catch (e) { toast(e.message); } };
function panel() {
  showSheet('ux-test', () => h('div', h('h3', 'UX-Test'),
    h('p', `Telegram ID: ${info.userId}`),
    h('p', `Сервер: ${net.connected ? 'подключён' : 'игровое подключение отсутствует'}. Профиль: ${info.profile ? 'сохранён' : 'новый'}.`),
    h('p', info.onboarding),
    info.tester ? [
      h('button.btn.wide', { onclick: action(async () => {
        if (!confirm('Сбросить только ваш тестовый профиль? Прогресс будет удалён.')) return;
        await queue; await api('reset'); restart(true);
      }) }, 'Сбросить тестовый профиль'),
      h('button.btn.wide', { onclick: action(() => restart()) }, 'Первый запуск'),
      h('button.btn.wide', { onclick: action(() => restart(true)) }, 'Очистить локальные данные'),
      h('button.btn.wide', { onclick: action(async () => {
        const result = await api('export');
        const url = URL.createObjectURL(new Blob([JSON.stringify(result.events, null, 2)], { type: 'application/json' }));
        const a = h('a', { href: url, download: 'ux-events.json' }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }) }, 'Скачать события'),
    ] : null,
    h('p', 'Запись исследования добровольна. Сохраняются шаги и время без переписки, карт и секретов. Остановить и удалить запись можно здесь.'),
    h('p', recording ? 'Запись включена' : 'Запись выключена'),
    h('button.btn.primary.wide', { disabled: recording, onclick: action(async () => {
      const r = await api('consent'); sid = r.session; storage.setItem('research-session', sid); recording = true;
      event('app_open'); if (['home', 'hub', 'solo'].includes(net.state?.kind)) event('home_view'); panel();
    }) }, 'Согласен, начать запись'),
    h('button.btn.wide', { disabled: !recording, onclick: action(async () => {
      recording = false; await queue; await api('stop', { session: sid }); panel();
    }) }, 'Остановить запись'),
    h('button.btn.wide', { disabled: !sid, onclick: action(async () => {
      recording = false; await queue; await api('delete', { session: sid }); sid = null; storage.removeItem('research-session'); panel();
    }) }, 'Удалить запись этой сессии'),
  ));
}
document.addEventListener('ux-step', e => event(e.detail.name, { game: e.detail.game }));
document.addEventListener('ux-error', () => { pendingCreate = false; event('error'); });
document.addEventListener('ux-send', e => {
  if (e.detail.t === 'create') pendingCreate = true;
});
document.addEventListener('ux-state', e => {
  const s = e.detail, place = `${s.kind}:${s.room?.code || ''}:${s.room?.status || s.status || ''}`;
  if (place === lastPlace) return;
  lastPlace = place;
  if (['home', 'hub', 'solo'].includes(s.kind)) event('home_view');
  if (pendingCreate && s.room?.code) { pendingCreate = false; event('room_created'); }
  if (s.room?.status === 'playing' || s.status === 'playing') event('game_start');
});
document.addEventListener('visibilitychange', () => { if (document.hidden) event('scenario_exit'); });
if (initData) {
  try {
    info = await api('info');
    const link = h('button.btn', { id: 'ux-access', onclick: action(async () => { info = await api('info'); panel(); }) }, info.tester ? 'UX-Test · разработчик' : 'UX-Test · запись');
    document.body.append(link);
    const css = h('link', { rel: 'stylesheet', href: '/ux.css' }); document.head.append(css);
  } catch { /* An invalid Telegram session never opens the panel. */ }
}
