#!/usr/bin/env node
/**
 * Единый запуск пакета «Графит»: координация исполнителей по зависимостям.
 *
 *   node tools/graphit-run.mjs                 # запустить (или продолжить) всё
 *   node tools/graphit-run.mjs --dry-run       # только проверки и план, ничего не создаётся
 *   node tools/graphit-run.mjs --status        # что выполнено, что остановилось
 *   node tools/graphit-run.mjs --check         # проверить только манифест (без git и claude)
 *
 * Параметры: --max-parallel N (по умолчанию из agents.json, 3), --only id[,id], --no-push,
 * --model <модель>, --permission-mode <режим> (по умолчанию auto), --agent-timeout-min N (по умолчанию 240).
 *
 * Как устроено (подробно — docs/graphit-launch/00-plan.md):
 *  · каждый исполнитель — `claude -p --agent <имя>` в СВОЕЙ рабочей копии (git worktree) на ветке gr/<id>;
 *  · слияние в gr/integration делает только этот скрипт, по очереди (--no-ff); исполнители не пушат;
 *  · состояние — .graphit-run/state.json (в .gitignore); повторный запуск продолжает, ничего не стирает
 *    и не создаёт дубликатов (существующие копии и ветки используются, готовое пропускается);
 *  · по зелёному FINAL.status.json (push_ready) — обычный `git push origin gr/integration:redesign` без --force.
 * Платежи, выкатка, PR, внешние публикации сюда не входят.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const MANIFEST = 'docs/graphit-launch/agents.json';
const STATUS_VALUES = ['done', 'partial', 'blocked'];
const EXIT = { OK: 0, FAIL: 1, PRE: 2, LIMIT: 75 };

/* ------------------------------------------------------------------ манифест */

export function loadManifest(root = ROOT, file = MANIFEST) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

/** Два пути пересекаются, если равны или один — папка (оканчивается на «/»), содержащая другой. */
export function pathsOverlap(a, b) {
  if (a === b) return true;
  if (a.endsWith('/') && b.startsWith(a)) return true;
  if (b.endsWith('/') && a.startsWith(b)) return true;
  return false;
}

/** Список проблем манифеста (пустой — всё в порядке). `exists` — проверка файла (в тестах подменяется). */
export function validateManifest(m, { exists = (p) => fs.existsSync(path.join(ROOT, p)) } = {}) {
  const bad = [];
  const ids = new Set();
  for (const a of m.agents || []) {
    if (!/^[a-z][a-z0-9-]*$/.test(a.id || '')) bad.push(`id «${a.id}» некорректен`);
    if (ids.has(a.id)) bad.push(`id «${a.id}» повторяется`);
    ids.add(a.id);
    for (const key of ['agent', 'phase', 'task']) if (!a[key]) bad.push(`${a.id}: нет поля ${key}`);
    if (a.task && !exists(a.task)) bad.push(`${a.id}: нет файла задания ${a.task}`);
    if (a.agent && !exists(`.claude/agents/${a.agent}.md`)) bad.push(`${a.id}: нет определения агента .claude/agents/${a.agent}.md`);
    if (!Array.isArray(a.deps)) bad.push(`${a.id}: deps — массив`);
    if (!Array.isArray(a.owns) || !a.owns.length) bad.push(`${a.id}: пустой owns`);
  }
  for (const a of m.agents || []) for (const d of a.deps || []) if (!ids.has(d)) bad.push(`${a.id}: зависимость «${d}» не найдена`);
  // цикл: алгоритм Кана
  const left = new Map((m.agents || []).map((a) => [a.id, new Set(a.deps || [])]));
  let moved = true;
  while (moved && left.size) {
    moved = false;
    for (const [id, deps] of [...left]) {
      if ([...deps].every((d) => !left.has(d))) { left.delete(id); moved = true; }
    }
  }
  if (left.size) bad.push(`цикл зависимостей: ${[...left.keys()].join(', ')}`);
  // зоны файлов не пересекаются
  const agents = m.agents || [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      for (const p of agents[i].owns || []) for (const q of agents[j].owns || []) {
        if (pathsOverlap(p, q)) bad.push(`зоны пересекаются: ${agents[i].id} «${p}» и ${agents[j].id} «${q}»`);
      }
    }
  }
  // заготовки передаются другому владельцу
  for (const a of agents) for (const s of a.stubs || []) {
    const owner = agents.find((o) => o.id !== a.id && (o.owns || []).some((p) => pathsOverlap(p, s)));
    if (!owner) bad.push(`${a.id}: заготовка ${s} не передана ни одному владельцу`);
  }
  // диапазоны номеров решений не пересекаются
  const ranges = agents.map((a) => [a.id, ...(a.decisions || [0, 0])]);
  for (let i = 0; i < ranges.length; i++) {
    const [id, lo, hi] = ranges[i];
    if (!(lo <= hi)) bad.push(`${id}: диапазон решений ${lo}–${hi} перевёрнут`);
    for (let j = i + 1; j < ranges.length; j++) {
      const [id2, lo2, hi2] = ranges[j];
      if (lo <= hi2 && lo2 <= hi) bad.push(`диапазоны решений пересекаются: ${id} и ${id2}`);
    }
  }
  const integrations = agents.filter((a) => a.phase === 'integration');
  if (integrations.length !== 1) bad.push('должен быть ровно один агент фазы integration');
  return bad;
}

/* ------------------------------------------------------------------ планирование */

/** Агент завершён «в хорошем смысле»: слит (полностью или частично). */
const MERGED = new Set(['merged', 'merged-partial']);
/** Агент больше ничего не изменит в этом запуске. */
export function isTerminal(a, maxAttempts = 3) {
  if (!a) return false;
  if (MERGED.has(a.status)) return true;
  if (a.status === 'blocked' || a.status === 'conflict') return true;
  // упал или оборван в ЭТОМ запуске: заново в этом же запуске не запускаем (повторная команда продолжит)
  if ((a.status === 'failed' || a.status === 'stopped') && (a.settled || (a.attempts || 0) >= maxAttempts)) return true;
  return false;
}

/** Какие агенты можно запустить сейчас (в порядке манифеста), с учётом занятых мест. */
export function nextRunnable(m, state, { maxParallel = 3, only = null, maxAttempts = 3 } = {}) {
  const st = (id) => state.agents[id] || { status: 'pending', attempts: 0 };
  const running = m.agents.filter((a) => st(a.id).status === 'running').length;
  let slots = Math.max(0, maxParallel - running);
  const out = [];
  for (const a of m.agents) {
    if (slots <= 0) break;
    if (only && !only.includes(a.id)) continue;
    const s = st(a.id);
    const startable = s.status === 'pending' || ((s.status === 'failed' || s.status === 'stopped') && !s.settled && (s.attempts || 0) < maxAttempts);
    if (!startable) continue;
    if (a.phase === 'integration') {
      // последняя фаза: все остальные должны закончить (хорошо или плохо)
      if (!m.agents.filter((o) => o.id !== a.id).every((o) => isTerminal(st(o.id), maxAttempts))) continue;
    } else if (!(a.deps || []).every((d) => MERGED.has(st(d).status))) continue;
    out.push(a.id);
    slots -= 1;
  }
  return out;
}

/** Порядок «волн» для --dry-run: кто стартует вместе при данном параллелизме (без учёта длительности). */
export function simulate(m, maxParallel = 3) {
  const state = { agents: {} };
  const waves = [];
  for (let guard = 0; guard < 50; guard++) {
    const ready = nextRunnable(m, state, { maxParallel });
    if (!ready.length) break;
    waves.push(ready);
    for (const id of ready) state.agents[id] = { status: 'merged' };
  }
  return waves;
}

/** Разбор статуса исполнителя. Возвращает { ok, status?, problems }. */
export function parseAgentStatus(text, id) {
  const problems = [];
  let j;
  try { j = JSON.parse(text); } catch { return { ok: false, problems: ['статус не JSON'] }; }
  if (j.id !== id) problems.push(`id в статусе «${j.id}», ожидался «${id}»`);
  const status = j.status ?? (j.ok === true ? 'done' : undefined);
  if (!STATUS_VALUES.includes(status)) problems.push(`status «${j.status}» не из ${STATUS_VALUES.join('|')}`);
  if (typeof j.summary !== 'string' || !j.summary.trim()) problems.push('нет summary');
  if (typeof j.at !== 'string' || Number.isNaN(Date.parse(j.at))) problems.push('нет поля at (время завершения, ISO)');
  return { ok: problems.length === 0, status, problems, raw: j };
}

/** Похоже ли на упор в лимит использования. */
export function looksLikeLimit(text) {
  return /usage limit|rate limit|limit reached|лимит использования|limit resets|try again at|quota/i.test(String(text || ''));
}

/* ------------------------------------------------------------------ git и процессы */

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const git = (cwd, ...args) => sh('git', args, { cwd });
const gitOut = (cwd, ...args) => (git(cwd, ...args).stdout || '').trim();
const ok = (r) => r.status === 0;
const now = () => new Date().toISOString();

/** Файл изменялся в коммитах после `base` (иначе это остаток прошлого запуска, а не ответ агента). */
export function changedSince(dir, base, relPath) {
  if (!base) return true;
  const n = gitOut(dir, 'rev-list', '--count', `${base}..HEAD`, '--', relPath);
  return Number(n) > 0;
}

function repoName() { return path.basename(ROOT); }
const worktreeDir = (id) => path.resolve(ROOT, '..', `${repoName()}-gr-${id}`);
const branchOf = (id) => `gr/${id}`;
const branchExists = (b) => ok(git(ROOT, 'show-ref', '--verify', '--quiet', `refs/heads/${b}`));

const RUN_DIR = path.join(ROOT, '.graphit-run');
const STATE_FILE = path.join(RUN_DIR, 'state.json');
const LOCK_FILE = path.join(RUN_DIR, 'lock');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { runId: null, agents: {} }; }
}
function writeState(state) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }


/* ------------------------------------------------------------------ сверка архива с рабочего стола */

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, base, out); else out.push(f);
  }
  return out;
}

/**
 * Если на рабочем столе лежат `graphit-collections.zip` и `README — копия.md`, сверяет их с `design/collections/`
 * (SHA-256). Только предупреждения: расхождение не останавливает запуск, но его видно в начале.
 */
export function compareDesktopPack(home = os.homedir(), repoDir = path.join(ROOT, 'design/collections')) {
  const out = [];
  const desk = path.join(home, 'Desktop');
  const zip = path.join(desk, 'graphit-collections.zip');
  const readme = path.join(desk, 'README — копия.md');
  const repoFiles = fs.existsSync(repoDir) ? walk(repoDir) : [];
  const byName = new Map(repoFiles.map((f) => [path.basename(f), f]));
  if (!fs.existsSync(zip)) out.push(`на рабочем столе нет graphit-collections.zip — сверка архива пропущена (в репозитории: design/collections, ${repoFiles.length} файлов)`);
  else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graphit-zip-'));
    const r = sh('unzip', ['-q', '-o', zip, '-d', tmp]);
    if (!ok(r)) out.push(`graphit-collections.zip не удалось распаковать (${(r.stderr || r.error?.message || '').trim().split('\n')[0]}) — сверка пропущена`);
    else {
      const files = walk(tmp).filter((f) => !f.includes('__MACOSX') && !path.basename(f).startsWith('._'));
      let same = 0; const diff = []; const extra = [];
      for (const f of files) {
        const name = path.basename(f);
        const mine = byName.get(name);
        if (!mine) { extra.push(name); continue; }
        if (sha(f) === sha(mine)) same += 1; else diff.push(name);
      }
      const missing = [...byName.keys()].filter((n) => !files.some((f) => path.basename(f) === n));
      out.push(`архив с рабочего стола: ${files.length} файлов; совпадают с репозиторием: ${same}; отличаются: ${diff.length ? diff.join(', ') : 'нет'}; только в архиве: ${extra.length ? extra.join(', ') : 'нет'}; только в репозитории: ${missing.length ? missing.join(', ') : 'нет'}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!fs.existsSync(readme)) out.push('на рабочем столе нет «README — копия.md» — сверка пропущена');
  else {
    const mine = path.join(repoDir, 'README.md');
    out.push(fs.existsSync(mine) && sha(readme) === sha(mine) ? '«README — копия.md» совпадает с design/collections/README.md' : '«README — копия.md» ОТЛИЧАЕТСЯ от design/collections/README.md (репозиторий не перезаписывался; сравните и скажите, какой верный)');
  }
  return out;
}

/* ------------------------------------------------------------------ проверки перед запуском */

export function preflight({ strict = true } = {}) {
  const errors = [];
  const notes = [];
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) errors.push(`Node ${process.versions.node}: нужен ≥ 22.5`);
  else notes.push(`Node ${process.versions.node}`);
  if (!ok(sh('git', ['--version']))) errors.push('git не найден');
  const claude = sh('claude', ['--version']);
  if (!ok(claude)) errors.push('claude (Claude Code) не найден в PATH');
  else {
    notes.push(`claude ${(claude.stdout || '').trim()}`);
    const help = (sh('claude', ['--help']).stdout || '');
    for (const flag of ['--agent', '--permission-mode', '--output-format', '--print']) {
      if (!help.includes(flag)) errors.push(`у вашего claude нет параметра ${flag} — обновите Claude Code`);
    }
  }
  if (!fs.existsSync(path.join(ROOT, MANIFEST))) { errors.push(`нет ${MANIFEST}`); return { errors, notes }; }
  const branch = gitOut(ROOT, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'redesign') errors.push(`текущая ветка «${branch}», нужна redesign (git checkout redesign)`);
  const dirty = gitOut(ROOT, 'status', '--porcelain').split('\n').filter((l) => l && !l.includes('.graphit-run'));
  if (dirty.length) errors.push(`в рабочей папке есть незакоммиченные изменения (не трогаю чужую работу):\n    ${dirty.slice(0, 8).join('\n    ')}`);
  if (strict) {
    const f = git(ROOT, 'fetch', 'origin', 'redesign');
    if (!ok(f)) errors.push(`не удалось обратиться к origin: ${(f.stderr || '').trim().split('\n')[0]}`);
    else {
      const local = gitOut(ROOT, 'rev-parse', 'HEAD');
      const remote = gitOut(ROOT, 'rev-parse', 'origin/redesign');
      if (local !== remote) {
        const behind = gitOut(ROOT, 'rev-list', '--count', 'HEAD..origin/redesign');
        const ahead = gitOut(ROOT, 'rev-list', '--count', 'origin/redesign..HEAD');
        errors.push(`redesign расходится с origin (позади ${behind}, впереди ${ahead}): сначала git pull origin redesign / запушьте свои коммиты`);
      } else notes.push(`redesign = origin/redesign (${local.slice(0, 7)})`);
    }
  }
  const m = loadManifest();
  for (const p of validateManifest(m)) errors.push(`манифест: ${p}`);
  try { for (const n of compareDesktopPack()) notes.push(n); } catch (e) { notes.push(`сверка архива с рабочего стола не удалась: ${e.message}`); }
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const l = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (alive(l.pid) && l.pid !== process.pid) errors.push(`уже запущен другой экземпляр (PID ${l.pid}, с ${l.startedAt}). Дождитесь его или закройте окно.`);
    } catch { /* битая блокировка — перезапишем */ }
  }
  return { errors, notes, manifest: m };
}

/* ------------------------------------------------------------------ рабочие копии */

function ensureNodeModules(dir) {
  if (process.env.GRAPHIT_SKIP_INSTALL === '1') return; // только для проверки самого запуска (тесты, имитация)
  if (fs.existsSync(path.join(dir, 'node_modules'))) return;
  log(`  npm install в ${path.basename(dir)}…`);
  const r = sh('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir });
  if (!ok(r)) throw new Error(`npm install не удался в ${dir}: ${(r.stderr || '').slice(0, 300)}`);
}

function ensureWorktree(id, baseRef) {
  const dir = worktreeDir(id);
  const branch = branchOf(id);
  if (fs.existsSync(dir)) {
    const cur = gitOut(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (cur !== branch) throw new Error(`папка ${dir} уже есть, но на ветке «${cur}», а не «${branch}» — разберитесь вручную (я её не трогаю)`);
  } else if (branchExists(branch)) {
    const r = git(ROOT, 'worktree', 'add', dir, branch);
    if (!ok(r)) throw new Error(`git worktree add: ${r.stderr}`);
  } else {
    const r = git(ROOT, 'worktree', 'add', '-b', branch, dir, baseRef);
    if (!ok(r)) throw new Error(`git worktree add -b: ${r.stderr}`);
  }
  ensureNodeModules(dir);
  return dir;
}

/* ------------------------------------------------------------------ запуск исполнителя */

function buildPrompt(a, dir, m, state) {
  const lines = [
    `Ты — исполнитель «${a.id}» пакета запуска коллекции «Графит» проекта TelegramBotPoker. Человека рядом нет: вопросов не задавай, обычные решения по интерфейсу принимай сам и записывай в отчёт.`,
    `Твоя рабочая копия: ${dir} (ветка ${branchOf(a.id)}). Сначала прочитай docs/graphit-launch/README.md, затем целиком своё задание ${a.task} и выполни его. Если в ветке уже есть твоя работа — продолжи, не переделывая.`,
    `Закончи только после того, как записаны отчёт и статус (docs/graphit-launch/reports/${a.id}.md и ${a.id}.status.json), всё закоммичено в твою ветку и git status чистый. Не пушь, не создавай PR, не выкатывай.`,
  ];
  if (a.phase === 'integration') {
    const lines2 = m.agents.filter((o) => o.id !== a.id).map((o) => {
      const s = state.agents[o.id] || {};
      return `- ${o.id}: ${s.status || 'pending'}${s.note ? ` (${s.note})` : ''}; ветка ${branchOf(o.id)}${MERGED.has(s.status) ? ', слита' : ', НЕ слита'}`;
    });
    lines.push('Состояние исполнителей на этот момент:', ...lines2);
    lines.push('Для веток со статусом conflict/blocked/partial: слей вручную (git merge --no-ff gr/<id>) там, где это безопасно, и опиши в FINAL.md. Итоговый статус пиши в docs/graphit-launch/reports/FINAL.status.json.');
  }
  return lines.join('\n');
}

/** Журналы по попыткам: старый текст (например, про лимит) не должен считаться ответом новой попытки. */
const logFiles = (id, attempt) => ({
  out: path.join(RUN_DIR, 'logs', `${id}.${attempt}.out.json`),
  err: path.join(RUN_DIR, 'logs', `${id}.${attempt}.err.log`),
});

function runAgent(a, dir, opts, m, state) {
  fs.mkdirSync(path.join(RUN_DIR, 'logs'), { recursive: true });
  const files = logFiles(a.id, state.agents[a.id].attempts);
  const out = fs.openSync(files.out, 'w');
  const err = fs.openSync(files.err, 'w');
  const args = ['-p', buildPrompt(a, dir, m, state), '--agent', a.agent, '--permission-mode', opts.permissionMode, '--output-format', 'json', '--name', `graphit-${a.id}`];
  if (opts.model) args.push('--model', opts.model);
  // Свой порт для браузерных проверок каждому: параллельные агенты не должны делить 8091–8198 (иначе «занятый порт»).
  const e2ePort = String(9100 + 40 * m.agents.findIndex((x) => x.id === a.id));
  const child = spawn('claude', args, { cwd: dir, stdio: ['ignore', out, err], env: { ...process.env, GRAPHIT_RUN: '1', E2E_PORT: e2ePort } });
  return child;
}

/* ------------------------------------------------------------------ слияние и публикация */

function mergeIntoIntegration(a, summary) {
  const int = worktreeDir('integration');
  const r = git(int, 'merge', '--no-ff', '-m', `Слияние ${branchOf(a.id)}: ${String(summary || a.id).slice(0, 120)}`, branchOf(a.id));
  if (ok(r)) return { ok: true };
  git(int, 'merge', '--abort');
  return { ok: false, error: `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(0, 4).join(' | ') };
}

function publish(opts, startHead) {
  const int = worktreeDir('integration');
  const fin = path.join(int, 'docs/graphit-launch/reports/FINAL.status.json');
  if (!fs.existsSync(fin)) return { pushed: false, why: 'нет FINAL.status.json' };
  let f;
  try { f = JSON.parse(fs.readFileSync(fin, 'utf8')); } catch { return { pushed: false, why: 'FINAL.status.json не читается' }; }
  if (!changedSince(int, startHead, 'docs/graphit-launch/reports/FINAL.status.json')) return { pushed: false, why: 'FINAL.status.json не обновлялся в этом запуске (остаток прошлого)' };
  if (!(f.ok === true && f.push_ready === true)) return { pushed: false, why: `итоговая проверка не зелёная (ok=${f.ok}, push_ready=${f.push_ready}): ${f.summary || ''}` };
  if (opts.noPush) return { pushed: false, why: 'указан --no-push' };
  if (gitOut(int, 'status', '--porcelain')) return { pushed: false, why: 'в gr/integration есть незакоммиченное' };
  git(int, 'fetch', 'origin', 'redesign');
  if (gitOut(int, 'rev-list', '--count', 'HEAD..origin/redesign') !== '0') {
    log('  origin/redesign ушёл вперёд — сливаю его в gr/integration и проверяю тесты ещё раз');
    const mr = git(int, 'merge', '--no-ff', '-m', 'Слияние origin/redesign в gr/integration перед публикацией', 'origin/redesign');
    if (!ok(mr)) { git(int, 'merge', '--abort'); return { pushed: false, why: 'конфликт при слиянии свежего origin/redesign — разберите вручную в ' + int }; }
    const t = sh('npm', ['test'], { cwd: int });
    if (!ok(t)) return { pushed: false, why: 'после слияния свежего origin/redesign npm test упал — публикация отменена' };
  }
  const p = git(int, 'push', 'origin', 'gr/integration:redesign');
  if (!ok(p)) return { pushed: false, why: `push отклонён: ${(p.stderr || '').trim().split('\n').pop()}` };
  return { pushed: true };
}

/* ------------------------------------------------------------------ вывод */

const T0 = Date.now();
function log(msg) { console.log(`[${String(Math.round((Date.now() - T0) / 1000)).padStart(5)}с] ${msg}`); }

function printTable(m, state) {
  const w = Math.max(...m.agents.map((a) => a.id.length));
  console.log('');
  console.log(`${'агент'.padEnd(w)}  ${'статус'.padEnd(14)} попыток  ветка / заметка`);
  for (const a of m.agents) {
    const s = state.agents[a.id] || { status: 'pending' };
    console.log(`${a.id.padEnd(w)}  ${String(s.status).padEnd(14)} ${String(s.attempts || 0).padEnd(7)}  ${branchOf(a.id)}${s.note ? ` — ${s.note}` : ''}`);
  }
  console.log('');
}

/* ------------------------------------------------------------------ главный ход */

function parseArgs(argv) {
  const o = { permissionMode: process.env.GRAPHIT_PERMISSION_MODE || 'auto', model: process.env.GRAPHIT_MODEL || null, timeoutMin: 240 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') o.dryRun = true;
    else if (x === '--status') o.status = true;
    else if (x === '--check') o.check = true;
    else if (x === '--no-push') o.noPush = true;
    else if (x === '--max-parallel') o.maxParallel = Number(argv[++i]);
    else if (x === '--only') o.only = String(argv[++i]).split(',').filter(Boolean);
    else if (x === '--model') o.model = argv[++i];
    else if (x === '--permission-mode') o.permissionMode = argv[++i];
    else if (x === '--agent-timeout-min') o.timeoutMin = Number(argv[++i]);
    else if (x === '-h' || x === '--help') o.help = true;
    else { console.error(`Неизвестный параметр: ${x}`); process.exit(EXIT.PRE); }
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*|^ \* ?/gm, '')); return EXIT.OK; }
  const m = loadManifest();
  const maxParallel = o.maxParallel || m.maxParallel || 3;
  const maxAttempts = m.maxAttempts || 3;

  if (o.check) {
    const bad = validateManifest(m);
    if (bad.length) { bad.forEach((b) => console.error(`✗ ${b}`)); return EXIT.PRE; }
    console.log(`✓ манифест в порядке: ${m.agents.length} агентов, волны: ${simulate(m, maxParallel).map((w) => `[${w.join(', ')}]`).join(' → ')}`);
    return EXIT.OK;
  }
  if (o.status) {
    printTable(m, readState());
    return EXIT.OK;
  }

  console.log('Пакет запуска «Графит»: проверки…');
  const pre = preflight({ strict: true });
  pre.notes.forEach((n) => console.log(`  ✓ ${n}`));
  pre.errors.forEach((e) => console.log(`  ✗ ${e}`));
  if (pre.errors.length && !o.dryRun) { console.log('\nЗапуск остановлен: исправьте то, что выше, и повторите команду.'); return EXIT.PRE; }

  const waves = simulate(m, maxParallel);
  console.log(`\nПлан (по зависимостям, не более ${maxParallel} одновременно): ${waves.map((w) => `[${w.join(', ')}]`).join(' → ')}`);
  console.log(`Режим прав агентов: ${o.permissionMode}${o.model ? `, модель ${o.model}` : ''}; публикация в redesign: ${o.noPush ? 'ВЫКЛ (--no-push)' : 'только при зелёном итоге'}`);
  if (o.dryRun) {
    console.log('\n--dry-run: ничего не создано и не запущено. Рабочие копии появятся рядом с проектом:');
    for (const a of m.agents) console.log(`  ${worktreeDir(a.id)}  (${branchOf(a.id)})`);
    console.log(`  ${worktreeDir('integration')}  (gr/integration)`);
    printTable(m, readState());
    if (pre.errors.length) { console.log('Проверки выше не прошли: реальный запуск остановился бы. Исправьте и повторите.'); return EXIT.PRE; }
    return EXIT.OK;
  }

  // блокировка и состояние
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: now() }));
  const state = readState();
  state.runId ||= now();
  state.agents ||= {};
  for (const a of m.agents) {
    const s = (state.agents[a.id] ||= { status: 'pending', attempts: 0 });
    if (s.status === 'running') { s.status = 'stopped'; s.note = 'прошлый запуск оборвался'; }
    s.settled = false;
  }
  // интеграция уже была, но потом слился ещё кто-то (исправили упавшего): итог устарел — повторить
  const integ0 = m.agents.find((a) => a.phase === 'integration');
  const si = state.agents[integ0.id];
  if (MERGED.has(si.status)) {
    const latest = Math.max(0, ...m.agents.filter((a) => a.id !== integ0.id).map((a) => Date.parse(state.agents[a.id].mergedAt || 0) || 0));
    if (latest > (Date.parse(si.mergedAt || 0) || 0)) {
      si.status = 'pending'; si.attempts = 0; si.note = 'повторная интеграция: после неё слились новые ветки'; si.mergedAt = null;
    }
  }
  writeState(state);

  // общая рабочая копия
  git(ROOT, 'fetch', 'origin', 'redesign');
  const intDir = worktreeDir('integration');
  try {
    if (fs.existsSync(intDir)) {
      const cur = gitOut(intDir, 'rev-parse', '--abbrev-ref', 'HEAD');
      if (cur !== 'gr/integration') throw new Error(`папка ${intDir} есть, но на ветке «${cur}»`);
    } else if (branchExists('gr/integration')) {
      const r = git(ROOT, 'worktree', 'add', intDir, 'gr/integration');
      if (!ok(r)) throw new Error(r.stderr);
    } else {
      const r = git(ROOT, 'worktree', 'add', '-b', 'gr/integration', intDir, 'origin/redesign');
      if (!ok(r)) throw new Error(r.stderr);
    }
  } catch (e) {
    console.error(`✗ рабочая копия интеграции: ${e.message}`);
    fs.rmSync(LOCK_FILE, { force: true });
    return EXIT.PRE;
  }
  ensureNodeModules(intDir);
  state.startHead ||= gitOut(intDir, 'rev-parse', 'HEAD');
  writeState(state);

  let limitHit = false;
  const running = new Map();
  let mergeChain = Promise.resolve();

  const cleanup = () => {
    for (const [, c] of running) { try { c.kill('SIGTERM'); } catch { /* уже закрыт */ } }
    for (const a of m.agents) if (state.agents[a.id].status === 'running') { state.agents[a.id].status = 'stopped'; state.agents[a.id].note = 'остановлен (прерывание)'; }
    writeState(state);
    fs.rmSync(LOCK_FILE, { force: true });
  };
  process.on('SIGINT', () => { console.log('\nПрерывание: останавливаю агентов; повторная команда продолжит.'); cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  const finish = (a, s, child, code, signal) => {
    running.delete(a.id);
    s.finishedAt = now();
    s.settled = true; // пока не слит: в этом запуске повторно не стартуем
    const dir = worktreeDir(a.id);
    const { out: outFile, err: errFile } = logFiles(a.id, s.attempts);
    const tail = (f) => { try { return fs.readFileSync(f, 'utf8').slice(-4000); } catch { return ''; } };
    const outTail = tail(outFile);
    const errTail = tail(errFile);
    if (looksLikeLimit(outTail) || looksLikeLimit(errTail)) {
      limitHit = true;
      s.status = 'stopped';
      s.note = 'упёрся в лимит использования — повторите команду позже';
      log(`✗ ${a.id}: ${s.note}`);
      return writeState(state);
    }
    const stFile = path.join(dir, `docs/graphit-launch/reports/${a.id}.status.json`);
    if (!fs.existsSync(stFile)) {
      s.status = code === 0 ? 'failed' : 'stopped';
      s.note = `нет ${a.id}.status.json (код ${code ?? signal})`;
      log(`✗ ${a.id}: ${s.note}`);
      return writeState(state);
    }
    if (!changedSince(dir, s.base, `docs/graphit-launch/reports/${a.id}.status.json`)) {
      s.status = code === 0 ? 'failed' : 'stopped';
      s.note = 'статус не обновлялся в этом запуске (остался от прошлого) — агент не закончил';
      log(`✗ ${a.id}: ${s.note}`);
      return writeState(state);
    }
    const parsed = parseAgentStatus(fs.readFileSync(stFile, 'utf8'), a.id);
    if (!parsed.ok) {
      s.status = 'failed'; s.note = `статус некорректен: ${parsed.problems.join('; ')}`;
      log(`✗ ${a.id}: ${s.note}`);
      return writeState(state);
    }
    const dirty = gitOut(dir, 'status', '--porcelain');
    if (dirty) {
      s.status = 'failed'; s.note = 'в ветке остались незакоммиченные изменения (повторный запуск продолжит)';
      log(`✗ ${a.id}: ${s.note}`);
      return writeState(state);
    }
    if (parsed.status === 'blocked') {
      s.status = 'blocked'; s.note = parsed.raw.summary;
      log(`■ ${a.id}: заблокирован — ${s.note}`);
      return writeState(state);
    }
    s.reported = parsed.status;
    // слияние — строго по очереди
    mergeChain = mergeChain.then(() => {
      const r = mergeIntoIntegration(a, parsed.raw.summary);
      if (r.ok) {
        s.status = parsed.status === 'done' ? 'merged' : 'merged-partial';
        s.settled = false;
        s.mergedAt = now();
        s.note = parsed.status === 'done' ? '' : `частично: ${parsed.raw.summary}`;
        log(`✓ ${a.id}: ${s.status} (${parsed.raw.summary})`);
        // слился кто-то после итоговой интеграции (например, исправили упавшего) — итог устарел, интеграцию повторим
        if (a.phase !== 'integration') {
          const si = state.agents[m.agents.find((x) => x.phase === 'integration').id];
          if (MERGED.has(si.status)) { si.status = 'pending'; si.attempts = 0; si.mergedAt = null; si.settled = false; si.note = 'повторная интеграция: слилась новая ветка'; log('  итоговая интеграция устарела — запущу заново'); }
        }
      } else {
        s.status = 'conflict'; s.note = `конфликт слияния: ${r.error}`;
        log(`✗ ${a.id}: ${s.note}`);
      }
      writeState(state);
    });
  };

  await new Promise((resolve) => {
    const tick = () => {
      if (limitHit && running.size === 0) return resolve();
      const ready = limitHit ? [] : nextRunnable(m, state, { maxParallel, only: o.only, maxAttempts });
      for (const id of ready) {
        const a = m.agents.find((x) => x.id === id);
        const s = state.agents[id];
        let dir;
        try {
          // ветка создаётся от gr/integration В МОМЕНТ старта: зависимые получают результат предыдущих
          dir = ensureWorktree(id, 'gr/integration');
        } catch (e) {
          s.status = 'failed'; s.settled = true; s.attempts = (s.attempts || 0) + 1; s.note = e.message; log(`✗ ${id}: ${e.message}`); writeState(state);
          continue;
        }
        s.base ||= gitOut(dir, 'rev-parse', 'HEAD'); // с этого коммита ветка «чиста»: статус старше — не наш
        if (a.phase === 'integration' && s.attempts > 0 && gitOut(dir, 'rev-list', '--count', 'HEAD..gr/integration') !== '0') {
          // повторная интеграция: сначала подтянуть то, что слилось после прошлой попытки
          const mg = git(dir, 'merge', '--no-edit', 'gr/integration');
          if (!ok(mg)) { git(dir, 'merge', '--abort'); s.status = 'failed'; s.settled = true; s.note = 'не удалось подтянуть gr/integration в ветку интеграции — слейте вручную'; log(`✗ ${id}: ${s.note}`); writeState(state); continue; }
        }
        s.status = 'running'; s.attempts = (s.attempts || 0) + 1; s.startedAt = now(); s.note = '';
        writeState(state);
        log(`▶ ${id} (попытка ${s.attempts}) — ${a.agent}, ветка ${branchOf(id)}`);
        const child = runAgent(a, dir, o, m, state);
        s.pid = child.pid;
        running.set(id, child);
        const timer = o.timeoutMin ? setTimeout(() => { s.note = `превышено ${o.timeoutMin} мин`; child.kill('SIGTERM'); }, o.timeoutMin * 60_000) : null;
        child.on('close', (code, signal) => { if (timer) clearTimeout(timer); finish(a, s, child, code, signal); mergeChain.then(() => { writeState(state); tick(); }); });
        child.on('error', (e) => { running.delete(id); s.settled = true; s.status = 'failed'; s.note = `не удалось запустить claude: ${e.message}`; writeState(state); tick(); });
      }
      if (running.size === 0) {
        // ничего не запущено: если запускать больше нечего — конец, иначе (агент не стартовал) пробуем снова
        if (limitHit || !nextRunnable(m, state, { maxParallel, only: o.only, maxAttempts }).length) mergeChain.then(() => resolve());
        else setImmediate(tick);
      }
    };
    tick();
  });

  await mergeChain;
  printTable(m, state);

  // публикация
  const integ = state.agents['lead-integration'];
  let exit = EXIT.OK;
  if (limitHit) {
    console.log('Остановка из-за лимита использования Claude. Состояние сохранено; повторите ту же команду, когда лимит сбросится.');
    exit = EXIT.LIMIT;
  } else if (integ && MERGED.has(integ.status)) {
    const p = publish(o, state.startHead);
    if (p.pushed) { console.log('✓ Итог зелёный и опубликован: git push origin gr/integration:redesign. Обновите свою папку: git pull origin redesign'); }
    else { console.log(`Публикация в redesign не выполнена: ${p.why}. Результат лежит в ветке gr/integration (${intDir}).`); exit = p.why === 'указан --no-push' ? EXIT.OK : EXIT.FAIL; }
    console.log(`Итоговый отчёт: ${path.join(intDir, 'docs/graphit-launch/reports/FINAL.md')}`);
  } else {
    console.log('Не всё выполнено: смотрите таблицу выше и журналы .graphit-run/logs/<агент>.<попытка>.* Повторная команда продолжит с места остановки.');
    exit = EXIT.FAIL;
  }
  fs.rmSync(LOCK_FILE, { force: true });
  return exit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); try { fs.rmSync(LOCK_FILE, { force: true }); } catch { /* ok */ } process.exit(EXIT.FAIL); });
}
void os;
