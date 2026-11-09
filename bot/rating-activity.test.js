import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, NullStore } from './store.js';
import { RatingReview } from './rating-review.js';
import { Table, user } from './harness.js';

for (const Storage of [Store, NullStore]) test(`рейтинг по числу партий и сброс (${Storage.name})`, t => {
  const store = new Storage();
  t.after(() => store.close?.());
  const record = (userId, round, delta, at, chatId = '-1') =>
    store.rate({ userId, game: 'chess', round, place: delta > 0 ? 1 : 2, of: 2, delta, at, chatId });
  const now = Date.UTC(2026, 10, 8), old = Date.UTC(2026, 9, 8);
  record('1', 'b', 20, old);
  record('1', 'c', 20, old);
  record('1', 'a', 20, now);
  record('2', 'd', -10, now);
  record('2', 'e', -10, now);
  record('3', 'f', 20, now, '-2');
  assert.deepEqual(store.activityRating('chess').map(r => [r.userId, r.played]), [['1', 3], ['2', 2], ['3', 1]]);
  const month = { month: '2026-11', chatId: '-1' };
  assert.deepEqual(store.activityRating('chess', month).map(r => [r.userId, r.played, r.points]), [['2', 2, 0], ['1', 1, 20]]);
  assert.equal(store.activityRating('chess', { ...month, userId: '1' })[0].place, 2);
  store.countParty('existing-limit', now);
  assert.equal(store.resetRating(0), true);
  assert.deepEqual(store.activityRating('chess'), []);
  assert.deepEqual(store.activityRating('chess', month), []);
  assert.deepEqual(store.ratingLog('1', 'chess'), []);
  assert.equal(store.partyCount('existing-limit', now), 1);
  assert.equal(record('1', 'a', 20, now), false, 'old round remains deduplicated');
  assert.equal(record('1', 'new', 20, now), true);
  assert.equal(store.resetRating(0), false, 'retry does not reset new results');
  assert.equal(store.activityRating('chess', month)[0].played, 1);
  assert.deepEqual(store.ratingLog('1', 'chess').map(r => r.round), ['new']);
});

test('пульт: наблюдение и записи только владельцу, сброс с подтверждением', async ctx => {
  const store = new Store();
  const owner = user(101, 'Владелец'), a = user(201, 'Первый'), b = user(202, 'Второй');
  const t = new Table({ store, admins: [String(owner.id)], ratingSoon: false, rankedTablesSoon: true });
  ctx.after(() => { t.app.stop(); store.close(); });
  t.openAdmin(owner);
  t.openSolo(a);
  await t.send(a, { t: 'ratingWatch', userId: String(a.id), on: true });
  assert.deepEqual(store.ratingWatch(), []);
  await t.send(owner, { t: 'ratingWatch', userId: String(a.id), on: true });
  await t.cmd(a, '/game');
  t.openHub(a);
  await t.send(a, { t: 'rating-play', game: 'chess', code: 'foreign-group' });
  assert.equal(t.lastError(a).code, 'NOT_YOUR_GROUP');
  await t.send(a, { t: 'rating-play', game: 'chess', code: t.group.code });
  assert.equal(t.state(a).playGame, 'chess');
  await t.send(a, { t: 'create', game: 'chess' });
  const room = t.app.roomByCode(t.state(a).room.code);
  t.openRoom(b, room);
  await t.send(b, { t: 'sit' });
  await t.send(a, { t: 'start' });
  await t.send(b, { t: 'move', from: 'e7', to: 'e5' }); // пока чужой ход
  await t.send(a, { t: 'move', from: 'e2', to: 'e4', cards: ['AS'], userId: b.id });
  await t.send(b, { t: 'move', from: 'e7', to: 'e5' });
  await t.send(a, { t: 'resign' });
  const [review] = store.ratingReviews();
  assert.ok(review?.watched);
  assert.deepEqual(review.actions.map(x => [x.actor, x.action, x.detail]), [
    [String(a.id), 'move', 'e2 → e4'], [String(b.id), 'move', 'e7 → e5'], [String(a.id), 'resign', undefined],
  ]);
  assert.doesNotMatch(JSON.stringify(review), /"cards"|AS/);
  await t.send(owner, { t: 'ratingReview', key: review.key });
  assert.equal(t.state(owner).ratingAdmin.selected.key, review.key);
  await t.send(b, { t: 'ratingReview', key: review.key });
  assert.equal(t.state(b).ratingAdmin, undefined);
  assert.doesNotMatch(t.received(b), /"ratingAdmin"|"actions"/);
  await t.send(owner, { t: 'ratingReset', generation: 0, confirm: 'нет' });
  assert.equal(t.lastError(owner).code, 'RATING_RESET_CONFIRM');
  await t.send(b, { t: 'ratingReset', generation: 0, confirm: 'СБРОСИТЬ' });
  assert.equal(store.ratingGeneration(), 0);
  await t.send(owner, { t: 'ratingReset', generation: 0, confirm: 'СБРОСИТЬ' });
  assert.equal(store.ratingGeneration(), 1);
  assert.equal(store.ratingReviews().length, 1, 'moderation remains available after reset');
});

test('лимиты и короткая партия попадают в журнал без ручного наблюдения', () => {
  const store = new NullStore();
  const review = new RatingReview(store);
  const room = { code: 'abcde', game: 'poker', seq: 1, players: [{ id: '1' }, { id: '2' }] };
  const round = { id: room.code, places: room.players };
  review.finish(room, round, { ok: true }, 10);
  assert.deepEqual(store.ratingReviews(), []);
  const entry = review.before(room, { t: 'act', action: 'raise', amount: 100, cards: ['AS'] }, '1');
  room.seq++;
  review.accepted(room, entry, 11);
  review.finish(room, round, { skipped: 'FARMED' }, 12);
  const [record] = store.ratingReviews();
  assert.equal(record.reason, 'FARMED');
  assert.equal(record.watched, false);
  assert.deepEqual(record.actions, [{ at: 11, actor: '1', action: 'raise', detail: '100' }]);
});
