'use strict';
/**
 * Покерные боты для игры с ботами: 18 характеров × 4 уровня.
 *
 * ЧЕСТНО — НЕ ДЕКЛАРАЦИЯ, А УСТРОЙСТВО. Бот решает по `view` — тому самому
 * виду стола, который сервер построил бы для человека на его месте: свои две
 * карты, открытый борд, стеки и ставки, законные действия. Чужих карт, колоды
 * и будущего борда в этом виде нет физически, поэтому бот не может их знать.
 * Силу руки он оценивает так же, как опытный игрок, только быстрее: тысячами
 * раздач «а что, если» против случайных рук соперников (метод Монте-Карло).
 * Ход идёт через тот же `handle`, что у человека, со всеми проверками.
 *
 * ХАРАКТЕР — как бот играет: что разыгрывает, как часто ставит и блефует,
 * сколько ставит, любит ли олл-ин. УРОВЕНЬ — насколько хорошо он это делает:
 * точность оценки руки, ошибки, умение считать шансы банка.
 */
import { cardCode } from '../../view.js';
import * as R from '../../room.js';

/* ------------------------------------------------------------- характеры */

/**
 * vpip  — с какой относительной силой руки бот вообще входит в раздачу
 *         (1 — «средняя рука при таком числе соперников», меньше — шире);
 * pfr   — с какой силой повышает до флопа;
 * value — какой шанс выиграть после флопа считает «сильной рукой»;
 * aggr  — как часто с сильной рукой ставит/повышает, а не просто уравнивает;
 * bluff — как часто ставит со слабой, если можно;
 * loose — насколько охотно уравнивает (множитель к своим шансам против шансов банка);
 * size  — размер ставки в долях банка;
 * slow  — как часто прячет очень сильную руку (чек, чтобы поймать);
 * shove — как охотно идёт ва-банк с хорошей рукой;
 * scared — насколько пугается крупной ставки (доп. запас к шансам банка).
 *
 * short — имя за столом: короткое, чтобы влезало под аватар (до 9 букв).
 */
export const TYPES = [
  { id: 'rock', name: 'Камень', short: 'Камень', blurb: 'Играет только сильные руки и почти не блефует', p: { vpip: 1.55, pfr: 1.9, value: 0.62, aggr: 0.55, bluff: 0.02, loose: 0.85, size: 0.6, slow: 0.05, shove: 0.05, scared: 0.08 } },
  { id: 'nit', name: 'Осторожный', short: 'Трусишка', blurb: 'Тайтовый и пугливый: от крупной ставки сбрасывает', p: { vpip: 1.35, pfr: 1.75, value: 0.6, aggr: 0.45, bluff: 0.03, loose: 0.8, size: 0.5, slow: 0.05, shove: 0.03, scared: 0.15 } },
  { id: 'tag', name: 'Тайт-агрессор', short: 'Регуляр', blurb: 'Немного рук, но разыгрывает их напористо — крепкий регуляр', p: { vpip: 1.2, pfr: 1.45, value: 0.55, aggr: 0.8, bluff: 0.12, loose: 1.0, size: 0.7, slow: 0.1, shove: 0.12, scared: 0.03 } },
  { id: 'lag', name: 'Лаг', short: 'Лаг', blurb: 'Широко и агрессивно: много рук, много ставок', p: { vpip: 0.85, pfr: 1.15, value: 0.5, aggr: 0.85, bluff: 0.25, loose: 1.1, size: 0.75, slow: 0.08, shove: 0.15, scared: 0.0 } },
  { id: 'maniac', name: 'Маньяк', short: 'Маньяк', blurb: 'Повышает почти всегда — давит, но много отдаёт', p: { vpip: 0.5, pfr: 0.7, value: 0.4, aggr: 0.95, bluff: 0.45, loose: 1.3, size: 1.0, slow: 0.0, shove: 0.3, scared: -0.05 } },
  { id: 'station', name: 'Звонарь', short: 'Звонарь', blurb: 'Уравнивает почти всё и редко повышает', p: { vpip: 0.7, pfr: 2.2, value: 0.7, aggr: 0.2, bluff: 0.02, loose: 1.6, size: 0.5, slow: 0.2, shove: 0.02, scared: -0.08 } },
  { id: 'fish', name: 'Рыба', short: 'Рыба', blurb: 'Играет почти любые карты и редко понимает, что делает', p: { vpip: 0.6, pfr: 1.8, value: 0.45, aggr: 0.35, bluff: 0.12, loose: 1.4, size: 0.55, slow: 0.15, shove: 0.08, scared: -0.03 } },
  { id: 'bluffer', name: 'Блефер', short: 'Блефер', blurb: 'Обожает блеф: ставит, когда все промолчали', p: { vpip: 1.0, pfr: 1.3, value: 0.55, aggr: 0.75, bluff: 0.5, loose: 0.95, size: 0.8, slow: 0.05, shove: 0.12, scared: 0.02 } },
  { id: 'trapper', name: 'Капканщик', short: 'Капканщик', blurb: 'С сильной рукой прикидывается слабым, потом повышает', p: { vpip: 1.1, pfr: 1.6, value: 0.55, aggr: 0.6, bluff: 0.08, loose: 1.0, size: 0.65, slow: 0.65, shove: 0.08, scared: 0.03 } },
  { id: 'math', name: 'Математик', short: 'Математик', blurb: 'Считает шансы банка и почти не ошибается в счёте', p: { vpip: 1.15, pfr: 1.45, value: 0.56, aggr: 0.7, bluff: 0.1, loose: 1.0, size: 0.66, slow: 0.08, shove: 0.1, scared: 0.0 } },
  { id: 'shark', name: 'Акула', short: 'Акула', blurb: 'Сильный и гибкий: учитывает позицию, блефует к месту', p: { vpip: 1.05, pfr: 1.3, value: 0.52, aggr: 0.82, bluff: 0.2, loose: 1.02, size: 0.7, slow: 0.15, shove: 0.12, scared: 0.0, position: 0.15 } },
  { id: 'shover', name: 'Олл-инщик', short: 'Олл-инщик', blurb: 'С любой приличной рукой — ва-банк', p: { vpip: 1.1, pfr: 1.3, value: 0.52, aggr: 0.7, bluff: 0.15, loose: 1.0, size: 0.8, slow: 0.0, shove: 0.75, scared: 0.0 } },
  { id: 'limper', name: 'Лимпер', short: 'Лимпер', blurb: 'До флопа только уравнивает, после — сбрасывает без попадания', p: { vpip: 0.75, pfr: 2.3, value: 0.6, aggr: 0.4, bluff: 0.04, loose: 0.85, size: 0.5, slow: 0.1, shove: 0.02, scared: 0.1 } },
  { id: 'bully', name: 'Задира', short: 'Задира', blurb: 'Ставит крупно, когда соперники молчат', p: { vpip: 0.95, pfr: 1.25, value: 0.5, aggr: 0.85, bluff: 0.35, loose: 0.95, size: 1.2, slow: 0.02, shove: 0.2, scared: 0.0 } },
  { id: 'gambler', name: 'Азартный', short: 'Азартный', blurb: 'Гонится за дро: уравнивает в надежде доехать', p: { vpip: 0.75, pfr: 1.5, value: 0.5, aggr: 0.55, bluff: 0.15, loose: 1.5, size: 0.6, slow: 0.05, shove: 0.2, scared: -0.05 } },
  { id: 'tilter', name: 'Тильтер', short: 'Тильтер', blurb: 'Играет ровно, пока не проиграет крупно — потом срывается', p: { vpip: 1.15, pfr: 1.45, value: 0.55, aggr: 0.7, bluff: 0.1, loose: 1.0, size: 0.66, slow: 0.08, shove: 0.1, scared: 0.0, tilt: true } },
  { id: 'sly', name: 'Хитрец', short: 'Хитрец', blurb: 'Ставки то маленькие, то огромные — не прочитать', p: { vpip: 1.0, pfr: 1.35, value: 0.53, aggr: 0.75, bluff: 0.22, loose: 1.0, size: 0.66, slow: 0.25, shove: 0.12, scared: 0.0, polar: true } },
  { id: 'quiet', name: 'Тихоня', short: 'Тихоня', blurb: 'Редко ставит сам, но уж если ставит — у него есть', p: { vpip: 1.1, pfr: 1.9, value: 0.62, aggr: 0.5, bluff: 0.0, loose: 1.0, size: 0.6, slow: 0.3, shove: 0.05, scared: 0.05 } },
];
const BY_ID = new Map(TYPES.map((t) => [t.id, t]));

/** Уровни: точность, ошибки, глубина оценки. */
export const LEVELS = [
  { name: 'Новичок', sims: 90, noise: 0.15, mistake: 0.12, odds: 0.3 },
  { name: 'Любитель', sims: 220, noise: 0.08, mistake: 0.05, odds: 0.65 },
  { name: 'Опытный', sims: 420, noise: 0.04, mistake: 0.02, odds: 0.9 },
  { name: 'Профи', sims: 750, noise: 0.0, mistake: 0.0, odds: 1.0 },
];

/* ---------------------------------------------------------------- карты */

const CODE = new Map(Array.from({ length: 52 }, (_, c) => [cardCode(c), c]));
const parse = (codes) => (codes || []).map((x) => CODE.get(x)).filter((c) => c != null);

/**
 * Сила руки из 5–7 карт одним числом: больше — сильнее. Тот же порядок, что
 * у `best5` из eval.js (это проверяет тест на десятках тысяч раздач), только
 * без перебора 21 пятёрки: счёт по достоинствам и мастям сразу. Нужна для
 * шансов — там рук оцениваются тысячи за ход.
 */
export function strength(cards) {
  const cnt = new Array(13).fill(0);
  const suitCnt = [0, 0, 0, 0];
  const suitMask = [0, 0, 0, 0];
  let mask = 0;
  for (const c of cards) {
    const r = c >> 2;
    const st = c & 3;
    cnt[r] += 1;
    suitCnt[st] += 1;
    suitMask[st] |= 1 << r;
    mask |= 1 << r;
  }
  const enc = (cat, ks) => {
    let v = cat;
    for (let i = 0; i < 5; i++) v = v * 14 + ((ks[i] ?? -1) + 1);
    return v;
  };
  const top = (except, n) => {
    const out = [];
    for (let r = 12; r >= 0 && out.length < n; r--) if (cnt[r] && !except.includes(r)) out.push(r);
    return out;
  };
  let fs = -1;
  for (let st = 0; st < 4; st++) if (suitCnt[st] >= 5) fs = st;
  if (fs >= 0) {
    const sf = straightTop(suitMask[fs]);
    if (sf >= 0) return enc(8, [sf]);
  }
  const quads = [];
  const trips = [];
  const pairs = [];
  for (let r = 12; r >= 0; r--) {
    if (cnt[r] === 4) quads.push(r);
    else if (cnt[r] === 3) trips.push(r);
    else if (cnt[r] === 2) pairs.push(r);
  }
  if (quads.length) return enc(7, [quads[0], ...top([quads[0]], 1)]);
  if (trips.length && (trips.length > 1 || pairs.length)) return enc(6, [trips[0], Math.max(trips[1] ?? -1, pairs[0] ?? -1)]);
  if (fs >= 0) {
    const ks = [];
    for (let r = 12; r >= 0 && ks.length < 5; r--) if ((suitMask[fs] >> r) & 1) ks.push(r);
    return enc(5, ks);
  }
  const st = straightTop(mask);
  if (st >= 0) return enc(4, [st]);
  if (trips.length) return enc(3, [trips[0], ...top([trips[0]], 2)]);
  if (pairs.length >= 2) return enc(2, [pairs[0], pairs[1], ...top([pairs[0], pairs[1]], 1)]);
  if (pairs.length) return enc(1, [pairs[0], ...top([pairs[0]], 3)]);
  return enc(0, top([], 5));
}

/** Старшая карта стрита в наборе достоинств (битовая маска), или -1. Колесо A-2-3-4-5 — до пятёрки. */
function straightTop(m) {
  for (let t = 12; t >= 4; t--) {
    const need = 0x1f << (t - 4);
    if ((m & need) === need) return t;
  }
  return (m & 0x100f) === 0x100f ? 3 : -1;
}

/**
 * Шанс выиграть (ничья — пополам) против `opponents` случайных рук. Колода —
 * все карты, кроме тех, что бот видит: своих и открытых. Ничьих чужих карт.
 */
export function equity(hole, board, opponents, sims, rng) {
  const known = new Set([...hole, ...board]);
  const deck = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);
  const need = opponents * 2 + (5 - board.length);
  let score = 0;
  for (let s = 0; s < sims; s++) {
    // Частичная перетасовка: нужны только первые `need` карт.
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(rng() * (deck.length - i));
      const t = deck[i];
      deck[i] = deck[j];
      deck[j] = t;
    }
    const full = board.concat(deck.slice(opponents * 2, need));
    const mine = strength([...hole, ...full]);
    let beaten = false;
    let ties = 0;
    for (let o = 0; o < opponents; o++) {
      const theirs = strength([deck[2 * o], deck[2 * o + 1], ...full]);
      if (theirs > mine) { beaten = true; break; }
      if (theirs === mine) ties++;
    }
    if (!beaten) score += 1 / (ties + 1);
  }
  return score / sims;
}

/* --------------------------------------------------------------- решение */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Размер ставки «как у людей»: в долях банка, округлённый до малого блайнда. */
function sizeTo(legal, fraction, view) {
  const unit = Math.max(1, view.room.settings.smallBlind || 1);
  const want = legal.currentBet + Math.max(legal.minTotal - legal.currentBet, Math.round(fraction * (legal.potTotal + legal.toCall)));
  const rounded = Math.round(want / unit) * unit;
  return clamp(rounded, legal.minTotal, legal.maxTotal);
}

/**
 * Что сделает бот. Только по `view` — тому, что видел бы человек на его месте.
 *
 * @returns сообщение `{ t: 'act', action, amount, seq }` — как от страницы
 */
export function decidePoker(view, spec, rng) {
  const legal = view.legal;
  if (!legal) return null;
  const type = BY_ID.get(spec.type) || BY_ID.get('tag');
  const L = LEVELS[clamp(spec.level ?? 1, 0, LEVELS.length - 1)];
  const p = { ...type.p };
  const seq = view.seq;
  const act = (action, amount) => ({ t: 'act', action, ...(amount != null ? { amount } : {}), seq });

  // Тильт: проиграл больше трети стартового стека — играет как маньяк.
  if (p.tilt && legal.stack + legal.myBet < view.room.settings.startingStack * 0.66) Object.assign(p, BY_ID.get('maniac').p);

  // Иногда — просто ошибка, как у живого новичка. Но не сброс, когда можно бесплатно чекнуть.
  if (rng() < L.mistake) {
    const options = [];
    if (legal.canCheck) options.push(act('check'));
    if (legal.canCall) options.push(act('call'));
    if (legal.canBet) options.push(act('bet', sizeTo(legal, 0.5, view)));
    if (legal.canRaise) options.push(act('raise', sizeTo(legal, 0.6, view)));
    if (!legal.canCheck) options.push(act('fold'));
    if (options.length) return options[Math.floor(rng() * options.length)];
  }

  const hole = parse(view.me.cards);
  const board = parse(view.hand?.board);
  const opponents = Math.max(1, view.players.filter((x) => !x.isMe && x.inHand && !x.folded).length);
  let eq = equity(hole, board, opponents, L.sims, rng);
  if (L.noise) eq = clamp(eq + (rng() * 2 - 1) * L.noise, 0, 1);
  const rel = eq * (opponents + 1); // 1 — «как у среднего соперника»

  const preflop = board.length === 0;
  const pot = legal.potTotal;
  const odds = legal.toCall > 0 ? legal.toCall / (pot + legal.toCall) : 0;
  // Слабые уровни считают шансы банка грубо: «дорого / дёшево».
  const needed = L.odds * odds + (1 - L.odds) * (legal.toCall > pot * 0.5 ? 0.45 : 0.25) + (p.scared || 0) * (legal.toCall > pot * 0.6 ? 1 : 0);
  const bb = view.room.settings.bigBlind || 1;
  const shortStack = legal.stack <= 12 * bb;
  // Поздняя позиция (кнопка) — играть чуть шире умеют только сильные характеры.
  const me = view.players.find((x) => x.isMe);
  const pos = me?.isButton ? (p.position || 0) : 0;

  const strong = preflop ? rel >= p.pfr - pos : eq >= p.value - pos;
  const playable = preflop ? rel >= p.vpip - pos : eq * p.loose >= needed;

  // Ва-банк: короткий стек с хорошей рукой или любитель олл-инов.
  if ((legal.canBet || legal.canRaise || legal.canCall) && strong && (shortStack || rng() < p.shove)) {
    return act('allin');
  }

  if (strong) {
    // Капкан: с очень сильной рукой иногда молчит, чтобы соперник поставил сам.
    if (legal.canCheck && rng() < p.slow) return act('check');
    if ((legal.canBet || legal.canRaise) && rng() < p.aggr) {
      const fraction = p.polar ? (rng() < 0.5 ? 0.35 : 1.4) : p.size;
      return act(legal.canBet ? 'bet' : 'raise', sizeTo(legal, fraction, view));
    }
    if (legal.canCall) return act('call');
    return act('check');
  }

  if (playable) {
    if (legal.canCheck) {
      if (legal.canBet && rng() < p.bluff * 0.6) return act('bet', sizeTo(legal, p.size * 0.8, view));
      return act('check');
    }
    // Полублеф: иногда повышает вместо колла.
    if (legal.canRaise && rng() < p.bluff * 0.25) return act('raise', sizeTo(legal, p.size, view));
    return act('call');
  }

  // Слабая рука.
  if (legal.canCheck) {
    if (legal.canBet && rng() < p.bluff) return act('bet', sizeTo(legal, p.size, view));
    return act('check');
  }
  if (legal.canRaise && rng() < p.bluff * 0.3 && !preflop) return act('raise', sizeTo(legal, p.size * 1.2, view));
  // Дёшево посмотреть флоп — широкие характеры не сбрасывают.
  if (preflop && legal.toCall <= bb && rel >= p.vpip * 0.75) return act('call');
  return act('fold');
}

/* ------------------------------------------------------------ для ядра */

const clampN = (v, a, b, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : d;
};

export default {
  catalog: () => ({
    levels: LEVELS.map((l) => l.name),
    defaultLevel: 1,
    levelHints: [
      'Ошибается, плохо считает шансы — для первых раздач.',
      'Понимает силу руки, но шансы банка считает на глаз.',
      'Считает почти точно и редко ошибается.',
      'Без ошибок: точная оценка руки и шансов банка.',
    ],
    types: TYPES.map((t) => ({ id: t.id, name: t.name, blurb: t.blurb })),
  }),

  /** Стол для игры с ботами: обычные фишки и блайнды, без таймера хода — человек играет в своём темпе. */
  settings: () => ({ startingStack: 10000, smallBlind: 50, bigBlind: 100, turnSeconds: 0 }),

  /**
   * Состав: сколько соперников, какой уровень и какие характеры. Невыбранные
   * характеры — случайные, по возможности разные: за столом из пяти ботов не
   * должно сидеть пять одинаковых «камней».
   */
  lineup(raw = {}, rng = Math.random) {
    const n = clampN(raw.opponents, 1, 7, 3);
    const level = clampN(raw.level, 0, LEVELS.length - 1, 1);
    const chosen = Array.isArray(raw.types) ? raw.types : [];
    const pool = TYPES.map((t) => t.id).filter((id) => !chosen.includes(id));
    const out = [];
    for (let i = 0; i < n; i++) {
      let type = BY_ID.has(chosen[i]) ? chosen[i] : null;
      if (!type) {
        const k = Math.floor(rng() * pool.length);
        type = pool.splice(k, 1)[0] || TYPES[Math.floor(rng() * TYPES.length)].id;
      }
      out.push({ type, level });
    }
    return out;
  },

  /**
   * Бот садится за стол под именем характера — его человек и выбирал. Два
   * одинаковых характера различаются номером: «Акула», «Акула 2».
   */
  seat(room, spec, i) {
    const t = BY_ID.get(spec.type);
    const same = room.players.filter((p) => p.bot?.type === spec.type).length;
    const name = same ? `${t.short} ${same + 1}` : t.short;
    const p = R.addPlayer(room, { id: `bot${i + 1}`, tgId: 0, name, dm: null });
    if (!p.error) p.bot = { ...spec };
    return p;
  },

  /** Пауза перед ходом: «думает» по-разному, чтобы стол жил, а не щёлкал. */
  delay: (room, p, w, rng) => 700 + Math.floor(rng() * 1300),

  decide: ({ view, me, rng }) => decidePoker(view, me.bot, rng),

  /** Запасное действие: бесплатно — чек, иначе сброс. Стол не встанет. */
  fallback(view) {
    const legal = view.legal;
    if (!legal) return null;
    return { t: 'act', action: legal.canCheck ? 'check' : 'fold', seq: view.seq };
  },
};
