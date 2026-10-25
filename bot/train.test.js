'use strict';
/**
 * «Тренировка» (покер): личный прогресс — bot/train.js, приём `train` в bot/hub.js.
 * (Тесты движка упражнений — bot/train.engine.test.js.)
 *
 *   ЛИЧНОСТЬ — только из initData; «чей» в теле игнорируется.
 *   ПРОВЕРКА — неизвестные направления, темы, навыки, уровни, оценки, лишние поля, размеры: отказ словами.
 *   ЛИЧНОЕ — прогресс не попадает ни в один экран других людей (что получил каждый телефон).
 *   АДАПТАЦИЯ — серия → предложение, не молчаливый скачок; ручной уровень сильнее.
 *   ПОВТОР — интервалы 1/3/7/14 по часам приложения, сброс при ошибке.
 *   ХРАНЕНИЕ — новые таблицы без смены версии схемы, ротация 500.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Table, user } from './harness.js';
import { Store, SCHEMA_VERSION } from './store.js';
import { KEEP_RESULTS, RESULTS_PER_MIN, TRAIN_ERRORS } from './train.js';
import { LADDER, DAY, afterMistake, afterCorrect, isDue } from '../miniapp/train/srs.js';
import { nextRating, levelPassed, suggestLevel } from '../miniapp/train/skills.js';

const ALICE = user(1, 'Алиса');
const BOB = user(2, 'Боб');
const CAROL = user(3, 'Катя');
const MIN = 60_000;

/** Отправить и вернуть ответ `train`. */
async function tr(t, u, msg) {
  const before = t.page(u).inbox.length;
  await t.send(u, { t: 'train', ...msg });
  const fresh = t.page(u).inbox.slice(before).filter((m) => m.t === 'train');
  return fresh[fresh.length - 1] ?? null;
}
const res = (over = {}) => ({ op: 'result', ex: 'pf-open-1', track: 'preflop', topic: 'open-raise', level: 1, score: 1, ms: 4000, mistakes: [], seed: 7, ...over });
const tableOf = async (store = new Store(':memory:')) => {
  const t = new Table({ store });
  await t.begin({ ALICE, BOB, CAROL });
  return t;
};

/* --------------------------------------------------------------- личность */

test('личность — только из initData: чужой id в теле игнорируется, чужой прогресс не тронут', async () => {
  const store = new Store(':memory:');
  const t = await tableOf(store);
  const r = await tr(t, BOB, res({ id: ALICE.id, uid: String(ALICE.id), userId: ALICE.id, user: { id: ALICE.id }, from: ALICE.id }));
  assert.equal(r.error, undefined);
  assert.equal(store.trainLoad(BOB.id).results.length, 1, 'у Боба записалось');
  assert.equal(store.trainLoad(ALICE.id).results.length, 0, 'у Алисы нет');
  assert.equal(store.trainLoad(CAROL.id).results.length, 0);
  store.close();
});

test('прогресс двух игроков не смешивается; «сбросить» стирает только свой', async () => {
  const store = new Store(':memory:');
  const t = await tableOf(store);
  await tr(t, ALICE, res({ score: 1 }));
  await tr(t, BOB, res({ topic: 'pot-odds', track: 'potodds', score: 0 }));
  const a = (await tr(t, ALICE, { op: 'get' })).progress;
  const b = (await tr(t, BOB, { op: 'get' })).progress;
  assert.equal(a.total, 1);
  assert.equal(b.total, 1);
  assert.deepEqual(a.weak, [], 'у Алисы слабых тем нет');
  assert.equal(b.weak[0].topic, 'pot-odds');
  const r = await tr(t, BOB, { op: 'reset' });
  assert.equal(r.reset, true);
  assert.equal(r.progress.total, 0);
  assert.equal(r.progress.started, false);
  assert.equal((await tr(t, ALICE, { op: 'get' })).progress.total, 1, 'у Алисы осталось');
  assert.deepEqual(store.trainLoad(BOB.id), { skills: [], results: [], topics: [], mistakes: [], passed: [] });
  store.close();
});

test('пустое состояние: человек, который ничего не решал', async () => {
  const t = await tableOf();
  const p = (await tr(t, ALICE, { op: 'get' })).progress;
  assert.equal(p.started, false);
  assert.equal(p.total, 0);
  assert.equal(p.skills.length, 4);
  assert.ok(p.skills.every((s) => s.level === 1 && s.rating === 0 && !s.mastered && s.suggest === null));
  assert.equal(p.tracks.length, 8);
  assert.deepEqual(p.mistakes, []);
});

/* --------------------------------------------------------------- проверка */

test('плохие сообщения — отказ словами, в базу ничего не попадает', async () => {
  const store = new Store(':memory:');
  const t = await tableOf(store);
  const bad = [
    [{ op: 'nope' }, 'TRAIN_BAD_OP'],
    [{}, 'TRAIN_BAD_OP'],
    [{ op: 42 }, 'TRAIN_BAD_OP'],
    [res({ track: 'bogus' }), 'TRAIN_BAD_TRACK'],
    [res({ track: { a: 1 } }), 'TRAIN_BAD_TRACK'],
    [res({ topic: 'bogus' }), 'TRAIN_BAD_TOPIC'],
    [res({ topic: '__proto__' }), 'TRAIN_BAD_TOPIC'],
    [res({ level: 0 }), 'TRAIN_BAD_LEVEL'],
    [res({ level: 6 }), 'TRAIN_BAD_LEVEL'],
    [res({ level: 2.5 }), 'TRAIN_BAD_LEVEL'],
    [res({ level: '2' }), 'TRAIN_BAD_LEVEL'],
    [res({ score: 1.01 }), 'TRAIN_BAD_SCORE'],
    [res({ score: -0.1 }), 'TRAIN_BAD_SCORE'],
    [res({ score: '1' }), 'TRAIN_BAD_SCORE'],
    [res({ score: null }), 'TRAIN_BAD_SCORE'],
    [res({ ms: -1 }), 'TRAIN_BAD_FIELD'],
    [res({ ms: 1e12 }), 'TRAIN_BAD_FIELD'],
    [res({ seed: -3 }), 'TRAIN_BAD_FIELD'],
    [res({ ex: 'x'.repeat(5000) }), 'TRAIN_BAD_EX'],
    [res({ ex: '<script>' }), 'TRAIN_BAD_EX'],
    [res({ ex: '' }), 'TRAIN_BAD_EX'],
    [res({ mistakes: Array(9).fill('a') }), 'TRAIN_BAD_FIELD'],
    [res({ mistakes: ['x'.repeat(500)] }), 'TRAIN_BAD_FIELD'],
    [res({ mistakes: 'a' }), 'TRAIN_BAD_FIELD'],
    [res({ extra: 'лишнее' }), 'TRAIN_BAD_FIELD'],
    [res({ junk: 'x'.repeat(100000) }), 'TRAIN_BAD_FIELD'],
    [{ op: 'level', skill: 'bogus', level: 2 }, 'TRAIN_BAD_SKILL'],
    [{ op: 'level', skill: 'math', level: 9 }, 'TRAIN_BAD_LEVEL'],
    [{ op: 'get', extra: 1 }, 'TRAIN_BAD_FIELD'],
  ];
  for (const [msg, code] of bad) {
    const r = await tr(t, ALICE, msg);
    assert.equal(r.error?.code, code, JSON.stringify(msg).slice(0, 80));
    assert.equal(r.error.text, TRAIN_ERRORS[code], 'отказ — словами');
    await t.clock.advance(MIN);
  }
  assert.equal(store.trainLoad(ALICE.id).results.length, 0);
  assert.equal(store.trainLoad(ALICE.id).skills.length, 0);
  store.close();
});

test('частота: больше RESULTS_PER_MIN ответов в минуту — отказ, через минуту снова можно', async () => {
  const t = await tableOf();
  for (let i = 0; i < RESULTS_PER_MIN; i++) assert.equal((await tr(t, ALICE, res())).error, undefined, `ответ ${i}`);
  assert.equal((await tr(t, ALICE, res())).error.code, 'TRAIN_FAST');
  assert.equal((await tr(t, BOB, res())).error, undefined, 'у другого игрока свой счётчик');
  await t.clock.advance(MIN + 1);
  assert.equal((await tr(t, ALICE, res())).error, undefined);
});

test('ротация: хранится не больше KEEP_RESULTS ответов, но пройденные уровни помнятся', async () => {
  const store = new Store(':memory:');
  const t = await tableOf(store);
  let passed = false;
  for (let i = 0; i < KEEP_RESULTS + 30; i++) {
    if (i % 30 === 0) await t.clock.advance(MIN + 1);
    const r = await tr(t, ALICE, res({ ex: `pf-${i % 7}`, seed: i }));
    passed ||= !!r.result?.passedLevel;
  }
  assert.ok(passed, 'уровень был пройден');
  const d = store.trainLoad(ALICE.id);
  assert.equal(d.results.length, KEEP_RESULTS);
  assert.deepEqual(d.passed.map((p) => `${p.track}:${p.level}`), ['preflop:1'], 'пройденный уровень записан навсегда');
  store.close();
});

/* ----------------------------------------------------- прогресс — личный */

test('прогресс не попадает в то, что получают другие телефоны: стол, чат, рейтинг, хаб группы', async () => {
  const t = await tableOf();
  await tr(t, ALICE, res({ score: 0.2, mistakes: ['too-loose'] }));
  await tr(t, ALICE, { op: 'level', skill: 'math', level: 4 });
  for (const u of [BOB, CAROL]) {
    const all = JSON.stringify(t.page(u).inbox);
    assert.ok(!all.includes('"train"'), 'ни одного сообщения train у соседа');
    assert.ok(!all.includes('too-loose'), 'код ошибки Алисы не у соседа');
    assert.ok(!all.includes('"progress"'));
    assert.ok(!all.includes('open-raise'));
  }
  const card = JSON.stringify(t.tg.messages ? [...t.tg.messages.values()] : []);
  assert.ok(!card.includes('open-raise') && !card.includes('too-loose'));
  const view = JSON.stringify(t.state(BOB));
  assert.ok(!view.includes('too-loose') && !view.includes('"skills"'));
});

/* ------------------------------------------------------------- адаптация */

test('адаптация: 7 из 8 верно — предложение «повысить», уровень сам не меняется; согласие меняет', async () => {
  const t = await tableOf();
  let r;
  for (let i = 0; i < 8; i++) r = await tr(t, ALICE, res({ ex: `a${i}`, score: i === 3 ? 0.2 : 1 }));
  const s = r.progress.skills.find((x) => x.id === 'preflop');
  assert.equal(s.level, 1, 'молча уровень не прыгнул');
  assert.equal(s.suggest.to, 2);
  assert.equal(s.suggest.dir, 'up');
  assert.match(s.suggest.text, /7 из 8/);
  r = await tr(t, ALICE, { op: 'level', skill: 'preflop', level: 2 });
  const s2 = r.progress.skills.find((x) => x.id === 'preflop');
  assert.equal(s2.level, 2);
  assert.equal(s2.suggest, null, 'после смены серия считается заново');
  assert.equal(s2.rating > 0, true, 'рейтинг не потерян');
});

test('адаптация: почти всё мимо — предложение «понизить»; ручной выбор сильнее', async () => {
  const t = await tableOf();
  await tr(t, ALICE, { op: 'level', skill: 'postflop', level: 3 });
  await t.clock.advance(10);
  let r;
  for (let i = 0; i < 8; i++) r = await tr(t, ALICE, res({ track: 'postflop', topic: 'cbet', ex: `p${i}`, level: 3, score: i < 1 ? 1 : 0 }));
  const s = r.progress.skills.find((x) => x.id === 'postflop');
  assert.equal(s.level, 3, 'сам не понизился');
  assert.equal(s.suggest.dir, 'down');
  r = await tr(t, ALICE, { op: 'level', skill: 'postflop', level: 5 });
  assert.equal(r.progress.skills.find((x) => x.id === 'postflop').level, 5, 'игрок хочет сложнее — его слово');
});

test('адаптация (правила): на краях уровней предложений нет, ровная игра — тоже', () => {
  const mk = (n, good) => Array.from({ length: n }, (_, i) => (i < good ? 1 : 0));
  assert.equal(suggestLevel(5, mk(8, 8)), null, 'выше 5 некуда');
  assert.equal(suggestLevel(1, mk(8, 0)), null, 'ниже 1 некуда');
  assert.equal(suggestLevel(2, mk(8, 5)), null);
  assert.equal(suggestLevel(2, mk(7, 7)), null, 'серия ещё не набрана');
});

test('уровень направления пройден: 8 из последних 10 с оценкой ≥ 0,7; 7 — нет', async () => {
  const mk = (good) => Array.from({ length: 10 }, (_, i) => (i < good ? 0.7 : 0.69));
  assert.equal(levelPassed(mk(8)), true);
  assert.equal(levelPassed(mk(7)), false);
  assert.equal(levelPassed(mk(8).slice(0, 9)), false, 'меньше 10 заданий — рано');
  const t = await tableOf();
  let r;
  for (let i = 0; i < 10; i++) r = await tr(t, ALICE, res({ ex: `q${i}`, score: i < 2 ? 0 : 1 }));
  assert.deepEqual(r.result.passedLevel, { track: 'preflop', level: 1 });
  const track = r.progress.tracks.find((x) => x.id === 'preflop');
  assert.deepEqual(track.passed, [1]);
  assert.equal(track.accuracy, 80);
});

test('рейтинг навыка: свежие ответы весят больше, шкала 0…100', () => {
  let r = 0;
  for (let n = 0; n < 5; n++) r = nextRating(r, n, 1);
  assert.equal(r, 100);
  for (let n = 5; n < 15; n++) r = nextRating(r, n, 0);
  assert.ok(r < 25 && r >= 0, `после серии промахов ${r}`);
});

/* --------------------------------------------------------------- повторение */

test('повторение (правило): 1, 3, 7, 14 дней, ошибка сбрасывает, раньше срока не считается', () => {
  assert.deepEqual(LADDER, [1, 3, 7, 14]);
  const t0 = 1_000_000;
  let s = afterMistake(null, t0);
  assert.deepEqual([s.step, s.dueAt, s.lapses], [0, t0 + DAY, 1]);
  assert.equal(afterCorrect(s, t0 + DAY - 1), s, 'раньше срока — не считается');
  assert.equal(isDue(s, t0 + DAY), true);
  let now = t0 + DAY;
  for (const days of [3, 7, 14]) {
    s = afterCorrect(s, now);
    assert.equal(s.dueAt, now + days * DAY);
    now = s.dueAt;
  }
  s = afterCorrect(s, now);
  assert.equal(s.done, true, 'после 14 дней — закреплена');
  const again = afterMistake(s, now + 5);
  assert.deepEqual([again.step, again.lapses, again.done], [0, 2, false], 'ошибка начинает заново');
});

test('повторение по часам приложения (FakeClock): тема приходит «пора», проходит интервалы, при ошибке сбрасывается', async () => {
  const t = await tableOf();
  const get = async () => (await tr(t, ALICE, { op: 'get' })).progress;
  await tr(t, ALICE, res({ topic: 'pot-odds', track: 'potodds', score: 0.1, mistakes: ['ignored-odds'] }));
  let p = await get();
  assert.deepEqual(p.due, [], 'сразу не пора — только через сутки');
  assert.equal(p.weak[0].topic, 'pot-odds');
  assert.equal(p.mistakes[0].code, 'ignored-odds');
  await t.clock.advance(DAY);
  p = await get();
  assert.deepEqual(p.due, ['pot-odds'], 'через сутки — пора');
  await tr(t, ALICE, res({ topic: 'pot-odds', track: 'potodds', score: 1 }));
  p = await get();
  assert.equal(p.weak[0].intervalDays, 3);
  assert.deepEqual(p.due, []);
  await t.clock.advance(3 * DAY);
  await tr(t, ALICE, res({ topic: 'pot-odds', track: 'potodds', score: 0.3 }));
  p = await get();
  assert.equal(p.weak[0].intervalDays, 1, 'ошибка вернула на первый шаг');
  assert.equal(p.weak[0].lapses, 2);
  for (const days of [1, 3, 7, 14]) {
    await t.clock.advance(days * DAY);
    await tr(t, ALICE, res({ topic: 'pot-odds', track: 'potodds', score: 1 }));
  }
  p = await get();
  assert.deepEqual(p.weak, []);
  assert.deepEqual(p.masteredTopics, ['pot-odds']);
});

test('часы страницы не нужны: время в сообщении не принимается', async () => {
  const t = await tableOf();
  const r = await tr(t, ALICE, res({ at: 1, now: 1, due: 1 }));
  assert.equal(r.error.code, 'TRAIN_BAD_FIELD');
});

/* ----------------------------------------------------------------- хранение */

test('таблицы тренировки: создаются в пустой базе, переживают перезапуск, пересоздаются, версия схемы прежняя', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'train-'));
  const file = path.join(dir, 'bot.db');
  let store = new Store(file);
  let t = await tableOf(store);
  await tr(t, ALICE, res({ score: 0.2, mistakes: ['m1'] }));
  store.close();
  store = new Store(file);
  t = await tableOf(store);
  const p = (await tr(t, ALICE, { op: 'get' })).progress;
  assert.equal(p.total, 1, 'пережило перезапуск');
  assert.equal(p.mistakes[0].code, 'm1');
  store.close();

  const raw = new DatabaseSync(file);
  for (const name of ['train_skill', 'train_result', 'train_topic', 'train_mistake', 'train_pass']) raw.exec(`DROP TABLE ${name}`);
  assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, SCHEMA_VERSION);
  raw.close();
  store = new Store(file);
  assert.equal(store.trainLoad(ALICE.id).results.length, 0, 'таблицы созданы заново');
  store.close();
  const check = new DatabaseSync(file, { readOnly: true });
  assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, '5', 'версия схемы не поднималась');
  check.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('без постоянной базы (NullStore) всё работает в памяти и так же', async () => {
  const t = new Table();
  await t.begin({ ALICE, BOB, CAROL });
  await tr(t, ALICE, res({ score: 0.2, mistakes: ['m1'] }));
  const p = (await tr(t, ALICE, { op: 'get' })).progress;
  assert.equal(p.total, 1);
  assert.equal(p.weak[0].topic, 'open-raise');
  assert.equal((await tr(t, BOB, { op: 'get' })).progress.total, 0);
});

test('общий счётчик для пульта — только число людей, без имён', async () => {
  const t = await tableOf();
  assert.equal(t.app.store.trainPeople(), 0);
  await tr(t, ALICE, res());
  assert.equal(t.app.store.trainPeople(), 1);
});
