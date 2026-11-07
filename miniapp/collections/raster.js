/** Runtime overlays for the six approved series. The original SVG atlas is kept for older clients. */
export const RASTER_COLLECTIONS = new Map([
  ['sever', { title: 'Ледяной берег', description: 'Матовый жетон с контуром северного берега.', alternate: ['Полярный знак', 'Треугольный жетон с северной звездой.'] }],
  ['obsidian', { title: 'Скол обсидиана', description: 'Тёмный жетон с гравировкой по линии скола.', alternate: ['Вулканический пласт', 'Шестигранник с прорезанной минеральной жилой.'] }],
  ['chertezh', { title: 'Угольник', description: 'Синий жетон с метками сборочного чертежа.', alternate: ['Калибр', 'Круглый жетон с кольцами технической разметки.'] }],
  ['terracotta', { title: 'Печная арка', description: 'Круглая глиняная печать с рельефной аркой.', alternate: ['Солнечный черепок', 'Треугольный жетон из обожжённой глины со ступенчатым солнцем.'] }],
  ['orbita', { title: 'Затмение', description: 'Круглый жетон с дугами затмения.', alternate: ['Дальняя орбита', 'Продолговатый жетон с кольцом и точкой спутника.'] }],
  ['porcelain', { title: 'Ивовая ветвь', description: 'Светлый фигурный медальон с синей ветвью.', alternate: ['Фарфоровый ромб', 'Белый жетон с тонким рисунком ивы.'] }],
]);

const TYPE = {
  cardback: 'cardback', 'unoq-cardback': 'cardback', table: 'table', frame: 'frame', badge: 'badge',
  'chess-board': 'board', 'checkers-board': 'board', 'nardy-board': 'board', 'battleship-panel': 'board',
  talisman: 'talisman',
};
const SURFACE_DESCRIPTION = {
  table: 'Цвет и рисунок всей игровой поверхности.',
  'chess-board': 'Цвет и фактура светлых и тёмных клеток, фон координат.',
  'checkers-board': 'Цвет и фактура светлых и тёмных клеток, фон координат.',
  'nardy-board': 'Фактурное основание, контрастные клинья и центральная перегородка.',
  'battleship-panel': 'Фактура воды, линии сетки и фон координат обоих полей.',
  'unoq-cardback': 'Рубашка стопки добора и оформление игровой поверхности UNOQ.',
};
const url = (collection, type) => `/collections/raster/${collection}-${type}.webp`;

export function withRaster(item) {
  if (!RASTER_COLLECTIONS.has(item.collection)) return item;
  const src = url(item.collection, item.artType ?? TYPE[item.slot] ?? 'cardback');
  const game = item.kind === 'bundle' ? null : src;
  return { ...item, description: SURFACE_DESCRIPTION[item.slot] ?? item.description, assets: { preview: src, game }, preview: src, game };
}

export const TALISMANS = [...RASTER_COLLECTIONS].flatMap(([collection, { title, description, alternate }]) =>
  [[title, description, 'talisman'], [...alternate, 'talisman-alt']].map(([title, description, artType]) => withRaster({
    id: `${collection}-${artType}`, collection, kind: 'item', slot: 'talisman', artType,
    games: ['poker', 'durak'], visibility: 'owner-table', title, description, price: null,
  })));
