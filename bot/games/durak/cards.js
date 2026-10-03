'use strict';
/**
 * The 36-card pack of durak: 6 up to the ace, four suits. A card is its
 * picture's file name — '6S', '10H', 'QD', 'AC' — the same names as the 52
 * SVGs the poker table already has, so the Mini App needs nothing new.
 */
import crypto from 'node:crypto';

export const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SUITS = ['S', 'H', 'D', 'C'];
export const HAND = 6;

const RANK_RU = { J: 'В', Q: 'Д', K: 'К', A: 'Т' };
export const SUIT_SIGN = { S: '♠', H: '♥', D: '♦', C: '♣' };
/** "trumps are diamonds" — «козырь — бубны» */
export const SUIT_RU = { S: 'пики', H: 'черви', D: 'бубны', C: 'трефы' };

const CARD = /^(6|7|8|9|10|J|Q|K|A)([SHDC])$/;

export const isCard = (c) => typeof c === 'string' && CARD.test(c);
export const rankOf = (c) => c.slice(0, -1);
export const suitOf = (c) => c.slice(-1);
export const rankIndex = (c) => RANKS.indexOf(rankOf(c));

/** "10♠", "Д♥" — how a card is written for a person. */
export const label = (c) => `${RANK_RU[rankOf(c)] || rankOf(c)}${SUIT_SIGN[suitOf(c)]}`;
/** "десятки", "дамы" would be nicer; the rank sign is what the table shows. */
export const rankLabel = (r) => RANK_RU[r] || r;

export function freshDeck36() {
  const out = [];
  for (const s of SUITS) for (const r of RANKS) out.push(r + s);
  return out;
}

/** Fisher–Yates on crypto.randomInt — the same shuffle as the poker deck. */
export function shuffled36(randInt = (n) => crypto.randomInt(n)) {
  const d = freshDeck36();
  for (let i = d.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/** A pack is exactly the 36 cards, once each — a stacked test deck included. */
export function isFullDeck(deck) {
  if (!Array.isArray(deck) || deck.length !== 36) return false;
  const seen = new Set(deck);
  return seen.size === 36 && deck.every(isCard);
}

/**
 * Does `defense` beat `attack`? A higher card of the same suit, or any trump
 * over a card that is not a trump. A trump is beaten only by a higher trump.
 */
export function beats(attack, defense, trump) {
  if (suitOf(defense) === suitOf(attack)) return rankIndex(defense) > rankIndex(attack);
  return suitOf(defense) === trump && suitOf(attack) !== trump;
}

/** A hand the way people hold it: by suit, trumps on the right, low to high. */
export function sortHand(cards, trump) {
  const suitRank = (c) => (suitOf(c) === trump ? 9 : SUITS.indexOf(suitOf(c)));
  return [...cards].sort((a, b) => suitRank(a) - suitRank(b) || rankIndex(a) - rankIndex(b));
}

/** The lowest trump in a hand, or null. */
export function lowestTrump(cards, trump) {
  let best = null;
  for (const c of cards) if (suitOf(c) === trump && (!best || rankIndex(c) < rankIndex(best))) best = c;
  return best;
}
