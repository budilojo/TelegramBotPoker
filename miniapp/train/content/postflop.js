/**
 * Направление «Постфлоп-стратегия» (агент X).
 *
 * ЧЕСТНОСТЬ (контракт 9): здесь нет «солверных» частот. Что считается точно —
 * класс руки, текстура по заданному правилу, эквити (перебор/Монте-Карло с
 * seed), EV при явно названном допущении о фолдах. Что отмечено «ориентир» —
 * правило порядка (размер ставки по текстуре), и в разборе так и сказано.
 */
import { registerExercises } from '../engine.js';
import * as M from '../poker-math.js';
import {
  numberTask, choiceTask, rndCards, genFlop, boardTexture, handClass, equityVsRandom, seatsHU, ex, fmtNum, fmtDec,
  TEXTURE_RU, TEXTURE_RULE, CLASS_RU, GUIDE_NOTE, STREET_RU,
} from './x-util.js';

const f1 = (x) => fmtDec(x, 1);
const pct = (x) => `${f1(x * 100)} %`;
const names = (cs) => cs.map(M.cardName).join(' ');
const POTS = [60, 80, 100, 120, 150, 200, 300];
const scene = (hero, board, pot, extra = {}) => ({ hero, board, street: STREET_RU[board.length], pot, seats: seatsHU({ heroStack: 1000, villainStack: 1000, heroPos: 'BTN', villainPos: 'BB' }), ...extra });

/** Рука нужного класса на флопе заданной текстуры. */
function genHandOfClass(rng, classes, texture = null) {
  for (let t = 0; t < 2000; t++) {
    const board = texture ? genFlop(rng, texture) : rndCards(rng, 3);
    const hero = rndCards(rng, 2, board);
    if (classes.includes(handClass(hero, board))) return { hero, board, cls: handClass(hero, board) };
  }
  throw new Error('genHandOfClass');
}

// ───────── уровень 1
const valueOrCheck = ex('x-post-value-or-check', 'value-bluff', 1, 'table', (seed, rng) => {
  const want = rng.pick([['strong'], ['weak', 'air']]);
  const { hero, board, cls } = genHandOfClass(rng, want);
  const pot = rng.pick(POTS);
  const eq = equityVsRandom(hero, board, seed);
  const bet = cls === 'strong';
  return choiceTask({
    rng, topic: 'value-bluff', code: 'post-value-check',
    prompt: `Флоп, вы в позиции, соперник сделал чек. У вас ${CLASS_RU[cls]}. Что делаете?`,
    scene: scene(hero, board, pot, { history: ['Соперник: чек'] }),
    options: [
      { id: 'bet', label: 'Ставка', why: bet ? `Против случайной руки вы впереди (≈ ${pct(eq)}): ставка забирает деньги у более слабых рук.` : `С такой рукой ≈ ${pct(eq)}: ставка заставляет сбросить слабое, а коллируют вас рукой сильнее.` },
      { id: 'check', label: 'Чек', why: bet ? 'Вы упускаете ставку на вэлью — сильная рука должна зарабатывать.' : 'Бесплатная карта и дешёвый шоудаун без лишнего риска.' },
    ],
    good: [bet ? 'bet' : 'check'],
    why: `${CLASS_RU[cls][0].toUpperCase() + CLASS_RU[cls].slice(1)}: эквити против случайной руки примерно ${pct(eq)} (расчёт по Монте-Карло с фиксированным seed). ${bet ? 'С сильной рукой ставят «на вэлью» — просить уплатить за слабые руки.' : 'С такой рукой ставка мало что добавляет: хуже вас обычно сбросят, лучше — заколлируют.'} ${GUIDE_NOTE}`,
  });
});

const sizeAfterCheck = ex('x-post-tx-classify', 'board-texture', 1, 'table', (seed, rng) => {
  const kind = rng.pick(['dry', 'medium', 'wet']);
  const board = genFlop(rng, kind);
  const tx = boardTexture(board);
  return choiceTask({
    rng, topic: 'board-texture', code: 'texture-classify', shuffle: false,
    prompt: `Какой это флоп по правилу текстуры? ${TEXTURE_RULE}`,
    scene: { board, street: 'Флоп' },
    options: ['dry', 'medium', 'wet'].map((k) => ({ id: k, label: TEXTURE_RU[k][0].toUpperCase() + TEXTURE_RU[k].slice(1), why: k === kind ? 'Верно.' : 'Не подходит по баллам.' })),
    good: [kind],
    why: `Масти: ${tx.flushPts} б., связность (разброс номиналов ${tx.span}): ${tx.pts - tx.flushPts} б. Всего ${tx.pts} — ${TEXTURE_RU[kind]} доска.`,
  });
});

// ───────── уровень 2: размер по текстуре (ориентир)
const GUIDE_FRAC = { dry: [1 / 3, 'треть банка'], medium: [1 / 2, 'половина банка'], wet: [2 / 3, 'две трети банка'] };

function sizeTask(rng, kind, topic, code, role) {
  const board = genFlop(rng, kind);
  const hero = rndCards(rng, 2, board);
  const pot = rng.pick([100, 150, 200, 300]);
  const [fr, label] = GUIDE_FRAC[kind];
  const ans = Math.round(pot * fr);
  const lo = Math.round(pot * 0.1), hi = pot;
  return numberTask({
    prompt: `${role} на ${TEXTURE_RU[kind]} флопе. Банк ${fmtNum(pot)}. Какую ставку выберете? Учебный ориентир: сухая доска — около 1/3 банка, средняя — 1/2, мокрая — 2/3 (рука не важна).`,
    scene: { ...scene(hero, board, pot), min: lo, max: hi, step: 1, quick: [1 / 3, 1 / 2, 2 / 3, 1] },
    range: { min: lo, max: hi, step: 1 },
    answer: ans, tol: Math.max(4, Math.round(pot * 0.08)), topic, code,
    why: `Доска ${TEXTURE_RU[kind]} (${boardTexture(board).pts} б.): ориентир — ${label}, то есть около ${fmtNum(ans)}. На мокрых досках ставят крупнее: у соперника больше дро, и им надо дорого платить за карту; на сухих хватает малой ставки. ${GUIDE_NOTE}`,
  });
}
const sizeByTexture = ex('x-post-size', 'bet-sizing', 2, 'bet', (seed, rng) => sizeTask(rng, rng.pick(['dry', 'medium', 'wet']), 'bet-sizing', 'post-size', 'Вы ставите'));
const cbetTexture = ex('x-post-cbet-size', 'cbet', 2, 'bet', (seed, rng) => sizeTask(rng, rng.pick(['dry', 'wet']), 'cbet', 'post-cbet-size', 'Вы повышали на префлопе и ставите c-bet'));

// ───────── уровень 3
const semiBluff3 = ex('x-post-draw-bet', 'draws', 3, 'table', (seed, rng) => {
  const { hero, board } = genHandOfClass(rng, ['draw']);
  const pot = rng.pick(POTS);
  const bet = Math.round(pot * 2 / 3);
  const fold = 0.4;
  const eq = equityVsRandom(hero, board, seed);
  const evBet = M.evBet(pot, bet, fold, eq);
  const evCheck = eq * pot;
  const better = evBet >= evCheck ? 'bet' : 'check';
  const close = Math.abs(evBet - evCheck) < 0.05 * pot;
  const good = close ? ['bet', 'check'] : [better];
  return choiceTask({
    rng, topic: 'draws', code: 'post-draw',
    prompt: `Флоп, вы в позиции, соперник сделал чек. У вас сильное дро. Допущение: на ставку ${fmtNum(bet)} (2/3 банка) соперник сбрасывает в ${Math.round(fold * 100)} % случаев, иначе вы реализуете эквити. Ставка или чек?`,
    scene: scene(hero, board, pot, { history: ['Соперник: чек', `Допущение: фолд ${Math.round(fold * 100)} % на ставку ${fmtNum(bet)}`] }),
    options: [
      { id: 'bet', label: `Ставка ${fmtNum(bet)}`, why: `EV ≈ ${f1(evBet)} фишек.` },
      { id: 'check', label: 'Чек', why: `EV ≈ ${f1(evCheck)} фишек (вы реализуете ${pct(eq)} банка).` },
    ],
    good,
    why: `Эквити дро против случайной руки ≈ ${pct(eq)}. EV чека ≈ ${pct(eq)} × ${fmtNum(pot)} = ${f1(evCheck)}. EV ставки = ${fold} × ${fmtNum(pot)} + ${f1(1 - fold)} × (${f1(eq)} × ${fmtNum(pot + bet)} − ${f1(1 - eq)} × ${fmtNum(bet)}) = ${f1(evBet)}. ${close ? 'Разница меньше 5 % банка — оба варианта допустимы.' : `Лучше ${better === 'bet' ? 'ставка' : 'чек'}.`} Результат зависит от допущения о фолдах, это не солвер.`,
  });
});

const sizeValueWet = ex('x-post-size-value', 'bet-sizing', 3, 'bet', (seed, rng) => sizeTask(rng, rng.pick(['dry', 'medium', 'wet']), 'bet-sizing', 'post-size-value', 'Сильная рука, ваш ход'));

// ───────── уровень 4: ответ на ставку соперника
const facingBet4 = ex('x-post-facing-bet', 'pot-odds', 4, 'table', (seed, rng) => {
  const cls = rng.pick([['strong'], ['top', 'weak'], ['draw'], ['air']]);
  const { hero, board, cls: c } = genHandOfClass(rng, cls);
  const pot = rng.pick(POTS);
  const bet = Math.round(pot * rng.pick([0.5, 2 / 3, 1]));
  const eq = equityVsRandom(hero, board, seed);
  const need = M.requiredEquity(pot, bet);
  const band = 0.04;
  let good;
  if (eq >= 0.75) good = ['raise', 'call'];
  else if (eq > need + band) good = ['call'];
  else if (eq < need - band) good = ['fold'];
  else good = ['call', 'fold'];
  return choiceTask({
    rng, topic: 'pot-odds', code: 'post-facing-bet',
    prompt: `Флоп. Соперник ставит ${fmtNum(bet)} в банк ${fmtNum(pot)}. У вас ${CLASS_RU[c]}. Учебное допущение: соперник мог поставить любой рукой. Что делаете?`,
    scene: scene(hero, board, pot, { bet, history: [`Соперник: ставка ${fmtNum(bet)}`] }),
    options: [
      { id: 'fold', label: 'Фолд', why: `Нужно ${pct(need)}, у вас ≈ ${pct(eq)}.` },
      { id: 'call', label: 'Колл', why: `Нужно ${pct(need)}, у вас ≈ ${pct(eq)}.` },
      { id: 'raise', label: 'Рейз', why: eq >= 0.75 ? 'Рука настолько сильна против случайной, что рейз берёт вэлью.' : 'Рейз с такой рукой оставляет против вас только сильнейшие руки.' },
    ],
    good,
    why: `Нужное эквити для колла: ${fmtNum(bet)} / ${fmtNum(pot + 2 * bet)} = ${pct(need)}. Ваше эквити против случайной руки ≈ ${pct(eq)} (Монте-Карло, seed). ${good.length > 1 ? 'Разница в пределах 4 п. п. или рука очень сильная — оба хода допустимы.' : good[0] === 'call' ? 'Эквити достаточно для колла.' : 'Эквити не хватает.'} Допущение «ставит любой рукой» — упрощение задания.`,
  });
});

const textureCbet4 = ex('x-post-cbet-air', 'cbet', 4, 'table', (seed, rng) => {
  const kind = rng.pick(['dry', 'wet']);
  const board = genFlop(rng, kind);
  const hero = rndCards(rng, 2, board);
  const pot = rng.pick([100, 150, 200]);
  const small = Math.round(pot / 3), big = Math.round((pot * 2) / 3);
  const good = kind === 'dry' ? ['small'] : ['check'];
  return choiceTask({
    rng, topic: 'cbet', code: 'post-cbet-air',
    prompt: `Вы повышали на префлопе, соперник один, вас чекнули. Флоп ${TEXTURE_RU[kind]}, у вас ничего (воздух). Учебный ориентир: на сухой доске маленький c-bet часто уместен, на мокрой — осторожнее. Что делаете?`,
    scene: scene(hero, board, pot, { history: ['Соперник: чек'] }),
    options: [
      { id: 'small', label: `Ставка ${fmtNum(small)} (1/3)`, why: kind === 'dry' ? 'Дёшево рискуете, на сухой доске у соперника мало хороших рук.' : 'На мокрой доске у соперника много дро — он чаще коллирует.' },
      { id: 'big', label: `Ставка ${fmtNum(big)} (2/3)`, why: 'Рискуете большим без руки.' },
      { id: 'check', label: 'Чек', why: kind === 'wet' ? 'На мокрой доске блеф дорог — чек разумен.' : 'Вы упускаете дешёвый шанс забрать банк.' },
    ],
    good,
    why: `Доска ${TEXTURE_RU[kind]}. ${kind === 'dry' ? 'На сухих досках мало связанных рук, ставка в треть банка часто добирается без большого риска.' : 'Мокрая доска часто попадает в диапазон соперника, блеф без дро окупается реже.'} ${GUIDE_NOTE}`,
  });
});

// ───────── уровень 5: смешанные решения по EV
const MIX_FOLD = { small: [0.3, 1 / 3], big: [0.45, 2 / 3] };
const mixed5 = ex('x-post-mixed', 'bet-sizing', 5, 'table', (seed, rng) => {
  const { hero, board, cls } = genHandOfClass(rng, ['top', 'weak', 'draw', 'air']);
  const pot = rng.pick(POTS);
  const eq = equityVsRandom(hero, board, seed);
  const opts = [['small', 'big'].map((k) => {
    const [fold, fr] = MIX_FOLD[k];
    const bet = Math.round(pot * fr);
    return { id: k, bet, fold, ev: M.evBet(pot, bet, fold, eq), label: `Ставка ${fmtNum(bet)} (${k === 'small' ? '1/3' : '2/3'})` };
  })].flat();
  opts.push({ id: 'check', ev: eq * pot, label: 'Чек' });
  const best = Math.max(...opts.map((o) => o.ev));
  const good = opts.filter((o) => best - o.ev <= 0.04 * pot).map((o) => o.id);
  good.sort((a, b) => opts.find((o) => o.id === b).ev - opts.find((o) => o.id === a).ev);
  return choiceTask({
    rng, topic: 'bet-sizing', code: 'post-mixed',
    prompt: `Флоп, вы в позиции, соперник чекнул. Допущения: на 1/3 банка он сбрасывает 30 %, на 2/3 — 45 %, иначе вы реализуете своё эквити (≈ ${pct(eq)}); чек реализует то же эквити без ставки. Принимается любой ход, потеря EV которого не больше 4 % банка.`,
    scene: scene(hero, board, pot, { history: ['Соперник: чек'] }),
    options: opts.map((o) => ({ id: o.id, label: o.label, why: `EV ≈ ${f1(o.ev)} фишек${best - o.ev <= 0.04 * pot ? ' — в допуске' : ''}.` })),
    good,
    why: `Эквити (${CLASS_RU[cls]}) ≈ ${pct(eq)}. EV чека = ${f1(opts[2].ev)}; EV ставки 1/3 = ${f1(opts[0].ev)}; 2/3 = ${f1(opts[1].ev)}. Лучший — ${f1(best)}; допустимо всё, что отстаёт не больше чем на ${f1(0.04 * pot)}. Так выглядят «смешанные» решения: несколько ходов почти равны по ценности. Допущения о фолдах — условие задачи, не данные солвера.`,
  });
});

const evBestSize5 = ex('x-post-best-size', 'bet-sizing', 5, 'bet', (seed, rng) => {
  const { hero, board } = genHandOfClass(rng, ['top', 'strong', 'draw']);
  const pot = rng.pick([100, 150, 200, 300]);
  const eq = equityVsRandom(hero, board, seed);
  // допущение: фолдов тем больше, чем крупнее ставка: f(b) = min(0.7, 0.15 + 0.5·b/pot)
  const F = (b) => Math.min(0.7, 0.15 + 0.5 * (b / pot));
  const ev = (b) => M.evBet(pot, b, F(b), eq);
  let bestB = 1, bestEv = -Infinity;
  for (let b = Math.round(pot * 0.1); b <= pot; b++) if (ev(b) > bestEv) { bestEv = ev(b); bestB = b; }
  const lo = Math.round(pot * 0.1), hi = pot;
  const tolEv = 0.03 * pot;
  const task = numberTask({
    prompt: `Флоп, соперник чекнул. Допущение: доля фолдов растёт с размером ставки b как min(70 %, 15 % + 50 % × b / банк); иначе вы реализуете эквити ≈ ${pct(eq)}. Подберите ставку с наибольшим EV (подойдёт любая, теряющая не больше 3 % банка).`,
    scene: { ...scene(hero, board, pot), min: lo, max: hi, step: 1, quick: [1 / 3, 1 / 2, 2 / 3, 1] },
    range: { min: lo, max: hi, step: 1 },
    answer: bestB, tol: 1, topic: 'bet-sizing', code: 'post-best-size',
    why: `Перебраны все ставки от ${fmtNum(lo)} до ${fmtNum(hi)}: лучшая около ${fmtNum(bestB)} (EV ≈ ${f1(bestEv)}). Допустимо всё, где EV не ниже ${f1(bestEv - tolEv)}. Модель фолдов — допущение задачи, реальный соперник сбрасывает иначе.`,
  });
  return {
    ...task,
    check(a) {
      const n = Number(a);
      if (a == null || !Number.isFinite(n)) return { ...task.check(null) };
      const ok = ev(Math.min(hi, Math.max(lo, n))) >= bestEv - tolEv;
      return {
        ok, score: ok ? 1 : 0,
        mistakes: ok ? [] : [{ code: 'post-best-size', topic: 'bet-sizing', text: `При ставке ${fmtNum(n)} EV ≈ ${f1(ev(n))}, а лучшая ставка около ${fmtNum(bestB)} даёт ≈ ${f1(bestEv)}.` }],
        why: task.check(null).why,
        alternatives: [{ label: 'Лучшая ставка', verdict: 'верно', text: `≈ ${fmtNum(bestB)}, EV ≈ ${f1(bestEv)}` }],
        solution: bestB,
      };
    },
  };
});

registerExercises('postflop', [valueOrCheck, sizeAfterCheck, sizeByTexture, cbetTexture, semiBluff3, sizeValueWet, facingBet4, textureCbet4, mixed5, evBestSize5]);
