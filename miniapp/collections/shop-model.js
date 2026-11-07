/** Shop projections use the one shared catalog; they never grant ownership. */
import { COLLECTIONS, ITEMS, itemsOfBundle, itemById } from './catalog.js';
export const GAMES = [['poker', 'Покер'], ['durak', 'Дурак'], ['colors', 'UNOQ'], ['chess', 'Шахматы'], ['checkers', 'Шашки'], ['nardy', 'Нарды'], ['battleship', 'Морской бой']];
export const COLLECTION_FILTERS = [['', 'Все'], ...['sever', 'obsidian', 'chertezh'].map(id => [id, COLLECTIONS.find(c => c.id === id).title]), ['talismans', 'Талисманы']];
export const CATEGORIES = [['cards', 'Карты'], ['tables', 'Столы'], ['boards', 'Доски'], ['profile', 'Профиль'], ['bundles', 'Комплекты']];
export const categoryOf = it => it.kind === 'bundle' ? 'bundles' : it.slot === 'talisman' ? 'talismans' : ['cardback', 'unoq-cardback'].includes(it.slot) ? 'cards' : it.slot === 'table' ? 'tables' : ['profile', 'frame', 'badge'].includes(it.slot) ? 'profile' : 'boards';
export const collectionOf = it => it.collection || 'graphit';
export function gamesOf(it) {
  if (!it) return [];
  if (it.kind === 'bundle') return [...new Set(itemsOfBundle(it.id).flatMap(id => gamesOf(itemById(id))))];
  // Legacy paired Graphit profile has exactly its original two-game scope.
  return it.slot === 'profile' ? ['poker', 'durak'] : it.games.filter(g => GAMES.some(([id]) => id === g));
}
export const gameNames = it => gamesOf(it).map(id => GAMES.find(([g]) => g === id)[1]).join(' · ');
export const personal = slot => ['cardback', 'profile', 'frame', 'badge', 'talisman'].includes(slot);
const SOURCE_NAMES = new Map([['owner', 'Доступ владельца · бесплатно'], ['purchase', 'Покупка'], ['admin', 'Подарок владельца'], ['demo', 'Демонстрация'], ['staff', 'Служебный доступ']]);
export const sourceText = sources => (sources || []).map(s => SOURCE_NAMES.get(s)).filter(Boolean).join(' · ');
export function filteredItems({ game = '', category = '', collection = '' } = {}, items = ITEMS) {
  return items.filter(it => (!game || gamesOf(it).includes(game)) && (!category || categoryOf(it) === category)
    && (!collection || (collection === 'talismans' ? it.slot === 'talisman' : collectionOf(it) === collection)));
}
