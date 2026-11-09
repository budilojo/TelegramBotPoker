import { gameOf } from './games/index.js';

// A namespace distinct from Telegram chats, solo games and tournaments.
export const rankedKey = (game) => `ranked:${game}`;
export const isRanked = (room) => !!room && room.chatId === rankedKey(room.game);
export const rankedMember = (room, userId) => room.players.some(
  (p) => p.id === String(userId) && !p.left && !p.kicked && p.seated !== false,
);
export const rankedRoundActive = (room) => {
  if (room.status !== 'playing') return false;
  if (room.hand) return room.hand.phase !== 'complete';
  if (room.deal) return room.deal.phase === 'play';
  return !!room.match && !room.match.over;
};
export const rankedSettings = {
  poker: { startingStack: 10000, smallBlind: 25, bigBlind: 50, turnSeconds: 45, blindMode: 'fixed' },
  durak: { variant: 'podkidnoy', turnSeconds: 30 },
  colors: { turnSeconds: 30 },
};

export function rankedTables(app, userId, gameId) {
  const mine = app.liveRooms(rankedKey(gameId)).find(room => rankedMember(room, userId));
  return app.liveRooms(rankedKey(gameId)).filter(room => {
    if (room === mine) return true;
    if (mine || room.status !== 'lobby') return false;
    const { seated, max } = gameOf(room).summary(room);
    return seated > 0 && seated < max && !room.players.some(p => p.id === String(userId) && p.kicked);
  }).map(room => {
    const { seated, max, detail } = gameOf(room).summary(room);
    return {
      code: room.code,
      host: room.players.find(p => p.id === room.hostId)?.name || '',
      mine: room === mine,
      seated,
      max,
      detail: detail || '',
    };
  }).sort((a, b) => b.seated - a.seated);
}
