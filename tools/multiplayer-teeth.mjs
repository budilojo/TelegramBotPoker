/** J: обратимая поломка каждой новой защиты; никогда не запускать рядом с тестами. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testArgs = ['--test', '--test-reporter=tap', '--disable-warning=ExperimentalWarning', 'bot/multiplayer.test.js'];
const run = (args, env = {}) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000, env: { ...process.env, DRAFT_GAMES: '1', ...env } });
function green(args, env) {
  const r = run(args, env);
  assert.equal(r.status, 0, `${r.error || ''}\n${r.stdout}\n${r.stderr}`);
}
const cases = [
  ['пакет предыдущей партии снова принимается', 'bot/hub.js', 'game.positionActions?.includes(msg.t) && Number.isInteger(msg.seq) && msg.seq !== room.seq', 'false', testArgs, 'старый пакет предыдущей партии'],
  ['пакет старой партии с новой seq принимается', 'bot/hub.js', 'Number.isInteger(msg.matchNo) && msg.matchNo !== room.match?.no', 'false', testArgs, 'старый номер партии'],
  ...['chess', 'checkers', 'nardy', 'battleship'].map((g) => [
    `${g}: Telegram id в публичном счёте`, `bot/games/${g}/view.js`, 'score: score(room).map(({ id, ...row }) => row),', 'score: score(room),', testArgs, 'Telegram id не нужен в публичном счёте',
  ]),
  ['клиент перестал передавать seq', 'miniapp/net.js', 'ws.send(JSON.stringify(packet));', 'ws.send(JSON.stringify(msg));', ['--disable-warning=ExperimentalWarning', 'tools/e2e-multiplayer.mjs'], 'клиент передал версию стола'],
];
const env = { MULTI_GAME: 'chess', MULTI_WIDTH: '320', E2E_PORT: '8242' };
green(testArgs);
for (const [label, file, from, to, args, reason] of cases) {
  const full = path.join(root, file);
  const original = fs.readFileSync(full, 'utf8');
  assert.equal(original.split(from).length, 2, `${label}: единственное место поломки`);
  let r;
  try { fs.writeFileSync(full, original.replace(from, to)); r = run(args, env); }
  finally { fs.writeFileSync(full, original); }
  assert.equal(r.error, undefined, `${label}: проверка завершилась сама`);
  assert.notEqual(r.status, 0, `${label}: поломка пропущена`);
  assert.ok((r.stdout + r.stderr).includes(reason), `${label}: упало не на нужной проверке\n${r.stdout}\n${r.stderr}`);
  console.log(`Поймано: ${label}`);
}
green(testArgs);
green(['--disable-warning=ExperimentalWarning', 'tools/e2e-multiplayer.mjs'], env);
console.log('J: 7/7 поломок пойманы; восстановленный код зелёный.');
