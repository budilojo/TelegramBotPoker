'use strict';
/**
 * Аудит: итоги игры уходят в группу ОДИН раз.
 *
 * «Завершить» на уже завершённой игре — не новое событие: правила отвечают
 * `noop`, и ядро не должно публиковать итоги ещё раз. Иначе хост (или
 * случайный двойной тап) засыпает группу одинаковыми «🏁 Итоги».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { GAME_LIST } from './games/index.js';

async function lobby(t, gameId, host, guest) {
  await t.cmd(host, '/game');
  t.openHub(host);
  await t.send(host, { t: 'create', game: gameId, settings: {} });
  const room = [...t.app.rooms.values()].find((r) => r.game === gameId);
  t.close(host);
  t.openRoom(host, room);
  t.openRoom(guest, room);
  await t.send(guest, { t: 'sit' });
  await t.send(host, { t: 'start' });
  return room;
}

for (const g of GAME_LIST) {
  for (const door of ['страница', 'команда /finish']) {
    test(`АУДИТ D-01: ${g.title} — «завершить» трижды (${door}) публикует итоги один раз`, async () => {
      const t = new Table();
      const host = user(101, 'Хост');
      const guest = user(202, 'Гость');
      const room = await lobby(t, g.id, host, guest);
      let finishes = 0;
      const finishUp = t.app.finishUp.bind(t.app);
      t.app.finishUp = (...a) => {
        finishes += 1;
        return finishUp(...a);
      };
      // Итоги — это именно текст `results` игры; короткий ответ «уже завершена» — не итоги.
      const posts = () => t.tg.calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(t.chatId) && c.text === g.results(room)).length;
      for (let i = 0; i < 3; i++) {
        if (door === 'страница') await t.send(host, { t: 'finish' });
        else await t.cmd(host, `/finish ${room.code}`);
        if (i === 0) {
          assert.equal(room.status, 'finished', 'игра завершена');
          var after = posts();
        }
      }
      assert.equal(finishes, 1, `finishUp вызван ${finishes} раз`);
      assert.equal(after, 1, 'итоги ушли');
      assert.equal(posts(), 1, 'повторное «завершить» не публикует итоги ещё раз');
      if (door !== 'страница') assert.match(t.lastPost(), /уже завершена/, 'а команде ответили словами');
    });
  }
}
