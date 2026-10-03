'use strict';
/**
 * Постоянный рейтинг: партия кончилась, а след остался.
 *
 * Правила целиком — в docs/rating.md; здесь то, из-за чего это не «прибавить
 * очков победителю»:
 *
 *   1. ОЧКИ ЗА МЕСТО, а не за выигранное. Иначе выгодно затягивать партию и
 *      раздувать банк, а не выигрывать.
 *   2. У КАЖДОЙ ИГРЫ СВОЙ РЕЙТИНГ. Хороший дурак и хороший покерист — разные
 *      умения, складывать их в одно число нечестно.
 *   3. НАКРУТИТЬ НЕЛЬЗЯ. Вдвоём за час можно нарисовать любое число, поэтому
 *      партия засчитывается, только если доиграна до конца, играли хотя бы
 *      двое, и у этого состава сегодня не больше десяти зачётных партий.
 *
 * Денег здесь нет и не будет: очки не покупаются, не выводятся и ни на что не
 * меняются. Рейтинг — это самолюбие, а не касса.
 */
import { ym } from './fmt.js';

/** Очки за место. Дальше четвёртого — всем «остальным, кто вышел». */
export const PLACE = [20, 12, 6];
export const REST = 3;
/** Дурак в дураке, последний по стеку в покере. */
export const LAST = -10;
/** Больше десяти зачётных партий в сутки один и тот же состав не наиграет. */
export const PER_DAY = 10;

export const GAME_RU = { durak: 'Дурак', poker: 'Покер', colors: 'UNOQ' };

export const WHY = {
  ABORTED: 'партия не доиграна — она не засчитывается',
  TOO_FEW: 'играл один — партии не было',
  FARMED: `партия без очков: с этим составом сегодня уже ${PER_DAY}`,
};

/** Сколько очков за место `i` (с нуля) из `n`. Последнему — минус. */
export function points(i, n, { last = true } = {}) {
  if (last && i === n - 1) return LAST;
  return PLACE[i] ?? REST;
}

/**
 * Отпечаток состава: те же люди в той же игре — тот же отпечаток, в каком бы
 * порядке они ни сели и сколько бы столов ни пересоздали. По нему и считается
 * дневной предел.
 */
export function fingerprint(game, userIds) {
  return `${game}:${[...new Set(userIds.map(String))].sort().join(',')}`;
}

/**
 * Разложить партию на начисления — ничего никуда не записывая.
 *
 * @param places  [{ id, name }] по местам: первый вышел первым
 * @param loserId кто остался дураком (в покере — последний по стеку); null,
 *                если проигравшего нет (ничья)
 * @returns [{ userId, name, place, of, delta, win, fool }]
 */
export function split(places, loserId = null) {
  const of = places.length;
  return places.map((p, i) => ({
    userId: String(p.id),
    name: p.name ?? null,
    place: i + 1,
    of,
    delta: points(i, of, { last: loserId != null }),
    win: i === 0,
    fool: loserId != null && String(p.id) === String(loserId),
  }));
}

/**
 * Записать партию в рейтинг.
 *
 * Возвращает либо `{ ok: true, rows }` — что кому начислено, либо
 * `{ skipped, why }` — почему партия не в счёт. Отказ всегда объясним словами:
 * человек должен понимать, почему за эту партию ничего не дали.
 */
export function apply(store, { game, round, places, loserId = null, aborted = false, chatId = null, at = Date.now() }) {
  if (aborted) return { skipped: 'ABORTED', why: WHY.ABORTED };
  const people = places.filter((p) => p && p.id != null);
  if (people.length < 2) return { skipped: 'TOO_FEW', why: WHY.TOO_FEW };

  const print = fingerprint(game, people.map((p) => p.id));
  // Считаем ДО записи: одиннадцатая партия играется как обычно, просто без
  // очков, и человеку об этом говорят.
  if (store.partyCount(print, at) >= PER_DAY) return { skipped: 'FARMED', why: WHY.FARMED };

  const rows = split(people, loserId);
  const written = [];
  for (const r of rows) {
    // Повтор той же партии (перезапуск, второй вызов) не удвоит очки: за это
    // отвечает база — строка журнала уникальна по человеку, игре и партии.
    if (store.rate({ ...r, game, round: String(round), chatId, at })) written.push(r);
  }
  if (!written.length) return { skipped: 'ALREADY', why: 'эта партия уже засчитана' };
  store.countParty(print, at);
  return { ok: true, rows: written, month: ym(at) };
}

/** «+20» или «−10» — как это пишется рядом с именем. */
export const sign = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
