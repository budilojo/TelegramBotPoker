import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { STEPS, acquireLock, buildPrompt, codexArgs, parseArgs, readState, reportPath, run, validateReport } from './codex-release-run.mjs';

const opts = { timeoutMin: 1 };
const origin = 'https://github.com/budilojo/TelegramBotPoker.git';
const report = (step, attemptId, extra = {}) => ({
  id: step.id, attemptId, status: 'done', summary: 'Проверено в тестовом репозитории',
  tests: [{ command: 'fixture', result: 'pass', environment: 'stub' }], blockers: [], ...extra,
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `fixture git ${args.join(' ')}: ${result.stderr}`);
    return (result.stdout || '').trim();
  };
  const commit = (message) => {
    git('add', '-A');
    git('-c', 'user.name=Тест', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', message);
  };
  git('init', '--quiet', '-b', 'redesign');
  put('.gitignore', '.release-run/\n');
  for (const name of ['docs/codex-release/00-plan.md', 'docs/codex-release/claude-interrupted.patch', ...STEPS.map((s) => s.task)]) put(name, 'Тестовый материал\n');
  commit('Исходное состояние теста');
  git('remote', 'add', 'origin', origin);
  git('update-ref', 'refs/remotes/origin/redesign', 'HEAD');
  const stateFile = path.join(root, '.release-run/codex/state.json');
  const state = () => readState(stateFile);
  const events = [];
  const control = { testStatus: 0, fetchFail: 0, pushFail: 0, reportExtra: {}, reportPerStep: {}, wrongAttempt: false, forbidden: null, dirtyAfter: false };
  let fetchCount = 0;
  let pushCount = 0;
  const command = (cmd, args) => {
    events.push({ cmd, args: [...args] });
    if (cmd === 'codex') return { status: 0, stdout: args[0] === 'exec' ? '--approve-for-me --json --output-last-message' : 'ready' };
    if (cmd === 'npm') return { status: control.testStatus, stdout: control.testStatus ? 'failed fixture test' : 'fixture tests passed' };
    assert.equal(cmd, 'git', 'никаких других внешних команд');
    if (args[0] === 'fetch') {
      fetchCount++;
      return { status: control.fetchFail === fetchCount ? 1 : 0, stdout: '' };
    }
    if (args[0] === 'push') {
      pushCount++;
      if (control.pushFail === pushCount) return { status: 1, stderr: 'fixture push rejected' };
      git('update-ref', 'refs/remotes/origin/redesign', 'HEAD');
      return { status: 0, stdout: '' };
    }
    return spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  };
  const launch = async (_root, step, attemptId) => {
    events.push({ cmd: 'launch', id: step.id, attemptId });
    put(reportPath(step), JSON.stringify(report(step, control.wrongAttempt ? 'previous-attempt' : attemptId, { ...control.reportExtra, ...control.reportPerStep[step.id] })));
    put(`docs/codex-release/reports/${step.id}.md`, 'Отчёт тестового исполнителя\n');
    if (control.forbidden) put(control.forbidden, 'Запрещённое изменение\n');
    commit(`Проверка ${step.id}`);
    if (control.dirtyAfter) put('unfinished.txt', 'Работа сохранена\n');
    return { code: 0 };
  };
  const pushes = () => events.filter((e) => e.cmd === 'git' && e.args[0] === 'push');
  const launches = () => events.filter((e) => e.cmd === 'launch');
  return { root, put, git, commit, state, stateFile, events, control, command, launch, pushes, launches };
}

test('Codex: строгие аргументы, безопасный sandbox и отдельные задания без Claude', () => {
  assert.deepEqual(STEPS.map((s) => s.letter), ['I', 'J', 'K', 'L', 'M']);
  const args = codexArgs('/tmp/project with spaces', '/tmp/out.md');
  assert.deepEqual(args.slice(0, 2), ['--search', 'exec'], 'агенту доступен поиск официальных источников для актуальной проверки');
  assert.ok(args.includes('--approve-for-me'));
  assert.ok(args.includes('--json'));
  assert.equal(args.at(-1), '-');
  assert.ok(!args.some((x) => x.includes('bypass') || x === 'danger-full-access'));
  assert.ok(!args.includes('--model'), 'по умолчанию используется настроенная модель');
  assert.deepEqual(codexArgs('/tmp/repo', '/tmp/out', 'custom').slice(-3), ['--model', 'custom', '-']);
  assert.match(buildPrompt('/tmp/repo', STEPS[0], 'fresh-id'), /fresh-id/);
  assert.match(buildPrompt('/tmp/repo', STEPS[0], 'fresh-id'), /claude-interrupted\.patch/);
  assert.throws(() => parseArgs(['--dangerously-bypass-approvals-and-sandbox']));
  assert.throws(() => parseArgs(['--agent-timeout-min', 'NaN']));
  assert.throws(() => parseArgs(['--model']));
});

test('статус требует текущую попытку и отличает внешние препятствия от ошибок кода', () => {
  const step = STEPS[0];
  assert.throws(() => validateReport(report(step, 'old'), step, 'new'), /попытке/);
  assert.throws(() => validateReport(report(step, 'new', { status: 'blocked' }), step, 'new'), /blocked/);
  assert.throws(() => validateReport(report(step, 'new', { status: 'partial', blockers: [{ scope: 'code', reason: 'Тест падает' }] }), step, 'new'), /локальные/);
  assert.throws(() => validateReport(report(step, 'new', { status: 'partial' }), step, 'new'), /перечня/);
  assert.equal(validateReport(report(step, 'new', { status: 'partial', blockers: [{ scope: 'external', reason: 'Нужен телефон' }] }), step, 'new').status, 'partial');
});

test('проверка в отчёте требует конкретные команду, результат и среду', () => {
  const step = STEPS[0];
  for (const tests of [[null], [{}], [{ command: 'npm test', result: '', environment: 'stub' }], [{ command: 'npm test', result: 'pass', environment: 3 }]]) {
    assert.throws(() => validateReport(report(step, 'new', { tests }), step, 'new'), /команда, результат и среда/);
  }
});

test('повреждённое состояние останавливает запуск, не сбрасывается и не запускает команды', async (t) => {
  const f = fixture(t);
  f.put('.release-run/codex/state.json', '{truncated');
  await assert.rejects(run(f.root, opts, f), SyntaxError);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), '{truncated');
  assert.deepEqual(f.events, []);
  f.put('.release-run/codex/state.json', JSON.stringify({ version: 1, steps: [] }));
  assert.throws(() => f.state(), /Повреждено/);
});

test('эксклюзивная блокировка запрещает второй запуск и сохраняет чужой lock', async (t) => {
  const f = fixture(t);
  f.put('.release-run/codex/placeholder', '');
  const lock = path.join(f.root, '.release-run/codex/lock');
  const unlock = acquireLock(lock);
  const initial = fs.readFileSync(lock, 'utf8');
  assert.throws(() => acquireLock(lock), /блокировк/i);
  await assert.rejects(run(f.root, opts, f), /блокировк/i);
  assert.equal(fs.readFileSync(lock, 'utf8'), initial);
  assert.equal(f.launches().length, 0);
  unlock();
});

test('dry-run не запускает исполнителей, fetch, тесты, push и не создаёт состояние', async (t) => {
  const f = fixture(t);
  assert.equal(await run(f.root, { ...opts, dryRun: true }, f), 0);
  assert.ok(!fs.existsSync(f.stateFile));
  assert.equal(f.launches().length, 0);
  assert.equal(f.pushes().length, 0);
  assert.ok(!f.events.some((e) => e.cmd === 'npm' || (e.cmd === 'git' && e.args[0] === 'fetch')));
});

for (const [name, configure, error] of [
  ['blocked', (f) => { f.control.reportExtra = { status: 'blocked' }; }, /blocked/],
  ['красный npm test', (f) => { f.control.testStatus = 1; }, /npm test/],
  ['старый attemptId', (f) => { f.control.wrongAttempt = true; }, /попытке/],
  ['ошибка кода не маскируется partial', (f) => { f.control.reportExtra = { status: 'partial', blockers: [{ scope: 'code', reason: 'Проверка не закончена' }] }; }, /локальные/],
]) test(`${name}: нет push и следующего исполнителя, состояние сохранено`, async (t) => {
  const f = fixture(t); configure(f);
  await assert.rejects(run(f.root, opts, f), error);
  assert.deepEqual(f.launches().map((e) => e.id), ['check2']);
  assert.equal(f.pushes().length, 0);
  assert.equal(f.state().steps.check2.status, 'interrupted');
  assert.ok(!f.state().steps.multiplayer);
});

test('этапы идут последовательно: запуск → тест → push; принятые при повторе не запускаются', async (t) => {
  const f = fixture(t);
  assert.equal(await run(f.root, opts, f), 0);
  assert.deepEqual(f.launches().map((e) => e.id), STEPS.map((s) => s.id));
  assert.equal(f.pushes().length, STEPS.length);
  for (const s of STEPS) {
    const start = f.events.findIndex((e) => e.cmd === 'launch' && e.id === s.id);
    const after = f.events.slice(start + 1);
    const testAt = after.findIndex((e) => e.cmd === 'npm');
    const pushAt = after.findIndex((e) => e.cmd === 'git' && e.args[0] === 'push');
    const nextAt = after.findIndex((e) => e.cmd === 'launch');
    assert.ok(testAt >= 0 && pushAt > testAt);
    assert.ok(nextAt === -1 || nextAt > pushAt);
    assert.equal(f.state().steps[s.id].published, true);
  }
  f.events.length = 0;
  assert.equal(await run(f.root, opts, f), 0);
  assert.equal(f.launches().length, 0);
  assert.equal(f.pushes().length, 0);
});

test('неуспешный push оставляет ready; повтор публикует без повторного исполнителя', async (t) => {
  const f = fixture(t); f.control.pushFail = 1;
  await assert.rejects(run(f.root, opts, f), /git push/);
  const firstAttempt = f.state().steps.check2.attemptId;
  assert.equal(f.state().steps.check2.status, 'ready');
  f.control.pushFail = 0;
  f.events.length = 0;
  await run(f.root, opts, f);
  assert.deepEqual(f.launches().map((e) => e.id), STEPS.slice(1).map((s) => s.id));
  assert.equal(f.state().steps.check2.attemptId, firstAttempt);
  assert.equal(f.state().steps.check2.published, true);
});

test('после остановки второго этапа повтор не запускает уже принятый первый', async (t) => {
  const f = fixture(t);
  f.control.reportPerStep.multiplayer = { status: 'blocked' };
  await assert.rejects(run(f.root, opts, f), /blocked/);
  const firstAttempt = f.state().steps.check2.attemptId;
  assert.equal(f.state().steps.check2.published, true);
  f.control.reportPerStep = {};
  f.events.length = 0;
  await run(f.root, opts, f);
  assert.deepEqual(f.launches().map((e) => e.id), STEPS.slice(1).map((s) => s.id));
  assert.equal(f.state().steps.check2.attemptId, firstAttempt);
});

test('посторонние незакоммиченные файлы сохраняются, запуск остановлен', async (t) => {
  const f = fixture(t);
  f.put('owners-work.txt', 'Чужая незаконченная работа\n');
  await assert.rejects(run(f.root, opts, f), /незакоммиченные/);
  assert.equal(fs.readFileSync(path.join(f.root, 'owners-work.txt'), 'utf8'), 'Чужая незаконченная работа\n');
  assert.equal(f.launches().length, 0);
  assert.equal(f.pushes().length, 0);
});

test('незаконченная работа после остановки сохраняется; изменение её владельцем требует проверки', async (t) => {
  const f = fixture(t); f.control.dirtyAfter = true;
  await assert.rejects(run(f.root, opts, f), /незакоммиченные/);
  assert.ok(f.state().steps.check2.dirtyHash);
  f.put('unfinished.txt', 'Ручное исправление владельца\n');
  f.control.dirtyAfter = false;
  f.events.length = 0;
  await assert.rejects(run(f.root, opts, f), /посторонние/);
  assert.equal(f.launches().length, 0);
  assert.equal(fs.readFileSync(path.join(f.root, 'unfinished.txt'), 'utf8'), 'Ручное исправление владельца\n');
});

test('повтор продолжает неизменённую незакоммиченную работу после остановки', async (t) => {
  const f = fixture(t); f.control.dirtyAfter = true;
  await assert.rejects(run(f.root, opts, f), /незакоммиченные/);
  const firstAttempt = f.state().steps.check2.attemptId;
  f.control.dirtyAfter = false;
  f.events.length = 0;
  assert.equal(await run(f.root, opts, f), 0);
  assert.equal(fs.readFileSync(path.join(f.root, 'unfinished.txt'), 'utf8'), 'Работа сохранена\n');
  assert.deepEqual(f.launches().map((e) => e.id), STEPS.map((s) => s.id));
  assert.notEqual(f.state().steps.check2.attemptId, firstAttempt);
  assert.equal(f.git('status', '--porcelain'), '');
});

for (const fetchFail of [1, 2]) test(`ошибка fetch №${fetchFail}: push не выполняется`, async (t) => {
  const f = fixture(t); f.control.fetchFail = fetchFail;
  await assert.rejects(run(f.root, opts, f), /git fetch/);
  assert.equal(f.pushes().length, 0);
  assert.equal(f.launches().length, fetchFail === 1 ? 0 : 1);
});

for (const name of ['server/game.js', 'public/index.html', 'deploy/update.sh', '.env', 'bot/.env.test', 'tools/codex-release-run.mjs']) {
  test(`запрещённая правка ${name} не публикуется`, async (t) => {
    const f = fixture(t); f.control.forbidden = name;
    await assert.rejects(run(f.root, opts, f), /запрещённый/);
    assert.equal(f.pushes().length, 0);
    assert.equal(f.launches().length, 1);
    assert.equal(fs.readFileSync(path.join(f.root, name), 'utf8'), 'Запрещённое изменение\n');
  });
}

test('повтор после запрещённой правки не обходит запрет новым чистым отчётом', async (t) => {
  const f = fixture(t); f.control.forbidden = 'server/game.js';
  await assert.rejects(run(f.root, opts, f), /запрещённый/);
  f.control.forbidden = null;
  f.events.length = 0;
  await assert.rejects(run(f.root, opts, f), /запрещённый/);
  assert.equal(f.pushes().length, 0, 'опасный коммит прошлого запуска не может попасть в origin');
});
