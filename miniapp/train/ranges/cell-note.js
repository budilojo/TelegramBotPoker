/**
 * Подпись к руке на матрице разбора: «AKs — туз-король одной масти, 4 комбинации. Входит в диапазон
 * всегда». Чистая функция без DOM: её читает виджет `reveal.js` и проверяют тесты.
 * `ref` — диапазон в форме ответа матрицы: массив рук или { рука: частота 0…1 }.
 */
import { handInfo, combosOf, freqOf } from './hands.js';
import { handName, classify } from './data.js';

const toSet = (ref) => {
  if (!ref) return new Map();
  if (Array.isArray(ref)) return new Set(ref);
  return new Map(Object.entries(ref).filter(([, f]) => f > 0));
};
const pl = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);

export function cellNote(code, ref, { title = 'диапазон' } = {}) {
  if (!handInfo(code)) return '';
  const n = combosOf(code);
  const f = freqOf(toSet(ref), code);
  const head = `${code} — ${handName(code)}, ${n} ${pl(n, 'комбинация', 'комбинации', 'комбинаций')}.`;
  const kind = classify(code).label;
  const state = f >= 1 ? `Входит в «${title}» всегда.`
    : f > 0 ? `Входит в «${title}» иногда: примерно в ${Math.round(f * 100)} % случаев.`
      : `Не входит в «${title}».`;
  return `${head} ${state} Это ${kind}.`;
}
