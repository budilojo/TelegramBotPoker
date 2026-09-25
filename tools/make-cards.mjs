/**
 * Generates the 52 card faces and the card back for the Mini App:
 *   miniapp/cards/AS.svg, KH.svg, 10D.svg, 2C.svg, …, back.svg
 *
 * One style, one place to change it. The interface assembles any hand from
 * these 53 files — nothing is ever drawn per hand.
 *
 * Design goals, in order: readable at 40 px wide (an opponent's shown cards),
 * handsome at 110 px (your own), and unambiguous between suits — red hearts
 * and diamonds, near-black spades and clubs, suits drawn as vector paths so
 * no font on any phone can substitute an emoji or a missing glyph.
 *
 *   node tools/make-cards.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'miniapp', 'cards');

const W = 200;
const H = 280;
const RED = '#d4283b';
const BLACK = '#161a20';
const FONT = "-apple-system, 'SF Pro Display', 'Helvetica Neue', Inter, 'Segoe UI', Roboto, Arial, sans-serif";

/** Suits drawn in a 100×100 box. */
const SUIT_PATH = {
  S: 'M50 4C38 22 8 38 8 60c0 14 11 23 24 23 7 0 13-3 16-8-1 9-5 15-11 21h26c-6-6-10-12-11-21 3 5 9 8 16 8 13 0 24-9 24-23C92 38 62 22 50 4Z',
  H: 'M50 92C22 70 5 52 5 31 5 16 16 6 30 6c9 0 16 5 20 13 4-8 11-13 20-13 14 0 25 10 25 25 0 21-17 39-45 61Z',
  D: 'M50 3C62 21 76 37 92 50 76 63 62 79 50 97 38 79 24 63 8 50 24 37 38 21 50 3Z',
  C: 'M50 6a19 19 0 0 1 17 28 19 19 0 1 1-3 36c-5 0-9-2-12-5 1 11 5 19 12 27H36c7-8 11-16 12-27-3 3-7 5-12 5a19 19 0 1 1-3-36A19 19 0 0 1 50 6Z',
};
const SUITS = { S: BLACK, C: BLACK, H: RED, D: RED };
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const FACE = { J: 'J', Q: 'Q', K: 'K' };

/** A suit symbol of `size` px, centred on (cx, cy). */
function suit(s, cx, cy, size, extra = '') {
  const k = size / 100;
  return `<path d="${SUIT_PATH[s]}" fill="${SUITS[s]}" transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${k})"${extra}/>`;
}

/** Rank + small suit in a corner; the bottom-right one is the same, turned over. */
function corner(rank, s) {
  const color = SUITS[s];
  const narrow = rank === '10';
  return (
    `<g>` +
    `<text x="${narrow ? 13 : 17}" y="52" font-family="${FONT}" font-weight="800" font-size="${narrow ? 44 : 50}" ` +
    `letter-spacing="${narrow ? -4 : 0}" fill="${color}">${rank}</text>` +
    suit(s, 34, 78, 32) +
    `</g>`
  );
}

function face(rank, s) {
  const color = SUITS[s];
  const tint = color === RED ? '#fdecee' : '#eef1f5';
  let centre;
  if (rank === 'A') {
    centre = suit(s, W / 2, H / 2 + 4, 118);
  } else if (FACE[rank]) {
    // Court cards: a framed panel with the letter and the suit. Clean, and
    // unmistakable at a glance — no tiny portraits to squint at.
    centre =
      // The panel stays clear of the corner indices (they reach x = 52).
      `<rect x="60" y="66" width="80" height="148" rx="12" fill="${tint}" stroke="${color}" stroke-opacity=".35" stroke-width="3"/>` +
      `<text x="${W / 2}" y="${H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="74" fill="${color}">${FACE[rank]}</text>` +
      suit(s, W / 2, H / 2 + 44, 36);
  } else {
    centre = suit(s, W / 2, H / 2 + 6, 104);
  }
  return svg(
    `<rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="18" fill="#fff" stroke="#d6dbe1" stroke-width="3"/>` +
      corner(rank, s) +
      `<g transform="rotate(180 ${W / 2} ${H / 2})">${corner(rank, s)}</g>` +
      centre
  );
}

function back() {
  // Felt green with a fine diamond lattice and a spade in the middle — the
  // colours of the table, so a face-down card reads as "ours".
  return svg(
    `<defs>` +
      `<pattern id="p" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
      `<rect width="16" height="16" fill="#12623f"/>` +
      `<rect width="8" height="16" fill="#0f5536"/>` +
      `</pattern>` +
      `</defs>` +
      `<rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="18" fill="#fff" stroke="#d6dbe1" stroke-width="3"/>` +
      `<rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="11" fill="url(#p)"/>` +
      `<rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="11" fill="none" stroke="#2ee08c" stroke-opacity=".35" stroke-width="2"/>` +
      `<circle cx="${W / 2}" cy="${H / 2}" r="34" fill="#0b3f28" stroke="#2ee08c" stroke-opacity=".5" stroke-width="2"/>` +
      `<path d="${SUIT_PATH.S}" fill="#2ee08c" transform="translate(${W / 2 - 22} ${H / 2 - 22}) scale(.44)"/>`
  );
}

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>\n`;

fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const s of Object.keys(SUITS)) {
  for (const r of RANKS) {
    fs.writeFileSync(path.join(OUT, `${r}${s}.svg`), face(r, s));
    n++;
  }
}
fs.writeFileSync(path.join(OUT, 'back.svg'), back());
console.log(`cards: ${n} faces + back → ${path.relative(process.cwd(), OUT)}`);
