'use strict';
/**
 * Реестр игр: ядро узнаёт об игре только из модуля и из реестров. Здесь —
 * что новая игра, добавленная одной строкой в `bot/games/index.js` и
 * `miniapp/games/index.js`, получает всё остальное сама: быструю команду,
 * строку в меню «/», своё название, экран, форму лобби, картинки и форму
 * партии с ботами. И что раздача (колода, жребий) приходит из модуля игры,
 * а не из ветки `room.game === …` в ядре.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAMES, GAME_LIST } from './games/index.js';
import { App, QUICK_GAMES, QUICK_MENU } from './app.js';
import { Table, user } from './harness.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('быстрые команды собираются из модулей: прежние плюс /checkers, и только к существующим играм', () => {
  assert.deepEqual(QUICK_GAMES, { durak: 'durak', unoq: 'colors', colors: 'colors', chess: 'chess', checkers: 'checkers' });
  for (const [cmd, id] of Object.entries(QUICK_GAMES)) {
    assert.ok(GAMES[id], `/${cmd} ведёт в игру ${id}, а её нет`);
    assert.match(cmd, /^[a-z0-9_]{1,32}$/, `/${cmd}: команды Telegram — латиницей`);
  }
  // Покер живёт на /poker и /newgame — быстрой командой его не перехватить.
  assert.equal(QUICK_GAMES.poker, undefined);
  assert.equal(QUICK_GAMES.game, undefined);
});

test('меню «/» в группе: у каждой команды описание, скрытый псевдоним /colors в меню не попадает', () => {
  assert.deepEqual(QUICK_MENU.map(([c]) => c), ['durak', 'unoq', 'chess', 'checkers']);
  for (const [cmd, about] of QUICK_MENU) assert.ok(about && about.length <= 256, `/${cmd}: описание`);
  // Меню бота берёт команды отсюда, а не держит свой список.
  assert.match(read('bot/index.js'), /\.\.\.QUICK_MENU/);
});

test('/unoq и /colors в группе открывают лобби UNOQ, /chess — шахмат, /durak — дурака', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  await t.start(ivan);
  const lobbies = (game) => [...t.app.rooms.values()].filter((r) => r.game === game && r.status === 'lobby');
  await t.cmd(ivan, '/colors');
  assert.equal(lobbies('colors').length, 1, '/colors — старое имя UNOQ');
  await t.cmd(user(202, 'Макс'), '/unoq');
  assert.equal(lobbies('colors').length, 2);
  await t.cmd(ivan, '/chess');
  assert.equal(lobbies('chess').length, 1);
  await t.cmd(ivan, '/durak');
  assert.equal(lobbies('durak').length, 1);
});

test('раздача приходит из модуля игры: ядро не знает, что подменяют шахматам и дураку', () => {
  const app = new App({});
  const chessRand = () => 0.3;
  const durakDeck = () => ['6S'];
  const deck = () => ['AS'];
  Object.assign(app, { chessRand, durakDeck, deck });
  assert.equal(app.dealOpts({ game: 'chess' }).rand, chessRand);
  assert.deepEqual(app.dealOpts({ game: 'durak' }).deck(), ['6S']);
  assert.deepEqual(app.dealOpts({ game: 'poker' }).deck(), ['AS']);
  // Без подмены — настоящая случайность: модуль ничего не подставляет.
  const plain = new App({});
  assert.deepEqual(plain.dealOpts({ game: 'chess' }), {});
  assert.deepEqual(plain.dealOpts({ game: 'durak' }), {});
  // В ядре не осталось веток под конкретную игру.
  const core = read('bot/app.js');
  const body = core.slice(core.indexOf('  dealOpts(room) {'), core.indexOf('\n  }\n', core.indexOf('  dealOpts(room) {')));
  assert.doesNotMatch(body, /room\.game ===/);
});

test('у каждой игры сервера есть экран клиента со всем, что берут хаб и «Игры с ботами»', () => {
  const index = read('miniapp/games/index.js');
  const exported = /export const GAMES = \{([^}]*)\}/.exec(index)[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(exported.sort(), GAME_LIST.map((g) => g.id).sort());
  for (const g of GAME_LIST) {
    assert.match(index, new RegExp(`import \\* as ${g.id} from './${g.id}\\.js'`), `${g.id}: нет в miniapp/games/index.js`);
    const src = read(`miniapp/games/${g.id}.js`);
    for (const name of ['onState', 'render']) assert.match(src, new RegExp(`export function ${name}\\b`), `${g.id}: нет ${name}`);
    for (const name of ['lobby', 'iconCards', 'solo']) assert.match(src, new RegExp(`export const ${name}\\b`), `${g.id}: нет ${name}`);
    assert.ok(g.title, `${g.id}: нет названия`);
  }
  // Экраны, хаб и «Игры с ботами» берут игры из реестра, а не перечисляют их.
  for (const f of ['miniapp/app.js', 'miniapp/hub.js', 'miniapp/solo.js']) {
    const src = read(f);
    assert.match(src, /from '\.\/games\/index\.js'/, `${f}: не из реестра`);
    assert.doesNotMatch(src, /from '\.\/games\/(poker|durak|colors|chess)\.js'/, `${f}: игра напрямую`);
    assert.doesNotMatch(src, /\.id === '(chess|durak|colors)'|game === '(chess|durak|colors)'/, `${f}: ветка под игру`);
  }
});
