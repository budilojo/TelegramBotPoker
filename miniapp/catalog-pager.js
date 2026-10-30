/**
 * Страницы каталога игр — чистая логика (без DOM, проверяется в Node).
 * Список игр берётся из реестра, число игр нигде не зашито: страниц ноль, одна или много.
 */

/** Сколько карточек на странице: чем выше экран, тем больше, но не меньше 2 и не больше 4. */
export function perPage(viewportHeight) {
  const h = Number(viewportHeight);
  if (!Number.isFinite(h) || h <= 0) return 3;
  return Math.max(2, Math.min(4, Math.floor((h - 360) / 96)));
}

/** Разбить список на страницы по `per` карточек; пустой список — ноль страниц. */
export function paginate(items, per) {
  const list = Array.isArray(items) ? items : [];
  const n = Math.max(1, Math.floor(per) || 1);
  const pages = [];
  for (let i = 0; i < list.length; i += n) pages.push(list.slice(i, i + n));
  return pages;
}

/** Номер страницы, который существует: после смены размера экрана или набора игр позиция не вылетает. */
export const clampPage = (page, count) => (count <= 0 ? 0 : Math.min(count - 1, Math.max(0, Math.floor(Number(page)) || 0)));

/** Какая страница сейчас на экране по прокрутке трека (ширина страницы = ширине трека). */
export const pageAt = (scrollLeft, width, count) => (width > 0 ? clampPage(Math.round(scrollLeft / width), count) : 0);

/** Подпись индикатора для чтения вслух и для экрана. */
export const pageLabel = (page, count) => `Страница ${page + 1} из ${count}`;

/** Позиции по ключу (группа/экран): вернулись на хаб — открывается тот же лист. */
const memory = new Map();
export const rememberPage = (key, page) => { memory.set(key, page); };
export const recallPage = (key, count) => clampPage(memory.get(key) ?? 0, count);
export const forgetPages = () => memory.clear();
