'use strict';
/**
 * Строка рекламы в сообщении «Поделиться»: что это за бот и куда идти. Одна
 * на все игры — новая игра дописывается сюда, а не в каждый render.js.
 */
export const PROMO_GAMES = 'шахматы, шашки, нарды, дурака, покер и UNOQ';

export const promoLine = (botUsername = '') => `Играем в ${PROMO_GAMES} прямо в Telegram${botUsername ? ` — @${botUsername}` : ''}`;
