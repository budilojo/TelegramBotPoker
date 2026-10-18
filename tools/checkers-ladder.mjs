/**
 * Лестница уровней бота шашек: партии бот-против-бота через правила стола
 * (те же проверки, что у хаба). Для старших уровней — дольше, чем стоит
 * гонять в npm test; итоги записаны в docs/checkers.md.
 *
 *   node tools/checkers-ladder.mjs <уровень A> <уровень B> <партий> [мс на ход]
 */
import { bestMove, LEVELS } from '../bot/games/checkers/engine.js';
import * as C from '../bot/games/checkers/rules.js';
import { toFen, sqName } from '../bot/games/checkers/board.js';

const [a, b, n, timeMs] = process.argv.slice(2).map(Number);
if (!(a >= 0 && b >= 0 && n > 0)) {
  console.error('usage: node tools/checkers-ladder.mjs <A> <B> <партий> [мс на ход]');
  process.exit(1);
}
const res = { [LEVELS[a].name]: 0, [LEVELS[b].name]: 0, ничьи: 0, отказов: 0 };
const t0 = Date.now();
for (let g = 0; g < n; g++) {
  const room = C.createRoom({ chatId: 1, host: { id: 1, name: 'A' }, base: 0, side: g % 2 ? 'white' : 'black' });
  C.addPlayer(room, { id: 2, name: 'B' });
  C.startGame(room, '1', { rand: () => 0.1 });
  for (let guard = 0; C.live(room) && guard < 600; guard++) {
    const m = room.match;
    const id = m.pos.t === 'w' ? m.white : m.black;
    const mv = bestMove(toFen(m.pos), id === '1' ? a : b, { seed: g * 1000 + guard + 1, timeMs: timeMs || undefined });
    const r = C.move(room, id, { from: sqName(mv.from), to: sqName(mv.to), path: mv.path.map(sqName) }, 0);
    if (r.error) { res.отказов += 1; break; }
  }
  const o = room.match.over;
  if (!o?.winner) res.ничьи += 1;
  else res[(o.winner === 'w' ? room.match.white : room.match.black) === '1' ? LEVELS[a].name : LEVELS[b].name] += 1;
}
console.log(`${LEVELS[a].name} — ${LEVELS[b].name}, ${n} партий${timeMs ? `, ${timeMs} мс на ход` : ''}:`, res, `${Math.round((Date.now() - t0) / 1000)} с`);
