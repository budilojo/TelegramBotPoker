'use strict';
/**
 * Бот нардов: соперник для одиночной партии (вход из лички).
 *
 * Решает ТОЛЬКО по своему виду стола (`view`) — доска, выпавшие кубики, уже
 * сыгранные шаги этого хода. Будущих кубиков в виде нет (их ещё не
 * бросали), в комнату бот не смотрит. Ходит через тот же `handle`, что и
 * человек: «Бросить» (числа выбросит сервер), шаги по одному, «Готово».
 * Ядро зовёт `decide`, пока ход его.
 */
import { LEVELS, chooseSequence } from './engine.js';
import { key } from './board.js';
import { HEAD_DOUBLES } from './rules.js';
import * as N from './rules.js';

export { LEVELS };

/**
 * План хода: бот зовётся на каждый шаг, а думает раз за ход — следующий шаг
 * берётся из выбранной последовательности, пока сыгранное с ней совпадает.
 */
const plans = new Map();
const PLANS_MAX = 200;
const same = (a, b) => a.from === b.from && a.to === b.to && a.die === b.die;

const clampLevel = (v) => Math.max(0, Math.min(LEVELS.length - 1, Math.round(Number(v)) || 0));
const sign = (c) => (c === 'w' ? 1 : -1);

/** Позиция начала хода — по виду: вернуть сыгранные шаги назад. */
function turnStart(m) {
  const c = m.turn;
  const b = m.board.slice();
  const off = { ...m.off };
  for (const s of m.played.slice().reverse()) {
    b[s.from] += sign(c);
    if (s.to < 0) off[c] -= 1;
    else b[s.to] -= sign(c);
  }
  return { b, off, t: c };
}

/** Можно ли сегодня две с головы — по виду, как и сервер: второй игрок, первый бросок, 3-3/4-4/6-6. */
function headLimitOf(m) {
  const c = m.turn;
  const first = c !== m.first && !m.log.some((x) => x.c === c);
  return first && m.dice[0] === m.dice[1] && HEAD_DOUBLES.includes(m.dice[0]) ? 2 : 1;
}

export default {
  catalog: () => ({
    levels: LEVELS.map((l) => l.name),
    defaultLevel: 1,
    levelHints: [
      'Ходит почти наугад, но снять шашку не упустит — для первых партий.',
      'Часто ходит как попало — обыграть можно.',
      'Играет толково, но то и дело небрежничает.',
      'Ошибается редко.',
      'Не ошибается: каждый ход — лучший по его оценке.',
    ],
  }),

  settings(raw = {}) {
    return { base: raw.base ?? 0, inc: raw.inc ?? 0, side: raw.side ?? 'random' };
  },
  lineup(raw = {}) {
    return [{ type: 'engine', level: clampLevel(raw.level ?? 1) }];
  },
  seat(room, spec, i) {
    const p = N.addPlayer(room, { id: `bot${i + 1}`, tgId: 0, name: `🤖 ${LEVELS[spec.level].name}`, dm: null });
    if (!p.error) p.bot = { ...spec };
    return p;
  },
  /** Пауза: бросок — подольше (посмотреть на кубики), шаг — покороче. */
  delay: (room, p, w, rng) => 450 + Math.floor(rng() * 450),
  wants: () => [],

  decide({ view, me, rng }) {
    const L = view.legal;
    if (!L?.myTurn) return null;
    if (L.phase === 'roll') return { t: 'roll' };
    if (L.phase === 'done') return { t: 'end' };
    const m = view.match;
    const start = turnStart(m);
    const level = me.bot.level;
    const headLimit = headLimitOf(m);
    const k = `${me.id}|${key(start)}|${m.dice.join()}|${level}|${headLimit}`;
    let seq = plans.get(k);
    if (!seq || seq.length <= m.played.length || !m.played.every((x, i) => same(x, seq[i]))) {
      seq = chooseSequence(start, m.dice, m.played, level, { headLimit, seed: Math.floor(rng() * 2 ** 31) });
      if (plans.size >= PLANS_MAX) plans.delete(plans.keys().next().value);
      plans.set(k, seq);
    }
    const next = seq?.[m.played.length];
    if (!next) return { t: 'end' };
    return { t: 'move', from: next.from, die: next.die, turn: m.turns };
  },

  /** Запасной ход: первый допустимый шаг из вида, или «Бросить» / «Готово». */
  fallback(view) {
    const L = view.legal;
    if (!L?.myTurn) return null;
    if (L.phase === 'roll') return { t: 'roll' };
    if (L.phase === 'done') return { t: 'end' };
    const s = L.next?.[0];
    return s ? { t: 'move', from: s.from, die: s.die } : null;
  },
};
