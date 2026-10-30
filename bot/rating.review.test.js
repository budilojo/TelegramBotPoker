'use strict';
/**
 * Проверка рейтинга перед релизом (docs/next-release/rating-review.md).
 * Рейтинг по-прежнему закрыт; здесь — дыры, найденные при проверке:
 *   1. покерный вечер из одной раздачи, закрытый хостом/«завершить все»/простоем,
 *      давал +20/−10 — самая дешёвая накрутка;
 *   2. ничья в покере отдавала победу тому, кто сидит раньше (хосту);
 * и то, что должно оставаться верным: партии с ботами и косметика очков не двигают.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Store, NullStore } from './store.js';
import { apply } from './rating.js';
import poker, { RATED_MIN_HANDS } from './games/poker/index.js';
import * as R from './room.js';
import { Table } from './harness.js';
import durak from './games/durak/index.js';

function evening({ hands, stacks, buyIn = 10000 }) {
  const room = R.createRoom({ chatId: '-1', host: { id: 1, name: 'Хост' } });
  R.addPlayer(room, { id: 2, name: 'Вася' });
  room.status = 'finished';
  room.players.forEach((p, i) => {
    p.stats.handsPlayed = hands;
    p.stats.buyIn = buyIn;
    p.stack = stacks[i];
  });
  return room;
}

test('покер: вечер из одной раздачи, закрытый хостом, очков не даёт', () => {
  const room = evening({ hands: 1, stacks: [15000, 5000] });
  const [round] = poker.rounds(room);
  assert.equal(round.short, true);
  const store = new NullStore();
  const out = apply(store, { ...round, game: 'poker', round: round.id });
  assert.equal(out.skipped, 'SHORT');
  assert.equal(store.ratingTop('poker').length, 0, 'в таблицу никто не попал');
});

test(`покер: вечер из ${RATED_MIN_HANDS} раздач засчитывается`, () => {
  const room = evening({ hands: RATED_MIN_HANDS, stacks: [15000, 5000] });
  const out = apply(new NullStore(), { ...poker.rounds(room)[0], game: 'poker', round: 'x' });
  assert.ok(out.ok);
  assert.deepEqual(out.rows.map((r) => [r.userId, r.delta]), [['1', 20], ['2', -10]]);
});

test('покер: естественный конец (все фишки у одного) считается при любой длине', () => {
  const room = evening({ hands: 1, stacks: [20000, 0] });
  const [round] = poker.rounds(room);
  assert.equal(round.short, false);
  assert.ok(apply(new NullStore(), { ...round, game: 'poker', round: 'n' }).ok);
});

test('покер: ничья на первом месте — очков нет, хост не выигрывает «по рассадке»', () => {
  const room = evening({ hands: 20, stacks: [10000, 10000] });
  const [round] = poker.rounds(room);
  assert.equal(round.draw, true);
  assert.equal(apply(new NullStore(), { ...round, game: 'poker', round: 'd' }).skipped, 'DRAW');
});

test('партия с ботами (room.solo) в рейтинг не идёт, даже если игра доиграна', () => {
  const store = new Store(':memory:');
  const t = new Table({ store });
  const room = evening({ hands: 30, stacks: [15000, 5000] });
  room.game = 'poker';
  room.solo = { owner: '1' };
  assert.deepEqual(t.app.rate(room), []);
  assert.equal(store.ratingTop('poker').length, 0);
  // Тот же вечер без признака — считается: проверка не пустая.
  delete room.solo;
  assert.equal(t.app.rate(room).length, 1);
  assert.equal(store.ratingTop('poker').length, 2);
  store.close();
});

test('очки не зависят от косметики и покупок: рейтинг их не импортирует', () => {
  for (const f of ['bot/rating.js', 'bot/ranked.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import .* from '(.+)';/gm)].map((m) => m[1]);
    for (const i of imports) assert.doesNotMatch(i, /collection|payment|shop|cosmetic|graphit/i, `${f} тянет ${i}`);
  }
});

test('дурак: ничья («карты кончились у всех разом») очков не даёт', () => {
  const room = { code: 'D1', game: 'durak', players: [{ id: '1', name: 'А' }, { id: '2', name: 'Б' }, { id: '3', name: 'В' }],
    history: [{ no: 1, fool: null, draw: true, out: ['1', '2', '3'] }] };
  const [round] = durak.rounds(room);
  assert.equal(round.draw, true);
  const store = new NullStore();
  assert.equal(apply(store, { ...round, game: 'durak', round: round.id }).skipped, 'DRAW');
  assert.equal(store.ratingTop('durak').length, 0, 'ни +20, ни +12 никому');
});
