/**
 * Карта на экране — ТЕМ ЖЕ рисунком, что за столом: `/cards/<код>.svg`
 * (`miniapp/cards/`, код «AS», «10H»; тот же путь, что в `ui.js: cardImg`).
 * Новых карт не рисуем. Карта в задании — целое 0…51 (`poker-math.js`).
 */
import { el } from './dom.js';
import { cardCode, cardName, rankOf, suitOf, RED_SUITS } from '../poker-math.js';

/** Картинка карты. `back` — рубашка. */
export function cardEl(card, cls = '') {
  const back = card === 'back' || card == null;
  return el(`img.tm-card${cls ? '.' + cls : ''}`, {
    src: `/cards/${back ? 'back' : cardCode(card)}.svg`,
    alt: back ? 'карта' : cardName(card),
    draggable: 'false',
    width: 200,
    height: 280,
  });
}

/** Текстовое имя с цветом масти для разборов: «A♠». */
export function cardText(card) {
  const s = el('span.tm-ctext', cardName(card));
  if (RED_SUITS.includes(suitOf(card))) s.classList.add('red');
  return s;
}

export { rankOf, suitOf };
