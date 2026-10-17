'use strict';
/**
 * Боты для «UNOQ»: 2 уровня — «Новичок» и «Сильный».
 *
 * Уровней два, а не четыре, нарочно: в UNOQ много решает расклад, и замеры
 * (тысячи партий ботов между собой) показали, что промежуточные уровни за
 * картами почти не отличаются. Различимы двое: новичок, который кладёт что
 * попало и медлит с криком, и сильный, который играет без ошибок, кричит
 * сразу и быстро ловит.
 *
 * ЧЕСТНО — ПО УСТРОЙСТВУ. Бот решает по своему `view`: своя рука, верхняя
 * карта и цвет, сколько карт у каждого (число), направление, кто молчит с
 * одной картой. Чужих рук и колоды в виде нет. Ход — через тот же `handle`.
 *
 * «UNOQ!» и «Поймал!» — тоже ходы, и тоже по виду: крикнуть бот может только
 * за себя, поймать — того, кого поймать можно по правилам и в срок. Насколько
 * он быстр, решает уровень: новичок кричит не сразу (и его можно поймать), а
 * ловит редко успевает; сильный кричит сразу и ловит быстро.
 */
import * as C from './rules.js';
import { COLORS, isWild, colorOf, signOf, WILD_FOUR } from './cards.js';

export const LEVELS = [
  { name: 'Новичок', mistake: 0.3, plan: false, attack: false, shout: [2500, 6500], catch: [3500, 7000] },
  { name: 'Сильный', mistake: 0, plan: true, attack: true, voids: true, shout: [250, 700], catch: [700, 1600] },
];

const NAMES = ['Вася', 'Маша', 'Коля', 'Оля', 'Гена', 'Лиза', 'Тёма'];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const levelOf = (spec) => LEVELS[clamp(spec?.level ?? 1, 0, LEVELS.length - 1)];
const between = ([a, b], rng) => a + Math.floor(rng() * (b - a));

/** Цвет, которого в руке больше всего (бесцветные не в счёт); при равенстве — тот, которого нет у следующего. */
function bestColor(hand, rng, voids = {}) {
  const n = Object.fromEntries(COLORS.map((c) => [c, voids[c] ? 1.5 : 0]));
  for (const c of hand) if (!isWild(c)) n[colorOf(c)] += 1;
  const max = Math.max(...Object.values(n));
  const top = COLORS.filter((c) => n[c] === max);
  return top[Math.floor(rng() * top.length)];
}

/** Следующий по кругу, кто ещё в игре, — его карт сколько? (число карт видно всем) */
function nextCount(view) {
  const inGame = view.players.filter((p) => p.inDeal && p.role !== 'out' && p.role !== 'quit');
  const at = inGame.findIndex((p) => p.isMe);
  if (at < 0 || inGame.length < 2) return 99;
  const dir = view.deal.dir || 1;
  return inGame[(at + dir + inGame.length) % inGame.length].count;
}

/**
 * Каких цветов нет у соседей — то, что видно всем за столом: человек взял
 * карту, когда был нужен такой-то цвет, значит, его у него не было. Сильный бот это
 * запоминает (только из ленты событий своего вида) и ходит в «пустой» цвет
 * следующего. Взял ещё карту — мог и получить этот цвет: память о нём стирается.
 */
function observe(spec, view) {
  const d = view.deal;
  let m = spec.mem;
  if (!m || m.no !== d.no) m = spec.mem = { no: d.no, n: 0, color: null, voids: {} };
  for (const e of d.events) {
    if (e.n <= m.n) {
      if (e.color) m.color = e.color;
      continue;
    }
    if (e.kind === 'draw' && e.seat >= 0) {
      // Взял, когда нужен был m.color: такого цвета у него не было. Новая карта
      // этого цвета пришла бы сразу в ход — значит, и сейчас нет.
      if (m.color) (m.voids[e.seat] ||= {})[m.color] = e.n;
    } else if ((e.kind === 'take' || e.kind === 'caught') && (e.seat >= 0 || e.targetSeat >= 0)) {
      // Набрал несколько карт вслепую — что у него теперь, неизвестно.
      delete m.voids[e.kind === 'caught' ? e.targetSeat : e.seat];
    }
    if (e.color) m.color = e.color;
    m.n = e.n;
  }
  m.color = d.color;
  return m;
}

/** Место следующего по кругу (тот, кому сейчас будет плохо от «+2»). */
function nextSeat(view) {
  const inGame = view.players.filter((p) => p.inDeal && p.role !== 'out' && p.role !== 'quit');
  const at = inGame.findIndex((p) => p.isMe);
  if (at < 0 || inGame.length < 2) return -1;
  return inGame[(at + (view.deal.dir || 1) + inGame.length) % inGame.length].seat;
}

/**
 * Какую карту положить. Сильный бот держит бесцветные на потом, ходит в
 * цвет, которого у него больше, и бьёт по следующему, когда у того мало
 * карт: «+2», «стоп», «разворот» — сейчас. Новичок кладёт любую подходящую.
 */
function choose(view, L, rng, voids = {}) {
  const hand = view.me.cards;
  const playable = view.legal.play;
  if (!L.plan) return playable[Math.floor(rng() * playable.length)];
  const danger = L.attack && nextCount(view) <= 2;
  const colorCount = (col) => hand.filter((c) => !isWild(c) && colorOf(c) === col).length;
  const score = (c) => {
    if (isWild(c)) {
      // Бесцветные — на потом; «+4» — ещё дальше, если только не надо бить следующего.
      let s = -20 + (c === WILD_FOUR ? (danger ? 30 : -10) : 0);
      if (hand.length <= 2) s += 25; // почти вышел — тратить можно всё
      return s;
    }
    const sign = signOf(c);
    let s = colorCount(colorOf(c)) * 2; // ходить в свой длинный цвет
    if (voids[colorOf(c)]) s += 6; // у следующего этого цвета нет
    if (sign === 'P' || sign === 'S' || sign === 'V') s += danger ? 25 : L.attack ? 1 : 3;
    if (/^[0-9]$/.test(sign)) s += Number(sign) / 10; // крупные цифры — раньше
    return s;
  };
  return [...playable].sort((a, b) => score(b) - score(a))[0];
}

/**
 * Что сделает бот. Только по `view`.
 *
 * @param wait  чего ждут: ход ('turn'/'pending'), крик ('shout') или поимка ('catch')
 */
export function decideColors(view, spec, wait, rng) {
  const legal = view.legal;
  if (!legal) return null;
  const L = levelOf(spec);
  const seq = view.seq;

  if (wait?.kind === 'shout') return legal.shout ? { t: 'shout' } : null;
  if (wait?.kind === 'catch') return legal.catch ? { t: 'catch' } : null;
  if (!legal.myTurn) return null;

  const hand = view.me.cards;
  const pending = view.deal.pending;
  const voids = L.voids ? observe(spec, view).voids[nextSeat(view)] || {} : {};
  const pick = (cards) => bestColor(cards, rng, voids);

  // Взятая карта подошла: играть её или пасовать. Сильные — играют (это минус карта).
  if (legal.pass) {
    const card = legal.play[0];
    if (card && (L.plan ? !(isWild(card) && hand.length > 3) : rng() < 0.5)) {
      return { t: 'play', card, ...(isWild(card) ? { color: pick(hand.filter((c) => c !== card)) } : {}), seq };
    }
    return { t: 'pass', seq };
  }

  // Висит «+2»/«+4»: накрыть, если есть чем (новичок иногда просто берёт).
  if (pending && legal.play.length && (L.plan || rng() < 0.6)) {
    const card = choose(view, L, rng, voids);
    return { t: 'play', card, ...(isWild(card) ? { color: pick(hand.filter((c) => c !== card)) } : {}), seq };
  }
  if (pending) return { t: 'draw', seq };

  if (!legal.play.length) return { t: 'draw', seq };
  let card = choose(view, L, rng, voids);
  if (rng() < L.mistake) card = legal.play[Math.floor(rng() * legal.play.length)];
  const rest = hand.filter((c, i) => i !== hand.indexOf(card));
  const color = isWild(card) ? (L.plan ? pick(rest) : COLORS[Math.floor(rng() * COLORS.length)]) : undefined;
  return { t: 'play', card, ...(color ? { color } : {}), seq };
}

/* ------------------------------------------------------------ для ядра */

const clampN = (v, a, b, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : d;
};

export default {
  catalog: () => ({
    levels: LEVELS.map((l) => l.name),
    defaultLevel: 0,
    levelHints: [
      'Кладёт что попало, «UNOQ!» кричит не сразу — его можно поймать.',
      'Без ошибок: ходит в свой цвет, бьёт «+2» того, у кого мало карт, кричит сразу и ловит быстро — не зевайте.',
    ],
    maxOpponents: C.MAX_SEATS - 1,
  }),

  /** Стол с ботами: накопление «+2» как обычно, без таймера хода. */
  settings: () => ({ stacking: true, turnSeconds: 0 }),

  lineup(raw = {}) {
    const n = clampN(raw.opponents, 1, C.MAX_SEATS - 1, 3);
    const level = clampN(raw.level, 0, LEVELS.length - 1, 1);
    return Array.from({ length: n }, () => ({ type: 'bot', level }));
  },

  seat(room, spec, i) {
    const p = C.addPlayer(room, { id: `bot${i + 1}`, tgId: 0, name: `🤖 ${NAMES[i % NAMES.length]}`, dm: null });
    if (!p.error) p.bot = { ...spec };
    return p;
  },

  /**
   * Кроме хода, от ботов ждут крика «UNOQ!» (за себя) и поимки промолчавшего
   * (за другого, пока не вышел срок). Крик — первым: он про того, кто только
   * что сходил, и не должен ждать, пока сходит следующий.
   */
  wants(room, now) {
    const d = room.deal;
    if (!d || d.phase !== 'play' || !d.call || d.call.called) return [];
    const c = d.call;
    if (d.hands[c.id]?.length !== 1) return [];
    const out = [];
    if (room.players.find((p) => p.id === c.id)?.bot) out.push({ id: c.id, key: `shout:${c.at}`, kind: 'shout' });
    if (now - c.at < C.CALL_MS) {
      for (const p of room.players) {
        if (p.bot && p.id !== c.id && d.order.includes(p.id)) out.push({ id: p.id, key: `catch:${c.id}:${c.at}`, kind: 'catch' });
      }
    }
    return out;
  },

  delay(room, p, w, rng) {
    const L = levelOf(p?.bot);
    if (w.kind === 'shout') return between(L.shout, rng);
    if (w.kind === 'catch') return between(L.catch, rng);
    return 700 + Math.floor(rng() * 1100);
  },

  decide: ({ view, me, wait, rng }) => decideColors(view, me.bot, wait, rng),

  /** Запасной ход: взять (или пас со взятой). Крик и поимка запаса не имеют. */
  fallback(view, wait) {
    const l = view.legal;
    if (!l || !l.myTurn || wait?.kind === 'shout' || wait?.kind === 'catch') return null;
    if (l.pass) return { t: 'pass', seq: view.seq };
    if (l.draw) return { t: 'draw', seq: view.seq };
    const card = l.play[0];
    return card ? { t: 'play', card, ...(isWild(card) ? { color: COLORS[0] } : {}), seq: view.seq } : null;
  },
};
