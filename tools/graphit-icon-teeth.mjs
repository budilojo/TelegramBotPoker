/**
 * «На зубы» для иконки на рабочий стол: ломаем код по одному месту, тесты (bot/homescreen.test.js) обязаны упасть.
 *   node tools/graphit-icon-teeth.mjs
 * Файлы возвращаются на место в любом случае.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const MOD = 'miniapp/homescreen.js';
const ROW = 'miniapp/homescreen-row.js';
const cases = [
  ['объявить успех без подтверждения (сразу после вызова)', MOD,
    "try { tg.addToHomeScreen(); }", "try { tg.addToHomeScreen(); set('added'); }"],
  ['показать «можно добавить» без метода/версии', MOD,
    "const supported = !!tg &&", "const supported = true || !!tg &&"],
  ['убрать таймаут ожидания (вечный спиннер)', MOD,
    "function arm(ms, fn) { stop(); timer = setTimer(fn, ms); }", "function arm(ms, fn) { stop(); }"],
  ['показывать подсказку автоматически (вызов add при показе строки)', ROW,
    "mine.start();\n  return host;", "mine.start();\n  setTimeout(() => mine.add(), 0);\n  return host;"],
  ['«не добавлено» после попытки считать успехом', MOD,
    "return ctx === 'verify' ? set('failed', 'declined') : set('can');", "return ctx === 'verify' ? set('added') : set('can');"],
  ['разрешить повторное нажатие в ожидании', MOD,
    "(state !== 'can' && state !== 'failed')", "(state === 'added')"],
];

let bad = 0;
for (const [name, file, from, to] of cases) {
  const orig = fs.readFileSync(file, 'utf8');
  if (!orig.includes(from)) { console.log(`НЕ НАЙДЕНО место для «${name}»`); bad++; continue; }
  try {
    fs.writeFileSync(file, orig.replace(from, to));
    const r = spawnSync(process.execPath, ['--test', '--disable-warning=ExperimentalWarning', 'bot/homescreen.test.js'], { encoding: 'utf8' });
    const fell = r.status !== 0;
    console.log(`${fell ? 'упал  ' : 'НЕ УПАЛ'} — ${name}`);
    if (!fell) bad++;
  } finally { fs.writeFileSync(file, orig); }
}
console.log(bad ? `ПРОВАЛ: ${bad}` : `все ${cases.length} поломок ловятся`);
process.exit(bad ? 1 : 0);
