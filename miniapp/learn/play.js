/**
 * Интерактивные примеры курса. Каждый — `(props) → Element`. Нажатие или движение ползунка
 * меняет только текст/класс нужных узлов (см. parts.js), экран не перерисовывается.
 * Все числа считает код (facts.js / hands.js), а не написаны руками.
 */
import { h, fmt } from '../ui.js';
import { slider, segs, stat, bar, verdict, cardsRow } from './parts.js';
import { positionsTable, STREETS, streetsStrip, rangeMatrix, deckMap, sprBars, SEATS } from './diagrams.js';
import { hitChance, requiredEquity, evCall, evBet, mdf, bluffShare, bluffBreakeven, fact, FORMATS } from './facts.js';
import { ALL_HANDS, comboSum, chen, combosLeft, boardTexture, rankCode } from './hands.js';

const pct = (v, d = 0) => FORMATS[d === 0 ? 'percent' : d === 1 ? 'percent1' : 'percent2'](v);
const signed = (v) => FORMATS.signed(v);
const wrap = (...kids) => h('div.ln-play', kids);

/* ---------------------------------------------------- улицы раздачи */

export function playStreets() {
  const strip = streetsStrip(0);
  const board = h('div.ln-board');
  const text = h('p.ln-play-text');
  const btn = h('button.k-btn.k-btn--primary.k-btn--block', { type: 'button' });
  const BOARD = 'QH JH 2C 7S 10H'.split(' ');
  let i = 0;
  const paint = () => {
    const s = STREETS[i];
    strip.set(i);
    board.replaceChildren(...cardsRow(BOARD.slice(0, s.board).join(' ')).children);
    board.classList.toggle('empty', !s.board);
    text.textContent = s.text;
    btn.textContent = i < STREETS.length - 1 ? 'Дальше →' : 'Сначала';
  };
  btn.addEventListener('click', () => { i = (i + 1) % STREETS.length; paint(); });
  paint();
  return wrap(h('div.ln-note', 'Ваши карты — закрытые, видите только вы:'), cardsRow('AH KH'), strip.el, h('div.ln-note', 'Общие карты на столе:'), board, text, btn);
}

/* ------------------------------------------------------ позиции */

const SEAT_TEXT = {
  BTN: 'Кнопка ходит последней на всех кругах после префлопа: вы видите, что сделали остальные, прежде чем решать. Лучшее место.',
  SB: 'Малый блайнд ставит половину обязательной ставки и после флопа ходит первым — самое неудобное место.',
  BB: 'Большой блайнд уже вложил обязательную ставку, поэтому доплачивать ему дешевле. На префлопе ходит последним, после флопа — рано.',
  UTG: 'Ранняя позиция говорит первой на префлопе: за вами ещё много игроков, поэтому играть стоит осторожнее.',
  HJ: 'Средняя позиция: игроков позади меньше, играть можно чуть смелее.',
  CO: 'Место перед кнопкой: позади только кнопка и блайнды — можно играть заметно шире.',
};

export function playPositions() {
  const out = h('div.ln-play-card');
  const set = (id) => {
    t.set(id);
    const s = SEATS.find((x) => x.id === id);
    out.replaceChildren(h('b', s.name), h('p.ln-play-text', SEAT_TEXT[id]));
  };
  const t = positionsTable({ onPick: set });
  set('BTN');
  return wrap(h('div.ln-note', 'Нажмите на место за столом. D — кнопка дилера.'), t.el, out);
}

/* ---------------------------------------------------- ставки */

export function playActions() {
  const POT = 30; const BET = 20;
  const list = h('div.ln-tree-col');
  const seg = segs([['none', 'Ставок не было'], ['bet', `Соперник поставил ${BET}`]], 'none', (v) => paint(v));
  const paint = (v) => {
    const rows = v === 'none'
      ? [['Check', 'пропустить бесплатно'], ['Bet', `поставить первым, например ${fmt(POT / 2)}`]]
      : [['Fold', `выйти; те ${fmt(BET)} вам не нужно доплачивать`], ['Call', `доплатить ${fmt(BET)} и остаться`], ['Raise', `поставить больше, минимум до ${fmt(BET * 2)}`]];
    list.replaceChildren(...rows.map(([n, d]) => h('div.ln-tree-leaf', h('b', n), h('span', d))));
  };
  paint('none');
  return wrap(h('div.ln-note', `В банке ${POT}. Выберите, что происходит, — и посмотрите, что вам разрешено:`), seg.el, list);
}

/* --------------------------------------------------------- комбо */

export function playCombos() {
  const KINDS = {
    p: { label: 'Пара', ex: 'Две семёрки', hi: '7', lo: '7', kind: 'p' },
    s: { label: 'Одномастные', ex: 'Туз-король одной масти', hi: 'A', lo: 'K', kind: 's' },
    o: { label: 'Разномастные', ex: 'Туз-король разных мастей', hi: 'A', lo: 'K', kind: 'o' },
  };
  const info = h('div.ln-play-card');
  const SU = ['S', 'H', 'D', 'C'];
  const combosOf = (k) => {
    const out = [];
    for (const a of SU) for (const b of SU) {
      if (k.kind === 'p' && a >= b) continue;
      if (k.kind === 's' && a !== b) continue;
      if (k.kind === 'o' && a === b) continue;
      out.push(`${rankCode(k.hi)}${a} ${rankCode(k.lo)}${b}`);
    }
    return out;
  };
  const seg = segs(Object.entries(KINDS).map(([v, k]) => [v, k.label]), 'p', (v) => paint(v));
  const paint = (v) => {
    const k = KINDS[v]; const list = combosOf(k);
    info.replaceChildren(h('b', `${k.ex}: ${list.length} комбо`), h('div.ln-combos', list.map((c) => cardsRow(c, 'mini'))));
  };
  paint('p');
  return wrap(h('div.ln-note', 'Одна «рука» вроде туз-король — это несколько разных пар карт (комбо). Выберите вид:'), seg.el, info);
}

/* -------------------------------------------------- блокеры */

export function playBlockers() {
  const dead = h('button.k-btn.k-btn--secondary.k-btn--block', { type: 'button', 'aria-pressed': 'false' }, 'Положить A♠ в мою руку');
  const aa = stat('Пар тузов (AA) у соперника'); const ak = stat('Туз-король (AK) у соперника');
  let held = false;
  const paint = () => {
    const d = held ? ['AS'] : [];
    aa.set(String(combosLeft('A', 'A', 'p', d)));
    ak.set(String(combosLeft('A', 'K', 's', d) + combosLeft('A', 'K', 'o', d)));
    dead.setAttribute('aria-pressed', String(held));
    dead.textContent = held ? 'Убрать A♠ из моей руки' : 'Положить A♠ в мою руку';
  };
  dead.addEventListener('click', () => { held = !held; paint(); });
  paint();
  return wrap(h('div.ln-note', 'Карта у вас в руке не может быть у соперника — это и есть блокер:'), dead, aa.el, ak.el);
}

/* ---------------------------------------- матрица и порог (диапазоны) */

/** Порог по формуле Чена для «ширины» диапазона. Учебная шкала, не солвер. */
const WIDTH = [['tight', 'Узко', 10], ['mid', 'Средне', 8], ['wide', 'Широко', 6], ['loose', 'Очень широко', 4]];

function matrixInfo(selected) {
  const combos = comboSum(selected);
  return `${fmt(combos)} комбо из ${fmt(fact('startHandCombos'))} — это ${pct(combos / fact('startHandCombos'), 1)} всех стартовых рук`;
}

export function playRangeKinds() {
  const SETS = {
    p: ['Пары', (x) => x.kind === 'p'],
    s: ['Одномастные', (x) => x.kind === 's'],
    o: ['Разномастные', (x) => x.kind === 'o'],
    a: ['Тузы', (x) => x.hi === 'A'],
  };
  const m = rangeMatrix(SETS.p[1]);
  const info = h('p.ln-play-text');
  const paint = (v) => { m.set(SETS[v][1]); info.textContent = matrixInfo(ALL_HANDS.filter(SETS[v][1])); };
  const seg = segs(Object.entries(SETS).map(([v, s]) => [v, s[0]]), 'p', paint);
  paint('p');
  return wrap(h('div.ln-note', 'Диапазон — набор рук. Вся таблица — 169 стартовых рук: пары по диагонали, одномастные выше неё, разномастные ниже.'), seg.el, m.el, info);
}

export function playRangeWidth({ labels = null } = {}) {
  const m = rangeMatrix(() => false);
  const info = h('p.ln-play-text');
  const paint = (v) => {
    const min = WIDTH.find((w) => w[0] === v)[2];
    const sel = ALL_HANDS.filter((x) => chen(x) >= min);
    m.set((x) => chen(x) >= min);
    info.textContent = matrixInfo(sel);
  };
  const seg = segs((labels || WIDTH).map((w) => [w[0], w[1]]), 'tight', paint);
  paint('tight');
  return wrap(h('div.ln-note', 'Подсветка — по формуле Чена (простая учебная оценка силы стартовой руки). Это схема, не рекомендация солвера.'), seg.el, m.el, info);
}

/** Как сужается диапазон соперника по его действиям (схема). */
export function playRangeNarrow() {
  const STEPS = [
    ['open', 'Открыл рейзом', 8],
    ['bet3', 'Ответил 3-бетом', 11],
    ['bet4', 'Сделал 4-бет', 13],
  ];
  const m = rangeMatrix(() => false);
  const info = h('p.ln-play-text');
  const paint = (v) => {
    const min = STEPS.find((s) => s[0] === v)[2];
    m.set((x) => chen(x) >= min);
    info.textContent = `${matrixInfo(ALL_HANDS.filter((x) => chen(x) >= min))}. Чем агрессивнее действие, тем меньше рук остаётся.`;
  };
  const seg = segs(STEPS.map((s) => [s[0], s[1]]), 'open', paint);
  paint('open');
  return wrap(h('div.ln-note', 'Что соперник сделал — то и подсвечено. Пороги условные: так выглядит сужение, а не точные диапазоны.'), seg.el, m.el, info);
}

/* ------------------------------------------------------- ауты */

const OUT_CASES = {
  flush: { label: 'Флеш-дро', hero: ['AH', 'KH'], board: ['7H', '2H', 'QS'], outs: ['3H', '4H', '5H', '6H', '8H', '9H', '10H', 'JH', 'QH'], text: 'Четыре карты одной масти: до флеша не хватает одной. Таких карт в колоде 9.' },
  oesd: { label: 'Стрит с двух концов', hero: ['9S', '8D'], board: ['7C', '6H', '2D'], outs: ['10S', '10H', '10D', '10C', '5S', '5H', '5D', '5C'], text: 'Четыре подряд (9-8-7-6): подойдёт десятка или пятёрка — 8 карт.' },
  gut: { label: 'Стрит «изнутри»', hero: ['9S', '8D'], board: ['6C', '5H', 'KD'], outs: ['7S', '7H', '7D', '7C'], text: 'Четыре из пяти карт стрита, дырка посередине: нужна только семёрка — 4 карты.' },
  over: { label: 'Две старшие карты', hero: ['AS', 'KD'], board: ['9C', '8H', '2D'], outs: ['AH', 'AD', 'AC', 'KS', 'KH', 'KC'], text: 'Пары нет, но если придёт туз или король, у вас старшая пара: 3 туза и 3 короля.' },
};

export function playOuts() {
  const deck = deckMap();
  const info = h('div.ln-play-card');
  const paint = (v) => {
    const c = OUT_CASES[v];
    deck.set([...c.hero, ...c.board], c.outs);
    info.replaceChildren(
      h('div.ln-row', h('div.ln-col', h('small', 'Ваши карты'), cardsRow(c.hero.join(' '), 'mini')), h('div.ln-col', h('small', 'Флоп'), cardsRow(c.board.join(' '), 'mini'))),
      h('p.ln-play-text', c.text),
      stat('Ауты', String(c.outs.length)).el,
      stat('Шанс на тёрне', pct(c.outs.length / 47, 1)).el,
      stat('Шанс до ривера', pct(hitChance(c.outs.length, 2, 47), 1)).el);
  };
  const seg = segs(Object.entries(OUT_CASES).map(([v, c]) => [v, c.label]), 'flush', paint);
  paint('flush');
  return wrap(h('div.ln-note', 'Зелёные карты — ауты, серые — вы их уже видите. Выберите ситуацию:'), seg.el, deck.el, info);
}

export function playRule24() {
  const res = h('div.ln-play-card');
  const paint = (outs) => {
    const exactFlop = hitChance(outs, 2, 47); const exactTurn = outs / 46;
    res.replaceChildren(
      stat('На флопе: правило × 4', `${outs * 4}%`).el, stat('На флопе: точно', pct(exactFlop, 1)).el,
      stat('На тёрне: правило × 2', `${outs * 2}%`).el, stat('На тёрне: точно', pct(exactTurn, 1)).el);
  };
  const s = slider({ label: 'Ауты', min: 1, max: 15, value: 9, onInput: paint });
  paint(9);
  return wrap(h('div.ln-note', 'Подвигайте ползунок и сравните быстрое правило с точным ответом:'), s.el, res);
}

/* --------------------------------------------- шансы банка и EV */

export function playPotOdds({ implied = false } = {}) {
  const POT = 100;
  const eq = slider({ label: 'Ваше эквити', min: 5, max: 70, value: 30, show: (v) => `${v}%`, onInput: () => paint() });
  const size = slider({ label: 'Ставка соперника', min: 10, max: 200, step: 5, value: 50, show: (v) => `${v}% банка`, onInput: () => paint() });
  const imp = implied ? slider({ label: 'Ещё выиграете, если соберёте', min: 0, max: 200, step: 10, value: 0, show: (v) => fmt(v), onInput: () => paint() }) : null;
  const need = bar('Нужно эквити для колла', 0); const have = bar('У вас есть', 0, 'ok');
  const v = verdict(); const ev = stat('Ожидаемый выигрыш колла');
  const paint = () => {
    const bet = (POT * size.value) / 100;
    const extra = imp ? imp.value : 0;
    const needNow = bet / (POT + 2 * bet + extra);
    need.set(needNow, pct(needNow, 1)); have.set(eq.value / 100, `${eq.value}%`);
    ev.set(`${signed(evCall(POT, bet, eq.value / 100) + (eq.value / 100) * extra)} фишек`);
    const good = eq.value / 100 >= needNow;
    v.set(good ? 'Колл выгоден: эквити хватает.' : `Колл невыгоден: не хватает ${pct(needNow - eq.value / 100, 1)}.`, good ? 'ok' : 'bad');
  };
  paint();
  return wrap(h('div.ln-note', `Банк ${POT}. Соперник ставит — вы решаете, стоит ли доплачивать:`), size.el, eq.el, imp?.el, need.el, have.el, ev.el, v.el);
}

export function playEv() {
  const POT = 100; const BET = 50;
  const eq = slider({ label: 'Шанс выиграть', min: 0, max: 100, step: 5, value: 35, show: (v) => `${v}%`, onInput: () => paint() });
  const win = stat('Выиграете (с шансом)'); const lose = stat('Проиграете (с шансом)'); const total = stat('Итого, в среднем');
  const v = verdict();
  const paint = () => {
    const p = eq.value / 100;
    win.set(`+${fmt(POT + BET)} × ${pct(p)} = ${signed(Math.round((POT + BET) * p * 10) / 10)}`);
    lose.set(`−${fmt(BET)} × ${pct(1 - p)} = ${signed(-Math.round(BET * (1 - p) * 10) / 10)}`);
    const e = evCall(POT, BET, p);
    total.set(`${signed(Math.round(e * 10) / 10)} фишек`);
    v.set(e >= 0 ? 'Решение в плюс: так стоит делать много раз подряд.' : 'Решение в минус: в долгой игре вы теряете.', e >= 0 ? 'ok' : 'bad');
  };
  paint();
  return wrap(h('div.ln-note', `В банке ${POT}, соперник ставит ${BET}: вы платите ${BET}, чтобы побороться за ${POT + BET}.`), eq.el, win.el, lose.el, total.el, v.el);
}

export function playFold({ withEquity = false } = {}) {
  const POT = 100;
  const size = slider({ label: 'Ваша ставка', min: 25, max: 200, step: 25, value: 100, show: (v) => `${v}% банка`, onInput: () => paint() });
  const fold = slider({ label: 'Соперник сбрасывает', min: 0, max: 100, step: 5, value: 40, show: (v) => `${v}%`, onInput: () => paint() });
  const eq = withEquity ? slider({ label: 'Шанс выиграть, если уравняли', min: 0, max: 60, step: 5, value: 35, show: (v) => `${v}%`, onInput: () => paint() }) : null;
  const be = stat('Безубыточный сброс (если без шанса)'); const e = stat('Ожидаемый выигрыш'); const v = verdict();
  const paint = () => {
    const bet = (POT * size.value) / 100; const f = fold.value / 100; const q = eq ? eq.value / 100 : 0;
    be.set(pct(bluffBreakeven(POT, bet), 1));
    const ev = evBet(POT, bet, f, q);
    e.set(`${signed(Math.round(ev * 10) / 10)} фишек`);
    v.set(ev >= 0 ? 'Ставка окупается.' : 'Ставка не окупается — соперник должен сбрасывать чаще.', ev >= 0 ? 'ok' : 'bad');
  };
  paint();
  return wrap(h('div.ln-note', `Банк ${POT}. Вы ставите без сильной руки. Сбросит соперник — банк ваш; уравняет — вы чаще проигрываете.`), size.el, fold.el, eq?.el, be.el, e.el, v.el);
}

export function playEquityShare() {
  const CASES = {
    a: ['Флеш-дро против пары тузов', '9H 8H', 'AC KD', 'AH 4H 2C', 'flushDrawVsTopPair'],
    b: ['Пара королей против флеш-дро', 'KS KD', '9H 8H', 'AH 4H 2C', 'pairVsFlushDraw'],
  };
  const hero = h('div.ln-col'); const vill = h('div.ln-col'); const flop = h('div.ln-col');
  const b = bar('Эквити героя', 0, 'ok'); const share = stat('Из банка 200 в среднем ваши');
  const paint = (v) => {
    const [, hc, vc, fc, id] = CASES[v]; const q = fact(id);
    hero.replaceChildren(h('small', 'Герой'), cardsRow(hc.split(' ').map(toCode).join(' '), 'mini'));
    vill.replaceChildren(h('small', 'Соперник'), cardsRow(vc.split(' ').map(toCode).join(' '), 'mini'));
    flop.replaceChildren(h('small', 'Флоп'), cardsRow(fc.split(' ').map(toCode).join(' '), 'mini'));
    b.set(q, pct(q, 1)); share.set(`${fmt(Math.round(200 * q))} фишек`);
  };
  const seg = segs(Object.entries(CASES).map(([v, c]) => [v, c[0]]), 'a', paint);
  paint('a');
  return wrap(h('div.ln-note', 'Эквити — ваша средняя доля банка, если дойти до конца. Расчёт — перебор всех 990 вариантов тёрна и ривера.'), seg.el, h('div.ln-row', hero, vill, flop), b.el, share.el);
}
const toCode = (c) => { const r = c[0] === 'T' ? '10' : c[0]; return r + c.slice(1).toUpperCase(); };

/* ----------------------------------------------- текстура борда */

const BOARDS = {
  dry: ['KS 7D 2C', 'Сухой'], wet: ['JH 10H 8C', 'Мокрый'], pair: ['9S 9D 4C', 'Парный'], mono: ['AH KH QH', 'Одной масти'],
};
const LABEL_TEXT = {
  сухой: 'Разные масти, карты далеко друг от друга: дро почти нет, у кого пара — тот и впереди.',
  мокрый: 'Есть дро на флеш или стрит: сильная рука может быть побита, часто рука уходит к тому, кто доберёт.',
  парный: 'Пара на столе: у кого-то может быть тройка или фулл-хаус, а у остальных — меньше «живых» дро.',
};
export function playTexture({ advice = false } = {}) {
  const info = h('div.ln-play-card'); const row = h('div.ln-row');
  const paint = (v) => {
    const [codes] = BOARDS[v]; const cards = codes.split(' ');
    const t = boardTexture(cards);
    row.replaceChildren(cardsRow(codes));
    const suit = { rainbow: 'три разных масти', two: 'две карты одной масти', mono: 'все одной масти' }[t.suits];
    info.replaceChildren(
      h('b', `Борд: ${t.label}`), h('p.ln-play-text', LABEL_TEXT[t.label] || ''),
      stat('Масти', suit).el, stat('Пара на столе', t.paired ? 'есть' : 'нет').el, stat('Карты рядом', t.connected ? 'да' : 'нет').el,
      advice ? h('p.ln-play-text', t.wet ? 'Чаще ставить на таком флопе стоит только с сильной рукой или дро — иначе вас часто «догонят». Правило порядка.' : 'На сухом флопе continuation bet работает часто: сопернику трудно что-то собрать, и многие сбросят. Правило порядка.') : null);
  };
  const seg = segs(Object.entries(BOARDS).map(([v, b]) => [v, b[1]]), 'dry', paint);
  paint('dry');
  return wrap(h('div.ln-note', 'Выберите флоп — разберём, чем он «живой» или «сухой»:'), seg.el, row, info);
}

/* --------------------------------------- MDF, баланс, размер ставки */

export function playMdf({ show = ['need', 'mdf', 'bluff'] } = {}) {
  const POT = 100;
  const size = slider({ label: 'Размер ставки', min: 25, max: 300, step: 25, value: 50, show: (v) => `${v}% банка`, onInput: () => paint() });
  const rows = { need: stat('Эквити, которое получает коллирующий'), mdf: stat('Защищать (MDF)'), be: stat('Блеф окупается, если сбросят'), bluff: stat('Блефов среди ставок (баланс)') };
  const paint = () => {
    const bet = (POT * size.value) / 100;
    rows.need.set(pct(requiredEquity(POT, bet), 1)); rows.mdf.set(pct(mdf(POT, bet), 1));
    rows.be.set(pct(bluffBreakeven(POT, bet), 1)); rows.bluff.set(pct(bluffShare(POT, bet), 1));
  };
  paint();
  const map = { need: 'need', mdf: 'mdf', be: 'be', bluff: 'bluff' };
  return wrap(h('div.ln-note', `Банк ${POT}. Двигайте размер ставки и смотрите на цифры:`), size.el, show.map((k) => rows[map[k]]?.el));
}

export function playSpr() {
  const bars = sprBars();
  const pot = slider({ label: 'Банк', min: 10, max: 200, step: 10, value: 60, show: fmt, onInput: () => paint() });
  const stack = slider({ label: 'Стек', min: 100, max: 2000, step: 100, value: 600, show: fmt, onInput: () => paint() });
  const val = stat('SPR'); const zone = h('p.ln-play-text');
  const paint = () => {
    const s = stack.value / pot.value; bars.set(pot.value, stack.value);
    val.set(FORMATS.num1(s));
    zone.textContent = s < 4 ? 'Низкий SPR: стек мал относительно банка. Даже одна хорошая пара часто готова идти до конца. Правило порядка.'
      : s <= 10 ? 'Средний SPR: нужны сильная пара или две пары и выше; одной пары мало. Правило порядка.'
        : 'Высокий SPR: много фишек позади. Рискуют большими комбинациями и сильными дро, а одна пара часто не стоит всего стека. Правило порядка.';
  };
  paint();
  return wrap(h('div.ln-note', 'SPR — во сколько раз ваш стек больше банка. Подвигайте оба ползунка:'), pot.el, stack.el, bars.el, val.el, zone);
}

export function playRps() {
  const PRESETS = { rock: ['Только камень', [1, 0, 0]], skew: ['Чаще камень', [0.6, 0.2, 0.2]], even: ['Поровну', [1 / 3, 1 / 3, 1 / 3]] };
  const rows = ['Камень', 'Бумага', 'Ножницы'].map((n) => bar(n, 0));
  const out = stat('Лучший ответ соперника выигрывает'); const v = verdict();
  const paint = (k) => {
    const [r, p, s] = PRESETS[k][1];
    [r, p, s].forEach((x, i) => rows[i].set(x, pct(x)));
    // выигрыш лучшего ответа: камень бьёт ножницы, проигрывает бумаге и т.д.
    const exploit = Math.max(s - p, r - s, p - r);
    out.set(`${pct(exploit, 0)} за игру`);
    v.set(exploit < 0.0001 ? 'Эксплуатировать нечем: любой ответ соперника выходит «в ноль». Это и есть равновесие.' : 'Соперник заметил перекос и отвечает против него — вы теряете.', exploit < 0.0001 ? 'ok' : 'bad');
  };
  const seg = segs(Object.entries(PRESETS).map(([k, x]) => [k, x[0]]), 'rock', paint);
  paint('rock');
  return wrap(h('div.ln-note', 'Игра «камень-ножницы-бумага» — самый простой пример равновесия. Как вы играете:'), seg.el, rows.map((r) => r.el), out.el, v.el);
}

export const PLAY = {
  streets: playStreets, positions: playPositions, actions: playActions, combos: playCombos, blockers: playBlockers,
  rangeKinds: playRangeKinds, rangeWidth: playRangeWidth, rangeNarrow: playRangeNarrow, outs: playOuts, rule24: playRule24,
  potOdds: playPotOdds, ev: playEv, fold: playFold, equityShare: playEquityShare, texture: playTexture, mdf: playMdf, spr: playSpr, rps: playRps,
};
