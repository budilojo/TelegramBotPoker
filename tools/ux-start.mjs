import fs from 'node:fs';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const root = path.resolve(import.meta.dirname, '..');
const envFile = path.join(root, '.env.ux');
// Do not inherit production BOT_TOKEN, DB_PATH, admin bot or sales settings.
const inherited = Object.keys(process.env).filter(k => /^(UX_|APP_ENV$)/.test(k));
const ux = Object.fromEntries(inherited.map(k => [k, process.env[k]]));
if (fs.existsSync(envFile)) Object.assign(ux, parseEnv(fs.readFileSync(envFile, 'utf8')));
if (!ux.UX_BOT_TOKEN || !/^\d+$/.test(ux.UX_BOT_ID || '') || ux.UX_BOT_TOKEN.split(':')[0] !== ux.UX_BOT_ID) throw new Error('Укажите отдельные UX_BOT_TOKEN и UX_BOT_ID в .env.ux');
if (!/^\d+$/.test(ux.UX_PRODUCTION_BOT_ID || '') || ux.UX_PRODUCTION_BOT_ID === ux.UX_BOT_ID) throw new Error('Укажите UX_PRODUCTION_BOT_ID основного бота; тестовый бот должен отличаться');
if (!/^https:\/\//.test(ux.UX_WEBAPP_URL || '')) throw new Error('Нужен отдельный HTTPS UX_WEBAPP_URL');
const dir = path.join(root, 'data-ux');
if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('data-ux не может быть ссылкой');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const db = path.join(dir, 'ux.db');
if (fs.existsSync(db)) {
  if (fs.lstatSync(db).isSymbolicLink() || fs.statSync(db).nlink !== 1) throw new Error('База UX не может быть ссылкой');
  const check = new DatabaseSync(db, { readOnly: true });
  try { if (check.prepare("SELECT value FROM meta WHERE key = 's:ux-environment'").get()?.value !== '"ux-test"') throw new Error('Отказ: существующая база не помечена UX-Test'); } finally { check.close(); }
} else {
  const fresh = new DatabaseSync(db);
  fresh.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('s:ux-environment', '"ux-test"');`);
  fresh.close();
}
for (const k of ['BOT_TOKEN', 'DB_PATH', 'ADMIN_BOT_TOKEN', 'ADMINS', 'COSMETICS_TESTERS', 'COLLECTIONS_DEMO', 'SALES_MODE', 'SKILL_RATING_SHADOW', 'SHOP_ENABLED']) delete process.env[k];
Object.assign(process.env, { APP_ENV: 'ux-test', BOT_TOKEN: ux.UX_BOT_TOKEN, DB_PATH: db,
  UX_TESTERS: ux.UX_TESTERS || '', WEBAPP_URL: ux.UX_WEBAPP_URL, MINIAPP: ux.UX_MINIAPP || '',
  PORT: ux.UX_PORT || '8081', BIND_HOST: ux.UX_BIND_HOST || '127.0.0.1', SALES_MODE: 'off', SHOP_ENABLED: 'false', TG_TEST_ENV: '0' });
globalThis.cardgameUXLauncher = true;
await import('../bot/index.js');
