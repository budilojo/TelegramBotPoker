/**
 * Направление «Тренажёр диапазонов» (агент W). Эталоны — учебные ориентиры из
 * miniapp/train/ranges/data.js («откуда» — в шапке того файла): НЕ солвер.
 * Ответ вида `range` — массив кодов рук (или объект частот на уровне 5);
 * `slider` — число; в разборе `solution` — эталон в той же форме.
 */
import { registerExercises } from '../engine.js';
import { parseRange, comboCount, rangePercent, formatRange, ALL_HANDS, handInfo, freqOf } from '../ranges/hands.js';
import {
  openRange, defendRange, vs3betRange, OPEN_PCT, BB_DEFEND, VS_3BET, layeredFreq, POSITION_NAMES, ORDER, midPercent, classify, topShare,
} from '../ranges/data.js';
import { asMap, reviewRange, fmtNum, fmtPct, fmtCombos, answerForm, listHands, weightedMatch } from '../ranges/tasks.js';

const TOP = { wide: 'range-by-position', tight: 'range-by-position', hands: 'starting-hands' };

/* --------------------------- каталог сценариев: один источник для заданий */

/** Сценарий: { id, name, prompt, ref (Set), thresholds (в %), pos, mix (Map частот для ур. 5) }. */
const SCEN = {
  open: (pos) => ({
    id: `open-${pos}`, pos, ref: openRange(pos), thresholds: [OPEN_PCT[pos]],
    name: `диапазон открытия рейзом с ${pos}`,
    ask: `Соберите диапазон открытия рейзом с позиции ${POSITION_NAMES[pos]} (6 игроков, около 100 BB, до вас все сбросили)`,
    hintPct: OPEN_PCT[pos],
    mix: () => { const lf = layeredFreq([{ action: 'x', upTo: OPEN_PCT[pos] }]); const m = new Map(); for (const [c, f] of lf) if (f.x > 0) m.set(c, f.x); return m; },
    wide: 'range-by-position',
  }),
  bb: (opener) => {
    const d = defendRange('BB', opener);
    const total = BB_DEFEND[opener].total;
    return {
      id: `bb-${opener}`, pos: 'BB', opener, ref: new Set([...d.threebet, ...d.call]), thresholds: [total],
      name: `защита BB против открытия с ${opener}`,
      ask: `Вы в большом блайнде. ${POSITION_NAMES[opener]} открылся рейзом 2,5 BB, остальные сбросили. Отметьте все руки, с которыми вы продолжите (колл или 3-бет), — остальные сбрасываются`,
      hintPct: total,
      mix: () => { const lf = layeredFreq([{ action: 'x', upTo: total }]); const m = new Map(); for (const [c, f] of lf) if (f.x > 0) m.set(c, f.x); return m; },
      wide: 'blinds-defence',
    };
  },
  v3: (pos) => {
    const v = vs3betRange(pos);
    const total = VS_3BET[pos].total;
    return {
      id: `v3-${pos}`, pos, ref: new Set([...v.fourbet, ...v.call]), thresholds: [total],
      name: `продолжение против 3-бета после открытия с ${pos}`,
      ask: `Вы открыли рейзом с ${POSITION_NAMES[pos]}, а кто-то из поздних позиций сделал 3-бет. Отметьте все руки, с которыми вы продолжите (колл или 4-бет), — остальные сбрасываются`,
      hintPct: total,
      mix: () => { const lf = layeredFreq([{ action: 'x', upTo: total }]); const m = new Map(); for (const [c, f] of lf) if (f.x > 0) m.set(c, f.x); return m; },
      wide: 'defend-vs-raise',
    };
  },
};
const OPEN_POS = ['UTG', 'MP', 'CO', 'BTN', 'SB'];
const BB_OPENERS = ['UTG', 'MP', 'CO', 'BTN', 'SB'];
const V3_POS = ['UTG', 'MP', 'CO', 'BTN', 'SB'];
const scenOf = (kind, pos) => SCEN[kind](pos);
const ALL_SCEN = () => [...OPEN_POS.map((p) => scenOf('open', p)), ...BB_OPENERS.map((p) => scenOf('bb', p)), ...V3_POS.map((p) => scenOf('v3', p))];

/** Задание «соберите диапазон сценария» (без частот). */
function buildTask(sc, { withHint, text = true }) {
  const topics = { wide: sc.wide, tight: sc.wide, hands: 'starting-hands' };
  return {
    prompt: `${sc.ask}${withHint ? `. Ориентир по размеру — около ${fmtNum(sc.hintPct)} % рук` : ''}.`,
    setup: { grid: { mode: 'edit', steps: 2, text, presets: ['pairs', 'suited', 'aces', 'top:15', 'top:25'] }, scenario: sc.id },
    solution: answerForm(sc.ref),
    check: (answer) => reviewRange({ user: answer, ref: sc.ref, thresholds: sc.thresholds, topics, what: sc.name[0].toUpperCase() + sc.name.slice(1),
      extraWhy: `Руки у границы (около ${fmtNum(sc.hintPct)} %) считаются спорными и штрафуются мягче.` }),
  };
}

/* ------------------------------------------------ 1. по названию (ур. 1) */

const NAME_TOKENS = [
  ['77+', 'ATs+', 'KQo'],
  ['JJ+', 'AKs', 'AKo'],
  ['22-66', 'A5s-A2s'],
  ['TT+', 'AQs+', 'AKo'],
  ['99+', 'AJs+', 'KQs', 'AQo+'],
  ['55+', 'A9s+', 'KJs+'],
  ['T9s-65s', 'JJ-88'],
  ['AKo', 'KQo', 'QJs', 'JTs'],
  ['44-88', 'ATs-A7s', 'KTs+'],
  ['QQ+', 'AKs'],
  ['66+', 'A2s-A5s', 'KQs'],
  ['K9s+', 'Q9s+', 'J9s+'],
  ['AJo+', 'KQo', 'ATs+'],
  ['33-77', 'T9s-87s'],
];

const byName = {
  id: 'w-ranges-name-1',
  topic: 'combos',
  level: 1,
  kind: 'range',
  make(seed, rng) {
    const tokens = rng.pick(NAME_TOKENS);
    const text = tokens.join(', ');
    const ref = parseRange(text);
    return {
      prompt: `Поставьте на матрице диапазон: ${text}.`,
      setup: { grid: { mode: 'edit', steps: 2, presets: ['pairs', 'suited', 'aces'], hint: 'Пара — на диагонали, «s» (одной масти) — выше, «o» (разных) — ниже.' }, text },
      solution: answerForm(ref),
      check(answer) {
        const user = asMap(answer);
        const r = reviewRange({ user, ref, topics: { wide: 'combos', tight: 'combos', hands: 'combos' }, what: `Диапазон «${text}»`, passScore: 0.9, extraWhy: `«+» поднимает руку вверх до тузов; «-» — это отрезок от одной руки до другой. Всего ${fmtCombos(comboCount(ref))}: пары по 6 комбинаций, одномастные по 4, разномастные по 12.` });
        return r;
      },
    };
  },
};

/* --------------------------------------- 2. оценить процент (ур. 2) */

const PERCENT_SETS = [
  () => ({ name: 'все пары', set: parseRange('22+') }),
  () => ({ name: 'все одномастные руки', set: new Set(ALL_HANDS.filter((c) => c.endsWith('s'))) }),
  () => ({ name: 'пары 77+, ATs+, KQo', set: parseRange('77+, ATs+, KQo') }),
  () => ({ name: 'все руки с тузом', set: new Set(ALL_HANDS.filter((c) => c[0] === 'A')) }),
  () => ({ name: 'диапазон открытия с UTG (учебный ориентир)', set: openRange('UTG') }),
  () => ({ name: 'диапазон открытия с CO (учебный ориентир)', set: openRange('CO') }),
  () => ({ name: 'диапазон открытия с BTN (учебный ориентир)', set: openRange('BTN') }),
  () => ({ name: 'диапазон открытия с MP (учебный ориентир)', set: openRange('MP') }),
  () => ({ name: 'диапазон открытия с SB (учебный ориентир)', set: openRange('SB') }),
  () => ({ name: 'все руки, где обе карты от девятки и выше', set: new Set(ALL_HANDS.filter((c) => handInfo(c).lo <= 5)) }),
  () => ({ name: 'только разномастные руки с тузом (AKo…A2o)', set: new Set(ALL_HANDS.filter((c) => c[0] === 'A' && c.endsWith('o'))) }),
  () => ({ name: 'бродвейные карты (обе от десятки)', set: new Set(ALL_HANDS.filter((c) => handInfo(c).lo <= 4 && handInfo(c).hi <= 4)) }),
];

const estimate = {
  id: 'w-ranges-percent-2',
  topic: 'combos',
  level: 2,
  kind: 'slider',
  make(seed, rng) {
    const pick = rng.pick(PERCENT_SETS)();
    const pct = rangePercent(pick.set);
    const combos = comboCount(pick.set);
    return {
      prompt: `На матрице показан диапазон: ${pick.name}. Какую долю всех стартовых рук (из 1.326 комбинаций) он занимает, в процентах?`,
      setup: { grid: { mode: 'readonly', ref: answerForm(pick.set) }, slider: { min: 0, max: 100, step: 1, unit: '%' } },
      solution: Math.round(pct),
      check(answer) {
        const a = Number(answer);
        const err = Math.abs(a - pct);
        const score = !Number.isFinite(a) ? 0 : err <= 2 ? 1 : err <= 4 ? 0.8 : err <= 8 ? 0.4 : 0;
        const why = `${fmtCombos(combos)} из 1.326 = ${fmtPct(pct)}. Считать удобно по комбинациям: пара — 6, одномастная — 4, разномастная — 12 (а не по числу клеток). `
          + `Вы назвали ${fmtNum(a)} %, разница ${fmtNum(err)} п.п.; зачёт — в пределах 4 п.п.`;
        return {
          ok: score >= 0.7, score,
          mistakes: score >= 0.7 ? [] : [{ code: 'range-percent-off', topic: 'combos', text: `Оценка ${fmtNum(a)} % при верных ${fmtPct(pct)}.` }],
          why,
          alternatives: [{ label: 'Верный ответ', verdict: fmtPct(pct), text: `${fmtCombos(combos)} / 1.326` }],
          solution: Math.round(pct),
        };
      },
    };
  },
};

/* ------------------------------ 3. сценарии: открытие, защита, против 3-бета */

const open2 = { id: 'w-ranges-open-2', topic: 'range-by-position', level: 2, kind: 'range', make: (seed, rng) => buildTask(scenOf('open', rng.pick(['UTG', 'MP', 'CO', 'BTN'])), { withHint: true }) };
const open3 = { id: 'w-ranges-open-3', topic: 'range-by-position', level: 3, kind: 'range', make: (seed, rng) => buildTask(scenOf('open', rng.pick(OPEN_POS)), { withHint: false }) };
const bbDefend3 = { id: 'w-ranges-bbdef-3', topic: 'blinds-defence', level: 3, kind: 'range', make: (seed, rng) => buildTask(scenOf('bb', rng.pick(BB_OPENERS)), { withHint: false }) };
const vs3bet3 = { id: 'w-ranges-vs3bet-3', topic: 'defend-vs-raise', level: 3, kind: 'range', make: (seed, rng) => buildTask(scenOf('v3', rng.pick(V3_POS)), { withHint: true }) };

/* ------------------------------------- 4. найди ошибку (ур. 4) */

const findMistake = {
  id: 'w-ranges-flag-4',
  topic: 'range-by-position',
  level: 4,
  kind: 'range',
  make(seed, rng) {
    const sc = rng.pick(ALL_SCEN());
    const base = sc.ref;
    const t = sc.thresholds[0];
    const inside = ORDER.filter((c) => base.has(c) && midPercent(c) < t * 0.55);
    const outside = ORDER.filter((c) => !base.has(c) && midPercent(c) > t * 2.2);
    const removed = rng.shuffle(inside).slice(0, 1 + rng.int(0, 1));
    const added = rng.shuffle(outside).slice(0, 2);
    const shown = new Set([...base].filter((c) => !removed.includes(c)));
    for (const c of added) shown.add(c);
    const wrong = [...removed, ...added];
    return {
      prompt: `Ниже — ${sc.name}, но в нём ${wrong.length} ошибки: каких-то рук лишних, каких-то не хватает. Нажмите на клетки, которые неверны (и лишние, и пропущенные).`,
      setup: { grid: { mode: 'flag', ref: answerForm(shown) }, errorsCount: wrong.length, scenario: sc.id },
      solution: wrong,
      check(answer) {
        const flagged = new Set(Array.isArray(answer) ? answer.filter((c) => ALL_HANDS.includes(c)) : []);
        const tp = wrong.filter((c) => flagged.has(c));
        const fp = [...flagged].filter((c) => !wrong.includes(c));
        const score = flagged.size ? Math.round((tp.length / (wrong.length + fp.length)) * 100) / 100 : 0;
        const miss = wrong.filter((c) => !flagged.has(c));
        const mistakes = [];
        if (miss.length) mistakes.push({ code: 'range-flag-missed', topic: sc.wide, text: `Не найдено: ${miss.map((c) => (added.includes(c) ? `${c} — лишняя (${classify(c).label})` : `${c} — пропущена (${classify(c).label})`)).join('; ')}.` });
        if (fp.length) mistakes.push({ code: 'range-flag-false', topic: 'starting-hands', text: `Отмечено зря: ${listHands(fp)} — эти руки в эталоне на своём месте.` });
        return {
          ok: score >= 0.7, score, mistakes,
          why: `Эталон — ${sc.name}: верхние ${fmtPct(t)} рук по учебному порядку. Убрана сильная ${listHands(removed)} (она с запасом внутри границы) и добавлены явно слабые ${listHands(added)} (далеко за границей). Найдено ${tp.length} из ${wrong.length}, отмечено зря ${fp.length}.`,
          alternatives: wrong.map((c) => ({ label: c, verdict: added.includes(c) ? 'лишняя' : 'пропущена', text: classify(c).label })),
          solution: wrong,
        };
      },
    };
  },
};

/* --------------------- 5. частоты (ур. 5): «иногда» у границы */

const mixed5 = {
  id: 'w-ranges-mixed-5',
  topic: 'gto-basics',
  level: 5,
  kind: 'range',
  make(seed, rng) {
    const sc = rng.pick(ALL_SCEN());
    const ref = sc.mix();
    const t = sc.thresholds[0];
    return {
      prompt: `${sc.ask}. Касание по клетке: 1-й раз — «всегда», 2-й — «иногда» (50 %), 3-й — снять. Руки у самой границы (около ${fmtNum(t)} %) в эталоне играются «иногда».`,
      setup: { grid: { mode: 'edit', steps: 3, presets: ['pairs', 'aces', 'top:10'] }, scenario: sc.id },
      solution: answerForm(ref),
      check: (answer) => reviewRange({ user: answer, ref, thresholds: [t], topics: { wide: sc.wide, tight: sc.wide, hands: 'gto-basics' }, what: sc.name[0].toUpperCase() + sc.name.slice(1), passScore: 0.75,
        extraWhy: 'Смешанная стратегия: у границы одна и та же рука иногда играется, иногда нет — так соперник не может использовать ваш диапазон. Частота считается по комбинациям.' }),
    };
  },
};

registerExercises('ranges', [byName, estimate, open2, open3, bbDefend3, vs3bet3, findMistake, mixed5]);

export const RANGE_EXERCISES = [byName, estimate, open2, open3, bbDefend3, vs3bet3, findMistake, mixed5];
void TOP; void topShare; void formatRange; void freqOf; void weightedMatch; void asMap; void parseRange;
