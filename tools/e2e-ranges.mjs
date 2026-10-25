/**
 * Матрица 13×13 настоящим браузером (агент W): тап, рисование мышью и
 * касанием (с лупой), строка/столбец, наборы, отмена/повтор, «Крупно» (клетка
 * 44 px), клавиатура, разбор (diff: пропущено/лишнее), режим heat,
 * отсутствие горизонтальной прокрутки страницы и «прыжков» прокрутки при
 * нажатиях. 320 и 390 px.
 *
 *   node tools/e2e-ranges.mjs
 *   SHOTS=1 node tools/e2e-ranges.mjs   ещё и снимки в preview/ranges/
 *
 * Страница-стенд отдаётся самим скриптом (в приложение она не входит).
 * Это Chromium с эмуляцией касаний, а НЕ iOS/Android WebView и не живой
 * Telegram: попадание пальцем в 20-пиксельную клетку так не проверить.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINI = path.join(ROOT, 'miniapp');
const PORT = Number(process.env.E2E_PORT || 8099);
const SHOTS = process.env.SHOTS === '1';
const OUT = path.join(ROOT, 'preview', 'ranges');
if (SHOTS) fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/ranges.css">
<style>body{margin:0;background:var(--bg-main);color:var(--text-primary);font-family:var(--k-font)} #app{padding:16px} .pad{height:900px}</style></head>
<body><div id="app"></div><div class="pad"></div>
<script type="module">
import * as W from '/train/widgets/range-grid.js';
window.__W = W;
window.__log = [];
window.__mount = (props) => {
  const app = document.getElementById('app'); app.replaceChildren();
  const el = W.mount({ ...props, onChange: (v) => window.__log.push(JSON.stringify(v)) });
  app.appendChild(el); window.__el = el; return true;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/__sandbox') { res.writeHead(200, { 'content-type': TYPES['.html'] }); res.end(PAGE); return; }
  const f = path.join(MINI, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(MINI) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end('no'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const problems = [];
const step = (s) => console.log(`· ${s}`);
const browser = await chromium.launch();

async function scrollProbe() {
  try { return await import('./lib/scroll-probe.mjs'); } catch { return null; }
}
const probe = await scrollProbe();

/** Выполнить действие и проверить, что страница не подпрыгнула (позиция прокрутки та же). */
async function noJump(page, what, action) {
  if (probe?.assertNoJump) return probe.assertNoJump(page, {}, action);
  const before = await page.evaluate(() => window.scrollY);
  await action();
  await page.waitForTimeout(60);
  const after = await page.evaluate(() => window.scrollY);
  assert.equal(after, before, `страница подпрыгнула при: ${what} (${before} → ${after})`);
}

async function run(width, height, touch) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: touch, isMobile: touch });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${width}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${width}: ${m.text()}`); });
  await page.goto(`http://localhost:${PORT}/__sandbox`);
  await page.waitForFunction(() => window.__ready);
  const mount = (props) => page.evaluate((p) => window.__mount(p), props);
  const cls = (code) => page.$eval(`[data-h="${code}"]`, (e) => e.className);
  const count = () => page.$eval('.rg-count', (e) => e.textContent);
  const box = async (code) => (await page.$(`[data-h="${code}"]`)).boundingBox();
  const tag = `${width}px${touch ? ' touch' : ''}`;

  /* --- разметка --- */
  await mount({ setup: { grid: { text: true } } });
  const cells = await page.$$eval('.rg-c', (a) => a.length);
  assert.equal(cells, 169, 'должно быть 169 клеток');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `${tag}: страница шире экрана на ${overflow}px`);
  const b0 = await box('AA');
  step(`${tag}: клетка ${b0.width.toFixed(1)}×${b0.height.toFixed(1)} px (нужно 44 — для этого режим «Крупно»)`);
  assert.ok(b0.width >= 18, 'клетка слишком мала');
  if (SHOTS) await page.screenshot({ path: path.join(OUT, `edit-empty-${width}.png`) });

  /* --- тап --- */
  await noJump(page, 'тап по клетке', async () => { await page.click('[data-h="AKs"]'); });
  assert.match(await cls('AKs'), /\bf1\b/, 'AKs выбрана');
  assert.match(await count(), /0,3 % · 4 комбо/);
  await page.click('[data-h="AKs"]');
  assert.doesNotMatch(await cls('AKs'), /\bf\b/, 'AKs снята');

  /* --- набор, отмена, повтор --- */
  await noJump(page, 'набор «Пары»', async () => { await page.click('[data-preset="pairs"]'); });
  assert.match(await count(), /5,9 % · 78 комбо/);
  await noJump(page, 'отмена', async () => { await page.click('button[aria-label="Отменить"]'); });
  assert.match(await count(), /0 % · 0 комбо/);
  await page.click('button[aria-label="Повторить"]');
  assert.match(await count(), /78 комбо/);
  await page.click('[data-preset="aces"]');
  assert.match(await count(), /комбо/);
  await page.click('[data-preset="clear"]');
  assert.match(await count(), /0 % · 0 комбо/);

  /* --- строка и столбец --- */
  await noJump(page, 'тап по букве ряда', async () => { await page.click('[data-row="0"]'); });
  assert.doesNotMatch(await cls('AKo'), /\bf\b/, 'ряд A — это AA и одномастные; разномастные — в столбце');
  assert.match(await cls('AA'), /\bf1\b/);
  assert.match(await cls('AKs'), /\bf1\b/);
  await page.click('[data-col="0"]');
  assert.match(await cls('AKo'), /\bf1\b/);
  await page.click('[data-preset="clear"]');
  assert.doesNotMatch(await cls('AKs'), /\bf\b/);

  /* --- ввод строкой --- */
  await page.fill('.rg-text input', '77+, ATs+, KQo');
  await page.click('.rg-text button');
  assert.match(await cls('ATs'), /\bf1\b/);
  assert.match(await cls('KQo'), /\bf1\b/);
  assert.equal(await page.$eval('.rg-err', (e) => e.textContent), '');
  await page.fill('.rg-text input', 'ZZ');
  await page.click('.rg-text button');
  assert.match(await page.$eval('.rg-err', (e) => e.textContent), /Не понимаю/);
  await page.click('[data-preset="clear"]');

  /* --- рисование мышью --- */
  if (!touch) {
    const a = await box('AA');
    const k = await box('KK');
    const q = await box('QQ');
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2, { steps: 4 });
    await page.mouse.move(q.x + q.width / 2, q.y + q.height / 2, { steps: 4 });
    await page.mouse.up();
    for (const c of ['AA', 'KK', 'QQ']) assert.match(await cls(c), /\bf1\b/, `мазок: ${c}`);
    assert.doesNotMatch(await cls('JJ'), /\bf\b/);
    await page.click('button[aria-label="Отменить"]');
    assert.doesNotMatch(await cls('KK'), /\bf\b/, 'мазок отменяется целиком одним шагом');
  }

  /* --- рисование касанием: лупа --- */
  if (touch) {
    await page.click('button[aria-label="Режим рисования протяжкой"]');
    const cdp = await ctx.newCDPSession(page);
    const a = await box('AA');
    const q = await box('QQ');
    const pt = (bb) => [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(a) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(await box('KK')) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(q) });
    const loupeVisible = await page.$eval('.rg-loupe', (e) => !e.hidden);
    assert.ok(loupeVisible, 'лупа видна, пока палец на матрице');
    if (SHOTS) await page.screenshot({ path: path.join(OUT, `loupe-${width}.png`) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    for (const c of ['AA', 'KK', 'QQ']) assert.match(await cls(c), /\bf1\b/, `касание: ${c}`);
    assert.ok(await page.$eval('.rg-loupe', (e) => e.hidden), 'лупа скрыта после отпускания');
    await page.click('button[aria-label="Режим рисования протяжкой"]');
    await page.click('[data-preset="clear"]');
    // тап пальцем вне режима рисования
    await page.touchscreen.tap(...Object.values({ x: (await box('T9s')).x + 5, y: (await box('T9s')).y + 5 }));
    assert.match(await cls('T9s'), /\bf1\b/, 'тап пальцем');
    await page.click('[data-preset="clear"]');
  }

  /* --- «Крупно»: клетка 44 px, прокрутка внутри матрицы --- */
  await noJump(page, 'режим «Крупно»', async () => { await page.click('button[aria-label="Увеличить матрицу"]'); });
  const z = await box('AA');
  assert.ok(Math.abs(z.width - 44) <= 1 && Math.abs(z.height - 44) <= 1, `${tag}: в «Крупно» клетка ${z.width}×${z.height}`);
  assert.ok(await page.$eval('.rg-wrap', (w) => w.scrollWidth > w.clientWidth), 'прокрутка внутри матрицы');
  assert.equal(await page.$eval('[data-h="AKs"] .rg-sfx', (e) => getComputedStyle(e).display !== 'none'), true, 'в «Крупно» видна масть');
  const ov2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(ov2 <= 0, `${tag}: «Крупно» растянуло страницу на ${ov2}px`);
  if (SHOTS) await page.screenshot({ path: path.join(OUT, `zoom-${width}.png`) });
  await page.click('button[aria-label="Увеличить матрицу"]');

  /* --- клавиатура --- */
  await page.click('[data-h="AA"]'); // фокус клавиатуры встаёт на последнюю нажатую клетку
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  assert.match(await cls('AKs'), /\bf1\b/, 'пробел выбирает клетку под фокусом');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  assert.match(await cls('AKo'), /\bf1\b/);
  await page.click('[data-preset="clear"]');

  /* --- три степени: «иногда» --- */
  await mount({ setup: { grid: { steps: 3 } } });
  await page.click('[data-h="AQs"]');
  await page.click('[data-h="AQs"]');
  assert.match(await cls('AQs'), /\bfh\b/, 'второй тап — «иногда»');
  assert.equal(await page.$eval('[data-h="AQs"]', (e) => e.style.getPropertyValue('--f')), '0.5');
  if (SHOTS) await page.screenshot({ path: path.join(OUT, `edit-steps3-${width}.png`) });

  /* --- разбор: diff --- */
  await mount({ setup: { grid: { mode: 'edit' } }, value: ['AA', 'KK', '72o'], result: { solution: ['AA', 'KK', 'QQ', 'AKs'] } });
  assert.match(await cls('AA'), /\bhit\b/);
  assert.match(await cls('QQ'), /\bmissed\b/);
  assert.match(await cls('AKs'), /\bmissed\b/);
  assert.match(await cls('72o'), /\bextra\b/);
  assert.ok((await page.$$eval('.rg-legend span', (a) => a.length)) >= 3, 'легенда разбора');
  const clicksBefore = await page.evaluate(() => window.__log.length);
  await page.click('[data-h="JJ"]');
  assert.equal(await page.evaluate(() => window.__log.length), clicksBefore, 'в разборе нажатия не меняют ответ');
  if (SHOTS) await page.screenshot({ path: path.join(OUT, `diff-${width}.png`) });

  /* --- heat: частоты полосой --- */
  await mount({ setup: { grid: { mode: 'heat', ref: { AA: 1, KK: 1, AKs: 0.5, QJs: 0.25 } } } });
  assert.equal(await page.$eval('[data-h="AKs"]', (e) => e.style.getPropertyValue('--f')), '0.5');
  assert.equal(await page.$eval('[data-h="QJs"]', (e) => e.style.getPropertyValue('--f')), '0.25');
  if (SHOTS) await page.screenshot({ path: path.join(OUT, `heat-${width}.png`) });

  /* --- «найди ошибку» --- */
  await mount({ setup: { grid: { mode: 'flag', ref: ['AA', 'KK', '72o', 'QQ'] } } });
  await page.click('[data-h="72o"]');
  assert.match(await cls('72o'), /\boff\b/, 'отмеченная клетка заметна формой');
  assert.match(await count(), /Отмечено клеток: 1/);

  /* --- правка на месте: клетки не пересоздаются --- */
  await mount({ setup: { grid: {} } });
  await page.evaluate(() => { window.__cellRef = document.querySelector('[data-h="T9s"]'); });
  await page.click('[data-h="T9s"]');
  await page.click('[data-preset="pairs"]');
  assert.ok(await page.evaluate(() => window.__cellRef === document.querySelector('[data-h="T9s"]')), 'DOM матрицы не пересобирается');

  await ctx.close();
}

try {
  await run(320, 640, false);
  await run(390, 740, false);
  await run(320, 640, true);
  await run(390, 740, true);
} finally {
  await browser.close();
  server.close();
}
const real = problems.filter((p) => !/404/.test(p));
if (real.length) { console.error('\nПроблемы в консоли браузера:\n' + real.join('\n')); process.exit(1); }
console.log('\nматрица 13×13 в браузере: всё в порядке (Chromium; не WebView и не живой Telegram)');
