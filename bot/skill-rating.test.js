import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { INITIAL, SYSTEM, expectedScore, skillDeltas, SkillShadow } from './skill-rating.js';
import { GAME_LIST } from './games/index.js';
import { Store, NullStore } from './store.js';
import { apply as legacy } from './rating.js';
import { Table, user, colorsDecks, colorsRandom } from './harness.js';
import poker from './games/poker/index.js';
import * as pokerRoom from './room.js';

const games = GAME_LIST.map(g => g.id);
const at = Date.parse('2026-11-03T12:00:00Z');
const cast = (n, rating = INITIAL) => Array.from({ length: n }, (_, i) => ({ id: String(i), rating, place: i + 1 }));
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);
const round = (r = 'one', extra = {}) => ({ game: 'colors', round: r, places: [{ id: 'a' }, { id: 'b' }], at, ...extra });

test('сила: равные +16/−16, сильный и слабый соперники дают разную цену победы', () => {
  near(expectedScore(1000, 1000), 0.5);
  assert.deepEqual(skillDeltas(cast(2)).map(r => r.delta), [16, -16]);
  const strong = skillDeltas([{ id: 'a', rating: 1000, place: 1 }, { id: 'b', rating: 1200, place: 2 }]);
  near(strong[0].delta, 24.31190165273465);
  near(strong[0].delta + strong[1].delta, 0);
  const weak = skillDeltas([{ id: 'a', rating: 1000, place: 1 }, { id: 'b', rating: 800, place: 2 }]);
  near(weak[0].delta, 7.68809834726535);
});

test('сила: каждый размер стола нормирован; очки не появляются из воздуха', () => {
  for (let n = 2; n <= 8; n++) {
    const rows = skillDeltas(cast(n));
    near(rows[0].delta, 16); near(rows.at(-1).delta, -16);
    near(rows.reduce((s, r) => s + r.delta, 0), 0);
    near(rows.reduce((s, r) => s + r.after, 0), n * INITIAL);
  }
  const four = skillDeltas(cast(4));
  near(four[1].delta, 16 / 3); near(four[2].delta, -16 / 3);
});

test('сила: порядок входа и идентификаторы не дают преимущества', () => {
  const players = cast(5).map((p, i) => ({ ...p, rating: 600 + i * 137 }));
  const a = skillDeltas(players), b = skillDeltas([...players].reverse());
  for (const row of a) near(row.delta, b.find(x => x.id === row.id).delta);
  const renamed = skillDeltas(players.map(p => ({ ...p, id: `новый:${p.id}`, name: 'Косметика' })));
  a.forEach((r, i) => near(r.delta, renamed[i].delta));
});

test('сила: ничья с равным нейтральна, ничья с сильным улучшает оценку слабого', () => {
  assert.deepEqual(skillDeltas(cast(2).map(p => ({ ...p, place: 1 }))).map(r => r.delta), [0, 0]);
  const rows = skillDeltas([{ id: 'a', rating: 1000, place: 1 }, { id: 'b', rating: 1200, place: 1 }]);
  near(rows[0].delta, 8.31190165273465); near(rows[1].delta, -rows[0].delta);
  const tied = skillDeltas(cast(4).map((p, i) => ({ ...p, place: i < 2 ? 1 : 3 })));
  near(tied[0].delta, tied[1].delta); near(tied[2].delta, tied[3].delta);
});

test('сила: нет подарка на нижней границе и округлением не печатаются очки', () => {
  const players = cast(3, 0);
  const rows = skillDeltas(players);
  near(rows.at(-1).after, -16);
  const four = skillDeltas(cast(4));
  assert.notEqual(four[1].after, Math.round(four[1].after));
});

test('сила: при верной вероятности ожидаемое изменение равно нулю при любой силе', () => {
  for (const other of [400, 800, 1000, 1200, 1800]) {
    const win = skillDeltas([{ id: 'a', rating: 1000, place: 1 }, { id: 'b', rating: other, place: 2 }])[0].delta;
    const loss = skillDeltas([{ id: 'a', rating: 1000, place: 2 }, { id: 'b', rating: other, place: 1 }])[0].delta;
    const p = expectedScore(1000, other);
    near(p * win + (1 - p) * loss, 0);
  }
});

test('сила: испорченные результаты и повторные участники отклоняются', () => {
  for (const bad of [[], cast(1), cast(9), [...cast(2), { id: '0', rating: 1000, place: 3 }],
    [{ id: '', rating: 1000, place: 1 }, cast(2)[1]],
    [{ id: 'a', rating: NaN, place: 1 }, cast(2)[1]],
    [{ id: 'a', rating: 1000, place: 0 }, cast(2)[1]]]) assert.throws(() => skillDeltas(bad));
  assert.throws(() => expectedScore(Infinity, 1000));
  assert.throws(() => skillDeltas(cast(2), 0));
});

test('сила: семь игр независимы, старые очки и версия схемы сохраняются', () => {
  const store = new Store(':memory:');
  try {
    legacy(store, { ...round(), loserId: 'b' });
    const schema = store.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value;
    const s = new SkillShadow(store.db, games);
    for (const game of games) {
      const r = s.apply(round('match', { game }));
      near(r.rows[0].after, 1016);
    }
    for (const game of games) assert.deepEqual(s.player(game, 'a'), { rating: 1016, played: 1 });
    assert.equal(store.ratingOf('a', 'colors').points, 20);
    assert.equal(store.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, schema);
    assert.throws(() => s.apply(round('bad', { game: 'unknown' })));
  } finally { store.close(); }
});

test('сила: весь результат и точная дельта переживают перезапуск; повтор не начисляет снова', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-shadow-'));
  const file = path.join(dir, 'test.db');
  let db = new DatabaseSync(file);
  try {
    const first = new SkillShadow(db, games).apply(round()); db.close(); db = new DatabaseSync(file);
    const s = new SkillShadow(db, games), again = s.apply(round('one', { at: at + 86400000 }));
    assert.equal(again.replayed, true); assert.deepEqual(again.rows, first.rows);
    assert.deepEqual(s.player('colors', 'a'), { rating: 1016, played: 1 });
    assert.throws(() => s.apply(round('one', { places: [{ id: 'b' }, { id: 'a' }] })), /изменён/);
    assert.equal(s.player('colors', 'a').played, 1);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('сила: ошибка записи второго игрока откатывает ВСЮ партию; повтор после сбоя безопасен', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const s = new SkillShadow(db, games);
    db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON skill_shadow_players
      WHEN NEW.user_id = 'b' BEGIN SELECT RAISE(ABORT, 'disk failure model'); END`);
    assert.throws(() => s.apply(round()), /disk failure model/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM skill_shadow_players').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM skill_shadow_rounds').get().n, 0);
    db.exec('DROP TRIGGER fail_second');
    assert.equal(s.apply(round()).ok, true); near(s.player('colors', 'a').rating, 1016);
  } finally { db.close(); }
});

test('сила: боты без калибровки, отмена и короткая партия не меняют оценки', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const s = new SkillShadow(db, games);
    for (const [field, reason] of [['hasBots', 'BOTS_UNCALIBRATED'], ['aborted', 'ABORTED'], ['short', 'SHORT']]) {
      assert.equal(s.apply(round(field, { [field]: true })).skipped, reason);
    }
    assert.equal(s.apply(round('one-person', { places: [{ id: 'a' }] })).skipped, 'TOO_FEW');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM skill_shadow_players').get().n, 0);
    const draw = s.apply(round('draw', { draw: true }));
    assert.deepEqual(draw.rows.map(r => r.delta), [0, 0]);
  } finally { db.close(); }
});

test('сила: покерные разделённые места не превращаются в победу по порядку посадки', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const s = new SkillShadow(db, games);
    const room = pokerRoom.createRoom({ chatId: '-1', host: { id: 1, name: 'Хост' } });
    for (let id = 2; id <= 4; id++) pokerRoom.addPlayer(room, { id, name: `Игрок ${id}` });
    room.status = 'finished';
    room.players.forEach((p, i) => { p.stats.handsPlayed = 20; p.stats.buyIn = 10000; p.stack = [15000, 15000, 5000, 5000][i]; });
    const r = poker.rounds(room)[0];
    assert.deepEqual(r.ranks, [1, 1, 3, 3]);
    assert.equal(legacy(new NullStore(), { ...r, game: 'poker', round: r.id }).skipped, 'DRAW');
    const result = s.apply({ ...r, game: 'poker', round: r.id, at });
    near(result.rows[0].delta, 32 / 3); near(result.rows[1].delta, 32 / 3);
    near(result.rows[2].delta, -32 / 3); near(result.rows[3].delta, -32 / 3);
    room.players.forEach((p, i) => { p.stack = [20000, 10000, 10000, 0][i]; });
    const next = poker.rounds(room)[0];
    assert.deepEqual(next.ranks, [1, 2, 2, 4]);
    assert.deepEqual(skillDeltas(next.places.map((p, i) => ({ id: p.id, place: next.ranks[i], rating: 1000 }))).map(r => r.delta), [16, 0, 0, -16]);
  } finally { db.close(); }
});

test('сила: неизвестное разделение мест при многопользовательской ничьей не угадывается', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const s = new SkillShadow(db, games);
    assert.equal(s.apply(round('unknown-draw', { draw: true, places: cast(4) })).skipped, 'DRAW_PLACES_UNKNOWN');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM skill_shadow_players').get().n, 0);
    assert.throws(() => s.apply(round('invalid-ranks', { ranks: [1] })), /места/);
  } finally { db.close(); }
});

async function humanGame(observer) {
  const t = new Table({ colorsDeck: colorsDecks(5), colorsRand: colorsRandom(5) });
  t.app.skillShadow = observer;
  const people = [user(101, 'Аня'), user(202, 'Боря'), user(303, 'Вера')];
  for (const u of people) await t.start(u);
  await t.cmd(people[0], '/play'); t.openHub(people[0]);
  await t.send(people[0], { t: 'create', game: 'colors' });
  const room = t.colors;
  for (const u of people.slice(1)) { t.openRoom(u, room); await t.send(u, { t: 'sit' }); }
  await t.send(people[0], { t: 'start' });
  for (let i = 0; i < 2000 && room.deal.phase === 'play'; i++) {
    const u = people.find(p => String(p.id) === room.deal.turn), s = t.state(u), l = s.legal;
    if (l.shout) await t.send(u, { t: 'shout' });
    const card = l.play[0];
    await t.send(u, card ? { t: 'play', card, ...(['WC', 'WF'].includes(card) ? { color: 'R' } : {}), seq: t.state(u).seq }
      : { t: l.draw ? 'draw' : 'pass', seq: t.state(u).seq });
  }
  assert.equal(room.deal.phase, 'over');
  return { t, room, people };
}

test('сила: настоящие страницы доигрывают UNOQ, наблюдатель пишет ровно раз и не попадает на телефоны', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const s = new SkillShadow(db, games), { t, room, people } = await humanGame(s);
    t.app.rate(room); t.app.rate(room);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM skill_shadow_rounds').get().n, 1);
    const ratings = people.map(u => s.player('colors', String(u.id)));
    near(ratings.reduce((sum, r) => sum + r.rating, 0), 3000);
    assert.ok(ratings.every(r => r.played === 1));
    assert.equal(t.app.ratingSoon, true);
    for (const u of people) assert.ok(!JSON.stringify(t.received(u)).includes(SYSTEM));
    assert.equal(room.rated[`${room.code}#1`].ok, true, 'старый путь начисления продолжает работать');
    const bots = { ...room, solo: { owner: '101' }, code: 'solo-copy', skillObserved: {} };
    assert.deepEqual(t.app.rate(bots), []);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM skill_shadow_rounds').get().n, 1);
    room.history.push({ ...room.history.at(-1), no: 2 });
    room.players[0].bot = { level: 1 };
    t.app.rate(room);
    const mixed = JSON.parse(db.prepare('SELECT result FROM skill_shadow_rounds WHERE round = ?').get(`${room.code}#2`).result);
    assert.equal(mixed.skipped, 'BOTS_UNCALIBRATED', 'наличие бота проверяется и без флага solo');
    assert.ok(people.every(u => s.player('colors', String(u.id)).played === 1));
  } finally { db.close(); }
});

test('сила: отказ наблюдателя не отменяет результат и старое начисление', async () => {
  const { t, room } = await humanGame({ apply() { throw new Error('observer unavailable'); } });
  assert.equal(room.rated[`${room.code}#1`].ok, true);
  assert.ok(t.errors.some(e => e.message === 'observer unavailable'));
  const db = new DatabaseSync(':memory:');
  try {
    t.app.skillShadow = new SkillShadow(db, games);
    t.app.rate(room); t.app.rate(room);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM skill_shadow_rounds').get().n, 1, 'неудачная запись повторяется после старого начисления');
  } finally { db.close(); }
});

test('сила: первое включение наблюдателя не пересчитывает уже сыгранную историю', async () => {
  const { t, room } = await humanGame(null), db = new DatabaseSync(':memory:');
  try {
    t.app.skillShadow = new SkillShadow(db, games);
    t.app.rate(room);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM skill_shadow_rounds').get().n, 0);
    const previous = room.history.at(-1);
    room.history.push({ ...previous, no: previous.no + 1 });
    t.app.rate(room);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM skill_shadow_rounds').get().n, 1, 'новый результат наблюдается');
  } finally { db.close(); }
});
