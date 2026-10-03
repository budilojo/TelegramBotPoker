/**
 * Витрина кита в настоящем браузере.
 *
 *   npm run kit              отчёт; выход 1 при любом замечании
 *   npm run kit -- --shots   ещё и снимки в preview/kit/
 *
 * Зачем машина там, где и так есть глаза: главное правило первой фазы —
 * «ни одного размера сверх шкалы» — глазами не проверяется. Два пикселя
 * разницы в скруглении не видно, а шкала от этого уже не шкала.
 *
 * Проверяется:
 *   1. ни одной ошибки в консоли;
 *   2. КАЖДЫЙ размер шрифта на странице — один из семи китовых;
 *   3. КАЖДОЕ скругление — одно из четырёх китовых;
 *   4. каждый отступ и зазор — из шкалы 4/8/12/16/24/32/48;
 *   5. в палец попадают: органы управления не ниже 44 px;
 *   6. на 320 px страница не шире экрана;
 *   7. текст читается: контраст по WCAG для пар из кита;
 *   8. все примитивы на месте и во всех состояниях.
 *
 * Нужен Playwright с Chromium, как tools/colors-check.mjs. Сервер не нужен:
 * витрина — обычная страница, и открывается прямо с диска.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'miniapp', 'kit.html');
const OUT = path.join(ROOT, 'preview', 'kit');
const SHOTS = process.argv.includes('--shots') || process.env.SHOTS === '1';

const VIEWPORTS = [[320, 568], [360, 640], [390, 844], [430, 932], [768, 1024]];

/* Шкалы кита. Всё, чего здесь нет, — это новый размер, то есть ошибка. */
const FONT_SIZES = [12, 14, 16, 20, 24, 32];
const RADII = [0, 6, 8, 12, 20, 999]; // 999 — «совсем круглое», отказ от размера
const SPACE = [0, 4, 8, 12, 16, 24, 32, 48];

/** Собрать со страницы всё, что можно сравнить со шкалой. */
function probe(scales) {
  const { fontSizes, radii, space } = scales;
  const px = (v) => Math.round(parseFloat(v) || 0);
  const bad = { font: [], radius: [], space: [], small: [] };
  const seen = { font: new Set(), radius: new Set() };

  const where = (el) => {
    const cls = (el.className?.baseVal ?? el.className ?? '').toString().trim().split(/\s+/)[0];
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
  };

  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    const text = (el.textContent || '').trim();

    // Размер шрифта — только у того, что само несёт текст.
    if (text && !el.children.length) {
      const fs = px(cs.fontSize);
      seen.font.add(fs);
      if (!fontSizes.includes(fs)) bad.font.push(`${where(el)}: ${fs}px`);
    }
    // Скругления. Проценты (кружки) — не размер, их пропускаем.
    for (const corner of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']) {
      const raw = cs[corner];
      if (raw.includes('%')) continue;
      const r = px(raw);
      seen.radius.add(r);
      if (!radii.includes(r)) bad.radius.push(`${where(el)} ${corner}: ${r}px`);
    }
    // Отступы и зазоры.
    for (const prop of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap']) {
      const raw = cs[prop];
      if (!raw || raw === 'normal') continue;
      const v = px(raw);
      if (!space.includes(v)) bad.space.push(`${where(el)} ${prop}: ${v}px`);
    }
    // В палец должно попадать.
    if (el.matches('.k-btn, .k-icon-btn, .k-input, .k-seg, .k-stepper')) {
      const h = el.getBoundingClientRect().height;
      if (h > 0 && h < 44) bad.small.push(`${where(el)}: ${Math.round(h)}px`);
    }
  }

  const count = (sel) => document.querySelectorAll(sel).length;
  return {
    bad,
    seenFont: [...seen.font].sort((a, b) => a - b),
    seenRadius: [...seen.radius].sort((a, b) => a - b),
    pageOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    // Кто именно вылезает за край — иначе ищется руками полчаса.
    widest: [...document.querySelectorAll('body *')]
      .map((el) => ({ el: where(el), right: Math.round(el.getBoundingClientRect().right) }))
      .filter((x) => x.right > innerWidth + 1)
      .sort((a, b) => b.right - a.right)
      .slice(0, 3)
      .map((x) => `${x.el} до ${x.right}px`),
    parts: {
      btnPrimary: count('.k-btn--primary'),
      btnSecondary: count('.k-btn--secondary'),
      btnGhost: count('.k-btn--ghost'),
      btnDisabled: count('.k-btn:disabled'),
      iconBtn: count('.k-icon-btn'),
      input: count('.k-input'),
      inputInvalid: count(".k-input[aria-invalid='true']"),
      stepper: count('.k-stepper'),
      segmented: count('.k-segmented'),
      segSelected: count(".k-seg[aria-selected='true']"),
      toggleOn: count('.k-toggle input:checked'),
      toggleOff: count('.k-toggle input:not(:checked):not(:disabled)'),
      toggleDisabled: count('.k-toggle input:disabled'),
      slider: count(".k-slider input[type='range']"),
      divider: count('.k-divider'),
      sheet: count('.k-sheet'),
      actions: count('.k-actions'),
      types: ['k-title', 'k-num', 'k-section', 'k-component', 'k-body', 'k-secondary', 'k-caption']
        .filter((c) => count('.' + c)).length,
    },
  };
}

/** Контраст по WCAG: пары, которые кит обязан держать читаемыми. */
function contrast() {
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const v = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return [
    ['основной текст на фоне', ratio(v('--k-text'), v('--k-bg'))],
    ['основной текст на поверхности', ratio(v('--k-text'), v('--k-surface'))],
    ['вторичный текст на фоне', ratio(v('--k-text-2'), v('--k-bg'))],
    ['вторичный текст на поверхности', ratio(v('--k-text-2'), v('--k-surface'))],
    ['текст на зелёной кнопке', ratio(v('--k-bg'), v('--k-green'))],
  ];
}

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const problems = [];
const browser = await chromium.launch();
if (SHOTS) fs.mkdirSync(OUT, { recursive: true });

const rows = [];
let shown = null;
for (const [w, h] of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`file://${PAGE}`);
  await page.waitForSelector('.k-btn', { timeout: 8000 });

  const p = await page.evaluate(probe, { fontSizes: FONT_SIZES, radii: RADII, space: SPACE });
  if (!shown) shown = { ...p, contrast: await page.evaluate(contrast) };

  const tag = `${w}×${h}`;
  let ok = true;
  const need = (cond, what) => { if (!cond) { problems.push(what); ok = false; } };

  need(!errors.length, `${tag}: ошибки в консоли — ${errors.slice(0, 2).join(' | ')}`);
  need(!p.bad.font.length, `${tag}: размер шрифта вне шкалы — ${p.bad.font.slice(0, 4).join(', ')}`);
  need(!p.bad.radius.length, `${tag}: скругление вне шкалы — ${p.bad.radius.slice(0, 4).join(', ')}`);
  need(!p.bad.space.length, `${tag}: отступ вне шкалы — ${p.bad.space.slice(0, 4).join(', ')}`);
  need(!p.bad.small.length, `${tag}: в палец не попасть — ${p.bad.small.slice(0, 4).join(', ')}`);
  need(p.pageOverflow === 0, `${tag}: страница шире экрана на ${p.pageOverflow}px — ${p.widest.join(', ')}`);

  const q = p.parts;
  need(q.types === 7, `${tag}: начертаний на странице ${q.types}, а в ките семь`);
  need(q.btnPrimary && q.btnSecondary && q.btnGhost && q.btnDisabled, `${tag}: кнопка не во всех состояниях`);
  need(q.iconBtn >= 7, `${tag}: иконочных кнопок ${q.iconBtn}, в ките семь видов`);
  need(q.input && q.inputInvalid, `${tag}: поле ввода без состояния ошибки`);
  need(q.stepper && q.segmented && q.segSelected, `${tag}: степпер или сегменты не собраны`);
  need(q.toggleOn && q.toggleOff && q.toggleDisabled, `${tag}: тумблер не во всех состояниях`);
  need(q.slider && q.divider && q.sheet && q.actions, `${tag}: ползунок, разделитель, шторка или зона действий отсутствуют`);

  if (SHOTS) await page.screenshot({ path: path.join(OUT, `kit-${w}.png`), fullPage: true });
  rows.push([tag, ok]);
  await page.close();
}
await browser.close();

for (const [name, cont] of shown.contrast) {
  // 4.5:1 — порог WCAG AA для обычного текста.
  if (cont < 4.5) problems.push(`контраст «${name}»: ${cont.toFixed(2)}:1, нужно 4.5`);
}

console.log('\nразмеры шрифта на странице: ' + shown.seenFont.join(', ') + ' px');
console.log('скругления на странице:     ' + shown.seenRadius.join(', ') + ' px');
console.log('контраст:');
for (const [name, cont] of shown.contrast) console.log(`  ${name.padEnd(32)} ${cont.toFixed(2)}:1`);
console.log('');
for (const [name, ok] of rows) console.log(`  ${name.padEnd(10)} ${ok ? '·' : '✗'}`);

if (problems.length) {
  console.log(`\n${problems.length} замечаний:`);
  for (const p of problems.slice(0, 30)) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('\nкит собран: ни одного размера сверх шкалы');
