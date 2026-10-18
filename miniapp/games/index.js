/**
 * Все игры клиента. Экраны (app.js), хаб группы (hub.js) и «Игры с ботами»
 * (solo.js) узнают об игре только отсюда: новая игра — файл рядом и строка
 * здесь.
 *
 * Что модуль игры выставляет: `onState`, `render` — экран; `lobby` — форма
 * нового лобби; `iconCards` — картинки карточки игры; `solo` — что
 * спрашивать в партии с ботами (`max` соперников, `blurb`, `duel` — цвет и
 * часы вместо числа соперников, `variants` — варианты правил).
 */
import * as poker from './poker.js';
import * as durak from './durak.js';
import * as colors from './colors.js';
import * as chess from './chess.js';
import * as checkers from './checkers.js';
import * as nardy from './nardy.js';

export const GAMES = { poker, durak, colors, chess, checkers, nardy };
