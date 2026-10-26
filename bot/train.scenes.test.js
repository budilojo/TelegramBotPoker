/**
 * «Тренировка», показ ситуации и диапазона (волна 4, агент F). Без DOM: проверяем данные заданий.
 * Браузерную часть (что нарисовано, нажатия, точки подхода) держит tools/e2e-train-scenes.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { allExercises, instantiate } from '../miniapp/train/engine.js';
import '../miniapp/train/content/index.js';
import { handOfCards } from '../miniapp/train/ranges/hands.js';
import { cellNote } from '../miniapp/train/ranges/cell-note.js';

const SEEDS = [1, 7, 12345, 99999];
const each = (fn) => { for (const ex of allExercises()) for (const seed of SEEDS) fn(ex, instantiate(ex.id, seed).task, seed); };

test('показанная матрица (readonly) не пустая: у задания есть что показывать', () => {
  each((ex, t) => {
    if (t.setup?.grid?.mode === 'readonly') {
      const ref = t.setup.grid.ref;
      const n = Array.isArray(ref) ? ref.length : Object.keys(ref || {}).length;
      assert.ok(n > 0, `${ex.id}: матрица показана пустой`);
    }
  });
});

test('задание с reveal даёт диапазон, а обведённая рука лежит в сетке 169 рук', () => {
  let seen = 0;
  each((ex, t) => {
    if (!t.reveal) return;
    seen += 1;
    assert.ok(t.reveal.grids.length > 0, `${ex.id}: reveal без матриц`);
    const size = (g) => (Array.isArray(g.ref) ? g.ref.length : Object.keys(g.ref || {}).length);
    // Пустые диапазоны допустимы (виджет их не рисует), но хотя бы один должен быть — иначе разбору нечего показать.
    assert.ok(t.reveal.grids.some((g) => size(g) > 0), `${ex.id}: все диапазоны reveal пусты`);
    for (const g of t.reveal.grids) for (const m of g.mark || []) assert.ok(cellNote(m, g.ref), `${ex.id}: обведена неизвестная рука ${m}`);
  });
  assert.ok(seen >= 6, 'reveal есть как минимум у префлоп-заданий');
});

test('карты задания (hole) совпадают с рукой (hand) и с обведённой на матрице', () => {
  each((ex, t) => {
    const { hole, hand } = t.setup || {};
    if (!hole || !hand) return;
    assert.equal(handOfCards(hole[0], hole[1]), hand, `${ex.id}: hole ${hole} не равна hand ${hand}`);
    for (const g of t.reveal?.grids || []) assert.deepEqual(g.mark, [hand], `${ex.id}: обведена не та рука`);
  });
});

test('у позиций в setup.hero (строка) нет карт-массива и наоборот: сцена не получит строку вместо карт', () => {
  each((ex, t) => {
    const h = t.setup?.hero;
    if (typeof h === 'string') assert.ok(['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'].includes(h), `${ex.id}: странная позиция ${h}`);
    if (Array.isArray(h)) assert.ok(h.every(Number.isInteger), `${ex.id}: hero — не карты`);
  });
});

test('«3-бет»: «вы» — тот, кто открылся, а закрашивают диапазон соперника', () => {
  for (const seed of SEEDS) {
    const t = instantiate('w-readrange-3bet-3', seed).task;
    assert.ok(t.setup.you && t.setup.opener && t.setup.you !== t.setup.opener);
    assert.equal(typeof t.setup.hero, 'undefined', 'hero оставлять нельзя: сцена приняла бы соперника за вас');
    assert.match(t.prompt, new RegExp(`Вы открылись рейзом с .*${t.setup.you}`));
  }
});

test('подпись к клетке: комбинации и вхождение в диапазон считаются верно', () => {
  assert.match(cellNote('AKs', ['AKs']), /AKs — туз-король одной масти, 4 комбинации\. Входит в «диапазон» всегда\./);
  assert.match(cellNote('AA', { AA: 0.5 }), /6 комбинаций\. Входит в «диапазон» иногда: примерно в 50 % случаев\./);
  assert.match(cellNote('72o', ['AA'], { title: 'Открытие' }), /12 комбинаций\. Не входит в «Открытие»\./);
  assert.equal(cellNote('ZZ', []), '');
});

test('make(seed) по-прежнему детерминирован для всех упражнений', () => {
  for (const ex of allExercises()) {
    const a = instantiate(ex.id, 4242).task;
    const b = instantiate(ex.id, 4242).task;
    assert.equal(JSON.stringify(a), JSON.stringify(b), ex.id);
  }
});
