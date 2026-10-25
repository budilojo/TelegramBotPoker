/**
 * Направление «Ауты и вероятности» (агент X). Всё считается кодом
 * (`poker-math.js`): перебор колоды, гипергеометрия, точное эквити.
 * Исключение — «правило 2 и 4»: это приближение, и в разборе рядом стоит
 * точное значение и ошибка правила.
 */
import { registerExercises } from '../engine.js';
import * as M from '../poker-math.js';
import { numberTask, cardsTask, genDraw, rndCards, sortCards, DRAW_RU, STREET_RU, unseenCount, ex, fmtDec } from './x-util.js';

const names = (cs) => cs.map(M.cardName).join(' ');
const scene = (hero, board, extra = {}) => ({ hero, board, street: STREET_RU[board.length], ...extra });
const fmt1 = (x) => fmtDec(x, 1);

// ───────── уровень 1
const countOuts = ex('x-outs-count', 'outs', 1, 'slider', (seed, rng) => {
  const type = rng.pick(['flush', 'oesd', 'gutshot']);
  const { hero, board } = genDraw(rng, type);
  const outs = M.drawOuts(hero, board);
  return numberTask({
    prompt: `У вас ${DRAW_RU[type]}. Сколько карт в колоде усиливают вашу руку (аутов)?`,
    scene: scene(hero, board, { mark: [] }),
    range: { min: 0, max: 20, step: 1, unit: '', label: 'Сколько аутов?' },
    answer: outs.length, tol: 0, fmtAns: (x) => String(x), topic: 'outs', code: 'outs-miscount',
    why: `Аут — карта, которая усиливает руку до нужной комбинации. Здесь их ${outs.length}: ${names(outs)}. Мы считаем только карты, которых вы ещё не видели.`,
  });
});

const tapFlush = ex('x-outs-tap-flush', 'outs', 1, 'cards', (seed, rng) => {
  const { hero, board } = genDraw(rng, 'flush');
  const outs = M.drawOuts(hero, board, ['flush']);
  const rest = M.remaining(hero, board).filter((c) => !outs.includes(c));
  const pool = [...outs, ...rng.shuffle(rest).slice(0, 6)];
  const suit = M.SUITS[M.suitOf(hero[0])];
  return cardsTask({
    prompt: `У вас четыре карты масти ${suit}. Коснитесь всех карт, которые дадут флеш.`,
    scene: scene(hero, board), pool, solutionCards: outs, hint: 'Коснитесь карт-аутов',
    topic: 'outs', code: 'outs-tap',
    why: `В масти 13 карт, четыре уже видны (две у вас, две на борде), поэтому остаётся 13 − 4 = ${outs.length} карт этой масти: ${names(outs)}. Карты других мастей флеш не дают.`,
  });
});

// ───────── уровень 2
const pctNext = ex('x-outs-pct-next', 'outs', 2, 'slider', (seed, rng) => {
  const type = rng.pick(['flush', 'oesd', 'gutshot']);
  const len = rng.pick([3, 4]);
  const { hero, board } = genDraw(rng, type, len);
  const o = M.drawOuts(hero, board).length;
  const left = unseenCount(len);
  const p = (o / left) * 100;
  return numberTask({
    prompt: `${STREET_RU[len]}: у вас ${DRAW_RU[type]}. Какой шанс (в процентах) поймать аут на СЛЕДУЮЩЕЙ карте?`,
    scene: scene(hero, board),
    range: { min: 0, max: 60, step: 0.5, unit: '%', label: 'Шанс на следующей карте' },
    answer: Math.round(p * 10) / 10, tol: 1.5, fmtAns: fmt1, topic: 'outs', code: 'outs-next',
    why: `Ауты: ${o}. Неизвестных карт: 52 − 2 (ваши) − ${len} (борд) = ${left}. Шанс на одной карте = ${o} / ${left} = ${fmt1(p)} %.`,
  });
});

const rule4 = ex('x-outs-rule24', 'rule-2-4', 2, 'slider', (seed, rng) => {
  const type = rng.pick(['flush', 'oesd', 'gutshot']);
  const len = rng.pick([3, 4]);
  const { hero, board } = genDraw(rng, type, len);
  const o = M.drawOuts(hero, board).length;
  const r = M.rule24(o, len);
  const mult = r.mult;
  return numberTask({
    prompt: `${STREET_RU[len]}, ${o} аутов. По правилу ${len === 3 ? '4 (до ривера)' : '2 (на ривер)'}: ауты × ${mult}. Какой шанс получается?`,
    scene: scene(hero, board),
    range: { min: 0, max: 100, step: 1, unit: '%', label: `Ауты × ${mult}` },
    answer: o * mult, tol: 0, fmtAns: (x) => String(x), topic: 'rule-2-4', code: 'rule24-apply',
    why: `Правило ${mult === 4 ? '4' : '2'}: ${o} × ${mult} = ${o * mult} %. Это быстрая прикидка: точное значение ${fmt1(r.exact * 100)} %, правило ошибается на ${fmt1(Math.abs(r.errorPp))} п. п. ${r.errorPp > 0 ? 'в большую сторону' : 'в меньшую сторону'} (приближённый способ, не точный расчёт).`,
  });
});

// ───────── уровень 3
const pctRiver = ex('x-outs-pct-river', 'outs', 3, 'slider', (seed, rng) => {
  const type = rng.pick(['flush', 'oesd', 'gutshot']);
  const { hero, board } = genDraw(rng, type);
  const o = M.drawOuts(hero, board).length;
  const p = M.hitProbability(o, 47, 2) * 100;
  const miss = M.binom(47 - o, 2), all = M.binom(47, 2);
  return numberTask({
    prompt: `Флоп, у вас ${DRAW_RU[type]} (${o} аутов). Какой точный шанс поймать аут хотя бы на одной из двух карт — тёрне или ривере?`,
    scene: scene(hero, board),
    range: { min: 0, max: 80, step: 0.5, unit: '%', label: 'Шанс к ривёру' },
    answer: Math.round(p * 10) / 10, tol: 1.5, fmtAns: fmt1, topic: 'outs', code: 'outs-river',
    why: `Проще посчитать, когда аут НЕ придёт: пар из двух «чужих» карт ${fmtNumSafe(miss)} из ${fmtNumSafe(all)}. Шанс поймать = 1 − ${fmtNumSafe(miss)} / ${fmtNumSafe(all)} = ${fmt1(p)} %. Правило 4 дало бы ${o * 4} %.`,
  });
});
const fmtNumSafe = (n) => M.fmtNum(n);

/** Комбо-дро: флеш + открытый стрит; ауты считаем без повторов (две карты работают на оба дро). */
function genCombo(rng) {
  for (let t = 0; t < 200; t++) {
    const r = rng.int(1, 8);
    const s = rng.int(0, 3);
    const ranks = rng.shuffle([r, r + 1, r + 2, r + 3]);
    const hero = [M.mk(ranks[0], s), M.mk(ranks[1], s)];
    const b = [M.mk(ranks[2], s), M.mk(ranks[3], s)];
    let x; do { x = rng.int(0, 12); } while (ranks.includes(x));
    const board = [...b, M.mk(x, (s + rng.int(1, 3)) % 4)];
    if (M.evaluate([...hero, ...board])[0] !== M.CAT.HIGH) continue;
    const ty = M.drawsOf(hero, board).map((d) => d.type).sort().join(',');
    if (ty !== 'flush,oesd') continue;
    return { hero: sortCards(hero), board };
  }
  throw new Error('genCombo');
}

const comboCount = ex('x-outs-combo', 'outs', 3, 'slider', (seed, rng) => {
  const { hero, board } = genCombo(rng);
  const fl = M.drawOuts(hero, board, ['flush']);
  const st = M.drawOuts(hero, board, ['oesd']);
  const both = fl.filter((c) => st.includes(c));
  const all = M.drawOuts(hero, board, ['flush', 'oesd']);
  return numberTask({
    prompt: 'Комбо-дро: у вас сразу флеш-дро и открытый стрит-дро. Сколько всего РАЗНЫХ карт вам помогает?',
    scene: scene(hero, board),
    range: { min: 0, max: 24, step: 1, unit: '', label: 'Сколько разных аутов?' },
    answer: all.length, tol: 0, fmtAns: (x) => String(x), topic: 'outs', code: 'outs-combo',
    why: `Флеш: ${fl.length} карт, стрит: ${st.length} карт. Но ${both.length} из них считаются дважды (${names(both)} — они дают и флеш, и стрит). Разных: ${fl.length} + ${st.length} − ${both.length} = ${all.length}.`,
  });
});

// ───────── уровень 4: «нечистые» ауты против известной руки соперника
function genDirty(rng) {
  for (let t = 0; t < 300; t++) {
    const { hero, board } = genDraw(rng, 'flush');
    const s = M.suitOf(hero[0]);
    const off = board.find((c) => M.suitOf(c) !== s);
    const suited = board.filter((c) => M.suitOf(c) === s);
    const pairWith = rng.pick(suited);
    const dead = [...hero, ...board];
    const freeSuits = (r) => [0, 1, 2, 3].filter((x) => x !== s && !dead.includes(M.mk(r, x)));
    const a = freeSuits(M.rankOf(off)), b = freeSuits(M.rankOf(pairWith));
    if (!a.length || !b.length) continue;
    const villain = [M.mk(M.rankOf(off), rng.pick(a)), M.mk(M.rankOf(pairWith), rng.pick(b))];
    if (new Set([...dead, ...villain]).size !== 7) continue;
    const { clean, dirty } = M.cleanOuts(hero, board, villain, M.drawOuts(hero, board, ['flush']));
    if (dirty.length >= 1 && clean.length >= 5) return { hero, board, villain, clean, dirty };
  }
  throw new Error('genDirty');
}

const dirtyOuts = ex('x-outs-dirty', 'outs', 4, 'cards', (seed, rng) => {
  const { hero, board, villain, clean, dirty } = genDirty(rng);
  const flushOuts = M.drawOuts(hero, board, ['flush']).filter((c) => !villain.includes(c));
  const rest = M.remaining(hero, board, villain).filter((c) => !flushOuts.includes(c));
  const pool = [...flushOuts, ...rng.shuffle(rest).slice(0, 4)];
  return cardsTask({
    prompt: `У вас флеш-дро. Вы знаете руку соперника: ${names(villain)} (у него две пары). Коснитесь только «чистых» аутов — карт, после которых вы выигрываете.`,
    scene: scene(hero, board, { history: [`Соперник: ${names(villain)}`] }), pool, solutionCards: clean,
    hint: 'Только карты, после которых вы впереди', topic: 'outs', code: 'outs-dirty',
    why: `Флеш-карт ${flushOuts.length}, но ${names(dirty)} спаривает борд: у соперника тогда фулл-хаус, а он сильнее вашего флеша. Это «нечистый» аут. Чистых: ${clean.length}.`,
  });
});

const huEquity = ex('x-outs-hu-equity', 'equity', 4, 'slider', (seed, rng) => {
  const type = rng.pick(['flush', 'oesd']);
  const { hero, board } = genDraw(rng, type);
  let villain;
  for (let t = 0; t < 200; t++) {
    const v = rndCards(rng, 2, [...hero, ...board]);
    if (M.evaluate([...v, ...board])[0] >= M.CAT.PAIR) { villain = v; break; }
  }
  const e = M.equity(hero, board, villain);
  return numberTask({
    prompt: `Флоп, у вас ${DRAW_RU[type]}. У соперника ${names(villain)}. Какова ваша доля банка в среднем (эквити, в процентах), если доиграть до конца?`,
    scene: scene(hero, board, { history: [`Соперник: ${names(villain)}`] }),
    range: { min: 0, max: 100, step: 1, unit: '%', label: 'Ваше эквити' },
    answer: Math.round(e.equity * 1000) / 10, tol: 3, fmtAns: fmt1, topic: 'equity', code: 'equity-hu',
    why: `Перебраны все ${M.fmtNum(e.n)} возможных пар карт на тёрн и ривер: вы выигрываете ${fmt1(e.win * 100)} %, делите банк ${fmt1(e.tie * 100)} %. Эквити = победы + половина ничьих = ${fmt1(e.equity * 100)} %.`,
  });
});

// ───────── уровень 5: против диапазона
const RANGES = [
  { name: 'любая пара от 88 до QQ', labels: ['88', '99', '1010', 'JJ', 'QQ'] },
  { name: 'сильные тузы и короли: AKs, AKo, AQs, KQs', labels: ['AKs', 'AKo', 'AQs', 'KQs'] },
  { name: 'пары 77–JJ и AQs', labels: ['77', '88', '99', '1010', 'JJ', 'AQs'] },
];

const vsRange = ex('x-outs-vs-range', 'equity', 5, 'slider', (seed, rng) => {
  const type = rng.pick(['flush', 'oesd']);
  const { hero, board } = genDraw(rng, type);
  const range = rng.pick(RANGES);
  const set = new Set(range.labels);
  const combos = M.rangeCombos(set, [...hero, ...board]);
  const e = M.equity(hero, board, set);
  return numberTask({
    prompt: `Флоп, у вас ${DRAW_RU[type]}. Соперник играет так: ${range.name}. Какое у вас эквити против ВСЕГО этого диапазона (в процентах)?`,
    scene: scene(hero, board, { history: [`Диапазон соперника: ${range.name} (${combos} комбинаций с учётом ваших карт и борда)`] }),
    range: { min: 0, max: 100, step: 1, unit: '%', label: 'Эквити против диапазона' },
    answer: Math.round(e.equity * 1000) / 10, tol: 4, fmtAns: fmt1, topic: 'equity', code: 'equity-range',
    why: `Перебраны ${combos} рук диапазона × все варианты тёрна и ривера (всего ${M.fmtNum(e.n)} исходов). Ваше эквити ${fmt1(e.equity * 100)} %. Диапазон — учебное допущение задания, не чтение настоящего соперника.`,
  });
});

const cleanRiver = ex('x-outs-clean-river', 'outs', 5, 'slider', (seed, rng) => {
  const { hero, board, villain, clean, dirty } = genDirty(rng);
  const pClean = M.hitProbability(clean.length, 45, 2) * 100; // 52 − 2 − 3 − 2 (карты соперника)
  const pNaive = M.hitProbability(clean.length + dirty.length, 45, 2) * 100;
  return numberTask({
    prompt: `Флоп, у вас флеш-дро, у соперника ${names(villain)} (две пары). Каков РЕАЛЬНЫЙ шанс (в %) получить выигрышный флеш хотя бы на одной из двух карт? Карты соперника вы знаете.`,
    scene: scene(hero, board, { history: [`Соперник: ${names(villain)}`] }),
    range: { min: 0, max: 80, step: 0.5, unit: '%', label: 'Реальный шанс к ривёру' },
    answer: Math.round(pClean * 10) / 10, tol: 2, fmtAns: fmt1, topic: 'outs', code: 'outs-clean-river',
    why: `Неизвестных карт: 52 − 2 − 3 − 2 (карты соперника) = 45. Чистых аутов ${clean.length} (карта ${names(dirty)} даёт ему фулл-хаус). Шанс = 1 − C(${45 - clean.length},2)/C(45,2) = ${fmt1(pClean)} %. Если считать «нечистый» аут, получилось бы ${fmt1(pNaive)} % — это завышение.`,
  });
});

registerExercises('outs', [countOuts, tapFlush, pctNext, rule4, pctRiver, comboCount, dirtyOuts, huEquity, vsRange, cleanRiver]);
