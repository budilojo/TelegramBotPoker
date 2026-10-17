'use strict';
/**
 * Юнит systemd из deploy/: каждая настройка — в той секции, где systemd её
 * читает. Не в своей секции systemd её молча пропускает (только строка
 * «Unknown key name … ignoring» в журнале) — так и было с ограничением
 * перезапусков.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const UNIT_ONLY = ['StartLimitBurst', 'StartLimitIntervalSec', 'After', 'Wants', 'Description', 'Documentation'];
const SERVICE_ONLY = ['Type', 'User', 'WorkingDirectory', 'EnvironmentFile', 'ExecStart', 'Restart', 'RestartSec'];

function sections(text) {
  const out = {};
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const head = /^\[(\w+)\]$/.exec(line);
    if (head) {
      cur = head[1];
      out[cur] = out[cur] || [];
      continue;
    }
    out[cur].push(line.split('=')[0]);
  }
  return out;
}

test('worldcard.service: ограничение перезапусков — в [Unit], запуск — в [Service]', () => {
  const s = sections(fs.readFileSync(new URL('../deploy/worldcard.service', import.meta.url), 'utf8'));
  for (const k of UNIT_ONLY) assert.ok(s.Unit.includes(k), `${k} в [Unit]`);
  for (const k of SERVICE_ONLY) assert.ok(s.Service.includes(k), `${k} в [Service]`);
  for (const k of UNIT_ONLY) assert.ok(!s.Service.includes(k), `${k} не в [Service]: там systemd его не читает`);
});
