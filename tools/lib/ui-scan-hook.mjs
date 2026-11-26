/**
 * Крючок для tools/preview.mjs во время автоскана вёрстки (запускает tools/ui-scan.mjs):
 *   - свои имена (обычные или «тяжёлые» — самые длинные и широкие, 16 букв);
 *   - добавочные сцены: то, чего нет в обычных снимках (магазин, профиль, рейтинг, чат,
 *     шторки, 8 игроков с числами в сотни миллионов, пустые списки, тренировка);
 *   - после каждого снимка — замеры (ui-scan-rules.mjs) в три положения прокрутки.
 *
 * Настройки приходят переменными окружения: UI_SCAN_NAMES=normal|long, UI_SCAN_ONLY=<рег.выр.>,
 * UI_SCAN_BREAK=<css> (проверка «на зубы»: заранее сломанная вёрстка).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as K from '../../bot/games/checkers/rules.js';
import * as ND from '../../bot/games/nardy/rules.js';
import * as UQ from '../../bot/games/colors/rules.js';
import * as C from '../../bot/games/chess/rules.js';
import { legalActions } from '../../server/game.js';
import { collect, analyze } from './ui-scan-rules.mjs';

const LONG = process.env.UI_SCAN_NAMES === 'long';
const ONLY = process.env.UI_SCAN_ONLY ? new RegExp(process.env.UI_SCAN_ONLY) : null;
const BREAK = process.env.UI_SCAN_BREAK || '';

/** Имя в игре — не длиннее 16 символов (cleanName): берём широкие буквы и слова без пробелов. */
const NORMAL = [[101, 'Иван'], [102, 'Артём'], [103, 'Макс'], [104, 'Дима'], [105, 'Саша'], [106, 'Лена'], [107, 'Ольга'], [108, 'Пётр']];
const WIDE = [[101, 'Константинопольс'], [102, 'Александра-Мария'], [103, 'ЖШЩМЮЖШЩМЮЖШЩМЮ'], [104, 'Ростислав Щукин'], [105, 'WWWWWWWWWWWWWWWW'], [106, 'Серафима Юрьевна'], [107, 'Святополк Мудрый'], [108, 'Её Величество 🏆']];
export const people = LONG ? WIDE : NORMAL;
export const appOptions = {};
export const pageOptions = { reducedMotion: 'reduce' };
export const skip = (s) => !!ONLY && !ONLY.test(s.name);

const results = [];
const errors = [];

export function extraScenes({ app, scene, table, play, durak, deck6, R, D, shuffledFor, playOut }) {
  const name = (id) => people.find(([i]) => i === id)[1];
  const title = LONG ? 'Покер по пятницам у Константина на даче' : 'Покер по пятницам';
  const chat = (() => { let n = -300000; return () => String(n--); })();

  /* ------------------------------------------------ хаб: пустой, полный, мои группы */
  const quiet = app.ensureGroup(chat(), title);
  scene('x01-hub-empty', null, 101, { start: `g_${quiet.code}` });

  const busyId = chat();
  const busy = app.ensureGroup(busyId, title);
  for (const [hid, game] of [[101, 'durak'], [102, 'poker'], [103, 'colors'], [104, 'chess'], [105, 'checkers'], [106, 'nardy'], [107, 'battleship']]) {
    app.createGame(game, { chatId: busyId, title, host: { id: hid, tgId: hid, name: name(hid), dm: 'ok' } });
  }
  scene('x02-hub-busy', null, 101, { start: `g_${busy.code}` });
  scene('x02б-hub-busy-guest', null, 108, { start: `g_${busy.code}` });

  /* ------------------------------------------------ профиль, рейтинг */
  const tab = (id) => async (page) => { await page.locator(`.nav-tab[data-tab="${id}"]`).click(); };
  scene('x03-profile', null, 101, { start: `g_${quiet.code}`, run: tab('settings') });
  scene('x03б-profile-bad-nick', null, 102, { start: `g_${quiet.code}`, run: async (page) => {
    await tab('settings')(page);
    await page.locator('.pf-field input').fill('@плохой ник.com');
    await page.locator('.pf-field input').blur();
  } });
  scene('x04-rating-tab', null, 101, { start: `g_${quiet.code}`, run: tab('rating') });
  const openRating = () => { app.setMaintenance(false); app.ratingSoon = false; app.rankedTablesSoon = false; };
  const closeRating = () => { app.ratingSoon = true; app.rankedTablesSoon = true; };
  scene('x04б-rating-pick', null, 101, { start: `g_${quiet.code}`, before: openRating, after: closeRating, run: tab('rating') });
  scene('x04в-rating-tables-empty', null, 101, { start: `g_${quiet.code}`, before: openRating, after: closeRating, run: async (page) => {
    await tab('rating')(page);
    await page.locator('.rk-games .rt-chip').first().click();
    await page.waitForTimeout(300);
  } });
  scene('x04г-leaderboard', null, 101, { start: `g_${quiet.code}`, before: openRating, after: closeRating, run: async (page) => {
    await tab('rating')(page);
    await page.locator('.rt-open').click();
    await page.waitForSelector('.rating .rt-head');
  } });

  /* ------------------------------------------------ магазин и «Мои вещи» */
  const shop = async (page) => { await tab('shop')(page); await page.waitForSelector('.col-show'); };
  const card = (id) => async (page) => { await shop(page); await page.locator(`.col-card[data-item="${id}"]`).click(); await page.waitForSelector('.col-item'); };
  const hubStart = { start: `g_${quiet.code}` };
  for (const [who, mark] of [[101, 'owner'], [102, 'guest']]) {
    scene(`x05-shop-${mark}`, null, who, { ...hubStart, run: shop });
    scene(`x05а-shop-item-${mark}`, null, who, { ...hubStart, run: card('sever-frame') });
    scene(`x05б-shop-inventory-${mark}`, null, who, { ...hubStart, run: async (page) => {
      await shop(page);
      await page.locator('.col-controls').getByRole('button', { name: 'Мои вещи', exact: true }).click();
      await page.waitForSelector('.col-inventory');
    } });
  }
  scene('x05в-shop-fit', null, 102, { ...hubStart, run: async (page) => {
    await card('sever-chess-board')(page);
    await page.getByRole('button', { name: 'Примерить', exact: true }).click();
    await page.waitForSelector('[data-sample="chess"]');
  } });
  scene('x05г-shop-bundle', null, 101, { ...hubStart, run: card('orbita-bundle') });
  scene('x05д-shop-equipped', null, 101, { ...hubStart, run: async (page) => {
    await card('orbita-bundle')(page);
    await page.getByRole('button', { name: 'Надеть комплект', exact: true }).click();
    await page.waitForTimeout(500);
  } });
  scene('x05е-shop-purchases', null, 102, { ...hubStart, run: async (page) => {
    await shop(page);
    await page.locator('[data-act="purchases"]').click();
    await page.waitForTimeout(500);
  } });
  scene('x05ж-shop-empty-filter', null, 101, { ...hubStart, run: async (page) => {
    await shop(page);
    await page.locator('[data-filter="collection"][data-value="talismans"]').click();
    await page.locator('[data-filter="game"]').selectOption('chess');
  } });

  /* ------------------------------------------------ покер на восемь с огромными числами */
  const big = (seed) => {
    const r = R.createRoom({ chatId: chat(), title, host: { id: 101, name: name(101), dm: 'ok' }, startingStack: 95_000_000, smallBlind: 500_000, bigBlind: 1_000_000 });
    for (const [id, nm] of people.slice(1)) R.addPlayer(r, { id, name: nm, dm: 'ok' });
    app.addRoom(r);
    return r;
  };
  scene('x06-poker-8-lobby', big(), 101);
  const bet = big();
  R.startGame(bet, '101');
  play(bet, (x) => x.hand.actorId === '101' && x.hand.log.length > 8, (x, id, l) => (l.canRaise && x.hand.currentBet < 6_000_000 ? ['raise', x.hand.currentBet + 1_000_000] : [l.canCheck ? 'check' : 'call']));
  scene('x06а-poker-8-bet', bet, 101);
  scene('x06б-poker-8-raise', bet, 101, { run: async (page) => { await page.getByRole('button', { name: /Raise|Bet/ }).first().click(); await page.waitForSelector('#sheet-root .sheet'); } });
  scene('x06в-poker-8-menu', bet, 101, { run: async (page) => { await page.getByRole('button', { name: 'Меню' }).click(); await page.waitForSelector('#sheet-root .sheet'); } });
  scene('x06г-poker-8-spectator', bet, 109);
  const show = big();
  R.startGame(show, '101');
  play(show, () => false, (x, id, l) => (l.canBet || l.canRaise ? ['allin'] : ['call']));
  if (show.status === 'finished') show.status = 'playing';
  scene('x06д-poker-8-showdown', show, 101);
  const done = big();
  R.startGame(done, '101');
  play(done, () => false, (x, id, l) => (l.canBet || l.canRaise ? ['allin'] : ['call']));
  R.endGame(done, '101');
  scene('x06е-poker-8-results', done, 101);

  /* ------------------------------------------------ чат и реакции за столом */
  const talk = table(4);
  R.startGame(talk, '101', { deck: () => deck6(talk) });
  scene('x07-chat', talk, talk.hand.actorId ? Number(talk.hand.actorId) : 101, { run: async (page) => {
    const say = (text) => page.evaluate(async (text) => (await import('/net.js')).send({ t: 'chat', text }, { lock: false }), text);
    await say('Всем привет! Играем до полуночи, потом расходимся.');
    await page.waitForTimeout(1200);
    await say('Оченьдлинноесловобезединогопробелачтобыпроверитьпереносстрокивчате'.repeat(2));
    await page.waitForTimeout(300);
    await page.locator('.chat-fab').click();
    await page.waitForSelector('.chat-panel');
    await page.waitForTimeout(300);
  } });

  /* ------------------------------------------------ дурак: большая рука, шторки */
  const full = durak(6);
  D.startGame(full, '101', { deck: () => shuffledFor(full, 11) });
  full.deal.hands['101'] = shuffledFor(full, 12).slice(0, 24);
  scene('x08-durak-big-hand', full, 101);
  scene('x08а-durak-menu', full, 101, { run: async (page) => { await page.getByRole('button', { name: 'Меню' }).click(); await page.waitForSelector('#sheet-root .sheet'); } });
  const lob = durak(2);
  scene('x08б-durak-settings', lob, 101, { run: async (page) => { await page.getByRole('button', { name: /^Настройки/ }).first().click(); await page.waitForSelector('#sheet-root .sheet'); } });

  /* ------------------------------------------------ UNOQ: лобби, стол, большая рука, итог */
  const uno = (n) => {
    const r = app.createGame('colors', { chatId: chat(), title, host: { id: 101, tgId: 101, name: name(101), dm: 'ok' } });
    for (const [id, nm] of people.slice(1, n)) UQ.addPlayer(r, { id, name: nm, dm: 'ok' });
    return r;
  };
  scene('x09-unoq-lobby', uno(4), 101);
  const un = uno(8);
  UQ.startGame(un, '101');
  scene('x09а-unoq-table-8', un, 101);
  scene('x09б-unoq-menu', un, 101, { run: async (page) => { await page.getByRole('button', { name: 'Меню' }).click(); await page.waitForSelector('#sheet-root .sheet'); } });
  const uh = uno(4);
  UQ.startGame(uh, '101');
  if (uh.deal?.hands?.['101']) uh.deal.hands['101'] = [...uh.deal.hands['101'], ...uh.deal.hands['102'], ...uh.deal.hands['103'], ...uh.deal.hands['104']];
  scene('x09в-unoq-big-hand', uh, 101);
  const uo = uno(4);
  UQ.startGame(uo, '101');
  UQ.endGame(uo, '101');
  scene('x09г-unoq-results', uo, 101);

  /* ------------------------------------------------ дуэли: меню и конец с длинными именами */
  const duel = (game, Rules) => {
    const r = app.createGame(game, { chatId: chat(), title, host: { id: 101, tgId: 101, name: name(101), dm: 'ok' }, settings: { base: 300, inc: 2, side: 'white' } });
    Rules.addPlayer(r, { id: 102, tgId: 102, name: name(102), dm: 'ok' });
    Rules.startGame(r, '101', { rand: () => 0.1 });
    return r;
  };
  for (const [game, Rules] of [['chess', C], ['checkers', K], ['nardy', ND]]) {
    const live = duel(game, Rules);
    scene(`x10-${game}-playing`, live, 101);
    scene(`x10а-${game}-menu`, live, 101, { run: async (page) => { await page.getByRole('button', { name: 'Меню' }).click(); await page.waitForSelector('#sheet-root .sheet'); } });
    const end = duel(game, Rules);
    Rules.resign(end, '102');
    scene(`x10б-${game}-over`, end, 101);
  }

  /* ------------------------------------------------ тренировка и обучение */
  const solo = { start: 'solo', click: 'Покер' };
  scene('x11-train', null, 105, { ...solo, press: ['Тренировка'] });
  scene('x11а-learn', null, 105, { ...solo, press: ['Обучение'] });
  scene('x11б-learn-lesson', null, 105, { ...solo, press: ['Обучение'], run: async (page) => {
    await page.locator('.ln-lesson-item').first().click();
    await page.waitForTimeout(400);
  } });

  /* ------------------------------------------------ турнир и отказ */
  scene('x12-tournament-create', null, 101, { start: `g_${quiet.code}`, run: async (page) => {
    await page.getByRole('button', { name: /Создать турнир/ }).first().click();
    await page.waitForSelector('#sheet-root .sheet');
  } });
  scene('x13-not-found', null, 101, { start: 'zzzzzz' });
}

/* ------------------------------------------------------------------ замеры */

async function measure(page, endShot) {
  if (BREAK) {
    await page.addStyleTag({ content: BREAK });
    await page.waitForTimeout(100);
  }
  const passes = [await page.evaluate(collect)];
  // Прокрутить всё, что листается вниз: то, что закрыто нижней панелью, должно хоть где-то открываться.
  for (const at of [0.5, 1]) {
    const moved = await page.evaluate((at) => {
      let n = 0;
      for (const el of document.querySelectorAll('body, body *')) {
        if (el.scrollHeight - el.clientHeight < 8) continue;
        if (!/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
        el.scrollTo({ top: (el.scrollHeight - el.clientHeight) * at, behavior: 'instant' });
        n++;
      }
      return n;
    }, at);
    if (!moved) break;
    await page.waitForTimeout(120);
    passes.push(await page.evaluate(collect));
    if (at === 1) await page.screenshot({ path: endShot }); // низ длинного экрана — смотреть глазами
  }
  return passes;
}

export async function inspect(page, s, out) {
  const passes = await measure(page, path.join(out, `${s.name}.end.png`));
  const findings = analyze(passes);
  const live = findings.filter((f) => !f.allowed);
  let marked = null;
  if (live.some((f) => f.severity !== 'minor')) {
    // Снимок с рамками вокруг проблемных мест (положение — как экран открылся).
    await page.evaluate((list) => {
      for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTo({ top: 0, behavior: 'instant' });
      list.forEach((f, i) => {
        const box = document.createElement('div');
        box.style.cssText = `position:fixed;left:${f.rect.l}px;top:${f.rect.t}px;width:${Math.max(4, f.rect.r - f.rect.l)}px;height:${Math.max(4, f.rect.b - f.rect.t)}px;outline:2px solid #ff00ff;z-index:2147483647;pointer-events:none;font:700 10px monospace;color:#ff00ff;`;
        box.textContent = String(i + 1);
        (document.querySelector('#sheet-root .sheet') ? document.getElementById('sheet-root') : document.body).append(box);
      });
    }, live.filter((f) => f.severity !== 'minor').slice(0, 30));
    await page.waitForTimeout(80);
    marked = `${s.name}.marked.png`;
    await page.screenshot({ path: path.join(out, marked) });
  }
  results.push({ scene: s.name, width: s.width, shot: `${s.name}.png`, marked, findings });
}

export async function failed(page, s, err, out) {
  await page.screenshot({ path: path.join(out, `${s.name}.fail.png`) }).catch(() => {});
  errors.push({ scene: s.name, width: s.width, error: String(err.message).split('\n')[0], shot: `${s.name}.fail.png` });
}

export function done({ junk, out }) {
  fs.writeFileSync(path.join(out, 'scan.json'), JSON.stringify({ names: LONG ? 'long' : 'normal', results, errors, junk }, null, 1));
}
