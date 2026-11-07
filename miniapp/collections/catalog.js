import { withRaster, TALISMANS } from './raster.js';
/**
 * Каталог коллекции «Графит» — общий чистый модуль (без DOM и зависимостей).
 * Его читают и сервер (`bot/collections/**`), и клиент (`miniapp/collections/*`).
 * Контракт: `docs/graphit-launch/contracts.md`, раздел 1; источник цветов — `design/collections/SPEC.md`.
 *
 * Цены — ДЕМОНСТРАЦИОННЫЕ (Stars, из SPEC), владельцем не утверждены; в рабочем режиме
 * нигде не показываются. Идентификаторы — латиницей и навсегда.
 */
import { V2_ITEMS, V2_COLLECTIONS } from './v2-items.js';
export { V2_ITEMS };
export const COLLECTIONS = [{ id: 'graphit', title: 'Графит' }, ...V2_COLLECTIONS];
export const COLLECTION = { id: 'graphit', title: 'Графит' };

/** Порядок = порядок показа. */
export const COLORS = [
  { id: 'graphite', title: 'Графит', bg: '#20292E', ink: '#B6BEC2' },
  { id: 'sapphire', title: 'Сапфир', bg: '#15263E', ink: '#A6B5C8' },
  { id: 'bordeaux', title: 'Бордо', bg: '#3B202B', ink: '#C2A8B2' },
  { id: 'petrol', title: 'Петроль', bg: '#153538', ink: '#9FBFC0' },
];
export const DEFAULT_COLOR = 'graphite';

/** Что можно «надеть». */
export const LEGACY_SLOTS = ['cardback', 'table', 'profile'];
export const SLOTS = [...LEGACY_SLOTS, 'frame', 'badge', 'chess-board', 'checkers-board', 'nardy-board', 'battleship-panel', 'unoq-cardback', 'talisman'];

export const ITEMS = [
  { id: 'graphit-cardback', kind: 'item', slot: 'cardback', title: 'Рубашка «Графит»', games: ['poker'], visibility: 'owner-closed-cards', price: 99 },
  { id: 'graphit-table', kind: 'item', slot: 'table', title: 'Стол «Графит»', games: ['poker', 'durak'], visibility: 'room', price: 199 },
  { id: 'graphit-profile', kind: 'item', slot: 'profile', title: 'Знак «Графит»', games: ['lobby', 'results'], visibility: 'public-profile', price: 79 },
  { id: 'graphit-bundle', kind: 'bundle', title: 'Коллекция «Графит»', includes: ['graphit-cardback', 'graphit-table', 'graphit-profile'], price: 249 },
  ...V2_ITEMS.map(withRaster),
  ...TALISMANS,
];

/** Бесплатное базовое оформление: доступно всегда, id зарезервированы. */
export const BASE = {
  cardback: { id: 'base-cardback', title: 'Классика' },
  table: { id: 'base-table', title: 'Классика' },
  profile: { id: 'base-profile', title: 'Без оформления' },
  ...Object.fromEntries(SLOTS.filter((s) => !LEGACY_SLOTS.includes(s)).map((s) => [s, { id: `base-${s}`, title: 'Классика' }])),
};

const byId = new Map(ITEMS.map((x) => [x.id, x]));

/** Предмет или комплект строго по списку (не по префиксу, не по прототипу) либо null. */
export const itemById = (id) => (typeof id === 'string' ? byId.get(id) ?? null : null);
export const isColor = (id) => typeof id === 'string' && COLORS.some((c) => c.id === id);
/** 'cardback' | 'table' | 'profile' | null — для комплекта тоже null. */
export const slotOf = (itemId) => {
  const x = itemById(itemId);
  return x && x.kind === 'item' ? x.slot : null;
};
/** Список id предметов комплекта или []. */
export const itemsOfBundle = (bundleId) => {
  const x = itemById(bundleId);
  return x && x.kind === 'bundle' ? [...x.includes] : [];
};
/** Какие предметы комплекта в `ownedIds` отсутствуют. */
export const missingForBundle = (ownedIds, bundle = 'graphit-bundle') => {
  const have = new Set(ownedIds || []);
  return itemsOfBundle(bundle).filter((id) => !have.has(id));
};

/** Graphit colors and fixed v2 art are disjoint. No client URL/color is accepted. */
export const isItemColor = (item, color) => itemById(item)?.collection ? color === 'default' : !!itemById(item) && isColor(color);
export const publicEntry = (raw, slot, game = null) => {
  const it = itemById(raw?.item);
  return it?.kind === 'item' && (Array.isArray(slot) ? slot.includes(it.slot) : it.slot === slot) && isItemColor(it.id, raw.color) && (!game || it.games.includes(game)) ? { item: it.id, color: raw.color } : null;
};
