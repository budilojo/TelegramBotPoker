/** Проверки «на зубы» в отдельной временной копии, исходники не портятся. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rating-teeth-'));
const cases = [
  ['нормирование размера стола', 'bot/skill-rating.js', 'const divisor = rows.length - 1;', 'const divisor = 1;', 'каждый размер'],
  ['нулевая сумма', 'bot/skill-rating.js', 'b.delta -= delta;', 'b.delta += delta;', 'каждый размер'],
  ['ничья', 'bot/skill-rating.js', 'a.place === b.place ? 0.5 : 0', 'a.place === b.place ? 0 : 0', 'ничья с равным'],
  ['отсутствие подарка на дне', 'bot/skill-rating.js', 'after: r.before + r.delta', 'after: Math.max(0, r.before + r.delta)', 'нижней границе'],
  ['не округлять внутренний рейтинг', 'bot/skill-rating.js', 'after: r.before + r.delta', 'after: Math.round(r.before + r.delta)', 'нижней границе'],
  ['разделение игр', 'bot/skill-rating.js', 'this.player(game, p.id).rating', "this.player('colors', p.id).rating", 'семь игр'],
  ['реестр игр', 'bot/skill-rating.js', "if (!this.games.has(game)) throw new Error('Неизвестная игра теневого рейтинга');", '', 'семь игр'],
  ['повтор после перезапуска', 'bot/skill-rating.js', 'if (old) {', 'if (false && old) {', 'переживают перезапуск'],
  ['подмена записанного результата', 'bot/skill-rating.js', "if (old.input !== input) throw new Error('Результат уже записанной партии изменён');", '', 'переживают перезапуск'],
  ['атомарность партии', 'bot/skill-rating.js', "this.db.exec('ROLLBACK TO skill_shadow_round');", '', 'ошибка записи второго'],
  ['боты без калибровки', 'bot/skill-rating.js', "hasBots ? 'BOTS_UNCALIBRATED' : ", '', 'боты без калибровки'],
  ['отменённая партия', 'bot/skill-rating.js', "aborted ? 'ABORTED' : ", '', 'боты без калибровки'],
  ['слишком короткая партия', 'bot/skill-rating.js', "short ? 'SHORT' : ", '', 'боты без калибровки'],
  ['не пересчитывать старую историю', 'bot/app.js', "((!seen[r.id] && !observed) || observed === 'pending')", "(!observed || observed === 'pending')", 'первое включение'],
  ['повтор неудачной теневой записи', 'bot/app.js', " || observed === 'pending'", '', 'отказ наблюдателя'],
  ['бот в смешанном столе', 'bot/app.js', 'hasBots: room.players.some(p => !!p.bot)', 'hasBots: false', 'настоящие страницы'],
  ['разделённые места покера', 'bot/games/poker/index.js', 'ranks: players.map(r => players.findIndex(other => other.net === r.net && other.stack === r.stack) + 1)', 'ranks: players.map((r, i) => i + 1)', 'покерные разделённые'],
  ['учёт разделённых мест наблюдателем', 'bot/skill-rating.js', 'const positions = ranks ?? ids.map', 'const positions = ids.map', 'покерные разделённые'],
  ['не угадывать места при ничьей', 'bot/skill-rating.js', "draw && ids.length > 2 && ranks === null ? 'DRAW_PLACES_UNKNOWN' : ", '', 'неизвестное разделение'],
  ['таймер 30 секунд', 'tools/unoq-research/lobby.mjs', 'this.now() + 30_000', 'this.now() + 1', 'ровно 30 секунд'],
  ['сложность закреплена после старта', 'tools/unoq-research/lobby.mjs', "if (this.status !== 'waiting' || (this.deadline !== null && this.now() >= this.deadline))", 'if (false)', 'сложность до старта'],
  ['однократный старт', 'tools/unoq-research/lobby.mjs', "if (this.status !== 'waiting' || !this.people.size) return;", 'if (!this.people.size) return;', 'реентерабельный'],
  ['назначение без перебора размера состава', 'tools/unoq-research/lobby.mjs', 'JSON.stringify([String(humanId), day])', 'JSON.stringify([String(humanId), day, count])', 'состав назначен сервером'],
  ['отдельные seeds контрольной выборки', 'tools/unoq-research/simulator.mjs', 'holdout: 100_000_000', 'holdout: 10_000_000', 'полный цикл'],
  ['проверка всех приватных сообщений', 'tools/unoq-research/simulator.mjs', 'export function auditView(v, room, uid) {', 'export function auditView(v, room, uid) { return;', 'приватность отклоняет'],
];

function run(file, pattern) {
  const args = ['--disable-warning=ExperimentalWarning', '--test', '--test-reporter=tap'];
  if (pattern) args.push(`--test-name-pattern=${pattern}`);
  args.push(file);
  return spawnSync(process.execPath, args, { cwd: tmp, env: { ...process.env, DRAFT_GAMES: '1' }, encoding: 'utf8', timeout: 30000 });
}

try {
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}\n');
  fs.cpSync(path.join(root, 'bot'), path.join(tmp, 'bot'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'tools'));
  fs.cpSync(path.join(root, 'tools/unoq-research'), path.join(tmp, 'tools/unoq-research'), { recursive: true });
  fs.copyFileSync(path.join(root, 'tools/unoq-research.test.js'), path.join(tmp, 'tools/unoq-research.test.js'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
  // Общий движок читается по прежнему пути, но не копируется и не меняется.
  fs.symlinkSync(path.join(root, 'server'), path.join(tmp, 'server'), 'dir');
  fs.symlinkSync(path.join(root, 'miniapp'), path.join(tmp, 'miniapp'), 'dir');
  for (const file of ['bot/skill-rating.test.js', 'tools/unoq-research.test.js']) {
    const r = run(file);
    if (r.status !== 0) throw new Error(`Неповреждённый тест не прошёл: ${file}\n${r.stdout}\n${r.stderr}`);
  }
  const results = [];
  for (const [name, file, from, to, pattern] of cases) {
    const target = path.join(tmp, file), original = fs.readFileSync(target, 'utf8');
    if (!original.includes(from)) throw new Error(`Поломка устарела: ${name}`);
    let r;
    try { fs.writeFileSync(target, original.replace(from, to)); r = run(file.startsWith('bot/') ? 'bot/skill-rating.test.js' : 'tools/unoq-research.test.js', pattern); }
    finally { fs.writeFileSync(target, original); }
    const output = `${r.stdout}\n${r.stderr}`;
    const caught = r.status === 1 && /^not ok /m.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND|ReferenceError/.test(output);
    results.push({ name, file, pattern, caught, exit: r.status });
    console.log(`${caught ? 'ПОЙМАНА' : 'ПРОПУЩЕНА'}: ${name}`);
    if (!caught) console.error(output.slice(-2500));
  }
  fs.writeFileSync(path.join(root, 'docs/bot-rating-data/teeth-summary.json'), JSON.stringify({ cases: results, passed: results.filter(r => r.caught).length, total: results.length }, null, 2) + '\n');
  if (results.some(r => !r.caught)) process.exitCode = 1;
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
