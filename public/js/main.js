/**
 * App shell: connection, routing, and the one place that owns "what screen
 * am I looking at". Screens are plain modules with mount()/update().
 */
import { net } from './net.js';
import { h, clear, tick, fmt } from './util.js';
import { toast, closeOverlay } from './ui/overlay.js';

import * as Home from './screens/home.js';
import * as Create from './screens/create.js';
import * as Join from './screens/join.js';
import * as Lobby from './screens/lobby.js';
import * as Table from './screens/table.js';
import * as Dealer from './screens/dealer.js';
import * as Results from './screens/results.js';
import * as Resume from './screens/resume.js';
import * as Blocked from './screens/blocked.js';

const SCREENS = { home: Home, create: Create, join: Join, lobby: Lobby, table: Table, dealer: Dealer, results: Results, resume: Resume, blocked: Blocked };

export const app = {
  state: null, // latest server snapshot
  prev: null, // previous snapshot, for diff-driven animation
  nav: 'home', // local route while outside a room
  ui: {
    pending: null, // { t, at } — an action awaiting server confirmation
    joinCode: '',
    blocked: null, // 'duplicate' when another tab holds our seat
    lastEvent: null,
  },
  root: null,
  bannerEl: null,
  current: null,
  currentName: null,

  /** Local navigation (only meaningful before joining a room). */
  go(nav) {
    this.nav = nav;
    closeOverlay();
    this.render();
  },

  /** Where we should be, given the server snapshot. */
  route() {
    if (this.ui.blocked) return 'blocked';
    const s = this.state;
    // Reconnecting into a remembered seat: show the resume screen, not home.
    if (!s) return net.session ? 'resume' : this.nav;
    if (s.status === 'finished') return 'results';
    if (s.status === 'lobby') return 'lobby';
    const me = s.players.find((p) => p.id === s.you);
    return me?.role === 'dealer' ? 'dealer' : 'table';
  },

  /** Send a game action with the optimistic-concurrency guard. */
  act(msg, label = msg.t) {
    if (this.ui.pending) return false;
    this.ui.pending = { t: label, at: Date.now() };
    const ok = net.send({ ...msg, seq: this.state?.seq });
    if (!ok) {
      this.ui.pending = null;
      toast('Нет связи с сервером — повторите', 'err');
      return false;
    }
    tick(10);
    this.render();
    // Safety valve: never leave the UI locked if a reply goes missing.
    clearTimeout(this._pendingTimer);
    this._pendingTimer = setTimeout(() => {
      if (this.ui.pending) {
        this.ui.pending = null;
        toast('Сервер не ответил — попробуйте ещё раз', 'err');
        this.render();
      }
    }, 5000);
    return true;
  },

  leaveRoom() {
    net.leave();
    this.state = null;
    this.prev = null;
    this.ui.pending = null;
    this.nav = 'home';
    closeOverlay();
    this.render();
  },

  render() {
    const name = this.route();
    if (name !== this.currentName) {
      this.currentName = name;
      this.current = SCREENS[name];
      clear(this.root);
      this.view = this.current.mount(this);
      this.root.append(this.view);
    }
    this.current?.update?.(this);
    this.renderBanner();
  },

  renderBanner() {
    const s = net.status;
    const st = this.state;
    let node = null;

    if (s === 'offline') {
      node = h('div.banner.bad', h('span.spin'), 'Соединение потеряно — переподключаемся');
    } else if (s === 'connecting' && !st) {
      node = h('div.banner', h('span.spin'), 'Подключение');
    } else if (st && st.status === 'paused') {
      node = h('div.banner', 'Игра на паузе');
    } else if (st && st.status !== 'finished' && st.hostId && !st.hostConnected) {
      node = h('div.banner', 'Хост отключился — игра продолжается');
    }

    if (!node) {
      this.bannerEl?.remove();
      this.bannerEl = null;
      return;
    }
    if (this.bannerEl) this.bannerEl.replaceWith(node);
    else this.root.prepend(node);
    this.bannerEl = node;
  },
};

/* --------------------------------------------------------------- wiring  */

net.on('state', (msg) => {
  app.prev = app.state;
  app.state = msg.state;
  // The blind clock counts down from here without further traffic.
  app.stateAt = Date.now();
  app.ui.lastEvent = msg.event || null;
  if (app.ui.pending) {
    clearTimeout(app._pendingTimer);
    app.ui.pending = null;
  }
  // Confirm my own action back to me — a tap on a phone needs an answer.
  const ev = msg.event;
  if (ev?.kind === 'action' && ev.playerId === msg.state.you) {
    const me = msg.state.players.find((p) => p.id === ev.playerId);
    if (me?.lastAction) {
      const quiet = me.lastAction === 'FOLD' || me.lastAction === 'CHECK';
      toast(`✓ ${me.lastAction}${quiet ? '' : ' ' + fmt(me.lastAmount)}`, 'ok', 1600);
    }
  }

  if (ev?.kind === 'payout' && Array.isArray(ev.payouts)) {
    for (const p of ev.payouts) {
      toast(`${p.name} забирает банк +${fmt(p.amount)}`, 'ok', 3200);
    }
  }

  // A server-side notice (undo, kick, host change) is worth surfacing once.
  const n = msg.state.notice;
  if (n && n.at !== app._noticeAt) {
    app._noticeAt = n.at;
    if (app.prev) toast(n.text, n.kind === 'undo' ? 'info' : 'info');
  }
  app.render();
});

net.on('error', (msg) => {
  clearTimeout(app._pendingTimer);
  app.ui.pending = null;
  if (msg.code === 'ROOM_NOT_FOUND' || msg.code === 'SESSION_INVALID') {
    // Our stored seat is gone (server restarted, room expired).
    if (app.state) {
      toast(msg.message, 'err');
    } else {
      net.clearSession();
    }
    if (msg.code === 'SESSION_INVALID') {
      net.clearSession();
      app.state = null;
      app.nav = 'home';
    }
  }
  if (msg.code !== 'STALE') toast(msg.message || 'Ошибка', 'err');
  app.render();
});

net.on('toast', (msg) => toast(msg.text, msg.kind || 'info', 3400));

net.on('kicked', (msg) => {
  app.state = null;
  if (msg.reason === 'DUPLICATE_SESSION') {
    // Stand down instead of racing the other tab for the socket.
    app.ui.blocked = 'duplicate';
    net.halt();
    app.render();
    return;
  }
  net.clearSession();
  app.nav = 'home';
  app.render();
  toast('Хост удалил вас из комнаты', 'err', 4200);
});

net.on('status', () => app.renderBanner());

/* ------------------------------------------------------------- bootstrap */

function readDeepLink() {
  const m = location.pathname.match(/^\/j\/([A-Za-z0-9]{3,8})\/?$/);
  const q = new URLSearchParams(location.search).get('r');
  const code = (m?.[1] || q || '').toUpperCase();
  if (code) {
    history.replaceState(null, '', '/');
    return code;
  }
  return '';
}

function boot() {
  app.root = document.getElementById('app');
  const deep = readDeepLink();
  if (deep) {
    // Scanning a different room's QR means leaving the old seat behind.
    if (net.session && net.session.code !== deep) net.clearSession();
    app.ui.joinCode = deep;
    app.nav = 'join';
  }
  app.render();
  net.connect();
}

// No "are you sure you want to leave?" guard on purpose: a refresh, a closed
// tab or a locked phone all resume straight back into the same seat, so the
// native dialog would be friction that protects against nothing.

// One second of wall clock only ever redraws the blind timer, never the table.
setInterval(() => app.current?.tickClock?.(app), 1000);

boot();
