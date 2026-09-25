'use strict';
/**
 * Poker as one game of the hub.
 *
 * The poker itself did not move: the rules, the deal, what each player sees
 * and the texts for Telegram are still `room.js`, `cards.js`, `view.js` and
 * `render.js`, under the 254 tests that pinned them down. This file is the
 * adapter that lets the core (app.js, hub.js) run poker without knowing a
 * thing about it — and it is where the poker-only parts of the old core went,
 * unchanged: the moves the Mini App may send, the all-in board turned over
 * street by street, the turn timer and the automatic deal.
 */
import * as R from '../../room.js';
import { tableView } from '../../view.js';
import { renderCard, renderResults, renderTurnPing } from '../../render.js';
import { num } from '../../fmt.js';

/** What the page may ask for at a poker table, and nothing else. */
const ACTIONS = new Set([
  'sit', 'leave', 'start', 'act', 'next', 'settings', 'role', 'kick', 'rebuy', 'host',
  'pause', 'resume', 'undo', 'finish', 'pick', 'potNext', 'potBack', 'confirm',
]);

/** Error codes in words a person can act on. Kept short: they show as a toast. */
export const ERRORS = {
  NOT_HOST: 'Это может только хост.',
  NOT_SEATED: 'Сначала сядьте за стол.',
  KICKED: 'Хост удалил вас из этой игры.',
  TABLE_FULL: 'За столом нет мест.',
  NOT_YOUR_TURN: 'Сейчас не ваш ход.',
  STALE: 'Стол уже изменился — посмотрите ещё раз.',
  NOT_ENOUGH_PLAYERS: 'Нужно минимум два игрока с фишками.',
  NOT_ENOUGH_CHIPS: 'Не хватает фишек.',
  BELOW_MIN_RAISE: 'Меньше минимального повышения.',
  CANNOT_CHECK: 'Чек нельзя — перед вами ставка.',
  CANNOT_CALL: 'Коллировать нечего.',
  CANNOT_BET: 'Ставку сейчас сделать нельзя.',
  CANNOT_RAISE: 'Повышать нельзя: короткий олл-ин не открыл торговлю заново.',
  BAD_AMOUNT: 'Некорректная сумма.',
  GAME_PAUSED: 'Игра на паузе.',
  GAME_FINISHED: 'Игра завершена.',
  NOT_PLAYING: 'Игра ещё не началась.',
  ALREADY_STARTED: 'Игра уже идёт.',
  HAND_IN_PROGRESS: 'Раздача ещё идёт.',
  DEALER_DECIDES: 'Победителя отмечает дилер.',
  DEALER_DEALS: 'Следующую раздачу начинает дилер.',
  NOT_ELIGIBLE: 'Этот игрок не претендует на этот банк.',
  NO_WINNER_SELECTED: 'Сначала отметьте победителя.',
  NOT_LIVE: 'Дилер нужен только для игры настоящими картами.',
  NOTHING_TO_UNDO: 'Отменять нечего. Ставки и раздачи не отменяются.',
  CANNOT_KICK_HOST: 'Хоста удалить нельзя — сначала передайте права.',
  NO_PLAYER: 'Игрок не найден.',
  NOT_LEVELS: 'Растущие блайнды выключены.',
  BAD_STEP: 'Сейчас этот шаг недоступен.',
  BAD_POT: 'Этот банк не требует решения.',
  BAD_REQUEST: 'Не понял запрос.',
};

/** Numbers the hub may pass when it creates a table. The room layer clamps them. */
function settingsPatch(msg = {}) {
  const patch = {};
  for (const k of ['startingStack', 'smallBlind', 'bigBlind', 'turnSeconds']) {
    if (msg[k] != null && Number.isFinite(Number(msg[k]))) patch[k] = Number(msg[k]);
  }
  if (msg.cards === 'live' || msg.cards === 'virtual') patch.cards = msg.cards;
  return patch;
}

/* ------------------------------------------------------ the all-in board */

/**
 * An all-in before the river: the board was dealt out to five cards in one
 * go, and the pot is already paid. What remains is to SHOW it the way a
 * table does — flop, turn, river — one step every `runoutStepMs`.
 *
 * Runs on timers, never on a sleep: grammY hands the bot one update at a
 * time, and a four-second sleep inside a handler would freeze every other
 * chat the bot is in.
 *
 * @returns true when a reveal started (and will finish the job itself)
 */
function startReveal(app, room) {
  const h = room.hand;
  if (!app.runoutStepMs || !h || h.phase !== 'complete' || h.runoutFrom == null || h.runoutShown) return false;
  h.runoutShown = true;
  room.ui.reveal = { handNo: h.no, shown: h.runoutFrom };
  scheduleReveal(app, room.code, h.no);
  return true;
}

function scheduleReveal(app, code, handNo) {
  app.after(`reveal:${code}`, `reveal:${handNo}`, app.runoutStepMs, () => revealStep(app, code, handNo));
}

async function revealStep(app, code, handNo) {
  const room = app.roomByCode(code);
  const r = room?.ui?.reveal;
  // Superseded — a new hand, /finish, a restart: the final view is already up.
  if (!r || r.handNo !== handNo || room.hand?.no !== handNo) return;
  const next = r.shown < 3 ? 3 : r.shown + 1;
  if (next >= 5) {
    // The river comes with the result: that frame IS the showdown.
    room.ui.reveal = null;
    if (room.status === 'finished') await app.finishUp(room);
    else await app.draw(room);
    app.syncClocks(); // the automatic deal counts from here
    return;
  }
  r.shown = next;
  await app.draw(room);
  scheduleReveal(app, code, handNo);
}

/* ------------------------------------------------------------ the clocks */

/**
 * The clock ran out on somebody. `key` names the exact turn it was armed
 * for; if they moved in the meantime, the room layer refuses and nothing
 * happens.
 */
async function onTurnTimeout(app, code, key) {
  const room = app.roomByCode(code);
  if (!room) return;
  const r = R.timeoutMove(room, key, app.clock.now());
  if (!r.error) await app.afterAction(room);
  app.syncClocks(); // a timer that woke a hair early is simply re-armed
}

async function onAutoNext(app, code, key) {
  const room = app.roomByCode(code);
  if (!room) return;
  const r = R.autoNextHand(room, key, app.clock.now(), app.dealOpts(room));
  if (!r.error) await app.afterDeal(room, r);
  else if (r.error === 'NOT_ENOUGH_PLAYERS') await app.draw(room);
  app.syncClocks();
}

/* ---------------------------------------------------------------- module */

export default {
  id: 'poker',
  title: 'Покер',
  icon: '♠️',
  blurb: 'Техасский холдем, фишки',
  minPlayers: 2,
  maxPlayers: R.MAX_SEATS,
  errors: ERRORS,

  create({ chatId, title, host, settings = null }) {
    const room = R.createRoom({ chatId, title, host });
    room.game = 'poker';
    const patch = settingsPatch(settings || {});
    if (Object.keys(patch).length) {
      R.updateSettings(room, room.hostId, patch);
      room.undo = []; // a table's first settings are not the host's to "undo"
      room.notice = null;
    }
    return room;
  },

  serialize: (room, now) => R.serialize(room, now),

  deserialize(data) {
    const room = R.deserialize(data);
    room.game = 'poker';
    return room;
  },

  view(room, viewerId, ctx) {
    return { game: 'poker', ...tableView(room, viewerId, ctx) };
  },

  card: (room, opts) => renderCard(room, opts),
  results: (room) => renderResults(room),

  /** Who the table is waiting for — the one player on the clock. */
  waiting(room) {
    const key = room.status === 'playing' ? R.turnKey(room) : null;
    return key ? [{ id: room.hand.actorId, key }] : [];
  },
  pingText: (room, p) => renderTurnPing(room, p),

  /** One line for the hub's list of games in the group. */
  summary(room) {
    const seated = room.players.filter((p) => !p.kicked && !p.left && R.roleOf(p) === 'player');
    const s = room.settings;
    return {
      seated: seated.length,
      max: R.MAX_SEATS,
      names: seated.map((p) => p.name),
      detail: `блайнды ${num(s.smallBlind)}/${num(s.bigBlind)}`,
    };
  },

  markLeft: (room, userId) => R.markLeft(room, userId),
  endGame: (room, userId) => R.endGame(room, userId),

  /** The all-in board: shown on the table's own clock, and it ends the hand itself. */
  beginShow: (app, room) => startReveal(app, room),
  onFinish(room) {
    room.ui.reveal = null; // the final word is the whole board, not a frame of it
  },
  onMigrate(room) {
    room.ui.reveal = null; // its timer is keyed by the old card and will find nothing
  },

  /**
   * The turn timer and the automatic deal. The room layer works out what
   * should be running; the core makes the real timers match.
   */
  clocks(app, room, now) {
    const code = room.code;
    const turn = R.syncTurn(room, now);
    const next = R.syncAutoNext(room, now);
    return [
      { id: 'turn', timer: turn, fire: () => onTurnTimeout(app, code, turn.key) },
      { id: 'next', timer: next, fire: () => onAutoNext(app, code, next.key) },
      { id: 'reveal', keep: true },
    ];
  },

  /**
   * One message from one page. The identity is `ctx.uid` — from the verified
   * initData, never from the message. Returns when the room and everything
   * that follows from the move (group card, timers, reveal) is taken care of.
   */
  async handle({ app, session, room, uid, msg, refuse, push }) {
    if (!ACTIONS.has(msg.t)) return refuse('BAD_REQUEST');
    const target = () => {
      const p = room.players[Number(msg.seat)];
      return Number.isInteger(Number(msg.seat)) && p ? p : null;
    };
    const fail = (r) => (r?.error ? (refuse(r.error), true) : false);

    switch (msg.t) {
      case 'sit': {
        if (room.status === 'finished') return refuse('GAME_FINISHED');
        const p = R.addPlayer(room, app.person(session.user));
        if (fail(p)) return;
        return app.afterChange(room);
      }

      case 'leave':
        if (fail(R.sitOut(room, uid, true))) return;
        return app.afterAction(room);

      case 'start': {
        const r = R.startGame(room, uid, app.dealOpts(room));
        if (fail(r)) return;
        return app.afterDeal(room, r);
      }

      case 'act': {
        const action = String(msg.action || '');
        if (!['fold', 'check', 'call', 'bet', 'raise', 'allin'].includes(action)) return refuse('BAD_REQUEST');
        const amount = msg.amount == null ? null : Number(msg.amount);
        const seq = Number.isInteger(msg.seq) ? msg.seq : undefined;
        if (fail(R.act(room, uid, action, amount, seq))) return push();
        return app.afterAction(room);
      }

      case 'next': {
        const r = R.nextHand(room, uid, app.dealOpts(room));
        if (fail(r)) return;
        return app.afterDeal(room, r);
      }

      case 'settings': {
        if (fail(R.updateSettings(room, uid, settingsPatch(msg)))) return;
        return app.afterChange(room);
      }

      case 'role': {
        const p = target();
        if (!p) return refuse('NO_PLAYER');
        if (fail(R.setRole(room, uid, p.id, msg.role === 'dealer' ? 'dealer' : 'player'))) return;
        return app.afterChange(room);
      }

      case 'kick': {
        const p = target();
        if (!p) return refuse('NO_PLAYER');
        if (fail(R.kickPlayer(room, uid, p.id))) return;
        return app.afterAction(room);
      }

      case 'rebuy': {
        const p = target();
        if (!p) return refuse('NO_PLAYER');
        if (fail(R.adjustStack(room, uid, p.id, room.settings.startingStack))) return;
        return app.afterChange(room);
      }

      case 'host': {
        const p = target();
        if (!p) return refuse('NO_PLAYER');
        if (fail(R.transferHost(room, uid, p.id))) return;
        return app.afterChange(room);
      }

      case 'pause':
      case 'resume':
        if (fail(R.setPaused(room, uid, msg.t === 'pause'))) return;
        return app.afterChange(room);

      case 'undo':
        if (fail(R.undo(room, uid))) return;
        return app.afterChange(room);

      case 'finish':
        if (fail(R.endGame(room, uid))) return;
        return app.finishUp(room);

      case 'pick': {
        const r = R.toggleWinner(room, uid, Number(msg.pot), Number(msg.seat));
        if (fail(r)) return;
        return app.afterChange(room);
      }
      case 'potNext':
      case 'potBack': {
        const r = msg.t === 'potNext' ? R.winnerNext(room, uid) : R.winnerBack(room, uid);
        if (fail(r)) return;
        return app.afterChange(room);
      }
      case 'confirm': {
        const r = R.confirmWinners(room, uid, Number.isInteger(msg.seq) ? msg.seq : undefined);
        if (fail(r)) return push();
        return app.afterAction(room);
      }
      default:
        return refuse('BAD_REQUEST');
    }
  },
};
