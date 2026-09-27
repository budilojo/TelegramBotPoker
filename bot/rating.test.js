'use strict';
/**
 * Рейтинг. Проверяется не «прибавилось ли число», а три вещи, без которых
 * рейтинг бессмысленен:
 *
 *   1. очки идут ЗА МЕСТО и у каждой игры свои;
 *   2. партию нельзя засчитать дважды — ни повторным вызовом, ни перезапуском;
 *   3. накрутить нельзя: недоигранное не в счёт, вдвоём за день — предел.
 *
 * Отдельно проверяется, что рейтинг переживает перезапуск бота: в этом весь
 * смысл слова «постоянный».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.js';
import { apply, fingerprint, points, split, PER_DAY, LAST } from './rating.js';
import { Table, user, durakDecks } from './harness.js';
import { allCovered, waitingThrowers } from './games/durak/rules.js';
import { RANKS } from './games/durak/cards.js';

const DAY = Date.parse('2026-09-10T18:00:00Z');
const people = (...ids) => ids.map((id) => ({ id, name: `И${id}` }));

const who = (cast, id) => cast.find((u) => String(u.id) === String(id));
const low = (cards) => cards.reduce((a, b) => (RANKS.indexOf(b.slice(0, -1)) < RANKS.indexOf(a.slice(0, -1)) ? b : a));

/** Доиграть партию так, как её играли бы с телефонов: ход выбирается из того,
 *  что СВОЯ страница считает разрешённым. */
async function playDurak(t, cast, limit = 3000) {
  for (let i = 0; i < limit && t.durak.deal?.phase === 'play'; i++) {
    const d = t.durak.deal;
    if (!d.table.length) {
      const u = who(cast, d.attacker);
      const s = t.state(u);
      await t.send(u, { t: 'attack', card: low(s.legal.attack), seq: s.seq });
    } else if (!allCovered(d) && !d.bout.taking) {
      const u = who(cast, d.defender);
      const s = t.state(u);
      const at = s.deal.table.findIndex((x) => !x.d);
      const card = Object.keys(s.legal.defend).find((c) => s.legal.defend[c].includes(at));
      await t.send(u, card ? { t: 'defend', card, target: at, seq: s.seq } : { t: 'take', seq: s.seq });
    } else {
      for (const id of waitingThrowers(d)) await t.send(who(cast, id), { t: 'pass', seq: t.state(who(cast, id)).seq });
    }
  }
  assert.equal(t.durak.deal.phase, 'over', 'партия доиграна до конца');
}

/* ------------------------------------------------------------- начисление */

test('очки идут за место, а не за победу', () => {
  assert.equal(points(0, 4), 20, 'вышел первым');
  assert.equal(points(1, 4), 12);
  assert.equal(points(2, 4), 6);
  assert.equal(points(3, 4), LAST, 'последний — дурак');
  assert.equal(points(3, 5), 3, 'из пятерых четвёртый просто вышел');
  assert.equal(points(4, 5), LAST);
});

test('без проигравшего (ничья) минуса нет ни у кого', () => {
  const rows = split(people(1, 2, 3), null);
  assert.deepEqual(rows.map((r) => r.delta), [20, 12, 6]);
  assert.equal(rows.some((r) => r.fool), false);
});

test('дурак помечен дураком, первый — победителем', () => {
  const rows = split(people(1, 2, 3), 3);
  assert.equal(rows[0].win, true);
  assert.equal(rows.at(-1).fool, true);
  assert.equal(rows[1].win, false);
});

/* ------------------------------------------------------------------ база */

test('рейтинг у каждой игры свой', () => {
  const store = new Store(':memory:');
  apply(store, { game: 'durak', round: 'd1', places: people(1, 2), loserId: 2, at: DAY });
  apply(store, { game: 'poker', round: 'p1', places: people(2, 1), loserId: 1, at: DAY });
  assert.equal(store.ratingOf(1, 'durak').points, 20);
  assert.equal(store.ratingOf(1, 'poker').points, 0, 'в покере он последний');
  assert.equal(store.ratingOf(2, 'poker').points, 20);
  store.close();
});

test('ниже нуля рейтинг не падает', () => {
  const store = new Store(':memory:');
  // Первый трижды остаётся дураком: он последний в списке мест.
  for (let i = 0; i < 3; i++) apply(store, { game: 'durak', round: `r${i}`, places: people(2, 1), loserId: 1, at: DAY });
  assert.equal(store.ratingOf(1, 'durak').points, 0, 'три раза подряд дурак — но не минус тридцать');
  assert.equal(store.ratingOf(1, 'durak').fools, 3, 'а вот дураком он был три раза, и это видно');
  store.close();
});

test('та же партия второй раз не считается', () => {
  const store = new Store(':memory:');
  const first = apply(store, { game: 'durak', round: 'd1', places: people(1, 2), loserId: 2, at: DAY });
  const again = apply(store, { game: 'durak', round: 'd1', places: people(1, 2), loserId: 2, at: DAY });
  assert.equal(first.ok, true);
  assert.equal(again.ok, undefined, 'второй раз — отказ');
  assert.equal(again.skipped, 'ALREADY');
  assert.equal(store.ratingOf(1, 'durak').points, 20, 'очки не удвоились');
  assert.equal(store.ratingOf(1, 'durak').played, 1, 'и партия одна');
  store.close();
});

test('месяц сменился — счёт месяца с нуля, за всё время цел', () => {
  const store = new Store(':memory:');
  apply(store, { game: 'durak', round: 'a', places: people(1, 2), loserId: 2, at: Date.parse('2026-09-28') });
  apply(store, { game: 'durak', round: 'b', places: people(1, 2), loserId: 2, at: Date.parse('2026-10-02') });
  assert.equal(store.ratingOf(1, 'durak').points, 40, 'за всё время — обе партии');
  assert.equal(store.ratingOf(1, 'durak', { month: '2026-10' }).points, 20, 'за октябрь — только октябрьская');
  assert.equal(store.ratingOf(1, 'durak', { month: '2026-09' }).points, 0, 'сентябрь уже не его');
  store.close();
});

test('в таблице выше тот, у кого больше очков; при равенстве — кто сыграл меньше', () => {
  const store = new Store(':memory:');
  store.rate({ userId: 1, game: 'durak', round: 'a', place: 2, of: 3, delta: 12, name: 'Один', at: DAY });
  store.rate({ userId: 2, game: 'durak', round: 'b', place: 3, of: 4, delta: 6, name: 'Два', at: DAY });
  store.rate({ userId: 2, game: 'durak', round: 'c', place: 3, of: 4, delta: 6, name: 'Два', at: DAY });
  store.rate({ userId: 3, game: 'durak', round: 'd', place: 1, of: 2, delta: 20, name: 'Три', at: DAY });

  const top = store.ratingTop('durak');
  assert.deepEqual(top.map((r) => r.userId), ['3', '1', '2']);
  assert.equal(top[1].points, top[2].points, 'у второго и третьего очки поровну');
  assert.equal(top[1].played, 1, 'но выше тот, кто набрал их за одну партию');
  assert.equal(store.ratingOf(2, 'durak').place, 3);
  assert.equal(store.ratingOf(2, 'durak').total, 3);
  store.close();
});

/* ------------------------------------------------- чтобы нельзя накрутить */

test('недоигранная партия не засчитывается, и отказ объясняется', () => {
  const store = new Store(':memory:');
  const r = apply(store, { game: 'durak', round: 'x', places: people(1, 2), loserId: 2, aborted: true, at: DAY });
  assert.equal(r.skipped, 'ABORTED');
  assert.match(r.why, /не доиграна/);
  assert.equal(store.ratingOf(1, 'durak'), null, 'ни строки в рейтинге');
  store.close();
});

test('играл один — партии не было', () => {
  const store = new Store(':memory:');
  const r = apply(store, { game: 'durak', round: 'x', places: people(1), loserId: null, at: DAY });
  assert.equal(r.skipped, 'TOO_FEW');
  store.close();
});

test(`с одним составом за сутки считаются ${PER_DAY} партий, дальше — без очков`, () => {
  const store = new Store(':memory:');
  for (let i = 0; i < PER_DAY; i++) {
    assert.equal(apply(store, { game: 'durak', round: `r${i}`, places: people(1, 2), loserId: 2, at: DAY }).ok, true);
  }
  const extra = apply(store, { game: 'durak', round: 'r99', places: people(1, 2), loserId: 2, at: DAY });
  assert.equal(extra.skipped, 'FARMED');
  assert.match(extra.why, /уже 10/);
  assert.equal(store.ratingOf(1, 'durak').points, PER_DAY * 20, 'одиннадцатая ничего не добавила');

  // Назавтра счётчик обнуляется сам: играть-то не запрещено.
  assert.equal(apply(store, { game: 'durak', round: 'r100', places: people(1, 2), loserId: 2, at: DAY + 86_400_000 }).ok, true);
  store.close();
});

test('предел — на состав, а не на стол: пересоздать стол не поможет', () => {
  assert.equal(fingerprint('durak', [2, 1]), fingerprint('durak', ['1', '2', '1']));
  assert.notEqual(fingerprint('durak', [1, 2]), fingerprint('poker', [1, 2]));
  assert.notEqual(fingerprint('durak', [1, 2]), fingerprint('durak', [1, 2, 3]), 'третий игрок — другой состав');
});

test('позвали третьего — это другой состав, и предел у него свой', () => {
  const store = new Store(':memory:');
  for (let i = 0; i < PER_DAY; i++) apply(store, { game: 'durak', round: `r${i}`, places: people(1, 2), loserId: 2, at: DAY });
  const three = apply(store, { game: 'durak', round: 'three', places: people(1, 2, 3), loserId: 3, at: DAY });
  assert.equal(three.ok, true, 'вдвоём наигрались, втроём — играйте');
  store.close();
});

/* ------------------------------------------------------- живая игра и диск */

test('партия дурака за настоящим столом попадает в рейтинг один раз', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store, durakDeck: durakDecks(5) });
  const cast = [user(101, 'Иван'), user(202, 'Макс'), user(303, 'Дима')];
  const [host, ...rest] = cast;
  for (const u of cast) await t.start(u);
  await t.cmd(host, '/play');
  t.openHub(host);
  await t.send(host, { t: 'create', game: 'durak', settings: {} });
  for (const u of rest) {
    t.openRoom(u, t.durak);
    await t.send(u, { t: 'sit' });
  }
  await t.send(host, { t: 'start' });
  await playDurak(t, cast);

  const rows = store.ratingTop('durak');
  assert.equal(rows.length, 3, 'все трое в рейтинге');
  assert.equal(rows.reduce((n, r) => n + r.played, 0), 3, 'по одной партии на каждого');
  assert.equal(rows.filter((r) => r.wins).length, 1, 'победитель ровно один');
  assert.equal(rows.reduce((n, r) => n + r.fools, 0), 1, 'и дурак ровно один');

  const fool = t.durak.history.at(-1).fool;
  assert.equal(store.ratingOf(fool, 'durak').points, 0, 'дураку минус десять, но ниже нуля не уводит');
  assert.equal(store.ratingLog(fool, 'durak')[0].delta, -10);

  // Ещё один прогон рейтинга ничего не добавит: партия уже засчитана.
  t.app.rate(t.durak);
  assert.equal(store.ratingTop('durak').reduce((n, r) => n + r.played, 0), 3);
  store.close();
});

test('рейтинг переживает перезапуск бота', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rating-')), 'db.sqlite');
  const first = new Store(file);
  apply(first, { game: 'durak', round: 'r1', places: people(1, 2), loserId: 2, at: DAY });
  first.close();

  const again = new Store(file);
  assert.equal(again.ratingOf(1, 'durak').points, 20, 'очки на месте после перезапуска');
  // И та же партия после перезапуска всё ещё не считается второй раз.
  assert.equal(apply(again, { game: 'durak', round: 'r1', places: people(1, 2), loserId: 2, at: DAY }).skipped, 'ALREADY');
  assert.equal(again.ratingOf(1, 'durak').points, 20);
  again.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('журнал помнит, откуда очки', () => {
  const store = new Store(':memory:');
  apply(store, { game: 'durak', round: 'r1', places: people(1, 2, 3), loserId: 3, at: DAY });
  const log = store.ratingLog(1, 'durak');
  assert.equal(log.length, 1);
  assert.equal(log[0].place, 1);
  assert.equal(log[0].of, 3);
  assert.equal(log[0].delta, 20);
  store.close();
});
