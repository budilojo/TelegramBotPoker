/**
 * Рисует 12 шахматных фигур для Mini App:
 *   miniapp/chess/wK.svg, wQ.svg, … bP.svg
 *
 * Фигуры — контурные силуэты, нарисованные векторными путями: ни один шрифт
 * на телефоне не подменит их эмодзи (чёрная пешка ♟ на iPhone — именно
 * эмодзи) и не потеряет глиф. Они грузятся как `<img>`, как и карты.
 *
 * Замена на другой набор — это те же 12 имён файлов в miniapp/chess/; больше
 * ничего в приложении про рисунок фигур не знает.
 *
 *   node tools/make-chess-pieces.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'miniapp', 'chess');

const SKIN = {
  w: { fill: '#f7f5ef', line: '#0a1216', detail: '#0a1216' },
  b: { fill: '#26323a', line: '#0a1216', detail: '#a9bcc0' },
};

/** Подставка у всех одна: фигуры стоят на одной линии. */
const BASE = '<path d="M11 39.5h23v-3a3 3 0 0 0-3-3H14a3 3 0 0 0-3 3z"/>';

/** Силуэт (заливка + контур) и тонкие линии-детали поверх. */
const SHAPE = {
  P: {
    body: `<circle cx="22.5" cy="12" r="6"/><path d="M15 33.5c0-6.5 2-10 4.8-12.8h5.4c2.8 2.8 4.8 6.3 4.8 12.8z"/>${BASE}`,
    detail: '<path d="M18 22.5h9"/>',
  },
  R: {
    body: `<path d="M12.5 8.5h5v3.5H21V8.5h3v3.5h3.5V8.5h5v10l-3.5 3.2v12.3H16V21.7l-3.5-3.2z"/>${BASE}`,
    detail: '<path d="M16 18.5h13M16.5 30h12"/>',
  },
  N: {
    body: `<path d="M14 33.5c0-5.5 1.5-8.5 5.5-11.5-3 0-6 1.5-8.5 4.5l-2.2-2.2c1-4 4.5-8 8.2-10.5l.7-5 3.6 3c8 .3 14.2 6 14.2 14.5v7.2z"/>${BASE}`,
    detail: '<path d="M25.5 14.5c3 1 5.5 4 6 8"/>',
    eye: '<circle cx="20.3" cy="13.4" r="1.3" stroke="none"/>',
  },
  B: {
    body: `<circle cx="22.5" cy="7" r="2.6"/><path d="M22.5 10.5c-5 3.6-8.2 7.2-8.2 12.2 0 3.2 1.6 5.4 3.2 7l-1.5 3.8h13l-1.5-3.8c1.6-1.6 3.2-3.8 3.2-7 0-5-3.2-8.6-8.2-12.2z"/>${BASE}`,
    detail: '<path d="M19.5 17.5l6 6M22.5 29h0"/>',
  },
  Q: {
    body: `<path d="M12 33.5L9 15.5l6.5 8 2.5-11.5 4.5 10.5 4.5-10.5 2.5 11.5 6.5-8-3 18z"/>${['9', '17.5', '22.5', '27.5', '36'].map((x, i) => `<circle cx="${x}" cy="${[13.5, 10.5, 8, 10.5, 13.5][i]}" r="2.3"/>`).join('')}${BASE}`,
    detail: '<path d="M14.5 30h16"/>',
  },
  K: {
    body: `<path d="M21.2 3.5h2.6v3h3v2.6h-3V12h-2.6V9.1h-3V6.5h3z"/><path d="M22.5 13c-5.2 0-9 3-9 7.5 0 3 1.5 5 3.5 6.5L15.5 33.5h14L28 27c2-1.5 3.5-3.5 3.5-6.5 0-4.5-3.8-7.5-9-7.5z"/>${BASE}`,
    detail: '<path d="M16.5 30h12"/>',
  },
};

fs.mkdirSync(OUT, { recursive: true });
for (const c of ['w', 'b']) {
  const s = SKIN[c];
  for (const [k, p] of Object.entries(SHAPE)) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45" width="45" height="45">` +
      `<g fill="${s.fill}" stroke="${s.line}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${p.body}</g>` +
      `<g fill="none" stroke="${s.detail}" stroke-width="1.1" stroke-linecap="round" opacity="${c === 'w' ? 0.55 : 0.7}">${p.detail}</g>` +
      (p.eye ? `<g fill="${s.detail}">${p.eye}</g>` : '') +
      `</svg>\n`;
    fs.writeFileSync(path.join(OUT, `${c}${k}.svg`), svg);
  }
}
console.log(`фигуры записаны в ${OUT}`);
