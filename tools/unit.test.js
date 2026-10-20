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

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('аудит H-02: на сервере бот слушает только 127.0.0.1 — снаружи он виден лишь через Caddy', () => {
  const unit = read('deploy/worldcard.service');
  assert.match(unit, /^Environment=BIND_HOST=127\.0\.0\.1$/m);
  const s = sections(unit);
  assert.ok(s.Service.includes('Environment'), 'Environment — в [Service]');
  // Бот берёт адрес из BIND_HOST и отдаёт серверу стола.
  const index = read('bot/index.js');
  assert.match(index, /process\.env\.BIND_HOST/);
  assert.match(index, /startServer\(\{[\s\S]*?host: BIND_HOST/);
  // Caddy ходит именно туда.
  assert.match(read('deploy/Caddyfile'), /reverse_proxy 127\.0\.0\.1:8080/);
});

test('аудит H-02: юнит ограничивает память и закрывает лишнее — в секции [Service]', () => {
  const s = sections(read('deploy/worldcard.service'));
  for (const k of ['MemoryMax', 'MemoryHigh', 'PrivateDevices', 'ProtectKernelTunables', 'ProtectKernelModules', 'RestrictAddressFamilies', 'NoNewPrivileges', 'ProtectSystem']) {
    assert.ok(s.Service.includes(k), `${k} в [Service]`);
  }
  // V8 пишет и исполняет свой код — этот запрет уронил бы Node.
  assert.ok(!s.Service.includes('MemoryDenyWriteExecute'));
});

test('аудит H-02/H-01: обновление — тесты на отдельной копии до того, как тронута рабочая папка; права на базу — каждый раз', () => {
  const sh = read('deploy/update.sh');
  const at = (re) => {
    const m = re.exec(sh);
    assert.ok(m, `нет ${re}`);
    return m.index;
  };
  const worktree = at(/git worktree add --detach "\$NEXT"/);
  const tests = at(/cd "\$NEXT" && sudo -u "\$USER" npm ci --omit=dev && sudo -u "\$USER" npm test/);
  const reset = at(/git reset --hard "origin\/\$BRANCH"/);
  const restart = at(/systemctl restart worldcard/);
  assert.ok(worktree < tests && tests < reset && reset < restart, 'копия → тесты → переключение → перезапуск');
  assert.match(sh, /exit 1\n\s*fi\n\s*cleanup_next/, 'тесты упали — выход до переключения');
  assert.match(sh, /chmod 700 "\$APP\/data" "\$APP\/backups"/);
  assert.match(read('.gitignore'), /^\.update-check\/$/m);
});
