/** Доказывает, что perf-lifecycle замечает оставленные страницы/подписки.
 * Только локально, без сервера. Не запускать одновременно с другими тестами:
 * по очереди временно ломает Hub.close/detach и возвращает точные байты файла.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = new URL('../bot/hub.js', import.meta.url);
const script = new URL('./perf-lifecycle.mjs', import.meta.url);
const original = fs.readFileSync(file, 'utf8');
const run = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script.pathname], { encoding: 'utf8', timeout: 30000 });
const positive = () => { const r = run(); assert.equal(r.status, 0, r.stderr || r.error?.message); };
positive();
const faults = [
  ['this.pages.delete(session);', '/* test: retained page */', 'закрытые страницы удалены из общего регистра pages'],
  ['set.delete(session);', '/* test: retained subscription */', 'закрытые страницы удалены из подписок стола'],
];
let caught = 0;
try {
  for (const [from, to, message] of faults) {
    assert.equal(original.split(from).length, 2, `одна точка мутации: ${from}`);
    try {
      fs.writeFileSync(file, original.replace(from, to));
      const r = run();
      assert.equal(r.status, 1, `нужен отказ assert, а не зависание/сбой запуска: ${r.error || r.stderr}`);
      assert.ok(r.stderr.includes(message), r.stderr);
      caught++; console.log(`Поймана: ${message}`);
    } finally { fs.writeFileSync(file, original); }
  }
} finally { fs.writeFileSync(file, original); }
positive();
console.log(`${caught}/${faults.length}; исходный Hub восстановлен, положительный проход зелёный`);
