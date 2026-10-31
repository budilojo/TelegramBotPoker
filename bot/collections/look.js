/** Explicit public projection. No private ids, entitlements, paths or game data. */
import { publicEntry } from '../../miniapp/collections/catalog.js';
export const BASE_LOOK = Object.freeze({ v: 1, table: null, backs: Object.freeze([]), dealNo: 0 });
export function frameOf(room, uid) {
  if (![1, 2].includes(room?.look?.v)) return null;
  return publicEntry(room.look.frames?.[String(uid)], ['profile', 'frame']);
}
export function badgeOf(room, uid) {
  if (room?.look?.v !== 2) return null;
  return publicEntry(room.look.badges?.[String(uid)], 'badge', room.game);
}
export function lookView(room, { withBacks = false } = {}) {
  const l = room?.look;
  if (![1, 2].includes(l?.v)) return { ...BASE_LOOK, backs: [] };
  const backs = [];
  if (withBacks && room.game === 'poker') room.players.forEach((p, seat) => {
    const b = publicEntry(l.backs?.[p.id], 'cardback', 'poker');
    if (b) backs.push({ seat, ...b });
  });
  const out = { v: l.v, table: publicEntry(l.table, 'table', room.game), backs, dealNo: Number.isInteger(l.dealNo) ? l.dealNo : 0 };
  if (l.v === 2) {
    out.board = publicEntry(l.board, `${room.game === 'battleship' ? 'battleship-panel' : `${room.game}-board`}`, room.game);
    out.deckBack = publicEntry(l.deckBack, 'unoq-cardback', room.game);
  }
  return out;
}
