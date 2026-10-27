/**
 * «На зубы» для оформления «Графит» на игровых экранах: ломаем код ровно так, как сломал бы человек,
 * и убеждаемся, что проверки краснеют. После каждой поломки файл возвращается как был.
 *
 *   node tools/graphit-screens-teeth.mjs            поломка → быстрые проверки; если не покраснели — ещё и браузерные
 *   node tools/graphit-screens-teeth.mjs --full     и быстрые, и браузерные всегда (долго, ~10 минут)
 *   node tools/graphit-screens-teeth.mjs --only 2   одна поломка по номеру
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FULL = process.argv.includes('--full');
const ONLY = process.argv.includes('--only') ? Number(process.argv[process.argv.indexOf('--only') + 1]) : null;

const BREAKS = [
  {
    name: 'вид меняется посреди раздачи (держатель снимка всегда берёт свежее)',
    file: 'miniapp/collections/look-view.js',
    from: 'const sameDeal = kept && kept.roomKey === roomKey && kept.dealNo === dealNo && status !== \'lobby\';',
    to: 'const sameDeal = false;',
  },
  {
    name: 'лицо собственной карты заменено рубашкой',
    file: 'miniapp/games/poker.js',
    from: 'const img = dealIn(cardImg(c), hd, me.seat, k);',
    to: 'const img = dealIn(backFor(me.seat), hd, me.seat, k);',
  },
  {
    name: 'рамка показана в самой партии (на местах стола)',
    file: 'miniapp/games/poker.js',
    from: '  const av = avatarEl(p);\n  if (win) {',
    to: '  const av = frameAvatar(avatarEl(p), p.frame);\n  if (win) {',
  },
  {
    name: 'при ошибке файла не возвращаемся к базе (битая картинка остаётся)',
    file: 'miniapp/collections/look-view.js',
    from: "img.addEventListener('error', () => { markFailed(url); img.remove(); onFail?.(); }, { once: true });",
    to: "img.addEventListener('error', () => { onFail?.(); }, { once: true });",
  },
  {
    name: 'центр стола закрыт (ромб лежит под банком и не отодвигается)',
    file: 'miniapp/collections/look-view.js',
    from: 'const SPOTS = [0.78, 0.9, 0.66, 0.5, 0.34, 0.22, 0.1];',
    to: 'const SPOTS = [0.5];',
    also: { from: 'if (rects.some((r) => r.left < box.r', to: 'if (false && rects.some((r) => r.left < box.r' },
  },
  {
    name: 'в игре показан блок «Так видят друзья»',
    file: 'miniapp/games/poker.js',
    from: "h('div.top-meta', meta),",
    to: "h('div.top-meta', meta), h('div.friends', 'Так видят друзья'),",
  },
];

const run = (args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: ROOT, encoding: 'utf8', env: process.env });
const unit = () => run(['--test', 'bot/collections.screens.test.js']);
const e2e = () => run(['tools/e2e-collections-look.mjs']);

let bad = 0;
const rows = [];
BREAKS.forEach((b, i) => {
  if (ONLY && ONLY !== i + 1) return;
  const file = path.join(ROOT, b.file);
  const original = fs.readFileSync(file, 'utf8');
  try {
    let broken = original;
    for (const { from, to } of [b, b.also].filter(Boolean)) {
      if (!broken.includes(from)) throw new Error(`поломка ${i + 1}: не найден фрагмент «${from.slice(0, 50)}…» — код изменился, обновите скрипт`);
      broken = broken.replace(from, to);
    }
    fs.writeFileSync(file, broken);
    const u = unit();
    const unitRed = u.status !== 0;
    let e2eRed = null;
    if (FULL || !unitRed) e2eRed = e2e().status !== 0;
    const caught = unitRed || e2eRed;
    rows.push(`| ${i + 1} | ${b.name} | быстрые: ${unitRed ? 'упали' : 'прошли'}${e2eRed === null ? '' : `; браузер: ${e2eRed ? 'упал' : 'прошёл'}`} | ${caught ? 'да' : 'НЕТ'} |`);
    if (!caught) bad++;
  } finally {
    fs.writeFileSync(file, original);
  }
});
console.log('| № | Поломка | Что покраснело | Поймана |\n|---|---|---|---|\n' + rows.join('\n'));
const back = run(['--test', 'bot/collections.screens.test.js']);
console.log(`после возврата кода быстрые проверки: ${back.status === 0 ? 'зелёные' : 'КРАСНЫЕ'}`);
process.exit(bad || back.status !== 0 ? 1 : 0);
