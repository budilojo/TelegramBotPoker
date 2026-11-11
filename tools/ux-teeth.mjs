/** Temporary guard mutations must be caught; always restore source before returning. */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const file = new URL('../bot/ux.js', import.meta.url);
const original = fs.readFileSync(file, 'utf8');
const mutations = [
  ['environment gate', "if (!enabled) throw", "if (false) throw"],
  ['database ownership', "if (app.store.getSetting('ux-environment') !== 'ux-test')", 'if (false)'],
  ['Telegram signature', "if (!auth.ok) return", "if (false) return"],
  ['tester allowlist', 'if (!tester) return fail();', 'if (false) return fail();'],
  ['active game guard', 'if (occupied) return', 'if (false) return'],
  ['own rows only', '`DELETE FROM ${table} WHERE user_id = ?`).run(uid)', '`DELETE FROM ${table} WHERE user_id = ? OR 1 = 1`).run(uid)'],
  ['own research session', 'WHERE id = ? AND user_id = ?\').get(String(msg.session || \'\'), uid)', "WHERE id = ? OR user_id = ?').get(String(msg.session || ''), uid)"],
  ['consent stopped', "op === 'event' && session.recording", "op === 'event'"],
];
try {
  for (const [name, before, after] of mutations) {
    if (!original.includes(before)) throw new Error('Mutation missing: ' + name);
    fs.writeFileSync(file, original.replaceAll(before, after));
    const result = spawnSync(process.execPath, ['--test', '--disable-warning=ExperimentalWarning', 'bot/ux.test.js'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    if (result.status === 0 || result.error) throw new Error('Mutation escaped: ' + name);
    console.log('Caught:', name);
    fs.writeFileSync(file, original);
  }
} finally { fs.writeFileSync(file, original); }
const launcher = new URL('../tools/ux-start.mjs', import.meta.url);
const launchSource = fs.readFileSync(launcher, 'utf8');
try {
  for (const [name, before, after] of [
    ['separate bot', "ux.UX_PRODUCTION_BOT_ID === ux.UX_BOT_ID", 'false'],
    ['fixed storage path', "const db = path.join(dir, 'ux.db');", "const db = process.env.DB_PATH || path.join(dir, 'ux.db');"],
    ['directory symlink', "fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()", 'false'],
    ['existing database marker', `check.prepare("SELECT value FROM meta WHERE key = 's:ux-environment'").get()?.value !== '"ux-test"'`, 'false'],
  ]) {
    if (!launchSource.includes(before)) throw new Error('Mutation missing: ' + name);
    fs.writeFileSync(launcher, launchSource.replace(before, after));
    const result = spawnSync(process.execPath, ['--test', '--disable-warning=ExperimentalWarning', 'bot/ux.launcher.test.js'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    if (result.status === 0 || result.error) throw new Error('Mutation escaped: ' + name);
    console.log('Caught:', name);
    fs.writeFileSync(launcher, launchSource);
  }
} finally { fs.writeFileSync(launcher, launchSource); }
