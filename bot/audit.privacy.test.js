'use strict';
/**
 * Аудит, фаза 2 (C): приватность методом «невмешательства».
 *
 * Не «есть ли в трафике чужая карта», а сильнее: два стола, которые
 * различаются ТОЛЬКО тем, чего человек знать не может, обязаны дать ему
 * побайтно одинаковый трафик. Любое различие — утечка, даже косвенная
 * (статус стола, длина списка, итоги, стек).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, stack } from './harness.js';

/* --------------------------------------- C-01: олл-ин, который кончает игру */

/**
 * Хедз-ап: у Ивана короткий стек, олл-ин префлоп, Макс отвечает. Флоп и тёрн
 * одинаковые, различается только ривер: на одном столе Иван выигрывает и
 * игра продолжается, на другом — проигрывает всё, и игра кончается.
 */
async function allInHeadsUp(river) {
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс'), spy: user(303, 'Зритель') };
  const t = new Table({ runoutStepMs: 1500 });
  t.useDeck(stack({ 101: 'As Ah', 202: 'Kd Kc' }, `Qs 9h 4d 3c ${river}`));
  await t.seat({ ivan: cast.ivan, max: cast.max }, { blinds: [25, 50] });
  const ivan = t.room.players.find((p) => p.id === '101');
  ivan.stack = 2000;
  ivan.stats.buyIn = 2000;
  t.page(cast.spy);
  await t.send(cast.ivan, { t: 'start' });
  // Хедз-ап: кнопка — малый блайнд, ходит первым.
  for (let i = 0; i < 4 && t.room.hand.phase === 'betting'; i++) {
    const who = t.actorOf(cast);
    const l = t.state(who).legal;
    await t.act(who, l.canBet || l.canRaise ? 'allin' : 'call');
  }
  return { t, cast };
}

/** Всё, что телефон получил, — по кадрам. */
const frames = (t, u) => t.page(u).inbox.filter((m) => m.t === 'state')
  .map((m) => JSON.parse(JSON.stringify(m.state).replaceAll(t.room.code, 'КОД')));

test('АУДИТ C-01: покер — пока борд олл-ина открывается, никто не узнаёт, что игра кончилась и кто выиграл', async () => {
  const win = await allInHeadsUp('8s'); // Иван (AA) выигрывает — игра идёт дальше
  const lose = await allInHeadsUp('Kh'); // сет королей у Макса — Иван выбывает, игра кончилась
  assert.equal(win.t.room.status, 'playing', 'на первом столе игра продолжается');
  assert.equal(lose.t.room.status, 'finished', 'на втором — закончилась (в памяти сервера)');
  assert.equal(win.t.room.hand.revealing ?? true, true);

  // Шаг за шагом открываем борд — флоп, тёрн — и сравниваем всё, что ушло.
  for (let step = 0; step < 3; step++) {
    for (const u of Object.values(win.cast)) {
      const a = frames(win.t, u);
      const b = frames(lose.t, u);
      assert.equal(a.length, b.length, `${u.first_name}, шаг ${step}: разное число кадров`);
      for (let i = 0; i < a.length; i++) {
        if (a[i].hand?.revealing === false) continue; // ривер вышел — дальше итоги законны
        assert.deepEqual(b[i], a[i], `${u.first_name}, кадр ${i}: телефон узнал исход до ривера`);
      }
    }
    assert.equal(lose.t.text().replaceAll(lose.t.room.code, 'КОД'), win.t.text().replaceAll(win.t.room.code, 'КОД'), `шаг ${step}: карточка в группе выдала исход до ривера`);
    if (win.t.room.ui.reveal?.shown >= 4) break;
    await win.t.advance(1500);
    await lose.t.advance(1500);
    if (!win.t.room.ui.reveal) break; // ривер вышел
  }
  // А после ривера — честные итоги.
  await lose.t.advance(10_000);
  assert.equal(lose.t.state(lose.cast.max).room.status, 'finished');
  assert.ok(lose.t.state(lose.cast.max).results, 'итоги после ривера есть');
  assert.match(lose.t.lastPost(), /ИТОГИ/);
});

/* -------------------------- фаззер невмешательства: короткий прогон для CI */

import { runGame } from '../tools/fuzz-privacy.mjs';

const SEEDS = Number(process.env.AUDIT_SEEDS || 4);
for (const game of ['poker', 'durak', 'colors', 'battleship']) {
  test(`АУДИТ C: ${game} — вид каждого телефона, карточка и хаб не зависят от скрытого (${SEEDS} партий)`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = await runGame(game, seed);
      assert.ok(r.steps > 5, `${game} зерно ${seed}: партия не пошла (${r.steps} перерисовок)`);
    }
  });
}
