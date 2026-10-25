/**
 * Покерная математика для «Обучения» и «Тренировки» (агент X, волна 3).
 *
 * Чистый модуль: без DOM, без импортов, на клиенте и в тестах один и тот же.
 * Оценщик здесь написан НЕЗАВИСИМО от `bot/eval.js` (другой способ: счётчики
 * рангов и битовые маски вместо перебора 21 пятёрки); `bot/train.math.test.js`
 * сверяет их на десятках тысяч случайных рук.
 *
 * Карта — целое 0…51, как в `bot/deck.js`: `ранг * 4 + масть`,
 * ранг 0…12 = 2…A, масть 0…3 = ♠ ♥ ♦ ♣. Имя файла картинки — `cardCode`
 * («AS», «10H»), как у `miniapp/cards/*.svg`.
 *
 * ЧЕСТНОСТЬ (контракт 9): всё, что здесь, считается точно (перебором или
 * формулой). Единственное приближение — префлоп-эквити и очень большие
 * диапазоны: там Монте-Карло с фиксированным seed (воспроизводимо), метод
 * возвращается в поле `exact: false`. Правило 2 и 4 — именно «правило порядка»,
 * его ошибка считается против точного значения.
 */

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SUITS = ['♠', '♥', '♦', '♣'];
const SUIT_LETTER = ['S', 'H', 'D', 'C'];
export const RED_SUITS = [1, 2];

export const rankOf = (c) => c >> 2;
export const suitOf = (c) => c & 3;
export const mk = (rank, suit) => rank * 4 + suit;
export const cardName = (c) => RANKS[rankOf(c)] + SUITS[suitOf(c)];
/** Код картинки `/cards/<код>.svg`: «AS», «10H». */
export const cardCode = (c) => RANKS[rankOf(c)] + SUIT_LETTER[suitOf(c)];

/** «As» / «10h» / «A♠» → карта. Возвращает -1, если не разобрали. */
export function parseCard(str) {
  const s = String(str).trim();
  const m = /^(10|[2-9JQKA])([shdc♠♥♦♣])$/i.exec(s);
  if (!m) return -1;
  const r = RANKS.indexOf(m[1].toUpperCase());
  const suit = 'shdc'.indexOf(m[2].toLowerCase());
  const s2 = suit >= 0 ? suit : SUITS.indexOf(m[2]);
  return r < 0 || s2 < 0 ? -1 : mk(r, s2);
}
/** «As Kd» → [карты]. */
export const parseCards = (str) => String(str).trim().split(/[\s,]+/).filter(Boolean).map(parseCard);

export const DECK = Array.from({ length: 52 }, (_, i) => i);

/** Колода без заданных (мёртвых) карт. */
export function remaining(...groups) {
  const dead = new Set(groups.flat());
  return DECK.filter((c) => !dead.has(c));
}

// ───────────────────────── оценщик рук ─────────────────────────

export const CAT = { HIGH: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4, FLUSH: 5, FULL_HOUSE: 6, QUADS: 7, STRAIGHT_FLUSH: 8 };
export const CAT_NAMES = ['Старшая карта', 'Пара', 'Две пары', 'Тройка', 'Стрит', 'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш'];

/** Старший ранг стрита в маске рангов (13 бит) или -1; туз считается и младшим (колесо). */
function straightTop(mask) {
  const m = (mask << 1) | ((mask >> 12) & 1); // бит 0 = «туз снизу», бит i = ранг i-1
  for (let t = 13; t >= 4; t--) {
    if (((m >> (t - 4)) & 31) === 31) return t - 1;
  }
  return -1;
}

/**
 * Сила лучшей пятёрки из 5…7 карт: массив `[категория, тайбрейки…]`,
 * сравнивается лексикографически (`compareHands`).
 */
export function evaluate(cards) {
  if (cards.length < 5 || cards.length > 7) throw new Error('evaluate: нужно 5–7 карт');
  const rc = new Array(13).fill(0);
  const sc = [0, 0, 0, 0];
  const sm = [0, 0, 0, 0];
  let rmask = 0;
  for (const c of cards) {
    const r = c >> 2, s = c & 3;
    rc[r]++; sc[s]++; sm[s] |= 1 << r; rmask |= 1 << r;
  }
  let fs = -1;
  for (let s = 0; s < 4; s++) if (sc[s] >= 5) fs = s;

  if (fs >= 0) {
    const t = straightTop(sm[fs]);
    if (t >= 0) return [CAT.STRAIGHT_FLUSH, t];
  }
  const quads = [], trips = [], pairs = [];
  for (let r = 12; r >= 0; r--) {
    if (rc[r] === 4) quads.push(r);
    else if (rc[r] === 3) trips.push(r);
    else if (rc[r] === 2) pairs.push(r);
  }
  const top = (skip, n) => {
    const out = [];
    for (let r = 12; r >= 0 && out.length < n; r--) if (rc[r] > 0 && !skip.includes(r)) out.push(r);
    return out;
  };
  if (quads.length) return [CAT.QUADS, quads[0], top([quads[0]], 1)[0]];
  if (trips.length && (trips.length > 1 || pairs.length)) {
    const second = trips.length > 1 ? Math.max(trips[1], pairs[0] ?? -1) : pairs[0];
    return [CAT.FULL_HOUSE, trips[0], second];
  }
  if (fs >= 0) {
    const rs = [];
    for (let r = 12; r >= 0 && rs.length < 5; r--) if (sm[fs] & (1 << r)) rs.push(r);
    return [CAT.FLUSH, ...rs];
  }
  const st = straightTop(rmask);
  if (st >= 0) return [CAT.STRAIGHT, st];
  if (trips.length) return [CAT.TRIPS, trips[0], ...top([trips[0]], 2)];
  if (pairs.length >= 2) return [CAT.TWO_PAIR, pairs[0], pairs[1], top([pairs[0], pairs[1]], 1)[0]];
  if (pairs.length === 1) return [CAT.PAIR, pairs[0], ...top([pairs[0]], 3)];
  return [CAT.HIGH, ...top([], 5)];
}

/** >0 — первая рука сильнее, <0 — слабее, 0 — ровно. */
export function compareHands(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Название руки по-русски: «Флеш до K», «Пара тузов» не склоняем: «Пара A». */
export function describeHand(score) {
  const [cat, a, b] = score;
  const R = (i) => RANKS[i];
  switch (cat) {
    case CAT.STRAIGHT_FLUSH: return a === 12 ? 'Флеш-рояль' : `Стрит-флеш до ${R(a)}`;
    case CAT.QUADS: return `Каре ${R(a)}`;
    case CAT.FULL_HOUSE: return `Фулл-хаус ${R(a)}/${R(b)}`;
    case CAT.FLUSH: return `Флеш до ${R(a)}`;
    case CAT.STRAIGHT: return `Стрит до ${R(a)}`;
    case CAT.TRIPS: return `Тройка ${R(a)}`;
    case CAT.TWO_PAIR: return `Две пары ${R(a)}/${R(b)}`;
    case CAT.PAIR: return `Пара ${R(a)}`;
    default: return `Старшая ${R(a)}`;
  }
}

// ───────────────────────── счёт, форматы ─────────────────────────

export function binom(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** Число с точками: 1234567 → «1.234.567». */
export function fmtNum(n) {
  const neg = n < 0;
  const s = String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '−' : '') + s;
}
/** Доля 0…1 → «35,0 %» (запятая — десятичный знак по-русски). */
export function fmtPct(x, digits = 1) {
  return (x * 100).toFixed(digits).replace('.', ',') + ' %';
}
/** Число фишек/BB с запятой и нужным числом знаков: «12,5». */
export function fmtDec(x, digits = 1) {
  const neg = x < 0 && Number(Math.abs(x).toFixed(digits)) !== 0;
  const [i, f] = Math.abs(x).toFixed(digits).split('.');
  return (neg ? '−' : '') + fmtNum(Number(i)) + (f ? ',' + f : '');
}

// ───────────────────────── seed-ГСЧ ─────────────────────────

/** mulberry32: `rng()` → [0,1). Один seed — одна и та же последовательность. */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Целое из [0, n). */
export const rngInt = (rng, n) => Math.floor(rng() * n);
/** Перемешать копию массива (Фишер–Йетс) по seed-ГСЧ. */
export function shuffleWith(rng, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rngInt(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ───────────────────────── стартовые руки и диапазоны ─────────────────────────

/** Метка руки: «AA», «AKs», «AKo» → список пар карт (все масти, без мёртвых). */
export function expandLabel(label, dead = []) {
  const m = /^(10|[2-9JQKA])(10|[2-9JQKA])([so]?)$/.exec(label);
  if (!m) throw new Error(`expandLabel: странная метка «${label}»`);
  const r1 = RANKS.indexOf(m[1]), r2 = RANKS.indexOf(m[2]);
  const gone = new Set(dead);
  const out = [];
  if (r1 === r2) {
    for (let s1 = 0; s1 < 4; s1++) for (let s2 = s1 + 1; s2 < 4; s2++) {
      const a = mk(r1, s1), b = mk(r1, s2);
      if (!gone.has(a) && !gone.has(b)) out.push([a, b]);
    }
    return out;
  }
  for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) {
    const suited = s1 === s2;
    if (m[3] === 's' && !suited) continue;
    if (m[3] === 'o' && suited) continue;
    const a = mk(r1, s1), b = mk(r2, s2);
    if (!gone.has(a) && !gone.has(b)) out.push([a, b]);
  }
  return out;
}

/** Метка руки по двум картам: «AKs», «77», «T9o» → пишем 10 как «10». */
export function labelOf(a, b) {
  let r1 = rankOf(a), r2 = rankOf(b);
  if (r1 < r2) [r1, r2] = [r2, r1];
  if (r1 === r2) return RANKS[r1] + RANKS[r2];
  return RANKS[r1] + RANKS[r2] + (suitOf(a) === suitOf(b) ? 's' : 'o');
}

/** Сколько комбинаций у метки с учётом мёртвых карт (блокеры). */
export const combosOf = (label, dead = []) => expandLabel(label, dead).length;
/** Все пары карт диапазона (`Set`/массив меток) без мёртвых карт. */
export function rangeHands(range, dead = []) {
  const out = [];
  for (const l of range) out.push(...expandLabel(l, dead));
  return out;
}
export const rangeCombos = (range, dead = []) => rangeHands(range, dead).length;

// ───────────────────────── эквити ─────────────────────────

/** Исходы руки героя против одной руки на полном борде. */
function showdown(hero, vil, board) {
  const c = compareHands(evaluate([...hero, ...board]), evaluate([...vil, ...board]));
  return c > 0 ? 1 : c < 0 ? 0 : 0.5;
}

/** Все сочетания по k из массива (по одному вызову fn). */
function eachCombo(arr, k, fn) {
  const pick = [];
  const rec = (start) => {
    if (pick.length === k) return fn(pick);
    for (let i = start; i < arr.length; i++) {
      pick.push(arr[i]);
      rec(i + 1);
      pick.pop();
    }
  };
  rec(0);
}

const EXACT_LIMIT = 400000; // не больше стольких «борд × рука соперника» перебираем точно

/**
 * Эквити героя (доля банка в среднем: победа = 1, ничья = ½).
 *
 * @param hero     две карты героя
 * @param board    0…5 карт борда
 * @param villain  две карты соперника ИЛИ диапазон (массив/Set меток «AKs»)
 * @param opts     { samples = 20000, seed = 1, exact = 'auto' }
 * @returns { equity, win, tie, lose, exact, n }
 *   exact === true — полный перебор (всех досдач и всех рук диапазона);
 *   false — Монте-Карло с seed (воспроизводимо).
 */
export function equity(hero, board, villain, opts = {}) {
  const { samples = 20000, seed = 1, exact: want = 'auto' } = opts;
  const need = 5 - board.length;
  const isHand = Array.isArray(villain) && typeof villain[0] === 'number';
  const dead = [...hero, ...board];
  const vHands = isHand ? [villain] : rangeHands(villain, dead);
  if (!vHands.length) throw new Error('equity: у соперника нет ни одной возможной руки');
  const tally = { w: 0, t: 0, l: 0, n: 0 };
  const add = (r, weight = 1) => {
    if (r === 1) tally.w += weight; else if (r === 0) tally.l += weight; else tally.t += weight;
    tally.n += weight;
  };

  // размер полного перебора: руки соперника × сочетания досдачи
  const perHand = (v) => binom(52 - dead.length - 2, need);
  const total = vHands.length * perHand();
  const doExact = want === true || (want === 'auto' && total <= EXACT_LIMIT);

  if (doExact) {
    for (const v of vHands) {
      const rest = remaining(dead, v);
      if (need === 0) add(showdown(hero, v, board));
      else eachCombo(rest, need, (extra) => add(showdown(hero, v, [...board, ...extra])));
    }
    return finish(tally, true);
  }
  const rng = makeRng(seed);
  for (let i = 0; i < samples; i++) {
    const v = vHands[rngInt(rng, vHands.length)];
    const rest = remaining(dead, v);
    // частичная тасовка: нужно только `need` карт
    for (let k = 0; k < need; k++) {
      const j = k + rngInt(rng, rest.length - k);
      [rest[k], rest[j]] = [rest[j], rest[k]];
    }
    add(showdown(hero, v, [...board, ...rest.slice(0, need)]));
  }
  return finish(tally, false);
}
function finish(t, exact) {
  return { equity: (t.w + t.t / 2) / t.n, win: t.w / t.n, tie: t.t / t.n, lose: t.l / t.n, exact, n: t.n };
}

// ───────────────────────── ауты ─────────────────────────

const windows = (() => {
  const w = [];
  for (let low = -1; low <= 8; low++) { // -1 = колесо A-2-3-4-5
    w.push([0, 1, 2, 3, 4].map((i) => (low + i + 13) % 13));
  }
  return w;
})();

/**
 * Какие дро есть у героя на борде (флоп или тёрн) и какие карты их закрывают.
 * Возвращает список `{ type, outs:[карты] }`, типы: 'flush', 'oesd', 'gutshot',
 * 'overcards'. Ауты каждого дро считаются независимо; общие — `drawOuts`.
 */
export function drawsOf(hero, board) {
  const all = [...hero, ...board];
  const unseen = remaining(all);
  const res = [];
  // флеш-дро: ровно 4 карты масти, из них хотя бы одна у героя
  for (let s = 0; s < 4; s++) {
    const have = all.filter((c) => suitOf(c) === s);
    if (have.length === 4 && hero.some((c) => suitOf(c) === s)) {
      res.push({ type: 'flush', outs: unseen.filter((c) => suitOf(c) === s) });
    }
  }
  // стрит-дро: карты-ранги, достраивающие окно из пяти рангов с участием карты героя
  const have = new Set(all.map(rankOf));
  const heroRanks = new Set(hero.map(rankOf));
  const complete = new Set();
  let madeAlready = false;
  for (const w of windows) {
    const miss = w.filter((r) => !have.has(r));
    if (miss.length === 0 && w.some((r) => heroRanks.has(r))) madeAlready = true;
    if (miss.length === 1 && w.some((r) => heroRanks.has(r))) complete.add(miss[0]);
  }
  if (!madeAlready && complete.size) {
    const outs = unseen.filter((c) => complete.has(rankOf(c)));
    res.push({ type: complete.size >= 2 ? 'oesd' : 'gutshot', outs });
  }
  // оверкарты: обе карты героя старше борда, пары нет
  if (board.length && all.length >= 5 && evaluate(all)[0] === CAT.HIGH && !hero.some((c) => board.some((b) => rankOf(b) === rankOf(c))) && rankOf(hero[0]) !== rankOf(hero[1])) {
    const bmax = Math.max(...board.map(rankOf));
    if (hero.every((c) => rankOf(c) > bmax)) {
      res.push({ type: 'overcards', outs: unseen.filter((c) => heroRanks.has(rankOf(c))) });
    }
  }
  return res;
}

/** Все различные карты-ауты (объединение, без повторов), ответ — отсортированный массив. */
export function drawOuts(hero, board, types = null) {
  const set = new Set();
  for (const d of drawsOf(hero, board)) if (!types || types.includes(d.type)) d.outs.forEach((c) => set.add(c));
  return [...set].sort((a, b) => a - b);
}

/**
 * «Честные» ауты против известной руки соперника: карта-аут, после которой
 * герой выигрывает у соперника на текущей улице (доходя борд до конца не
 * требуется). Для каждой карты из `candidates` (по умолчанию вся оставшаяся
 * колода) определяет: помогает ли она герою обойти соперника сейчас.
 * Возвращает `{ clean:[...], dirty:[...] }`:
 *   clean — карта делает героя лидером;
 *   dirty — карта «похожа на аут» (замыкает дро), но герой всё равно не лидирует
 *           (соперник тоже усилился: фулл-хаус на спаренном борде, старший флеш…).
 * Работает на флопе/тёрне (после карты оценивает героя и соперника на 4/5 картах борда,
 * для флопа добирая оба до пяти карт только из имеющихся — используем 6-картное сравнение).
 */
export function cleanOuts(hero, board, villain, candidates = null) {
  const cand = (candidates ?? drawOuts(hero, board)).filter((c) => !villain.includes(c));
  const clean = [], dirty = [];
  for (const c of cand) {
    const b2 = [...board, c];
    const h = evaluate([...hero, ...b2]);
    const v = evaluate([...villain, ...b2]);
    if (compareHands(h, v) > 0) clean.push(c); else dirty.push(c);
  }
  return { clean, dirty };
}

/**
 * Вероятность поймать хотя бы один аут при `toCome` картах до конца (точно, гипергеометрия).
 * `unseen` — число неизвестных карт (по умолчанию 52 − карты героя − борд).
 */
export function hitProbability(outs, unseen, toCome) {
  if (outs <= 0) return 0;
  return 1 - binom(unseen - outs, toCome) / binom(unseen, toCome);
}

/** Точные шансы по улицам для героя с `outs` аутами. */
export function hitByStreet(outs, boardLen) {
  const unseen = 52 - 2 - boardLen;
  const next = boardLen < 5 ? outs / unseen : 0;
  const toRiver = boardLen === 3 ? hitProbability(outs, unseen, 2) : boardLen === 4 ? next : 0;
  return { next, toRiver };
}

/**
 * Правило 2 и 4: на флопе (две карты впереди) ауты × 4, на тёрне (одна) ауты × 2.
 * Возвращает приближение и ошибку против точного (в процентных пунктах).
 */
export function rule24(outs, boardLen) {
  const mult = boardLen === 3 ? 4 : 2;
  const approx = (outs * mult) / 100;
  const exact = boardLen === 3 ? hitProbability(outs, 47, 2) : hitProbability(outs, 46, 1);
  return { approx, exact, errorPp: (approx - exact) * 100, mult };
}

// ───────────────────────── банк, шансы, EV ─────────────────────────
// Соглашение: pot — банк ДО ставки соперника, bet — ставка, которую вам надо уравнять.
// Все суммы — в фишках (или BB), числа — не округляем: округляет тот, кто показывает.

/** Нужное эквити для колла: bet / (pot + 2·bet). */
export const requiredEquity = (pot, bet) => bet / (pot + 2 * bet);
/** Pot odds как отношение «в банке : вам платить»: (pot + bet) / bet. */
export const potOddsRatio = (pot, bet) => (pot + bet) / bet;
/** Шанс банка в долях: bet / (pot + bet + bet) = то же, что `requiredEquity`. */
export const potOdds = requiredEquity;

/** EV колла при эквити `eq`: выигрыш (pot + bet) с вероятностью eq, потеря bet иначе. */
export const evCall = (eq, pot, bet) => eq * (pot + bet) - (1 - eq) * bet;
/** EV фолда по соглашению «уже вложенное не считаем» — ноль. */
export const evFold = () => 0;
/**
 * EV ставки `bet` в банк `pot`: соперник сбрасывает с частотой `fold` (вы берёте pot),
 * иначе колл, и вы выигрываете банк в среднем с эквити `eq`.
 */
export const evBet = (pot, bet, fold, eq) =>
  fold * pot + (1 - fold) * (eq * (pot + bet) - (1 - eq) * bet);
/** Безубыточная частота сброса для чистого блефа: bet / (pot + bet). */
export const breakEvenFold = (pot, bet) => bet / (pot + bet);
/** MDF — сколько диапазона надо защищать, чтобы блеф не был прибыльным: pot / (pot + bet). */
export const mdf = (pot, bet) => pot / (pot + bet);
/** SPR: эффективный стек / банк. */
export const spr = (stack, pot) => stack / pot;
/**
 * Нужное эквити с учётом скрытых шансов: вы надеетесь выиграть ещё `implied`
 * на следующих улицах при попадании. Формула: bet / (pot + 2·bet + implied).
 */
export const requiredEquityImplied = (pot, bet, implied) => bet / (pot + 2 * bet + implied);
/**
 * Сколько доплаты на попадании нужно, чтобы колл с эквити `eq` стал безубыточным.
 * Условие: eq·(pot + bet + X) − (1 − eq)·bet ≥ 0 → X = bet·(1 − eq)/eq − pot − bet.
 * Если ≤ 0 — колл и так выгоден.
 */
export function impliedNeeded(eq, pot, bet) {
  return Math.max(0, (bet * (1 - eq)) / eq - pot - bet);
}
/**
 * Сколько блефов должно быть на каждый вэлью, чтобы соперник был безразличен
 * к коллу: bet / (pot + bet). Для `value` вэлью-комбо — `value × это`.
 */
export const bluffRatio = (pot, bet) => bet / (pot + bet);
export const bluffsForValue = (value, pot, bet) => value * bluffRatio(pot, bet);
/** Доля блефов в ставочном диапазоне при безразличии соперника: bet / (pot + 2·bet). */
export const bluffShare = (pot, bet) => bet / (pot + 2 * bet);
/** Ставка как доля банка → фишки. */
export const betOfPot = (pot, fraction) => Math.round(pot * fraction);
