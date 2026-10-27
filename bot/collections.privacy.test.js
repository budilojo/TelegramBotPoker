'use strict';
/**
 * Коллекция «Графит» и приватность: что получил КАЖДЫЙ телефон за всю партию (вся история сообщений),
 * а не только последний экран.
 *
 *   Чужих карт и колод нет. Нет `owned` / `choice` / `pending` / демо-флагов / цен / id других людей
 *   в виде стола. Рубашки — по номеру места, без id. Итоги несут только публичное оформление.
 *   Личное состояние `{t:'col'}` приходит только его владельцу.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, ALICE, BOB, CAROL, demoOn, col, grant, apply, seatPoker, seatDurak, nextPokerHand } from './collections/testkit.js';
import { durakDecks, seededDecks } from './harness.js';

const CB = 'graphit-cardback';
const TB = 'graphit-table';
const PR = 'graphit-profile';
const CAST = { ALICE, BOB, CAROL };
const PEOPLE = [ALICE, BOB, CAROL];
const FORBIDDEN_KEYS = ['owned', 'choice', 'pending', 'demo', 'unlocked', 'price', 'enabled', 'granted_at', 'when', 'req'];

/** Все ключи любой глубины. */
function keysOf(x, out = new Set()) {
  if (Array.isArray(x)) x.forEach((v) => keysOf(v, out));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.add(k); keysOf(v, out); }
  return out;
}
const toStates = (t, u) => t.page(u).inbox.filter((m) => m.t !== 'col');

/** Выдать Бобу всё, выбрать только рубашку; Алисе — стол и знак; у Кати пусто. Банальные «чужие» тайны. */
async function dress(t) {
  await grant(t, BOB, 'graphit-bundle');
  await apply(t, BOB, 'cardback', CB, 'petrol');           // Боб надел только рубашку; стол и знак у него лишь «в коллекции»
  await grant(t, ALICE, 'graphit-bundle');
  await apply(t, ALICE, 'table', TB, 'bordeaux');
  await apply(t, ALICE, 'profile', PR, 'sapphire');
}

function noForeign(t, who, others) {
  const raw = JSON.stringify(toStates(t, who));
  const keys = keysOf(toStates(t, who));
  for (const k of FORBIDDEN_KEYS) assert.equal(keys.has(k), false, `${who.first_name}: в виде стола нет ключа «${k}»`);
  for (const o of others) {
    assert.equal(raw.includes(String(o.id)), false, `${who.first_name}: нет id ${o.first_name}`);
  }
  assert.equal(raw.includes('"price"'), false);
  assert.equal(/\b(99|199|249|79)\b/.test(JSON.stringify([...keysOf(toStates(t, who))])), false);
  assert.equal(raw.includes('graphit-bundle'), false, 'комплект в виде стола не встречается');
}

test('покер, три телефона, вся история: ни чужих карт, ни владения, ни выбора, ни id; рубашки — по местам', async () => {
  const t = new Table({ deck: seededDecks(11) });
  demoOn(t);
  await seatPoker(t);
  await dress(t);
  await t.send(ALICE, { t: 'start' });
  const holes = Object.fromEntries(PEOPLE.map((u) => [u.id, t.hole(u)]));
  await t.runToShowdown(CAST);
  await t.send(ALICE, { t: 'next' });
  // оформление меняется посреди партии (отложено), вид не должен выдать ничего
  await apply(t, BOB, 'profile', PR, 'petrol');
  await t.runToShowdown(CAST);
  await t.send(ALICE, { t: 'finish' });

  for (const u of PEOPLE) {
    noForeign(t, u, PEOPLE.filter((o) => o !== u));
    // чужие предметы, которые есть у владельца, но не надеты, не выходят ни в одном сообщении вида
  }
  // Боб выдал себе комплект, но надел одну рубашку: стол и знак Боба (его «в коллекции») Алисе и Кате не приходят
  // иначе как через собственный выбор Алисы. Катя ничего не надела: стол Алисы (хоста) публичен всей комнате,
  // а у Кати нет ни своей записи, ни чужих «в коллекции» (бордо — цвет стола Алисы, сапфир — её знака).
  const carolRaw = JSON.stringify(toStates(t, CAROL));
  assert.equal(carolRaw.includes('graphit-bundle'), false);
  assert.deepEqual(t.state(CAROL).look.table, { item: TB, color: 'bordeaux' }, 'стол хоста — публичное оформление комнаты');
  assert.equal(t.state(CAROL).players.find((p) => p.isMe).frame, null, 'у Кати своей рамки нет');
  // Чужие карты: закрытые карты Алисы и Боба Кате не приходили ни разу, пока на вскрытии не открылись.
  const carolStates = toStates(t, CAROL).filter((m) => m.t === 'state').map((m) => m.state);
  for (const st of carolStates) assert.equal(st.me.cards.some((c) => holes[ALICE.id]?.includes(c) || holes[BOB.id]?.includes(c)), false);
  const states = toStates(t, CAROL).filter((m) => m.t === 'state').map((m) => m.state);
  assert.ok(states.length > 5);
  for (const st of states) {
    for (const p of st.players) {
      if (p.isMe) continue;
      if (p.cards) assert.equal(st.hand?.phase === 'complete' || st.room.status === 'finished', true, 'чужие карты — только на вскрытии');
    }
    assert.equal(Object.hasOwn(st, 'owned'), false);
    // look: рубашки по месту, без id; максимум одна запись на место
    const seats = st.look.backs.map((b) => b.seat);
    assert.equal(new Set(seats).size, seats.length);
    for (const b of st.look.backs) assert.deepEqual(Object.keys(b).sort(), ['color', 'item', 'seat']);
    assert.deepEqual(Object.keys(st.look).sort(), ['backs', 'dealNo', 'table', 'v']);
    for (const p of st.players) {
      if (p.frame) assert.deepEqual(Object.keys(p.frame).sort(), ['color', 'item']);
    }
  }
  // Самое важное про рубашку: все видят одну и ту же публичную запись о рубашке Боба
  const last = t.state(CAROL);
  assert.deepEqual(last.look.backs, [{ seat: 1, item: CB, color: 'petrol' }]);
  assert.deepEqual(t.state(ALICE).look.backs, last.look.backs);
});

test('покер: итоги несут только публичное оформление (рамка: item и color), без прав и цен', async () => {
  const t = new Table();
  demoOn(t);
  await seatPoker(t);
  await dress(t);
  await t.send(ALICE, { t: 'start' });
  await t.send(ALICE, { t: 'finish' });
  for (const u of PEOPLE) {
    const st = t.state(u);
    assert.equal(st.room.status, 'finished');
    assert.ok(st.results.length >= 2);
    for (const r of st.results) {
      assert.deepEqual(Object.keys(r).sort(), ['biggest', 'frame', 'hands', 'isHost', 'kicked', 'name', 'net', 'pots', 'role', 'stack']);
      if (r.frame) assert.deepEqual(Object.keys(r.frame).sort(), ['color', 'item']);
    }
    assert.deepEqual(st.results.find((r) => r.name === 'Алиса').frame, { item: PR, color: 'sapphire' });
    assert.equal(st.results.find((r) => r.name === 'Боб').frame, null, 'Боб знак не надел — рамки нет, хотя знак у него «в коллекции»');
    noForeign(t, u, PEOPLE.filter((o) => o !== u));
  }
});

test('личное состояние {t:"col"} приходит только владельцу и никому за столом', async () => {
  const t = new Table();
  demoOn(t);
  await seatPoker(t);
  await dress(t);
  await t.send(ALICE, { t: 'start' });
  const carol = JSON.stringify(col(t, CAROL));
  for (const needle of ['petrol', 'bordeaux', 'sapphire', 'graphit']) {
    assert.equal(carol.includes(needle), false, `Кате не пришло «${needle}»`);
  }
  // у Алисы — только её собственное; рубашки Боба она в своём col-состоянии не видит
  const alice = JSON.stringify(col(t, ALICE));
  assert.equal(alice.includes('petrol'), false);
  // и ни одного col-сообщения с чужой личностью
  for (const u of PEOPLE) for (const m of col(t, u)) assert.equal(m.enabled, true);
});

test('дурак, три телефона, вся история: колод и чужих рук нет, оформление публичное и без id', async () => {
  const t = new Table({ durakDeck: durakDecks(5) });
  demoOn(t);
  await seatDurak(t);
  await dress(t);
  await t.send(ALICE, { t: 'start' });
  await apply(t, BOB, 'profile', PR, 'petrol'); // посреди партии — отложено
  await t.send(ALICE, { t: 'abort' });
  await t.send(BOB, { t: 'next' });
  await t.send(ALICE, { t: 'finish' });

  for (const u of PEOPLE) {
    noForeign(t, u, PEOPLE.filter((o) => o !== u));
    const tableStates = toStates(t, u).filter((x) => x.t === 'state' && x.state.game === 'durak').map((x) => x.state);
    assert.ok(tableStates.length >= 4, 'история партии не пустая');
    for (const st of tableStates) {
      const ks = keysOf(st);
      for (const k of ['hands', 'talonCards', 'pack', 'discardCards']) assert.equal(ks.has(k), false, k);
      if (st.deal) {
        assert.equal(typeof st.deal.talon, 'number', 'колода — число');
        assert.equal(typeof st.deal.discard, 'number', 'отбой — число');
      }
      for (const p of st.players) assert.equal(typeof p.count, 'number', 'чужая рука — число карт');
      assert.deepEqual(Object.keys(st.look).sort(), ['backs', 'dealNo', 'table', 'v']);
      assert.deepEqual(st.look.backs, [], 'в дураке рубашек нет');
      for (const p of st.players) if (p.frame) assert.deepEqual(Object.keys(p.frame).sort(), ['color', 'item']);
      for (const s of st.score) if (s.frame) assert.deepEqual(Object.keys(s.frame).sort(), ['color', 'item']);
    }
  }
  const last = t.state(CAROL);
  assert.deepEqual(last.look.table, { item: TB, color: 'bordeaux' }, 'стол хоста');
  assert.deepEqual(last.score.find((s) => s.name === 'Алиса').frame, { item: PR, color: 'sapphire' });
});

test('вид без демосреды (рабочий режим): оформление пустое, в виде нет ни owned, ни choice, ни id', async () => {
  const t = new Table();
  await seatPoker(t);
  await t.send(ALICE, { t: 'start' });
  for (const u of PEOPLE) {
    noForeign(t, u, PEOPLE.filter((o) => o !== u));
    assert.deepEqual(t.state(u).look, { v: 1, table: null, backs: [], dealNo: 1 });
    assert.ok(t.state(u).players.every((p) => p.frame === null));
    assert.equal(col(t, u).length, 0);
  }
});

test('«игра с ботами» (solo): оформление считается так же, а чужого сюда не попадает', async () => {
  const t = new Table();
  demoOn(t);
  await t.start(ALICE);
  t.openSolo(ALICE);
  await grant(t, ALICE, 'graphit-bundle');
  await apply(t, ALICE, 'table', TB, 'petrol');
  await apply(t, ALICE, 'profile', PR, 'petrol');
  await t.send(ALICE, { t: 'play', game: 'durak', settings: {} });
  const st = t.state(ALICE);
  assert.deepEqual(st.look.table, { item: TB, color: 'petrol' });
  const me = st.players.find((p) => p.isMe);
  assert.deepEqual(me.frame, { item: PR, color: 'petrol' });
  assert.ok(st.players.filter((p) => !p.isMe).every((p) => p.frame === null), 'у ботов оформления нет');
  assert.equal(keysOf(st).has('owned'), false);
});
