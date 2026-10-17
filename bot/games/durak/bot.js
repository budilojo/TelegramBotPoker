'use strict';
/**
 * Боты для дурака: 8 характеров × 4 уровня.
 *
 * ЧЕСТНО — ПО УСТРОЙСТВУ. Бот решает по своему `view`: свои карты, открытый
 * стол, козырь, сколько карт в колоде и у каждого (число, не карты), и
 * законные ходы (`legal`), посчитанные по ЕГО руке. Чужих рук и порядка колоды
 * в этом виде нет. Ход идёт через тот же `handle`, что у человека.
 *
 * ХАРАКТЕР — что бот любит: беречь козыри, подкидывать всё подряд, переводить,
 * брать мелочь. УРОВЕНЬ — насколько аккуратно: новичок отбивается первой
 * подходящей картой и путается; любитель считает, чем отбить всё; опытный
 * ещё и знает, что без колоды надо избавляться от всего; профи не ошибается
 * и помнит вышедшие карты (только открытые — как внимательный человек).
 * Каждый уровень обыгрывает предыдущий — это проверено тестом.
 */
import * as D from './rules.js';
import { beats, rankOf, suitOf, rankIndex, freshDeck36 } from './cards.js';

const ALL = freshDeck36();

/**
 * save   — насколько бережёт козыри: чем больше, тем охотнее возьмёт, чем отдаст старший козырь;
 * throw  — насколько охотно подкидывает (0 — только мелочь, 1 — всё, что можно);
 * move   — как охотно переводит (переводной);
 * take   — готовность взять мелочь, а не тратить карты;
 * pairs  — любит заходить с пары, чтобы потом подкинуть;
 * wild   — доля случайных ходов сверх уровня.
 */
export const TYPES = [
  { id: 'calm', name: 'Ровный', short: 'Ровный', blurb: 'Играет по учебнику: мелочью ходит, дёшево отбивается', p: { save: 0.5, throw: 0.5, move: 0.6, take: 0.3, pairs: 0.5, wild: 0 } },
  { id: 'miser', name: 'Скупой', short: 'Скупой', blurb: 'Козыри не отдаёт: скорее возьмёт, чем побьёт старшим', p: { save: 0.95, throw: 0.4, move: 0.5, take: 0.6, pairs: 0.4, wild: 0 } },
  { id: 'trumper', name: 'Козырник', short: 'Козырник', blurb: 'Бьёт козырями не жалея — лишь бы не брать', p: { save: 0.05, throw: 0.5, move: 0.5, take: 0.05, pairs: 0.3, wild: 0 } },
  { id: 'thrower', name: 'Подкидчик', short: 'Подкидчик', blurb: 'Подкидывает всё, что можно, — завалить отбивающегося', p: { save: 0.5, throw: 1, move: 0.6, take: 0.3, pairs: 0.6, wild: 0 } },
  { id: 'mover', name: 'Ловкач', short: 'Ловкач', blurb: 'Переводит при любой возможности (в переводном)', p: { save: 0.5, throw: 0.5, move: 1, take: 0.3, pairs: 0.5, wild: 0 } },
  { id: 'collector', name: 'Сборщик', short: 'Сборщик', blurb: 'Охотно берёт мелочь в начале — копит силу на конец', p: { save: 0.7, throw: 0.3, move: 0.4, take: 0.9, pairs: 0.4, wild: 0 } },
  { id: 'tactic', name: 'Тактик', short: 'Тактик', blurb: 'Заходит с пар и подкидывает в масть — давит связками', p: { save: 0.6, throw: 0.7, move: 0.7, take: 0.25, pairs: 1, wild: 0 } },
  { id: 'wild', name: 'Шальной', short: 'Шальной', blurb: 'Непредсказуемый: то бережёт, то рискует', p: { save: 0.4, throw: 0.6, move: 0.6, take: 0.3, pairs: 0.4, wild: 0.25 } },
];
const BY_ID = new Map(TYPES.map((t) => [t.id, t]));

/** Уровни: ошибки, планирование защиты, учёт колоды и конца игры. */
export const LEVELS = [
  { name: 'Новичок', mistake: 0.25, plan: false, endgame: false, talonAware: false },
  { name: 'Любитель', mistake: 0.12, plan: true, endgame: false, talonAware: false },
  { name: 'Опытный', mistake: 0.12, plan: true, endgame: true, talonAware: true },
  { name: 'Профи', mistake: 0, plan: true, endgame: true, talonAware: true, memory: true },
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Цена карты: шестёрка дешевле туза, любой козырь дороже любой простой. */
const value = (c, trump) => rankIndex(c) + (suitOf(c) === trump ? 10 : 0);

/**
 * Чем покрыть все непобитые карты: по одной своей на каждую, самыми дешёвыми.
 * Сначала — самые трудные (старшие и козырные) атаки. null — не отбиться.
 */
function planCover(hand, attacks, trump) {
  const left = [...hand];
  const plan = [];
  const order = [...attacks].sort((x, y) => value(y.card, trump) - value(x.card, trump));
  for (const { card, i } of order) {
    const options = left.filter((c) => beats(card, c, trump)).sort((a, b) => value(a, trump) - value(b, trump));
    if (!options.length) return null;
    plan.push({ target: i, card: options[0] });
    left.splice(left.indexOf(options[0]), 1);
  }
  return plan;
}

/**
 * Память профи — как у внимательного человека: что уже было на столе. Только
 * то, что бот видел сам в своих видах: отбитые карты ушли в отбой, взятые —
 * к тому, кто взял, пока он ими снова не сходит. Чужих рук бот не видит —
 * он помнит открытое.
 */
export function observe(spec, view) {
  const d = view.deal;
  let m = spec.mem;
  if (!m || m.no !== d.no) m = spec.mem = { no: d.no, gone: [], took: {}, table: [], bout: null };
  // Судьба карт известна, только если закончился именно тот отбой, что бот
  // видел: за большим столом между его ходами могут пройти и другие.
  if (m.bout != null && m.bout !== d.bout && d.last?.bout === m.bout && m.table.length) {
    if (d.last.kind === 'beaten') m.gone.push(...m.table);
    else (m.took[d.last.defenderSeat] ||= []).push(...m.table);
  }
  m.bout = d.bout;
  m.table = d.table.flatMap((x) => [x.a, x.d]).filter(Boolean);
  // Карта снова на столе или у меня в руке — значит, уже не «у того, кто взял».
  const here = new Set([...m.table, ...view.me.cards]);
  for (const k of Object.keys(m.took)) m.took[k] = m.took[k].filter((c) => !here.has(c));
  return m;
}

/**
 * Какие карты могут быть у соперников: все, кроме своих, лежащих на столе и
 * ушедших в отбой на глазах у бота. При неполной памяти — с запасом.
 */
export function possibleCards(view, m) {
  const out = new Set([...view.me.cards, ...m.table, ...m.gone]);
  return ALL.filter((c) => !out.has(c));
}

/** Карты, которые нечем побить ни одной картой из `possible`. */
const unbeatable = (cards, possible, trump) => cards.filter((c) => !possible.some((x) => beats(c, x, trump)));

/**
 * Что сделает бот. Только по `view` — тому, что видел бы человек на его месте.
 *
 * @returns сообщение, как от страницы: attack / defend / transfer / take / pass
 */
export function decideDurak(view, spec, rng) {
  const msg = decide(view, spec, rng);
  // Свою карту бот тоже запоминает: стол он в следующий раз может увидеть уже без неё.
  if (msg?.card && spec.mem?.no === view.deal?.no) spec.mem.table.push(msg.card);
  return msg;
}

function decide(view, spec, rng) {
  const legal = view.legal;
  const deal = view.deal;
  if (!legal || !deal || deal.phase !== 'play') return null;
  const type = BY_ID.get(spec.type) || BY_ID.get('calm');
  const L = LEVELS[clamp(spec.level ?? 1, 0, LEVELS.length - 1)];
  const p = type.p;
  const seq = view.seq;
  const trump = deal.trump;
  const hand = view.me.cards;
  const talon = deal.talon;
  const endgame = L.endgame && talon === 0;
  const cheap = (a, b) => value(a, trump) - value(b, trump);
  const mem = L.memory ? observe(spec, view) : null;
  // В конце игры профи знает, чем сопернику крыть нечем.
  const sure = mem && endgame ? (cards) => unbeatable(cards, possibleCards(view, mem), trump).sort(cheap) : () => [];

  const msg = {
    attack: (card) => ({ t: 'attack', card, seq }),
    defend: (card, target) => ({ t: 'defend', card, target, seq }),
    transfer: (card) => ({ t: 'transfer', card, seq }),
    take: () => ({ t: 'take', seq }),
    pass: () => ({ t: 'pass', seq }),
  };

  // Ошибки новичка и выходки шального: любой законный ход.
  if (rng() < L.mistake + p.wild) {
    const options = [];
    for (const c of legal.attack) options.push(msg.attack(c));
    for (const [c, targets] of Object.entries(legal.defend)) options.push(msg.defend(c, targets[Math.floor(rng() * targets.length)]));
    for (const c of legal.transfer) options.push(msg.transfer(c));
    if (legal.take) options.push(msg.take());
    if (legal.pass) options.push(msg.pass());
    if (options.length) return options[Math.floor(rng() * options.length)];
  }

  /* --- заход */
  if (legal.lead) {
    const sorted = [...hand].sort(cheap);
    // В конце игры, когда колоды нет, — заходить парой (её не отбить одной картой
    // того же достоинства) или самой дешёвой; до конца — самой дешёвой некозырной.
    const pool = sorted.filter((c) => suitOf(c) !== trump);
    let card = sure(hand)[0] || (pool.length ? pool : sorted)[0];
    if (rng() < p.pairs) {
      const counts = new Map();
      for (const c of hand) counts.set(rankOf(c), (counts.get(rankOf(c)) || 0) + 1);
      const pair = sorted.find((c) => counts.get(rankOf(c)) >= 2 && (suitOf(c) !== trump || endgame) && rankIndex(c) <= rankIndex(card) + 3);
      if (pair) card = pair;
    }
    return msg.attack(card);
  }

  /* --- защита */
  const defending = Object.keys(legal.defend).length > 0 || legal.take || legal.transfer.length > 0;
  if (defending) {
    const attacks = deal.table.map((x, i) => ({ card: x.a, i, covered: !!x.d })).filter((x) => !x.covered);

    // Перевод: дешёвой некозырной — почти всегда выгодно (отбиваться будет другой).
    if (legal.transfer.length) {
      const t = [...legal.transfer].sort(cheap)[0];
      const costly = suitOf(t) === trump && !endgame;
      if (!costly && rng() < p.move) return msg.transfer(t);
    }

    let plan = null;
    if (L.plan) plan = planCover(hand, attacks, trump);
    else {
      // Новичок кроет первую попавшуюся карту первой подходящей — без расчёта на остальные.
      const [c, targets] = Object.entries(legal.defend)[0] || [];
      plan = c ? [{ card: c, target: targets[0] }] : null;
    }
    if (!plan) return legal.take ? msg.take() : null;

    // Стоит ли тратить на это козыри, пока колода не кончилась?
    if (L.talonAware && talon > 8 && legal.take && attacks.length <= 2) {
      // Отдать туза или короля козырей ради одной-двух мелких карт в начале
      // игры — дорого: козырь ещё понадобится, а мелочь потом уйдёт сама.
      const big = plan.some((x) => suitOf(x.card) === trump && rankIndex(x.card) >= 7);
      const small = attacks.every((x) => suitOf(x.card) !== trump && rankIndex(x.card) <= 4);
      if (big && small && rng() < p.save * 0.7) return msg.take();
      // «Сборщик» берёт мелочь, чтобы не тратить карты.
      if (small && p.take >= 0.6 && hand.length <= 6 && rng() < p.take * 0.4) return msg.take();
    }
    const first = plan[0];
    return msg.defend(first.card, first.target);
  }

  /* --- подкинуть или пас */
  if (legal.attack.length) {
    const taking = deal.taking;
    const sorted = [...legal.attack].sort(cheap);
    // Козыри и старшие карты не подкидывают — кроме конца игры, когда надо
    // избавиться от всего, или если характер «завалить любой ценой».
    const ok = sorted.filter((c) => {
      if (endgame) return true;
      if (suitOf(c) === trump) return p.throw >= 1 && talon === 0;
      const limit = taking ? 8 : 4 + Math.round(p.throw * 4); // по индексу: 4 — десятка, 8 — туз
      return rankIndex(c) <= limit;
    });
    const best = sure(ok)[0] || ok[0];
    if (ok.length && (endgame || taking || rng() < 0.35 + p.throw * 0.65)) return msg.attack(best);
  }
  if (legal.pass) return msg.pass();
  return null;
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
      'Кроет первой подходящей картой и часто ошибается.',
      'Отбивается с расчётом, но без колоды играет как с колодой.',
      'Знает, как играть, когда колода кончилась; иногда ошибается.',
      'Без ошибок и помнит вышедшие карты: в конце ходит тем, что нечем побить.',
    ],
    types: TYPES.map((t) => ({ id: t.id, name: t.name, blurb: t.blurb })),
    maxOpponents: D.MAX_SEATS - 1,
  }),

  /** Стол с ботами: выбранный вариант, без таймера хода. */
  settings: (raw = {}) => ({ variant: D.VARIANTS.includes(raw.variant) ? raw.variant : 'podkidnoy', turnSeconds: 0 }),

  lineup(raw = {}, rng = Math.random) {
    const n = clampN(raw.opponents, 1, D.MAX_SEATS - 1, 2);
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

  /** Бот садится под именем характера; одинаковые различаются номером. */
  seat(room, spec, i) {
    const t = BY_ID.get(spec.type);
    const same = room.players.filter((p) => p.bot?.type === spec.type).length;
    const p = D.addPlayer(room, { id: `bot${i + 1}`, tgId: 0, name: same ? `${t.short} ${same + 1}` : t.short, dm: null });
    if (!p.error) p.bot = { ...spec };
    return p;
  },

  delay: (room, p, w, rng) => (w.kind === 'throw' ? 600 : 800) + Math.floor(rng() * 900),

  decide: ({ view, me, rng }) => decideDurak(view, me.bot, rng),

  /** Запасной ход: отбивающийся берёт, подкидывающий пасует, заходящий — самой младшей. */
  fallback(view) {
    const l = view.legal;
    if (!l) return null;
    if (l.take) return { t: 'take', seq: view.seq };
    if (l.pass) return { t: 'pass', seq: view.seq };
    if (l.lead && l.attack.length) {
      const trump = view.deal.trump;
      const card = [...l.attack].sort((a, b) => value(a, trump) - value(b, trump))[0];
      return { t: 'attack', card, seq: view.seq };
    }
    return null;
  },
};
