/**
 * The game hub, inside Telegram — the shell.
 *
 * It connects (net.js), and shows whatever the server says this page is
 * looking at: a group's hub (pick a game, see the lobbies), a poker table or
 * a durak game. Each screen is its own module with the same two calls —
 * `onState(state, previous)` and `render()` — so a new game is a new file in
 * games/ and one line here.
 */
import { tg, $app, h, tickClocks, flushAnimations, closeSheet } from './ui.js';
import { net, bus, connect, send, serverNow, initData, isOpen } from './net.js';
import * as hub from './hub.js';
import * as poker from './games/poker.js';
import * as durak from './games/durak.js';

const SCREENS = { hub, poker, durak };

/** Which module draws this state. Rooms saved before the hub carry no `game`: poker. */
const screenOf = (s) => (s?.kind === 'hub' || s?.kind === 'home' ? 'hub' : s?.game === 'durak' ? 'durak' : 'poker');
/** A different screen (another room, or the hub) starts without a "before". */
const placeOf = (s) => (s ? `${s.kind || screenOf(s)}:${s.kind === 'hub' ? s.group?.code : s.kind === 'home' ? '' : s.room?.code}` : '');

let prevSame = null;

bus.onState = (wasConnected) => {
  const s = net.state;
  const moved = placeOf(net.prev) !== placeOf(s);
  if (moved) closeSheet();
  prevSame = moved ? null : net.prev;
  SCREENS[screenOf(s)].onState(s, prevSame, { wasConnected });
  backButton(s);
  if (!wasConnected) reportVisibility();
};

bus.render = render;

function render() {
  $app.replaceChildren();
  if (!tg || !initData) {
    $app.append(h('div.fatal', h('h2', 'Откройте игру из Telegram'), h('div', 'Это мини-приложение работает внутри Telegram: нажмите кнопку в группе.')));
    return;
  }
  if (net.fatal) {
    $app.append(h('div.fatal', h('div.boot-logo', '♠'), h('h2', net.fatal), h('button.btn.primary', { style: { padding: '0 24px' }, onclick: () => tg.close() }, 'Закрыть')));
    return;
  }
  if (!net.state) {
    $app.append(h('div.boot', h('div.boot-logo', '♠'), h('div', 'Подключаемся…')));
    return;
  }
  SCREENS[screenOf(net.state)].render();
  // Which state is on screen — for the browser checks (tools/e2e*.mjs).
  document.body.dataset.seq = net.state.seq ?? '';
  if (!net.connected) $app.append(h('div.conn', 'Нет связи — переподключаемся…'));
  tickClocks(serverNow());
  flushAnimations({ still: !prevSame });
}

setInterval(() => tickClocks(serverNow()), 250);

/** Telegram's own «Назад» — back to the group's games, for a page that came from there. */
let backBound = false;
function backButton(s) {
  const b = tg?.BackButton;
  if (!b) return;
  if (!backBound) {
    b.onClick?.(() => send({ t: 'hub' }, { lock: false }));
    backBound = true;
  }
  if (s?.hub) b.show?.();
  else b.hide?.();
}

/** Telegram tells us when the app goes to the background: then the bot may nudge. */
function reportVisibility() {
  const visible = !document.hidden;
  if (isOpen() && net.state) send({ t: 'visible', visible }, { lock: false });
}
document.addEventListener('visibilitychange', reportVisibility);
tg?.onEvent?.('activated', reportVisibility);
tg?.onEvent?.('deactivated', () => isOpen() && send({ t: 'visible', visible: false }, { lock: false }));

/* ------------------------------------------------------------------ start */

if (tg) {
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes?.(); // the raise slider must not close the app
  try {
    tg.setHeaderColor?.('#0a0f0c');
    tg.setBackgroundColor?.('#0a0f0c');
    tg.setBottomBarColor?.('#0a0f0c');
  } catch {
    /* older clients */
  }
}
render();
if (tg && initData) connect();
