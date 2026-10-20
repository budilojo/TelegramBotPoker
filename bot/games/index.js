'use strict';
/**
 * Every game the hub offers. The core (app.js, hub.js) knows games only
 * through this list: a new game is a new folder next to these and one line
 * here — nothing in the core changes.
 *
 * What a game module is, part by part, is in docs/game-hub.md ("Модуль
 * игры"); poker/index.js is the reference.
 */
import poker from './poker/index.js';
import durak from './durak/index.js';
import colors from './colors/index.js';
import chess from './chess/index.js';
import checkers from './checkers/index.js';
import nardy from './nardy/index.js';
import battleship from './battleship/index.js';

/**
 * Игра-черновик (`draft: true` в модуле) — ещё не готова для людей: её нет ни в
 * хабе, ни в командах, ни в «Играх с ботами», столы с ней не создать. Её видят
 * только тесты и проверки (`DRAFT_GAMES=1`, так их запускает `npm test`).
 * Выкатка увозит код, но не игру — пока с модуля не снята пометка.
 */
export const DRAFTS_ON = process.env.DRAFT_GAMES === '1';
const ALL = [poker, durak, colors, chess, checkers, nardy, battleship];

/** The order of the big cards on the hub's first screen. */
export const GAME_LIST = ALL.filter((g) => !g.draft || DRAFTS_ON);

export const GAMES = Object.fromEntries(GAME_LIST.map((g) => [g.id, g]));

/** Скрытые сейчас черновики: их столы из базы не читаются (и не стираются). */
export const HIDDEN_DRAFTS = new Set(ALL.filter((g) => !GAME_LIST.includes(g)).map((g) => g.id));

/** Rooms saved before the hub existed have no `game`: they are poker tables. */
export const gameOf = (room) => GAMES[room?.game] || poker;
