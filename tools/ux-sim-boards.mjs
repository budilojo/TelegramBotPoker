/**
 * UX-симуляция досок: шахматы, шашки, нарды, морской бой. Ход тапом и
 * перетаскиванием, отказы, сдача/ничья/откат, расстановка и выстрел.
 *
 *   node tools/ux-sim-boards.mjs [--update] [--only=шахматы]
 */
import {
  runSim, observe, point, tapAt, drag, text, count, sheetTitle, buttonsOf, until, sleep,
} from './lib/ux-sim.mjs';

const PANEL = '.panel button';
const status = (p) => text(p, '.ch-status');

/* ---------------------------------------------------- шахматы и шашки */

const sq = (n) => `.ch-sq[data-sq="${n}"]`;
const marks = async (p) => ({ выбрано: await count(p, '.ch-sq.sel'), точек: await count(p, '.ch-sq.dot, .ch-sq.cap'), окно: await sheetTitle(p) });

async function board(s, game, { touch = false } = {}) {
  s.app[`${game}Rand`] = () => 0.1; // хост — белыми
  const t = await s.table(game, { touch, settings: { base: 0 } });
  for (const p of t.pages) await p.waitForSelector('.ch-board');
  await sleep(250);
  return { ...t, w: t.pages[0], b: t.pages[1] };
}
async function move(page, from, to) {
  await tapAt(page, await point(page, sq(from)));
  await tapAt(page, await point(page, sq(to)));
  await sleep(300);
}

const MOVES = {
  chess: { name: 'шахматы', from: 'e2', to: 'e4', bad: 'e5', reply: ['e7', 'e5'], their: 'e7', second: [['g1', 'f3'], ['b8', 'c6']] },
  checkers: { name: 'шашки', from: 'c3', to: 'd4', bad: 'c4', reply: ['f6', 'e5'], their: 'f6', second: [] },
};

const scenarios = [];
for (const [game, m] of Object.entries(MOVES)) {
  const n = m.name;
  for (const gesture of ['тап-тап', 'перетаскивание', 'перетаскивание пальцем', 'двойной тап по фигуре']) {
    scenarios.push([`${n}: ход — ${gesture}`, async (s) => {
      const touch = gesture.includes('пальцем');
      const t = await board(s, game, { touch });
      return observe(t.w, async () => {
        const a = await point(t.w, sq(m.from));
        const b = await point(t.w, sq(m.to));
        if (gesture === 'тап-тап') { await tapAt(t.w, a); await tapAt(t.w, b); }
        else if (gesture === 'двойной тап по фигуре') { await tapAt(t.w, a); await tapAt(t.w, a); }
        // Пальцем фигура рисуется выше пальца: палец отпускают ниже нужной клетки.
        else await drag(t.w, a, touch ? { x: b.x, y: b.y + 24 } : b, { touch });
      }, marks);
    }]);
  }
  scenarios.push(
    [`${n}: выбор фигуры — что подсвечено`, async (s) => {
      const t = await board(s, game);
      return observe(t.w, async () => tapAt(t.w, await point(t.w, sq(m.from))), async (p) => ({ ...(await marks(p)), строка: await status(p) }));
    }],
    [`${n}: ход в недопустимую клетку (что объясняют)`, async (s) => {
      const t = await board(s, game);
      return observe(t.w, () => move(t.w, m.from, m.bad), marks);
    }],
    [`${n}: тап в чужой ход (что объясняют)`, async (s) => {
      const t = await board(s, game);
      return observe(t.b, async () => tapAt(t.b, await point(t.b, sq(m.their))), async (p) => ({ ...(await marks(p)), строка: await status(p) }));
    }],
    [`${n}: кнопки партии до и после первых ходов`, async (s) => {
      const t = await board(s, game);
      const до = await buttonsOf(t.w, PANEL);
      await move(t.w, m.from, m.to);
      await move(t.b, ...m.reply);
      for (const [i, mv] of m.second.entries()) await move(i % 2 ? t.b : t.w, ...mv);
      return { до, после: { белые: await buttonsOf(t.w, PANEL), чёрные: await buttonsOf(t.b, PANEL) } };
    }],
    [`${n}: «Отменить» партию — подтверждение`, async (s) => {
      const t = await board(s, game);
      const out = await observe(t.w, () => t.w.locator(PANEL, { hasText: 'Отменить' }).click(), async (p) => ({ окно: await sheetTitle(p), кнопки: await buttonsOf(p, '#sheet-root button') }));
      return out;
    }],
    [`${n}: «Ничья» — одно касание, ответ соперника`, async (s) => {
      const t = await board(s, game);
      await move(t.w, m.from, m.to);
      await move(t.b, ...m.reply);
      const предложить = await observe(t.w, () => t.w.locator(PANEL, { hasText: 'Ничья' }).click(), async (p) => ({ строка: await status(p), окно: await sheetTitle(p) }));
      await sleep(300);
      return { предложить, соперник: { строка: await status(t.b), окно: await sheetTitle(t.b), кнопки: await buttonsOf(t.b, '.ch-offer-btns button') } };
    }],
    [`${n}: «Откат» — одно касание, ответ соперника`, async (s) => {
      const t = await board(s, game);
      await move(t.w, m.from, m.to);
      const просьба = await observe(t.w, () => t.w.locator(PANEL, { hasText: 'Откат' }).click(), async (p) => ({ строка: await status(p) }));
      await sleep(400);
      return { просьба, соперник: { строка: await status(t.b), окно: await sheetTitle(t.b), кнопки: await buttonsOf(t.b, '#sheet-root button, .ch-offer-btns button') } };
    }],
    [`${n}: «Сдаться» — подтверждение и экран итога`, async (s) => {
      const t = await board(s, game);
      await move(t.w, m.from, m.to);
      await move(t.b, ...m.reply);
      for (const [i, mv] of m.second.entries()) await move(i % 2 ? t.b : t.w, ...mv);
      const кнопка = t.w.locator(PANEL, { hasText: 'Сдаться' });
      if (!(await кнопка.count())) return { нет_кнопки: await buttonsOf(t.w, PANEL) };
      const окно = await observe(t.w, () => кнопка.click(), async (p) => ({ окно: await sheetTitle(p), кнопки: await buttonsOf(p, '#sheet-root button') }));
      await t.w.locator('#sheet-root button.danger').click();
      await sleep(600);
      return { окно, итог: { строка: await status(t.w), кнопки: await buttonsOf(t.w, PANEL) } };
    }],
  );
}

scenarios.push(['шашки: обязательный бой — тап по другой шашке', async (s) => {
  const t = await board(s, 'checkers');
  await move(t.w, 'c3', 'd4');
  await move(t.b, 'f6', 'e5');
  const кольца = await count(t.w, '.ch-sq.ck-must');
  const тап = await observe(t.w, async () => tapAt(t.w, await point(t.w, sq('g3'))), marks);
  return { колец: кольца, тап };
}]);

/* -------------------------------------------------------------- нарды */

const pt = (p) => `.nd-pt[data-p="${p}"]`;
const ndLook = async (p) => ({ строка: await status(p), кнопки: await buttonsOf(p, PANEL), точек: await count(p, '[data-p].dot') });

async function nardy(s, { rolled = true, touch = false } = {}) {
  s.app.nardyRand = () => 0.1;
  const queue = [[5, 3], [4, 2]];
  s.app.nardyDice = () => queue.shift() || [2, 1];
  const t = await s.table('nardy', { touch, settings: { base: 0 } });
  for (const p of t.pages) await p.waitForSelector('.nd-board');
  await sleep(300);
  const w = t.pages[0];
  if (!rolled) return { ...t, w };
  const roll = w.locator('.nd-roll');
  if (await roll.count()) { await roll.click(); await sleep(400); }
  const heads = await w.locator('.nd-pt.can').evaluateAll((els) => els.map((e) => e.dataset.p));
  return { ...t, w, head: heads[0] };
}
/** Куда ведёт ход на 5 с головы (первая подсвеченная точка с числом 5). */
async function targetOf(page, head, die = '5') {
  await tapAt(page, await point(page, pt(head), { x: 10, y: 20 }));
  const to = await page.evaluate((die) => [...document.querySelectorAll('[data-p].dot')].find((e) => e.querySelector('.nd-die')?.textContent === die)?.dataset.p, die);
  await tapAt(page, await point(page, pt(head), { x: 10, y: 20 })); // снять выбор
  return to;
}

scenarios.push(['нарды: начало хода — кубики бросаются сами или кнопкой', async (s) => {
  const t = await nardy(s, { rolled: false });
  return { первый_ход: await ndLook(t.w), кубики: await count(t.w, '.nd-dicef') };
}]);
for (const gesture of ['тап-тап', 'перетаскивание', 'двойной тап по шашке']) {
  scenarios.push([`нарды: шаг — ${gesture}`, async (s) => {
    const t = await nardy(s);
    const to = await targetOf(t.w, t.head);
    return observe(t.w, async () => {
      const a = await point(t.w, `${pt(t.head)} .nd-stack .nd-pc, ${pt(t.head)}`);
      const b = await point(t.w, pt(to));
      if (gesture === 'тап-тап') { await tapAt(t.w, a); await tapAt(t.w, b); }
      else if (gesture === 'перетаскивание') await drag(t.w, a, b);
      else { await tapAt(t.w, a); await tapAt(t.w, a); }
    }, ndLook);
  }]);
}
scenarios.push(
  ['нарды: тап по чужой/занятой шашке (что объясняют)', async (s) => {
    const t = await nardy(s);
    const free = await t.w.evaluate(() => [...document.querySelectorAll('.nd-pt')].find((e) => !e.querySelector('.nd-pc'))?.dataset.p);
    return observe(t.w, async () => tapAt(t.w, await point(t.w, pt(free))), ndLook);
  }],
  ['нарды: ход целиком, «Вернуть» и «Готово»', async (s) => {
    const t = await nardy(s);
    for (const die of ['5', '3']) {
      const from = (await t.w.locator('.nd-pt.can').evaluateAll((els) => els.map((e) => e.dataset.p)));
      let done = false;
      for (const f of from) {
        await tapAt(t.w, await point(t.w, pt(f), { x: 10, y: 20 }));
        const to = await t.w.evaluate((die) => [...document.querySelectorAll('[data-p].dot')].find((e) => e.querySelector('.nd-die')?.textContent === die)?.dataset.p, die);
        if (to != null) { await tapAt(t.w, await point(t.w, pt(to))); done = true; await sleep(400); break; }
        await tapAt(t.w, await point(t.w, pt(f), { x: 10, y: 20 }));
      }
      if (!done) break;
    }
    const сыграно = await ndLook(t.w);
    const вернуть = await observe(t.w, () => t.w.locator(PANEL, { hasText: 'Вернуть' }).click(), ndLook);
    return { сыграно, вернуть };
  }],
  ['нарды: «Отменить»/«Сдаться» и чего нет по сравнению с шахматами', async (s) => {
    const t = await nardy(s);
    const кнопки = await buttonsOf(t.w, PANEL);
    const отменить = t.w.locator(PANEL, { hasText: /Отменить|Сдаться/ });
    const окно = await observe(t.w, () => отменить.click(), async (p) => ({ окно: await sheetTitle(p), кнопки: await buttonsOf(p, '#sheet-root button') }));
    return { кнопки, окно };
  }],
);

/* -------------------------------------------------------- морской бой */

const ship = '.bs-grid:not(.mini) .bs-ship';
const cell = (c) => `.bs-grid:not(.mini) .bs-cell[data-c="${c}"]`;
const bsLook = async (p) => ({
  кораблей_на_поле: await count(p, ship),
  строка: await status(p),
  выбор: await text(p, '.bs-seltext'),
});

async function bs(s, { touch = false, width } = {}) {
  s.app.battleshipRand = () => 0.1;
  const t = await s.table('battleship', { touch, width, settings: { base: 0 } });
  for (const p of t.pages) await p.waitForSelector('.bs-tray');
  await sleep(300);
  return { ...t, a: t.pages[0], b: t.pages[1] };
}
const tray = (len) => `.bs-tray-ship[data-len="${len}"]`;

scenarios.push(
  ['морской бой: экран расстановки', async (s) => {
    const t = await bs(s);
    return { ...(await bsLook(t.a)), кнопки: await buttonsOf(t.a, `${PANEL}, .bs-rot`) };
  }],
  ['морской бой: клетка без выбранного корабля', async (s) => {
    const t = await bs(s);
    return observe(t.a, async () => tapAt(t.a, await point(t.a, cell(0))), bsLook);
  }],
  ['морской бой: тап по лотку, тап по клетке, тап по кораблю (поворот)', async (s) => {
    const t = await bs(s);
    await tapAt(t.a, await point(t.a, tray(4)));
    const поставить = await observe(t.a, async () => tapAt(t.a, await point(t.a, cell(0))), bsLook);
    const клетки = () => t.a.locator(ship).first().evaluate((e) => `${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
    const до = await клетки();
    const повторный = await observe(t.a, async () => tapAt(t.a, await point(t.a, cell(0))), bsLook);
    return { поставить, повторный_тап: { ...повторный, размер: `${до} → ${await клетки()}` } };
  }],
  ['морской бой: перетащить корабль из лотка и обратно', async (s) => {
    const t = await bs(s);
    const поле = await observe(t.a, async () => drag(t.a, await point(t.a, tray(4)), await point(t.a, cell(22))), bsLook);
    const убрать = await observe(t.a, async () => drag(t.a, await point(t.a, cell(22)), await point(t.a, '.ch-status')), bsLook);
    return { поле, убрать };
  }],
  ['морской бой: «Расставить случайно», «Очистить», «Я готов»', async (s) => {
    const t = await bs(s);
    const случайно = await observe(t.a, () => t.a.locator(PANEL, { hasText: 'Расставить случайно' }).click(), bsLook);
    await sleep(400);
    const стало = await bsLook(t.a);
    const очистить = await observe(t.a, () => t.a.locator(PANEL, { hasText: 'Очистить' }).click(), async (p) => ({ ...(await bsLook(p)), окно: await sheetTitle(p) }));
    await t.a.locator(PANEL, { hasText: 'Расставить случайно' }).click();
    await sleep(500);
    const готов = await observe(t.a, () => t.a.locator(PANEL, { hasText: 'Я готов' }).click(), async (p) => ({ окно: await sheetTitle(p), строка: await status(p), кнопки: await buttonsOf(p, PANEL) }));
    return { случайно, стало, очистить, готов };
  }],
);

async function battle(s, opts) {
  const t = await bs(s, opts);
  for (const p of t.pages) {
    await p.locator(PANEL, { hasText: 'Расставить случайно' }).click();
    await sleep(500);
    await p.locator(PANEL, { hasText: 'Я готов' }).click();
    await sleep(300);
  }
  await until(async () => (await t.a.locator('.bs-aim').count()) > 0, 'бой начался');
  await sleep(400);
  let me = null;
  await until(async () => {
    for (const p of t.pages) if (await p.locator('.ch-status.mine').count()) { me = p; return true; }
    return false;
  }, 'чей-то выстрел');
  return { ...t, me, other: t.pages.find((p) => p !== me) };
}
const aim = '.bs-grid:not(.mini) .bs-cell';
const shotLook = async (p) => ({ строка_есть: !!(await status(p)), окно: await sheetTitle(p) });

scenarios.push(
  ['морской бой: выстрел — одно касание', async (s) => {
    const t = await battle(s);
    return observe(t.me, async () => tapAt(t.me, await point(t.me, `${aim}[data-c="0"]`)), shotLook);
  }],
  ['морской бой: касание в чужой ход (что объясняют)', async (s) => {
    const t = await battle(s);
    return observe(t.other, async () => tapAt(t.other, await point(t.other, `${aim}[data-c="0"]`)), shotLook);
  }],
  ['морской бой: кнопки боя', async (s) => {
    const t = await battle(s);
    return { мой_ход: await buttonsOf(t.me, PANEL), чужой: await buttonsOf(t.other, PANEL), меню: await (async () => {
      await t.me.locator('[aria-label="Меню"]').click();
      return buttonsOf(t.me, '#sheet-root .menu-item');
    })() };
  }],
);

await runSim('доски', scenarios);
