/**
 * Рисует 4 шашки для Mini App: miniapp/checkers/w.svg, b.svg (простые),
 * wK.svg, bK.svg (дамки).
 *
 * Те же краски, что у шахматных фигур (tools/make-chess-pieces.mjs): это
 * игровой арт, не палитра интерфейса. Белые и чёрные различимы и без цвета:
 * у белой — одно кольцо, у чёрной — кольцо и точка в центре. Дамка — корона
 * поверх. Плоско: ни градиентов, ни теней.
 *
 *   node tools/make-checkers-pieces.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'miniapp', 'checkers');

const SKIN = {
  w: { fill: '#f7f5ef', line: '#0a1216', detail: '#0a1216', opacity: 0.55 },
  b: { fill: '#26323a', line: '#0a1216', detail: '#a9bcc0', opacity: 0.8 },
};

const RING = '<circle cx="22.5" cy="22.5" r="11.5"/>';
const DOT = '<circle cx="22.5" cy="22.5" r="3"/>';
const CROWN = '<path d="M14.5 27.5l-1.5-10 5.2 4.3 4.3-7 4.3 7 5.2-4.3-1.5 10z"/>';

fs.mkdirSync(OUT, { recursive: true });
for (const c of ['w', 'b']) {
  const s = SKIN[c];
  for (const king of [false, true]) {
    const marks = king ? CROWN : (c === 'b' ? DOT : '');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45" width="45" height="45">` +
      `<circle cx="22.5" cy="22.5" r="18" fill="${s.fill}" stroke="${s.line}" stroke-width="1.5"/>` +
      `<g fill="none" stroke="${s.detail}" stroke-width="1.4" stroke-linejoin="round" opacity="${s.opacity}">${RING}</g>` +
      (marks ? `<g fill="${s.detail}" stroke="none" opacity="${king ? 1 : s.opacity}">${marks}</g>` : '') +
      (king && c === 'b' ? `<g fill="${s.fill}" stroke="none">${DOT.replace('r="3"', 'r="1.6"').replace('cy="22.5"', 'cy="23.5"')}</g>` : '') +
      `</svg>\n`;
    fs.writeFileSync(path.join(OUT, `${c}${king ? 'K' : ''}.svg`), svg);
  }
}
console.log(`шашки записаны в ${OUT}`);
