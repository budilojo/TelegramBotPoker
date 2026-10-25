/**
 * Направление «Pot Odds и EV» (агент X). Банк, ставка, эквити → решение;
 * все числа в ответах и разборах считаются формулами из `poker-math.js`.
 * Соглашение везде: «банк» — до ставки соперника, «ставка» — то, что надо уравнять.
 */
import { registerExercises } from '../engine.js';
import * as M from '../poker-math.js';
import { numberTask, choiceTask, genDraw, DRAW_RU, STREET_RU, seatsHU, ex, fmtNum, fmtDec, rndCards, unseenCount } from './x-util.js';

const f1 = (x) => fmtDec(x, 1);
const pctS = (x) => `${f1(x * 100)} %`;
const BET_FRACS = [[1 / 3, 'треть банка'], [1 / 2, 'половину банка'], [2 / 3, 'две трети банка'], [3 / 4, 'три четверти банка'], [1, 'весь банк'], [3 / 2, 'полтора банка']];

function potAndBet(rng, fracs = BET_FRACS) {
  const pot = rng.pick([60, 80, 100, 120, 150, 200, 240, 300, 400]);
  const [fr, name] = rng.pick(fracs);
  return { pot, bet: Math.round(pot * fr), name };
}
const scene = (pot, bet, extra = {}) => ({ pot, bet, seats: seatsHU({ heroStack: 1000, villainStack: 1000 }), ...extra });

// ───────── уровень 1
const needEq = ex('x-potodds-need', 'pot-odds', 1, 'slider', (seed, rng) => {
  const { pot, bet, name } = potAndBet(rng);
  const need = M.requiredEquity(pot, bet);
  return numberTask({
    prompt: `В банке ${fmtNum(pot)}. Соперник ставит ${name} — ${fmtNum(bet)}. Какой минимальный шанс на победу (в %) нужен, чтобы колл не был убыточным?`,
    scene: scene(pot, bet),
    range: { min: 0, max: 50, step: 0.5, unit: '%', label: 'Нужное эквити' },
    answer: Math.round(need * 1000) / 10, tol: 1, fmtAns: f1, topic: 'pot-odds', code: 'potodds-need',
    why: `Колл стоит ${fmtNum(bet)}. После него в банке будет ${fmtNum(pot)} + ${fmtNum(bet)} + ${fmtNum(bet)} = ${fmtNum(pot + 2 * bet)}. Нужное эквити = цена колла / итоговый банк = ${fmtNum(bet)} / ${fmtNum(pot + 2 * bet)} = ${pctS(need)}.`,
  });
});

const callFold1 = ex('x-potodds-callfold', 'pot-odds', 1, 'table', (seed, rng) => {
  const { pot, bet } = potAndBet(rng);
  const need = M.requiredEquity(pot, bet);
  const up = rng.pick([true, false]);
  const gap = rng.pick([0.06, 0.08, 0.1, 0.12]);
  const eq = Math.max(0.03, Math.min(0.9, Math.round((need + (up ? gap : -gap)) * 100) / 100));
  const call = eq > need;
  const ev = M.evCall(eq, pot, bet);
  return choiceTask({
    rng, topic: 'pot-odds', code: 'potodds-decision',
    prompt: `В банке ${fmtNum(pot)}, соперник ставит ${fmtNum(bet)}. Ваше эквити — ${Math.round(eq * 100)} %. Что делаете?`,
    scene: scene(pot, bet, { history: [`Ваше эквити: ${Math.round(eq * 100)} %`] }),
    options: [
      { id: 'call', label: 'Колл', why: call ? `Эквити ${pctS(eq)} выше нужных ${pctS(need)}: колл в среднем приносит ${f1(ev)}.` : `Эквити ${pctS(eq)} ниже нужных ${pctS(need)}: колл в среднем теряет ${f1(-ev)}.` },
      { id: 'fold', label: 'Фолд', why: call ? 'Вы отказываетесь от выгодного колла.' : 'Верно: колл был бы убыточным по шансам банка.' },
    ],
    good: [call ? 'call' : 'fold'],
    why: `Нужное эквити = ${fmtNum(bet)} / ${fmtNum(pot + 2 * bet)} = ${pctS(need)}. У вас ${pctS(eq)}, значит ${call ? 'колл выгоден' : 'колл убыточен'} (EV колла = ${f1(ev)}).`,
  });
});

// ───────── уровень 2
const evCall2 = ex('x-potodds-ev-call', 'ev', 2, 'slider', (seed, rng) => {
  const { pot, bet } = potAndBet(rng, BET_FRACS.slice(0, 5));
  const eq = rng.pick([0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6]);
  const ev = M.evCall(eq, pot, bet);
  const lim = Math.ceil((pot + bet) / 10) * 10;
  return numberTask({
    prompt: `В банке ${fmtNum(pot)}, соперник ставит ${fmtNum(bet)}. Ваше эквити — ${Math.round(eq * 100)} %. Чему равен средний выигрыш колла (EV, в фишках; минус — проигрыш)?`,
    scene: scene(pot, bet, { history: [`Ваше эквити: ${Math.round(eq * 100)} %`] }),
    range: { min: -lim, max: lim, step: 1, unit: 'фишек', label: 'EV колла' },
    answer: Math.round(ev * 10) / 10, tol: Math.max(2, Math.round(pot * 0.02)), topic: 'ev', code: 'ev-call', fmtAns: (x) => fmtDec(x, Number.isInteger(x) ? 0 : 1),
    why: `С вероятностью ${pctS(eq)} вы выигрываете ${fmtNum(pot + bet)} (банк и ставку), с вероятностью ${pctS(1 - eq)} теряете ${fmtNum(bet)}. EV = ${eq} × ${fmtNum(pot + bet)} − ${f1(1 - eq)} × ${fmtNum(bet)} = ${f1(ev)}.`,
  });
});

const sizeForOdds = ex('x-potodds-size', 'pot-odds', 2, 'bet', (seed, rng) => {
  const pot = rng.pick([100, 120, 150, 200, 300]);
  const r = rng.pick([0.2, 0.25, 0.3, 1 / 3]);
  const bet = Math.round((pot * r) / (1 - 2 * r));
  const real = M.requiredEquity(pot, bet);
  const max = pot * 2;
  return numberTask({
    prompt: `В банке ${fmtNum(pot)}. Подберите размер ставки, при котором СОПЕРНИКУ для безубыточного колла нужно ровно ${Math.round(r * 1000) / 10} % эквити.`,
    scene: { pot, seats: seatsHU({ heroStack: 1000, villainStack: 1000 }), min: Math.round(pot * 0.1), max, step: 1, quick: [1 / 3, 1 / 2, 2 / 3, 1] },
    range: { min: Math.round(pot * 0.1), max, step: 1 },
    answer: bet, tol: Math.max(2, Math.round(pot * 0.03)), topic: 'pot-odds', code: 'potodds-size',
    why: `Нужное эквити соперника = ставка / (банк + 2 × ставка). Решаем для r = ${f1(r * 100)} %: ставка = банк × r / (1 − 2r) = ${fmtNum(pot)} × ${r.toFixed(3)} / ${(1 - 2 * r).toFixed(3)} ≈ ${fmtNum(bet)}. Проверка: ${fmtNum(bet)} / ${fmtNum(pot + 2 * bet)} = ${pctS(real)}.`,
  });
});

// ───────── уровень 3
function drawSituation(rng) {
  for (let t = 0; t < 200; t++) {
    const type = rng.pick(['flush', 'oesd', 'gutshot']);
    const { hero, board } = genDraw(rng, type, 4);
    const outs = M.drawOuts(hero, board).length;
    const eq = outs / unseenCount(4);
    const { pot, bet } = potAndBet(rng, BET_FRACS.slice(1, 5));
    const need = M.requiredEquity(pot, bet);
    if (Math.abs(eq - need) >= 0.03) return { type, hero, board, outs, eq, pot, bet, need };
  }
  throw new Error('drawSituation');
}

const impl3 = ex('x-potodds-implied-need', 'implied-odds', 3, 'slider', (seed, rng) => {
  let s;
  for (let t = 0; t < 200; t++) {
    const d = drawSituation(rng);
    const bet = Math.round(d.pot * rng.pick([0.75, 1, 1.5]));
    if (M.requiredEquity(d.pot, bet) > d.eq + 0.04) { s = { ...d, bet }; break; }
  }
  if (!s) throw new Error('implied-need');
  const { pot, bet, hero, board, outs, eq, type } = s;
  const x = M.impliedNeeded(eq, pot, bet);
  return numberTask({
    prompt: `Тёрн. У вас ${DRAW_RU[type]} (${outs} аутов, до ривера одна карта). Банк ${fmtNum(pot)}, ставка ${fmtNum(bet)}. Шансов банка не хватает: сколько ДОПОЛНИТЕЛЬНО фишек вам нужно выиграть на ривере, если дро придёт, чтобы колл стал безубыточным (скрытые шансы)?`,
    scene: { hero, board, street: STREET_RU[4], pot, bet, seats: seatsHU({ heroStack: 1000, villainStack: 1000 }), history: [`Ауты: ${outs}, шанс на ривере ${pctS(eq)}`] },
    range: { min: 0, max: Math.max(100, Math.ceil((x * 2) / 50) * 50), step: 1, unit: 'фишек', label: 'Нужные скрытые шансы' },
    answer: Math.round(x), tol: Math.max(3, Math.round(pot * 0.04)), topic: 'implied-odds', code: 'implied-need',
    why: `Шанс на ривере: ${outs} / ${unseenCount(4)} = ${pctS(eq)}. Условие безубыточности: ${f1(eq)} × (${fmtNum(pot + bet)} + X) = ${f1(1 - eq)} × ${fmtNum(bet)} (X — доплата при попадании). Отсюда X = ${fmtNum(bet)} × ${f1(1 - eq)} / ${f1(eq)} − ${fmtNum(pot)} − ${fmtNum(bet)} ≈ ${fmtNum(x)}. Выиграете больше — колл оправдан; нет — это ориентир для оценки соперника, а не гарантия.`,
  });
});

const drawCall3 = ex('x-potodds-draw-call', 'pot-odds', 3, 'table', (seed, rng) => {
  const s = drawSituation(rng);
  const { type, hero, board, outs, eq, pot, bet, need } = s;
  const call = eq > need;
  return choiceTask({
    rng, topic: 'pot-odds', code: 'draw-call',
    prompt: `Тёрн, у вас ${DRAW_RU[type]} (${outs} аутов). Соперник ставит ${fmtNum(bet)} в банк ${fmtNum(pot)}. Скрытые шансы не считаем. Колл по шансам банка?`,
    scene: { hero, board, street: STREET_RU[4], pot, bet, seats: seatsHU({ heroStack: 1000, villainStack: 1000 }) },
    options: [
      { id: 'call', label: 'Колл', why: call ? `Шанс ${pctS(eq)} выше нужных ${pctS(need)}.` : `Шанс ${pctS(eq)} ниже нужных ${pctS(need)} — только скрытые шансы могли бы оправдать колл.` },
      { id: 'fold', label: 'Фолд', why: call ? 'Вы отказываетесь от выгодного колла.' : 'Верно по прямым шансам банка.' },
    ],
    good: [call ? 'call' : 'fold'],
    why: `${outs} аутов из ${unseenCount(4)} неизвестных карт — шанс на ривере ${pctS(eq)}. Нужно ${fmtNum(bet)} / ${fmtNum(pot + 2 * bet)} = ${pctS(need)}. ${call ? 'Колл выгоден' : 'Колл по прямым шансам убыточен'}.`,
  });
});

// ───────── уровень 4
const breakFold = ex('x-potodds-breakfold', 'fold-equity', 4, 'slider', (seed, rng) => {
  const { pot, bet, name } = potAndBet(rng, BET_FRACS.slice(0, 5));
  const f = M.breakEvenFold(pot, bet);
  return numberTask({
    prompt: `Вы блефуете: ставите ${name} — ${fmtNum(bet)} в банк ${fmtNum(pot)}, ваша рука не выигрывает, если соперник заколлирует. Как часто он должен сбрасывать (в %), чтобы блеф не терял фишек?`,
    scene: { pot, seats: seatsHU({ heroStack: 1000, villainStack: 1000, heroBet: bet }) },
    range: { min: 0, max: 100, step: 0.5, unit: '%', label: 'Нужные фолды' },
    answer: Math.round(f * 1000) / 10, tol: 1.5, fmtAns: f1, topic: 'fold-equity', code: 'fold-eq-break',
    why: `Если сбросит — вы берёте банк ${fmtNum(pot)}; если нет — теряете ставку ${fmtNum(bet)}. Безубыточность: f × ${fmtNum(pot)} = (1 − f) × ${fmtNum(bet)}, отсюда f = ${fmtNum(bet)} / ${fmtNum(pot + bet)} = ${pctS(f)}.`,
  });
});

const semiBluffEV = ex('x-potodds-semibluff-ev', 'fold-equity', 4, 'slider', (seed, rng) => {
  const { pot, bet } = potAndBet(rng, BET_FRACS.slice(1, 5));
  const fold = rng.pick([0.2, 0.3, 0.4, 0.5]);
  const eq = rng.pick([0.2, 0.25, 0.3, 0.35]);
  const ev = M.evBet(pot, bet, fold, eq);
  const lim = Math.ceil((pot + bet) / 10) * 10;
  return numberTask({
    prompt: `Полу-блеф: вы ставите ${fmtNum(bet)} в банк ${fmtNum(pot)}. Соперник сбрасывает в ${Math.round(fold * 100)} % случаев; если он коллирует, ваше эквити ${Math.round(eq * 100)} % (для простоты — без дальнейших ставок). Чему равен EV вашей ставки (в фишках)?`,
    scene: { pot, seats: seatsHU({ heroStack: 1000, villainStack: 1000, heroBet: bet }) },
    range: { min: -lim, max: lim, step: 1, unit: 'фишек', label: 'EV ставки' },
    answer: Math.round(ev * 10) / 10, tol: Math.max(2, Math.round(pot * 0.02)), fmtAns: (x) => fmtDec(x, Number.isInteger(x) ? 0 : 1), topic: 'fold-equity', code: 'semibluff-ev',
    why: `Сбросит (${Math.round(fold * 100)} %): вы выигрываете ${fmtNum(pot)}. Заколлирует (${Math.round((1 - fold) * 100)} %): ${eq} × ${fmtNum(pot + bet)} − ${f1(1 - eq)} × ${fmtNum(bet)} = ${f1(M.evCall(eq, pot, bet))}. Итого EV = ${fold} × ${fmtNum(pot)} + ${f1(1 - fold)} × ${f1(M.evCall(eq, pot, bet))} = ${f1(ev)}.`,
  });
});

// ───────── уровень 5
const needFoldSemi = ex('x-potodds-needfold', 'fold-equity', 5, 'slider', (seed, rng) => {
  const { pot, bet } = potAndBet(rng, BET_FRACS.slice(1, 5));
  const eq = rng.pick([0.1, 0.15, 0.2, 0.25, 0.3]);
  const e = M.evCall(eq, pot, bet);
  const f = e >= 0 ? 0 : -e / (pot - e);
  return numberTask({
    prompt: `Полу-блеф: ставка ${fmtNum(bet)} в банк ${fmtNum(pot)}, при колле ваше эквити ${Math.round(eq * 100)} %. Какая минимальная доля фолдов (в %) делает ставку безубыточной?`,
    scene: { pot, seats: seatsHU({ heroStack: 1000, villainStack: 1000, heroBet: bet }) },
    range: { min: 0, max: 100, step: 0.5, unit: '%', label: 'Нужные фолды' },
    answer: Math.round(f * 1000) / 10, tol: 1.5, fmtAns: f1, topic: 'fold-equity', code: 'semibluff-fold',
    why: `EV при колле: ${eq} × ${fmtNum(pot + bet)} − ${f1(1 - eq)} × ${fmtNum(bet)} = ${f1(e)}. EV ставки = f × ${fmtNum(pot)} + (1 − f) × (${f1(e)}) = 0 → f = ${f1(-e)} / (${fmtNum(pot)} + ${f1(-e)}) = ${pctS(f)}. Чем сильнее ваше эквити при колле, тем меньше фолдов нужно.`,
  });
});

const sizeForFold = ex('x-potodds-size-fold', 'fold-equity', 5, 'bet', (seed, rng) => {
  const pot = rng.pick([100, 150, 200, 300]);
  const f = rng.pick([0.25, 1 / 3, 0.4, 0.5]);
  const bet = Math.round((pot * f) / (1 - f));
  return numberTask({
    prompt: `Чистый блеф в банк ${fmtNum(pot)}. По вашим данным соперник сбрасывает ${f1(f * 100)} % рук. Подберите ставку, при которой блеф в среднем ровно безубыточен.`,
    scene: { pot, seats: seatsHU({ heroStack: 1000, villainStack: 1000 }), min: Math.round(pot * 0.1), max: pot * 2, step: 1, quick: [1 / 3, 1 / 2, 2 / 3, 1] },
    range: { min: Math.round(pot * 0.1), max: pot * 2, step: 1 },
    answer: bet, tol: Math.max(2, Math.round(pot * 0.03)), topic: 'fold-equity', code: 'size-for-fold',
    why: `Безубыточность блефа: f = ставка / (банк + ставка). Отсюда ставка = банк × f / (1 − f) = ${fmtNum(pot)} × ${f.toFixed(3)} / ${(1 - f).toFixed(3)} ≈ ${fmtNum(bet)}. Проверка: ${fmtNum(bet)} / ${fmtNum(pot + bet)} = ${pctS(M.breakEvenFold(pot, bet))}. Чем больше ставка, тем чаще нужны фолды.`,
  });
});

registerExercises('potodds', [needEq, callFold1, evCall2, sizeForOdds, impl3, drawCall3, breakFold, semiBluffEV, needFoldSemi, sizeForFold]);
