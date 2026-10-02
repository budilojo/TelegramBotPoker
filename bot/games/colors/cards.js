'use strict';
/**
 * Колода «Радуги»: 108 карт четырёх цветов.
 *
 * Карта — это имя её картинки, как в покере и в дураке: 'R5', 'GS', 'WF'.
 * Первая буква — цвет (R/Y/G/B), вторая — что на карте: цифра 0–9, 'S'
 * («стоп»), 'V' («разворот»), 'P' («+2»). Две бесцветные карты — 'WC'
 * («смена цвета») и 'WF' («смена цвета +4») — без цвета вовсе.
 *
 * В одном цвете: один ноль, по две карты каждой цифры 1–9, по две «стоп»,
 * «разворот» и «+2» — 25 карт; четыре цвета, плюс по четыре 'WC' и 'WF' —
 * 108. Значит, ОДНА И ТА ЖЕ карта лежит в колоде дважды, и в руке может
 * оказаться два 'R5'. Всё, что работает с рукой, обязано это выдерживать:
 * сравнивать по значению и убирать ровно один экземпляр.
 *
 * У каждого цвета есть ещё и своя ФИГУРА (круг, треугольник, квадрат, ромб).
 * Это не украшение: пара «красный — зелёный» — ровно та, которую не различают
 * дальтоники, а их около восьми процентов мужчин. Фигура — часть карты, и
 * выключателя для неё нет.
 */
import crypto from 'node:crypto';

export const COLORS = ['R', 'Y', 'G', 'B'];
/** Порядок цветов в руке — всегда один и тот же, от партии к партии. */
export const COLOR_ORDER = COLORS;
export const HAND = 7;
export const DECK_SIZE = 108;

export const COLOR_RU = { R: 'красный', Y: 'жёлтый', G: 'зелёный', B: 'синий' };
export const COLOR_HEX = { R: '#E04A3F', Y: '#F2B22E', G: '#2FA355', B: '#2D6FD8' };
/** Фигура цвета — второй признак, по которому цвет узнаётся без цвета. */
export const COLOR_SHAPE = { R: 'circle', Y: 'triangle', G: 'square', B: 'diamond' };
export const SHAPE_RU = { circle: 'круг', triangle: 'треугольник', square: 'квадрат', diamond: 'ромб' };

/** Знаки особых карт. Цифры 0–9 — сами себе знаки. */
export const SIGNS = ['S', 'V', 'P'];
export const SIGN_RU = { S: 'стоп', V: 'разворот', P: '+2' };
export const WILD = 'WC';
export const WILD_FOUR = 'WF';

const CARD = /^(?:[RYGB](?:[0-9]|S|V|P)|WC|WF)$/;

export const isCard = (c) => typeof c === 'string' && CARD.test(c);
/** Бесцветные карты — у них нет своего цвета, цвет им называет игрок. */
export const isWild = (c) => c === WILD || c === WILD_FOUR;
/** Цвет карты, или null у бесцветной. */
export const colorOf = (c) => (isWild(c) ? null : c[0]);
/** Знак карты: цифра '0'–'9', 'S', 'V', 'P' — или 'WC'/'WF' у бесцветных. */
export const signOf = (c) => (isWild(c) ? c : c.slice(1));
export const isNumber = (c) => !isWild(c) && /^[0-9]$/.test(signOf(c));

/** «красная 5», «синий стоп», «смена цвета +4» — как карта называется словами. */
export function label(c) {
  if (c === WILD) return 'смена цвета';
  if (c === WILD_FOUR) return 'смена цвета +4';
  const s = signOf(c);
  return isNumber(c) ? `${COLOR_RU[colorOf(c)]} ${s}` : `${COLOR_RU[colorOf(c)]} «${SIGN_RU[s]}»`;
}

/**
 * Можно ли положить `card` на `top` при текущем цвете `color`?
 *
 * Правило одно: тот же цвет, то же число или тот же знак — а бесцветные
 * кладутся всегда. Цвет берётся не с верхней карты, а из `color`: после
 * «смены цвета» верхняя карта бесцветная, а цвет назван.
 *
 * Про накопление здесь ничего нет: это отдельное правило, и живёт оно в
 * rules.js, где известно, сколько карт висит на столе.
 */
export function matches(card, top, color) {
  if (!isCard(card) || !isCard(top)) return false;
  if (isWild(card)) return true;
  if (colorOf(card) === color) return true;
  return !isWild(top) && signOf(card) === signOf(top);
}

export function freshDeck() {
  const out = [];
  for (const c of COLORS) {
    out.push(`${c}0`);
    for (let n = 1; n <= 9; n++) out.push(`${c}${n}`, `${c}${n}`);
    for (const s of SIGNS) out.push(`${c}${s}`, `${c}${s}`);
  }
  for (let i = 0; i < 4; i++) out.push(WILD, WILD_FOUR);
  return out;
}

/** Fisher–Yates на crypto.randomInt — та же тасовка, что у покера и дурака. */
export function shuffled(randInt = (n) => crypto.randomInt(n)) {
  const d = freshDeck();
  for (let i = d.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/** Перетасовать то, что дали (сброс, вернувшийся в колоду) — на месте не трогая. */
export function shuffleOf(cards, randInt = (n) => crypto.randomInt(n)) {
  const d = [...cards];
  for (let i = d.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/**
 * Пачка — это ровно 108 карт нужного состава, в любом порядке. Подтасованная
 * в тестах колода проходит ту же проверку, что настоящая.
 */
export function isFullDeck(deck) {
  if (!Array.isArray(deck) || deck.length !== DECK_SIZE) return false;
  if (!deck.every(isCard)) return false;
  const want = tally(freshDeck());
  const got = tally(deck);
  if (want.size !== got.size) return false;
  for (const [c, n] of want) if (got.get(c) !== n) return false;
  return true;
}

function tally(cards) {
  const m = new Map();
  for (const c of cards) m.set(c, (m.get(c) || 0) + 1);
  return m;
}

/** Убрать из руки ОДИН экземпляр карты. Второй такой же остаётся. */
export function takeOne(hand, card) {
  const i = hand.indexOf(card);
  if (i < 0) return false;
  hand.splice(i, 1);
  return true;
}

/** Вес знака внутри цвета: сперва цифры по возрастанию, потом особые. */
const signWeight = (c) => (isNumber(c) ? Number(signOf(c)) : 10 + SIGNS.indexOf(signOf(c)));

/**
 * Рука так, как её держат: цвета в неизменном порядке (красный, жёлтый,
 * зелёный, синий), внутри цвета по возрастанию номинала, особые карты цвета
 * после цифр, бесцветные — в самом конце.
 *
 * Фиксированный порядок важнее «красивее»: рука выглядит одинаково от партии
 * к партии, и палец начинает попадать по памяти. Сортировка чистая и
 * устойчивая — одна и та же рука всегда ложится одинаково, поэтому чужой ход
 * не может сдвинуть карту из-под пальца.
 */
export function sortHand(cards) {
  const key = (c) => (isWild(c) ? [9, c === WILD ? 0 : 1, 0] : [COLOR_ORDER.indexOf(colorOf(c)), 0, signWeight(c)]);
  return [...cards].sort((a, b) => {
    const [ka, sa, wa] = key(a);
    const [kb, sb, wb] = key(b);
    return ka - kb || sa - sb || wa - wb || (a < b ? -1 : a > b ? 1 : 0);
  });
}
