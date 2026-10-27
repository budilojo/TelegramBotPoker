/**
 * Реестр строк «Настроек». Каждая строка — функция `(state) => Element | null`;
 * `null` означает «ничего не рисовать». Строки показываются после существующих
 * блоков «Настроек», в порядке регистрации. Пока никто не зарегистрировался,
 * вид «Настроек» не меняется.
 */
import collectionsRow from './collections/settings-row.js';
import homescreenRow from './homescreen-row.js';

/** Порядок = порядок показа. */
export const ROWS = [collectionsRow, homescreenRow];

/** Список готовых элементов; пустые и сломанные строки молча пропускаются. */
export function settingsRows(state, rows = ROWS) {
  const out = [];
  for (const row of rows) {
    let el = null;
    try { el = row(state); } catch { el = null; }
    if (el != null && el !== false) out.push(el);
  }
  return out;
}
