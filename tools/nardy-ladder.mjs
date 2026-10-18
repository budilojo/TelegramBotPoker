/**
 * Лестница уровней бота нардов: партии бот-против-бота через правила стола
 * (те же проверки, что у хаба). Бот решает по своему виду (`view`), как в
 * игре; кубики — честные, но с зерном, чтобы прогон можно было повторить.
 *
 *   node tools/nardy-ladder.mjs <уровень A> <уровень B> <партий> [зерно]
 */
import * as N from '../bot/games/nardy/rules.js';
import { nardyView } from '../bot/games/nardy/view.js';
import bot, { LEVELS } from '../bot/games/nardy/bot.js';
import { rngFrom } from '../bot/games/nardy/engine.js';

/** Одна партия: возвращает победителя ('1' | '2') и число отказов сервера. */
export function playGame(levelA, levelB, seed) {
  const rnd = rngFrom(seed);
  const dice = () => [1 + Math.floor(rnd() * 6), 1 + Math.floor(rnd() * 6)];
  const room = N.createRoom({ chatId: 1, host: { id: 1, name: 'A' }, base: 0, side: seed % 2 ? 'white' : 'black' });
  N.addPlayer(room, { id: 2, name: 'B' });
  N.startGame(room, '1', { dice });
  const players = { 1: { id: '1', bot: { level: levelA } }, 2: { id: '2', bot: { level: levelB } } };
  const refused = [];
  for (let guard = 0; N.live(room) && guard < 5000; guard++) {
    const m = room.match;
    const id = m.turn.c === 'w' ? m.white : m.black;
    const view = nardyView(room, id, { now: 0 });
    const msg = bot.decide({ view, me: players[id], rng: rnd });
    let r;
    if (msg.t === 'roll') r = N.roll(room, id, 0, { dice });
    else if (msg.t === 'move') r = N.move(room, id, { from: msg.from, die: msg.die }, 0, msg.turn);
    else r = N.endTurn(room, id, 0);
    if (r.error) {
      refused.push(`${msg.t} ${JSON.stringify(msg)}: ${r.error} — кубики ${m.turn.dice}, сыграно ${JSON.stringify(m.turn.played)}, ходов ${m.log.length}`);
      break;
    }
  }
  const o = room.match.over;
  const winner = o?.winner ? (o.winner === 'w' ? room.match.white : room.match.black) : null;
  return { winner, refused, turns: room.match.log.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [a, b, n, seed = 1] = process.argv.slice(2).map(Number);
  const res = { [LEVELS[a].name]: 0, [LEVELS[b].name]: 0, отказов: 0, недоиграно: 0 };
  const t0 = Date.now();
  for (let g = 0; g < n; g++) {
    const r = playGame(a, b, seed * 10_000 + g);
    res.отказов += r.refused.length;
    if (r.refused.length) console.log(`партия ${g}:`, r.refused);
    if (!r.winner) res.недоиграно += 1;
    else res[r.winner === '1' ? LEVELS[a].name : LEVELS[b].name] += 1;
  }
  console.log(`${LEVELS[a].name} — ${LEVELS[b].name}, ${n} партий:`, res, `${Math.round((Date.now() - t0) / 1000)} с`);
}
