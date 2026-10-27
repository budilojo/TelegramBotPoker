/**
 * Каталог коллекции «Графит» — общий чистый модуль (без DOM и зависимостей).
 * Его читают и сервер (`bot/collections/**`), и клиент (`miniapp/collections/*`).
 * Контракт: `docs/graphit-launch/contracts.md`, раздел 1; источник цветов — `design/collections/SPEC.md`.
 *
 * Цены — ДЕМОНСТРАЦИОННЫЕ (Stars, из SPEC), владельцем не утверждены; в рабочем режиме
 * нигде не показываются. Идентификаторы — латиницей и навсегда.
 */
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
export const SLOTS = ['cardback', 'table', 'profile'];

export const ITEMS = [
  { id: 'graphit-cardback', kind: 'item', slot: 'cardback', title: 'Рубашка «Графит»', games: ['poker'], visibility: 'owner-closed-cards', price: 99 },
  { id: 'graphit-table', kind: 'item', slot: 'table', title: 'Стол «Графит»', games: ['poker', 'durak'], visibility: 'room', price: 199 },
  { id: 'graphit-profile', kind: 'item', slot: 'profile', title: 'Знак «Графит»', games: ['lobby', 'results'], visibility: 'public-profile', price: 79 },
  { id: 'graphit-bundle', kind: 'bundle', title: 'Коллекция «Графит»', includes: ['graphit-cardback', 'graphit-table', 'graphit-profile'], price: 249 },
];

/** Бесплатное базовое оформление: доступно всегда, id зарезервированы. */
export const BASE = {
  cardback: { id: 'base-cardback', title: 'Классика' },
  table: { id: 'base-table', title: 'Классика' },
  profile: { id: 'base-profile', title: 'Без оформления' },
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
export const missingForBundle = (ownedIds) => {
  const have = new Set(ownedIds || []);
  return itemsOfBundle('graphit-bundle').filter((id) => !have.has(id));
};
