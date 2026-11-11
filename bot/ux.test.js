import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.js';
import { Table, TEST_TOKEN, user } from './harness.js';
import { signInitData } from './webapp-auth.js';
import { UX } from './ux.js';

function fixture(t) {
  const store = new Store(); store.setSetting('ux-environment', 'ux-test');
  const table = new Table({ store });
  const ux = new UX({ app: table.app, botToken: TEST_TOKEN, testers: ['1'], enabled: true });
  t.after(() => { table.app.stop(); store.close(); });
  const request = (op, fields = {}, id = 1) => ux.request({ op, initData: signInitData({ user: user(id, 'Тест'), auth_date: Math.floor(table.clock.now() / 1000) }, TEST_TOKEN), ...fields });
  return { store, table, ux, request };
}

test('UX: production and unmarked stores fail closed', () => {
  const store = new Store();
  try {
    store.setSetting('ux-environment', 'ux-test');
    assert.throws(() => new UX({ app: { store }, enabled: false }), /выключен/);
    store.setSetting('ux-environment', null);
    assert.throws(() => new UX({ app: { store }, enabled: true }), /База/);
  } finally { store.close(); }
});

test('UX: signed identity, allowlist and arbitrary target substitution', t => {
  const { store, ux, request } = fixture(t);
  store.putProfile('1', { nickname: 'Первый', avatar: 'av01' });
  store.putProfile('2', { nickname: 'Второй', avatar: 'av02' });
  assert.equal(ux.request({ op: 'reset', initData: 'user=1' }).status, 401);
  assert.equal(request('reset', {}, 2).status, 403);
  assert.equal(request('export', {}, 2).status, 403);
  assert.equal(request('reset', { userId: '2', id: '2' }).ok, true);
  assert.equal(store.getProfile('1').nickname, null);
  assert.equal(store.getProfile('2').nickname, 'Второй');
});

test('UX: active games including hosted lobbies block reset without changes', t => {
  const { store, table, request } = fixture(t);
  store.putProfile('1', { nickname: 'Первый', avatar: 'av01' });
  const room = { status: 'playing', hostId: '2', players: [{ id: '1' }] };
  table.app.rooms.set('fake', room);
  assert.equal(request('reset').status, 409);
  assert.equal(store.getProfile('1').nickname, 'Первый');
  room.players[0].left = true; room.hostId = '1'; room.status = 'lobby';
  assert.equal(request('reset').status, 409);
  room.status = 'finished';
  assert.equal(request('reset').ok, true);
  assert.deepEqual(room.players, [{ id: '1', left: true }]);
});

test('UX: reset clears training, cache, memberships and own settings atomically, preserves global and other users', t => {
  const { store, table, request } = fixture(t);
  store.putProfile('1', { nickname: 'Первый', avatar: 'av01' });
  table.app.profiles.raw('1');
  for (const id of ['1','2']) store.db.prepare('INSERT INTO train_skill (user_id, skill, level) VALUES (?, ?, ?)').run(id, 'math', 4);
  store.setSetting('cosmetic:talisman-hidden:1', true); store.setSetting('cosmetic:talisman-hidden:2', true);
  const g = { code: 'group', chatId: '-42', members: ['1', '2'] }; table.app.groups.set('-42', g); store.saveGroup(g);
  const prod = new Store(); t.after(() => prod.close()); prod.putProfile('1', { nickname: 'Боевой', avatar: 'av01' });
  assert.equal(request('reset').ok, true);
  assert.equal(table.app.profiles.raw('1').nickname, null);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM train_skill WHERE user_id = ?').get('1').n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM train_skill WHERE user_id = ?').get('2').n, 1);
  assert.equal(store.getSetting('cosmetic:talisman-hidden:1'), null);
  assert.equal(store.getSetting('cosmetic:talisman-hidden:2'), true);
  assert.deepEqual(g.members, ['2']); assert.deepEqual(store.loadGroups()[0].members, ['2']);
  assert.equal(prod.getProfile('1').nickname, 'Боевой');
  assert.equal(request('reset').ok, true);
});

test('UX: consent, own-session authorization, safe schema, stop and erasure', t => {
  const { request } = fixture(t);
  assert.equal(request('event', { name: 'app_open', screen: 'home' }).status, 403);
  const { session } = request('consent', {}, 2);
  assert.match(session, /^[a-f0-9-]{36}$/);
  assert.equal(request('event', { session, name: 'app_open', screen: 'home', secret: 'never-store' }, 2).ok, true);
  assert.equal(request('event', { session, name: 'BOT_TOKEN', screen: 'home' }, 2).status, 400);
  assert.equal(request('delete', { session }).status, 403);
  const events = request('export').events;
  assert.equal(events.length, 1); assert.equal(events[0].name, 'app_open');
  assert.equal(JSON.stringify(events).includes('never-store'), false);
  assert.equal(request('stop', { session }, 2).ok, true);
  assert.equal(request('event', { session, name: 'home_view', screen: 'home' }, 2).status, 400);
  assert.equal(request('export').events.length, 1);
  assert.equal(request('delete', { session }, 2).ok, true);
  assert.equal(request('export').events.length, 0);
});

test('UX: failed reset rolls back all database changes', t => {
  const { store, table, request } = fixture(t);
  store.putProfile('1', { nickname: 'Сохранить', avatar: 'av01' });
  const g = { code: 'rollback', chatId: '-43', members: ['1', '2'] }; table.app.groups.set('-43', g); store.saveGroup(g);
  store.saveGroup = () => { throw new Error('simulated disk failure'); };
  assert.throws(() => request('reset'), /disk failure/);
  assert.equal(store.getProfile('1').nickname, 'Сохранить');
  assert.deepEqual(g.members, ['1', '2']);
});

test('UX: first-launch route is gated by environment and signed tester identity', t => {
  const { table, ux } = fixture(t);
  const signed = id => signInitData({ auth_date: Math.floor(table.clock.now() / 1000), user: user(id, 'Тестер'), start_param: 'nonexistent' }, TEST_TOKEN);
  const open = id => table.hub.open({ initData: signed(id), uxFirst: true }, () => {});
  assert.ok(open(1).error, 'production ignores UX hint');
  table.hub.ux = ux;
  assert.ok(open(2).error, 'respondent cannot bypass signed route');
  assert.equal(open(1).session.kind, 'solo');
});
