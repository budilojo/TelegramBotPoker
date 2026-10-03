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

/**
 * Рисунки придворных карт, туза пик и рубашки — готовит tools/make-court-art.mjs.
 * Они вшиты в файл строкой, а не лежат рядом картинками, потому что карта
 * грузится как `<img src="…svg">`, а SVG внутри <img> не имеет права тянуть
 * внешние картинки: браузер их просто не покажет.
 */
const ART = JSON.parse(fs.readFileSync(new URL('./court-art.json', import.meta.url), 'utf8'));
const COURT = { J: 'valet', Q: 'dama', K: 'korol' };

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
    // Туз пик — с узором, как в старых колодах; остальные тузы просто крупной мастью.
    centre = s === 'S'
      ? `<image href="${ART.tuzPik.data}" x="52" y="92" width="96" height="96" preserveAspectRatio="xMidYMid meet"/>`
      : suit(s, W / 2, H / 2 + 4, 118);
  } else if (FACE[rank]) {
    // Придворные: зеркально-двойная фигура, как на настоящей карте. Поле
    // подобрано так, чтобы она не налезала на угловой индекс (он достаёт до
    // x = 52), и одинаково для всех трёх — иначе король встанет выше дамы.
    centre = `<image href="${ART[COURT[rank]].data}" x="38" y="48" width="124" height="184" preserveAspectRatio="xMidYMid meet"/>`;
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
  // Рубашка: свой орнамент в цветах игры. Узор без верха и низа — карта не
  // читается перевёрнутой, и по ней ничего нельзя угадать.
  return svg(
    `<defs><clipPath id="c"><rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="11"/></clipPath></defs>` +
      `<rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="18" fill="#fff" stroke="#d6dbe1" stroke-width="3"/>` +
      `<image href="${ART.rubashka.data}" x="14" y="14" width="${W - 28}" height="${H - 28}" preserveAspectRatio="xMidYMid slice" clip-path="url(#c)"/>` +
      `<rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="11" fill="none" stroke="#7FD8E8" stroke-opacity=".35" stroke-width="2"/>`
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
