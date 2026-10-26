/**
 * The line to the server: one WebSocket that says hello with the signed
 * initData, gets back states (built for this person only) and sends
 * requests. Reconnects by itself and gets the whole state again.
 *
 * The page is a view, never a judge: every tap is a request the server
 * re-checks against the player's signed identity.
 */
import { tg, toast, haptic, openShare } from './ui.js';

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
  onShare: openShare,
  /** Смайлик за столом (miniapp/reactions.js ставит свой). */
  onReact: () => {},
  /** Рейтинговые столы игры (miniapp/rating.js). */
  onRanked: () => {},
  /** Чат за столом: chat, chat-sync, chat-unread (miniapp/chat.js ставит свой). */
  onChat: () => {},
  /** Не показывать тост об этом отказе (чат объясняет сам). */
  hideToast: () => false,
  /** Отказ сервера — после тоста; смайлики так узнают «подождите N с». */
  onError: () => {},
  /** Свой профиль (miniapp/profile.js ставит свой): { profile } или { error: {code, text} }. */
  onProfile: () => {},
  onShop: () => {},
  /** Личный прогресс «Тренировки» (miniapp/train/screens.js): { progress } или { error }. */
  onTrain: () => {},
};

let ws = null;
let retry = 0;
let clockOffset = 0; // server time − our time
let busyTimer = null;
/** Уже было соединение с сервером: следующее — переподключение. */
let connectedOnce = false;

export const serverNow = () => Date.now() + clockOffset;

export function connect() {
  const url = location.origin.replace(/^http/, 'ws') + '/ws';
  ws = new WebSocket(url);
  ws.onopen = () => {
    retry = 0;
    // A hub page that had stepped into a lobby asks for it again: the server
    // allows it only for a room of the group this page was opened for.
    // `back` — страница переподключается, а не открывается; `visible` — видна ли она:
    // свёрнутая страница стол «живым» не делает (иначе брошенный стол не закрыть).
    ws.send(JSON.stringify({ t: 'hello', initData, room: net.inside || startCode, back: connectedOnce, visible: !document.hidden }));
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
      connectedOnce = true;
      net.prev = net.state;
      net.state = msg.state;
      clockOffset = net.state.now - Date.now();
      // Where this page is now — asked for again after a reconnect. The server
      // lets a page back only into its own group's games (or its own groups).
      const st = net.state;
      if (startCode.startsWith('g_')) net.inside = st.kind === 'hub' ? null : st.room?.code || null;
      else if (startCode === 'solo') net.inside = st.kind === 'solo' ? null : st.room?.code || null;
      else if (startCode === 'admin') net.inside = null;
      else if (!startCode) net.inside = st.kind === 'hub' ? `g_${st.group.code}` : st.kind === 'home' ? null : st.room?.code || null;
      setBusy(false);
      bus.onState(wasConnected);
    } else if (msg.t === 'error') {
      setBusy(false);
      haptic.err();
      if (!bus.hideToast(msg)) toast(msg.text || 'Не получилось');
      bus.onError(msg);
    } else if (msg.t === 'rtables') {
      bus.onRanked(msg);
    } else if (msg.t === 'shop') {
      bus.onShop(msg);
    } else if (msg.t === 'profile') {
      bus.onProfile(msg);
    } else if (msg.t === 'train') {
      bus.onTrain(msg);
    } else if (msg.t === 'react') {
      bus.onReact(msg);
    } else if (msg.t === 'chat' || msg.t === 'chat-sync' || msg.t === 'chat-unread') {
      bus.onChat(msg);
    } else if (msg.t === 'share') {
      bus.onShare(msg);
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
