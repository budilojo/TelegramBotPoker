'use strict';
/**
 * Журнал решений и грубая оценка (агент Y, решения 071–075).
 * Журнал: только решения самого человека, только его карты, не ломает партию,
 * ротация, удаление. Оценка: по правилу — пара «ошибка / не ошибка»; исход
 * раздачи на вердикт не влияет; сомнительное — unknown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { NullStore, Store } from './store.js';
import {
  rateDecision, assessHistory, snapshot, parseCodes, handClass, positionOf, KEEP, MIN_TOTAL,
} from './decisions.js';

const CAST = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') });
const C = (s) => s; // читаемость: коды карт — числа rank*4+suit

/** Играет раздачу, записывая, какие карты видел каждый в момент хода. */
async function playHand(t, cast, seen) {
  let guard = 0;
  while (t.room.hand?.phase === 'betting' && guard++ < 40) {
    const who = t.actorOf(cast);
    if (!who) break;
    seen.push({ uid: String(who.id), hole: [...t.hole(who)], board: [...t.room.hand.board] });
    const l = t.state(who).legal;
    await t.act(who, l?.canCheck ? 'check' : 'call');
  }
}

test('журнал пишет решения людей и только их собственные карты', async () => {
  const store = new NullStore();
  const cast = CAST();
  const t = new Table({ store });
  await t.begin(cast);
  const seen = [];
  await playHand(t, cast, seen);
  assert.ok(seen.length >= 3);
  let total = 0;
  for (const u of Object.values(cast)) {
    const rows = store.decisionsOf(u.id);
    total += rows.length;
    const mine = seen.filter((s) => s.uid === String(u.id));
    assert.equal(rows.length, mine.length, 'ровно по записи на каждое своё решение');
    const others = new Set(seen.filter((s) => s.uid !== String(u.id)).flatMap((s) => s.hole));
    for (const r of rows) {
      const hole = parseCodes(r.hole);
      assert.equal(hole.length, 2);
      for (const c of hole) assert.ok(!others.has(c), 'чужая карта в моём журнале');
      assert.ok(mine.some((s) => s.hole.join() === hole.join()), 'карты — те, что видел сам игрок');
      assert.ok(!JSON.stringify(r).includes('holes'));
      assert.equal(r.kind, 'table');
    }
  }
  assert.equal(total, seen.length);
});

test('журнал не пишет за бота и не пишет без карт на руках', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const who = t.actorOf(cast);
  assert.ok(snapshot(t.room, who.id), 'у человека снимок есть');
  const p = t.room.players.find((x) => x.id === String(who.id));
  p.bot = true;
  assert.equal(snapshot(t.room, who.id), null, 'у бота снимка нет');
  p.bot = false;
  assert.equal(snapshot(t.room, 'чужой'), null);
  t.room.settings.cards = 'live';
  assert.equal(snapshot(t.room, who.id), null, 'настоящие карты — карт у приложения нет');
});

test('упавший журнал не ломает раздачу', async () => {
  const store = new NullStore();
  store.addDecision = () => { throw new Error('диск полон'); };
  const cast = CAST();
  const t = new Table({ store });
  const log = console.error;
  console.error = () => {};
  try {
    await t.begin(cast);
    await playHand(t, cast, []);
  } finally {
    console.error = log;
  }
  assert.notEqual(t.room.hand.phase, 'betting', 'раздача дошла до конца');
  assert.equal(t.lastError(cast.ivan), null);
});

for (const [name, mk] of [['память', () => new NullStore()], ['SQLite', () => new Store(':memory:')]]) {
  test(`ротация, удаление и изоляция игроков (${name})`, () => {
    const s = mk();
    const row = (i) => ({ handKey: `r:${i}`, street: 'flop', position: 'BTN', hole: '48 49', board: '', pot: 100, toCall: 0, stack: 900, opps: 1, bb: 50, action: 'check', amount: null, strength: 1, equity: 0.5, kind: 'table', at: i });
    for (let i = 0; i < KEEP + 20; i++) s.addDecision('1', row(i), KEEP);
    s.addDecision('2', row(1), KEEP);
    const mine = s.decisionsOf('1', 1000);
    assert.equal(mine.length, KEEP, 'хранятся последние KEEP');
    assert.equal(mine[0].at, KEEP + 19, 'новые первыми');
    assert.equal(s.decisionsOf('2').length, 1, 'чужой журнал не тронут ротацией');
    assert.equal(s.deleteDecisions('1'), KEEP);
    assert.equal(s.decisionsOf('1').length, 0, 'удалено');
    assert.equal(s.decisionsOf('2').length, 1, 'у другого — на месте');
  });
}

/* ------------------------------------------------------------ оценка */

const AA = '48 49'; const T72 = '20 1'; const KQ = '44 40';
const base = { street: 'flop', position: 'BTN', hole: T72, board: '', pot: 100, toCall: 0, stack: 2000, opps: 1, bb: 50, action: 'check', equity: 0.5 };
const rate = (o) => rateDecision({ ...base, ...o });

test('правило: сброс, когда можно чекнуть', () => {
  assert.equal(rate({ action: 'fold', toCall: 0 }).code, 'free-fold');
  assert.equal(rate({ action: 'fold', toCall: 0 }).verdict, 'mistake');
  assert.notEqual(rate({ action: 'fold', toCall: 50, equity: 0.2 }).code, 'free-fold');
});

test('правило: сброс при выгодных шансах', () => {
  const bad = rate({ action: 'fold', pot: 400, toCall: 50, equity: 0.6 });
  assert.deepEqual([bad.verdict, bad.code, bad.topic, bad.skill], ['mistake', 'fold-good-odds', 'pot-odds', 'math']);
  assert.equal(rate({ action: 'fold', pot: 400, toCall: 50, equity: 0.3 }).verdict, 'unknown', 'спорно — не судим');
  assert.equal(rate({ action: 'fold', pot: 100, toCall: 100, equity: 0.6 }).verdict !== 'mistake', true, 'крупная ставка — не судим');
});

test('правило: колл при невыгодных шансах', () => {
  assert.equal(rate({ action: 'call', pot: 100, toCall: 100, equity: 0.15 }).code, 'call-bad-odds');
  assert.notEqual(rate({ action: 'call', pot: 100, toCall: 100, equity: 0.45 }).verdict, 'mistake');
  assert.equal(rate({ action: 'call', pot: 100, toCall: 100, equity: 0.65 }).verdict, 'good');
});

test('правило: олл-ин мусором против небольшой ставки', () => {
  assert.equal(rate({ action: 'allin', toCall: 50, equity: 0.2 }).code, 'shove-trash');
  assert.notEqual(rate({ action: 'allin', toCall: 50, equity: 0.55 }).verdict, 'mistake');
  assert.notEqual(rate({ action: 'allin', toCall: 50, equity: 0.2, stack: 300 }).verdict, 'mistake', 'короткий стек — шов нормален');
  assert.notEqual(rate({ action: 'allin', toCall: 1000, equity: 0.2 }).verdict, 'mistake', 'большая ставка — не «небольшая»');
});

test('правило: сброс сильнейшей руки и пассивность из ранней позиции', () => {
  const pre = { street: 'preflop', pot: 225, equity: null };
  assert.equal(rate({ ...pre, hole: AA, action: 'fold', toCall: 150 }).code, 'premium-fold');
  assert.notEqual(rate({ ...pre, hole: T72, action: 'fold', toCall: 150 }).verdict, 'mistake');
  assert.equal(rate({ ...pre, hole: AA, action: 'call', toCall: 50, position: 'UTG' }).code, 'premium-limp');
  assert.notEqual(rate({ ...pre, hole: AA, action: 'call', toCall: 50, position: 'BTN' }).verdict, 'mistake');
  assert.notEqual(rate({ ...pre, hole: AA, action: 'call', toCall: 150, position: 'UTG' }).verdict, 'mistake', 'после рейза колл — не лимп');
  assert.notEqual(rate({ ...pre, hole: KQ, action: 'call', toCall: 50, position: 'UTG' }).verdict, 'mistake');
  assert.equal(rate({ ...pre, hole: AA, action: 'raise', toCall: 50 }).verdict, 'good');
});

test('исход раздачи на вердикт не влияет', () => {
  const row = { ...base, action: 'call', pot: 100, toCall: 100, equity: 0.15 };
  const same = rateDecision(row);
  for (const extra of [{ won: true, result: 'win', chips: 99999 }, { won: false, result: 'lose', chips: -500, delta: -500 }]) {
    assert.deepEqual(rateDecision({ ...row, ...extra }), same);
  }
  assert.equal(same.verdict, 'mistake');
});

test('сомнительное — unknown, мусор не падает', () => {
  assert.equal(rate({ action: 'raise', equity: 0.4 }).verdict, 'unknown');
  assert.equal(rate({ equity: null, action: 'call', toCall: 50 }).verdict, 'unknown');
  assert.equal(rateDecision(null).verdict, 'unknown');
  assert.equal(rateDecision({}).verdict, 'unknown');
  assert.equal(rate({ hole: '' }).verdict, 'unknown');
});

test('классы рук и позиции', () => {
  assert.equal(handClass([48, 49]), 'AA');
  assert.equal(handClass([48, 44]), 'AKs');
  assert.equal(handClass([48, 45]), 'AKo');
  const mk = (n, d) => ({ hand: { dealerId: 'p' + d }, players: Array.from({ length: n }, (_, i) => ({ id: 'p' + i, inHand: true })) });
  const r = mk(6, 0);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => positionOf(r, 'p' + i)), ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO']);
  assert.deepEqual([0, 1].map((i) => positionOf(mk(2, 0), 'p' + i)), ['BTN', 'BB']);
});

/* ------------------------------------------------------- итог по журналу */

const rowsOf = (n, o) => Array.from({ length: n }, (_, i) => ({ ...base, id: i, ...o }));

test('«по истории»: мало решений — недоступно, со словами', () => {
  const a = assessHistory(rowsOf(10, {}));
  assert.equal(a.available, false);
  assert.match(a.summary, /мало решений/);
  assert.equal(a.need, MIN_TOTAL - 10);
  assert.equal(assessHistory([]).available, false);
});

test('«по истории»: уровни по навыкам из подготовленных наборов', () => {
  const goodMath = rowsOf(30, { action: 'call', pot: 100, toCall: 100, equity: 0.7 });
  const badMath = rowsOf(30, { action: 'call', pot: 100, toCall: 100, equity: 0.1 });
  const good = assessHistory(goodMath.concat(rowsOf(20, {})));
  assert.equal(good.available, true);
  assert.equal(good.skills.math.level, 4);
  assert.equal(good.skills.ranges.level, null, 'диапазоны журнал не оценивает');
  assert.equal(good.skills.ranges.enough, false);
  const bad = assessHistory(badMath.concat(rowsOf(20, {})));
  assert.equal(bad.skills.math.level, 1);
  assert.equal(bad.mistakes[0].code, 'call-bad-odds');
  assert.match(bad.summary, /колл при невыгодных шансах/);
  assert.ok(good.skills.math.level > bad.skills.math.level);
});
