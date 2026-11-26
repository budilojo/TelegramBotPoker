/**
 * Автоскан вёрстки: что выезжает, обрезано, налезает и плохо нажимается.
 *
 *   npm run ui:scan                       все экраны × 320, 360, 390, 430 px × обычные и длинные имена
 *   node tools/ui-scan.mjs --widths=320   одна ширина
 *   node tools/ui-scan.mjs --names=long   только длинные имена
 *   node tools/ui-scan.mjs --only=shop    только сцены, чьё имя подходит под выражение
 *   node tools/ui-scan.mjs --teeth        «на зубы»: нарочно сломать вёрстку и убедиться, что скан это видит
 *
 * Сцены — те же, что у `npm run preview` (настоящий сервер, Telegram — заглушка, токен одноразовый),
 * плюс добавочные из tools/lib/ui-scan-hook.mjs. Правила — tools/lib/ui-scan-rules.mjs.
 * Выход: preview/scan/report.json (экран, ширина, селектор, координаты, снимок), снимки рядом,
 * `*.marked.png` — с рамками вокруг находок. Код 1 — есть неотсеянные находки серьёзнее косметики.
 *
 * Это не замена глазам: снимки проблемных мест надо смотреть, а в живом Telegram — проверять руками.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const HEIGHTS = { 320: 568, 360: 640, 390: 844, 430: 932 };
const OUT = path.resolve(arg('out') || path.join(ROOT, 'preview', 'scan'));
const BASE_PORT = Number(process.env.UI_SCAN_PORT || 8310);

/** Один прогон preview.mjs: одна ширина и один набор имён. */
function run({ width, names, only, dir, port, brk }) {
  return new Promise((resolve, reject) => {
    fs.rmSync(dir, { recursive: true, force: true });
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'tools', 'preview.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env, DRAFT_GAMES: '1', PREVIEW_W: String(width), PREVIEW_H: String(HEIGHTS[width] || 800), PREVIEW_PORT: String(port),
        PREVIEW_HOOK: path.join(ROOT, 'tools', 'lib', 'ui-scan-hook.mjs'), PREVIEW_OUT: dir,
        UI_SCAN_NAMES: names, UI_SCAN_ONLY: only || '', UI_SCAN_BREAK: brk || '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    child.on('close', (code) => {
      const file = path.join(dir, 'scan.json');
      if (code !== 0 || !fs.existsSync(file)) return reject(new Error(`скан ${width}px/${names} упал (код ${code}):\n${log.slice(-3000)}`));
      resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
    });
  });
}

const serious = (f) => !f.allowed && f.severity !== 'minor';

async function scan() {
  const widths = (arg('widths') || '320,360,390,430').split(',').map(Number);
  const names = (arg('names') || 'normal,long').split(',');
  const jobs = widths.flatMap((width) => names.map((n) => ({ width, names: n, only: arg('only'), dir: path.join(OUT, `${width}-${n}`) })));
  const parallel = Number(arg('jobs')) || 3;
  const all = [];
  let next = 0;
  await Promise.all(Array.from({ length: parallel }, async (_, slot) => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const t0 = Date.now();
      const r = await run({ ...job, port: BASE_PORT + slot });
      all.push({ ...job, ...r });
      console.log(`  ${job.width}px · ${job.names}: ${r.results.length} экранов, ${r.errors.length} не открылось — ${Math.round((Date.now() - t0) / 1000)} с`);
    }
  }));
  all.sort((a, b) => a.width - b.width || a.names.localeCompare(b.names));

  // Свод: одна находка на (экран, тип, селектор) со списком ширин.
  const merged = new Map();
  const screens = new Map();
  let allowed = 0;
  for (const job of all) {
    for (const r of job.results) {
      const row = screens.get(r.scene) || screens.set(r.scene, {}).get(r.scene);
      row[job.width] ||= { major: 0, minor: 0 };
      for (const f of r.findings) {
        if (f.allowed) { allowed++; continue; }
        row[job.width][f.severity === 'minor' ? 'minor' : 'major']++;
        const key = `${r.scene}|${f.type}|${f.sel}`;
        const m = merged.get(key) || merged.set(key, { scene: r.scene, type: f.type, severity: f.severity, sel: f.sel, text: f.text, at: [] }).get(key);
        m.at.push({ width: job.width, names: job.names, rect: f.rect, detail: f.detail, shot: path.relative(OUT, path.join(job.dir, r.marked || r.shot)) });
      }
    }
  }
  const findings = [...merged.values()];
  const errors = all.flatMap((j) => j.errors.map((e) => ({ ...e, names: j.names, width: j.width })));
  const junk = [...new Set(all.flatMap((j) => j.junk))];
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ widths, names, screens: Object.fromEntries(screens), findings, errors, junk, allowed }, null, 1));

  console.log(`\nэкран × ширина: серьёзных/косметических находок (${widths.join(' · ')} px)`);
  for (const [scene, row] of [...screens].sort()) {
    const cells = widths.map((w) => (row[w] ? `${row[w].major}/${row[w].minor}` : '—'));
    if (cells.some((c) => c !== '0/0' && c !== '—')) console.log(`  ${scene.padEnd(34)} ${cells.map((c) => c.padStart(6)).join('')}`);
  }
  const byType = {};
  for (const f of findings) byType[f.type] = (byType[f.type] || 0) + 1;
  console.log(`\nэкранов: ${screens.size} · отсеяно правилами: ${allowed} · находки по видам: ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ') || 'нет'}`);
  for (const e of errors) console.log(`НЕ ОТКРЫЛСЯ ${e.width}px/${e.names} ${e.scene}: ${e.error}`);
  for (const j of junk) console.log(`ОШИБКА/МУСОР ${j}`);
  console.log(`отчёт: ${path.relative(ROOT, path.join(OUT, 'report.json'))}`);
  const bad = findings.filter(serious).length + errors.length + junk.length;
  console.log(bad ? `КРАСНО: ${findings.filter(serious).length} серьёзных находок, ${errors.length} экранов не открылось, ${junk.length} ошибок` : 'зелено');
  process.exit(bad ? 1 : 0);
}

/** Поломки для «на зубы»: каждая обязана дать новую находку своего вида на своей сцене. */
const BREAKS = [
  { what: 'длинное имя без переноса', only: '^x06а-', css: '.seat .nm, .seat .plate, .seat .info { white-space: nowrap !important; max-width: none !important; width: max-content !important; overflow: visible !important; text-overflow: clip !important; }', types: ['offscreen', 'out-of-box', 'text-overlap', 'hscroll-page', 'covered-text'] },
  { what: 'блок шире экрана', only: '^x03-', css: '.set-block { width: 600px !important; max-width: none !important; }', types: ['offscreen', 'hscroll-box', 'hscroll-page'] },
  { what: 'кнопки профиля по 20 px', only: '^x03-', css: '.pf button { height: 20px !important; min-height: 0 !important; padding: 0 !important; }', types: ['small-target'] },
  { what: 'обрезанный заголовок', only: '^x03-', css: '.hub-head h1 { width: 40px !important; overflow: hidden !important; white-space: nowrap !important; }', types: ['clipped'] },
  { what: 'панель поверх действий', only: '^x03-', css: '.nav { position: fixed !important; inset: 0 !important; height: auto !important; background: #000 !important; z-index: 999 !important; }', types: ['covered-action', 'covered-text'] },
  { what: 'кнопка чата поверх игры', only: '^x07-chat$|^x08-', css: '.chat-fab { position: fixed !important; left: 0 !important; top: 0 !important; right: auto !important; bottom: auto !important; width: 320px !important; height: 568px !important; }', types: ['under-fab', 'covered-action', 'covered-text'] },
  { what: 'название раздавлено соседом', only: '^x02-', css: '.lrow button { min-width: 230px !important; }', types: ['crushed'] },
];

async function teeth() {
  const width = 320;
  let bad = 0;
  const key = (f) => `${f.type}|${f.sel}`;
  for (const [i, b] of BREAKS.entries()) {
    const base = await run({ width, names: 'long', only: b.only, dir: path.join(OUT, `teeth-${i}-base`), port: BASE_PORT });
    const broken = await run({ width, names: 'long', only: b.only, dir: path.join(OUT, `teeth-${i}-broken`), port: BASE_PORT, brk: b.css });
    const before = new Set(base.results.flatMap((r) => r.findings.filter((f) => !f.allowed).map(key)));
    const fresh = broken.results.flatMap((r) => r.findings).filter((f) => !f.allowed && !before.has(key(f)) && b.types.includes(f.type));
    const ok = base.results.length > 0 && fresh.length > 0;
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} ${b.what}: новых находок ${fresh.length}${fresh[0] ? ` (${fresh[0].type}: ${fresh[0].sel})` : ''}`);
  }
  console.log(bad ? `КРАСНО: не замечено поломок ${bad}` : 'зелено: все поломки замечены');
  process.exit(bad ? 1 : 0);
}

fs.mkdirSync(OUT, { recursive: true });
await (process.argv.includes('--teeth') ? teeth() : scan());
