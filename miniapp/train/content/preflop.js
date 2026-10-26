/**
 * Направление «Префлоп-решения» (агент W): рука + позиция + что было до нас
 * → действие. Эталон — учебные ориентиры miniapp/train/ranges/data.js
 * (порядок рук по формуле Чена и эквити, пороги — округлённые проценты 6-max,
 * 100 BB). НЕ солвер: на границе диапазона честно сказано «спорная рука».
 * Слова ходов — по-английски (Fold, Call, Raise), как в любом покерном клиенте.
 */
import { registerExercises, makePick } from '../engine.js';
import { combosOf, comboCount, ALL_HANDS } from '../ranges/hands.js';
import {
  openRange, defendRange, vs3betRange, OPEN_PCT, BB_DEFEND, VS_OPEN, VS_3BET, OPEN_SIZE, ORDER, midPercent,
  layeredFreq, POSITION_NAMES, handName, classify, MIX_BAND,
} from '../ranges/data.js';
import { EQUITY169 } from '../ranges/equity169.js';
import { reviewRange, answerForm, fmtNum, fmtPct, handsBetween, holeOf, rankNote } from '../ranges/tasks.js';

const ACT = { fold: 'Fold', call: 'Call', raise: 'Raise', threebet: '3-bet', fourbet: '4-bet', open: 'Raise (открыть)' };
const BLUFFS = ['A5s', 'A4s'];

/** Что показать на матрице после ответа: диапазон(ы) по названию и рука задания, обведённая рамкой. */
const reveal = (code, ...grids) => ({ grids: grids.map(([title, set]) => ({ title, ref: answerForm(set), mark: [code] })) });

/** Рука из пула с учётом того, что границы-«спорные» полосы обойдены. */
const pickFrom = (rng, pool) => rng.pick(pool);

/** Общая часть: что видит игрок за столом. */
function seatSetup(rng, code, extra) {
  return { hand: code, hole: holeOf(rng, code), stackBB: 100, bb: 1, sb: 0.5, ...extra };
}

/** Действие по слоям: самое частое (для подсказки «почему»). */
function actionIn(sets, code) {
  for (const [name, set] of sets) if (set.has(code)) return name;
  return 'fold';
}

const equityLine = (code) => `эквити против случайной руки ${fmtPct(EQUITY169[code] * 100)}`;

function whyAction(code, correct, ctx) {
  return `${rankNote(code)}. ${ctx} Верный ответ по учебному ориентиру — ${ACT[correct]}. ${classify(code).label[0].toUpperCase() + classify(code).label.slice(1)}.`;
}

/** Задание-выбор «действие»: options — список id. */
function actionPick(rng, { code, prompt, setup, options, correct, ctx, topicIn, topicOut, notes = {}, reveal = null }) {
  const mistakeTopic = correct === 'fold' ? topicOut : topicIn;
  return makePick(rng, {
    prompt,
    setup,
    options: options.map((id) => ({
      id,
      label: ACT[id],
      why: id === correct ? `Верно. ${notes[id] || ''}`.trim() : notes[id] || `${ACT[id]} здесь хуже: ${rankNote(code)}.`,
    })),
    correct,
    why: whyAction(code, correct, ctx),
    reveal,
    mistake: { code: correct === 'fold' ? 'pf-too-loose' : correct === 'call' ? 'pf-call-spot' : 'pf-too-tight', topic: mistakeTopic, text: undefined },
  });
}

/* ================= уровень 1: очевидные руки ================= */

const open1 = {
  id: 'w-preflop-open-1',
  topic: 'open-raise',
  level: 1,
  kind: 'pick',
  make(seed, rng) {
    const pos = rng.pick(['UTG', 'CO', 'BTN']);
    const pct = OPEN_PCT[pos];
    const raise = rng.int(0, 1) === 0;
    const pool = raise ? handsBetween(0, pct * 0.5) : handsBetween(Math.min(pct * 2.4, 75), 100);
    const code = pickFrom(rng, pool);
    const range = openRange(pos);
    return actionPick(rng, {
      code,
      prompt: `Вы на позиции ${POSITION_NAMES[pos]}. Все до вас сбросили. Ваша рука — ${handName(code)} (${code}). Что делаете?`,
      setup: seatSetup(rng, code, { hero: pos, pot: 1.5, toCall: 1, history: 'до вас все сбросили' }),
      options: ['fold', 'raise'],
      correct: range.has(code) ? 'raise' : 'fold',
      ctx: `С ${pos} в этом ориентире открываются верхние ${fmtPct(pct)} рук (${fmtNum(comboCount(range))} комбо из 1.326).`,
      topicIn: 'open-raise',
      topicOut: 'starting-hands',
      reveal: reveal(code, [`Диапазон открытия с ${pos}`, range]),
      notes: {
        raise: range.has(code) ? 'Рука входит в диапазон открытия: рейзим, а не лимпим.' : 'Рука слишком слаба для этой позиции.',
        fold: range.has(code) ? 'Сбросить такую руку — потерять выгодный рейз.' : 'Рука вне диапазона открытия — отдаём руку без потерь.',
      },
    });
  },
};

const compare1 = {
  id: 'w-preflop-compare-1',
  topic: 'starting-hands',
  level: 1,
  kind: 'pick',
  make(seed, rng) {
    const a = rng.pick(ORDER.slice(0, 40));
    const b = rng.pick(ORDER.slice(90));
    const [x, y] = rng.int(0, 1) ? [a, b] : [b, a];
    return makePick(rng, {
      prompt: `Какая стартовая рука сильнее: ${handName(x)} (${x}) или ${handName(y)} (${y})?`,
      setup: { hands: [x, y] },
      options: [x, y].map((c) => ({ id: c, label: `${c}`, why: `${rankNote(c)}.` })),
      correct: a,
      why: `${rankNote(a)}. ${rankNote(b)}. Сильнее та, что выше в порядке: у неё больше эквити и лучше играется масть/старшинство.`,
      mistake: { code: 'pf-hand-order', topic: 'starting-hands' },
    });
  },
};

/* ================= уровень 2: пограничные руки, защита BB ================= */

const open2 = {
  id: 'w-preflop-open-2',
  topic: 'open-raise',
  level: 2,
  kind: 'pick',
  make(seed, rng) {
    const pos = rng.pick(['UTG', 'MP', 'CO', 'BTN', 'SB']);
    const pct = OPEN_PCT[pos];
    const code = pickFrom(rng, handsBetween(pct * 0.55, pct * 1.7, [pct], MIX_BAND + 0.5));
    const range = openRange(pos);
    return actionPick(rng, {
      code,
      prompt: `Вы на ${POSITION_NAMES[pos]}, до вас никто не играл. Рука — ${handName(code)} (${code}). Открываете рейзом или сбрасываете?`,
      setup: seatSetup(rng, code, { hero: pos, pot: 1.5, toCall: 1, history: 'до вас все сбросили' }),
      options: ['fold', 'raise'],
      correct: range.has(code) ? 'raise' : 'fold',
      ctx: `Граница открытия с ${pos} — верхние ${fmtPct(pct)} рук; эта рука лежит рядом с границей (${fmtPct(midPercent(code))}).`,
      topicIn: 'open-raise',
      topicOut: 'range-by-position',
      reveal: reveal(code, [`Диапазон открытия с ${pos}`, range]),
    });
  },
};

function bbPool(opener, avoidExtra = []) {
  const { total, threebet } = BB_DEFEND[opener];
  return handsBetween(0, total * 1.8, [total, threebet, ...avoidExtra], MIX_BAND + 0.5).filter((c) => !BLUFFS.includes(c) || true);
}

const bb2 = {
  id: 'w-preflop-bbdef-2',
  topic: 'blinds-defence',
  level: 2,
  kind: 'pick',
  make(seed, rng) {
    const opener = rng.pick(['CO', 'BTN', 'SB']);
    const code = pickFrom(rng, bbPool(opener));
    const d = defendRange('BB', opener);
    const correct = actionIn([['threebet', d.threebet], ['call', d.call]], code);
    const open = opener === 'SB' ? 3 : 2.5;
    return actionPick(rng, {
      code,
      prompt: `Вы в большом блайнде. ${POSITION_NAMES[opener]} открылся рейзом до ${fmtNum(open)} BB, остальные сбросили. Ваша рука — ${handName(code)} (${code}). Fold, Call или 3-bet?`,
      setup: seatSetup(rng, code, { hero: 'BB', opener, pot: 1.5 + open, toCall: open - 1, openTo: open, history: `${opener} открылся до ${open} BB` }),
      options: ['fold', 'call', 'threebet'],
      correct,
      ctx: `Против ${opener} большой блайнд защищается около ${fmtPct(BB_DEFEND[opener].total)} рук, из них 3-бетит около ${fmtPct(BB_DEFEND[opener].threebet)} (плюс блеф-3-беты A5s и A4s). Так как в банке уже есть ${fmtNum(1)} BB вашего блайнда, колл дешевле.`,
      topicIn: 'blinds-defence',
      topicOut: 'defend-vs-raise',
      reveal: reveal(code, [`3-bet из BB против ${opener}`, d.threebet], [`Call из BB против ${opener}`, d.call]),
    });
  },
};

/* ================= уровень 3: против открытия, размер, диапазон ================= */

const vsOpen3 = {
  id: 'w-preflop-vsopen-3',
  topic: 'defend-vs-raise',
  level: 3,
  kind: 'pick',
  make(seed, rng) {
    const opener = rng.pick(['UTG', 'MP', 'CO']);
    const hero = rng.pick(['CO', 'BTN', 'SB'].filter((h) => ['UTG', 'MP', 'CO', 'BTN', 'SB'].indexOf(h) > ['UTG', 'MP', 'CO', 'BTN', 'SB'].indexOf(opener)));
    const d = defendRange(hero, opener);
    const v = VS_OPEN[opener];
    const code = pickFrom(rng, handsBetween(0, (hero === 'SB' ? v.threebet + 3 : v.total) * 1.9, [v.threebet, v.total, v.threebet + 3], MIX_BAND + 0.5));
    const correct = actionIn([['threebet', d.threebet], ['call', d.call]], code);
    return actionPick(rng, {
      code,
      prompt: `${POSITION_NAMES[opener]} открылся рейзом до 2,5 BB, до вас все сбросили. Вы на ${POSITION_NAMES[hero]}. Рука — ${handName(code)} (${code}). Что делаете?`,
      setup: seatSetup(rng, code, { hero, opener, pot: 4, toCall: 2.5, openTo: 2.5, history: `${opener} открылся до 2,5 BB` }),
      options: ['fold', 'call', 'threebet'],
      correct,
      ctx: hero === 'SB'
        ? `Из малого блайнда против открытия играют «3-bet или Fold»: Call без позиции и с двумя игроками позади невыгоден. 3-бет — верхние ${fmtPct(v.threebet + 3)} рук.`
        : `Против открытия с ${opener} 3-бетят верхние ${fmtPct(v.threebet)} рук, уравнивают до ${fmtPct(v.total)} в сумме. Остальное — Fold: открывший силён ранней позицией.`,
      topicIn: 'defend-vs-raise',
      topicOut: 'starting-hands',
      reveal: reveal(code, [`3-bet с ${hero} против ${opener}`, d.threebet], [`Call с ${hero} против ${opener}`, d.call]),
    });
  },
};

const size3 = {
  id: 'w-preflop-size-3',
  topic: 'open-raise',
  level: 3,
  kind: 'table',
  make(seed, rng) {
    const pos = rng.pick(['UTG', 'CO', 'BTN', 'SB']);
    const pct = OPEN_PCT[pos];
    const raise = rng.int(0, 3) > 0;
    const code = pickFrom(rng, raise ? handsBetween(0, pct * 0.7) : handsBetween(Math.min(pct * 2, 75), 100));
    const ideal = OPEN_SIZE[pos];
    const sol = openRange(pos).has(code) ? { action: 'raise', to: ideal } : { action: 'fold' };
    return {
      prompt: `Вы на ${POSITION_NAMES[pos]}, до вас все сбросили, стеки 100 BB. Рука — ${handName(code)} (${code}). Выберите действие и, если Raise, размер рейза (до скольки BB).`,
      setup: seatSetup(rng, code, { hero: pos, pot: 1.5, toCall: 1, legal: { minRaise: 2, maxRaise: 100 }, history: 'до вас все сбросили' }),
      solution: sol,
      check(answer) {
        const a = answer?.action;
        const to = Number(answer?.to);
        const mistakes = [];
        let score = 0;
        if (sol.action === 'fold') {
          score = a === 'fold' ? 1 : 0;
          if (a !== 'fold') mistakes.push({ code: 'pf-too-loose', topic: 'starting-hands', text: `${code} вне диапазона открытия с ${pos} (верхние ${fmtPct(pct)}).` });
        } else if (a === 'fold') {
          mistakes.push({ code: 'pf-too-tight', topic: 'open-raise', text: `${code} входит в диапазон открытия с ${pos}.` });
        } else if (a === 'call') {
          mistakes.push({ code: 'pf-limp', topic: 'open-raise', text: 'Лимп (Call блайнда) отдаёт инициативу и приглашает всех; в этом ориентире открываются только рейзом.' });
        } else if (a === 'raise' && Number.isFinite(to)) {
          const lo = ideal * 0.8;
          const hi = ideal * 1.4;
          if (to >= lo && to <= hi) score = 1;
          else if (to >= ideal * 0.7 && to <= ideal * 2) { score = 0.6; mistakes.push({ code: 'pf-size', topic: 'bet-sizing', text: `Размер ${fmtNum(to)} BB: стандартный для ${pos} — около ${fmtNum(ideal)} BB (допустимо ${fmtNum(lo)}–${fmtNum(hi)}).` }); }
          else { score = 0.2; mistakes.push({ code: 'pf-size', topic: 'bet-sizing', text: `Размер ${fmtNum(to)} BB слишком ${to < ideal ? 'мал — соперники получают дешёвый вход' : 'велик — вы рискуете больше, чем нужно'}.` }); }
        }
        return {
          ok: score >= 0.7, score, mistakes,
          why: `${rankNote(code)}. С ${pos} открываются верхние ${fmtPct(pct)} рук; ${sol.action === 'fold' ? 'эта рука вне диапазона — Fold.' : `размер открытия по правилу порядка — около ${fmtNum(ideal)} BB (${pos === 'SB' ? 'из малого блайнда чуть больше, так как вы потом без позиции' : '2,5 BB: достаточно, чтобы не пускать дёшево, и не слишком рискованно'}).`} Размеры — ориентир, а не солвер.`,
          alternatives: [
            { label: 'Fold', verdict: sol.action === 'fold' ? 'верно' : 'неверно', text: sol.action === 'fold' ? 'Рука вне диапазона.' : 'Теряете выгодную руку.' },
            { label: 'Raise', verdict: sol.action === 'raise' ? `верно, ${fmtNum(ideal)} BB` : 'неверно', text: sol.action === 'raise' ? `Допустимо ${fmtNum(ideal * 0.8)}–${fmtNum(ideal * 1.4)} BB.` : 'Рука слабее границы диапазона.' },
            { label: 'Call (лимп)', verdict: 'неверно', text: 'Лимп отдаёт инициативу.' },
          ],
          solution: sol,
        };
      },
    };
  },
};

const rangeBtn3 = {
  id: 'w-preflop-range-3',
  topic: 'open-raise',
  level: 3,
  kind: 'range',
  make(seed, rng) {
    const pos = rng.pick(['UTG', 'MP', 'CO', 'BTN', 'SB']);
    const ref = openRange(pos);
    return {
      prompt: `Выберите на матрице все руки, которые вы откроете рейзом с ${POSITION_NAMES[pos]} (до вас все сбросили). Без подсказок.`,
      setup: { grid: { mode: 'edit', steps: 2, text: true, presets: ['pairs', 'suited', 'aces', 'top:15', 'top:25'] }, position: pos },
      solution: answerForm(ref),
      check: (answer) => reviewRange({ user: answer, ref, thresholds: [OPEN_PCT[pos]], topics: { wide: 'open-raise', tight: 'open-raise', hands: 'starting-hands' }, what: `Открытие с ${pos}` }),
    };
  },
};

/* ================= уровень 4: против 3-бета, борьба блайндов ================= */

const vs3bet4 = {
  id: 'w-preflop-vs3bet-4',
  topic: 'defend-vs-raise',
  level: 4,
  kind: 'pick',
  make(seed, rng) {
    const hero = rng.pick(['UTG', 'MP', 'CO', 'BTN', 'SB']);
    const v = vs3betRange(hero);
    const t = VS_3BET[hero];
    const code = pickFrom(rng, handsBetween(0, t.total * 2.2, [t.fourbet, t.total], MIX_BAND + 0.5).filter((c) => openRange(hero).has(c)));
    const correct = actionIn([['fourbet', v.fourbet], ['call', v.call]], code);
    const threeTo = hero === 'BTN' || hero === 'CO' ? 7.5 : 9;
    return actionPick(rng, {
      code,
      prompt: `Вы открылись рейзом 2,5 BB с ${POSITION_NAMES[hero]}, и кто-то из поздних позиций сделал 3-бет до ${fmtNum(threeTo)} BB. Ваша рука — ${handName(code)} (${code}). Что делаете?`,
      setup: seatSetup(rng, code, { hero, openTo: 2.5, threeBetTo: threeTo, pot: 2.5 + threeTo + 1.5, toCall: threeTo - 2.5, history: `вы открылись, 3-bet до ${threeTo} BB` }),
      options: ['fold', 'call', 'fourbet'],
      correct,
      ctx: `Против 3-бета с ${hero} продолжают верхние ${fmtPct(t.total)} вашего диапазона: 4-бетят около ${fmtPct(t.fourbet)}, уравнивают остальное из этих рук.`,
      topicIn: 'defend-vs-raise',
      topicOut: 'range-by-position',
      reveal: reveal(code, [`4-bet с ${hero}`, v.fourbet], [`Call 3-бета с ${hero}`, v.call]),
    });
  },
};

const sb4 = {
  id: 'w-preflop-sb-4',
  topic: 'blinds-defence',
  level: 4,
  kind: 'pick',
  make(seed, rng) {
    const pct = OPEN_PCT.SB;
    const code = pickFrom(rng, handsBetween(pct * 0.5, pct * 1.6, [pct], MIX_BAND + 0.5));
    const range = openRange('SB');
    return actionPick(rng, {
      code,
      prompt: `Все сбросили до вас, вы в малом блайнде, остался только большой блайнд. Рука — ${handName(code)} (${code}). Рейз до 3 BB или Fold? (Лимп здесь не рассматриваем.)`,
      setup: seatSetup(rng, code, { hero: 'SB', pot: 1.5, toCall: 0.5, history: 'все сбросили, остался BB' }),
      options: ['fold', 'raise'],
      correct: range.has(code) ? 'raise' : 'fold',
      ctx: `В борьбе блайндов остаётся один соперник, и вы платите лишь ${fmtNum(0.5)} BB, чтобы войти. Поэтому диапазон широкий — около ${fmtPct(pct)}. Но позиции у вас не будет, потому стандартный размер 3 BB.`,
      topicIn: 'blinds-defence',
      topicOut: 'range-by-position',
      reveal: reveal(code, ['Диапазон SB в борьбе блайндов', range]),
    });
  },
};

/* ================= уровень 5: смешанные частоты ================= */

const MIX_SCEN = [
  () => { const pos = 'BTN'; return { name: `BB против открытия с ${pos}`, layers: [{ action: 'threebet', upTo: BB_DEFEND[pos].threebet }, { action: 'call', upTo: BB_DEFEND[pos].total }], rest: 'fold', opts: ['fold', 'call', 'threebet'], ctx: { hero: 'BB', opener: pos, pot: 5.5, toCall: 1.5, openTo: 2.5 } }; },
  () => { const pos = 'CO'; return { name: `BB против открытия с ${pos}`, layers: [{ action: 'threebet', upTo: BB_DEFEND[pos].threebet }, { action: 'call', upTo: BB_DEFEND[pos].total }], rest: 'fold', opts: ['fold', 'call', 'threebet'], ctx: { hero: 'BB', opener: pos, pot: 5.5, toCall: 1.5, openTo: 2.5 } }; },
  () => { const pos = 'BTN'; return { name: `открытие с ${pos}`, layers: [{ action: 'raise', upTo: OPEN_PCT[pos] }], rest: 'fold', opts: ['fold', 'raise', 'call'], ctx: { hero: pos, pot: 1.5, toCall: 1 } }; },
  () => { const pos = 'CO'; return { name: `открытие с ${pos}`, layers: [{ action: 'raise', upTo: OPEN_PCT[pos] }], rest: 'fold', opts: ['fold', 'raise', 'call'], ctx: { hero: pos, pot: 1.5, toCall: 1 } }; },
  () => { const pos = 'CO'; return { name: `ответ на 3-бет после открытия с ${pos}`, layers: [{ action: 'fourbet', upTo: VS_3BET[pos].fourbet }, { action: 'call', upTo: VS_3BET[pos].total }], rest: 'fold', opts: ['fold', 'call', 'fourbet'], ctx: { hero: pos, pot: 12.5, toCall: 5, openTo: 2.5, threeBetTo: 7.5 } }; },
];

const mixed5 = {
  id: 'w-preflop-mixed-5',
  topic: 'gto-basics',
  level: 5,
  kind: 'pick',
  make(seed, rng) {
    const sc = rng.pick(MIX_SCEN)();
    const lf = layeredFreq(sc.layers, sc.rest);
    const boundaryHands = ORDER.filter((c) => !BLUFFS.includes(c) && Object.values(lf.get(c)).some((v) => v === 0.5));
    const code = pickFrom(rng, boundaryHands);
    const f = lf.get(code);
    const main = Object.entries(f).filter(([, v]) => v > 0).map(([k]) => k);
    const prompt = `Спорная рука у границы диапазона — ${sc.name}. Рука — ${handName(code)} (${code}). Выберите действие. (Эту руку учебный ориентир играет «иногда»: любое из двух действий зачтётся.)`;
    const opts = [...sc.opts].sort((x, y) => ((f[x] ?? 0) > 0) - ((f[y] ?? 0) > 0)); // играемые варианты — в конце
    const labels = Object.fromEntries(opts.map((o) => [o, ACT[o]]));
    return {
      prompt,
      setup: seatSetup(rng, code, { ...sc.ctx, options: opts.map((id) => ({ id, label: labels[id] })), history: sc.name }),
      solution: main[0],
      check(answer) {
        const chosen = f[answer] ?? 0;
        const best = Math.max(...Object.values(f));
        const score = chosen / best;
        const okAns = chosen >= 0.4;
        return {
          ok: okAns, score: Math.round(score * 100) / 100,
          mistakes: okAns ? [] : [{ code: 'pf-mixed', topic: 'gto-basics', text: `Для ${code} это действие не из частот ориентира (${main.map((m) => `${labels[m] || m} ${fmtNum(f[m] * 100)} %`).join(', ')}).` }],
          why: `${rankNote(code)}. Эта рука лежит у границы между действиями: в смешанной стратегии её играют «иногда ${main.map((m) => (labels[m] || 'Fold')).join(', иногда ')}» (по ${fmtNum(50)} %). Так соперник не может использовать ваш диапазон. Полоса «иногда» — ±${fmtNum(MIX_BAND)} п.п. вокруг границы; частоты — учебный ориентир, не солвер.`,
          alternatives: opts.map((k) => ({ label: labels[k], verdict: (f[k] ?? 0) > 0 ? 'верно' : 'неверно', text: (f[k] ?? 0) > 0 ? `входит в смесь: ${fmtNum(f[k] * 100)} %` : 'эта рука так не играется' })),
          solution: main[0],
        };
      },
    };
  },
};

registerExercises('preflop', [open1, compare1, open2, bb2, vsOpen3, size3, rangeBtn3, vs3bet4, sb4, mixed5]);

export const PREFLOP_EXERCISES = [open1, compare1, open2, bb2, vsOpen3, size3, rangeBtn3, vs3bet4, sb4, mixed5];
void combosOf; void ALL_HANDS; void bbPool;
