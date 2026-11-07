import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock, Table, user, stack, initDataFor } from './harness.js';
import { Store } from './store.js';
import { productMetrics } from './product-metrics.js';

const owner = user(401, 'Вера'), guest = user(402, 'Илья'), viewer = user(403, 'Лида');
const config = { t: 'tournament-create', name: 'Вечерний турнир', seats: 2, stack: 100,
  levels: [{ small: 5, big: 10, seconds: 10 }, { small: 10, big: 20, seconds: 20 }] };
const open = (t, person, room) => t.open(person, { initData: initDataFor(person, { clock: t.clock }), room: `t_${room.code}` });

async function setup(t, options = config) {
  t.openSolo(owner);
  await t.send(owner, options);
  const room = t.app.roomByCode(t.state(owner).room.code);
  assert.ok(open(t, guest, room).session);
  assert.ok(open(t, viewer, room).session);
  await t.send(guest, { t: 'sit', id: viewer.id });
  return room;
}

test('tournament route, identity, registration limit, blinded timer and next hand', async () => {
  const store = new Store();
  const t = new Table({ store });
  const room = await setup(t);
  try {
    assert.equal(t.state(owner).tournament.share.endsWith(`startapp=t_${room.code}`), true);
    assert.equal(t.state(viewer).tournament.leaders.length, 2);
    assert.deepEqual(room.players.map(p => p.id), [String(owner.id), String(guest.id)]);
    await t.send(viewer, { t: 'sit', id: owner.id });
    assert.equal(t.lastError(viewer).code, 'TOUR_FULL');
    await t.send(guest, { t: 'start', id: owner.id });
    assert.equal(t.lastError(guest).code, 'NOT_HOST');
    await t.send(owner, { t: 'start' });
    assert.equal(t.state(viewer).tournament.deadline, t.clock.now() + 10_000);
    await t.send(viewer, { t: 'sit' });
    assert.equal(t.lastError(viewer).code, 'TOUR_LOCKED');
    await t.send(owner, { t: 'settings', bigBlind: 999 });
    assert.equal(t.lastError(owner).code, 'TOUR_ACTION');
    await t.clock.advance(4000);
    await t.send(owner, { t: 'pause' });
    assert.equal(t.state(guest).tournament.remaining, 6000);
    await t.clock.advance(60_000);
    assert.equal(t.state(guest).tournament.level, 1);
    await t.send(owner, { t: 'resume' });
    await t.clock.advance(6000);
    assert.equal(t.state(guest).tournament.level, 2);
    assert.equal(t.state(guest).tournament.current.big, 20);
    assert.equal(room.settings.bigBlind, 10);
    assert.equal(t.state(viewer).players.every(p => p.cards === null), true);
    const actor = room.hand.actorId === String(owner.id) ? owner : guest;
    await t.act(actor, 'fold');
    assert.equal(t.state(viewer).tournament.leaders[0].stack >= t.state(viewer).tournament.leaders[1].stack, true);
    await t.clock.advance(15_000);
    assert.equal(room.handNo, 2);
    assert.equal(room.settings.bigBlind, 20);
    const { activity, tournaments } = productMetrics(store.db, t.clock.now(), t.app.rooms.values());
    assert.deepEqual(tournaments, { active: 1, average: 2 });
    assert.equal(activity.nsm, 2, 'watching is not participation');
  } finally { store.close(); }
});

test('rebuy is only the signed player and once; add-on has the same limit; bad schedule creates nothing', async () => {
  const t = new Table({ deck: stack({ [owner.id]: 'As Ah', [guest.id]: 'Kd Kc' }, '2s 7h 9d Jc 3s') });
  t.openSolo(owner);
  await t.send(owner, { ...config, levels: [{ small: 10, big: 5, seconds: 10 }] });
  assert.equal(t.lastError(owner).code, 'TOUR_CONFIG');
  assert.equal(t.app.rooms.size, 0);
  const room = await setup(t);
  await t.send(owner, { t: 'start' });
  const actor = room.hand.actorId === String(owner.id) ? owner : guest;
  await t.act(actor, 'allin');
  const other = actor === owner ? guest : owner;
  await t.act(other, 'call');
  assert.equal(room.hand.phase, 'complete');
  assert.equal(t.state(viewer).tournament.leaders[1].eliminated, true);
  await t.send(viewer, { t: 'tour-rebuy', id: guest.id, seq: room.seq });
  assert.equal(t.lastError(viewer)?.code, 'TOUR_TOPUP');
  await t.send(guest, { t: 'tour-rebuy', seq: room.seq - 1 });
  assert.equal(t.lastError(guest)?.code, 'STALE');
  const deadline = room.autoNext.deadline;
  room.autoNext.deadline = t.clock.now();
  await t.send(guest, { t: 'tour-rebuy', seq: room.seq });
  assert.equal(t.lastError(guest)?.code, 'TOUR_TOPUP', 'an expired top-up cannot race the timer');
  room.autoNext.deadline = deadline;
  await t.send(guest, { t: 'tour-rebuy', seq: room.seq });
  await t.send(owner, { t: 'tour-addon', id: guest.id, seq: room.seq });
  await t.send(owner, { t: 'tour-addon', seq: room.seq });
  assert.equal(t.lastError(owner).code, 'TOUR_TOPUP');
  assert.deepEqual(t.state(viewer).tournament.leaders.map(p => [p.name, p.stack, p.rebuy, p.addon]), [
    ['Вера', 300, 0, 1], ['Илья', 100, 1, 0],
  ]);
  await t.clock.advance(15_000);
  assert.equal(room.handNo, 2);
});

test('tournament survives restart and maintenance with its current blind time and stack', async () => {
  const store = new Store();
  const t = new Table({ store });
  try {
    const room = await setup(t);
    await t.send(owner, { t: 'start' });
    await t.clock.advance(2000);
    t.app.save(room);
    const next = new Table({ store, clock: t.clock });
    next.app.load();
    await next.app.resume();
    const restored = next.app.roomByCode(room.code);
    assert.ok(open(next, guest, restored).session);
    assert.equal(next.state(guest).tournament.deadline, t.clock.now() + 8000);
    next.app.setMaintenance(true);
    assert.equal(restored.tournament.clock.deadline, null);
    assert.equal(restored.tournament.clock.remaining, 8000);
    next.app.setMaintenance(false);
    assert.equal(next.state(guest).tournament.deadline, t.clock.now() + 8000);
    assert.deepEqual(restored.players.map(p => p.stack), room.players.map(p => p.stack));
  } finally { store.close(); }
});

test('an auto-deal tied with a blind deadline after restart uses the new blinds', async () => {
  const store = new Store();
  try {
    const before = new Table({ store });
    const room = await setup(before, { ...config, levels: [{ ...config.levels[0], seconds: 15 }, config.levels[1]] });
    await before.send(owner, { t: 'start' });
    const actor = room.hand.actorId === String(owner.id) ? owner : guest;
    await before.act(actor, 'fold');
    assert.equal(room.autoNext.deadline, room.tournament.clock.deadline);
    const after = new Table({ store, clock: new FakeClock(before.clock.now()) });
    after.app.load();
    await after.app.resume();
    await after.clock.advance(15_000);
    const restored = after.app.roomByCode(room.code);
    assert.equal(restored.handNo, 2);
    assert.equal(restored.tournament.index, 1);
    assert.equal(restored.settings.bigBlind, 20, 'the next hand posts the next level even when its timer fires first');
  } finally { store.close(); }
});

test('the last stack wins after the rebuy window and only participants get a resume shortcut', async () => {
  const t = new Table({ deck: stack({ [owner.id]: 'As Ah', [guest.id]: 'Kd Kc' }, '2s 7h 9d Jc 3s') });
  const room = await setup(t);
  await t.send(owner, { t: 'start' });
  const actor = room.hand.actorId === String(owner.id) ? owner : guest;
  await t.act(actor, 'allin');
  await t.act(actor === owner ? guest : owner, 'call');
  assert.equal(t.state(guest).tournament.canRebuy, true);
  await t.clock.advance(15_000);
  assert.equal(t.state(guest).room.status, 'finished');
  assert.equal(t.state(viewer).tournament.leaders[0].name, 'Вера');
  assert.equal(t.state(viewer).tournament.leaders[1].eliminated, true);
  await t.send(viewer, { t: 'hub' });
  assert.deepEqual(t.state(viewer).myTournaments, []);
  await t.send(viewer, { t: 'tournament-resume', code: room.code, user: guest.id });
  assert.equal(t.lastError(viewer)?.code, 'NO_ROOM');
  await t.send(guest, { t: 'hub' });
  assert.deepEqual(t.state(guest).myTournaments, [{ code: room.code, title: config.name, status: 'finished', host: false }]);
  await t.send(guest, { t: 'tournament-resume', code: room.code });
  assert.equal(t.state(guest).room.status, 'finished');
});
