/**
 * Определение уровня и связка «ошибка → урок → то же задание» настоящим браузером
 * (агент Y). Экраны Тренировки (V) и Обучения (U) могут быть ещё не подключены к
 * приложению, поэтому страница-стенд собирается здесь: те же модули
 * `miniapp/train/placement.js`, `link.js`, `engine.js` и упражнения из `content/`,
 * а сервер заменён заглушкой запроса. Это Chromium с эмуляцией телефона —
 * не Telegram и не WebView.
 *
 *   node tools/e2e-placement.mjs          SHOTS=1 — ещё и снимки в preview/placement/
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINI = path.join(ROOT, 'miniapp');
const SHOTS = process.env.SHOTS === '1';
const OUT = path.join(ROOT, 'preview', 'placement');
if (SHOTS) fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const HARNESS = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/style.css">
<style>html,body{margin:0;height:100%}#app{min-height:100%}</style></head><body><div id="app"></div>
<script type="module">
import './train/content/index.js';
import * as E from './train/engine.js';
import { showPlacement } from './train/placement.js';
import * as L from './train/link.js';
import { h } from './ui.js';
const root = document.getElementById('app');
window.sent = [];
// Журнал: пока пуст — «по истории» должна быть серой.
const history = { available: false, total: 3, need: 37, summary: 'Пока мало решений (3 из 40): сыграйте ещё 37 или пройдите диагностику.', skills: {}, mistakes: [] };
const request = async (msg) => { window.sent.push(msg); if (msg.op === 'history') return { history: window.history_ }; return { progress: { ok: true } }; };
window.history_ = history;
window.done = null;
window.startPlacement = () => showPlacement(root, { request, bank: E, onDone: (p) => { window.done = p; root.replaceChildren(h('div', { id: 'after' }, 'готово')); } });

// связка: упражнение → ошибка → «Изучить тему» → урок → «Вернуться к заданию»
const screen = (...k) => root.replaceChildren(h('div', { style: { padding: '16px' } }, ...k));
function open(id, s, opts = {}) {
  const { task } = E.instantiate(id, s);
  const learnBtn = (r) => {
    const m = r.mistakes[0];
    const a = m && L.topicAction(m.topic, { exercise: id, seed: s, title: m.topic });
    return a ? h('button.k-btn.k-btn--primary', { id: 'learn', type: 'button', onclick: () => a.run() }, a.label) : null;
  };
  const rep = h('div', { id: 'repeat' }, opts.repeat ? 'повтор' : '');
  const boxes = task.setup.options.map((o) => h('button.k-btn.k-btn--secondary', { type: 'button', 'data-opt': o.id, onclick: () => {
    const r = task.check(o.id);
    screen(h('div', { id: 'prompt' }, task.prompt), h('div', { id: 'verdict' }, r.ok ? 'верно' : 'неверно'), rep, learnBtn(r));
  } }, o.label));
  screen(h('div', { id: 'prompt' }, task.prompt), ...boxes, rep);
  window.lastOpened = { id, s };
}
window.setupLink = () => L.setRouter({
  lesson: (topic, o) => screen(h('div', { id: 'lesson' }, 'Урок: ' + topic), o.returnTo ? h('button.k-btn.k-btn--primary', { id: 'back', type: 'button', onclick: () => L.returnToTask() }, 'Вернуться к заданию') : null),
  exercise: (id, s, o) => open(id, s, o),
  home: () => screen(h('div', { id: 'home' }, 'Домой')),
});
window.startLink = (id, s) => { window.setupLink(); open(id, s); };
window.resumeLink = () => { window.setupLink(); return L.returnToTask(); };
window.wrongOption = (id, s) => { const { task } = E.instantiate(id, s); return task.setup.options.find((o) => o.id !== task.solution).id; };
window.ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x').pathname;
  if (u === '/__harness') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(HARNESS); }
  const file = path.join(MINI, u);
  if (!file.startsWith(MINI) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('no'); }
  const ext = path.extname(file);
  res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[ext] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const step = (s) => console.log(`· ${s}`);
const problems = [];

for (const width of [320, 390]) {
  const ctx = await browser.newContext({ viewport: { width, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${width}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) problems.push(`${width}: ${m.text()}`); });
  await page.goto(`${base}/__harness`);
  await page.waitForFunction(() => window.ready);
  const shot = (n) => SHOTS && page.screenshot({ path: path.join(OUT, `${n}-${width}.png`) });
  const noHScroll = async (what) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${what}: горизонтальный скролл на ${width}px`);
  const small = async (what) => {
    const bad = await page.evaluate(() => [...document.querySelectorAll('.pl button, .pl [role=button]')].filter((b) => b.offsetParent && (b.getBoundingClientRect().height < 43.5 || b.getBoundingClientRect().width < 43.5)).map((b) => b.textContent.trim()));
    assert.deepEqual(bad, [], `${what}: кнопки меньше 44px на ${width}px`);
  };

  step(`${width}px · три карточки, «по истории» серая с объяснением`);
  await page.evaluate(() => window.startPlacement());
  await page.waitForSelector('[data-pl=history] .pl-card-n:not(:text("Проверяем"))');
  assert.equal(await page.locator('.pl-card').count(), 3);
  assert.equal(await page.locator('[data-pl=history]').getAttribute('aria-disabled'), 'true');
  assert.match(await page.locator('[data-pl=history]').innerText(), /Пока мало решений/);
  await page.click('[data-pl=history]', { force: true });
  assert.equal(await page.locator('.pl-card').count(), 3, 'серая карточка не открывает ничего');
  await shot('1-cards'); await noHScroll('карточки'); await small('карточки');

  step(`${width}px · «Начать с нуля» сохраняет все навыки на 1`);
  await page.click('[data-pl=zero]');
  await page.waitForSelector('#after');
  const zero = await page.evaluate(() => window.sent.at(-1));
  assert.deepEqual(zero, { t: 'train', op: 'placement', via: 'zero', skills: { preflop: 1, ranges: 1, math: 1, postflop: 1 } });

  step(`${width}px · диагностика: задания, «Не знаю», итог, ручная правка`);
  await page.evaluate(() => window.startPlacement());
  await page.click('[data-pl=quiz]');
  let n = 0;
  while (await page.locator('.pl-prompt').count()) {
    n++;
    assert.ok(n <= 12, 'не больше 12 заданий');
    if (n === 1) { await shot('2-quiz'); await noHScroll('задание'); await small('задание'); }
    // чередуем: верный ответ узнать нельзя, поэтому просто выбираем первый вариант, на 3-м «Не знаю»
    if (n === 3 || !(await page.locator('.pl-opt').count())) await page.click('.pl-skip');
    else await page.locator('.pl-opt').first().click();
  }
  assert.ok(n >= 1, 'хотя бы одно задание');
  await page.waitForSelector('.pl-rows');
  await shot('3-result'); await noHScroll('итог'); await small('итог');
  assert.equal(await page.locator('.pl-row').count(), 4);
  // − и + правят на месте и не сдвигают прокрутку
  const before = await page.evaluate(() => [window.scrollY, document.querySelector('.pl-rows')]).then(([y]) => y);
  const lvl = async () => Number(await page.locator('[data-skill=math] .pl-lvl').innerText());
  const l0 = await lvl();
  await page.click('[data-pm="math+"]');
  assert.equal(await lvl(), Math.min(5, l0 + 1));
  for (let i = 0; i < 6; i++) await page.click('[data-pm="math-"]', { force: true, timeout: 500 }).catch(() => {});
  assert.equal(await lvl(), 1, 'ниже первого не уходит');
  assert.equal(await page.locator('[data-pm="math-"]').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.scrollY), before, 'прокрутка не прыгнула');
  await page.click('[data-pl=confirm]');
  await page.waitForSelector('#after');
  const sent = await page.evaluate(() => window.sent.at(-1));
  assert.equal(sent.via, 'quiz');
  assert.equal(sent.skills.math, 1, 'ручная правка ушла на сервер');
  for (const v of Object.values(sent.skills)) assert.ok(v >= 1 && v <= 5);

  step(`${width}px · «по истории» с достаточными данными: основание и мало данных по навыкам`);
  await page.evaluate(() => {
    window.history_ = { available: true, total: 60, doubtful: 20, need: 0, summary: 'За последние 60 решений: 20 спорных, 6 явных ошибок: колл при невыгодных шансах — 6.',
      mistakes: [{ code: 'call-bad-odds', text: 'колл при невыгодных шансах', count: 6 }],
      skills: { preflop: { enough: false, level: null }, ranges: { enough: false, level: null }, math: { enough: true, level: 2 }, postflop: { enough: false, level: null } } };
    window.startPlacement();
  });
  await page.waitForSelector('[data-pl=history]:not([aria-disabled])');
  await page.click('[data-pl=history]');
  await page.waitForSelector('.pl-why');
  assert.match(await page.locator('.pl-why').innerText(), /60 решений.*колл при невыгодных шансах/s);
  assert.equal(await page.locator('.pl-row').count(), 1, 'только навык с данными');
  assert.match(await page.locator('.pl').innerText(), /Мало данных: Префлоп, Диапазоны, Постфлоп/);
  await shot('4-history'); await noHScroll('история'); await small('история');
  await page.click('[data-pl=confirm]');
  await page.waitForSelector('#after');
  assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { t: 'train', op: 'placement', via: 'history', skills: { math: 2 } });

  step(`${width}px · ошибка → «Изучить тему» → урок → «Вернуться к заданию» → то же задание`);
  const EX = 'v-outs-count-1';
  const SEED = 555;
  await page.evaluate(([i, sd]) => window.startLink(i, sd), [EX, SEED]);
  const prompt0 = await page.locator('#prompt').innerText();
  const wrong = await page.evaluate(([i, sd]) => window.wrongOption(i, sd), [EX, SEED]);
  await page.click(`[data-opt="${wrong}"]`);
  assert.equal(await page.locator('#verdict').innerText(), 'неверно');
  assert.match(await page.locator('#learn').innerText(), /^Изучить тему: /);
  await page.click('#learn');
  await page.waitForSelector('#lesson');
  // «перезагрузка WebView» посреди урока: память страницы пропадает, sessionStorage — нет
  await page.reload();
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.evaluate(() => window.resumeLink()), true, 'контекст возврата пережил перезагрузку');
  await page.waitForSelector('#prompt');
  assert.equal(await page.locator('#prompt').innerText(), prompt0, 'то же задание (те же карты, те же числа)');
  assert.equal(await page.locator('#repeat').innerText(), 'повтор');
  assert.deepEqual(await page.evaluate(() => window.lastOpened), { id: EX, s: SEED });
  assert.equal(await page.locator('[data-opt]').count() > 1, true, 'ответ можно дать заново');
  // цикл: снова ошибка и снова в урок — до предела, потом «домой»
  let home = false;
  for (let i = 0; i < 6 && !home; i++) {
    await page.click(`[data-opt="${wrong}"]`);
    await page.click('#learn');
    if (await page.locator('#home').count()) { home = true; break; }
    await page.click('#back');
  }
  assert.equal(home, true, 'цикл остановлен: «домой»');
  await shot('5-link');
  await ctx.close();
}
await browser.close();
server.close();
if (problems.length) { console.error('Ошибки страницы:\n' + problems.join('\n')); process.exit(1); }
console.log('e2e определение уровня: ок');
