'use strict';
/**
 * Набор эмодзи (miniapp/emoji/manifest.json) — контракт для чата и реакций.
 * Проверяется сам манифест и файлы; «на зубы» — подменой данных (см. конец файла).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAMES } from './games/index.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'miniapp', 'emoji');
const MAX_FILE = 12 * 1024, MAX_TOTAL = 700 * 1024, MAX_LABEL = 18;
const read = () => JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

/** Все проверки; возвращает список нарушений (пустой — всё хорошо). */
export function problems(m, dir = DIR) {
  const bad = [];
  if (m.version !== 1) bad.push('version должен быть 1');
  if (!Array.isArray(m.sets) || !m.sets.length) return [...bad, 'нет наборов'];
  const ids = new Set(), setIds = new Set();
  let total = 0, quick = 0;
  for (const s of m.sets) {
    if (!/^[a-z][a-z0-9-]*$/.test(s.id || '')) bad.push(`набор: плохой id ${s.id}`);
    if (setIds.has(s.id)) bad.push(`набор ${s.id} повторяется`);
    setIds.add(s.id);
    if (!s.title) bad.push(`набор ${s.id}: нет названия`);
    if (s.games !== '*' && !(Array.isArray(s.games) && s.games.length && s.games.every((g) => GAMES[g])))
      bad.push(`набор ${s.id}: games — «*» или игры из реестра`);
    if (!s.items?.length) bad.push(`набор ${s.id}: пуст`);
    for (const it of s.items || []) {
      if (!/^[a-z][a-z0-9-]*$/.test(it.id || '')) bad.push(`смайлик: плохой id ${it.id}`);
      if (ids.has(it.id)) bad.push(`id ${it.id} повторяется`);
      ids.add(it.id);
      if (!it.label || [...it.label].length > MAX_LABEL) bad.push(`${it.id}: подпись пуста или длиннее ${MAX_LABEL}`);
      if (it.file !== `${s.id}/${it.id}.png`) bad.push(`${it.id}: file должен быть ${s.id}/${it.id}.png`);
      if (it.quick && s.id !== 'universal') bad.push(`${it.id}: быстрые — только в universal`);
      if (it.quick) quick++;
      const f = path.join(dir, it.file || '');
      if (!fs.existsSync(f)) { bad.push(`${it.id}: нет файла`); continue; }
      const b = fs.readFileSync(f);
      total += b.length;
      if (b.length > MAX_FILE) bad.push(`${it.id}: ${b.length} байт > ${MAX_FILE}`);
      if (b.subarray(1, 4).toString() !== 'PNG') { bad.push(`${it.id}: не PNG`); continue; }
      const ct = b[25], w = b.readUInt32BE(16), h = b.readUInt32BE(20);
      if (w !== 128 || h !== 128) bad.push(`${it.id}: размер ${w}×${h}, нужно 128×128`);
      const transparent = ct === 6 || ct === 4 || (ct === 3 && b.includes('tRNS')) ;
      if (!transparent) bad.push(`${it.id}: нет прозрачности`);
    }
  }
  const uni = m.sets.find((s) => s.id === 'universal');
  if (!uni) bad.push('нет набора universal');
  else if (uni.games !== '*') bad.push('universal должен быть для всех игр');
  if (quick < 3 || quick > 6) bad.push(`быстрых ${quick}, нужно от 3 до 6`);
  if (total > MAX_TOTAL) bad.push(`весь набор ${total} байт > ${MAX_TOTAL}`);
  return bad;
}

test('манифест эмодзи валиден, файлы на месте и в бюджете', () => {
  assert.deepEqual(problems(read()), []);
});

test('на зубы: подмена id, лишний файл, раздутый и чужой файл, плохие подписи и игры — всё ловится', () => {
  const clone = () => structuredClone(read());
  let m = clone(); m.sets[0].items[1].id = m.sets[0].items[0].id;
  assert.ok(problems(m).length, 'повторный id пропущен');
  m = clone(); m.sets[0].items[0].file = 'universal/net.png';
  assert.ok(problems(m).length, 'несуществующий файл пропущен');
  m = clone(); m.sets[0].items[0].label = 'очень длинная подпись смайлика';
  assert.ok(problems(m).length, 'длинная подпись пропущена');
  m = clone(); m.sets[1].games = ['tetris'];
  assert.ok(problems(m).length, 'неизвестная игра пропущена');
  m = clone(); m.sets[0].items.forEach((i) => { delete i.quick; });
  assert.ok(problems(m).length, 'нет быстрых — пропущено');
  m = clone(); m.sets[1].items[0].quick = true;
  assert.ok(problems(m).length, 'быстрый вне universal пропущен');
  // раздутый и «не PNG» файл — во временной папке
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'emoji-'));
  try {
    fs.cpSync(DIR, tmp, { recursive: true });
    const f = path.join(tmp, 'universal', 'gg.png');
    const orig = fs.readFileSync(f);
    fs.writeFileSync(f, Buffer.concat([orig, Buffer.alloc(MAX_FILE)]));
    assert.ok(problems(read(), tmp).some((p) => p.includes('gg')), 'раздутый файл пропущен');
    fs.writeFileSync(f, Buffer.from('GIF89a not a png'));
    assert.ok(problems(read(), tmp).some((p) => p.includes('gg')), 'не-PNG пропущен');
    fs.rmSync(f);
    assert.ok(problems(read(), tmp).some((p) => p.includes('нет файла')), 'удалённый файл пропущен');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
