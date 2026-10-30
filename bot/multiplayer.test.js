/** Этап J: независимые страницы, весь поток, один App и несколько групп. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, initDataFor } from './harness.js';
import { GAME_LIST } from './games/index.js';
import { cardCode } from './view.js';
const codes = (cs) => cs.map(cardCode);

const HOST = user(101, 'Хост');
const GUEST = user(202, 'Гость');
const SPY = user(303, 'Зритель');
const clone = (x) => structuredClone(x);
const states = (p) => p.inbox.filter((m) => m.t === 'state').map((m) => m.state);
const state = (p) => states(p).at(-1);
const errors = (p) => p.inbox.filter((m) => m.t === 'error');
const seated = (r) => r.players.filter((p) => !p.left && !p.kicked && p.seated !== false && !p.sittingOut);
// Table.pages хранит лишь последнюю страницу личности. Здесь храним ВСЕ страницы,
// в том числе закрытые: иначе reconnect теряет ранние кадры и тест лжёт.
function page(t, who, code, opts = {}) {
  const p = { who, inbox: [] };
  const r = t.hub.open({ initData: initDataFor(who, { startParam: code, clock: t.clock }), ...opts }, (m) => {
    p.inbox.push(clone(m));
    if (m.t === 'state' && m.state.game) {
      const s = m.state;
      const room = t.app.roomByCode(s.room.code);
      // Эти поля никогда не являются публичной частью стола.
      const json = JSON.stringify(m);
      assert.doesNotMatch(json, /"(?:holes|fleets|initData|telegram_payment_charge_id|user_id|tgId|support_ticket|pay_order)"/);
      assert.doesNotMatch(json, /"hands":\{/);
      if (['chess', 'checkers', 'nardy', 'battleship'].includes(s.game)) for (const row of s.score) assert.equal(row.id, undefined, 'Telegram id не нужен в публичном счёте');
      if (['durak', 'colors'].includes(s.game)) {
        assert.deepEqual([...s.me.cards].sort(), [...(!room.deal?.aborted ? room.deal?.hands[String(who.id)] || [] : [])].sort());
        assert.equal(typeof s.deal?.[s.game === 'durak' ? 'talon' : 'deck'] === 'number' || !s.deal, true);
        for (const row of s.players) assert.equal(row.cards, undefined);
      }
      if (s.game === 'poker') {
        assert.deepEqual([...s.me.cards].sort(), codes(!room.hand?.live ? room.hand?.holes?.[String(who.id)] || [] : []).sort());
        if (room.hand?.phase === 'betting') for (const row of s.players) assert.equal(row.cards, null);
      }
      if (['chess', 'checkers', 'nardy'].includes(s.game) && s.match) {
        if (!s.me.color || s.match.over || s.match.turn !== s.me.color) assert.deepEqual(s.legal, { myTurn: false });
      }
      if (s.game === 'battleship' && s.match && !s.match.over) {
        for (const b of s.match.boards) if (s.me.side !== b.side) {
          // В этом сценарии ещё нет потопленных кораблей.
          assert.deepEqual(b.ships, []);
        }
        if (s.me.side == null || s.match.turn !== s.me.side) assert.deepEqual(s.legal, { myTurn: false });
      }
    }
  });
  assert.ok(r.session, r.text);
  p.session = r.session;
  p.send = async (m) => { await t.hub.handle(p.session, m); await t.app.settle(); };
  return p;
}
async function setup(g, ctx) {
  const t = new Table({ nardyDice: () => [5, 3], battleshipFleetRand: () => 0.37 });
  ctx.after(() => t.app.stop());
  await t.cmd(HOST, '/game');
  const h = page(t, HOST, `g_${t.group.code}`);
  await h.send({ t: 'create', game: g.id, settings: g.maxPlayers === 2 ? { base: 60 } : { turnSeconds: 30 }, reqId: 'j-create' });
  const room = t.app.roomByCode(h.session.code);
  const h2 = page(t, HOST, `g_${t.group.code}`, { room: room.code });
  const b = page(t, GUEST, `g_${t.group.code}`, { room: room.code });
  const spy = page(t, SPY, `g_${t.group.code}`, { room: room.code });
  return { t, room, h, h2, b, spy, pages: [h, h2, b, spy] };
}
const spoof = { id: HOST.id, uid: HOST.id, userId: HOST.id, user: HOST, player: HOST, seat: 0, side: 'w', color: 'w', hostId: HOST.id };
const patchOf = (g) => g.maxPlayers === 2 ? { base: 180, inc: 2 } : { turnSeconds: 60 };
function moveOf(g, s) {
  if (g.id === 'poker') return { t: 'act', action: s.legal.canCheck ? 'check' : 'call', seq: s.seq };
  if (g.id === 'durak') return { t: 'attack', card: s.legal.attack[0], seq: s.seq };
  if (g.id === 'colors') return s.legal.play.length ? { t: 'play', card: s.legal.play[0], color: 'R', seq: s.seq } : { t: 'draw', seq: s.seq };
  if (g.id === 'chess') { const [from, tos] = Object.entries(s.legal.to)[0]; return { t: 'move', from, to: tos[0], ply: s.match.plies, seq: s.seq }; }
  if (g.id === 'checkers') return { t: 'move', ...s.legal.moves[0], ply: s.match.plies, seq: s.seq };
  if (g.id === 'nardy') return { t: 'move', ...s.legal.next[0], turn: s.match.turns, seq: s.seq };
  return { t: 'fire', cell: 99, shot: s.match.shots, seq: s.seq };
}
async function begin(g, rig) {
  const { h, b, room } = rig;
  await b.send({ t: 'sit' });
  await h.send({ t: 'start' });
  assert.equal(room.status, 'playing');
  if (g.id === 'battleship') for (const p of [h, b]) { await p.send({ t: 'random' }); await p.send({ t: 'ready' }); }
}
const actor = (g, rig) => [rig.h, rig.b].find((p) => {
  const s = state(p);
  return g.id === 'poker' ? !!s.legal : g.id === 'durak' ? !!s.legal?.attack?.length : !!s.legal?.myTurn;
});

for (const g of GAME_LIST) {
  test(`J ${g.id}: две вкладки создают одно лобби, последнее место и повторный вход`, async (ctx) => {
    const rig = await setup(g, ctx);
    const { t, h, h2, room, b, spy } = rig;
    await h2.send({ t: 'hub' });
    await h2.send({ t: 'create', game: g.id, reqId: 'j-create' });
    assert.equal(h2.session.code, room.code);
    assert.equal(t.app.roomsOf(t.chatId).length, 1);
    // Заполняем до последнего свободного места; два реальных запроса конкурируют.
    for (let i = 1; i < g.maxPlayers - 1; i++) {
      const p = page(t, user(1000 + i, `Игрок ${i}`), room.code);
      await p.send({ t: 'sit' });
    }
    await Promise.all([b.send({ t: 'sit', ...spoof }), spy.send({ t: 'sit', ...spoof })]);
    assert.equal(seated(room).length, g.maxPlayers);
    const winner = seated(room).some((p) => p.id === String(GUEST.id)) ? b : spy;
    const loser = winner === b ? spy : b;
    assert.equal(errors(loser).at(-1)?.code, 'TABLE_FULL');
    assert.match(errors(loser).at(-1).text, /[А-Яа-я]/);
    await Promise.all([h.send({ t: 'sit' }), h2.send({ t: 'sit' })]);
    assert.equal(room.players.filter((p) => p.id === String(HOST.id)).length, 1);
    t.hub.close(h.session);
    assert.equal(state(h2).me.isHost, true);
    assert.equal(seated(room).length, g.maxPlayers);
    const restored = page(t, HOST, `g_${t.group.code}`, { room: room.code, back: true });
    assert.equal(state(restored).me.seat, state(h2).me.seat);
    assert.deepEqual(t.errors, []);
  });

  test(`J ${g.id}: изоляция столов/групп, полномочия, уход хоста`, async (ctx) => {
    const { t, h, h2, room, b, spy } = await setup(g, ctx);
    await b.send({ t: 'sit' });
    const other = t.app.ensureGroup('-777000', 'Другая группа');
    const outsider = page(t, GUEST, `g_${other.code}`);
    await outsider.send({ t: 'create', game: g.id, reqId: 'other-group' });
    const otherRoom = t.app.roomByCode(outsider.session.code);
    const otherBefore = JSON.stringify(otherRoom);
    const parallel = page(t, GUEST, `g_${t.group.code}`);
    await parallel.send({ t: 'create', game: g.id, reqId: 'same-group' });
    const neighbor = t.app.roomByCode(parallel.session.code);
    assert.notEqual(neighbor.code, room.code);
    const neighborBefore = JSON.stringify(neighbor);
    await h2.send({ t: 'hub' });
    await h2.send({ t: 'join', code: otherRoom.code });
    assert.equal(errors(h2).at(-1).code, 'NO_ROOM');
    await h2.send({ t: 'join', code: room.code });
    const before = clone(room.settings);
    for (const m of [{ t: 'settings', ...patchOf(g) }, { t: 'host' }, { t: 'kick' }, { t: 'finish' }, { t: 'drop' }]) {
      const n = errors(b).length;
      await b.send({ ...m, ...spoof });
      assert.equal(errors(b).length, n + 1, m.t);
      assert.match(errors(b).at(-1).text, /[А-Яа-я]/);
      assert.equal(room.hostId, String(HOST.id));
      assert.deepEqual(room.settings, before);
    }
    await h.send({ t: 'leave' });
    assert.ok(!seated(room).some((p) => p.id === String(HOST.id)), 'хост встал');
    assert.equal(t.app.roomByCode(room.code), room, 'лобби не пропало');
    await h2.send({ t: 'sit' });
    await h.send({ t: 'host', seat: room.players.findIndex((p) => p.id === String(GUEST.id)) });
    assert.equal(room.hostId, String(GUEST.id));
    await h.send({ t: 'drop', ...spoof });
    assert.equal(errors(h).at(-1).code, 'NOT_HOST');
    assert.equal(JSON.stringify(otherRoom), otherBefore, 'другой стол не менялся');
    assert.equal(JSON.stringify(neighbor), neighborBefore, 'соседний стол той же группы не менялся');
    assert.equal(spy.inbox.some((m) => m.state?.room?.code === otherRoom.code), false);
    assert.deepEqual(t.errors, []);
  });

  test(`J ${g.id}: весь поток, подмена хода, настройки, разделы и reconnect`, async (ctx) => {
    const rig = await setup(g, ctx);
    const { t, h, h2, b, spy, room } = rig;
    await begin(g, rig);
    const a = actor(g, rig);
    assert.ok(a, 'есть ходящий');
    const m = moveOf(g, state(a));
    const before = clone(room.hand || room.deal || room.match);
    const deadline = clone(room.turn);
    for (const p of [spy, a === h ? b : h]) {
      const n = errors(p).length;
      await p.send({ ...m, ...spoof });
      assert.equal(errors(p).length, n + 1);
      assert.match(errors(p).at(-1).text, /[А-Яа-я]/);
      assert.deepEqual(room.hand || room.deal || room.match, before, 'чужой ход не изменил партию');
    }
    await b.send({ t: 'settings', ...patchOf(g), ...spoof });
    assert.equal(errors(b).at(-1).code, 'NOT_HOST');
    await h.send({ t: 'settings', ...patchOf(g) });
    if (g.maxPlayers === 2) {
      assert.equal(errors(h).at(-1).code, 'GAME_IN_PROGRESS');
      assert.deepEqual(room.turn, deadline);
    } else {
      assert.equal(room.settings.turnSeconds, 60);
      if (g.id === 'poker') {
        const current = clone(room.hand);
        await h.send({ t: 'settings', smallBlind: 100, bigBlind: 200, startingStack: 99999 });
        assert.deepEqual(room.pendingBlinds, { sb: 100, bb: 200 });
        assert.equal(room.settings.startingStack, 10000);
        assert.deepEqual(room.hand, current);
      } else {
        const settings = clone(room.settings);
        await h.send({ t: 'settings', ...(g.id === 'durak' ? { variant: 'perevodnoy' } : { stacking: !room.settings.stacking }) });
        assert.equal(errors(h).at(-1).code, 'DEAL_IN_PROGRESS');
        assert.deepEqual(room.settings, settings);
      }
    }
    const stable = clone(room.hand || room.deal || room.match);
    const time = clone(room.turn);
    await h.send({ t: 'hub' });
    assert.ok(state(h).lobbies.find((r) => r.code === room.code)?.inside);
    await h.send({ t: 'rating' });
    assert.equal(errors(h).at(-1).code, 'RATING_SOON');
    await t.advance(1000);
    assert.deepEqual(room.turn, time, 'переход не сдвинул срок хода');
    await h.send({ t: 'join', code: room.code });
    assert.deepEqual(room.hand || room.deal || room.match, stable);
    assert.deepEqual(state(h).me, state(h2).me, 'оба устройства знают только одну свою роль');
    t.hub.close(h2.session);
    const re = page(t, HOST, `g_${t.group.code}`, { room: room.code, back: true });
    assert.deepEqual(state(re).me, state(h).me);
    assert.deepEqual(room.turn, time);
    assert.deepEqual(t.errors, []);
    assert.ok(rig.pages.every((p) => states(p).some((s) => s.game === g.id && s.room.status === 'playing')), 'каждая страница получила партию');
  });
}

// Счётчик ply/turn/shot начинается заново в каждой партии. Старый пакет
// третьего хода после двух повторов может снова оказаться законным.
for (const g of GAME_LIST.filter((g) => g.maxPlayers === 2)) {
  test(`J ${g.id}: старый пакет предыдущей партии не ходит в новой`, async (ctx) => {
    const rig = await setup(g, ctx);
    const { h, b, room, t } = rig;
    await begin(g, rig);
    const a = actor(g, rig);
    const old = moveOf(g, state(a));
    for (let i = 0; i < 2; i++) {
      await h.send({ t: 'abort' });
      assert.ok(room.match.over);
      await h.send({ t: 'next' });
      if (g.id === 'chess') await b.send({ t: 'next' });
      assert.equal(room.match.over, null);
      if (g.id === 'battleship') for (const p of [h, b]) { await p.send({ t: 'random' }); await p.send({ t: 'ready' }); }
    }
    assert.equal(actor(g, rig), a, 'та же личность снова ходит первой');
    const before = clone(room.match);
    const n = errors(a).length;
    await a.send(old);
    assert.deepEqual(room.match, before, 'старый пакет не изменил новую партию');
    assert.equal(errors(a).length, n + 1);
    assert.equal(errors(a).at(-1).code, 'STALE');
    assert.match(errors(a).at(-1).text, /[А-Яа-я]/);
    // Даже свежий счётчик позиции не делает старую партию текущей.
    await a.send({ ...old, seq: room.seq, matchNo: 1 });
    assert.deepEqual(room.match, before, 'старый номер партии не изменил новую партию');
    assert.equal(errors(a).at(-1).code, 'STALE');
    // Новый пакет той же личности с новым состоянием проходит.
    await a.send({ ...moveOf(g, state(a)), matchNo: room.match.no });
    assert.notDeepEqual(room.match, before, 'свежий ход проходит');
    assert.deepEqual(t.errors, []);
  });
}

for (const g of GAME_LIST) {
  test(`J ${g.id}: завершение, новый стол двумя вкладками и старый код`, async (ctx) => {
    const rig = await setup(g, ctx);
    const { t, h, h2, b, room } = rig;
    await begin(g, rig);
    const settings = clone(room.settings);
    await h.send({ t: 'finish' });
    assert.equal(room.status, 'finished');
    const n = t.app.roomsOf(t.chatId).length;
    await Promise.all([h.send({ t: 'again', reqId: 'j-again' }), h2.send({ t: 'again', reqId: 'j-again' })]);
    const next = t.app.roomByCode(h.session.code);
    assert.notEqual(next.code, room.code);
    assert.equal(h2.session.code, next.code);
    assert.equal(t.app.roomsOf(t.chatId).length, n + 1);
    assert.deepEqual(next.settings, settings);
    assert.equal(next.game, g.id);
    // Гость остался в старом завершённом столе: никаких ходов в новый.
    const before = clone(next);
    await b.send({ t: 'start', ...spoof });
    assert.ok(errors(b).at(-1)?.text);
    assert.deepEqual(next, before);
    await h.send({ t: 'drop' });
    await h.send({ t: 'join', code: next.code });
    assert.equal(errors(h).at(-1).code, 'NO_ROOM');
    assert.deepEqual(t.errors, []);
  });
}

import { Store } from './store.js';
import { cfgOf, purchase } from './payments/testkit.js';

test('J все игры: непустые покупки и поддержка одного игрока не попадают сопернику/зрителю/другой группе', async (ctx) => {
  const store = new Store(':memory:');
  const t = new Table({ store, admins: ['909'] });
  ctx.after(() => { t.app.stop(); store.close(); });
  t.app.payments.cfg = cfgOf(); // только заглушка Telegram, без .env и сети
  for (const u of [HOST, GUEST, SPY, user(909, 'Владелец')]) t.tg.dmOpen.add(String(u.id));
  const paid = await purchase(t, HOST, 'graphit-table');
  assert.equal(paid.ok, true);
  await t.start(HOST, 'support');
  const privateText = 'Личное обращение MULTIPLAYER_PRIVATE_731';
  await t.dm(HOST, privateText);
  assert.ok(t.tg.calls.some((c) => c.text?.includes(privateText)), 'обращение реально передано владельцу');
  t.app.payments.cfg.mode = 'off'; // старые покупки и история при закрытых продажах
  const pages = [];
  for (const g of GAME_LIST) {
    await t.advance(61_000); // настоящее окно лимитера, не сброс его внутренностей
    const group = t.app.ensureGroup(String(-8000 - GAME_LIST.indexOf(g)), `Группа ${g.id}`);
    const h = page(t, HOST, `g_${group.code}`);
    await h.send({ t: 'create', game: g.id, reqId: `private-${g.id}`, settings: { base: 0 } });
    const room = t.app.roomByCode(h.session.code);
    const same = page(t, HOST, room.code);
    const b = page(t, GUEST, room.code);
    const spy = page(t, SPY, room.code);
    pages.push(h, same, b, spy);
    await b.send({ t: 'sit' });
    await h.send({ t: 'start' });
    for (const p of [same, b, spy]) await p.send({ t: 'pay', op: 'history', userId: HOST.id, id: HOST.id, order: paid.order.id });
    assert.match(JSON.stringify(same.inbox), new RegExp(paid.order.id), 'собственная история непустая');
    for (const p of [b, spy]) {
      const all = JSON.stringify(p.inbox);
      for (const secret of [paid.order.id, paid.chargeId, paid.payload, privateText]) assert.ok(!all.includes(secret), `${g.id}: утечка ${secret}`);
      assert.deepEqual(p.inbox.filter((m) => m.t === 'pay').at(-1).orders, []);
      await p.send({ t: 'ashop', op: 'orders', userId: HOST.id, admin: true });
      assert.equal(errors(p).at(-1).code, 'BAD_REQUEST');
    }
    await h.send({ t: 'hub' });
    await h.send({ t: 'join', code: room.code });
    t.hub.close(same.session);
    const reconnect = page(t, HOST, room.code, { back: true });
    pages.push(reconnect);
    await reconnect.send({ t: 'pay', op: 'history' });
    assert.match(JSON.stringify(reconnect.inbox), new RegExp(paid.order.id));
  }
  for (const p of pages) assert.ok(!JSON.stringify(p.inbox).includes(privateText), 'текст поддержки не уходит ни в одну страницу');
  const publicTexts = t.tg.calls.filter((c) => Number(c.chatId) < 0).map((c) => c.text).join('\n');
  for (const secret of [paid.order.id, paid.chargeId, paid.payload, privateText]) assert.ok(!publicTexts.includes(secret));
  assert.deepEqual(t.errors, []);
});

for (const g of GAME_LIST) {
  test(`J ${g.id}: два одинаковых хода одновременно и часы вне стола`, async (ctx) => {
    const rig = await setup(g, ctx);
    const { t, room, h, h2, b } = rig;
    await begin(g, rig);
    const a = actor(g, rig);
    const duplicate = a === h ? h2 : page(t, GUEST, room.code);
    const move = moveOf(g, state(a));
    const seq = room.seq;
    const n = errors(a).length + errors(duplicate).length;
    await Promise.all([a.send(move), duplicate.send(move)]);
    assert.ok(room.seq > seq, 'первый ход принят');
    assert.equal(errors(a).length + errors(duplicate).length, n + 1, 'повтор не сделал второго хода');
    const rejected = [...errors(a), ...errors(duplicate)].at(-1);
    assert.match(rejected.text, /[А-Яа-я]/);
    // Все уходят в разделы. Даже без открытой доски время не останавливается.
    for (const p of [h, h2, b]) await p.send({ t: 'hub' });
    const old = clone(room.turn);
    assert.ok(old?.deadline > t.clock.now(), 'часы работают до перехода');
    const part = clone(room.hand || room.deal || room.match);
    await t.advance(old.deadline - t.clock.now() + 1);
    assert.notDeepEqual(room.hand || room.deal || room.match, part, 'срок сработал вне стола');
    assert.equal(room.players.filter((p) => p.id === String(HOST.id)).length, 1);
    await h.send({ t: 'join', code: room.code });
    assert.equal(state(h).me.seat, room.players.findIndex((p) => p.id === String(HOST.id)));
    assert.deepEqual(t.errors, []);
  });
}

for (const g of GAME_LIST) {
  test(`J ${g.id}: хост вышел из Telegram-группы — права переходят оставшемуся`, async (ctx) => {
    const rig = await setup(g, ctx);
    const { t, h, h2, b, room } = rig;
    await begin(g, rig);
    await t.raw({ message: { message_id: 900, chat: { id: t.chatId, type: 'supergroup' }, from: HOST, left_chat_member: HOST, date: 1 } });
    assert.equal(room.hostId, String(GUEST.id));
    assert.equal(room.players.find((p) => p.id === String(HOST.id)).left, true);
    const settings = clone(room.settings);
    await h2.send({ t: 'settings', ...patchOf(g) });
    assert.equal(errors(h2).at(-1).code, 'NOT_HOST');
    assert.deepEqual(room.settings, settings);
    assert.equal(state(b).me.isHost, true);
    assert.equal(state(h).me.isHost, false);
    assert.deepEqual(t.errors, []);
  });
}

test('J battleship: одно нажатие «Я готов» отправляет place и ready с одной исходной версией', async (ctx) => {
  const g = GAME_LIST.find((g) => g.id === 'battleship');
  const { h, b, room, t } = await setup(g, ctx);
  await b.send({ t: 'sit' });
  await h.send({ t: 'start' });
  await h.send({ t: 'random' });
  const ships = clone(room.match.fleets[0]);
  const seq = room.seq;
  await h.send({ t: 'place', ships, seq });
  await h.send({ t: 'ready', seq });
  assert.equal(room.match.ready[0], true, 'два связанных сообщения не конфликтуют');
  assert.deepEqual(t.errors, []);
});
