/**
 * Первые упражнения «Тренировки» (агент V): только то, что считается ТОЧНО
 * (ауты, шансы банка, старшинство комбинаций) — ничего «эталонного» из
 * солверов (docs/poker-training.md, «Честность содержания»). Остальные
 * направления наполняют W и X в своих файлах; этот файл их не заменяет.
 */
import { registerExercises, makePick } from '../engine.js';

const fmtPct = (x) => `${Math.round(x * 100)}%`;

/* ------------------------------------------------------------ ауты · уровень 1 */
const DRAWS = [
  { id: 'flush', name: 'флеш-дро (четыре карты одной масти, пятая нужна)', outs: 9, how: '13 карт масти минус 4 уже видимые = 9' },
  { id: 'oesd', name: 'открытое стрит-дро (четыре подряд, карта нужна с обоих концов)', outs: 8, how: 'по 4 карты каждого из двух нужных номиналов = 8' },
  { id: 'gutshot', name: 'гатшот (стрит не хватает одной карты в середине)', outs: 4, how: 'одного номинала осталось 4 карты' },
  { id: 'overs', name: 'две оверкарты (обе ваши карты старше борда, нужна любая из них)', outs: 6, how: '3 карты одного номинала + 3 карты другого = 6' },
];

const outsCount = {
  id: 'v-outs-count-1',
  topic: 'outs',
  level: 1,
  kind: 'pick',
  make(seed, rng) {
    const d = rng.pick(DRAWS);
    const values = [...new Set([d.outs, 4, 6, 8, 9, 12])].slice(0, 5);
    return makePick(rng, {
      prompt: `На флопе у вас ${d.name}. Сколько аутов (карт, которые сделают руку)?`,
      options: values.map((n) => ({ id: String(n), label: String(n), why: n === d.outs ? `Верно: ${d.how}.` : `${n} — это не число аутов для такого дро.` })),
      correct: String(d.outs),
      why: `Аут — карта в колоде, которая усиливает вашу руку. Здесь: ${d.how}. Эти карты вы ещё не видели, поэтому считаем все оставшиеся.`,
      mistake: { code: 'outs-miscount', topic: 'outs' },
    });
  },
};

/* ---------------------------------------------- Pot Odds · уровень 1 */
const BETS = [
  { num: 1, den: 3, name: 'треть банка' },
  { num: 1, den: 2, name: 'половину банка' },
  { num: 2, den: 3, name: 'две трети банка' },
  { num: 1, den: 1, name: 'весь банк' },
];

const potOdds = {
  id: 'v-potodds-need-1',
  topic: 'pot-odds',
  level: 1,
  kind: 'pick',
  make(seed, rng) {
    const pot = rng.pick([60, 90, 120, 150, 300]);
    const b = rng.pick(BETS);
    const bet = (pot * b.num) / b.den;
    // Колл стоит `bet`; выиграть можно банк + ставка соперника.
    const need = bet / (pot + bet + bet);
    const correct = fmtPct(need);
    const alts = [...new Set([correct, fmtPct(bet / (pot + bet)), fmtPct(bet / pot), fmtPct(1 - need)])];
    return makePick(rng, {
      prompt: `В банке ${pot}. Соперник ставит ${b.name} — ${bet}. Какой минимальный шанс выиграть нужен, чтобы колл не был убыточным?`,
      setup: { pot, bet },
      options: alts.map((l) => ({
        id: l,
        label: l,
        why: l === correct
          ? `Верно: платите ${bet}, чтобы выиграть ${pot + bet + bet} → ${bet} / ${pot + bet + bet} = ${correct}.`
          : l === fmtPct(bet / (pot + bet)) ? `Не учтён ваш собственный колл: банк после него больше (${pot + bet + bet}).` : `Это не доля колла в итоговом банке.`,
      })),
      correct,
      why: `Колл стоит ${bet}, а итоговый банк после него — ${pot} + ${bet} + ${bet} = ${pot + bet + bet}. Нужный шанс = цена колла / итоговый банк = ${bet} / ${pot + bet + bet} = ${correct}. Если ваш шанс выше — колл выгоден по шансам банка.`,
      mistake: { code: 'potodds-formula', topic: 'pot-odds' },
    });
  },
};

/* --------------------------------------- комбинации · уровень 1 (префлоп-навык) */
const RANKS = ['старшая карта', 'пара', 'две пары', 'тройка (сет)', 'стрит', 'флеш', 'фулл-хаус', 'каре', 'стрит-флеш'];

const handRanks = {
  id: 'v-handranks-1',
  topic: 'hand-ranks',
  level: 1,
  kind: 'pick',
  make(seed, rng) {
    const i = rng.int(0, RANKS.length - 1);
    let j = rng.int(0, RANKS.length - 2);
    if (j >= i) j += 1;
    const hi = Math.max(i, j);
    const lo = Math.min(i, j);
    return makePick(rng, {
      prompt: 'Какая комбинация старше?',
      options: [i, j].map((k) => ({ id: String(k), label: RANKS[k], why: k === hi ? `${RANKS[k]} — под номером ${k + 1} в лестнице комбинаций, она старше.` : `${RANKS[k]} младше.` })),
      correct: String(hi),
      why: `Лестница комбинаций от младшей к старшей: ${RANKS.join(' → ')}. «${RANKS[hi]}» стоит выше, чем «${RANKS[lo]}».`,
      mistake: { code: 'handranks-order', topic: 'hand-ranks' },
    });
  },
};

registerExercises('outs', [outsCount]);
registerExercises('potodds', [potOdds]);
registerExercises('preflop', [handRanks]);
