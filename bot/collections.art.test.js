/**
 * Графика «Графита»: miniapp/collections/art/ (контракт, раздел 7).
 * Папку можно подменить: GRAPHIT_ART_DIR=<папка> (так «зубы» подсовывают поломки).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COLORS } from '../miniapp/collections/catalog.js';
import { ART_DIR, BUDGET, KINDS, FILE_NAMES, buildAll, writeAll, contrast, deltaE, GREEN, SURFACES } from '../tools/build-graphit-art.mjs';

const DIR = process.env.GRAPHIT_ART_DIR ? path.resolve(process.env.GRAPHIT_ART_DIR) : ART_DIR;
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const ALLOWED_TAGS = new Set(['svg', 'path', 'rect', 'ellipse', 'circle', 'g']);
const ALLOWED_ATTRS = new Set(['xmlns', 'viewBox', 'width', 'height', 'preserveAspectRatio', 'aria-hidden', 'focusable', 'd', 'fill', 'stroke', 'stroke-width',
  'stroke-linejoin', 'stroke-linecap', 'fill-rule', 'vector-effect', 'x', 'y', 'rx', 'ry', 'cx', 'cy', 'r', 'transform']);
const palette = new Set(COLORS.flatMap((c) => [c.bg, c.ink]));

/** Разбор SVG без зависимостей: список [тег, {атрибуты}] в порядке документа. */
function parse(text) {
  const out = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;
  let m;
  let last = 0;
  let pos = 0;
  while ((m = re.exec(text))) {
    assert.equal(text.slice(pos, m.index).trim(), '', 'между тегами нет текста');
    pos = re.lastIndex;
    last = m.index;
    if (m[1]) continue;
    const attrs = {};
    for (const a of m[3].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    out.push([m[2], attrs]);
  }
  assert.equal(text.slice(pos).trim(), '', 'после последнего тега ничего нет');
  assert.ok(last >= 0);
  return out;
}

/** Структура файла: палитру заменяем ролями — у четырёх цветов результат обязан совпасть побайтно. */
function skeleton(text, color) {
  return text.split(color.bg).join('{BG}').split(color.ink).join('{INK}');
}

test('список файлов совпадает с контрактом и лежит на диске', () => {
  const expected = [];
  for (const k of ['cardback-detail', 'cardback-small', 'table-ornament', 'table-diamond', 'frame-detail', 'frame-small', 'mark',
    'thumb-cardback', 'thumb-table', 'thumb-profile', 'bundle']) for (const c of ['graphite', 'sapphire', 'bordeaux', 'petrol']) expected.push(`${k}-${c}.svg`);
  assert.deepEqual([...FILE_NAMES].sort(), expected.sort());
  const onDisk = fs.readdirSync(DIR).filter((f) => f !== 'README.md').sort();
  assert.deepEqual(onDisk, [...expected, 'manifest.json'].sort());
});

test('четыре цвета одного вида — одна геометрия, различаются только цвета', () => {
  for (const kind of KINDS) {
    const skels = COLORS.map((c) => skeleton(read(`${kind.name}-${c.id}.svg`), c));
    for (let i = 1; i < skels.length; i++) assert.equal(skels[i], skels[0], `${kind.name}: ${COLORS[i].id} отличается по структуре`);
    // Роли действительно подставлены: после замены в файле не осталось чужих HEX.
    const hexes = new Set((skels[0].match(/#[0-9A-Fa-f]{3,8}\b/g) || []));
    assert.equal(hexes.size, 0, `${kind.name}: остались посторонние цвета ${[...hexes]}`);
    const stroke = (s) => [...s.matchAll(/stroke-width="([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(stroke(skels[3]), stroke(skels[0]));
  }
});

test('цвета только из палитры, у каждого цвета свой комплект фона и линии', () => {
  for (const f of FILE_NAMES) {
    const text = read(f);
    const colorId = COLORS.find((c) => f.endsWith(`-${c.id}.svg`));
    const used = new Set(text.match(/#[0-9A-Fa-f]{3,8}\b/g) || []);
    for (const h of used) assert.ok(palette.has(h), `${f}: цвет ${h} не из палитры`);
    for (const h of used) assert.ok([colorId.bg, colorId.ink].includes(h), `${f}: цвет ${h} чужого варианта`);
    for (const m of text.matchAll(/(fill|stroke)="([^"]*)"/g)) assert.ok(m[2] === 'none' || /^#[0-9A-F]{6}$/.test(m[2]), `${f}: ${m[0]}`);
  }
});

test('нет запрещённого: градиентов, фильтров, прозрачности, image, ссылок, скриптов, текста', () => {
  for (const f of FILE_NAMES) {
    const text = read(f);
    const els = parse(text);
    assert.equal(els[0][0], 'svg', f);
    assert.equal(els[0][1].xmlns, 'http://www.w3.org/2000/svg', f);
    assert.equal(els[0][1]['aria-hidden'], 'true', `${f}: декор скрыт от чтения`);
    for (const [tag, attrs] of els) {
      assert.ok(ALLOWED_TAGS.has(tag), `${f}: тег <${tag}>`);
      for (const a of Object.keys(attrs)) assert.ok(ALLOWED_ATTRS.has(a), `${f}: атрибут ${a}`);
    }
    assert.ok(!/url\(|href|<image|<script|<style|<text|<filter|Gradient|opacity|mask|clip-path|<use|<foreignObject|javascript:/i.test(text), `${f}: запрещённое`);
    const urls = text.match(/https?:\/\/[^"'\s<>]+/g) || [];
    assert.deepEqual(urls.filter((u) => u !== 'http://www.w3.org/2000/svg'), [], `${f}: внешние адреса`);
    assert.ok(!/\/\//.test(text.replace('http://www.w3.org/2000/svg', '')), `${f}: «//»`);
  }
});

test('viewBox по контракту и совпадает у четырёх цветов', () => {
  const want = { 'cardback-detail': '0 0 200 280', 'cardback-small': '0 0 200 280', 'frame-detail': '0 0 120 120', 'frame-small': '0 0 120 120', mark: '0 0 24 24' };
  for (const [k, vb] of Object.entries(want)) for (const c of COLORS) assert.equal(parse(read(`${k}-${c.id}.svg`))[0][1].viewBox, vb, `${k}-${c.id}`);
  for (const c of COLORS) assert.equal(parse(read(`table-ornament-${c.id}.svg`))[0][1].preserveAspectRatio, 'none');
});

test('рамка не закрывает аватар: центр прозрачный (безопасный круг r=44 свободен)', () => {
  for (const k of ['frame-detail', 'frame-small']) for (const c of COLORS) {
    const els = parse(read(`${k}-${c.id}.svg`));
    const first = els.find(([t, a]) => t === 'path' && a['fill-rule'] === 'evenodd');
    assert.ok(first, `${k}: кольцо с вырезом`);
    for (const [t, a] of els) {
      if (t === 'circle') assert.ok(Number(a.r) >= 46, `${k}: круг r=${a.r} заходит на аватар`);
      if (t === 'rect' || t === 'ellipse') assert.fail(`${k}: заливка по центру`);
    }
  }
});

test('вес: подробные ≤ 24 КБ, остальные ≤ 8 КБ', () => {
  for (const kind of KINDS) for (const c of COLORS) {
    const b = fs.statSync(path.join(DIR, `${kind.name}-${c.id}.svg`)).size;
    assert.ok(b <= (kind.detail ? BUDGET.detail : BUDGET.small), `${kind.name}-${c.id}: ${b} байт`);
  }
});

test('манифест соответствует диску и палитре', () => {
  const man = JSON.parse(read('manifest.json'));
  assert.deepEqual(man.colors, COLORS.map((c) => ({ id: c.id, bg: c.bg, ink: c.ink })));
  assert.deepEqual(man.files.map((x) => x.file).sort(), [...FILE_NAMES].sort());
  for (const x of man.files) {
    const buf = fs.readFileSync(path.join(DIR, x.file));
    assert.equal(x.bytes, buf.length, `${x.file}: размер`);
    assert.equal(x.sha256, crypto.createHash('sha256').update(buf).digest('hex'), `${x.file}: хэш`);
    assert.equal(x.viewBox, parse(buf.toString())[0][1].viewBox, `${x.file}: viewBox`);
  }
});

test('генерация воспроизводима и файлы на диске — её результат', () => {
  const a = buildAll();
  const b = buildAll();
  assert.deepEqual([...a.files], [...b.files]);
  assert.deepEqual(a.manifest, b.manifest);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graphit-art-'));
  try {
    writeAll(tmp);
    for (const f of [...FILE_NAMES, 'manifest.json']) assert.equal(read(f), fs.readFileSync(path.join(tmp, f), 'utf8'), `${f}: на диске не то, что даёт генератор`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('контраст линии к фону предмета ≥ 3:1; на подложках проекта линия читается', () => {
  for (const c of COLORS) {
    assert.ok(contrast(c.ink, c.bg) >= 3, `${c.id} линия/фон`);
    for (const s of SURFACES) assert.ok(contrast(c.ink, s) >= 3, `${c.id} линия/${s}`);
  }
});

test('«Петроль» (и другие) отличим от зелёного «Ваш ход» по цвету линии и фона', () => {
  for (const c of COLORS) {
    assert.ok(deltaE(c.ink, GREEN) >= 40, `${c.id}: линия близка к зелёному (ΔE ${deltaE(c.ink, GREEN).toFixed(1)})`);
    assert.ok(deltaE(c.bg, GREEN) >= 40, `${c.id}: фон близок к зелёному (ΔE ${deltaE(c.bg, GREEN).toFixed(1)})`);
  }
});
