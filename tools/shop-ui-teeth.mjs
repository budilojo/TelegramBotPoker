/** Проверка живого скроллера «на зубы». Не запускать одновременно с другими браузерными проверками. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const file = 'miniapp/shop/index.js';
const source = fs.readFileSync(file, 'utf8');
const point = '  patch();\n  if (!msg.error && pendingView)';
assert.ok(source.includes(point));
try {
  fs.writeFileSync(file, source.replace(point,
    '  patch();\n  if (wanted.size && current?.isConnected) { const copy = current.cloneNode(true); current.replaceWith(copy); current = copy; }\n  if (!msg.error && pendingView)'));
  const r = spawnSync(process.execPath, ['tools/e2e-shop.mjs'], {
    env: { ...process.env, SHOP_ALLOW_PENDING: '1' }, encoding: 'utf8', timeout: 90_000,
  });
  const output = r.stdout + r.stderr;
  assert.ok(r.status !== 0 && /AssertionError/.test(output) && /recreated|пересоздан|скачок/i.test(output), output);
  console.log('Пересоздание скроллера после «Хочу» поймано assertNoJump.');
} finally { fs.writeFileSync(file, source); }
