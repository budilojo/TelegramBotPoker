/**
 * UX-симуляция карточных игр: дурак, UNOQ, покер. Каждое главное действие
 * пробуется разными жестами с чистого стола; записывается, что сработало.
 *
 *   node tools/ux-sim-cards.mjs [--update] [--only=дурак]
 */
import {
  runSim, observe, point, tapAt, drag, text, count, sheetTitle, buttonsOf, until, sleep,
} from './lib/ux-sim.mjs';
import { durakStack, colorsStack } from '../bot/harness.js';

/* ------------------------------------------------------------------ дурак */

const A = '6C 6D 9H 9S JH QH';
const B = '7D 8D 7C 10S JS QS';
const CARD = { x: 7, y: 24 };
const dk = (c) => `.dk-card[data-card="${c}"]`;

/** Стол дурака: Иван ходит (у него 6♣ козырь), Макс отбивается. */
async function durak(s, { variant, bHand = B, touch = false } = {}) {
  s.app.durakDeck = durakStack({ 1000: A, 1001: bHand }, { trump: 'AC' });
  const t = await s.table('durak', { touch, settings: variant ? { variant } : null });
  const [a, b] = t.pages;
  await a.waitForSelector('.dk-hand .dk-card');
  await b.waitForSelector('.dk-hand .dk-card');
  return { ...t, a, b };
}
/** …и 6♦ уже на столе: Макс отбивается. */
async function attacked(s, opts) {
  const t = await durak(s, opts);
  const p = await point(t.a, dk('6D'), CARD);
  await tapAt(t.a, p, opts);
  await tapAt(t.a, p, opts);
  await until(() => t.room.deal.table.length === 1, 'атака легла');
  await t.b.waitForSelector('.dk-pair');
  await sleep(250);
  return t;
}

const picked = (card) => async (p) => ({
  поднята: await p.locator(`${dk(card)} img.picked`).count() === 1,
  подсвечено_целей: await count(p, '.dk-pair.target'),
  строка: await text(p, '.dk-line'),
  под_столом: await text(p, '.panel'),
});

/** Один жест над картой: tap / tap2 / drag на цель / тап карты и тап цели. */
function cardGesture(page, card, gesture, target, { touch = false } = {}) {
  return async () => {
    const from = await point(page, dk(card), CARD);
    if (gesture === 'drag') return drag(page, from, await point(page, target), { touch });
    await tapAt(page, from, { touch });
    if (gesture === 'tap2') await tapAt(page, await point(page, dk(card), CARD), { touch });
    if (gesture === 'tap-цель') await tapAt(page, await point(page, target), { touch });
  };
}

const durakScenarios = [];
for (const gesture of ['tap', 'tap2', 'drag']) {
  durakScenarios.push([`дурак: атака — ${gesture}`, async (s) => {
    const t = await durak(s);
    return observe(t.a, cardGesture(t.a, '6D', gesture, '.dk-mid'), picked('6D'));
  }]);
}
for (const gesture of ['tap', 'tap2', 'drag', 'tap-цель']) {
  durakScenarios.push([`дурак: защита (одна цель) — ${gesture}`, async (s) => {
    const t = await attacked(s);
    return observe(t.b, cardGesture(t.b, '7D', gesture, '.dk-pair[data-i="0"]'), picked('7D'));
  }]);
}
durakScenarios.push(
  ['дурак: защита — перетаскивание пальцем', async (s) => {
    const t = await attacked(s, { touch: true });
    return observe(t.b, cardGesture(t.b, '7D', 'drag', '.dk-pair[data-i="0"]', { touch: true }), picked('7D'));
  }],
  ['дурак: защита неподходящей картой — два тапа (что объясняют)', async (s) => {
    const t = await attacked(s);
    return observe(t.b, cardGesture(t.b, '10S', 'tap2'), picked('10S'));
  }],
  ['дурак: защита неподходящей картой — перетащить', async (s) => {
    const t = await attacked(s);
    return observe(t.b, cardGesture(t.b, '10S', 'drag', '.dk-pair[data-i="0"]'), picked('10S'));
  }],
  ['дурак: подкидывание — tap2', async (s) => {
    const t = await attacked(s);
    await drag(t.b, await point(t.b, dk('7D'), CARD), await point(t.b, '.dk-pair[data-i="0"]'));
    await until(() => !!t.room.deal.table[0].d, 'побита');
    await t.a.waitForSelector('.dk-pair.covered');
    await sleep(250);
    return observe(t.a, cardGesture(t.a, '6C', 'tap2'), picked('6C'));
  }],
  ['дурак: «взять» — одно касание', async (s) => {
    const t = await attacked(s);
    const кнопки = await buttonsOf(t.b, '.panel button');
    return { кнопки, ...(await observe(t.b, () => t.b.getByRole('button', { name: /ВЗЯТЬ/ }).click(), async (p) => ({ окно_подтверждения: await sheetTitle(p) }))) };
  }],
  ['дурак: «бито» — одно касание', async (s) => {
    const t = await attacked(s);
    await drag(t.b, await point(t.b, dk('7D'), CARD), await point(t.b, '.dk-pair[data-i="0"]'));
    await until(() => !!t.room.deal.table[0].d, 'побита');
    await t.a.waitForSelector('.panel button:has-text("БИТО")');
    const подсказка = await text(t.a, '.dk-line');
    return { подсказка, ...(await observe(t.a, () => t.a.getByRole('button', { name: /БИТО/ }).click())) };
  }],
);
for (const [name, gestures] of [['кнопка «Перевести» без выбора', null], ['tap2 по карте перевода', 'tap2'], ['карта, затем «Перевести»', 'button']]) {
  durakScenarios.push([`дурак: перевод — ${name}`, async (s) => {
    const t = await attacked(s, { variant: 'perevodnoy', bHand: '6H 8D 7C 10S JS QS' });
    const look = picked('6H');
    if (gestures === 'tap2') return observe(t.b, cardGesture(t.b, '6H', 'tap2'), look);
    if (gestures === 'button') await tapAt(t.b, await point(t.b, dk('6H'), CARD));
    return observe(t.b, () => t.b.getByRole('button', { name: /ПЕРЕВЕСТИ/ }).click(), look);
  }]);
}

/* ------------------------------------------------------------------- UNOQ */

const HAND = 'R1 R5 WC G3 B4 Y7';
const cl = (c) => `.cl-card[data-card="${c}"]`;

async function colors(s, { hand = HAND, deck = 'G9 B9', touch = false } = {}) {
  s.app.colorsDeck = colorsStack({ 1000: hand, 1001: hand.replace('WC', 'WF') }, { top: 'R0', deck });
  const t = await s.table('colors', { touch });
  await t.pages[0].waitForSelector('.cl-card');
  const id = t.room.deal.order?.[t.room.deal.turn] ?? t.room.deal.turn;
  let me = null;
  await until(async () => {
    for (const p of t.pages) if (await p.locator('.cl-hero.turn').count()) { me = p; return true; }
    return false;
  }, `чей-то ход (${id})`);
  await sleep(300);
  return { ...t, me, other: t.pages.find((p) => p !== me) };
}

const clLook = async (p) => ({ окно: await sheetTitle(p), роль: await text(p, '.cl-role') });
const clGesture = (page, card, gesture) => async () => {
  const from = await point(page, cl(card), { x: 8, y: 30 });
  if (gesture === 'drag на стол') return drag(page, from, await point(page, '.cl-pile'));
  if (gesture === 'увести в сторону') return drag(page, from, { x: from.x + 150, y: from.y });
  await tapAt(page, from);
  if (gesture === 'tap2') await tapAt(page, from);
};

const colorsScenarios = [];
for (const gesture of ['tap', 'drag на стол', 'увести в сторону']) {
  colorsScenarios.push([`UNOQ: сыграть карту — ${gesture}`, async (s) => {
    const t = await colors(s);
    return observe(t.me, clGesture(t.me, 'R5', gesture), clLook);
  }]);
}
colorsScenarios.push(
  ['UNOQ: неподходящая карта — tap (что объясняют)', async (s) => {
    const t = await colors(s);
    return observe(t.me, clGesture(t.me, 'G3', 'tap'), clLook);
  }],
  ['UNOQ: чужой ход — tap', async (s) => {
    const t = await colors(s);
    return observe(t.other, clGesture(t.other, 'R5', 'tap'), clLook);
  }],
  ['UNOQ: дикая карта — выбор цвета', async (s) => {
    const t = await colors(s);
    const wild = (await t.me.locator(cl('WC')).count()) ? 'WC' : 'WF';
    const open = await observe(t.me, clGesture(t.me, wild, 'tap'), clLook);
    const варианты = await buttonsOf(t.me, '#sheet-root button');
    const pick = await observe(t.me, () => t.me.locator('.cl-pick-btn').first().click());
    return { касаний: 2, открытие: open, варианты, выбор: pick };
  }],
  ['UNOQ: добор тапом по колоде, когда есть чем ходить', async (s) => {
    const t = await colors(s);
    return observe(t.me, () => t.me.locator('.cl-deck').click({ force: true }), async (p) => ({ кнопки: await buttonsOf(p, '.cl-panel button') }));
  }],
  ['UNOQ: добор кнопкой и «передать ход»', async (s) => {
    const t = await colors(s);
    const кнопки = await buttonsOf(t.me, '.cl-panel button');
    const btn = t.me.getByRole('button', { name: /^Взять/ });
    if (!(await btn.count())) return { кнопки };
    const добор = await observe(t.me, () => btn.click());
    await sleep(400);
    return { кнопки, добор, после: { роль: await text(t.me, '.cl-role'), кнопки: await buttonsOf(t.me, '.cl-panel button') } };
  }],
  ['UNOQ: нечем ходить — подсказка, добор по колоде, дальше', async (s) => {
    const t = await colors(s, { hand: 'G3 G4 B5 B7 Y1 Y2 G5', deck: 'G9 B9' });
    const wild = t.pages.indexOf(t.me) === 1; // у второго в руке «+4» вместо дикой нет — руки без диких
    const до = { второй: wild, роль: await text(t.me, '.cl-role'), кнопки: await buttonsOf(t.me, '.cl-panel button') };
    const добор = await observe(t.me, () => t.me.locator('.cl-deck').click({ force: true }));
    await sleep(500);
    return { до: { роль: до.роль, кнопки: до.кнопки }, добор, после: { роль: await text(t.me, '.cl-role'), кнопки: await buttonsOf(t.me, '.cl-panel button') } };
  }],
  ['UNOQ: выкрик при двух картах', async (s) => {
    // По одной карте до двух в руке не дойти без долгой партии: смотрим, что
    // есть на панели, когда рука поставлена напрямую в две карты.
    const t = await colors(s);
    const d = t.room.deal;
    const uid = t.users[t.pages.indexOf(t.me)].id;
    d.hands[String(uid)] = ['R1', 'R5'];
    t.room.seq++;
    s.app.hub.broadcast(t.room);
    await sleep(500);
    const до = await buttonsOf(t.me, '.cl-panel button');
    const ход = await observe(t.me, clGesture(t.me, 'R5', 'tap'));
    await sleep(500);
    return { до, ход, после: await buttonsOf(t.me, '.cl-panel button'), соперник: await buttonsOf(t.other, '.cl-panel button') };
  }],
);

/* ------------------------------------------------------------------ покер */

const PK = '.panel.poker-actions button';

async function poker(s, { settings = null } = {}) {
  const t = await s.table('poker', { settings });
  let me = null;
  await until(async () => {
    for (const p of t.pages) if (await p.locator(PK).count()) { me = p; return true; }
    return false;
  }, 'чей-то ход');
  await sleep(400);
  return { ...t, me, other: t.pages.find((p) => p !== me) };
}
const pkLook = async (p) => ({ кнопки: await buttonsOf(p, PK), окно: await sheetTitle(p) });
const press = (p, name) => () => p.locator(PK, { hasText: name }).first().click();
/** Первый ход сыгран коллом: у большого блайнда бесплатный Check. */
async function freeCheck(s) {
  const t = await poker(s);
  await press(t.me, 'Call')();
  await t.other.waitForSelector(`${PK}:has-text("Check")`);
  await sleep(300);
  return t;
}
async function raiseSheet(s) {
  const t = await poker(s);
  await press(t.me, /Raise|Bet/)();
  await t.me.waitForSelector('.sheet .sheet-confirm button');
  return t;
}

const pokerScenarios = [
  ['покер: Call — одно касание', async (s) => {
    const t = await poker(s);
    const кнопки = await buttonsOf(t.me, PK);
    return { кнопки, ...(await observe(t.me, press(t.me, 'Call'))) };
  }],
  ['покер: Fold против ставки — одно касание', async (s) => {
    const t = await poker(s);
    return observe(t.me, press(t.me, 'Fold'), pkLook);
  }],
  ['покер: Check — одно касание', async (s) => {
    const t = await freeCheck(s);
    return observe(t.other, press(t.other, 'Check'));
  }],
  ['покер: Fold при бесплатном Check — первое и второе касание', async (s) => {
    const t = await freeCheck(s);
    const первое = await observe(t.other, press(t.other, 'Fold'), pkLook);
    const второе = await observe(t.other, press(t.other, 'Fold'));
    return { первое, второе };
  }],
  ['покер: Raise — открыть окно', async (s) => {
    const t = await raiseSheet(s);
    return { окно: await sheetTitle(t.me), кнопки: await buttonsOf(t.me, '#sheet-root button') };
  }],
  ['покер: Raise — готовый размер (одно касание)', async (s) => {
    const t = await raiseSheet(s);
    return observe(t.me, () => t.me.locator('#sheet-root .size-btn').first().click(), async (p) => ({ окно: await sheetTitle(p) }));
  }],
  ['покер: Raise — своя сумма и кнопка подтверждения', async (s) => {
    const t = await raiseSheet(s);
    return observe(t.me, () => t.me.locator('#sheet-root .sheet-confirm button').click(), async (p) => ({ окно: await sheetTitle(p) }));
  }],
  ['покер: All-in — первое и второе касание', async (s) => {
    const t = await raiseSheet(s);
    const btn = () => t.me.locator('#sheet-root .size-btn', { hasText: 'All-in' }).click();
    const первое = await observe(t.me, btn, async (p) => ({ кнопка: await text(p, '#sheet-root .size-btn.danger') }));
    const второе = await observe(t.me, btn);
    return { первое, второе };
  }],
  ['покер: меню стола и «Встать из-за стола» посреди раздачи', async (s) => {
    const t = await poker(s);
    await t.me.locator('[aria-label="Меню"]').click();
    const пункты = await buttonsOf(t.me, '#sheet-root .menu-item');
    const встать = await observe(t.me, () => t.me.locator('#sheet-root .menu-item', { hasText: 'Встать из-за стола' }).click(), async (p) => ({ окно_подтверждения: await sheetTitle(p) }));
    return { пункты, встать };
  }],
  ['покер: «настоящие карты» — что видит игрок и кто отмечает победителя', async (s) => {
    const t = await s.table('poker', { settings: { cards: 'live' } });
    let me = null;
    await until(async () => {
      for (const p of t.pages) if (await p.locator(PK).count()) { me = p; return true; }
      return false;
    }, 'чей-то ход');
    await sleep(300);
    const первый = { кнопки: await buttonsOf(me, PK), своих_карт_на_экране: await me.locator('.hero img.card:not([src*="back"])').count() };
    // Коллы и чеки до вскрытия: дальше победителя называет человек.
    for (let i = 0; i < 12 && t.room.hand?.phase === 'betting'; i++) {
      await sleep(600);
      for (const p of t.pages) {
        const b = p.locator(PK, { hasText: /Check|Call/ }).first();
        if (await b.count()) { await b.click(); break; }
      }
    }
    await until(() => t.room.hand?.phase === 'showdown', 'вскрытие');
    await sleep(900);
    // Кому окно «кто выиграл» открылось само, а у кого только кнопка — записываем оба экрана.
    const вскрытие = {};
    for (const [i, p] of t.pages.entries()) {
      вскрытие[t.users[i].first_name] = {
        панель: await text(p, '.panel'),
        окно_открылось_само: await sheetTitle(p),
        в_окне: await buttonsOf(p, '#sheet-root button'),
      };
    }
    return { первый, вскрытие };
  }],
];

await runSim('карты', [...durakScenarios, ...colorsScenarios, ...pokerScenarios]);
