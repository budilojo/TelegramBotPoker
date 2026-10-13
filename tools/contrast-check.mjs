/**
 * КОНТРАСТ КАК ИНСТРУМЕНТ, А НЕ КАК ОБЕЩАНИЕ.
 *
 *   npm run contrast
 *
 * Зачем это отдельная проверка. Палитра стала спокойнее: зелёный с #2EE08C
 * сменился на #137A43, и вместе с яркостью ушёл запас по контрасту. На глаз
 * этого не видно — светлая надпись на зелёном и зелёная надпись на фоне
 * выглядят одинаково «нормально», а первая даёт 4.98, вторая 3.50. Решает
 * здесь арифметика, и считать её должна машина при каждом прогоне.
 *
 * Что считается:
 *   A. АВТОМАТИЧЕСКИ — каждое правило в miniapp/*.css, где в одном блоке
 *      заданы и цвет текста, и заливка. Пары собираются из самих стилей, а
 *      не из списка, который кто-то вспомнил.
 *   B. ПО ТАБЛИЦЕ — то, что из CSS не вывести: текст и контуры ПОВЕРХ СУКНА
 *      (сукно задаётся раскладкой в JS), маркеры на клетках доски, контур
 *      вокруг заливки.
 *   C. ИСКЛЮЧЕНИЯ — с причиной и с измеренным числом. Печатаются всегда:
 *      исключение, которое не видно, через месяц станет правилом.
 *
 * Порог: мелкий текст 4.5, крупный текст и неТекст 3.0 (WCAG 2.1 AA, 1.4.3
 * и 1.4.11). Крупный — от 24 px, либо от 18.66 px полужирным.
 *
 * Падает с кодом 1 при любом недоборе. Проверить, что проверка живая:
 * поставить тёмный текст на зелёную кнопку (--k-on-green: var(--k-bg)) или
 * зелёный мелкий текст на фон — оба случая обязаны уронить прогон.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'miniapp');

/*
 * UNOQ ждёт фазы 6: miniapp/colors.css ещё не переведён на кит, и его пары
 * заведомо не прошли бы. Файл исключён целиком и НАЗВАН здесь — чтобы при
 * закрытии фазы 6 строку убрали, а не искали, почему экран не проверяется.
 */
const SKIP_FILES = new Set(['colors.css']);

const AA_TEXT = 4.5;
const AA_LARGE = 3.0;

/* ----------------------------------------------------------------- цвет */

const srgb = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function parse(c) {
  c = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(c);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16));
  m = /^#([0-9a-f]{6})$/.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
  if (m) return [1, 2, 3].map((i) => Math.round(parseFloat(m[i])));
  return null;
}
const lum = ([r, g, b]) => 0.2126 * srgb(r / 255) + 0.7152 * srgb(g / 255) + 0.0722 * srgb(b / 255);
function ratio(a, b) {
  const [x, y] = [lum(parse(a)), lum(parse(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
/** Непрозрачный цвет, лежащий на подложке: mix по альфе. */
function over(fg, alpha, bg) {
  const f = parse(fg), b = parse(bg);
  return hex(f.map((v, i) => v * alpha + b[i] * (1 - alpha)));
}

/* ------------------------------------------------------------- токены */

/** Все переменные из всех :root, с разворотом var() и color-mix. */
function readTokens() {
  const raw = new Map();
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.css'))) {
    const src = strip(fs.readFileSync(path.join(DIR, f), 'utf8'));
    for (const block of src.matchAll(/:root\s*\{([^}]*)\}/g)) {
      for (const d of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        if (!raw.has(d[1])) raw.set(d[1], d[2].trim());
      }
    }
  }
  const seen = new Map();
  function resolve(name, depth = 0) {
    if (seen.has(name)) return seen.get(name);
    if (depth > 12 || !raw.has(name)) return null;
    let v = raw.get(name);
    let m;
    while ((m = /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/.exec(v))) {
      const inner = resolve(m[1], depth + 1) ?? (m[2] || '').trim();
      if (!inner) return null;
      v = v.slice(0, m.index) + inner + v.slice(m.index + m[0].length);
    }
    /* color-mix(in srgb, A p%, B) — ровно та форма, что встречается в токенах. */
    m = /^color-mix\(\s*in srgb\s*,\s*(\S+)\s+([\d.]+)%\s*,\s*(\S+?)\s*\)$/.exec(v);
    if (m) {
      const p = parseFloat(m[2]) / 100;
      const base = m[3] === 'transparent' ? null : m[3];
      v = base ? over(m[1], p, base) : `${m[1]}@${m[2]}%`;
    }
    const out = parse(v) ? hex(parse(v)) : v;
    seen.set(name, out);
    return out;
  }
  const out = new Map();
  for (const k of raw.keys()) { const v = resolve(k); if (v) out.set(k, v); }
  return out;
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const T = readTokens();
const tok = (n) => {
  const v = T.get(n);
  if (!v || !parse(v)) throw new Error(`токен ${n} не разворачивается в цвет (получено: ${v})`);
  return v;
};

/* ------------------------------------------------ A. пары из самих стилей */

/** Крупный ли текст: от 24px, либо от 18.66px полужирным. */
function isLarge(px, weight) {
  if (px == null) return false;
  return px >= 24 || (px >= 18.66 && weight >= 600);
}
/** Развернуть значение свойства в конкретный цвет, если это возможно. */
function colorOf(v) {
  v = v.trim();
  if (/^(transparent|none|inherit|currentcolor|initial|unset)$/i.test(v)) return null;
  let m = /^var\(\s*(--[\w-]+)/.exec(v);
  if (m) { const t = T.get(m[1]); return t && parse(t) ? t : null; }
  if (/gradient|hsl|color-mix/i.test(v)) return null;
  return parse(v) ? hex(parse(v)) : null;
}

function autoPairs() {
  const rows = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.css'))) {
    if (SKIP_FILES.has(f)) continue;
    const src = strip(fs.readFileSync(path.join(DIR, f), 'utf8'));
    for (const r of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = r[1].trim().replace(/\s+/g, ' ');
      if (sel.startsWith('@') || sel.includes(':root')) continue;
      const body = r[2];
      const get = (prop) => {
        const m = [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g'))];
        return m.length ? m[m.length - 1][1].trim() : null;
      };
      const fg = get('color') && colorOf(get('color'));
      const bgRaw = get('background-color') || get('background');
      const bg = bgRaw && colorOf(bgRaw.split(/\s+/)[0]);
      if (!fg || !bg) continue;
      /* Кегль и вес из того же правила: шрифт в сокращённой записи тоже. */
      let px = null, weight = 400;
      const fsRaw = get('font-size') || (get('font') || '').match(/(\d+(?:\.\d+)?)px|var\(--k-fs-[\w-]+\)/)?.[0];
      if (fsRaw) {
        const v = colorOfSize(fsRaw);
        if (v != null) px = v;
      }
      const wRaw = get('font-weight') || (get('font') || '').match(/var\(--k-w-[\w-]+\)|\b[1-9]00\b/)?.[0];
      if (wRaw) weight = sizeNum(wRaw) ?? 400;
      /*
       * Выключенное состояние — исключение по WCAG 1.4.3, и узнаётся оно по
       * селектору, а не по списку имён: новое выключенное правило попадёт под
       * исключение само, но и в отчёт попадёт тоже — молча оно не исчезнет.
       */
      const off = /:disabled|\[data-disabled\]|--off\b|\.off\b/.test(sel);
      rows.push({ where: `${f} ${sel}`, fg, bg, large: isLarge(px, weight), px, off });
    }
  }
  return rows;
}
function sizeNum(v) {
  v = String(v).trim();
  const m = /^var\(\s*(--[\w-]+)/.exec(v);
  if (m) { const t = T.get(m[1]); return t ? parseFloat(t) : null; }
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
const colorOfSize = sizeNum;

/* ------------------------------------------------- B. таблица комбинаций */

const felt = tok('--table-felt');
const feltD = tok('--felt-durak');
const chL = tok('--ch-light');
const chD = tok('--ch-dark');

/** kind: 'text' — мелкий текст (4.5); 'nontext' — контур, точка, полоса (3.0). */
const TABLE = [
  /* --- текст на заливках --- */
  ['светлый текст на зелёной заливке', tok('--text-on-success'), tok('--color-success'), 'text'],
  ['светлый текст на красной заливке', tok('--text-primary'), tok('--color-danger'), 'text'],
  ['тёмная надпись на светлой плашке', tok('--bg-main'), tok('--text-primary'), 'text'],
  ['основной текст на фоне', tok('--text-primary'), tok('--bg-main'), 'text'],
  ['основной текст на поверхности', tok('--text-primary'), tok('--bg-surface'), 'text'],
  ['основной текст на приподнятой', tok('--text-primary'), tok('--bg-elevated'), 'text'],
  ['вторичный текст на фоне', tok('--text-secondary'), tok('--bg-main'), 'text'],
  ['вторичный текст на поверхности', tok('--text-secondary'), tok('--bg-surface'), 'text'],
  ['вторичный текст на приподнятой', tok('--text-secondary'), tok('--bg-elevated'), 'text'],

  /* --- ПОВЕРХ СУКНА: сукно рисует раскладка, из CSS эту пару не вывести --- */
  ['основной текст на сукне покера', tok('--text-primary'), felt, 'text'],
  ['вторичный текст на сукне покера', tok('--text-secondary'), felt, 'text'],
  ['основной текст на сукне дурака', tok('--text-primary'), feltD, 'text'],
  ['вторичный текст на сукне дурака', tok('--text-secondary'), feltD, 'text'],
  ['контур плашки на сукне покера', tok('--on-felt-line'), felt, 'nontext'],
  ['контур плашки на сукне дурака', tok('--on-felt-line'), feltD, 'nontext'],
  ['светлый контур на сукне покера', tok('--on-felt-accent-line'), felt, 'nontext'],
  ['светлый контур на сукне дурака', tok('--on-felt-accent-line'), feltD, 'nontext'],
  /* Зелёная заливка на сукне не видна (2.24) — её держит светлый контур, и
     он обязан отличаться и от сукна, и от самой заливки. */
  ['светлый контур к зелёной заливке', tok('--on-felt-accent-line'), tok('--color-success'), 'nontext'],
  ['светлый контур к красной заливке', tok('--on-felt-accent-line'), tok('--color-danger'), 'nontext'],
  ['зелёная полоса «чей ход» на фоне', tok('--color-success'), tok('--bg-main'), 'nontext'],
  ['зелёная рамка на поверхности', tok('--color-success'), tok('--bg-surface'), 'nontext'],
  ['красная рамка на поверхности', tok('--color-danger'), tok('--bg-surface'), 'nontext'],
  ['зелёная точка знака числа на фоне', tok('--color-success'), tok('--bg-main'), 'nontext'],
  ['красная точка знака числа на фоне', tok('--color-danger'), tok('--bg-main'), 'nontext'],
  ['зелёное подчёркивание ссылки на фоне', tok('--color-success'), tok('--bg-main'), 'nontext'],

  /* --- ДОСКА: маркер двухслойный, на каждой клетке держит хотя бы один слой --- */
  ['маркер хода: кольцо на светлой клетке', tok('--bg-main'), chL, 'nontext'],
  ['маркер хода: ядро на тёмной клетке', tok('--text-primary'), chD, 'nontext'],
  ['маркер хода: кольцо на тёмной клетке', tok('--bg-main'), chD, 'nontext'],
  ['маркер хода: ядро к своему кольцу', tok('--text-primary'), tok('--bg-main'), 'nontext'],
  ['шах: красное кольцо на светлой клетке', tok('--color-danger'), chL, 'nontext'],
  ['шах: светлое кольцо на тёмной клетке', tok('--text-primary'), chD, 'nontext'],
];

/* ------------------------------------------------------- C. исключения */

/*
 * Каждое исключение — с причиной и с числом. Не «потом посмотрим», а
 * измеренный факт, который виден в каждом прогоне.
 */
const EXEMPT = [
  {
    what: 'координаты по краю доски',
    pair: [tok('--bg-main'), chD],
    need: AA_TEXT,
    why: 'до 4.5 на клетке #5F7F76 не дотянуть НИЧЕМ: даже чистый белый даёт 4.28, '
       + 'чистый чёрный 4.47. Цвета клеток — игровой арт. Взято лучшее возможное, '
       + 'и те же координаты продублированы записью ходов под доской.',
  },
  {
    what: 'подложка «последний ход» на клетке',
    pair: [over(tok('--text-primary'), 0.24, chD), chD],
    need: AA_LARGE,
    why: 'украшение, а не состояние: какой ход был последним, написано в записи '
       + 'ходов под доской. Подложка только помогает глазу, и усиливать её значит '
       + 'спорить с маркерами «сюда можно», которым видимость действительно нужна.',
  },
  {
    what: 'выключенный текст (--color-muted)',
    pair: [tok('--color-muted'), tok('--bg-surface')],
    need: AA_TEXT,
    why: 'WCAG 1.4.3 не распространяется на выключенные органы управления. '
       + 'Выключенное отличается и формой — без контура и без отклика на нажатие, — '
       + 'а рядом стоит подпись, чего не хватает (кит, раздел 6).',
  },
];

/* ------------------------------------------------------------- прогон */

const problems = [];
const pad = (s, n) => String(s).padEnd(n);

console.log('\nТОКЕНЫ');
for (const n of ['--bg-main', '--bg-surface', '--bg-elevated', '--table-felt', '--felt-durak',
  '--text-primary', '--text-secondary', '--border-color', '--color-success', '--color-danger',
  '--color-muted', '--text-on-success', '--on-felt-line', '--on-felt-accent-line']) {
  console.log(`  ${pad(n, 24)} ${tok(n)}`);
}

console.log('\nБ. КОМБИНАЦИИ ПО ТАБЛИЦЕ');
for (const [name, fg, bg, kind] of TABLE) {
  const need = kind === 'text' ? AA_TEXT : AA_LARGE;
  const r = ratio(fg, bg);
  const ok = r >= need;
  console.log(`  ${ok ? '·' : '✗'} ${pad(name, 42)} ${r.toFixed(2).padStart(6)}  нужно ${need}`);
  if (!ok) problems.push(`${name}: ${r.toFixed(2)}, нужно ${need} (${fg} на ${bg})`);
}

const auto = autoPairs();
const autoBad = [];
const autoOff = [];
for (const row of auto) {
  const need = row.large ? AA_LARGE : AA_TEXT;
  const r = ratio(row.fg, row.bg);
  if (r >= need) continue;
  (row.off ? autoOff : autoBad).push({ ...row, r, need });
}
console.log(`\nА. ПАРЫ ИЗ САМИХ СТИЛЕЙ — собрано ${auto.length}, недобор ${autoBad.length}`);
for (const b of autoBad) {
  console.log(`  ✗ ${pad(b.where, 52)} ${b.r.toFixed(2).padStart(6)}  нужно ${b.need}  (${b.fg} на ${b.bg})`);
  problems.push(`${b.where}: ${b.r.toFixed(2)}, нужно ${b.need}`);
}
if (!autoBad.length) console.log('  · каждая пара, заданная в одном правиле, проходит порог');

console.log('\nВ. ИСКЛЮЧЕНИЯ — измерены и названы');
for (const e of EXEMPT) {
  const r = ratio(e.pair[0], e.pair[1]);
  console.log(`  ! ${pad(e.what, 42)} ${r.toFixed(2).padStart(6)}  порог ${e.need}`);
  for (const line of e.why.match(/.{1,74}(\s|$)/g)) console.log(`      ${line.trim()}`);
}
for (const o of autoOff) {
  console.log(`  ! ${pad(o.where, 42)} ${o.r.toFixed(2).padStart(6)}  порог ${o.need} — выключенное состояние`);
}
if (SKIP_FILES.size) {
  console.log(`\n  ! не проверяется целиком: ${[...SKIP_FILES].join(', ')} — UNOQ ждёт фазы 6`);
}

if (problems.length) {
  console.log(`\n${problems.length} недоборов контраста:`);
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('\nконтраст держится: мелкий текст не ниже 4.5, неТекст не ниже 3');
