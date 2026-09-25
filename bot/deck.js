'use strict';
/**
 * Колода. 52 карты, честная тасовка, раздача.
 *
 * Карта — целое 0..51: `rank * 4 + suit`, где rank 0..12 = 2..A,
 * suit 0..3 = ♠♥♦♣. Целые, а не объекты: оценщик перебирает 21 комбинацию на
 * каждого игрока, и сравнение чисел там заметно дешевле.
 *
 * Тасовка — Фишер–Йетс на `crypto.randomInt`, а не на `Math.random()`.
 * Math.random() предсказуем: зная несколько выходов, можно восстановить
 * состояние генератора и посчитать остаток колоды. Для игры на деньги это
 * было бы дырой; здесь фишки виртуальные, но цена честного ГСЧ — одна строка.
 */
import crypto from 'node:crypto';

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SUITS = ['♠', '♥', '♦', '♣'];

export const DECK_SIZE = 52;

export const rankOf = (card) => card >> 2; // 0..12
export const suitOf = (card) => card & 3; // 0..3

/** "A♠" — то, что видит человек. */
export function cardName(card) {
  return RANKS[rankOf(card)] + SUITS[suitOf(card)];
}

export const handName = (cards) => cards.map(cardName).join(' ');

/** Свежая колода в порядке 0..51 — тасуется отдельно. */
export const freshDeck = () => Array.from({ length: DECK_SIZE }, (_, i) => i);

/**
 * Фишер–Йетс. `rnd(n)` должен вернуть целое из [0, n) — по умолчанию
 * криптографический, в тестах подменяется на детерминированный.
 */
export function shuffle(deck, rnd = (n) => crypto.randomInt(n)) {
  const a = [...deck];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const shuffled = (rnd) => shuffle(freshDeck(), rnd);

/**
 * Снять `n` карт сверху. Возвращает новый курсор, а не мутирует колоду:
 * состояние раздачи целиком сериализуется в SQLite, и мутирующая колода
 * пережила бы рестарт хуже, чем пара чисел.
 */
export function draw(deck, cursor, n) {
  if (cursor + n > deck.length) throw new Error('колода кончилась');
  return { cards: deck.slice(cursor, cursor + n), cursor: cursor + n };
}

/** Разбор "As", "Kd", "10h", "Th" — нужен тестам и ручной отладке. */
export function parseCard(s) {
  const t = String(s).trim().toUpperCase().replace('10', 'T');
  const r = '23456789TJQKA'.indexOf(t[0]);
  const suit = { S: 0, H: 1, D: 2, C: 3, '♠': 0, '♥': 1, '♦': 2, '♣': 3 }[t.slice(1)];
  if (r < 0 || suit === undefined) throw new Error(`не карта: ${s}`);
  return r * 4 + suit;
}

export const parseHand = (s) => String(s).trim().split(/\s+/).map(parseCard);
