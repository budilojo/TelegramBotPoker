#!/usr/bin/env node
/**
 * Последовательный запуск подготовки релиза с покупками: A (law) → B (payments) → C (navigation) → D (rating) → E (check).
 *
 *   node tools/release-run.mjs                 # запустить всё по порядку (или продолжить с места остановки)
 *   node tools/release-run.mjs --dry-run       # проверки и план, ничего не создаётся
 *   node tools/release-run.mjs --status        # что выполнено, что остановилось
 *   node tools/release-run.mjs --check         # проверить только манифест
 *   node tools/release-run.mjs --only law      # только один шаг (предыдущие должны быть выполнены)
 *
 * Параметры: --no-push, --model <модель> (перекрывает модель из .claude/agents), --permission-mode <режим> (auto),
 * --agent-timeout-min N (240), --continue-partial (идти дальше после статуса partial).
 *
 * Устройство (подробно — docs/next-release/README.md):
 *  · шаги строго по очереди, как требует план; параллельности нет;
 *  · все шаги работают в одной рабочей копии ../<проект>-release на ветке release/run (от origin/redesign);
 *  · исполнитель коммитит, но не пушит; после шага скрипт проверяет статус-файл, чистое дерево, гоняет npm test
 *    и только при зелёном делает обычный `git push origin release/run:redesign` (без --force);
 *  · состояние — .release-run/state.json (в .gitignore); повторный запуск продолжает.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAgentStatus, looksLikeLimit, snippet, changedSince } from './graphit-run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const MANIFEST = 'docs/next-release/agents.json';
const EXIT = { OK: 0, FAIL: 1, PRE: 2, LIMIT: 75 };
const RUN_DIR = path.join(ROOT, '.release-run');
const STATE_FILE = path.join(RUN_DIR, 'state.json');
const LOCK_FILE = path.join(RUN_DIR, 'lock');

/* ------------------------------------------------------------------ манифест */

export function loadManifest(file = path.join(ROOT, MANIFEST)) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Проблемы манифеста (пустой список = корректен). `exists` подменяется в тестах. */
export function validateManifest(m, { exists = (p) => fs.existsSync(path.join(ROOT, p)) } = {}) {
  const problems = [];
  if (!Array.isArray(m.steps) || !m.steps.length) return ['нет списка steps'];
  const ids = new Set();
  const ranges = [];
  for (const p of m.common || []) if (!exists(p)) problems.push(`нет общего файла ${p}`);
  for (const s of m.steps) {
    if (!s.id || ids.has(s.id)) problems.push(`повтор или пустой id: ${s.id}`);
    ids.add(s.id);
    if (!exists(s.task)) problems.push(`${s.id}: нет задания ${s.task}`);
    if (!exists(`.claude/agents/${s.agent}.md`)) problems.push(`${s.id}: нет определения агента .claude/agents/${s.agent}.md`);
    if (!Array.isArray(s.decisions) || s.decisions.length !== 2 || s.decisions[0] > s.decisions[1]) problems.push(`${s.id}: decisions должен быть [от, до]`);
    else ranges.push([s.id, ...s.decisions]);
  }
  for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) {
    if (ranges[i][1] <= ranges[j][2] && ranges[j][1] <= ranges[i][2]) problems.push(`диапазоны решений ${ranges[i][0]} и ${ranges[j][0]} пересекаются`);
  }
  return problems;
}

/**
 * Что делать дальше. Возвращает { step } | { done: true } | { stop: 'причина', step? }.
 * Шаг идёт после предыдущего только если тот выполнен (`done`), а `partial` — лишь при continuePartial.
 */
export function nextStep(m, state, { only = null, continuePartial = false } = {}) {
  const st = (id) => state.steps?.[id]?.status || 'pending';
  const steps = m.steps;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const status = st(s.id);
    if (only && !only.includes(s.id)) {
      continue;
    }
    if (status === 'done') continue;
    if (status === 'partial' && continuePartial && !(only && only.includes(s.id))) continue;
    const prev = steps.slice(0, i).find((p) => {
      const ps = st(p.id);
      return !(ps === 'done' || (ps === 'partial' && continuePartial));
    });
    if (prev) return { stop: `сначала нужно выполнить «${prev.id}» (сейчас: ${st(prev.id)})`, step: s };
    return { step: s };
  }
  return { done: true };
}

/* ------------------------------------------------------------------ git и процессы */

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const git = (cwd, ...args) => sh('git', args, { cwd });
const gitOut = (cwd, ...args) => (git(cwd, ...args).stdout || '').trim();
const ok = (r) => r.status === 0;
const now = () => new Date().toISOString();
const log = (...a) => console.log(...a);

const repoName = () => path.basename(ROOT);
const worktreeDir = () => path.resolve(ROOT, '..', `${repoName()}-release`);

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { steps: {} }; }
}
function writeState(state) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
const logFiles = (id, attempt) => ({
  out: path.join(RUN_DIR, 'logs', `${id}.${attempt}.out.json`),
  err: path.join(RUN_DIR, 'logs', `${id}.${attempt}.err.log`),
});
const statusPath = (id) => `docs/next-release/reports/${id}.status.json`;

/* ------------------------------------------------------------------ проверки перед запуском */

function preflight(m, o) {
  const errors = [];
  const warns = [];
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) errors.push(`нужен Node ≥ 22.5, а здесь ${process.versions.node}`);
  if (!ok(sh('git', ['--version']))) errors.push('git не найден');
  const claude = sh('claude', ['--version']);
  if (!ok(claude)) errors.push('команда claude не найдена: установите Claude Code и войдите в аккаунт');
  else {
    const help = sh('claude', ['--help']).stdout || '';
    for (const flag of ['--agent', '--permission-mode', '--output-format', '--print']) {
      if (!help.includes(flag)) errors.push(`эта версия claude не знает ${flag}: обновите Claude Code`);
    }
  }
  const branch = gitOut(ROOT, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== m.baseBranch) errors.push(`основная папка должна быть на ветке ${m.baseBranch}, а сейчас «${branch}»`);
  const dirty = gitOut(ROOT, 'status', '--porcelain', '--untracked-files=no').split('\n').filter((l) => l && !l.includes('.release-run'));
  if (dirty.length) errors.push(`в основной папке есть незакоммиченные изменения (${dirty.length}); сохраните их или отложите`);
  if (!o.check) {
    const f = git(ROOT, 'fetch', 'origin', m.baseBranch);
    if (!ok(f)) errors.push('git fetch origin не удался (нет связи или доступа к GitHub)');
    else if (gitOut(ROOT, 'rev-list', '--count', `HEAD..origin/${m.baseBranch}`) !== '0') errors.push(`локальная ${m.baseBranch} отстаёт от origin: выполните git pull origin ${m.baseBranch}`);
    else if (gitOut(ROOT, 'rev-list', '--count', `origin/${m.baseBranch}..HEAD`) !== '0') warns.push(`локальная ${m.baseBranch} впереди origin (незапушенные коммиты) — они попадут в запуск, но в origin их не будет`);
  }
  for (const p of validateManifest(m)) errors.push(`манифест: ${p}`);
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* нет такого процесса */ }
    if (alive) errors.push(`уже идёт другой запуск (процесс ${pid})`);
  }
  return { errors, warns };
}

/* ------------------------------------------------------------------ рабочая копия */

function ensureWorktree(m) {
  const dir = worktreeDir();
  if (fs.existsSync(dir)) {
    const cur = gitOut(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (cur !== m.runBranch) throw new Error(`папка ${dir} есть, но на ветке «${cur}», а нужна ${m.runBranch}`);
    return dir;
  }
  const exists = ok(git(ROOT, 'show-ref', '--verify', '--quiet', `refs/heads/${m.runBranch}`));
  const r = exists
    ? git(ROOT, 'worktree', 'add', dir, m.runBranch)
    : git(ROOT, 'worktree', 'add', '-b', m.runBranch, dir, `origin/${m.baseBranch}`);
  if (!ok(r)) throw new Error(`не удалось создать рабочую копию ${dir}: ${r.stderr}`);
  log(`  создана рабочая копия ${dir} (ветка ${m.runBranch}); ставлю зависимости…`);
  const i = sh('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir });
  if (!ok(i)) throw new Error(`npm install в ${dir} не удался: ${(i.stderr || '').slice(-300)}`);
  return dir;
}

/* ------------------------------------------------------------------ запуск исполнителя */

function buildPrompt(m, s, dir, state) {
  const prev = m.steps.slice(0, m.steps.findIndex((x) => x.id === s.id))
    .map((p) => `- ${p.id} (${p.letter}): ${state.steps?.[p.id]?.status || 'pending'}`);
  return [
    `Ты — исполнитель «${s.id}» (${s.letter}) подготовки релиза с покупками проекта TelegramBotPoker. Человека рядом нет: вопросов не задавай, обычные решения принимай сам и записывай в отчёт.`,
    `Твоя рабочая копия: ${dir} (ветка ${m.runBranch}). Сначала прочитай ${m.common.join(' и ')}, затем целиком своё задание ${s.task} и выполни его. Если в ветке уже есть твоя работа — продолжи, не переделывая.`,
    `Переопределение общей части: вместо «работа в redesign и обычный push» коммить в ${m.runBranch}; git push НЕ делай — скрипт проверит и опубликует сам. Не создавай PR, не выкатывай.`,
    `Закончи только после того, как записаны docs/next-release/reports/${s.id}.md и ${s.id}.status.json (поля id, status done|partial|blocked, summary, at, tests, blockers), всё закоммичено и git status чистый.`,
    prev.length ? `Предыдущие шаги:\n${prev.join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

function runAgent(m, s, dir, opts, state, index) {
  fs.mkdirSync(path.join(RUN_DIR, 'logs'), { recursive: true });
  const f = logFiles(s.id, state.steps[s.id].attempts);
  const out = fs.openSync(f.out, 'w');
  const err = fs.openSync(f.err, 'w');
  const args = ['-p', buildPrompt(m, s, dir, state), '--agent', s.agent, '--permission-mode', opts.permissionMode, '--output-format', 'json', '--name', `release-${s.id}`];
  if (opts.model) args.push('--model', opts.model);
  return spawn('claude', args, { cwd: dir, stdio: ['ignore', out, err], env: { ...process.env, RELEASE_RUN: '1', E2E_PORT: String(9300 + 40 * index) } });
}

function waitFor(child, timeoutMin) {
  return new Promise((resolve) => {
    let settled = false;
    const fin = (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* ok */ } fin({ code: null, timeout: true }); }, timeoutMin * 60_000);
    child.on('error', (e) => fin({ code: -1, error: e.message }));
    child.on('exit', (code) => fin({ code }));
  });
}

/* ------------------------------------------------------------------ проверка и публикация шага */

function gate(dir) {
  log('  прогоняю npm test в рабочей копии (несколько минут)…');
  const r = sh('npm', ['test'], { cwd: dir, maxBuffer: 1 << 28 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  // Итог — по коду выхода (0 = всё прошло). Числа — только для показа: у node:test строка то «# pass N», то «ℹ pass N».
  const pass = /^\W*pass (\d+)/m.exec(text)?.[1] ?? '?';
  const fail = /^\W*fail (\d+)/m.exec(text)?.[1] ?? '?';
  return { ok: ok(r), pass, fail, tail: text.slice(-600) };
}

function publish(m, dir, opts) {
  if (opts.noPush) return { pushed: false, why: 'указан --no-push' };
  if (gitOut(dir, 'status', '--porcelain')) return { pushed: false, why: 'в рабочей копии есть незакоммиченное' };
  git(dir, 'fetch', 'origin', m.baseBranch);
  if (gitOut(dir, 'rev-list', '--count', `HEAD..origin/${m.baseBranch}`) !== '0') {
    log(`  origin/${m.baseBranch} ушёл вперёд — сливаю его в ${m.runBranch} и проверяю тесты ещё раз`);
    const mr = git(dir, 'merge', '--no-ff', '-m', `Слияние origin/${m.baseBranch} в ${m.runBranch} перед публикацией`, `origin/${m.baseBranch}`);
    if (!ok(mr)) { git(dir, 'merge', '--abort'); return { pushed: false, why: `конфликт при слиянии свежего origin/${m.baseBranch}` }; }
    const g2 = gate(dir);
    if (!g2.ok) return { pushed: false, why: `после слияния с origin тесты красные (fail ${g2.fail})` };
  }
  const p = git(dir, 'push', 'origin', `${m.runBranch}:${m.baseBranch}`);
  if (!ok(p)) return { pushed: false, why: `push не прошёл: ${(p.stderr || '').trim().slice(-200)}` };
  return { pushed: true };
}

/* ------------------------------------------------------------------ вывод */

function table(m, state) {
  const rows = m.steps.map((s) => {
    const x = state.steps?.[s.id] || {};
    return `  ${s.letter}  ${s.id.padEnd(11)} ${(x.status || 'pending').padEnd(10)} попыток ${x.attempts || 0}${x.published ? '  опубликован' : ''}${x.note ? `  — ${x.note}` : ''}`;
  });
  return rows.join('\n');
}

function parseArgs(argv) {
  const o = { permissionMode: 'auto', timeoutMin: 240 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') o.dryRun = true;
    else if (x === '--status') o.status = true;
    else if (x === '--check') o.check = true;
    else if (x === '--no-push') o.noPush = true;
    else if (x === '--continue-partial') o.continuePartial = true;
    else if (x === '--only') o.only = String(argv[++i]).split(',').filter(Boolean);
    else if (x === '--model') o.model = argv[++i];
    else if (x === '--permission-mode') o.permissionMode = argv[++i];
    else if (x === '--agent-timeout-min') o.timeoutMin = Number(argv[++i]);
    else if (x === '-h' || x === '--help') o.help = true;
    else { console.error(`неизвестный параметр ${x}`); o.help = true; }
  }
  return o;
}

/* ------------------------------------------------------------------ главный ход */

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '')); return EXIT.OK; }
  const m = loadManifest();
  const state = readState();
  if (o.only) {
    const bad = o.only.filter((id) => !m.steps.some((s) => s.id === id));
    if (bad.length) { console.error(`нет таких шагов: ${bad.join(', ')}`); return EXIT.PRE; }
  }

  if (o.status) { console.log(table(m, state)); return EXIT.OK; }

  const pf = preflight(m, o);
  for (const w of pf.warns) log(`Предупреждение: ${w}`);
  if (pf.errors.length) {
    console.error('Запуск остановлен:');
    for (const e of pf.errors) console.error(`  · ${e}`);
    return EXIT.PRE;
  }
  if (o.check) { log('Манифест и окружение в порядке.'); return EXIT.OK; }

  log(`Подготовка релиза с покупками. Порядок: ${m.steps.map((s) => `${s.letter}=${s.id}`).join(' → ')}`);
  log(table(m, state));
  if (o.dryRun) {
    log(`\n--dry-run: ничего не создано и не запущено. Рабочая копия появится здесь: ${worktreeDir()} (ветка ${m.runBranch}).`);
    log(`Результат каждого шага после зелёного npm test публикуется обычным push в ${m.baseBranch}${o.noPush ? ' (отключено: --no-push)' : ''}.`);
    return EXIT.OK;
  }

  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  let exit = EXIT.OK;
  try {
    const dir = ensureWorktree(m);
    for (;;) {
      const nx = nextStep(m, state, { only: o.only, continuePartial: o.continuePartial });
      if (nx.done) { log('\nВсе шаги выполнены.'); break; }
      if (nx.stop) { log(`\nОстановка: ${nx.stop}.`); exit = EXIT.FAIL; break; }
      const s = nx.step;
      const index = m.steps.findIndex((x) => x.id === s.id);
      const rec = (state.steps[s.id] ||= { status: 'pending', attempts: 0 });
      // красный npm test после успешной работы агента: при повторном запуске агента не гоняем, проверяем заново то, что он сделал
      let ps;
      let recheck = false;
      if (rec.status === 'gate-failed' || rec.status === 'publish-failed') {
        const sp0 = path.join(dir, statusPath(s.id));
        const p0 = fs.existsSync(sp0) ? parseAgentStatus(fs.readFileSync(sp0, 'utf8'), s.id) : { ok: false };
        if (p0.ok && !gitOut(dir, 'status', '--porcelain')) { recheck = true; ps = p0; }
      }
      if (!recheck && rec.attempts >= m.maxAttempts) { log(`\n«${s.id}»: исчерпаны попытки (${m.maxAttempts}). Смотрите журналы .release-run/logs/.`); exit = EXIT.FAIL; break; }
      if (recheck) {
        log(`\n▶ ${s.letter} · ${s.id}: агент уже отработал, повторяю только проверку тестов`);
      } else {
        rec.attempts += 1;
        rec.base = gitOut(dir, 'rev-parse', 'HEAD');
        rec.startedAt = now();
        writeState(state);
        log(`\n▶ ${s.letter} · ${s.id} (попытка ${rec.attempts}) — агент ${s.agent}`);

        const child = runAgent(m, s, dir, o, state, index);
        const res = await waitFor(child, o.timeoutMin);
        const f = logFiles(s.id, rec.attempts);
        const outText = fs.existsSync(f.out) ? fs.readFileSync(f.out, 'utf8') : '';
        const errText = fs.existsSync(f.err) ? fs.readFileSync(f.err, 'utf8') : '';

        if (res.timeout || res.code !== 0) {
          const why = res.timeout ? `не уложился в ${o.timeoutMin} мин` : res.error ? `не запустился: ${res.error}` : `завершился с кодом ${res.code}`;
          const limit = looksLikeLimit(`${outText}\n${errText}`, true);
          rec.status = limit ? 'limit' : 'failed';
          rec.note = limit ? 'упёрся в лимит использования' : why;
          if (limit) rec.attempts -= 1; // ожидание сброса лимита не тратит попытки
          writeState(state);
          log(`  ✗ ${why}${limit ? ' — похоже на лимит использования; подождите сброса и запустите ту же команду' : ''}`);
          const sn = snippet(outText) || snippet(errText);
          if (sn) log(`    причина: ${sn}`);
          exit = limit ? EXIT.LIMIT : EXIT.FAIL;
          break;
        }

        const sp = path.join(dir, statusPath(s.id));
        if (!fs.existsSync(sp) || !changedSince(dir, rec.base, statusPath(s.id))) {
          rec.status = 'failed'; rec.note = 'исполнитель не записал свежий статус-файл';
          writeState(state);
          log(`  ✗ ${rec.note} (${statusPath(s.id)})`);
          exit = EXIT.FAIL; break;
        }
        ps = parseAgentStatus(fs.readFileSync(sp, 'utf8'), s.id);
        if (!ps.ok) {
          rec.status = 'failed'; rec.note = `статус-файл неверный: ${ps.problems.join('; ')}`;
          writeState(state);
          log(`  ✗ ${rec.note}`);
          exit = EXIT.FAIL; break;
        }
        if (gitOut(dir, 'status', '--porcelain')) {
          rec.status = 'failed'; rec.note = 'после работы в рабочей копии остались незакоммиченные изменения';
          writeState(state);
          log(`  ✗ ${rec.note}`);
          exit = EXIT.FAIL; break;
        }
      }

      rec.status = ps.status; rec.note = String(ps.raw.summary).slice(0, 160);
            log(`  статус исполнителя: ${ps.status} — ${rec.note}`);
      const g = gate(dir);
      rec.tests = g.ok ? `npm test зелёный (${g.pass})` : `npm test КРАСНЫЙ (pass ${g.pass}, fail ${g.fail})`;
      if (!g.ok) {
        rec.status = 'gate-failed'; rec.note = rec.tests;
        writeState(state);
        log(`  ✗ ${rec.tests} — ничего не опубликовано. Хвост вывода:\n${g.tail}`);
        exit = EXIT.FAIL; break;
      }
      log(`  ✓ ${rec.tests}`);
      const pub = publish(m, dir, o);
      rec.published = pub.pushed;
      if (!pub.pushed) log(`  не опубликовано: ${pub.why}`);
      else log(`  опубликовано в ${m.baseBranch}`);
      if (!pub.pushed && !o.noPush) {
        rec.status = 'publish-failed'; rec.note = `не опубликовано: ${pub.why}`;
        writeState(state);
        log('\nПубликация не удалась — остановка, чтобы следующие шаги не строились на неопубликованном. Повторная команда проверит и опубликует заново, не запуская агента.');
        exit = EXIT.FAIL; break;
      }
      writeState(state);
      if (ps.status === 'blocked') { log(`\nШаг «${s.id}» заблокирован — дальше не иду. Причина — в docs/next-release/reports/${s.id}.md`); exit = EXIT.FAIL; break; }
      if (ps.status === 'partial' && !o.continuePartial) { log(`\nШаг «${s.id}» выполнен частично — остановка. Прочитайте отчёт; продолжить можно командой с --continue-partial.`); exit = EXIT.FAIL; break; }
    }
  } catch (e) {
    console.error(e.message || e);
    exit = EXIT.FAIL;
  } finally {
    fs.rmSync(LOCK_FILE, { force: true });
  }
  log(`\n${table(m, readState())}`);
  return exit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); try { fs.rmSync(LOCK_FILE, { force: true }); } catch { /* ok */ } process.exit(EXIT.FAIL); });
}
