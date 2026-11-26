/**
 * Правила автоскана вёрстки — без браузера: на выдуманных замерах. Сам обход экранов —
 * `npm run ui:scan` (нужен Chromium), его «на зубы» — `node tools/ui-scan.mjs --teeth`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, real } from './lib/ui-scan-rules.mjs';

const rect = (l, t, w, h) => ({ l, t, r: l + w, b: t + h });
const line = (text, l, t, w, h = 16) => ({ text, ...rect(l, t, w, h) });
/** Один узел замера; всё, что не названо, — «обычный видимый блок». */
function node(i, over = {}) {
  const r = over.rect || rect(10, 10, 100, 44);
  return {
    i, p: -1, sel: `div.n${i}`, tag: 'div', cls: '', rect: r, invisible: false, decor: false, ox: 'visible', oy: 'visible', pos: 'static',
    ellipsis: false, clamp: 0, boxed: false, sw: 0, cw: 0, sh: 0, ch: 0, transform: false, srOnly: false, interactive: false, media: false,
    text: over.lines ? over.lines.map((x) => x.text).join(' ') : '', lines: [], coveredBy: null, reach: null, tap: null, ...over,
  };
}
const scan = (nodes, over = {}) => real(analyze([{ vw: 320, vh: 568, docW: 320, nodes, ...over }]));
const types = (found) => found.map((f) => f.type).sort();

test('ui-scan: ровный экран — ни одной находки', () => {
  assert.deepEqual(scan([node(0, { lines: [line('Привет', 12, 20, 60)] }), node(1, { rect: rect(10, 80, 120, 48), interactive: true, reach: 1 })]), []);
});

test('ui-scan: страница шире экрана и блок за краем', () => {
  assert.deepEqual(types(scan([node(0, { rect: rect(200, 10, 200, 40), lines: [line('Далеко', 210, 12, 60)] })], { docW: 400 })), ['hscroll-page', 'offscreen']);
});

test('ui-scan: срезанные буквы, «…» длинного имени и раздавленная подпись — разные вещи', () => {
  const box = (i, over) => node(i, { rect: rect(10, 10, 100, 20), ox: 'hidden', oy: 'hidden', ...over });
  assert.deepEqual(types(scan([box(0, { lines: [line('Обрезано', 10, 12, 130)] })])), ['clipped']);
  const long = scan([box(0, { ellipsis: true, lines: [line('Александра-Мария', 10, 12, 140)] })]);
  assert.deepEqual(long.map((f) => [f.type, f.severity]), [['ellipsis', 'minor']]);
  const crushed = scan([box(0, { ellipsis: true, rect: rect(10, 10, 30, 20), lines: [line('Морской бой', 10, 12, 105)] })]);
  assert.deepEqual(crushed.map((f) => [f.type, f.severity]), [['crushed', 'major']]);
  // Имя, которому соседи не оставили ни пикселя, — не «для читалки с экрана».
  assert.deepEqual(types(scan([node(0, { rect: rect(10, 10, 0, 20), text: 'Иван' })])), ['crushed']);
});

test('ui-scan: надпись, не поместившаяся на кнопке, — сломанная кнопка', () => {
  const b = node(0, { tag: 'button', interactive: true, reach: 1, ellipsis: true, ox: 'hidden', rect: rect(10, 10, 90, 48), lines: [line('▶ Ещё партия', 10, 20, 100)] });
  assert.deepEqual(types(scan([b])), ['cut-label']);
});

test('ui-scan: мелкая зона нажатия; расширенная псевдоэлементом и клетка доски — не находка', () => {
  const small = { interactive: true, reach: 1, rect: rect(10, 10, 38, 38) };
  assert.deepEqual(types(scan([node(0, { ...small, tap: { extended: false } })])), ['small-target']);
  assert.deepEqual(scan([node(0, { ...small, tap: { extended: true } })]), []);
  assert.deepEqual(scan([node(0, { ...small, tap: { extended: false }, sel: 'div.ch-board > button.ch-sq' })]), []);
});

test('ui-scan: наложение текстов, закрытое действие и кнопка ниже экрана', () => {
  const a = node(0, { reach: 1, lines: [line('Места в таблице', 10, 100, 200)] });
  const b = node(1, { reach: 1, lines: [line('Вы ещё не играли', 20, 105, 200)] });
  assert.deepEqual(types(scan([a, b])), ['text-overlap']);
  const covered = node(0, { interactive: true, reach: 0, coveredBy: 'nav.nav', rect: rect(10, 500, 100, 48) });
  assert.deepEqual(scan([covered]).map((f) => [f.type, f.severity]), [['covered-action', 'block']]);
  assert.deepEqual(types(scan([node(0, { interactive: true, rect: rect(10, 600, 100, 48) })])), ['unreachable']);
  // Открылось после прокрутки (другой замер) — не закрыто.
  const open = { vw: 320, vh: 568, docW: 320, nodes: [{ ...covered, reach: 1, coveredBy: null }] };
  assert.deepEqual(real(analyze([{ ...open, nodes: [covered] }, open])), []);
});

test('ui-scan: под кнопкой чата — серьёзно на неподвижном экране, косметика там, где можно сдвинуть', () => {
  const fab = node(1, { cls: 'chat-fab', sel: 'div.chat-root > button.chat-fab', tag: 'button', interactive: true, reach: 1, rect: rect(264, 300, 48, 48) });
  const text = (i, over) => node(i, { reach: 1, rect: rect(40, 320, 260, 20), lines: [line('Вы выиграли — шашек не осталось', 40, 322, 250)], ...over });
  assert.deepEqual(scan([text(0), fab]).map((f) => [f.type, f.severity]), [['under-fab', 'major']]);
  const list = node(0, { sel: 'div.lobby', oy: 'auto', sh: 900, ch: 500, rect: rect(0, 0, 320, 500) });
  assert.deepEqual(scan([list, fab, text(2, { p: 0 })]).map((f) => [f.type, f.severity]), [['under-fab', 'minor']]);
});

test('ui-scan: разорванное слово, одинокая буква, половина эмодзи и число без точек', () => {
  assert.deepEqual(types(scan([node(0, { lines: [line('Констант', 10, 10, 60), line('ин', 10, 30, 16)] })])), ['orphan', 'word-break']);
  assert.deepEqual(types(scan([node(0, { text: '🤖'[0], lines: [line('🤖'[0], 10, 10, 16)] })])), ['broken-char']);
  assert.deepEqual(types(scan([node(0, { lines: [line('+1000000', 10, 10, 70)] })])), ['bare-number']);
  assert.deepEqual(scan([node(0, { lines: [line('+1.000.000', 10, 10, 80)] })]), []);
  assert.deepEqual(scan([node(0, { lines: [line('Ваш ID 700201001', 10, 10, 120)] })]), []);
});

test('аватар: первый символ имени целиком, а не половина эмодзи («🤖 Вася» не «�»)', async () => {
  const keep = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { addEventListener() {}, innerHeight: 800 };
  globalThis.document = { getElementById: () => null, addEventListener() {}, querySelectorAll: () => [], documentElement: { style: { setProperty() {} } } };
  try {
    const { initial } = await import('../miniapp/ui.js');
    assert.equal(initial('🤖 Вася'), '🤖');
    assert.equal(initial('  артём'), 'А');
    assert.equal(initial(''), '?');
  } finally {
    Object.assign(globalThis, keep);
  }
});
