/**
 * Направление «Чтение диапазонов» (агент W): что могло быть у соперника.
 * Всё, что можно посчитать, считается кодом: комбинации с учётом блокеров
 * (`combosGiven`), попадание в борд и дро — оценщик агента X (`poker-math.js`).
 * Диапазон соперника — учебный ориентир (ranges/data.js), НЕ солвер.
 * Сужение по улицам — учебное упрощение: правила названы прямо в разборе.
 */
import { registerExercises, makePick } from '../engine.js';
import { handCombos, comboCount, combosGiven, cardLabel, ALL_HANDS, rangePercent } from '../ranges/hands.js';
import { openRange, defendRange, OPEN_PCT, POSITION_NAMES, handName, midPercent, ORDER } from '../ranges/data.js';
import { reviewRange, answerForm, fmtNum, fmtPct, handsBetween, rankNote } from '../ranges/tasks.js';
import { evaluate, drawsOf } from '../poker-math.js';

const RANK_NAME = (c) => cardLabel(c);
const showCards = (cs) => cs.map(RANK_NAME).join(' ');

/** Случайные различные карты, не входящие в `dead`. */
function deal(rng, n, dead = []) {
  const left = Array.from({ length: 52 }, (_, i) => i).filter((c) => !dead.includes(c));
  return rng.shuffle(left).slice(0, n);
}
const unpaired = (b) => new Set(b.map((c) => c >> 2)).size === b.length;
function dealBoard(rng, n, dead = []) {
  for (let i = 0; i < 200; i++) { const b = deal(rng, n, dead); if (unpaired(b)) return b; }
  return deal(rng, n, dead);
}

/** Комбинации набора, живые при мёртвых картах: [{ code, hole:[a,b] }]. */
function liveCombos(set, dead) {
  const out = [];
  for (const code of set) for (const hole of handCombos(code)) if (!dead.includes(hole[0]) && !dead.includes(hole[1])) out.push({ code, hole });
  return out;
}
const baseCat = (board) => (board.length >= 5 ? evaluate(board)[0] : 0);
/** Рука «попала»: лучше, чем одна лишь доска. Для досок с парой до ривера не используется. */
const hits = (hole, board) => evaluate([...hole, ...board].slice(-7).length >= 5 ? [...hole, ...board] : [...hole, ...board])[0] > baseCat(board) || (board.length < 5 && evaluate([...hole, ...board])[0] >= 1);

/* ===== уровень 1: какая рука вероятнее у открывшегося ===== */
const open1 = {
  id: 'w-readrange-open-1', topic: 'range-reading', level: 1, kind: 'pick',
  make(seed, rng) {
    const pos = rng.pick(['UTG', 'MP', 'CO']);
    const pct = OPEN_PCT[pos];
    const inR = rng.pick(handsBetween(0, pct * 0.6));
    const out = rng.shuffle(handsBetween(Math.min(pct * 2.5, 75), 100)).slice(0, 3);
    const range = openRange(pos);
    return makePick(rng, {
      prompt: `Соперник с ${POSITION_NAMES[pos]} открылся рейзом (до него все сбросили). Какая из этих рук есть в его диапазоне открытия?`,
      setup: { opener: pos },
      options: [inR, ...out].map((c) => ({ id: c, label: `${c} — ${handName(c)}`, why: range.has(c) ? `${rankNote(c)}: входит в диапазон ${pos}.` : `${rankNote(c)}: вне диапазона ${pos} (верхние ${fmtPct(pct)}).` })),
      correct: inR,
      reveal: { grids: [{ title: `Диапазон открытия с ${pos}`, ref: answerForm(range), mark: [inR, ...out] }] },
      why: `Диапазон открытия с ${pos} — верхние ${fmtPct(pct)} рук (${fmtNum(comboCount(range))} комбо из 1.326). ${rankNote(inR)} — внутри. Остальные варианты лежат далеко за границей. Учебный ориентир, не солвер.`,
      mistake: { code: 'rr-open-hand', topic: 'range-reading' },
    });
  },
};

/* ===== уровень 2: доля готовых рук на флопе ===== */
const board2 = {
  id: 'w-readrange-board-2', topic: 'range-reading', level: 2, kind: 'slider',
  make(seed, rng) {
    const pos = rng.pick(['UTG', 'CO', 'BTN']);
    const board = dealBoard(rng, 3);
    const live = liveCombos(openRange(pos), board);
    const made = live.filter((x) => evaluate([...x.hole, ...board])[0] >= 1);
    const pct = (made.length / live.length) * 100;
    return {
      prompt: `Соперник открыл с ${POSITION_NAMES[pos]}, вы вдвоём видите флоп ${showCards(board)}. Какая доля его диапазона на этом флопе уже сделала пару или лучше (в процентах)?`,
      setup: { board, opener: pos, slider: { min: 0, max: 100, step: 1, unit: '%' } },
      solution: Math.round(pct),
      check(answer) {
        const a = Number(answer); const err = Math.abs(a - pct);
        const score = !Number.isFinite(a) ? 0 : err <= 5 ? 1 : err <= 10 ? 0.8 : err <= 20 ? 0.4 : 0;
        return {
          ok: score >= 0.7, score,
          mistakes: score >= 0.7 ? [] : [{ code: 'rr-board-share', topic: 'range-reading', text: `Оценка ${fmtNum(a)} % при верных ${fmtPct(pct)}.` }],
          why: `Из диапазона ${pos} на доске ${showCards(board)} живы ${live.length} комбинаций (карты доски убирают часть рук). Пару или лучше имеют ${made.length}, то есть ${fmtPct(pct)}. Зачёт — в пределах 10 п.п.`,
          alternatives: [{ label: 'Верный ответ', verdict: fmtPct(pct), text: `${made.length} из ${live.length} комбо` }],
          solution: Math.round(pct),
        };
      },
    };
  },
};

/* ===== уровень 3: чей это диапазон; нарисуйте 3-бет ===== */
const shape3 = {
  id: 'w-readrange-shape-3', topic: 'range-by-position', level: 3, kind: 'pick',
  make(seed, rng) {
    const pos = rng.pick(['UTG', 'MP', 'CO', 'BTN', 'SB']);
    const range = openRange(pos);
    const others = rng.shuffle(['UTG', 'MP', 'CO', 'BTN', 'SB'].filter((p) => p !== pos)).slice(0, 3);
    return makePick(rng, {
      prompt: `На матрице — диапазон открытия рейзом одного из игроков. С какой позиции он открылся?`,
      setup: { grid: { mode: 'readonly', ref: answerForm(range) } },
      options: [pos, ...others].map((p) => ({ id: p, label: POSITION_NAMES[p], why: p === pos ? `Верно: ${fmtPct(rangePercent(range))} рук.` : `У ${p} диапазон около ${fmtPct(OPEN_PCT[p])}, а здесь ${fmtPct(rangePercent(range))}.` })),
      correct: pos,
      why: `Показано ${fmtPct(rangePercent(range))} рук (${fmtNum(comboCount(range))} комбо). Чем позже позиция, тем шире диапазон: ближе всего это к ${pos} (около ${fmtPct(OPEN_PCT[pos])}).`,
      mistake: { code: 'rr-position-shape', topic: 'range-by-position' },
    });
  },
};

const threebet3 = {
  id: 'w-readrange-3bet-3', topic: 'range-reading', level: 3, kind: 'range',
  make(seed, rng) {
    const [opener, hero] = rng.pick([['CO', 'BTN'], ['UTG', 'CO'], ['MP', 'BTN'], ['CO', 'SB'], ['BTN', 'SB']]);
    const ref = defendRange(hero, opener).threebet;
    return {
      prompt: `Вы открылись рейзом с ${POSITION_NAMES[opener]}, и игрок с ${POSITION_NAMES[hero]} сделал 3-бет. Закрасьте на матрице диапазон, которым он, по учебному ориентиру, так играет.`,
      setup: { grid: { mode: 'edit', steps: 2, text: true, presets: ['pairs', 'aces', 'top:5', 'top:10'] }, opener: hero, you: opener },
      solution: answerForm(ref),
      check: (answer) => reviewRange({ user: answer, ref, thresholds: [rangePercent(ref)], topics: { wide: 'range-reading', tight: 'range-reading', hands: 'starting-hands' }, what: `3-бет с ${hero} против ${opener}`, extraWhy: '3-бет — узкий диапазон: сильные руки на вэлью и немного блефов с блокером туза (A5s, A4s).' }),
    };
  },
};

/* ===== уровень 4: блокеры ===== */
const blockers4 = {
  id: 'w-readrange-blockers-4', topic: 'combos', level: 4, kind: 'pick',
  make(seed, rng) {
    const pos = rng.pick(['UTG', 'MP', 'CO']);
    const range = openRange(pos);
    const prem = ['AA', 'KK', 'AKs', 'AKo'];
    const hero = rng.pick([['A', 'K'], ['A', 'Q'], ['K', 'J'], ['A', 'A'], ['K', 'K']]).map((r, i) => (ALL_HANDS && ((12 - 'AKQJT98765432'.indexOf(r)) * 4 + i)));
    const dead = hero;
    const free = prem.reduce((s, c) => s + (range.has(c) ? handCombos(c).length : 0), 0);
    const live = prem.reduce((s, c) => s + (range.has(c) ? combosGiven(c, dead) : 0), 0);
    const opts = [...new Set([live, free, live + 2, Math.max(0, live - 3), free - live, live + 5])].filter((n) => n >= 0).slice(0, 5);
    return makePick(rng, {
      prompt: `Соперник открылся с ${POSITION_NAMES[pos]}. У вас на руках ${showCards(hero)}. Сколько комбинаций сильнейших рук (AA, KK, AKs, AKo) может быть у него? Ваши карты убирают часть комбинаций.`,
      setup: { hole: hero, opener: pos },
      options: opts.map((n) => ({ id: String(n), label: String(n), why: n === live ? 'Верно.' : n === free ? 'Это без учёта ваших карт.' : 'Не сходится с подсчётом.' })),
      correct: String(live),
      why: `Без ваших карт в диапазоне ${pos} этих рук ${free} комбинаций (пары по 6, AKs — 4, AKo — 12). Ваши карты ${showCards(hero)} убирают часть из них — осталось ${live}. Чем больше таких карт у вас, тем реже у соперника сильнейшие руки (блокеры).`,
      mistake: { code: 'rr-blockers', topic: 'combos' },
    });
  },
};

/* ===== уровень 5: сужение по улицам ===== */
const narrow5 = {
  id: 'w-readrange-narrow-5', topic: 'range-reading', level: 5, kind: 'pick',
  make(seed, rng) {
    const pos = rng.pick(['UTG', 'CO', 'BTN']);
    const hero = deal(rng, 2);
    const full = dealBoard(rng, 5, hero);
    const flop = full.slice(0, 3);
    const turn = full.slice(0, 4);
    let live = liveCombos(openRange(pos), [...hero, ...full]);
    const start = liveCombos(openRange(pos), [...hero, ...flop]).length;
    const keepDraw = (h, b, kinds) => drawsOf(h, b).some((d) => kinds.includes(d.type));
    const fl = liveCombos(openRange(pos), [...hero, ...flop]).filter((x) => evaluate([...x.hole, ...flop])[0] >= 1 || keepDraw(x.hole, flop, ['flush', 'oesd', 'gutshot']));
    const tn = liveCombos(openRange(pos), [...hero, ...turn]).filter((x) => fl.some((y) => y.hole[0] === x.hole[0] && y.hole[1] === x.hole[1]) && (evaluate([...x.hole, ...turn].length >= 5 ? [...x.hole, ...turn] : [...x.hole, ...turn])[0] >= 1 || keepDraw(x.hole, turn, ['flush', 'oesd'])));
    const rv = live.filter((x) => tn.some((y) => y.hole[0] === x.hole[0] && y.hole[1] === x.hole[1]) && evaluate([...x.hole, ...full])[0] > evaluate(full)[0]);
    const n = rv.length;
    const opts = [...new Set([n, start, fl.length, tn.length, n + 7].filter((v) => v >= 0))].slice(0, 5);
    return makePick(rng, {
      prompt: `Соперник открылся с ${POSITION_NAMES[pos]} и продолжал ставить на всех улицах. У вас ${showCards(hero)}. Борд: флоп ${showCards(flop)}, тёрн ${RANK_NAME(full[3])}, ривер ${RANK_NAME(full[4])}. Сколько комбинаций осталось у него на ривере, если он ставил только с готовой рукой лучше борда и (на флопе и тёрне) с сильными дро? Учтите блокеры.`,
      setup: { hole: hero, board: full, opener: pos },
      options: opts.map((v) => ({ id: String(v), label: String(v), why: v === n ? 'Верно.' : v === start ? 'Это весь диапазон на флопе до сужения.' : 'Это число с одной из промежуточных улиц.' })),
      correct: String(n),
      why: `Правила сужения (учебное упрощение, не солвер): флоп — пара и лучше или дро (флеш, стрит); тёрн — пара и лучше или флеш/открытое стрит-дро; ривер — рука лучше, чем одна доска. Из диапазона ${pos} на флопе живо ${start} комбо (ваши карты и борд убирают часть), после флопа ${fl.length}, после тёрна ${tn.length}, на ривере ${n}.`,
      mistake: { code: 'rr-narrow', topic: 'range-reading' },
    });
  },
};

registerExercises('readrange', [open1, board2, shape3, threebet3, blockers4, narrow5]);
export const READRANGE_EXERCISES = [open1, board2, shape3, threebet3, blockers4, narrow5];
void hits; void midPercent; void ORDER;
