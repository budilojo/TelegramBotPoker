/**
 * Шашки — экран партии. Пока только заготовка, чтобы игра была в реестре:
 * доска, ходы и окна — следующим шагом (план, этап 1.3).
 */
import { $app, h } from '../ui.js';

let state = null;

export function onState(s) {
  state = s;
}

export function render() {
  $app.append(h('div.lobby', h('h1', 'Шашки'), h('div.sub', state?.room?.notice || '')));
}

/** Что спрашивают при создании стола — как у шахмат: часы и цвет. */
export const lobby = {
  defaults: { base: 600, inc: 0, side: 'random' },
  fields: () => [],
};

/** Партия с ботом: цвет и часы вместо числа соперников. */
export const solo = { duel: true, blurb: 'Русские шашки против бота' };

/** Чем игра подписана в хабе: белая шашка и чёрная дамка. */
export const iconCards = ['/checkers/w.svg', '/checkers/bK.svg'];
