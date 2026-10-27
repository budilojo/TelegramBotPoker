/**
 * collections: чистые функции вида. Из `room.look` (снимок раздачи) делают то, что
 * уходит страницам. Идентификаторы людей наружу не идут: рубашки — по номеру места,
 * рамка — прямо в записи игрока. Старая комната без `look` читается как база.
 */
export const BASE_LOOK = Object.freeze({ v: 1, table: null, backs: Object.freeze([]), dealNo: 0 });

const pick = (x) => (x && typeof x.item === 'string' && typeof x.color === 'string' ? { item: x.item, color: x.color } : null);

/** Рамка и знак игрока (публично) — из снимка; нет записи — null (база). */
export function frameOf(room, playerId) {
  return pick(room?.look?.frames?.[String(playerId)]);
}

/** Поле `look` персонального вида. `withBacks` — только покер. */
export function lookView(room, { withBacks = false } = {}) {
  const l = room?.look;
  if (!l || l.v !== 1) return { v: 1, table: null, backs: [], dealNo: 0 };
  const backs = [];
  if (withBacks) {
    room.players.forEach((p, seat) => {
      const b = pick(l.backs?.[p.id]);
      if (b) backs.push({ seat, item: b.item, color: b.color });
    });
  }
  return { v: 1, table: pick(l.table), backs, dealNo: Number.isInteger(l.dealNo) ? l.dealNo : 0 };
}
