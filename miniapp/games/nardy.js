/**
 * Нарды — экран партии. Пока заготовка, чтобы игра была в реестре: доска,
 * кубики и ходы — следующим шагом (план, этап 2.4).
 */
import { $app, h } from '../ui.js';

let state = null;

export function onState(s) {
  state = s;
}

export function render() {
  $app.append(h('div.lobby', h('h1', 'Нарды'), h('div.sub', state?.room?.notice || '')));
}

export const lobby = {
  defaults: { base: 600, inc: 0, side: 'random' },
  fields: () => [],
};

export const solo = { duel: true, blurb: 'Длинные нарды против бота' };

export const iconCards = [];
