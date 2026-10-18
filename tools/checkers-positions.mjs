/**
 * Позиции для сверки ходов шашек с pydraughts (tools/checkers-oracle.py):
 * из случайных партий, почаще — с дамками и сериями взятий.
 *
 *   node tools/checkers-positions.mjs [seed] [count] > /tmp/pos.json
 */
import * as B from '../bot/games/checkers/board.js';

let seed = Number(process.argv[2] || 2026);
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const want = Number(process.argv[3] || 400);
const out = [];
while (out.length < want) {
  let p = B.startPosition();
  for (let ply = 0; ply < 140 && out.length < want; ply++) {
    const ms = B.legalMoves(p);
    if (!ms.length) break;
    const rich = ms.some((m) => m.caps.length > 1) || p.b.some(B.isKing);
    if (rich ? rnd() < 0.5 : rnd() < 0.05) out.push(B.toFen(p));
    p = B.make(p, ms[Math.floor(rnd() * ms.length)]);
  }
}
console.log(JSON.stringify(out));
