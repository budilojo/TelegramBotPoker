'use strict';
/**
 * «Школа покера»: уроки против дилера-наставника и игра с подсказками.
 *
 * Урок — одна раздача один на один с подстроенными картами: ситуация, ради
 * которой урок и затеян (тузы на руках, дро на флеш, дорогая ставка против
 * слабого дро…). Наставник ходит по сценарию урока, а не по чужим картам:
 * сценарий написан заранее и одинаков при любых картах человека. Подсказки
 * говорят только про то, что человек видит сам: свои карты и борд.
 *
 * После раздачи урок оценивается по тому, что человек сделал: повышал ли с
 * сильной рукой, сбросил ли мусор, уравнял ли выгодное дро. Не вышло —
 * можно повторить; вышло — дальше. Последний «урок» — свободная игра с
 * подсказками наставника на каждом ходу.
 */
import crypto from 'node:crypto';
import { parseCard, shuffled } from '../../deck.js';
import { dealOrder } from '../../cards.js';
import { equity } from './bot.js';

/** Имя и место наставника за столом. */
export const COACH_ID = 'bot1';
export const COACH_NAME = 'Наставник';

/**
 * Уроки. `holes` — карты человека (`me`) и наставника (`coach`), `board` —
 * пять общих. `coach` — как наставник ходит: по улицам. `tips` — что
 * подсказать на каждой улице, `advice` — какое действие правильное. `check` —
 * получилось ли (по тому, что человек сделал за раздачу).
 */
export const LESSONS = [
  {
    id: 'strong',
    title: 'Сильная рука',
    goal: 'С сильной рукой не прячьтесь: повышайте и ставьте, чтобы банк вырос.',
    holes: { me: 'As Ah', coach: 'Kd Qc' },
    board: '9h 4c 2s Ac 7d',
    coach: { preflop: 'passive', flop: 'passive', turn: 'passive', river: 'passive' },
    tips: {
      preflop: 'Пара тузов — лучшая стартовая рука в покере. Не прячьте её: повышайте, чтобы в банке было больше фишек.',
      flop: 'Ваши тузы всё ещё сильнее почти любой руки. Ставьте около половины банка — слабая рука соперника заплатит.',
      turn: 'Третий туз! У вас тройка. Ставьте снова: когда рука сильная, вы хотите, чтобы вам заплатили, — это ставка «на вэлью».',
      river: 'Последняя ставка. Тройке тузов здесь почти нечего бояться — ставьте.',
    },
    advice: { preflop: 'raise', flop: 'bet', turn: 'bet', river: 'bet' },
    check: (r) => (r.won && r.aggressive
      ? { ok: true, text: 'Вы выиграли банк и сами его растили. Так и играют сильную руку.' }
      : r.won
        ? { ok: false, text: 'Банк ваш, но маленький: вы ни разу не поставили и не повысили. С тузами банк растят.' }
        : { ok: false, text: 'С тузами не сбрасывают. Попробуйте ещё раз — повышайте и ставьте.' }),
  },
  {
    id: 'fold',
    title: 'Когда сбросить',
    goal: 'Слабую руку против повышения сбрасывают: несыгранные фишки — тоже выигрыш.',
    holes: { me: '7c 2d', coach: 'Qs Qh' },
    board: 'Kd 9s 3c 8h 4d',
    coach: { preflop: 'raise', flop: 'bet', turn: 'bet', river: 'bet' },
    tips: {
      preflop: 'Семь и двойка разной масти — самая слабая стартовая рука. Если нужно доплачивать — сбрасывайте. Бесплатно (чек) — можно посмотреть.',
      flop: 'Ничего не собралось, а соперник ставит. Сбросьте — не платите за надежду.',
      turn: 'Всё ещё ничего. Сбросить — правильно.',
      river: 'Ничего. Сбросить.',
    },
    advice: { preflop: 'fold', flop: 'fold', turn: 'fold', river: 'fold' },
    check: (r) => (r.folded && r.paid <= r.blind
      ? { ok: true, text: 'Правильно: с 7-2 против повышения не играют. Вы потеряли только блайнд.' }
      : r.folded
        ? { ok: false, text: 'Сбросили, но поздно: за слабую руку уже заплачено. Против повышения 7-2 сбрасывают сразу.' }
        : { ok: false, text: 'С 7-2 против сильной игры вы рисковали фишками почти без шансов. Попробуйте сбросить.' }),
  },
  {
    id: 'pairs',
    title: 'Пара и две пары',
    goal: 'Учимся читать борд: старшая пара, кикер, две пары.',
    holes: { me: 'Kh Qh', coach: 'Jc 10c' },
    board: 'Kc 7d 2s Qd 3h',
    coach: { preflop: 'passive', flop: 'passive', turn: 'passive', river: 'passive' },
    tips: {
      preflop: 'Король и дама одной масти — хорошая рука: можно уравнять или повысить.',
      flop: 'Пришёл король — у вас «старшая пара»: пара королей, а дама — «кикер», она решает, если у соперника тоже король. Это сильно — ставьте.',
      turn: 'Дама! Теперь у вас две пары — короли и дамы. Ставьте снова.',
      river: 'Две пары в игре один на один проигрывают редко. Ставьте или вскрывайтесь.',
    },
    advice: { preflop: 'call', flop: 'bet', turn: 'bet', river: 'bet' },
    check: (r) => (r.won
      ? { ok: true, text: 'Банк ваш: две пары, короли и дамы. Вы видите, что собрал борд вместе с вашими картами.' }
      : { ok: false, text: 'Вы сбросили сильную руку. Пара королей, а потом две пары — повод ставить, а не сбрасывать.' }),
  },
  {
    id: 'draw',
    title: 'Шансы банка: дро',
    goal: 'Считаем «ауты» и сравниваем шанс с ценой колла.',
    holes: { me: '9h 8h', coach: 'Ac Kd' },
    board: '7h 6c 2h Jh 3s',
    coach: { preflop: 'passive', flop: 'bet-half', turn: 'passive', river: 'passive' },
    tips: {
      preflop: 'Девять и восемь одной масти — рука «на потом»: она собирает стриты и флеши. Дёшево — можно посмотреть флоп.',
      flop: 'Пока ничего, но это сильное «дро»: четыре черви (пятая даст флеш) и 9-8-7-6 (пятёрка или десятка дадут стрит). Карт, которые собирают руку, — 15. Шанс на следующей карте ≈ 32%, до ривера ≈ 54%. Соперник ставит полбанка: доплатить нужно 25% от будущего банка. 32% больше 25% — уравнивайте.',
      turn: 'Флеш собран! Теперь ставьте сами — соперник может заплатить.',
      river: 'Флеш — сильная рука. Ставьте.',
    },
    // Когда первым ходит человек и ставки ещё нет.
    tipsFree: {
      flop: 'Пока ничего, но это сильное «дро»: четыре черви (пятая даст флеш) и 9-8-7-6 (пятёрка или десятка дадут стрит). Карт, которые собирают руку, — 15: шанс на следующей карте ≈ 32%. Можно бесплатно посмотреть карту — чек. А если соперник поставит полбанка — уравнивайте: доплатить нужно 25%, а шанс больше.',
    },
    advice: { preflop: 'call', flop: 'call', turn: 'bet', river: 'bet' },
    check: (r) => (!r.foldedOn.flop && !r.foldedOn.preflop
      ? { ok: true, text: 'Верно: шанс собрать руку был больше доли, которую вы доплачивали. Такой колл выгоден на дистанции.' }
      : { ok: false, text: '15 аутов — это много: шанс больше цены колла. Здесь уравнивают.' }),
  },
  {
    id: 'overpay',
    title: 'Не переплачивать',
    goal: 'Мало аутов и дорогая ставка — сбросить.',
    holes: { me: 'Jd 10c', coach: 'Ks Kc' },
    board: '8s 7d 2c 3h 4s',
    coach: { preflop: 'passive', flop: 'bet-pot', turn: 'bet-pot', river: 'bet-pot' },
    tips: {
      preflop: 'Валет-десятка — средняя рука. Можно посмотреть флоп.',
      flop: 'Валет-десятка на 8-7-2: стрит соберёт только девятка — 4 аута, ≈ 9% на следующей карте. Соперник ставит весь банк: доплатить нужно треть будущего банка (33%). 9% меньше 33% — колл в минус. Сбросьте.',
      turn: 'Ничего не пришло, а ставка снова крупная. Сбросить.',
      river: 'Ничего. Сбросить.',
    },
    tipsFree: {
      flop: 'Валет-десятка на 8-7-2: стрит соберёт только девятка — 4 аута, ≈ 9% на следующей карте. Бесплатно посмотреть — можно: чек. Но если соперник поставит весь банк, доплачивать треть банка за 9% — в минус: сбрасывайте.',
    },
    advice: { preflop: 'call', flop: 'fold', turn: 'fold', river: 'fold' },
    check: (r) => (r.foldedOn.flop
      ? { ok: true, text: 'Верно: 4 аута не стоят ставки в размер банка. Сбросить — значит сберечь фишки.' }
      : r.folded
        ? { ok: false, text: 'Сбросили, но не на флопе. Считайте сразу: 4 аута против ставки в банк — это сброс.' }
        : { ok: false, text: 'Дорого: за 9% шанса вы платили треть банка. Попробуйте сбросить на флопе.' }),
  },
  {
    id: 'bluff',
    title: 'Блеф',
    goal: 'Если соперник показывает слабость (чек), ставка может забрать банк сразу.',
    holes: { me: 'Ac 5d', coach: 'Js 10s' },
    board: '9d 6c 2h Kh 3c',
    coach: { preflop: 'passive', flop: 'weak', turn: 'weak', river: 'weak' },
    tips: {
      preflop: 'Туз с пятёркой — средне. Можно посмотреть флоп.',
      flop: 'Борд не помог ни вам, ни, скорее всего, сопернику. Ставка в половину банка часто забирает банк сразу — это и есть блеф. Попробуйте.',
      turn: 'Соперник не показывает силы — это слабость. Ставьте.',
      river: 'Последний шанс забрать банк ставкой.',
    },
    advice: { preflop: 'call', flop: 'bet', turn: 'bet', river: 'bet' },
    check: (r) => (r.won && !r.showdown
      ? { ok: true, text: 'Соперник сбросил — банк ваш без вскрытия. Блеф работает, когда соперник показывает слабость.' }
      : r.won
        ? { ok: false, text: 'Банк ваш на вскрытии, но можно было забрать его ставкой: соперник не показывал силы.' }
        : { ok: false, text: 'Попробуйте поставить, когда соперник пропускает ход (чек).' }),
  },
];

/** Номер урока «свободная игра» — после всех уроков. */
export const FREE = LESSONS.length;
export const lessonOf = (room) => (room.learn && room.learn.lesson < LESSONS.length ? LESSONS[room.learn.lesson] : null);

/** Колода урока: нужные карты на нужные места, остальное — честно перемешано. */
export function lessonDeck(room, owner, randInt = (n) => crypto.randomInt(n)) {
  const L = lessonOf(room);
  const deck = shuffled(randInt);
  if (!L) return deck;
  const order = dealOrder(room);
  const n = order.length;
  const out = new Array(52).fill(null);
  const used = new Set();
  const put = (i, card) => {
    used.add(card);
    out[i] = card;
  };
  const holes = { [owner]: L.holes.me, [COACH_ID]: L.holes.coach };
  order.forEach((id, i) => {
    if (!holes[id]) return;
    const [a, b] = holes[id].split(' ').map(parseCard);
    put(i, a);
    put(n + i, b);
  });
  // Перед флопом, тёрном и ривером карта сжигается (cards.js): флоп — 2n+1…2n+3, тёрн — 2n+5, ривер — 2n+7.
  const at = [1, 2, 3, 5, 7];
  L.board.split(' ').map(parseCard).forEach((c, k) => put(2 * n + at[k], c));
  const rest = deck.filter((c) => !used.has(c));
  for (let i = 0; i < 52; i++) if (out[i] == null) out[i] = rest.shift();
  return out;
}

/* ------------------------------------------------------------ наставник */

/**
 * Ход наставника по сценарию урока. Сценарий не смотрит в карты человека —
 * он один и тот же при любых его картах.
 */
export function coachMove(room, view) {
  const L = lessonOf(room);
  const legal = view.legal;
  if (!L || !legal) return null;
  const street = room.hand.street;
  const plan = L.coach[street] || 'passive';
  const seq = view.seq;
  const act = (action, amount) => ({ t: 'act', action, ...(amount != null ? { amount } : {}), seq });
  const sized = (f) => {
    const want = legal.currentBet + Math.max(legal.minTotal - legal.currentBet, Math.round(f * (legal.potTotal + legal.toCall)));
    return Math.max(legal.minTotal, Math.min(legal.maxTotal, want));
  };
  const passive = () => (legal.canCheck ? act('check') : act('call'));
  // Урок — не про олл-ины: на крупную ставку человека наставник сбрасывает,
  // чтобы ни у кого не кончились фишки посреди школы.
  if (legal.toCall > 0 && legal.toCall >= legal.stack * 0.25) return act('fold');
  switch (plan) {
    case 'raise':
      if (legal.canRaise || legal.canBet) return act(legal.canBet ? 'bet' : 'raise', Math.max(legal.minTotal, Math.min(legal.maxTotal, 3 * view.room.settings.bigBlind)));
      return passive();
    case 'bet':
    case 'bet-half':
      if (legal.canBet) return act('bet', sized(0.5));
      return legal.canCheck ? act('check') : act('call');
    case 'bet-pot':
      if (legal.canBet) return act('bet', sized(1));
      if (legal.canRaise && legal.toCall < legal.potTotal * 0.4) return act('raise', sized(1));
      return passive();
    case 'weak':
      if (legal.canCheck) return act('check');
      return act('fold');
    default:
      return passive();
  }
}

/* ------------------------------------------------------------ подсказки */

/** Детерминированная случайность для подсказки: одна и та же на одном ходу — цифры не прыгают. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CODE_INDEX = new Map();
/** Код карты вида ('AS', '10H') → номер карты движка. */
function indexOf(code) {
  if (!CODE_INDEX.size) for (let c = 0; c < 52; c++) CODE_INDEX.set(cardCodeOf(c), c);
  return CODE_INDEX.get(code);
}
const RANK_CODES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const cardCodeOf = (c) => RANK_CODES[c >> 2] + 'SHDC'[c & 3];

const pct = (x) => `${Math.round(x * 100)}%`;
const ACTION_RU = { raise: 'Повысить', bet: 'Поставить', call: 'Уравнять', check: 'Чек', fold: 'Сбросить' };

/**
 * Подсказка «по-честному» — из того, что человек видит сам: его карты, борд,
 * банк и сколько доплатить. Шанс выиграть считается против случайной руки
 * соперника, как это делает человек в голове, только точнее.
 */
export function liveTip(view) {
  const legal = view.legal;
  if (!legal) return null;
  const hole = (view.me.cards || []).map(indexOf).filter((c) => c != null);
  const board = (view.hand?.board || []).map(indexOf).filter((c) => c != null);
  if (hole.length !== 2) return null;
  const opponents = Math.max(1, view.players.filter((p) => !p.isMe && p.inHand && !p.folded).length);
  const eq = equity(hole, board, opponents, 600, seeded(view.seq * 7919 + board.length));
  const odds = legal.toCall > 0 ? legal.toCall / (legal.potTotal + legal.toCall) : 0;
  const strong = eq >= (opponents > 1 ? 0.45 : 0.62);
  let advice;
  if (strong) advice = legal.canBet ? 'bet' : legal.canRaise ? 'raise' : legal.canCall ? 'call' : 'check';
  else if (legal.canCheck) advice = 'check';
  else advice = eq >= odds ? 'call' : 'fold';
  const parts = [];
  parts.push(view.me.handName ? `У вас: ${view.me.handName.toLowerCase()}.` : 'Пока ничего не собрано.');
  parts.push(`Шанс выиграть против ${opponents === 1 ? 'одной руки' : `${opponents} рук`} ≈ ${pct(eq)}.`);
  if (legal.toCall > 0) parts.push(`Доплатить — ${pct(odds)} будущего банка: ${eq >= odds ? 'шанс больше цены, колл в плюс' : 'шанс меньше цены, колл в минус'}.`);
  if (strong && (legal.canBet || legal.canRaise)) parts.push('Рука сильная — ставьте, пусть банк растёт.');
  return { text: parts.join(' '), advice, equity: Math.round(eq * 100), odds: Math.round(odds * 100) };
}

/** Что показать человеку: урок, подсказку на этой улице и итог урока. */
export function learnView(room, view) {
  if (!room.learn) return null;
  const L = lessonOf(room);
  const no = room.learn.lesson;
  const street = room.hand?.street || 'preflop';
  let tip = null;
  if (view.legal) {
    if (L) {
      // Совет урока — в том виде, в каком его можно выполнить сейчас:
      // «сбросить», когда доплачивать не надо, — это чек; «поставить» после
      // чужой ставки — это повысить.
      const advice = L.advice[street];
      const legal = view.legal;
      const doable = advice === 'fold' && legal.canCheck ? 'check'
        : advice === 'bet' && !legal.canBet && legal.canRaise ? 'raise'
          : advice === 'raise' && legal.canBet ? 'bet'
            : advice === 'call' && legal.canCheck ? 'check'
              : advice;
      tip = { text: (legal.canCheck && L.tipsFree?.[street]) || L.tips[street], advice: doable };
    } else tip = liveTip(view);
  }
  return {
    lesson: no,
    total: LESSONS.length,
    title: L ? L.title : 'Свободная игра',
    goal: L ? L.goal : 'Играйте сами — наставник подсказывает на каждом ходу.',
    tip: tip ? { text: tip.text, advice: tip.advice, label: ACTION_RU[tip.advice] || null } : null,
    result: room.learn.result || null,
    lessons: LESSONS.map((x) => x.title),
  };
}

/* ------------------------------------------------------------ итог урока */

/** Записать ход человека — урок оценивается по ним. */
export function noteAct(room, uid, action) {
  if (!room.learn || uid !== room.solo?.owner) return;
  room.learn.acts.push({ street: room.hand?.street || 'preflop', action });
}

/** Раздача кончилась — получился ли урок. */
export function judge(room) {
  const L = lessonOf(room);
  const h = room.hand;
  if (!room.learn || !h || h.phase !== 'complete' || room.learn.result || room.learn.judged === h.no) return;
  room.learn.judged = h.no;
  if (!L) return;
  const owner = room.solo.owner;
  const acts = room.learn.acts;
  const me = room.players.find((p) => p.id === owner);
  const won = (h.payouts || []).some((x) => x.playerId === owner && x.amount > 0) &&
    !(h.payouts || []).some((x) => x.playerId !== owner && x.amount > 0);
  const foldedOn = {};
  for (const a of acts) if (a.action === 'fold') foldedOn[a.street] = true;
  const r = {
    won,
    showdown: !!h.shown,
    folded: acts.some((a) => a.action === 'fold'),
    foldedOn,
    aggressive: acts.some((a) => ['bet', 'raise', 'allin'].includes(a.action)),
    paid: Math.max(0, (room.learn.stackAt ?? me.stack) - me.stack),
    blind: room.settings.bigBlind,
  };
  room.learn.result = { lesson: room.learn.lesson, ...L.check(r) };
}
