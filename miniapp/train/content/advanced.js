/**
 * Направление «Продвинутая стратегия» (агент X): SPR, MDF, блокеры, баланс
 * вэлью/блефов, эксплуатация. Числа (SPR, MDF, комбо, доля блефов, EV блефа)
 * считаются формулами и перебором. Где задание опирается на «правило порядка»
 * (линия по SPR), в разборе так и сказано: «ориентир, не точный расчёт».
 * Виджет `range-grid` (W) здесь не используется: блокеры считаются по комбинациям
 * и показываются числами — меньше зависимостей между агентами.
 */
import { registerExercises } from '../engine.js';
import * as M from '../poker-math.js';
import { numberTask, choiceTask, rndCards, seatsHU, ex, fmtNum, fmtDec, GUIDE_NOTE } from './x-util.js';

const f1 = (x) => fmtDec(x, 1);
const pct = (x) => `${f1(x * 100)} %`;
const names = (cs) => cs.map(M.cardName).join(' ');

// ───────── уровень 1
const spr1 = ex('x-adv-spr', 'spr', 1, 'slider', (seed, rng) => {
  const pot = rng.pick([20, 30, 40, 60, 80, 120]);
  const stack = pot * rng.pick([2, 3, 4, 5, 6, 8, 10, 12, 15]) + rng.pick([0, 0, pot / 2]);
  const v = M.spr(stack, pot);
  return numberTask({
    prompt: `Эффективный стек ${fmtNum(stack)}, банк ${fmtNum(pot)}. Чему равен SPR (стек к банку, одно число с десятичной долей)?`,
    scene: { pot, stack, seats: seatsHU({ heroStack: stack, villainStack: stack }) },
    range: { min: 0, max: 20, step: 0.1, unit: '', label: 'SPR' },
    answer: Math.round(v * 10) / 10, tol: 0.2, fmtAns: f1, topic: 'spr', code: 'spr-calc',
    why: `SPR = эффективный стек / банк = ${fmtNum(stack)} / ${fmtNum(pot)} = ${f1(v)}. Чем он меньше, тем ближе игра к «всё или ничего» и тем меньше значит одна пара.`,
  });
});

const mdf1 = ex('x-adv-mdf', 'mdf', 1, 'slider', (seed, rng) => {
  const pot = rng.pick([60, 100, 150, 200, 300]);
  const fr = rng.pick([1 / 3, 1 / 2, 2 / 3, 1]);
  const bet = Math.round(pot * fr);
  const v = M.mdf(pot, bet);
  return numberTask({
    prompt: `Соперник ставит ${fmtNum(bet)} в банк ${fmtNum(pot)}. Какую долю своего диапазона (в %) нужно защищать (MDF), чтобы его чистый блеф не был выгоден?`,
    scene: { pot, bet, seats: seatsHU({ heroStack: 1000, villainStack: 1000 }) },
    range: { min: 0, max: 100, step: 0.5, unit: '%', label: 'MDF' },
    answer: Math.round(v * 1000) / 10, tol: 1.5, fmtAns: f1, topic: 'mdf', code: 'mdf-calc',
    why: `MDF = банк / (банк + ставка) = ${fmtNum(pot)} / ${fmtNum(pot + bet)} = ${pct(v)}. Вы защищаетесь на эту долю рук; сбрасываете остальные ${pct(1 - v)}. Если сбрасывать чаще, любой блеф соперника прибыльный.`,
  });
});

// ───────── уровень 2
const SPR_BANDS = [[0, 3, 'низкий'], [3, 10, 'средний'], [10, Infinity, 'высокий']];
const sprLine2 = ex('x-adv-spr-line', 'spr', 2, 'table', (seed, rng) => {
  const pot = rng.pick([20, 30, 40, 60]);
  const sprVal = rng.pick([1.5, 2, 2.5, 12, 14, 18]);
  const stack = Math.round(pot * sprVal);
  const real = M.spr(stack, pot);
  const band = SPR_BANDS.find(([lo, hi]) => real >= lo && real < hi);
  const low = band[2] === 'низкий';
  let board, hero;
  for (let t = 0; t < 3000 && !hero; t++) { // рука с топ-парой
    board = rndCards(rng, 3);
    const h = rndCards(rng, 2, board);
    const sc = M.evaluate([...h, ...board]);
    if (sc[0] === M.CAT.PAIR && h.some((c) => M.rankOf(c) === sc[1]) && sc[1] >= Math.max(...board.map(M.rankOf))) hero = h;
  }
  if (!hero) throw new Error('spr-line: нет топ-пары');
  return choiceTask({
    rng, topic: 'spr', code: 'spr-line',
    prompt: `Флоп, у вас топ-пара. SPR = ${f1(real)} (${band[2]}: меньше 3 — низкий, 3–10 — средний, больше 10 — высокий). Какой план разумнее? Это учебный ориентир.`,
    scene: { hero, board, street: 'Флоп', pot, stack, seats: seatsHU({ heroStack: stack, villainStack: stack }) },
    options: [
      { id: 'commit', label: 'Готов вложить весь стек', why: low ? 'При низком SPR топ-пара обычно достаточно сильна, чтобы идти до конца.' : 'При высоком SPR один пара редко стоит всего стека.' },
      { id: 'control', label: 'Играть осторожно, держать банк небольшим', why: low ? 'Вы упускаете выгодное вложение: стек и так мал по сравнению с банком.' : 'При глубоких стеках главные потери — когда одна пара встречает сильную руку.' },
    ],
    good: [low ? 'commit' : 'control'],
    why: `SPR = ${fmtNum(stack)} / ${fmtNum(pot)} = ${f1(real)}. ${low ? 'Низкий SPR: после ставки или двух оставшийся стек уже мал по отношению к банку, топ-пара — рука для всего стека.' : 'Высокий SPR: нужно много вложить, и это оправдано сильными руками (две пары, сет и лучше), а не одной парой.'} ${GUIDE_NOTE}`,
  });
});

const mdfCombos2 = ex('x-adv-mdf-combos', 'mdf', 2, 'slider', (seed, rng) => {
  const n = rng.pick([12, 15, 20, 24, 30, 40]);
  const pot = rng.pick([100, 150, 200]);
  const bet = Math.round(pot * rng.pick([1 / 2, 2 / 3, 1]));
  const m = M.mdf(pot, bet);
  const keep = n * m;
  return numberTask({
    prompt: `У вас в диапазоне ${n} комбинаций, соперник ставит ${fmtNum(bet)} в банк ${fmtNum(pot)}. Сколько комбинаций нужно ПРОДОЛЖИТЬ (колл или рейз), чтобы защищаться по MDF? (Округлите до целого.)`,
    scene: { pot, bet, seats: seatsHU({ heroStack: 1000, villainStack: 1000 }) },
    range: { min: 0, max: n, step: 1, unit: 'комбо', label: 'Продолжать' },
    answer: Math.round(keep), tol: 1, fmtAns: (x) => String(Math.round(x)), topic: 'mdf', code: 'mdf-combos',
    why: `MDF = ${fmtNum(pot)} / ${fmtNum(pot + bet)} = ${pct(m)}. От ${n} комбинаций это ${n} × ${f1(m)} ≈ ${f1(keep)}, то есть около ${Math.round(keep)}. Остальные сбрасываются.`,
  });
});

// ───────── уровень 3: блокеры
const VALUE_SETS = [['AA', 'KK', 'AKs', 'AKo'], ['AA', 'KK', 'QQ', 'AKs', 'AKo'], ['KK', 'QQ', 'AKs', 'AQs']];
const blockersCount = ex('x-adv-blockers-count', 'blockers', 3, 'slider', (seed, rng) => {
  const labels = rng.pick(VALUE_SETS);
  const board = rndCards(rng, 3);
  const hero = rndCards(rng, 2, board);
  const set = new Set(labels);
  const free = M.rangeCombos(set, board);
  const left = M.rangeCombos(set, [...board, ...hero]);
  const per = labels.map((l) => `${l}: ${M.combosOf(l, [...board, ...hero])} из ${M.combosOf(l, board)}`).join('; ');
  return numberTask({
    prompt: `Соперник ставит вэлью-диапазоном: ${labels.join(', ')}. Сколько комбинаций этого диапазона у него ОСТАЛОСЬ с учётом ваших карт и борда (блокеры)?`,
    scene: { hero, board, street: 'Флоп', history: [`Диапазон соперника: ${labels.join(', ')}`] },
    range: { min: 0, max: M.rangeCombos(set, []), step: 1, unit: 'комбо', label: 'Комбинаций осталось' },
    answer: left, tol: 0, fmtAns: (x) => String(Math.round(x)), topic: 'blockers', code: 'blockers-count',
    why: `Без ваших карт при этом борде в диапазоне ${free} комбинаций, с ними — ${left}. По строкам: ${per}. Ваши карты «блокируют» ${free - left} комбинаций: такие руки у соперника быть не могут.`,
  });
});

const blockerBluff3 = ex('x-adv-blocker-bluff', 'blockers', 3, 'table', (seed, rng) => {
  const labels = rng.pick(VALUE_SETS);
  const set = new Set(labels);
  for (let t = 0; t < 400; t++) {
    const board = rndCards(rng, 3);
    const a = rndCards(rng, 2, board), b = rndCards(rng, 2, board);
    if (new Set([...a, ...b]).size !== 4) continue;
    const base = M.rangeCombos(set, board);
    const ra = base - M.rangeCombos(set, [...board, ...a]);
    const rb = base - M.rangeCombos(set, [...board, ...b]);
    if (Math.abs(ra - rb) < 2) continue;
    const bestId = ra > rb ? 'a' : 'b';
    return choiceTask({
      rng, topic: 'blockers', code: 'blocker-pick', shuffle: false,
      prompt: `Вы блефуете ставкой. Соперник коллирует вэлью-диапазоном ${labels.join(', ')}. Какая из двух блеф-рук лучше с точки зрения блокеров (сильнее сокращает вэлью-комбо соперника)?`,
      scene: { board, street: 'Флоп', history: [`Рука A: ${names(a)}`, `Рука B: ${names(b)}`] },
      options: [
        { id: 'a', label: `A: ${names(a)}`, why: `Блокирует ${ra} комбо вэлью.` },
        { id: 'b', label: `B: ${names(b)}`, why: `Блокирует ${rb} комбо вэлью.` },
      ],
      good: [bestId],
      why: `Вэлью-комбо до ваших карт: ${base}. Рука A оставляет ${base - ra} (блокирует ${ra}), рука B — ${base - rb} (блокирует ${rb}). Чем больше блокировано, тем реже вас перебьют при колле. (Блокер — лишь одно из соображений: у блеф-руки есть и другие плюсы и минусы.)`,
    });
  }
  throw new Error('blocker-bluff');
});

// ───────── уровень 4: баланс и эксплуатация
const bluffBalance4 = ex('x-adv-balance', 'value-bluff', 4, 'slider', (seed, rng) => {
  const value = rng.pick([6, 8, 9, 12, 15, 18, 24]);
  const pot = rng.pick([100, 150, 200]);
  const bet = Math.round(pot * rng.pick([1 / 2, 2 / 3, 1]));
  const b = M.bluffsForValue(value, pot, bet);
  return numberTask({
    prompt: `Река. У вас ${value} комбинаций вэлью. Вы ставите ${fmtNum(bet)} в банк ${fmtNum(pot)}. Сколько блефов (комбинаций) нужно добавить, чтобы соперник был безразличен к колл/фолд?`,
    scene: { pot, bet, seats: seatsHU({ heroStack: 1000, villainStack: 1000, heroBet: bet }) },
    range: { min: 0, max: 30, step: 0.5, unit: 'комбо', label: 'Блефов' },
    answer: Math.round(b * 2) / 2, tol: 0.5, fmtAns: f1, topic: 'value-bluff', code: 'balance-bluffs',
    why: `На каждое вэлью надо ставка / (банк + ставка) = ${fmtNum(bet)} / ${fmtNum(pot + bet)} = ${f1(M.bluffRatio(pot, bet))} блефа. Для ${value} комбо: ${value} × ${f1(M.bluffRatio(pot, bet))} ≈ ${f1(b)}. Доля блефов во всём диапазоне ставки: ${pct(M.bluffShare(pot, bet))}.`,
  });
});

const exploitEV4 = ex('x-adv-exploit-ev', 'value-bluff', 4, 'slider', (seed, rng) => {
  const pot = rng.pick([100, 150, 200, 300]);
  const bet = Math.round(pot * rng.pick([1 / 3, 1 / 2, 2 / 3]));
  const fold = rng.pick([0.4, 0.5, 0.6, 0.7, 0.8]);
  const ev = M.evBet(pot, bet, fold, 0);
  const lim = Math.ceil((pot + bet) / 10) * 10;
  return numberTask({
    prompt: `Соперник сбрасывает на ставку ${fmtNum(bet)} в ${Math.round(fold * 100)} % случаев. Чему равен EV ЧИСТОГО блефа (рука не выигрывает при колле) в банк ${fmtNum(pot)}?`,
    scene: { pot, seats: seatsHU({ heroStack: 1000, villainStack: 1000, heroBet: bet }) },
    range: { min: -lim, max: lim, step: 1, unit: 'фишек', label: 'EV блефа' },
    answer: Math.round(ev * 10) / 10, tol: Math.max(2, Math.round(pot * 0.02)), fmtAns: (x) => fmtDec(x, Number.isInteger(x) ? 0 : 1), topic: 'value-bluff', code: 'exploit-ev',
    why: `Сбросит (${Math.round(fold * 100)} %): +${fmtNum(pot)}; заколлирует (${Math.round((1 - fold) * 100)} %): −${fmtNum(bet)}. EV = ${fold} × ${fmtNum(pot)} − ${f1(1 - fold)} × ${fmtNum(bet)} = ${f1(ev)}. Безубыточная доля фолдов для такой ставки — ${pct(M.breakEvenFold(pot, bet))}.`,
  });
});

// ───────── уровень 5
const bluffShare5 = ex('x-adv-bluff-share', 'value-bluff', 5, 'slider', (seed, rng) => {
  const pot = rng.pick([100, 150, 200, 300]);
  const bet = Math.round(pot * rng.pick([1 / 2, 2 / 3, 3 / 4, 1, 3 / 2]));
  const s = M.bluffShare(pot, bet);
  return numberTask({
    prompt: `Вы ставите ${fmtNum(bet)} в банк ${fmtNum(pot)} на ривере. Какая ДОЛЯ ставочного диапазона (в %) должна быть блефами, чтобы соперник был безразличен к колл/фолд?`,
    scene: { pot, seats: seatsHU({ heroStack: 1000, villainStack: 1000, heroBet: bet }) },
    range: { min: 0, max: 60, step: 0.5, unit: '%', label: 'Доля блефов' },
    answer: Math.round(s * 1000) / 10, tol: 1.5, fmtAns: f1, topic: 'value-bluff', code: 'bluff-share',
    why: `Доля блефов = ставка / (банк + 2 × ставка) = ${fmtNum(bet)} / ${fmtNum(pot + 2 * bet)} = ${pct(s)}; это ровно то эквити, которое нужно сопернику для колла. Больше блефов — ему выгодно коллировать, меньше — выгодно сбрасывать.`,
  });
});

const exploitPick5 = ex('x-adv-exploit-pick', 'value-bluff', 5, 'table', (seed, rng) => {
  const pot = rng.pick([100, 150, 200, 300]);
  const bet = Math.round(pot * rng.pick([1 / 3, 1 / 2, 2 / 3, 1]));
  const be = M.breakEvenFold(pot, bet);
  const fold = Math.round((be + rng.pick([-0.2, -0.12, 0.12, 0.2])) * 100) / 100;
  const more = fold > be;
  return choiceTask({
    rng, topic: 'value-bluff', code: 'exploit-pick',
    prompt: `Сбалансированный блеф на ставку ${fmtNum(bet)} в банк ${fmtNum(pot)} безубыточен при ${pct(be)} фолдов. Соперник на деле сбрасывает ${Math.round(fold * 100)} %. Как лучше поменять игру против него?`,
    scene: { pot, seats: seatsHU({ heroStack: 1000, villainStack: 1000, heroBet: bet }), history: [`Соперник сбрасывает ${Math.round(fold * 100)} %`] },
    options: [
      { id: 'more', label: 'Блефовать чаще', why: more ? `Он сбрасывает больше нужного (${pct(fold)} > ${pct(be)}): каждый блеф прибылен, EV ≈ ${f1(M.evBet(pot, bet, fold, 0))}.` : `При ${pct(fold)} фолдов блеф убыточен (EV ≈ ${f1(M.evBet(pot, bet, fold, 0))}).` },
      { id: 'less', label: 'Блефовать реже', why: more ? 'Вы отказываетесь от прибыльных блефов.' : 'Верно: он коллирует слишком часто, блеф теряет фишки.' },
    ],
    good: [more ? 'more' : 'less'],
    why: `Порог безубыточности ${pct(be)}. Фактическая доля фолдов ${pct(fold)} — ${more ? 'выше' : 'ниже'} порога, поэтому блеф для чистого блефа ${more ? 'прибылен' : 'убыточен'}: EV = ${fold} × ${fmtNum(pot)} − ${f1(1 - fold)} × ${fmtNum(bet)} = ${f1(M.evBet(pot, bet, fold, 0))}. Это эксплуатация: мы отступаем от баланса, потому что знаем перекос соперника.`,
  });
});

registerExercises('advanced', [spr1, mdf1, sprLine2, mdfCombos2, blockersCount, blockerBluff3, bluffBalance4, exploitEV4, bluffShare5, exploitPick5]);
