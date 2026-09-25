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

export const GAMES = { poker, durak };

/** The order of the big cards on the hub's first screen. */
export const GAME_LIST = [poker, durak];

/** Rooms saved before the hub existed have no `game`: they are poker tables. */
export const gameOf = (room) => GAMES[room?.game] || poker;
