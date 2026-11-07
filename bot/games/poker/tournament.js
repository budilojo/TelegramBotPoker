/** One-table tournament. Chip movements still go through the poker room rules. */
import * as R from '../../room.js';
import { cleanName } from '../../fmt.js';

export const TOURNAMENT_CODE = /^t_([a-z2-9]{10})$/;
export const TOUR_ERRORS = {
  TOUR_CONFIG: 'Проверьте название, число игроков, стек и уровни блайндов.',
  TOUR_EXISTS: 'У вас уже есть открытый турнир.',
  TOUR_FULL: 'Все места в турнире заняты.',
  TOUR_LOCKED: 'Регистрация закрылась с первой раздачей.',
  TOUR_ACTION: 'Это действие недоступно в турнире.',
  TOUR_TOPUP: 'Докупка доступна один раз после вылета, добавка — один раз между раздачами.',
};

const inRange = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

export function createTournament(app, user, msg) {
  const name = typeof msg.name === 'string' ? cleanName(msg.name, '', 40) : '';
  const { seats, stack, levels } = msg;
  if (!name || !inRange(seats, 2, R.MAX_SEATS) || !inRange(stack, 2, 100_000_000)
    || !Array.isArray(levels) || !inRange(levels.length, 1, 20)) return { error: 'TOUR_CONFIG' };
  const blindLevels = [];
  for (const level of levels) {
    const prev = blindLevels.at(-1);
    if (!level || !inRange(level.small, 1, 1_000_000) || !inRange(level.big, level.small, 2_000_000)
      || !inRange(level.seconds, 10, 3600) || (prev && (level.small < prev.small || level.big <= prev.big))) {
      return { error: 'TOUR_CONFIG' };
    }
    blindLevels.push({ small: level.small, big: level.big, seconds: level.seconds });
  }
  if (blindLevels[0].big > stack) return { error: 'TOUR_CONFIG' };
  if ([...app.rooms.values()].some(r => r.tournament && r.hostId === user.id && r.status !== 'finished')) return { error: 'TOUR_EXISTS' };
  const first = blindLevels[0];
  const room = R.createRoom({ chatId: `tournament:${user.id}`, title: name, host: app.person(user),
    startingStack: stack, smallBlind: first.small, bigBlind: first.big });
  room.game = 'poker';
  room.createdAt = app.clock.now();
  room.settings.turnSeconds = 30;
  room.tournament = { seats, levels: blindLevels, index: 0, clock: null };
  app.rooms.set(room.code, room);
  return room;
}

export function parkTournament(room, now) {
  const timer = room.tournament?.clock;
  if (timer?.deadline != null) {
    timer.remaining = Math.max(0, timer.deadline - now);
    timer.deadline = null;
  }
}

export function tournamentClock(app, room, now) {
  const t = room.tournament;
  if (!t) return null;
  if (room.status === 'paused') parkTournament(room, now);
  if (room.status !== 'playing') return null;
  const key = `level:${t.index}`;
  if (t.clock?.key !== key) t.clock = { key, remaining: t.levels[t.index].seconds * 1000, deadline: null };
  if (t.clock.done) return null;
  t.clock.deadline ??= now + t.clock.remaining;
  return {
    id: 'tournament', timer: t.clock,
    fire: () => {
      if (room.status !== 'playing' || app.down || app.roomByCode(room.code) !== room || t.clock?.key !== key) return;
      const time = app.clock.now();
      if (time < t.clock.deadline) return app.syncClocks();
      const next = t.levels[t.index + 1];
      if (next) {
        const boundary = t.clock.deadline;
        t.index++;
        t.clock = { key: `level:${t.index}`, remaining: next.seconds * 1000, deadline: boundary + next.seconds * 1000 };
        room.pendingBlinds = { sb: next.small, bb: next.big };
      } else t.clock = { key, done: true, remaining: 0, deadline: null };
      return app.draw(room);
    },
  };
}

function topUpAllowed(room, player, rebuy, now) {
  if (!player || !player.inHand || room.status !== 'playing' || room.hand?.phase !== 'complete' || room.ui.reveal) return false;
  if (room.autoNext?.deadline != null && now >= room.autoNext.deadline) return false;
  return rebuy ? player.stack === 0 && !player.tourRebuys : player.stack > 0 && !player.tourAddons;
}

export function topUp(room, uid, rebuy, now) {
  const p = room.players.find(x => x.id === String(uid));
  if (!topUpAllowed(room, p, rebuy, now)) return { error: 'TOUR_TOPUP' };
  const r = R.adjustStack(room, room.hostId, p.id, room.settings.startingStack);
  if (!r.error) {
    if (rebuy) p.tourRebuys = 1;
    else p.tourAddons = 1;
  }
  return r;
}

export function tournamentView(room, view, uid) {
  const t = room.tournament;
  const mine = room.players.find(p => p.id === String(uid));
  return {
    seats: t.seats, level: t.index + 1, current: t.levels[t.index], next: t.levels[t.index + 1] ?? null,
    deadline: view.room.status === 'playing' ? t.clock?.deadline ?? null : null,
    remaining: t.clock?.remaining ?? null,
    canRebuy: topUpAllowed(room, mine, true, view.now), canAddon: topUpAllowed(room, mine, false, view.now),
    leaders: view.players.map(p => ({
      seat: p.seat, name: p.name, stack: p.stack,
      rebuy: room.players[p.seat].tourRebuys || 0, addon: room.players[p.seat].tourAddons || 0,
      eliminated: p.stack === 0 && !(p.inHand && (view.hand?.phase !== 'complete' || view.hand?.revealing)),
    })).sort((a, b) => b.stack - a.stack || Number(a.eliminated) - Number(b.eliminated) || a.seat - b.seat),
  };
}
