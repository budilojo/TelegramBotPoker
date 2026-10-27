/**
 * Оформление «Графит» на игровых экранах: проверки чтения вида (`miniapp/collections/look-view.js`)
 * и охрана границ экрана (где вид показывать нельзя). Браузерная часть — tools/e2e-collections-look.mjs;
 * «на зубы» — node tools/graphit-screens-teeth.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  artUrl, tableOf, backOf, frameOf, makeHolder, markFailed, resetFailed, isFailed,
} from '../miniapp/collections/look-view.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
/** Тело функции верхнего уровня по имени (до следующей строки `}` в начале строки). */
const body = (src, name) => {
  const i = src.search(new RegExp(`^(export )?function ${name}\\(`, 'm'));
  assert.ok(i >= 0, `функция ${name} найдена`);
  const j = src.indexOf('\n}\n', i);
  return src.slice(i, j + 3);
};
const POKER = read('miniapp/games/poker.js');
const DURAK = read('miniapp/games/durak.js');
const LOOK = read('miniapp/collections/look-view.js');

const T = { item: 'graphit-table', color: 'sapphire' };
const B = (seat, color = 'petrol') => ({ seat, item: 'graphit-cardback', color });
const F = { item: 'graphit-profile', color: 'bordeaux' };

test('адреса картинок: только известные виды и цвета; падение файла помнится', () => {
  resetFailed();
  assert.equal(artUrl('table-ornament', 'petrol'), '/collections/art/table-ornament-petrol.svg');
  assert.equal(artUrl('table-ornament', 'red'), null);
  assert.equal(artUrl('../../etc/passwd', 'petrol'), null);
  assert.equal(artUrl('cardback-detail', 'petrol'), null, 'подробная рубашка в игре не нужна');
  markFailed('/collections/art/mark-petrol.svg');
  assert.ok(isFailed('/collections/art/mark-petrol.svg'));
  assert.equal(artUrl('mark', 'petrol'), null, 'не загрузился → не просим второй раз (база)');
  assert.equal(artUrl('mark', 'graphite'), '/collections/art/mark-graphite.svg');
  resetFailed();
});

test('стол: нужный предмет и цвет из каталога, иначе база; нет файлов → база', () => {
  resetFailed();
  assert.equal(tableOf({ table: T }).color, 'sapphire');
  assert.equal(tableOf({ table: null }), null);
  assert.equal(tableOf(null), null);
  assert.equal(tableOf({}), null);
  assert.equal(tableOf({ table: { item: 'graphit-table', color: 'pink' } }), null);
  assert.equal(tableOf({ table: { item: 'graphit-cardback', color: 'sapphire' } }), null, 'чужой слот');
  assert.equal(tableOf({ table: { item: 'graphit-bundle', color: 'sapphire' } }), null, 'комплект — не стол');
  assert.equal(tableOf({ table: { item: '__proto__', color: 'sapphire' } }), null);
  markFailed('/collections/art/table-ornament-sapphire.svg');
  assert.equal(tableOf({ table: T }).ornament, null, 'орнамента нет — слой не рисуем');
  assert.ok(tableOf({ table: T }).diamond, 'ромб ещё есть');
  markFailed('/collections/art/table-diamond-sapphire.svg');
  assert.equal(tableOf({ table: T }), null, 'нет ни орнамента, ни ромба — база');
  resetFailed();
});

test('рубашка: по номеру места, одна запись; нет записи/файла → null; лица не затрагиваются', () => {
  resetFailed();
  const look = { backs: [B(0), B(2, 'sapphire'), B(2, 'bordeaux')] };
  assert.equal(backOf(look, 0).color, 'petrol');
  assert.equal(backOf(look, 2).color, 'sapphire', 'берётся первая запись места');
  assert.equal(backOf(look, 1), null);
  assert.equal(backOf(look, '0'), null, 'место — только число');
  assert.equal(backOf({ backs: [{ seat: 0, item: 'graphit-table', color: 'petrol' }] }, 0), null);
  assert.equal(backOf({ backs: 'x' }, 0), null);
  assert.equal(backOf({ backs: [B(0, 'nope')] }, 0), null);
  assert.match(backOf(look, 0).src, /cardback-small-petrol\.svg$/, 'в игре — малая рубашка');
  markFailed('/collections/art/cardback-small-petrol.svg');
  assert.equal(backOf(look, 0), null, 'файла нет — обычная рубашка');
  resetFailed();
});

test('рамка и знак: нужный предмет; нет файла рамки — знак остаётся, нет обоих — база', () => {
  resetFailed();
  const f = frameOf(F);
  assert.equal(f.color, 'bordeaux');
  assert.match(f.frame, /frame-small-bordeaux\.svg$/);
  assert.match(f.mark, /mark-bordeaux\.svg$/);
  assert.equal(frameOf(null), null);
  assert.equal(frameOf({ item: 'graphit-table', color: 'bordeaux' }), null);
  markFailed('/collections/art/frame-small-bordeaux.svg');
  assert.equal(frameOf(F).frame, null);
  assert.ok(frameOf(F).mark);
  markFailed('/collections/art/mark-bordeaux.svg');
  assert.equal(frameOf(F), null);
  resetFailed();
});

test('вид не меняется посреди раздачи; лобби живое; новая раздача и новая комната берут новый вид', () => {
  const hold = makeHolder();
  const look = (dealNo, color) => ({ v: 1, table: { item: 'graphit-table', color }, backs: [], dealNo });
  assert.equal(hold.hold('R1', 'lobby', look(0, 'petrol')).table.color, 'petrol');
  assert.equal(hold.hold('R1', 'lobby', look(0, 'bordeaux')).table.color, 'bordeaux', 'лобби — сразу');
  assert.equal(hold.hold('R1', 'playing', look(1, 'sapphire')).table.color, 'sapphire', 'начало раздачи — снимок');
  assert.equal(hold.hold('R1', 'playing', look(1, 'graphite')).table.color, 'sapphire', 'посреди раздачи прежний');
  assert.equal(hold.hold('R1', 'playing', look(1, 'petrol')).table.color, 'sapphire', 'в том числе при повторном получении (переподключение)');
  assert.equal(hold.hold('R1', 'finished', look(1, 'petrol')).table.color, 'sapphire', 'итоги — та же раздача');
  assert.equal(hold.hold('R1', 'playing', look(2, 'petrol')).table.color, 'petrol', 'следующая раздача — новый вид');
  assert.equal(hold.hold('R2', 'playing', look(2, 'bordeaux')).table.color, 'bordeaux', 'другая комната — свой вид');
  assert.equal(hold.hold('R2', 'playing', null), null, 'нет look (старый сервер) — база');
  assert.equal(hold.hold('R2', 'playing', look(2, 'graphite')).table.color, 'graphite', 'после «нет look» держатель начинает заново');
});

test('границы экрана: рамка и знак — только лобби и итоги; в партии их нет', () => {
  for (const [name, src, fns] of [
    ['покер', POKER, ['seatEl', 'heroEl', 'renderTable', 'centerEl', 'panelEl', 'openWinner']],
    ['дурак', DURAK, ['seatEl', 'heroEl', 'renderTable', 'middleEl', 'panelEl']],
  ]) {
    for (const fn of fns) {
      const b = body(src, fn);
      assert.ok(!/frameAvatar|nameWithMark/.test(b), `${name}: ${fn} не рисует рамку и знак (в партии их нет)`);
    }
    for (const fn of ['renderLobby', 'renderResults']) {
      const b = body(src, fn);
      assert.ok(/frameAvatar|nameWithMark/.test(b), `${name}: ${fn} рисует рамку/знак`);
    }
  }
});

test('границы экрана: лица своих карт не заменяются; дурак без персональных рубашек', () => {
  const hero = body(POKER, 'heroEl');
  const faces = hero.slice(hero.indexOf('me.cards.map'), hero.indexOf('} else {', hero.indexOf('me.cards.map')));
  assert.ok(/cardImg\(c\)/.test(faces) && !/backFor|backImgFor/.test(faces), 'лицо своей карты — cardImg, не рубашка');
  const seat = body(POKER, 'seatEl');
  const shown = seat.slice(seat.indexOf("div.minis.shown"), seat.indexOf('} else if'));
  assert.ok(/cardImg\(c\)/.test(shown) && !/backFor|backImgFor/.test(shown), 'вскрытые карты места — лица');
  assert.ok(!/backImgFor|backOf/.test(DURAK), 'у дурака нет персональных рубашек');
  assert.ok(!/backImgFor|backFor/.test(body(POKER, 'centerEl')), 'общие карты стола — не рубашка игрока');
});

test('«Так видят друзья» в игровых экранах нет', () => {
  for (const [n, src] of [['покер', POKER], ['дурак', DURAK], ['look-view', LOOK]]) {
    assert.ok(!/Так видят друзья/i.test(src), `${n}: блока «Так видят друзья» нет`);
  }
});

test('стол: слои под содержимым, центр не закрыт, стили плоские', () => {
  // Овал — первым ребёнком (под банком, картами и сиденьями).
  assert.match(POKER, /dressedFelt\(\),\s*centerEl\(s\),/);
  assert.match(DURAK, /dressedCloth\(\),\s*middleEl\(s\),/);
  const css = read('miniapp/collections-look.css');
  assert.ok(/\.gr-orn[^}]*pointer-events:\s*none/s.test(css) && /\.gr-dia[^}]*pointer-events:\s*none/s.test(css), 'слои не ловят нажатия');
  assert.ok(!/z-index:\s*[1-9]/.test(css.slice(css.indexOf('.gr-table'), css.indexOf('/* ------------------------------------------------------- рубашка'))), 'слои стола не поднимаются над содержимым');
  assert.ok(!/gradient|box-shadow|filter:|@import|url\(\s*['"]?https?:/.test(css), 'плоско, без градиентов, теней и внешних адресов');
  assert.ok(/prefers-reduced-motion/.test(css), 'есть правило для prefers-reduced-motion');
  assert.ok(/placeDiamond/.test(POKER) && /placeDiamond/.test(DURAK), 'ромб отходит от банка/карт');
});

test('look-view: при ошибке картинка убирается, а адрес запоминается (возврат к базе)', () => {
  const deco = LOOK.slice(LOOK.indexOf('function deco('), LOOK.indexOf('/**', LOOK.indexOf('function deco(')));
  assert.match(deco, /'error'[\s\S]*markFailed\(url\)[\s\S]*img\.remove\(\)/);
  const back = LOOK.slice(LOOK.indexOf('export function backImgFor'));
  assert.match(back, /'error'[\s\S]*markFailed\(b\.src\)[\s\S]*\/cards\/back\.svg/);
});
