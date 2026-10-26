/** Общий каталог страницы и сервера. Без DOM; id вещей не переименовывать. */
export const SETS = [{
  id: 'night-casino', title: 'Ночной казино-клуб',
  blurb: 'Бархат, фишки и неон — соберите свой вечер за столом.', order: 1,
}];

const item = (id, kind, title, blurb, file, a, b, extra = {}) => ({
  id, set: 'night-casino', kind, title, blurb,
  file: `/cosmetics/night-casino/${file}.png`,
  placeholder: `/cosmetics/placeholder/${file}.svg`,
  stars: { a, b }, free: false, ...extra,
});

export const ITEMS = [
  item('nc-back-1', 'cardback', 'Чёрный бархат', 'Тёмная рубашка с неоновой каймой и четырьмя мастями.', 'back-1', 50, 75),
  item('nc-back-2', 'cardback', 'Рулетка', 'Красное и чёрное колесо на обороте каждой карты.', 'back-2', 50, 75),
  item('nc-felt-1', 'felt', 'Бордовый бархат', 'Глубокое бордо для спокойного вечера за столом.', 'felt-1', 75, 100, { tokens: { felt: '#4a0f1f' } }),
  item('nc-frame-1', 'frame', 'Неоновая вывеска', 'Розовые и бирюзовые трубки вокруг вашего аватара.', 'frame-1', 50, 75),
  item('nc-frame-2', 'frame', 'Венок из фишек', 'Кольцо из фишек — маленький стол вокруг вашего портрета.', 'frame-2', 50, 75),
  item('nc-react-1', 'reaction', 'Джекпот', 'Три семёрки для момента, когда всё сошлось.', 'react-1', 15, 25),
  item('nc-react-2', 'reaction', 'Покер-фейс', 'Тёмные очки. Ни одной лишней эмоции.', 'react-2', 15, 25),
  item('nc-react-3', 'reaction', 'Тильт', 'Пар из ушей — когда карты решили пошутить.', 'react-3', 15, 25),
  item('nc-fx-win', 'effect', 'Дождь из фишек', 'Фишки и звёзды отмечают вашу победу.', 'fx-chip', 15, 25),
  item('nc-title-1', 'title', 'Крупье', 'Короткое звание рядом с вашим ником.', 'title-1', 15, 25, { file: null }),
];

// bundle — дополнение контракта L ↔ M: items содержит id всех десяти вещей.
ITEMS.push(item('nc-bundle', 'bundle', 'Весь ночной клуб',
  'Все десять вещей набора. Для примерки — первая рубашка и первая рамка.',
  'bundle', 265, 395, { file: null, items: ITEMS.map((x) => x.id) }));

const byId = new Map(ITEMS.map((x) => [x.id, x]));
export const itemById = (id) => typeof id === 'string' ? byId.get(id) ?? null : null;
export const itemsOfSet = (id) => ITEMS.filter((x) => x.set === id);
export const isItem = (id) => itemById(id) !== null;
