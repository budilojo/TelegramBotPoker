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
import { results as tally } from '../../../server/game.js';
import pokerBot, { decidePoker } from './bot.js';
import * as S from './school.js';

/** What the page may ask for at a poker table, and nothing else. */
const ACTIONS = new Set([
  'sit', 'leave', 'start', 'act', 'next', 'settings', 'role', 'kick', 'rebuy', 'host',
  'pause', 'resume', 'undo', 'finish', 'pick', 'potNext', 'potBack', 'confirm', 'learn',
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
  SOLO_ONLY: 'В игре с ботами этого нет: здесь только ходы, пауза и завершение.',
};

/** За столом с ботами человек играет, а не правит стол: ни настроек, ни докупок, ни удалений. */
const SOLO_ACTIONS = new Set(['start', 'act', 'next', 'pause', 'resume', 'finish', 'learn']);

/**
 * Стол с ботами: что можно выбрать в форме. Страница присылает выбор, но
 * ей не верим — принимается только значение из этих наборов, остальное
 * становится умолчанием (10.000 фишек, 50/100, блайнды растут).
 */
const SOLO_BLINDS = [[25, 50], [50, 100], [100, 200], [200, 400]];
const SOLO_STACKS = [5000, 10000, 20000];
const SOLO_DEFAULT = { bb: 100, stack: 10000, grow: 'on' };
/** С ботами блайнды растут раз в 10 минут. */
const SOLO_LEVEL_MINUTES = 10;

function soloSettings(raw = {}) {
  // Школа: стол наставника всегда один и тот же — урок это одна раздача.
  if (raw.learn) return { startingStack: 10000, smallBlind: 50, bigBlind: 100, turnSeconds: 0, blindMode: 'fixed' };
  const [smallBlind, bigBlind] = SOLO_BLINDS.find(([, bb]) => bb === raw.bb) || SOLO_BLINDS.find(([, bb]) => bb === SOLO_DEFAULT.bb);
  const startingStack = SOLO_STACKS.includes(raw.stack) ? raw.stack : SOLO_DEFAULT.stack;
  const grow = raw.grow === 'off' ? 'off' : SOLO_DEFAULT.grow;
  return {
    startingStack, smallBlind, bigBlind, turnSeconds: 0,
    ...(grow === 'on' ? { blindMode: 'levels', levelMinutes: SOLO_LEVEL_MINUTES } : { blindMode: 'fixed' }),
  };
}

/**
 * Боты покера и «Школа покера». В школе за столом один соперник —
 * наставник: в уроках он ходит по сценарию урока (сценарий не смотрит в
 * карты человека), в свободной игре — как спокойный крепкий игрок.
 */
const bot = {
  ...pokerBot,
  catalog: () => ({
    ...pokerBot.catalog(),
    school: S.LESSONS.map((l) => ({ title: l.title, goal: l.goal })),
    table: { blinds: SOLO_BLINDS, stacks: SOLO_STACKS, ...SOLO_DEFAULT },
  }),
  settings: soloSettings,
  /** Как назвать партию на экране «Игры с ботами» (кнопка «Продолжить»). */
  label: (room) => (room.learn ? 'Школа покера' : null),
  lineup: (raw = {}, rng) => (raw.learn ? [{ type: 'coach', level: 1 }] : pokerBot.lineup(raw, rng)),
  seat(room, spec, i) {
    if (spec.type !== 'coach') return pokerBot.seat(room, spec, i);
    const p = R.addPlayer(room, { id: S.COACH_ID, tgId: 0, name: S.COACH_NAME, dm: null });
    if (!p.error) p.bot = { ...spec };
    return p;
  },
  /** Школа: запомнить урок до первой раздачи — её карты подстроены под урок. */
  prepare(room, raw = {}) {
    if (!raw.learn) return;
    const n = Math.round(Number(raw.lesson));
    room.learn = { lesson: Number.isFinite(n) ? Math.max(0, Math.min(S.FREE, n)) : 0, acts: [], result: null, judged: null, stackAt: room.settings.startingStack };
  },
  decide(args) {
    if (args.room.learn) return S.coachMove(args.room, args.view) || decidePoker(args.view, { type: 'tag', level: 1 }, args.rng);
    return pokerBot.decide(args);
  },
};

/**
 * Следующий урок (или тот же ещё раз): у обоих снова полный стек, карты —
 * под урок. Только между раздачами.
 */
function dealLesson(app, room, uid, lesson) {
  if (room.hand && room.hand.phase !== 'complete') return { error: 'HAND_IN_PROGRESS' };
  room.learn.lesson = Math.max(0, Math.min(S.FREE, lesson));
  room.learn.acts = [];
  room.learn.result = null;
  if (room.status === 'paused') room.status = 'playing';
  for (const p of room.players) p.stack = room.settings.startingStack;
  room.learn.stackAt = room.settings.startingStack;
  return R.nextHand(room, uid, app.dealOpts(room));
}

/**
 * Игра с ботами кончается, когда у человека кончились фишки: смотреть, как
 * боты доигрывают между собой, незачем. Только между раздачами — карты
 * текущей раздачи досматриваются до конца.
 */
function soloBust(room) {
  if (!room.solo || room.status !== 'playing' || room.hand?.phase !== 'complete') return;
  const me = room.players.find((p) => p.id === room.solo.owner);
  if (me && me.stack <= 0 && !me.topUp) R.endGame(room, me.id);
}

/** Как часто растут блайнды у нового стола, минут. */
const DEFAULT_LEVEL_MINUTES = 15;

/** Numbers the hub may pass when it creates a table. The room layer clamps them. */
function settingsPatch(msg = {}) {
  const patch = {};
  for (const k of ['startingStack', 'smallBlind', 'bigBlind', 'turnSeconds']) {
    if (msg[k] != null && Number.isFinite(Number(msg[k]))) patch[k] = Number(msg[k]);
  }
  if (msg.cards === 'live' || msg.cards === 'virtual') patch.cards = msg.cards;
  // Рост блайндов: «fixed» — стоят, «levels» — растут по лестнице каждые N минут.
  if (msg.blindMode === 'levels' || msg.blindMode === 'fixed') patch.blindMode = msg.blindMode;
  if (msg.levelMinutes != null && Number.isFinite(Number(msg.levelMinutes))) patch.levelMinutes = Number(msg.levelMinutes);
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
  bot,

  create({ chatId, title, host, settings = null }) {
    const room = R.createRoom({ chatId, title, host });
    room.game = 'poker';
    // Новые столы — с растущими блайндами (раз в 15 минут), если хозяин не
    // сказал иначе: иначе партия «зависает» на одних и тех же ставках.
    const patch = { blindMode: 'levels', levelMinutes: DEFAULT_LEVEL_MINUTES, ...settingsPatch(settings || {}) };
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
    const v = { game: 'poker', ...tableView(room, viewerId, ctx) };
    if (room.learn && String(viewerId) === room.solo?.owner) {
      v.learn = S.learnView(room, v);
      if (S.lessonOf(room)) v.canNext = false; // после урока — «Дальше» или «Ещё раз», а не просто раздача
    }
    return v;
  },

  /** Карты урока подстроены; в свободной игре и за обычным столом — как всегда. */
  dealOpts(room) {
    if (!room.learn || !S.lessonOf(room)) return null;
    return { deck: () => S.lessonDeck(room, room.solo.owner) };
  },

  card: (room, opts) => renderCard(room, opts),
  results: (room) => renderResults(room),

  /**
   * Для рейтинга покерный вечер — одна партия, а не каждая раздача: иначе
   * очки шли бы за усидчивость. Места по итогу вечера, размер стека на очки
   * не влияет — иначе один вечер с большими блайндами перевесит десять
   * обычных. Кто ушёл или удалён, не получает ничего: он не доиграл.
   */
  rounds(room) {
    if (room.status !== 'finished') return [];
    const byId = new Map(room.players.map((p) => [p.id, p]));
    const players = tally(room)
      .filter((r) => r.role !== 'dealer' && r.handsPlayed > 0)
      // Ушедший из группы остаётся в местах со своим стеком (аудит D-02: иначе
      // выход перед концом спасал от −10). Удалённого хостом в местах нет.
      .filter((r) => !byId.get(r.id)?.kicked)
      .sort((a, b) => b.net - a.net || b.stack - a.stack);
    if (players.length < 2) return [];
    return [{
      id: room.code,
      aborted: false,
      loserId: players.at(-1).id,
      places: players.map((r) => ({ id: r.id, name: r.name })),
    }];
  },

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

  /** Обслуживание: часы уровня блайндов стоят вместе с часами хода. */
  freeze: (room, on) => R.parkLevelClock(room, on),
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
    if (room.solo && !SOLO_ACTIONS.has(msg.t)) return refuse('SOLO_ONLY');
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
        if (room.learn) {
          S.noteAct(room, uid, action);
          S.judge(room);
        }
        soloBust(room);
        return app.afterAction(room);
      }

      // Школа: «Ещё раз», «Дальше» или урок по номеру.
      case 'learn': {
        if (!room.learn) return refuse('BAD_REQUEST');
        const cur = room.learn.lesson;
        const lesson = msg.step === 'next' ? cur + 1 : msg.step === 'retry' ? cur : Math.round(Number(msg.lesson));
        if (!Number.isFinite(lesson)) return refuse('BAD_REQUEST');
        const r = dealLesson(app, room, uid, lesson);
        if (fail(r)) return;
        return app.afterDeal(room, r);
      }

      case 'next': {
        if (room.learn) {
          // После урока — «Дальше» или «Ещё раз» (learn); просто раздача — в свободной игре.
          if (S.lessonOf(room)) return refuse('BAD_REQUEST');
          room.learn.acts = [];
        }
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

      case 'finish': {
        const r = R.endGame(room, uid);
        // Уже завершена: итоги в группе есть, второй раз их не публикуем.
        if (fail(r) || r.noop) return;
        return app.finishUp(room);
      }

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
