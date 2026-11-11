import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cardgame-ux-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tools')); fs.mkdirSync(path.join(root, 'bot'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(new URL('../tools/ux-start.mjs', import.meta.url), path.join(root, 'tools/ux-start.mjs'));
  fs.writeFileSync(path.join(root, 'bot/index.js'), `console.log(JSON.stringify({db:process.env.DB_PATH, env:process.env.APP_ENV, admin:process.env.ADMIN_BOT_TOKEN, sales:process.env.SALES_MODE, flag:globalThis.cardgameUXLauncher}));`);
  fs.writeFileSync(path.join(root, '.env'), 'BOT_TOKEN=do-not-read\nDB_PATH=production.db');
  fs.writeFileSync(path.join(root, 'production.db'), 'production sentinel');
  fs.writeFileSync(path.join(root, '.env.ux'), 'UX_BOT_TOKEN=123:fake\nUX_BOT_ID=123\nUX_PRODUCTION_BOT_ID=456\nUX_WEBAPP_URL=https://ux.example.invalid\n');
  const run = extra => spawnSync(process.execPath, [path.join(root, 'tools/ux-start.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH, BOT_TOKEN: '456:production-placeholder', DB_PATH: path.join(root, 'production.db'), ADMIN_BOT_TOKEN: 'never-use', ...extra } });
  return { root, run };
}
test('UX launcher ignores production config, marks new DB and reopens only its own DB', t => {
  const { root, run } = setup(t);
  const first = run(); assert.equal(first.status, 0, first.stderr);
  const config = JSON.parse(first.stdout);
  assert.equal(config.db, path.join(root, 'data-ux', 'ux.db'));
  assert.equal(config.env, 'ux-test'); assert.equal(config.admin, undefined); assert.equal(config.sales, 'off');
  assert.equal(config.flag, true);
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'production.db'), 'utf8'), 'production sentinel');
});
test('UX launcher refuses existing unmarked database before runtime import', t => {
  const { root, run } = setup(t);
  fs.mkdirSync(path.join(root, 'data-ux'));
  const file = path.join(root, 'data-ux', 'ux.db'), db = new DatabaseSync(file);
  db.exec('CREATE TABLE meta (key TEXT, value TEXT)'); db.close();
  const before = fs.readFileSync(file);
  const result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /не помечена UX-Test/);
  assert.deepEqual(fs.readFileSync(file), before);
});
test('UX launcher refuses database-directory symlink and same bot identity', t => {
  const { root, run } = setup(t);
  fs.mkdirSync(path.join(root, 'data'));
  fs.symlinkSync(path.join(root, 'data'), path.join(root, 'data-ux'));
  assert.match(run().stderr, /не может быть ссылкой/);
  fs.unlinkSync(path.join(root, 'data-ux'));
  fs.appendFileSync(path.join(root, '.env.ux'), 'UX_PRODUCTION_BOT_ID=123\n');
  assert.match(run().stderr, /тестовый бот должен отличаться/);
  assert.equal(fs.existsSync(path.join(root, 'data-ux')), false);
});
