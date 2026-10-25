/**
 * Направление «Разбор сложных раздач» (агент X): целая раздача по улицам
 * (флоп → тёрн → ривер, 2–3 решения подряд), на каждом решении — свой выбор,
 * потом общий разбор по шагам.
 *
 * Честно о границах: префлоп здесь только «история» (эталонных префлоп-диапазонов
 * нет, контракт 9), поэтому решений 2–3, а не 4–6. Диапазон соперника — УЧЕБНОЕ
 * ДОПУЩЕНИЕ, названное в задании; эквити на каждой улице считается ТОЧНО
 * перебором против этого диапазона. Раздача идёт по «основной линии»:
 * после верного хода (колл/ставка) продолжается; если верный ход — фолд, раздача
 * на этом заканчивается.
 */
import { registerExercises } from '../engine.js';
import * as M from '../poker-math.js';
import { rndCards, seatsHU, ex, fmtNum, fmtDec, STREET_RU, GUIDE_NOTE } from './x-util.js';

const f1 = (x) => fmtDec(x, 1);
const pct = (x) => `${f1(x * 100)} %`;
const names = (cs) => cs.map(M.cardName).join(' ');

/** Учебные диапазоны соперника (допущения; не солвер, не «эталон»). */
const VILLAIN_RANGES = [
  { name: 'сильные пары и тузы: 88+, AQs+, AKo', labels: ['88', '99', '1010', 'JJ', 'QQ', 'KK', 'AA', 'AQs', 'AKs', 'AKo'] },
  { name: 'пары и бродвей: 77+, AJs+, KQs, AQo+', labels: ['77', '88', '99', '1010', 'JJ', 'QQ', 'AJs', 'AQs', 'AKs', 'KQs', 'AQo', 'AKo'] },
  { name: 'средние пары, сьютед-коннекторы, тузы: 55–TT, A9s+, T9s, 98s, 87s', labels: ['55', '66', '77', '88', '99', '1010', 'A9s', 'A10s', 'AJs', 'AQs', 'AKs', '87s', '98s', '109s'] },
];

const STEPS_BY_LEVEL = { 1: 2, 2: 2, 3: 3, 4: 3, 5: 3 };
const BAND_BY_LEVEL = { 1: 0.0, 2: 0.02, 3: 0.03, 4: 0.03, 5: 0.04 };
const FRACS_BY_LEVEL = { 1: [0.5], 2: [0.5, 2 / 3], 3: [0.5, 2 / 3, 1], 4: [1 / 3, 0.5, 2 / 3, 1], 5: [1 / 3, 0.5, 2 / 3, 1, 1.5] };

/** Эквити героя против диапазона на данном борде (точно). null — диапазон пуст. */
function eqVs(hero, board, labels) {
  const set = new Set(labels);
  if (!M.rangeCombos(set, [...hero, ...board])) return null;
  return M.equity(hero, board, set, { exact: true }).equity;
}

/**
 * Собрать раздачу и верные ходы по улицам.
 * role 'defend' — соперник ставит, вы решаете (фолд/колл/рейз);
 * role 'attack' — соперник чекает, вы решаете (чек/ставка).
 */
function buildHand(rng, level, role) {
  const nSteps = STEPS_BY_LEVEL[level];
  const band = BAND_BY_LEVEL[level];
  for (let attempt = 0; attempt < 300; attempt++) {
    const range = rng.pick(VILLAIN_RANGES);
    const labels = range.labels;
    const hero = rndCards(rng, 2);
    const runout = rndCards(rng, 5, hero);
    let pot = rng.pick([30, 40, 60, 80]); // банк на флопе
    const steps = [];
    let alive = true;
    for (let s = 0; s < nSteps && alive; s++) {
      const board = runout.slice(0, 3 + s);
      const eq = eqVs(hero, board, labels);
      if (eq == null) { alive = false; break; }
      const frac = rng.pick(FRACS_BY_LEVEL[level]);
      const bet = Math.max(2, Math.round(pot * frac));
      let good, text, kind;
      if (role === 'defend') {
        const need = M.requiredEquity(pot, bet);
        if (eq >= 0.78) good = ['raise', 'call'];
        else if (eq > need + band) good = ['call'];
        else if (eq < need - band) good = ['fold'];
        else good = ['call', 'fold'];
        kind = 'defend';
        text = `${STREET_RU[board.length]}: соперник ставит ${fmtNum(bet)} в банк ${fmtNum(pot)}. Нужно ${pct(need)}, у вас ${pct(eq)} против его диапазона.`;
        steps.push({ board, pot, bet, eq, need, good, kind, text, options: [{ id: 'fold', label: 'Фолд' }, { id: 'call', label: 'Колл' }, { id: 'raise', label: 'Рейз' }] });
        if (good[0] === 'fold' && good.length === 1) alive = false;
        else pot += 2 * bet;
      } else {
        // соперник чекает; если вы ставите, он коллирует лишь лучшей половиной диапазона
        const hands = M.rangeHands(new Set(labels), [...hero, ...board]);
        const scored = hands.map((h) => ({ h, sc: M.evaluate([...h, ...board]) })).sort((a, b) => M.compareHands(b.sc, a.sc));
        const callPart = scored.slice(0, Math.max(1, Math.ceil(scored.length / 2)));
        const heroSc = M.evaluate([...hero, ...board]);
        let w = 0;
        for (const c of callPart) { const r = M.compareHands(heroSc, c.sc); w += r > 0 ? 1 : r === 0 ? 0.5 : 0; }
        const eqCall = w / callPart.length;
        const betAmt = Math.max(2, Math.round(pot * 0.5));
        if (eqCall >= 0.5 + band) good = ['bet'];
        else if (eqCall < 0.5 - band) good = ['check'];
        else good = ['bet', 'check'];
        kind = 'attack';
        text = `${STREET_RU[board.length]}: соперник чекнул, банк ${fmtNum(pot)}. Против лучшей половины его диапазона (с чем он заколлирует ставку 1/2 банка) ваши шансы выиграть — ${pct(eqCall)}.`;
        steps.push({ board, pot, bet: betAmt, eq: eqCall, need: 0.5, good, kind, text, options: [{ id: 'check', label: 'Чек' }, { id: 'bet', label: `Ставка ${fmtNum(betAmt)} (1/2)` }] });
        if (good.includes('bet')) pot += 2 * betAmt;
      }
    }
    if (steps.length < 2) continue;
    // с третьего уровня решения не должны быть все одинаковыми
    const kinds = new Set(steps.map((x) => x.good[0]));
    if (kinds.size < 2 && level >= 3) continue;
    // соперник «показывает» случайную руку из диапазона, совместимую с бордом
    const vh = M.rangeHands(new Set(labels), [...hero, ...runout]);
    const villain = vh.length ? vh[rng.int(0, vh.length - 1)] : null;
    return { hero, runout, range, steps, villain, role };
  }
  throw new Error(`hands: не собралась раздача (уровень ${level}, ${role})`);
}

function handExercise(id, level, role) {
  const topic = role === 'defend' ? 'pot-odds' : 'value-bluff';
  return ex(id, topic, level, 'table', (seed, rng) => {
    const h = buildHand(rng, level, role);
    const { hero, steps, range } = h;
    const header = role === 'defend'
      ? `Вы в позиции, соперник на каждой улице ставит. Допущение (не данные солвера): его диапазон — ${range.name}.`
      : `Вы в позиции, соперник на каждой улице чекает. Допущение (не данные солвера): его диапазон — ${range.name}.`;
    return {
      prompt: `Разберите раздачу по улицам: на каждой выберите ход. ${header}`,
      setup: {
        hero, seats: seatsHU({ heroStack: 1000, villainStack: 1000 }), history: [header],
        steps: steps.map((s, i) => ({
          title: `${STREET_RU[s.board.length]} (${i + 1} из ${steps.length})`,
          text: s.text, board: s.board, pot: s.pot, bet: s.kind === 'defend' ? s.bet : null,
          options: s.options, street: STREET_RU[s.board.length],
        })),
      },
      solution: steps.map((s) => s.good[0]),
      isComplete: (a) => Array.isArray(a) && a.length === steps.length && a.every((x) => typeof x === 'string'),
      check(answer) {
        const picks = Array.isArray(answer) ? answer : [];
        const ok = steps.map((s, i) => s.good.includes(picks[i]));
        const score = ok.filter(Boolean).length / steps.length;
        const mistakes = [];
        const alternatives = [];
        let lost = 0;
        steps.forEach((s, i) => {
          const label = (oid) => s.options.find((o) => o.id === oid)?.label ?? '—';
          const stepName = STREET_RU[s.board.length];
          if (!ok[i]) {
            const tag = stepName === 'Флоп' ? 'flop' : stepName === 'Тёрн' ? 'turn' : 'river';
            mistakes.push({ code: `hand-${s.kind}-${tag}`, topic, text: `${stepName}: выбрано «${label(picks[i])}», верно «${label(s.good[0])}».` });
            if (s.kind === 'defend') {
              const evc = M.evCall(s.eq, s.pot, s.bet);
              if (picks[i] === 'call' && evc < 0) lost += -evc;
              if (picks[i] === 'fold' && evc > 0) lost += evc;
            }
          }
          alternatives.push({
            label: `${stepName}: ${s.options.map((o) => o.label).join(' / ')}`,
            verdict: ok[i] ? 'верно' : 'ошибка',
            text: `${s.text} Верно: ${s.good.map(label).join(' или ')}.${s.kind === 'defend' ? ` EV колла = ${f1(M.evCall(s.eq, s.pot, s.bet))} фишек.` : ''}`,
          });
        });
        const reveal = h.villain ? ` Карты соперника в этой раздаче: ${names(h.villain)} (в расчёт они не входят — решения принимаются против всего диапазона).` : '';
        const tail = lost > 0 ? ` Ошибки в среднем стоили ≈ ${f1(lost)} фишек EV (по тем же числам, что в разборе).` : '';
        return {
          score,
          mistakes,
          why: `Всего решений: ${steps.length}, верно ${ok.filter(Boolean).length}. Эквити на каждой улице считается точным перебором против названного диапазона, нужное — по формуле ставка / (банк + 2 × ставка).${tail}${reveal} Диапазон соперника — допущение задачи; ${GUIDE_NOTE}`,
          alternatives,
          solution: steps.map((s) => s.good),
        };
      },
    };
  });
}

const list = [];
for (let level = 1; level <= 5; level++) {
  list.push(handExercise(`x-hand-defend-${level}`, level, 'defend'));
  list.push(handExercise(`x-hand-attack-${level}`, level, 'attack'));
}
registerExercises('hands', list);
