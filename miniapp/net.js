/**
 * The line to the server: one WebSocket that says hello with the signed
 * initData, gets back states (built for this person only) and sends
 * requests. Reconnects by itself and gets the whole state again.
 *
 * The page is a view, never a judge: every tap is a request the server
 * re-checks against the player's signed identity.
 */
import { tg, toast, haptic } from './ui.js';

export const initData = tg?.initData || '';
/** What the link opened: a room code, or `g_<code>` — a group's hub. Signed by Telegram. */
export const startCode = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('room') || '';

/** Live connection facts every screen may read. */
export const net = {
  connected: false,
  fatal: null,
  busy: false,
  state: null,
  prev: null,
  /** The room this page stepped into from a hub — asked for again after a reconnect. */
  inside: null,
};

/** The shell's hooks: what to do with a state, how to redraw. */
export const bus = {
  onState: () => {},
  render: () => {},
  onNotice: (text) => toast(text, 3200),
};

let ws = null;
let retry = 0;
let clockOffset = 0; // server time − our time
let busyTimer = null;

export const serverNow = () => Date.now() + clockOffset;

export function connect() {
  const url = location.origin.replace(/^http/, 'ws') + '/ws';
  ws = new WebSocket(url);
  ws.onopen = () => {
    retry = 0;
    // A hub page that had stepped into a lobby asks for it again: the server
    // allows it only for a room of the group this page was opened for.
    ws.send(JSON.stringify({ t: 'hello', initData, room: net.inside || startCode }));
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.t === 'state') {
      const wasConnected = net.connected;
      net.connected = true;
      net.prev = net.state;
      net.state = msg.state;
      clockOffset = net.state.now - Date.now();
      // Where this page is now — asked for again after a reconnect. The server
      // lets a page back only into its own group's games (or its own groups).
      const st = net.state;
      if (startCode.startsWith('g_')) net.inside = st.kind === 'hub' ? null : st.room?.code || null;
      else if (!startCode) net.inside = st.kind === 'hub' ? `g_${st.group.code}` : st.kind === 'home' ? null : st.room?.code || null;
      setBusy(false);
      bus.onState(wasConnected);
    } else if (msg.t === 'error') {
      setBusy(false);
      haptic.err();
      toast(msg.text || 'Не получилось');
    } else if (msg.t === 'notice') {
      bus.onNotice(msg.text);
    } else if (msg.t === 'fatal' || (msg.t === 'gone' && startCode && !startCode.startsWith('g_'))) {
      net.fatal = msg.text || 'Стол недоступен.';
      bus.render();
    } else if (msg.t === 'gone') {
      toast(msg.text || 'Игру удалили.');
    }
  };
  ws.onclose = () => {
    const was = net.connected;
    net.connected = false;
    if (net.fatal) return;
    if (was) bus.render();
    retry = Math.min(retry + 1, 5);
    setTimeout(connect, [0, 500, 1000, 2000, 4000, 8000][retry]);
  };
}

export const isOpen = () => ws?.readyState === WebSocket.OPEN;

export function send(msg, { lock = true } = {}) {
  if (!isOpen()) {
    toast('Нет связи — переподключаемся…');
    return false;
  }
  ws.send(JSON.stringify(msg));
  if (lock) setBusy(true);
  return true;
}

/** One request at a time: a second tap never races the first. */
export function setBusy(on) {
  net.busy = on;
  clearTimeout(busyTimer);
  if (on) busyTimer = setTimeout(() => setBusy(false), 4000);
  document.querySelector('.panel')?.classList.toggle('busy', on);
}
