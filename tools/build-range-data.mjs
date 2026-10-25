/**
 * Сборка таблицы «эквити 169 стартовых рук против одной случайной руки».
 *
 *   node tools/build-range-data.mjs          пересчитать и записать miniapp/train/ranges/equity169.js
 *   node tools/build-range-data.mjs --check  пересчитать с другим зерном и сверить с записанным
 *
 * Откуда числа: Монте-Карло, бот-оценщик `strength` из bot/games/poker/bot.js,
 * фиксированное зерно, SIMS раздач на каждую руку. Эквити считается без
 * ничьей пополам: ничья идёт за 1/2. Погрешность ≈ ±0,2 п.п. (2σ) на 100 000
 * раздач. Это НЕ солвер и не «сила руки в игре»: это шанс против случайной
 * руки до открытия карт (AA ≈ 85 %, 72o ≈ 35 % — общеизвестные значения).
 * Клиент эти числа не считает — берёт готовые из equity169.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { equity } from '../bot/games/poker/bot.js';
import { ALL_HANDS, handCombos } from '../miniapp/train/ranges/hands.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'miniapp', 'train', 'ranges', 'equity169.js');
const SIMS = 100000;
const SEED = 20261025;

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeTable(seed = SEED, sims = SIMS) {
  const rng = mulberry32(seed);
  const table = {};
  for (const code of ALL_HANDS) {
    const hole = handCombos(code)[0]; // масти симметричны против случайной руки
    table[code] = Math.round(equity(hole, [], 1, sims, rng) * 10000) / 10000;
  }
  return table;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const t = computeTable(check ? SEED + 1 : SEED, check ? 40000 : SIMS);
  if (check) {
    const src = fs.readFileSync(OUT, 'utf8');
    let worst = 0;
    for (const code of ALL_HANDS) {
      const stored = Number(new RegExp(`"${code}": ([0-9.]+)`).exec(src)?.[1]);
      worst = Math.max(worst, Math.abs(stored - t[code]));
    }
    console.log(`наибольшее расхождение с записанным: ${(worst * 100).toFixed(2)} п.п.`);
    process.exit(worst < 0.015 ? 0 : 1);
  }
  const body = ALL_HANDS.map((c) => `  "${c}": ${t[c].toFixed(4)},`).join('\n');
  fs.writeFileSync(OUT, `/**
 * Эквити 169 стартовых рук против ОДНОЙ случайной руки до флопа (ничья = ½).
 * ФАЙЛ СОЗДАН СКРИПТОМ tools/build-range-data.mjs — руками не править.
 * Источник: Монте-Карло по ${SIMS} раздач на руку, зерно ${SEED}, оценщик
 * bot/games/poker/bot.js. Погрешность ≈ ±0,2 п.п. Учебное число, не солвер.
 */
export const EQUITY_META = { sims: ${SIMS}, seed: ${SEED}, opponents: 1 };
export const EQUITY169 = {
${body}
};
`);
  console.log('записано', OUT);
}
