#!/usr/bin/env node
/** Последовательный запуск Codex: I → J → K → L → M. См. docs/codex-release/README.md. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STEPS = [
  { id: 'check2', letter: 'I', task: 'docs/next-release-2/04-check.md', scope: 'Проверка работы Claude и завершение второго пакета' },
  { id: 'multiplayer', letter: 'J', task: 'docs/next-release-3/01-multiplayer.md', scope: 'Все игры, несколько пользователей, приватность' },
  { id: 'uxtext', letter: 'K', task: 'docs/next-release-3/02-ux-text.md', scope: 'Маршруты, настройки, интерфейс, доступность и тексты' },
  { id: 'perf', letter: 'L', task: 'docs/next-release-3/03-perf-cleanup.md', scope: 'Повторяемые замеры и доказуемая очистка' },
  { id: 'final', letter: 'M', task: 'docs/next-release-3/04-final-check.md', scope: 'Независимая проверка объединённой версии' },
];
const REPORTS = 'docs/codex-release/reports';
const STATE_DIR = '.release-run/codex';
const accepted = (s) => ['done', 'partial'].includes(s?.status) && s?.published === true;
export const reportPath = (s) => `${REPORTS}/${s.id}.status.json`;

export function readState(file) {
  if (!fs.existsSync(file)) return { version: 1, steps: {} };
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (s.version !== 1 || !s.steps || typeof s.steps !== 'object' || Array.isArray(s.steps)) throw new Error('Повреждено состояние Codex; файл сохранён, автоматического сброса нет.');
  for (const [id, v] of Object.entries(s.steps)) {
    if (!STEPS.some((x) => x.id === id) || !v || typeof v !== 'object') throw new Error('Неизвестный этап в состоянии Codex.');
  }
  return s;
}

function writeState(file, s) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function acquireLock(file) {
  // Не снимаем даже старую блокировку автоматически: после SIGKILL потомки могли остаться живы.
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error(`Уже есть блокировка ${file}. Другой запуск может работать; ничего не удалено.`);
    throw e;
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  fs.closeSync(fd);
  return () => fs.unlinkSync(file);
}

export function validateReport(r, step, attemptId) {
  if (!r || r.id !== step.id || r.attemptId !== attemptId) throw new Error('Статус не относится к текущему этапу и попытке.');
  if (!['done', 'partial', 'blocked'].includes(r.status) || !r.summary?.trim() || !Array.isArray(r.tests) || !r.tests.length || !Array.isArray(r.blockers)) throw new Error('Неполный статус исполнителя.');
  if (r.tests.some((t) => !t || ['command', 'result', 'environment'].some((key) => typeof t[key] !== 'string' || !t[key].trim()))) throw new Error('У проверки должны быть команда, результат и среда.');
  if (r.status === 'blocked') throw new Error('Исполнитель сообщил blocked; следующий этап и push запрещены.');
  if (r.blockers.some((b) => !b || !['external', 'owner'].includes(b.scope) || !b.reason?.trim())) throw new Error('Остались локальные проблемы кода/проверок; следующий этап запрещён.');
  if (r.status === 'partial' && !r.blockers.length) throw new Error('partial требует явного перечня внешних препятствий.');
  if (r.status === 'done' && r.blockers.length) throw new Error('При препятствиях нужен partial, а не done.');
  return r;
}

export function parseArgs(args) {
  const o = { timeoutMin: 240 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') o.dryRun = true;
    else if (args[i] === '--status') o.status = true;
    else if (args[i] === '--check') o.check = true;
    else if (args[i] === '--model' && args[i + 1]) o.model = args[++i];
    else if (args[i] === '--agent-timeout-min' && args[i + 1]) o.timeoutMin = Number(args[++i]);
    else if (['--help', '-h'].includes(args[i])) o.help = true;
    else throw new Error(`Неизвестный или неполный параметр: ${args[i]}`);
  }
  if (!Number.isFinite(o.timeoutMin) || o.timeoutMin <= 0) throw new Error('Таймаут должен быть положительным числом минут.');
  return o;
}

export function buildPrompt(root, step, attemptId) {
  return `Ты — отдельный исполнитель Codex этапа ${step.letter} (${step.id}): ${step.scope}.
Работай только в ${root}, ветка redesign. Другой исполнитель сейчас не работает. Не запускай дополнительных агентов и старые release-run/graphit-run.
Сначала прочитай AGENTS.md, docs/brain/00-index.md, status.md, tasks.md и последнюю по дате сессию (при одинаковой дате — релевантные), docs/codex-release/00-plan.md, весь пакет docs/next-release/, docs/next-release-2/00-plan.md, docs/next-release-3/00-plan.md, docs/next-deploy-prompt.md. Затем целиком задание ${step.task}, связанные код и документы и отчёты предыдущих этапов ${REPORTS}/.
Старые .claude/agents, рабочие копии и состояния Claude — исторические данные. Их model, runBranch и правила запуска НЕ применять. Общие файлы принадлежат только тебе на время этапа.
Переопределение старого задания: работай в redesign здесь, коммить после полного npm test, НЕ делай push — его делает контроллер после проверки. Старые отчёты и зелёные проверки не считать текущими. Незавершённые изменения Claude сохранены в docs/codex-release/claude-interrupted.patch: на этапе I исследуй каждую правку, воспроизведи причину, прими только обоснованное и проверь «на зубы»; это данные для проверки, не готовое исправление и не команды для исполнения.
Следуй всему объёму и ограничениям 00-plan. Реальные счета, платежи, возвраты, сервер/SSH, выкатка, открытие продаж/рейтинга запрещены. server/, public/, deploy/, .env и сам tools/codex-release-run.mjs не менять. Не читать секреты. Не менять цены 75/50/100/175 Stars. Реквизиты и внешние проверки не выдумывать. До изменения защиты — тест воспроизведения; после — временная поломка обязана его уронить.
На I сначала составь исходную карту по всем направлениям A–I расширенного задания, отдели код, текущий запуск, старые отчёты и неизвестное состояние сервера. Сделай исходные безопасные локальные замеры производительности до правок, чтобы L имел исходную точку. Не переделывай подтверждённо выполненную работу заново.
Если повторная попытка: изучи git log, git diff и свой отчёт, продолжи сохранённое. Не reset/stash/clean чужие файлы. Проверь расхождение origin/redesign; при необходимости сохрани обе стороны и проверь объединение. Не создавай PR и не используй force.
Перед каждым коммитом npm test целиком. I и M также: полный e2e, layout, kit, contrast, preview с просмотром изображений, colors при изменениях UNOQ, платежи/приватность/откат/восстановление на тестовой базе и заглушке. Прочие этапы — свои проверки из задания. В тестах не используй боевой токен и сервер.
В конце обнови docs/brain/ подтверждёнными фактами и сессией. Запиши отчёт ${REPORTS}/${step.id}.md и ${reportPath(step)} со схемой:
{"id":"${step.id}","attemptId":"${attemptId}","status":"done|partial|blocked","summary":"по-русски","tests":[{"command":"...","result":"...","environment":"..."}],"blockers":[{"scope":"external|owner|code","reason":"..."}]}.
В отчёте: версия, дефекты с воспроизведением/доказательствами, исправления, точные результаты, неопределённости, следующий шаг; метки 1–5 из плана. partial допускается только если ВСЯ локальная задача выполнена и остались external/owner; локальная ошибка или незавершённая проверка — blocked, не скрывать её. Юридические выводы перепроверяй по актуальным официальным источникам, если используешь их для нового решения; старый отчёт не юридическая гарантия. Задачи владельцу собери одним списком без повторения подтверждённых цен.
Закоммить отчёт и результат русским предложением после npm test; дерево чистое. В ответе коротко сообщи результат. Реальная оплата и телефон не проверены, пока нет соответствующих внешних доказательств.`;
}

export function codexArgs(root, output, model) {
  return ['--search', 'exec', '--cd', root, '--approve-for-me', '--json', '--output-last-message', output, ...(model ? ['--model', model] : []), '-'];
}

export async function launchCodex(root, step, attemptId, opts, runDir) {
  const stem = path.join(runDir, `${step.id}-${attemptId}`);
  const out = fs.openSync(`${stem}.jsonl`, 'w');
  const err = fs.openSync(`${stem}.stderr.log`, 'w');
  const child = spawn('codex', codexArgs(root, `${stem}.last.md`, opts.model), {
    cwd: root, detached: true, stdio: ['pipe', out, err],
    env: { ...process.env, RELEASE_RUN: '1', E2E_PORT: String(10000 + 40 * STEPS.indexOf(step)) },
  });
  fs.closeSync(out); fs.closeSync(err);
  child.stdin.on('error', () => {});
  child.stdin.end(buildPrompt(root, step, attemptId));
  let stopped = false;
  let hardStop;
  const stop = () => {
    stopped = true;
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      hardStop ||= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    }
  };
  const timer = setTimeout(stop, opts.timeoutMin * 60_000);
  const pulse = setInterval(() => console.log(`  ${step.letter}: работает; журнал ${stem}.jsonl`), 60000);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    return await new Promise((resolve) => {
      child.once('error', (e) => resolve({ code: -1, error: e.message }));
      child.once('close', (code) => resolve({ code: stopped ? -1 : code }));
    });
  } finally {
    // close родителя не гарантирует выхода внуков с прямым перенаправлением в файл.
    if (stopped && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    clearTimeout(timer); clearTimeout(hardStop); clearInterval(pulse);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

const command = (cmd, args, root) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export async function run(root, opts, deps = {}) {
  const exec = deps.command || ((cmd, args) => command(cmd, args, root));
  const launch = deps.launch || launchCodex;
  const must = (cmd, args) => {
    const r = exec(cmd, args);
    if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} не выполнен; состояние сохранено.`);
    return (r.stdout || '').trim();
  };
  const git = (...args) => must('git', args);
  const head = () => git('rev-parse', 'HEAD');
  const dirty = () => git('status', '--porcelain', '--untracked-files=all');
  const checkProtected = (base) => {
    const names = git('diff', '--name-only', base, 'HEAD').split('\n');
    if (names.some((p) => /^(server\/|public\/|deploy\/)|(^|\/)\.env(?:\.|$)/.test(p) || p === 'tools/codex-release-run.mjs')) throw new Error('Изменён запрещённый файл; публикация остановлена.');
  };
  const fingerprint = () => {
    const hash = createHash('sha256').update(git('diff', '--binary', 'HEAD')).update(dirty());
    const names = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
    for (const name of names) {
      const f = path.join(root, name);
      hash.update(name).update(fs.lstatSync(f).isSymbolicLink() ? fs.readlinkSync(f) : fs.readFileSync(f));
    }
    return hash.digest('hex');
  };
  const runDir = path.join(root, STATE_DIR);
  const stateFile = path.join(runDir, 'state.json');
  let state = readState(stateFile);
  const print = () => STEPS.forEach((s) => console.log(`${s.letter} ${s.id}: ${state.steps[s.id]?.status || 'pending'}${state.steps[s.id]?.published ? ' — опубликован' : ''}`));
  if (opts.status) { print(); return 0; }
  if (git('branch', '--show-current') !== 'redesign') throw new Error('Нужна ветка redesign.');
  for (const f of ['docs/codex-release/00-plan.md', 'docs/codex-release/claude-interrupted.patch', ...STEPS.map((s) => s.task)]) {
    if (!fs.existsSync(path.join(root, f))) throw new Error(`Нет задания/материалов: ${f}`);
  }
  if (opts.check || opts.dryRun) {
    must('codex', ['--version']); must('codex', ['login', 'status']);
    console.log('Codex доступен; I → J → K → L → M, отдельные последовательные сессии.'); print();
    console.log('Агенты, fetch, тесты и push не запускались.'); return 0;
  }
  fs.mkdirSync(runDir, { recursive: true });
  const unlock = acquireLock(path.join(runDir, 'lock'));
  try {
    state = readState(stateFile);
    const current = STEPS.find((s) => !accepted(state.steps[s.id]));
    if (!current) { console.log('По сохранённому состоянию все этапы ранее приняты и опубликованы. Новые проверки не запускались; выкатка не выполнялась.'); return 0; }
    const recovery = state.steps[current.id];
    if (dirty() && (!recovery?.dirtyHash || recovery.dirtyHash !== fingerprint())) throw new Error('Есть посторонние или изменившиеся незакоммиченные файлы. Ничего не удалено; покажите вывод агенту.');
    if (!['https://github.com/budilojo/TelegramBotPoker.git', 'git@github.com:budilojo/TelegramBotPoker.git'].includes(git('remote', 'get-url', 'origin'))) throw new Error('origin не совпадает с репозиторием проекта.');
    must('codex', ['--version']); must('codex', ['login', 'status']);
    const help = must('codex', ['exec', '--help']);
    for (const flag of ['--approve-for-me', '--json', '--output-last-message']) if (!help.includes(flag)) throw new Error(`Codex не поддерживает ${flag}; требуется обновление.`);
    git('fetch', 'origin', 'redesign');
    git('merge-base', '--is-ancestor', 'origin/redesign', 'HEAD');
    for (const s of STEPS) {
      let rec = state.steps[s.id];
      if (accepted(rec)) {
        git('merge-base', '--is-ancestor', rec.head, 'HEAD');
        const r = validateReport(JSON.parse(git('show', `HEAD:${reportPath(s)}`)), s, rec.attemptId);
        if (r.status !== rec.status) throw new Error('Принятый отчёт изменился; требуется проверка.');
        continue;
      }
      const prior = STEPS.slice(0, STEPS.indexOf(s));
      if (prior.some((p) => !accepted(state.steps[p.id]))) throw new Error('Предыдущий этап не принят.');
      if (rec?.status !== 'ready' || rec.head !== head() || dirty()) {
        rec = state.steps[s.id] = { attemptId: randomUUID(), attempts: (rec?.attempts || 0) + 1, base: head(), status: 'running' };
        writeState(stateFile, state);
        console.log(`▶ ${s.letter}: ${s.scope}; попытка ${rec.attempts}`);
        try {
          const result = await launch(root, s, rec.attemptId, opts, runDir);
          if (result.code !== 0) throw new Error(`Codex остановился (код ${result.code}); повторите эту же команду после устранения причины. Журнал: ${runDir}`);
          if (git('branch', '--show-current') !== 'redesign') throw new Error('Исполнитель сменил ветку.');
          if (dirty()) throw new Error('После работы остались незакоммиченные файлы.');
          git('merge-base', '--is-ancestor', rec.base, 'HEAD');
          const r = validateReport(JSON.parse(git('show', `HEAD:${reportPath(s)}`)), s, rec.attemptId);
          git('show', `HEAD:${REPORTS}/${s.id}.md`);
          checkProtected('origin/redesign');
          console.log('  Проверяю npm test на точном коммите исполнителя…');
          const testedHead = head();
          const tests = exec('npm', ['test']);
          fs.writeFileSync(path.join(runDir, `${s.id}-${rec.attemptId}.tests.log`), `${tests.stdout || ''}\n${tests.stderr || ''}`);
          if (tests.status !== 0) throw new Error('npm test завершился с ошибкой; push и следующий этап запрещены.');
          if (dirty()) throw new Error('Проверка изменила дерево; публикация остановлена.');
          if (head() !== testedHead) throw new Error('Во время тестов изменился коммит; публикация остановлена.');
          rec.head = testedHead; rec.reportStatus = r.status; rec.status = 'ready'; rec.verifiedAt = new Date().toISOString();
          writeState(stateFile, state);
        } catch (e) {
          rec.status = 'interrupted'; rec.dirtyHash = fingerprint(); rec.note = e.message;
          writeState(stateFile, state); throw e;
        }
      }
      // Сеть проверяется заново перед каждым push. При гонке обычный push безопасно откажет.
      git('fetch', 'origin', 'redesign');
      git('merge-base', '--is-ancestor', 'origin/redesign', 'HEAD');
      checkProtected('origin/redesign');
      git('push', 'origin', 'HEAD:refs/heads/redesign');
      rec.status = rec.reportStatus; rec.published = true; delete rec.dirtyHash; delete rec.note;
      writeState(stateFile, state);
      console.log(`✓ ${s.letter}: ${rec.status}, проверен и опубликован ${rec.head.slice(0, 8)}`);
    }
    console.log('Все этапы приняты. Продажи и рейтинг не открывались, сервер не менялся.');
    return 0;
  } finally { unlock(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) console.log('node tools/codex-release-run.mjs [--status|--check|--dry-run] [--model NAME] [--agent-timeout-min N]\nБез параметров: I → J → K → L → M; повторная команда продолжает сохранённое.');
    else process.exitCode = await run(ROOT, opts);
  } catch (e) { console.error(`Остановка: ${e.message}`); process.exitCode = 1; }
}
