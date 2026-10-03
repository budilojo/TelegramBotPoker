'use strict';
/**
 * The `.env` editor. It touches a file a person keeps their bot token in, so
 * the tests are mostly about what it must NOT change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setEnvValue, getEnvValue } from './envfile.js';

const SAMPLE = `# Скопируйте в .env и впишите токен от @BotFather. Файл .env в git не попадает.
BOT_TOKEN=123456:AA-secret

# Необязательно:
# DB_PATH=./data/bot.db
# PORT=8080

WEBAPP_URL=https://old-address.trycloudflare.com
MINIAPP=WorldCard
`;

test('setting an address replaces that line and nothing else', () => {
  const out = setEnvValue(SAMPLE, 'WEBAPP_URL', 'https://new-one.trycloudflare.com');
  assert.match(out, /^WEBAPP_URL=https:\/\/new-one\.trycloudflare\.com$/m);
  assert.ok(!out.includes('old-address'));
  assert.ok(out.includes('BOT_TOKEN=123456:AA-secret'), 'the token is untouched');
  assert.ok(out.includes('MINIAPP=WorldCard'));
  assert.ok(out.includes('# Необязательно:'), 'comments stay');
  assert.equal(out.split('\n').length, SAMPLE.split('\n').length, 'and not a line more');
});

test('a key that is not there yet is appended, on its own line', () => {
  const out = setEnvValue('BOT_TOKEN=1:AA\n', 'WEBAPP_URL', 'https://x.example');
  assert.equal(out, 'BOT_TOKEN=1:AA\nWEBAPP_URL=https://x.example\n');
  const noEol = setEnvValue('BOT_TOKEN=1:AA', 'WEBAPP_URL', 'https://x.example');
  assert.equal(noEol, 'BOT_TOKEN=1:AA\nWEBAPP_URL=https://x.example\n', 'a file without a last newline too');
  assert.equal(setEnvValue('', 'PORT', '8080'), 'PORT=8080\n');
});

test('a commented-out line is a hint, not a setting: it stays, the real one is added', () => {
  const out = setEnvValue('# PORT=8080\n', 'PORT', '9000');
  assert.ok(out.includes('# PORT=8080'), 'the hint is left alone');
  assert.match(out, /^PORT=9000$/m);
});

test('a key whose name is the tail of another is not mistaken for it', () => {
  const out = setEnvValue('MY_PORT=1\nPORT=2\n', 'PORT', '3');
  assert.equal(out, 'MY_PORT=1\nPORT=3\n');
});

test('reading back: a value, a quoted value, a missing key', () => {
  assert.equal(getEnvValue(SAMPLE, 'MINIAPP'), 'WorldCard');
  assert.equal(getEnvValue(SAMPLE, 'WEBAPP_URL'), 'https://old-address.trycloudflare.com');
  assert.equal(getEnvValue('WEBAPP_URL="https://q.example"\n', 'WEBAPP_URL'), 'https://q.example');
  assert.equal(getEnvValue(SAMPLE, 'NOPE'), null);
  assert.equal(getEnvValue('# PORT=8080\n', 'PORT'), null, 'a comment is not a value');
});
