/** Временное возвращение старого пути; каждый файл восстанавливается даже при ошибке. Без git reset. */
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = import.meta.dirname + '/..';
process.chdir(root);
const files = ['miniapp/ui.js', 'miniapp/profile.js', 'miniapp/games/poker.js', 'miniapp/games/durak.js', 'miniapp/reactions.js', 'miniapp/cosmetics.css', 'miniapp/cosmetics/apply.js'];
const originals = new Map(files.map((f) => [f, fs.readFileSync(f)]));
const run = (args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { encoding: 'utf8', timeout: 120000 });
try {
  for (const f of files) {
    const before = execFileSync('git', ['show', `1781699:${f}`]);
    try {
      fs.writeFileSync(f, before);
      const r = run(['--test', 'bot/cosmetics.retirement.test.js']);
      assert.equal(r.status, 1, `${f}: тест должен упасть\n${r.stdout}${r.stderr}`);
      assert.match(r.stdout + r.stderr, /живые экраны не читают архивный выбор/);
      console.log(`CAUGHT boundary: ${f}`);
      if (process.argv.includes('--browser') && ['miniapp/ui.js', 'miniapp/games/poker.js', 'miniapp/reactions.js', 'miniapp/cosmetics.css'].includes(f)) {
        const e = run(['tools/e2e-look.mjs']);
        assert.equal(e.status, 1, `${f}: браузер должен поймать поломку\n${e.stdout}${e.stderr}`);
        assert.match(e.stdout + e.stderr, /AssertionError/, 'падение по assert, а не инфраструктуре');
        console.log(`CAUGHT browser: ${f}`);
      }
    } finally { fs.writeFileSync(f, originals.get(f)); }
  }
  const r = run(['--test', 'bot/cosmetics.retirement.test.js']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  console.log(`OK: ${files.length} временных поломок пойманы, исправленный код восстановлен и зелёный`);
} finally { for (const [f, content] of originals) fs.writeFileSync(f, content); }
