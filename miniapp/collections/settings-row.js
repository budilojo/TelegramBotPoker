/**
 * Строка «Коллекции» в «Настройках» (реестр miniapp/settings-rows.js).
 * Показывается ТОЛЬКО когда сервер прислал enabled && (demo || shop); иначе — null: никакой точки входа.
 * Модуль не тянет DOM и экраны при загрузке (реестр проверяется в Node): экраны подгружаются по нажатию.
 */
import { store, noteOf } from './state.js';

export default function collectionsRow(/* state */) {
  if (!store.visible) return null;
  const mk = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };
  const row = mk('button', 'set-row col-entry');
  row.type = 'button';
  row.dataset.entry = 'collections';
  const body = mk('div', 'set-body');
  body.append(mk('div', 'set-title', 'Коллекции'), mk('div', 'set-sub', noteOf(store.snapshot())));
  const arrow = mk('span', 'col-entry-go', '›');
  arrow.setAttribute('aria-hidden', 'true');
  row.append(body, arrow);
  row.addEventListener('click', () => { import('./index.js').then((m) => m.open()); });
  return row;
}
