/**
 * Рейтинговые столы — путь «выбор игры → столы → присоединиться».
 *
 * Пока рейтинг закрыт (`RATING_SOON`), этого пути нет вовсе: сервер не
 * отвечает на запрос столов, а отказывает словами. Когда рейтинг откроется,
 * здесь окажутся только столы, которые сами заявлены рейтинговыми
 * (`room.ranked === true`) — такого признака у столов пока никто не ставит,
 * потому что «рейтинговый стол» ещё не придуман (docs/ranked.md, раздел
 * «Что мешает включить»). Обычный стол группы сюда не попадёт никогда:
 * похожим на рейтинговый его делает только флаг, а не название и не группа.
 */

import { gameOf } from './games/index.js';

/** Столы игры, куда этот человек может сесть: рейтинговые, открытые, из его групп. */
export function rankedTables(app, userId, gameId) {
  const chats = new Set(app.groupsOf(userId).map((g) => g.chatId));
  const out = [];
  for (const chatId of chats) {
    for (const room of app.liveRooms(chatId)) {
      if (room.ranked !== true) continue; // единственное, что делает стол рейтинговым
      if (room.game !== gameId || room.status !== 'lobby') continue;
      const sum = gameOf(room).summary(room);
      out.push({
        code: room.code,
        host: room.players.find((p) => p.id === room.hostId)?.name || '',
        seated: sum.seated,
        max: sum.max,
        detail: sum.detail || '',
      });
    }
  }
  return out;
}
