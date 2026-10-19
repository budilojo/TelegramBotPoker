/**
 * Морской бой «на зубы»: каждую защиту по очереди ломаем — нужный тест
 * обязан упасть. Файл после каждой поломки возвращается как был.
 *
 *   node tools/battleship-teeth.mjs
 *
 * Здесь — утечки флота во все каналы (вид игрока и зрителя, карточка
 * группы, «ваш ход», пульт, журнал, тексты отказов, перезапуск, новая
 * партия) и правила (касания, «попал — ещё», «за другого»). Строка «ПРОПУЩЕНО»
 * значит: тест такую поломку не видит — он ничего не охраняет.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
const G = 'bot/games/battleship/';
const M = [
  ['чужой флот целиком в view', G + 'view.js', 'ships: fleet ? fleet.map(copyShip) : player ? sunk.map(copyShip) : [],', 'ships: (m.fleets[s] || []).map(copyShip),', 'bot/battleship.test.js'],
  ['зрителю — потопленные корабли', G + 'view.js', 'player ? sunk.map(copyShip) : []', 'sunk.map(copyShip)', 'bot/battleship.test.js'],
  ['скрытая «сумма» флота в view (структура цела)', G + 'view.js', '    left: fleetLeft(sunk),', '    left: fleetLeft(sunk),\n    v: (m.fleets[s] || []).reduce((a, x) => a + x.x * 7 + x.y, 0),', 'bot/battleship.test.js'],
  ['чужой флот только в конце хода противника (lastShips)', G + 'view.js', '      shots: m.log.length,', '      shots: m.log.length,\n      hint: side != null && m.fleets[1 - side] ? m.fleets[1 - side].filter((x) => x.len === 1).length : 0,\n      peek: side != null && m.fleets[1 - side] ? m.fleets[1 - side][9].x : null,', 'bot/battleship.test.js'],
  ['«ранил трёхпалубный» — длина раненого корабля в отметке', G + 'view.js', "  return m.shots[1 - s].map((x) => ({ c: x.c, r: dead.has(x.c) ? 'sunk' : x.r }));", "  return m.shots[1 - s].map((x) => ({ c: x.c, r: dead.has(x.c) ? 'sunk' : x.r, n: (m.fleets[s] || []).find((sh) => shipCells(sh).includes(x.c))?.len ?? 0 }));", 'bot/battleship.test.js'],
  ['отказ «не ваш ход» зависит от клетки', G + 'rules.js', "  if (mover(m) !== s) return { error: 'NOT_YOUR_TURN' };", "  if (mover(m) !== s) return { error: shoot(m.fleets[1 - s], new Set(), Number(cell)).r === 'miss' ? 'NOT_YOUR_TURN' : 'STALE' };", 'bot/battleship.test.js'],
  ['клетка чужого корабля в карточке группы', G + 'render.js', "m.phase === 'place' ? 'Расставляют флот — в приложении.' : 'Идёт бой — поле в приложении.'", "m.phase === 'place' ? 'Расставляют флот — в приложении.' : `Идёт бой — поле в приложении. ${addr(m.fleets[1][9].y * 10 + m.fleets[1][9].x)}`", 'bot/battleship.test.js'],
  ['чужой флот в «ваш ход»', G + 'render.js', "  if (room.turn?.deadline) lines.push('⏱ время на часах идёт');", "  if (room.turn?.deadline) lines.push('⏱ время на часах идёт');\n  if (m?.fleets?.[1]) lines.push(String(m.fleets[1][3].x));", 'bot/battleship.test.js'],
  ['флот в пульте владельца', G + 'index.js', "detail: B.controlRu(room.settings) + (room.gameNo ? ` · партия ${room.gameNo}` : ''),", "detail: B.controlRu(room.settings) + (room.match?.fleets?.[1] ? ` ${room.match.fleets[1][3].x}` : ''),", 'bot/battleship.test.js'],
  ['флот в журнал ошибок', G + 'index.js', "        const r = B.fire(room, uid, msg.cell, now(), shotNo, opts());", "        app.log(new Error('выстрел ' + JSON.stringify(room.match?.fleets)));\n        const r = B.fire(room, uid, msg.cell, now(), shotNo, opts());", 'bot/battleship.test.js'],
  ['флоты переходят в новую партию', G + 'rules.js', '    fleets: [null, null],', '    fleets: room.match?.fleets || [null, null],', 'bot/battleship.test.js'],
  ['расстановка «за другого» по полю тела', G + 'index.js', 'const r = B.place(room, uid, msg.ships, now(), opts());', 'const r = B.place(room, msg.uid ?? uid, msg.ships, now(), opts());', 'bot/battleship.test.js'],
  ['после «готов» можно переставить', G + 'rules.js', "  if (m.ready[s]) return { error: 'ALREADY_READY' };", '', 'bot/battleship.rules.test.js'],
  ['«null» вместо координаты корабля', G + 'board.js', '  const { x, y, len } = s;', '  const x = Number(s.x); const y = Number(s.y); const len = Number(s.len);', 'bot/battleship.board.test.js'],
  ['«null» вместо клетки выстрела', G + 'rules.js', "const c = typeof cell === 'number' ? cell : NaN;", 'const c = Number(cell);', 'bot/battleship.rules.test.js'],
  ['касание углом разрешено', G + 'board.js', "      for (const n of neighbors(c)) if (owner[n] !== -1 && owner[n] !== i) return { error: 'SHIPS_TOUCH' };", "      for (const n of neighbors(c)) if (owner[n] !== -1 && owner[n] !== i && (n % 10 === c % 10 || Math.floor(n / 10) === Math.floor(c / 10))) return { error: 'SHIPS_TOUCH' };", 'bot/battleship.board.test.js'],
  ['вокруг потопленного стрелять можно', G + 'rules.js', "  if (knownEmpty(m, s).has(c)) return { error: 'NEAR_SUNK' };", '', 'bot/battleship.rules.test.js'],
  ['попал — ход всё равно переходит', G + 'rules.js', "  if (r === 'miss') m.turn = 1 - s;", '  m.turn = 1 - s;', 'bot/battleship.rules.test.js'],
  ['перезапуск теряет флоты', G + 'rules.js', "  room.game = 'battleship';\n", "  room.game = 'battleship';\n  if (room.match) room.match.fleets = room.match.fleets.map(() => null);\n", 'bot/battleship.test.js'],
  ['«случайно» берёт флот со страницы', G + 'index.js', 'const r = B.placeRandom(room, uid, now(), opts());', 'const r = Array.isArray(msg.ships) ? B.place(room, uid, msg.ships, now(), opts()) : B.placeRandom(room, uid, now(), opts());', 'bot/battleship.test.js'],
];
let bad = 0;
for (const [name, file, from, to, testFile] of M) {
  const p = root + file;
  const orig = fs.readFileSync(p, 'utf8');
  if (orig.split(from).length !== 2) { console.log(`?? ${name}: образец не найден один раз`); bad++; continue; }
  fs.writeFileSync(p, orig.replace(from, to));
  const r = spawnSync('node', ['--test', '--disable-warning=ExperimentalWarning', testFile], { cwd: root, encoding: 'utf8' });
  fs.writeFileSync(p, orig);
  const failed = (r.stdout.match(/^not ok \d+ - (.*)$/gm) || []).map((l) => l.replace(/^not ok \d+ - /, ''));
  if (r.status === 0) { console.log(`ПРОПУЩЕНО: ${name}`); bad++; }
  else console.log(`поймано: ${name}\n    упали: ${failed.join(' | ')}`);
}
console.log(bad ? `\n${bad} поломок тесты НЕ поймали` : '\nвсе поломки пойманы');
process.exit(bad ? 1 : 0);
