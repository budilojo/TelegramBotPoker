/**
 * WebSocket client with automatic reconnect and session resume.
 *
 * The connection is treated as disposable: on every (re)open we replay the
 * stored session with a `resume`, and the server answers with a full snapshot.
 * Nothing about the game lives in this file.
 */
import { store } from './util.js';

const SESSION_KEY = 'chiptable.session';

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;

/**
 * A link somebody else can actually open. When this browser is sitting on
 * localhost — the laptop that started the server — its own origin is no use
 * to a phone, so we fall back to the LAN address the server reported. On a
 * real deployment the origin is already right and wins.
 */
export function joinUrl(code) {
  const useLan = LOOPBACK.test(location.hostname) && net.lanUrl;
  return `${useLan ? net.lanUrl : location.origin}/j/${code}`;
}

export const net = {
  ws: null,
  lanUrl: null,
  status: 'idle', // idle | connecting | online | offline
  stopped: false, // true while another tab holds this seat
  attempts: 0,
  timer: null,
  pingTimer: null,
  lastPong: 0,
  handlers: {},
  /** Intent that must be replayed once we are online again. */
  pendingIntent: null,

  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
    return this;
  },

  emit(type, payload) {
    for (const fn of this.handlers[type] || []) fn(payload);
  },

  session: store.get(SESSION_KEY, null),

  saveSession(s) {
    this.session = s;
    store.set(SESSION_KEY, s);
  },

  clearSession() {
    this.session = null;
    store.del(SESSION_KEY);
  },

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  },

  /** Stop reconnecting (another tab owns this seat). */
  halt() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.stopPing();
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.setStatus('idle');
  },

  /** Take the seat back in this tab. */
  takeOver() {
    this.stopped = false;
    this.attempts = 0;
    this.connect();
  },

  connect() {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    clearTimeout(this.timer);
    this.setStatus(this.attempts === 0 ? 'connecting' : 'offline');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      return this.scheduleReconnect();
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.lastPong = Date.now();
      this.setStatus('online');
      // Re-claim our seat before anything else.
      if (this.session) {
        this.raw({
          t: 'resume',
          code: this.session.code,
          playerId: this.session.playerId,
          token: this.session.token,
        });
      }
      if (this.pendingIntent) {
        const p = this.pendingIntent;
        this.pendingIntent = null;
        this.raw(p);
      }
      this.startPing();
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        this.lastPong = Date.now();
        return;
      }
      if (msg.t === 'session') {
        this.lanUrl = msg.lanUrl || null;
        this.saveSession({
          code: msg.code,
          playerId: msg.playerId,
          token: msg.token,
        });
      }
      this.emit(msg.t, msg);
      this.emit('*', msg);
    };

    ws.onclose = () => {
      this.stopPing();
      if (this.ws === ws) this.ws = null;
      // A socket we closed on purpose is not a lost connection.
      if (this.stopped) return;
      this.setStatus('offline');
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  },

  scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.attempts += 1;
    // 0.4s, 0.8s, 1.6s ... capped at 6s, with jitter so a whole table of
    // phones waking up at once does not stampede the server.
    const base = Math.min(6000, 400 * 2 ** Math.min(this.attempts - 1, 4));
    const wait = base + Math.random() * 400;
    this.timer = setTimeout(() => this.connect(), wait);
  },

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      // No pong for 40s means the socket is a zombie (common after a phone
      // wakes from sleep on a flaky network).
      if (Date.now() - this.lastPong > 40_000) {
        try {
          this.ws.close();
        } catch {}
        return;
      }
      this.raw({ t: 'ping' });
    }, 12_000);
  },

  stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  },

  raw(msg) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  },

  /**
   * Send an intent. If we are offline, the *entry* intents (create/join) are
   * queued so a tap on a dead connection is not silently lost.
   */
  send(msg) {
    if (this.raw(msg)) return true;
    if (msg.t === 'create' || msg.t === 'join') this.pendingIntent = msg;
    this.connect();
    return false;
  },

  leave() {
    this.raw({ t: 'leave' });
    this.clearSession();
  },
};

/* A phone coming back from lock screen must resync immediately, not on the
   next 12s ping. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (net.stopped) return;
  if (!net.ws || net.ws.readyState !== 1) {
    net.attempts = 0;
    net.connect();
  } else {
    net.raw({ t: 'ping' });
  }
});
window.addEventListener('online', () => {
  if (net.stopped) return;
  net.attempts = 0;
  net.connect();
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) net.connect();
});
