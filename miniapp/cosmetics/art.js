/**
 * Картинки косметики: откуда берётся файл вещи. Без DOM и без ui.js, чтобы ui.js мог импортировать.
 *
 * Пока настоящих файлов владельца нет (`REAL_ART = false`), берутся плоские заглушки TEMP из
 * `placeholder/` — без запросов к ещё не существующим PNG (так делает и витрина L).
 * Когда файлы лежат в `miniapp/cosmetics/night-casino/`, команда «подключить косметику»
 * ставит `REAL_ART = true`; у вещи при этом `file` — настоящий путь.
 */
import { itemById } from './catalog.js';
import { getLook } from './look.js';

export const REAL_ART = false;

/** Адрес картинки вещи (заглушка, пока нет настоящей); у звания и набора картинки нет — null. */
export function artSrc(item) {
  const it = typeof item === 'string' ? itemById(item) : item;
  if (!it) return null;
  if (REAL_ART && it.file) return it.file;
  return it.placeholder || null;
}

/** Рубашка, выбранная в «виде», или null — тогда стандартная `/cards/back.svg`. */
export function cardBackSrc() {
  return artSrc(getLook().cardback);
}

export const DEFAULT_BACK = '/cards/back.svg';
