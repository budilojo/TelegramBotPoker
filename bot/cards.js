'use strict';
/**
 * Карты поверх движка ставок. Чистые функции над `room`, без ввода-вывода.
 *
 * `server/game.js` считает только фишки: улицы, очередь, сайд-поты. Он не
 * знает, что такое карта, и не должен узнать — это делает его общим для веба
 * (где карты настоящие) и для бота (где их сдаёт бот). Поэтому карты живут
 * здесь, рядом с раздачей движка, и следуют за ней:
 *
 *   - движок перешёл на новую улицу -> открываем борд до 3/4/5 карт;
 *   - движок ушёл во вскрытие       -> докладываем борд до пяти, считаем руки,
 *                                      и отдаём каждый банк через `awardPots`
 *                                      движка — делёж и лишняя фишка остаются
 *                                      на его совести, здесь их не считают;
 *   - все сбросили                  -> движок сам отдал банк; карты
 *                                      победителя НЕ открываются.
 *
 * Всё состояние карт — несколько полей внутри `room.hand`: колода, курсор,
 * карманные карты, борд. Оно сериализуется вместе с раздачей, поэтому рестарт
 * посреди раздачи продолжает ту же колоду, а не тасует новую.
 */
import { awardPots } from '../server/game.js';
import { shuffled, RANKS, rankOf, suitOf } from './deck.js';
import { best5, rank } from './eval.js';

/** Сколько карт лежит на борде на каждой улице. */
export const BOARD_SIZE = { preflop: 0, flop: 3, turn: 4, river: 5 };

/* ---------------------------------------------------------------- показ */

/**
 * Масти с эмодзи-вариантом (U+FE0F): красные ♥️♦️ отличаются от чёрных ♠️♣️
 * цветом на любом телефоне. Текстовые ♠♥ в шрифте Telegram одного цвета, и
 * пики с трефами на маленьком экране путают — а это чужой флеш.
 */
const SUIT_EMOJI = ['♠️', '♥️', '♦️', '♣️'];

export const cardText = (c) => RANKS[rankOf(c)] + SUIT_EMOJI[suitOf(c)];
export const cardsText = (cs) => (cs || []).map(cardText).join(' ');

/* -------------------------------------------------------------- раздача */

/**
 * Порядок сдачи: с первого места слева от баттона, по одной карте за круг —
 * как сдаёт живой дилер. На честность это не влияет (колода и так случайна),
 * зато тест может подложить колоду и точно знать, кому что придёт.
 */
export function dealOrder(room) {
  const h = room.hand;
  const n = room.players.length;
  const d = room.players.findIndex((p) => p.id === h.dealerId);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const p = room.players[(((d + i) % n) + n) % n];
    if (p.inHand) out.push(p.id);
  }
  return out;
}

/**
 * Раздать карманные карты сразу после `startHand` движка.
 * @param deck массив 0..51 в порядке сдачи; по умолчанию — честно тасованный
 */
export function dealHoles(room, deck = shuffled()) {
  const h = room.hand;
  if (!Array.isArray(deck) || deck.length !== 52 || new Set(deck).size !== 52) {
    throw new Error('колода должна содержать 52 разные карты');
  }
  h.deck = [...deck];
  h.cursor = 0;
  h.board = [];
  h.holes = {};
  h.shown = null;
  const order = dealOrder(room);
  for (const id of order) h.holes[id] = [];
  for (let round = 0; round < 2; round++) {
    for (const id of order) h.holes[id].push(h.deck[h.cursor++]);
  }
}

function dealBoardTo(h, size) {
  while (h.board.length < size) h.board.push(h.deck[h.cursor++]);
}

/**
 * Подтянуть карты за движком. Вызывается после КАЖДОГО вызова движка, который
 * может сдвинуть раздачу: действие игрока, выход из чата, удаление, старт.
 *
 * @returns 'betting' | 'showdown' | 'folded' | null — чем кончилось
 */
export function syncCards(room) {
  const h = room.hand;
  if (!h || !h.deck) return null;

  if (h.phase === 'betting') {
    dealBoardTo(h, BOARD_SIZE[h.street] ?? 0);
    return 'betting';
  }

  if (h.phase === 'showdown') {
    // Олл-ин до ривера: движок улицы не двигает — остаток борда формальность,
    // и его докладывают сразу.
    dealBoardTo(h, 5);
    resolveShowdown(room);
    return 'showdown';
  }

  // phase === 'complete'. Если бот сам не вскрывал — значит, все сбросили и
  // движок отдал банк единственному оставшемуся. Карты победителя закрыты.
  if (!h.shown && !h.foldWin) {
    h.foldWin = true;
    closeDeck(h);
  }
  return h.foldWin ? 'folded' : 'showdown';
}

/**
 * Вскрытие. Каждый банк — отдельно, среди СВОИХ претендентов: короткий
 * олл-ин с лучшей рукой берёт основной банк, а сайд-пот, на который он не
 * претендует, уходит лучшей руке среди остальных.
 */
function resolveShowdown(room) {
  const h = room.hand;
  const seven = (id) => [...h.holes[id], ...h.board];

  const live = room.players.filter((p) => p.inHand && !p.folded);
  const shown = {};
  for (const p of live) {
    const b = best5(seven(p.id));
    shown[p.id] = { cards: [...h.holes[p.id]], best: b.cards, score: b.score, name: b.name };
  }

  const assignments = h.pots.map((pot) => {
    if (pot.eligible.length === 1) return [...pot.eligible]; // возврат, не спор
    return rank(pot.eligible.map((id) => ({ id, cards: seven(id) })))[0].ids;
  });

  const r = awardPots(room, assignments);
  if (r.error) throw new Error(`движок не принял вскрытие: ${r.error}`);

  h.shown = shown;
  closeDeck(h);

  // Запись в историю движка: чем закончилась раздача, для итогов вечера.
  const rec = room.history?.[0];
  if (rec && rec.no === h.no) {
    rec.board = [...h.board];
    rec.shown = Object.fromEntries(Object.entries(shown).map(([id, s]) => [id, s.name]));
  }
}

/**
 * После раздачи несданный остаток колоды больше никому не нужен. Стираем
 * его, чтобы «что было бы на ривере» не лежало в базе и в undo-снимках.
 */
function closeDeck(h) {
  h.deck = null;
}

/* ---------------------------------------------------------------- чтение */

/** Карманные карты игрока или null — если он не в раздаче. */
export function holeOf(room, userId) {
  return room.hand?.holes?.[String(userId)] ?? null;
}

/**
 * Текст для «🂠 Мои карты» — всплывающее окно, которое Telegram показывает
 * ТОЛЬКО нажавшему. Лимит — 200 символов, поэтому коротко.
 */
export function peekText(room, userId) {
  const h = room.hand;
  if (!h || !h.holes) return 'Раздача ещё не началась.';
  const mine = holeOf(room, userId);
  if (!mine) return 'Вы не в этой раздаче.';
  const p = room.players.find((x) => x.id === String(userId));
  const lines = [`Раздача #${h.no}. Ваши карты: ${cardsText(mine)}`];
  if (h.board.length) lines.push(`Борд: ${cardsText(h.board)}`);
  if (h.board.length >= 3) lines.push(`У вас: ${best5([...mine, ...h.board]).name}`);
  if (p?.folded) lines.push('Вы сбросили.');
  return lines.join('\n');
}
