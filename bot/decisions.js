'use strict';
/**
 * Журнал решений игрока в покере и грубая оценка их качества (агент Y, волна 3).
 *
 * ЧТО ПИШЕМ — только решения САМОГО человека и только то, что он видел сам:
 * его две карты, открытый борд, банк, сколько доплачивать, его стек, позицию,
 * число соперников. Чужих карт здесь нет физически: снимок строится из
 * `holeOf(room, uid)` и `boardShown(room)`, а чужие карманные карты функция
 * не читает. Бот не пишет за себя. Исход раздачи (выиграл/проиграл) не пишется
 * вовсе — оценка по исходу невозможна по построению.
 *
 * ОЦЕНКА — эвристика, не солвер. Ошибкой помечается только очевидное и
 * измеримое (шансы банка против шанса выиграть). Сомнительное — `unknown`, и в
 * учёт не идёт. Решения 071–075.
 */
import { holeOf, boardShown } from './cards.js';
import { legalActions, totalPot } from '../server/game.js';
import { equity as monteCarlo, strength } from './games/poker/bot.js';

export const KEEP = 300; // сколько последних решений хранится на игрока
export const SIMS = 160; // прогонов Монте-Карло на одно решение
export const MIN_TOTAL = 40; // меньше — «по истории» недоступна
export const MIN_PER_SKILL = 5; // меньше оценённых по навыку — навык «мало данных»

/* --------------------------------------------------------------- карты */

const RANK_CH = '23456789TJQKA';
export const codes = (cs) => (cs || []).join(' ');
export const parseCodes = (s) => (typeof s === 'string' && s.trim() ? s.trim().split(/\s+/).map(Number) : []);

/** Класс стартовой руки: 'AA', 'AKs', 'T9o'. */
export function handClass(hole) {
  if (!hole || hole.length !== 2) return null;
  const [a, b] = hole.map((c) => ({ r: c >> 2, s: c & 3 })).sort((x, y) => y.r - x.r);
  if (a.r === b.r) return RANK_CH[a.r] + RANK_CH[b.r];
  return RANK_CH[a.r] + RANK_CH[b.r] + (a.s === b.s ? 's' : 'o');
}

const PREMIUM = new Set(['AA', 'KK', 'QQ', 'AKs', 'AKo']);

/* ------------------------------------------------------------- позиция */

/** Позиция по кругу от баттона среди тех, кто в раздаче. */
export function positionOf(room, uid) {
  const h = room.hand;
  const seats = room.players.filter((p) => p.inHand);
  const n = seats.length;
  const d = seats.findIndex((p) => p.id === h.dealerId);
  const me = seats.findIndex((p) => p.id === String(uid));
  if (n < 2 || d < 0 || me < 0) return null;
  const dist = (me - d + n) % n; // 0 = баттон
  if (n === 2) return dist === 0 ? 'BTN' : 'BB';
  if (dist === 0) return 'BTN';
  if (dist === 1) return 'SB';
  if (dist === 2) return 'BB';
  const k = dist - 3; // 0 = первый после BB
  const r = n - 3; // сколько мест между BB и BTN
  const fromEnd = r - 1 - k; // 0 = CO
  if (fromEnd === 0) return 'CO';
  if (k === 0) return 'UTG';
  if (fromEnd === 1) return 'HJ';
  return 'MP';
}

export const isEarly = (pos) => pos === 'UTG' || pos === 'MP';

/* -------------------------------------------------------------- снимок */

function rngFor(key) {
  let h = 2166136261;
  for (const ch of String(key)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Снимок «до хода» — то, что видел этот игрок. null, если решение не пишем:
 * бот, школа, стол с настоящими картами, не его ход. Никогда не бросает.
 */
export function snapshot(room, userId) {
  try {
    const uid = String(userId);
    const h = room?.hand;
    const me = room?.players?.find((p) => p.id === uid);
    if (!h || !me || me.bot || room.learn || room.settings?.cards === 'live') return null;
    const l = legalActions(room, uid);
    const hole = holeOf(room, uid);
    if (!l || !hole || hole.length !== 2) return null;
    const board = [...boardShown(room)];
    const opps = room.players.filter((p) => p.inHand && !p.folded && p.id !== uid).length;
    const handKey = `${room.code}:${h.no}`;
    const eq = opps > 0
      ? monteCarlo(hole, board, opps, SIMS, rngFor(`${handKey}:${uid}:${h.street}:${l.toCall}`))
      : null;
    return {
      handKey, street: h.street, position: positionOf(room, uid), hole: codes(hole), board: codes(board),
      pot: totalPot(room), toCall: l.toCall, stack: l.stack, opps, bb: room.settings.bigBlind,
      strength: Math.floor(strength([...hole, ...board]) / 14 ** 5),
      equity: eq == null ? null : Math.round(eq * 1000) / 1000,
      kind: room.solo ? 'solo' : 'table',
    };
  } catch (e) {
    console.error('[decisions] снимок не снят:', e?.message);
    return null;
  }
}

/** Записать решение. Ошибка журнала глотается: партия идёт дальше. */
export function logDecision(store, snap, action, amount, at) {
  try {
    if (!snap || !store?.addDecision) return false;
    store.addDecision(snap.userId ?? snap.uid, { ...snap, action, amount: amount == null ? null : Math.round(amount), at }, KEEP);
    return true;
  } catch (e) {
    console.error('[decisions] журнал не записан:', e?.message);
    return false;
  }
}

/**
 * Удобный хук для комнаты: снять снимок до хода — и вернуть функцию «записать».
 * Всё внутри try: из хука наружу ничего не вылетает.
 */
export function begin(room, userId, store, now) {
  const snap = snapshot(room, userId);
  if (!snap) return () => {};
  snap.uid = String(userId);
  return (action, amount) => void logDecision(store, snap, action, amount, typeof now === 'function' ? now() : now);
}

/* --------------------------------------------------------------- оценка */

const need = (r) => (r.toCall > 0 ? r.toCall / (r.pot + r.toCall) : 0);
const skillOfStreet = (r) => (r.street === 'preflop' ? 'preflop' : 'postflop');

/**
 * Правила. Каждое получает разобранную строку и возвращает
 * { verdict, skill, topic, code, reason } или null («не моё»).
 * Смотрят ТОЛЬКО на поля снимка — исхода раздачи в строке нет.
 */
export const RULES = {
  /** Сброс, когда можно бесплатно чекнуть. */
  freeFold(r) {
    if (r.action !== 'fold' || r.toCall > 0) return null;
    return { verdict: 'mistake', skill: skillOfStreet(r), topic: 'betting-actions', code: 'free-fold',
      reason: 'Сброс там, где можно бесплатно сказать Check.' };
  },
  /** Сброс при шансах банка, сильно лучших, чем нужно. */
  foldGoodOdds(r) {
    if (r.action !== 'fold' || r.toCall <= 0 || r.equity == null) return null;
    const n = need(r);
    if (n <= 0.25 && r.equity - n >= 0.25) {
      return { verdict: 'mistake', skill: 'math', topic: 'pot-odds', code: 'fold-good-odds',
        reason: `Для колла нужно ${pct(n)}, а шанс выиграть даже против случайной руки ${pct(r.equity)}.` };
    }
    return null;
  },
  /** Колл, когда шанс выиграть заметно ниже нужного. */
  callBadOdds(r) {
    if (r.action !== 'call' || r.toCall <= 0 || r.equity == null) return null;
    const n = need(r);
    if (r.equity < n - 0.12) {
      return { verdict: 'mistake', skill: 'math', topic: 'pot-odds', code: 'call-bad-odds',
        reason: `Для колла нужно ${pct(n)}, а шанс выиграть всего ${pct(r.equity)} даже против случайной руки.` };
    }
    return null;
  },
  /** Олл-ин с мусором против небольшой ставки при глубоком стеке. */
  shoveTrash(r) {
    if (r.action !== 'allin' || r.equity == null || !r.opps || !r.bb) return null;
    if (r.stack < 12 * r.bb || r.toCall > 0.25 * r.stack) return null;
    if (r.equity < 1 / (r.opps + 1) - 0.12) {
      return { verdict: 'mistake', skill: skillOfStreet(r), topic: r.street === 'preflop' ? 'starting-hands' : 'value-bluff',
        code: 'shove-trash', reason: 'Олл-ин слабой рукой при глубоком стеке и небольшой ставке — рискуете всем без причины.' };
    }
    return null;
  },
  /** Сброс сильнейшей стартовой руки. */
  premiumFold(r) {
    if (r.street !== 'preflop' || r.action !== 'fold' || r.toCall <= 0) return null;
    if (!PREMIUM.has(handClass(parseCodes(r.hole)))) return null;
    if (r.toCall >= r.stack) return null; // олл-ин против — спорно
    return { verdict: 'mistake', skill: 'preflop', topic: 'starting-hands', code: 'premium-fold',
      reason: 'Сброс одной из сильнейших стартовых рук (AA, KK, QQ, AK).' };
  },
  /** Сильнейшая рука без повышения из ранней позиции (пассивно). */
  premiumPassive(r) {
    if (r.street !== 'preflop' || r.action !== 'call' || !isEarly(r.position)) return null;
    if (!r.bb || r.toCall > r.bb) return null; // уже был рейз — это не лимп
    if (!PREMIUM.has(handClass(parseCodes(r.hole)))) return null;
    return { verdict: 'mistake', skill: 'preflop', topic: 'open-raise', code: 'premium-limp',
      reason: 'Сильнейшая рука из ранней позиции — повышайте, а не просто входите.' };
  },
  /** Хорошие решения. */
  goodFold(r) {
    if (r.action !== 'fold' || r.toCall <= 0 || r.equity == null) return null;
    if (r.equity < need(r) - 0.05) return { verdict: 'good', skill: 'math', topic: 'pot-odds', code: 'good-fold', reason: 'Сброс там, где шансов банка не хватает.' };
    return null;
  },
  goodCall(r) {
    if (r.action !== 'call' || r.toCall <= 0 || r.equity == null) return null;
    if (r.equity >= need(r) + 0.1) return { verdict: 'good', skill: 'math', topic: 'pot-odds', code: 'good-call', reason: 'Колл, когда шанс выиграть выше нужного.' };
    return null;
  },
  goodPremiumRaise(r) {
    if (r.street !== 'preflop' || (r.action !== 'raise' && r.action !== 'bet' && r.action !== 'allin')) return null;
    if (!PREMIUM.has(handClass(parseCodes(r.hole)))) return null;
    return { verdict: 'good', skill: 'preflop', topic: 'starting-hands', code: 'good-premium-raise', reason: 'Сильная рука — повышение.' };
  },
  goodValueBet(r) {
    if (r.street === 'preflop' || (r.action !== 'bet' && r.action !== 'raise') || r.equity == null) return null;
    if (r.equity >= 0.65) return { verdict: 'good', skill: 'postflop', topic: 'value-bluff', code: 'good-value', reason: 'Ставка с сильной рукой — за вэлью.' };
    return null;
  },
};

const pct = (x) => `${Math.round(x * 100)}%`;
const ORDER = ['freeFold', 'foldGoodOdds', 'callBadOdds', 'shoveTrash', 'premiumFold', 'premiumPassive',
  'goodFold', 'goodCall', 'goodPremiumRaise', 'goodValueBet'];

/**
 * Оценка одного решения. Читает только белый список полей; исход раздачи
 * (`won`, `result`, `chips` и т. п.) игнорируется, даже если его подсунули.
 * Возвращает { verdict: 'good'|'ok'|'mistake'|'unknown', skill, topic, code, reason }.
 */
export function rateDecision(row) {
  const r = {
    street: row?.street, position: row?.position, hole: row?.hole, board: row?.board,
    pot: row?.pot, toCall: row?.toCall, stack: row?.stack, opps: row?.opps, bb: row?.bb,
    action: row?.action, equity: row?.equity,
  };
  const unknown = { verdict: 'unknown', skill: null, topic: null, code: null, reason: 'Слишком спорно, чтобы судить.' };
  if (!r.action || !r.street || typeof r.pot !== 'number' || typeof r.toCall !== 'number') return unknown;
  if (parseCodes(r.hole).length !== 2) return unknown;
  for (const name of ORDER) {
    const v = RULES[name](r);
    if (v) return v;
  }
  // Бесплатный чек — не ошибка и не достижение: обычное решение.
  if (r.action === 'check') return { verdict: 'ok', skill: skillOfStreet(r), topic: 'betting-actions', code: 'check', reason: 'Бесплатный чек.' };
  return unknown;
}

/* --------------------------------------------------------- итог по журналу */

/** Точность → уровень 1…4. Выше 4 эвристика поручиться не может (решение 073). */
export function levelFromAccuracy(acc) {
  if (acc < 0.45) return 1;
  if (acc < 0.65) return 2;
  if (acc < 0.82) return 3;
  return 4;
}

const SKILLS = ['preflop', 'ranges', 'math', 'postflop'];
const CODE_TEXT = {
  'free-fold': 'сброс, когда можно было бесплатно чекнуть',
  'fold-good-odds': 'сброс при выгодных шансах банка',
  'call-bad-odds': 'колл при невыгодных шансах',
  'shove-trash': 'олл-ин слабой рукой без причины',
  'premium-fold': 'сброс сильнейшей стартовой руки',
  'premium-limp': 'сильная рука без повышения из ранней позиции',
};

/**
 * По строкам журнала (новые первыми) → что видно про каждый навык и на чём это
 * основано. Если решений мало — `available:false` и слова, без числа.
 */
export function assessHistory(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const per = Object.fromEntries(SKILLS.map((s) => [s, { good: 0, ok: 0, mistake: 0, graded: 0 }]));
  const mistakes = new Map();
  let doubtful = 0;
  for (const row of list) {
    const v = rateDecision(row);
    if (v.verdict === 'unknown' || !v.skill) { doubtful++; continue; }
    const s = per[v.skill];
    s[v.verdict]++;
    s.graded++;
    if (v.verdict === 'mistake') {
      const m = mistakes.get(v.code) || { code: v.code, topic: v.topic, count: 0, text: CODE_TEXT[v.code] || v.reason };
      m.count++;
      mistakes.set(v.code, m);
    }
  }
  const skills = {};
  for (const id of SKILLS) {
    const s = per[id];
    if (s.graded < MIN_PER_SKILL) {
      skills[id] = { ...s, level: null, enough: false };
    } else {
      const acc = (s.good + 0.7 * s.ok) / s.graded;
      skills[id] = { ...s, accuracy: Math.round(acc * 100) / 100, level: levelFromAccuracy(acc), enough: true };
    }
  }
  const total = list.length;
  const enoughTotal = total >= MIN_TOTAL;
  const anySkill = SKILLS.some((s) => skills[s].enough);
  const available = enoughTotal && anySkill;
  const errs = [...mistakes.values()].sort((a, b) => b.count - a.count);
  const nMist = errs.reduce((a, m) => a + m.count, 0);
  const summary = available
    ? `За последние ${total} решений: ${doubtful} спорных, ${nMist} явных ошибок${errs.length ? ': ' + errs.slice(0, 3).map((m) => `${m.text} — ${m.count}`).join('; ') : ''}.`
    : total < MIN_TOTAL
      ? `Пока мало решений (${total} из ${MIN_TOTAL}): сыграйте ещё ${MIN_TOTAL - total} или пройдите диагностику.`
      : 'Решений хватает, но по навыкам оценить нечего: пройдите диагностику.';
  return { available, total, doubtful, skills, mistakes: errs, summary, need: Math.max(0, MIN_TOTAL - total) };
}
