'use strict';
/**
 * The bot's brain. Takes normalised Telegram updates, decides what is allowed,
 * mutates the room, redraws the table, sends the cards. Knows nothing about
 * long polling or webhooks, and talks to Telegram only through an injected
 * `api` port — which is why the whole thing can be tested without a network.
 *
 * THE TWO RULES THIS FILE EXISTS TO ENFORCE:
 *
 * 1. Nobody ever acts for somebody else. A button in a group chat is visible
 *    to everyone and can be pressed by everyone, and a command can be typed
 *    by anyone, so neither is a permission. Every press and every command is
 *    re-checked here against `from.id`, which Telegram signs and a client
 *    cannot forge.
 * 2. Nobody ever sees somebody else's cards. Hole cards leave the bot in
 *    exactly two ways: a private message to `chat_id = owner's Telegram id`,
 *    and a callback answer — a popup Telegram shows only to the person who
 *    pressed. The group sees the board, and at showdown the hands that must
 *    be shown — pot winners and all-ins. Nothing else.
 *
 * The one move the bot makes in somebody's place is the turn timer's, and
 * only because the host switched it on: a free check, or a fold. Never chips.
 *
 * Note on ordering: every mutation that moves a chip or a card happens
 * synchronously, before the first `await`. Two updates that arrive in the
 * same tick therefore cannot interleave inside one, and the second sees the
 * bumped `seq`. (The only state touched between awaits is the display-only
 * "can we write to them" flag while the private messages go out.)
 */
import { legalActions } from '../server/game.js';
import { identify } from './identity.js';
import { decode, argInt, NS } from './cb.js';
import * as R from './room.js';
import {
  renderRoom, renderResults, renderKick, renderRebuy, renderTransfer, renderHole, dmLink,
} from './render.js';
import { peekText, holeOf, cardsText } from './cards.js';
import { Outbox } from './outbox.js';
import { NullStore } from './store.js';
import { esc, num } from './fmt.js';

const HELP = [
  '♠️ <b>Покер в чате</b> — техасский холдем. Бот тасует и сдаёт, карты приходят в личку, ставки — здесь.',
  '',
  '<b>/newgame</b> — создать стол · <b>/join</b> — сесть · <b>/leave</b> — встать',
  '',
  '<b>Ход:</b> /check · /call · /fold · /raise 300 · /bet 200 · /allin',
  '<i>/raise 300 — поднять ДО 300: столько всего будет стоять перед вами на этой улице.</i>',
  '/next — следующая раздача · /table — показать стол',
  '',
  '<b>Хост:</b> /stack 10000 · /blinds 25 50 · /levels 20 · /rebuy · /kick · /host · ' +
    '/level · /pause · /resume · /undo · /finish · /cancel',
  '<b>/timer 60</b> — таймер хода: не успел — чек или фолд, раздачи идут сами. /timer off — выключить.',
  '',
  'Бот не может написать первым: чтобы карты приходили в личку, один раз нажмите Start у бота.',
].join('\n');

const HELP_DM = [
  '♠️ <b>Покер в чате</b>',
  '',
  'Сюда приходят ваши карты. Сама игра — в группе: добавьте меня туда и напишите /newgame.',
  '/cards — показать ваши карты в текущих раздачах.',
].join('\n');

const WELCOME_DM = '✅ Готово: карты будут приходить сюда. Возвращайтесь в группу.';

/** The real clock. Tests pass a fake one and move time by hand. */
const REAL_CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

export class App {
  /**
   * @param deck          test seam: `(room) => number[52]` — a stacked deck.
   *                      Production leaves it out: every hand is shuffled with
   *                      crypto.randomInt.
   * @param clock         `{ now, setTimeout, clearTimeout }` — the turn timer,
   *                      the automatic deal and the board reveal all run on it
   * @param runoutStepMs  pause between streets when an all-in board is turned
   *                      over; 0 shows the whole board at once
   */
  constructor({
    api, store = new NullStore(), minIntervalMs = 1000, botUsername = '', onError = null, deck = null,
    clock = REAL_CLOCK, runoutStepMs = 1500,
  } = {}) {
    this.api = api;
    this.store = store;
    this.botUsername = botUsername;
    this.deck = deck;
    this.clock = clock;
    this.runoutStepMs = runoutStepMs;
    /** `${kind}:${chatId}` -> { key, deadline, h } — every timer the bot holds */
    this.handles = new Map();
    this.log = onError || ((err) => console.error('[bot]', err?.description || err?.message || err));
    this.outbox = new Outbox(api, { minIntervalMs, onError: this.log });
    /** @type {Map<string, object>} */
    this.rooms = new Map();
    /** `${chatId}:${userId}` -> Telegram date of that user's last applied typed move */
    this.lastTyped = new Map();
  }

  /* ---------------------------------------------------------- persistence */

  load() {
    for (const { chatId, data } of this.store.loadAll()) {
      try {
        this.rooms.set(String(chatId), R.deserialize(data));
      } catch (err) {
        this.log(err);
      }
    }
    return this.rooms.size;
  }

  save(room) {
    try {
      this.store.save(room, R.serialize(room, this.clock.now()));
    } catch (err) {
      this.log(err);
    }
  }

  /** After a restart: redraw every live table so play resumes where it stopped. */
  async resume() {
    this.syncClocks(); // timers come back with the time that was LEFT, not less
    let drawn = 0;
    for (const room of this.rooms.values()) {
      if (room.status === 'finished') continue;
      try {
        // Staggered: the global ceiling is ~30 messages a second, and a bot
        // running a dozen groups would otherwise redraw them all at once.
        if (drawn++) await new Promise((r) => setTimeout(r, 50));
        await this.draw(room, { immediate: true });
      } catch (err) {
        this.log(err);
      }
    }
    return drawn;
  }

  /* -------------------------------------------------------------- drawing */

  /**
   * Schedule a redraw of the table message (coalesced, latest state wins).
   *
   * If the table has been buried — somebody typed a command, the bot replied
   * — the new state is posted at the bottom and the old copy deleted; an edit
   * three screens up is an edit nobody sees. With buttons only, nothing moves
   * and the message is edited in place.
   */
  draw(room, { immediate = false } = {}) {
    this.syncClocks(); // the table shows the turn deadline: set it before drawing
    const produce = async () => {
      const view = renderRoom(room, { botUsername: this.botUsername });
      const kbKey = JSON.stringify(view.keyboard?.length ? { inline_keyboard: view.keyboard } : null);
      const unchanged = room.ui.lastText === view.text && room.ui.lastKb === kbKey;
      const buried = !!room.ui.tableMessageId && (room.ui.lastMsgId || 0) - room.ui.tableMessageId >= 2;
      await this.outbox.draw(room, view, { move: buried && !unchanged });
      this.seen(room, room.ui.tableMessageId);
      this.save(room);
    };
    if (immediate) return produce();
    this.outbox.schedule(room.chatId, produce);
    return Promise.resolve();
  }

  /** Remember the newest message id in a chat — the measure of "buried". */
  seen(room, messageId) {
    if (room && Number.isFinite(messageId)) room.ui.lastMsgId = Math.max(room.ui.lastMsgId || 0, messageId);
  }

  /**
   * One table message per hand: the finished hand stays in the chat as its
   * own record, and the new one lands at the bottom where people are looking.
   */
  async newTableMessage(room) {
    this.outbox.cancel(room.chatId);
    const old = room.ui.tableMessageId;
    if (old) await this.outbox.dropKeyboard(room.chatId, old);
    room.ui.tableMessageId = null;
    room.ui.lastText = null;
    room.ui.lastKb = null;
    await this.draw(room, { immediate: true });
    this.save(room);
  }

  /** Test seam: wait until every coalesced redraw has actually gone out. */
  settle() {
    return this.outbox.drain();
  }

  /* ------------------------------------------------------------ the cards */

  /** `{ deck }` for the room layer: stacked in tests, shuffled otherwise. */
  dealOpts(room) {
    return this.deck ? { deck: () => this.deck(room) } : {};
  }

  /**
   * A new hand was dealt: send every player their two cards, privately, then
   * put the table up. Cards first, so that whoever is first to act already
   * has them when the table appears.
   *
   * A private message only ever goes to `p.tgId` — the Telegram id the player
   * joined with — and only ever contains `holeOf(room, p.id)`: their own two.
   */
  async dealOut(room) {
    const h = room.hand;
    for (const p of room.players) {
      const text = renderHole(room, p.id);
      if (!text) continue;
      const r = await this.outbox.dm(p.tgId, text);
      if (r.ok) this.setDm(p.id, 'ok', { redraw: false });
      else if (r.forbidden) this.setDm(p.id, 'fail', { redraw: false });
      if (room.hand !== h) return; // the room moved on under us (should not happen)
    }
    await this.newTableMessage(room);
  }

  /**
   * Can the bot write to this person? Known from Start ('ok'), a bounced
   * delivery ('fail'), or Telegram telling us they blocked/unblocked the bot.
   */
  setDm(userId, status, { redraw = true } = {}) {
    const id = String(userId);
    if (this.store.getDm(id) !== status) this.store.setDm(id, status);
    for (const room of this.rooms.values()) {
      const p = R.findPlayer(room, id);
      if (!p || p.dm === status) continue;
      p.dm = status;
      if (redraw && room.status !== 'finished') this.draw(room);
    }
  }

  person(user) {
    return { id: user.id, tgId: user.tgId, name: user.name, dm: this.store.getDm(user.id) };
  }

  /* --------------------------------------------------------------- router */

  async handleUpdate(update) {
    try {
      if (update.callback_query) return await this.onCallback(update.callback_query);
      if (update.message) return await this.onMessage(update.message);
      if (update.my_chat_member) return await this.onMyChatMember(update.my_chat_member);
    } catch (err) {
      this.log(err);
      // A crash must never leave a spinner on somebody's button.
      if (update.callback_query) {
        await this.outbox.answer(update.callback_query.id, 'Ошибка. Попробуйте ещё раз.');
      }
    } finally {
      // Whatever just happened may have started a turn, ended one or ended a
      // hand: re-arm the timers from the state, not from what we think changed.
      this.syncClocks();
    }
  }

  /* --------------------------------------------------------------- clocks */

  /**
   * The turn timer and the automatic deal, for every table. Idempotent: the
   * room layer works out what should be running, this only makes the real
   * timers match — arming new ones, dropping ones nobody needs.
   */
  syncClocks() {
    const now = this.clock.now();
    const live = new Set();
    for (const room of this.rooms.values()) {
      const chatId = room.chatId;
      const turn = R.syncTurn(room, now);
      this.arm(`turn:${chatId}`, turn, () => this.onTurnTimeout(chatId, turn.key));
      const next = R.syncAutoNext(room, now);
      this.arm(`next:${chatId}`, next, () => this.onAutoNext(chatId, next.key));
      live.add(`turn:${chatId}`).add(`next:${chatId}`).add(`reveal:${chatId}`);
    }
    for (const [id, cur] of this.handles) {
      if (!live.has(id)) {
        this.clock.clearTimeout(cur.h);
        this.handles.delete(id);
      }
    }
  }

  arm(id, timer, fire) {
    const cur = this.handles.get(id);
    const deadline = timer?.deadline ?? null;
    if (cur && cur.key === timer?.key && cur.deadline === deadline) return;
    if (cur) this.clock.clearTimeout(cur.h);
    this.handles.delete(id);
    if (deadline == null) return;
    const h = this.clock.setTimeout(() => {
      this.handles.delete(id);
      return this.guard(fire);
    }, Math.max(0, deadline - this.clock.now()));
    this.handles.set(id, { key: timer.key, deadline, h });
  }

  /** A timer callback runs outside any update: it must never throw into the void. */
  async guard(fn) {
    try {
      await fn();
    } catch (err) {
      this.log(err);
    }
  }

  /** Stop every timer — shutdown, and the end of a test. */
  stop() {
    for (const cur of this.handles.values()) this.clock.clearTimeout(cur.h);
    this.handles.clear();
  }

  /**
   * The clock ran out on somebody. `key` names the exact turn it was armed
   * for; if they moved in the meantime, the room layer refuses and nothing
   * happens.
   */
  async onTurnTimeout(chatId, key) {
    const room = this.room(chatId);
    if (!room) return;
    const r = R.timeoutMove(room, key, this.clock.now());
    if (!r.error) await this.afterAction(room);
    this.syncClocks(); // a timer that woke a hair early is simply re-armed
  }

  async onAutoNext(chatId, key) {
    const room = this.room(chatId);
    if (!room) return;
    const r = R.autoNextHand(room, key, this.clock.now(), this.dealOpts(room));
    if (!r.error) await this.afterDeal(room, r);
    else if (r.error === 'NOT_ENOUGH_PLAYERS') await this.draw(room);
    this.syncClocks();
  }

  /* --------------------------------------------------------- board reveal */

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
  startReveal(room) {
    const h = room.hand;
    if (!this.runoutStepMs || !h || h.phase !== 'complete' || h.runoutFrom == null || h.runoutShown) return false;
    h.runoutShown = true;
    room.ui.reveal = { handNo: h.no, shown: h.runoutFrom };
    this.scheduleReveal(room.chatId, h.no);
    return true;
  }

  scheduleReveal(chatId, handNo) {
    const id = `reveal:${chatId}`;
    const h = this.clock.setTimeout(() => {
      this.handles.delete(id);
      return this.guard(() => this.revealStep(chatId, handNo));
    }, this.runoutStepMs);
    this.handles.set(id, { key: `reveal:${handNo}`, deadline: null, h });
  }

  async revealStep(chatId, handNo) {
    const room = this.room(chatId);
    const r = room?.ui?.reveal;
    // Superseded — a new hand, /finish, a restart: the final view is already up.
    if (!r || r.handNo !== handNo || room.hand?.no !== handNo) return;
    const next = r.shown < 3 ? 3 : r.shown + 1;
    if (next >= 5) {
      // The river comes with the result: that frame IS the showdown.
      room.ui.reveal = null;
      if (room.status === 'finished') await this.finishUp(room);
      else await this.draw(room);
      this.syncClocks(); // the automatic deal counts from here
      return;
    }
    r.shown = next;
    await this.draw(room);
    this.scheduleReveal(chatId, handNo);
  }

  room(chatId) {
    return this.rooms.get(String(chatId)) || null;
  }

  /* ------------------------------------------------------------- messages */

  async onMessage(msg) {
    if (msg.chat?.type === 'private') return this.onPrivate(msg);

    const chatId = String(msg.chat.id);

    // A group promoted to a supergroup changes chat.id. Re-key the table or
    // it is silently lost the moment somebody upgrades the group.
    if (msg.migrate_to_chat_id) return this.migrate(chatId, String(msg.migrate_to_chat_id));

    if (msg.left_chat_member) return this.onLeft(chatId, msg.left_chat_member);
    if (msg.new_chat_members?.length) return this.onJoined(chatId, msg.new_chat_members);
    if (typeof msg.text !== 'string') return;

    const room = this.room(chatId);
    this.seen(room, msg.message_id);

    // A reply to our ForceReply prompt: the "custom amount" path.
    const pb = room?.ui?.pendingBet;
    if (pb && msg.reply_to_message && msg.reply_to_message.message_id === pb.promptMessageId) {
      return this.onAmountReply(room, msg, pb);
    }

    const cmd = parseCommand(msg.text, this.botUsername);
    if (!cmd) return;
    return this.onCommand(cmd, msg);
  }

  /**
   * The private chat. Pressing Start here is the one thing that lets the bot
   * send cards at all. Nothing typed here can seat anybody anywhere: the
   * deep-link payload is text the user controls, so it is not trusted to
   * name a table. Seats are taken in the group, where being able to press a
   * button already proves you are a member.
   */
  async onPrivate(msg) {
    const who = identify(msg.from, msg.sender_chat);
    if (!who.ok) return;
    const user = who.user;
    // Any private message means the chat is open.
    this.setDm(user.id, 'ok');

    const cmd = typeof msg.text === 'string' ? parseCommand(msg.text, this.botUsername) : null;
    if (cmd?.cmd === 'start') {
      await this.outbox.post(user.tgId, cmd.rest ? WELCOME_DM : `${WELCOME_DM}\n\n${HELP_DM}`);
      // Pressed Start in the middle of a hand whose cards bounced: deliver now.
      const live = this.myCards(user.id);
      if (live) await this.outbox.post(user.tgId, live);
      return;
    }
    if (cmd?.cmd === 'cards') {
      return void (await this.outbox.post(user.tgId, this.myCards(user.id) || 'Сейчас вы не в раздаче.'));
    }
    return void (await this.outbox.post(user.tgId, HELP_DM));
  }

  /** Every live hand this person holds cards in, or null — for private chat only. */
  myCards(userId) {
    const out = [];
    for (const room of this.rooms.values()) {
      const h = room.hand;
      const mine = holeOf(room, userId);
      if (!mine || !h || h.phase === 'complete' || room.status === 'finished') continue;
      const board = h.board?.length ? ` · борд ${cardsText(h.board)}` : '';
      out.push(`${room.title ? esc(room.title) + ': ' : ''}раздача #${h.no} — <b>${cardsText(mine)}</b>${board}`);
    }
    return out.length ? `🂠 Ваши карты:\n${out.join('\n')}` : null;
  }

  async onCommand(cmd, msg) {
    const chatId = String(msg.chat.id);
    const who = identify(msg.from, msg.sender_chat);

    if (cmd.cmd === 'start' || cmd.cmd === 'help') return void (await this.reply(chatId, HELP));
    if (!who.ok) return void (await this.reply(chatId, who.text, msg));

    const user = who.user;
    const room = this.room(chatId);

    switch (cmd.cmd) {
      case 'newgame': {
        if (room && room.status !== 'finished') {
          return void (await this.reply(
            chatId,
            `Стол уже создан, хост — ${esc(nameOf(room, room.hostId))}. ` +
              'Завершите его через /finish или /cancel, потом создавайте новый.'
          ));
        }
        const fresh = R.createRoom({ chatId, title: msg.chat.title, host: this.person(user) });
        this.rooms.set(chatId, fresh);
        await this.newTableMessage(fresh);
        return;
      }

      case 'join':
        if (!room) return void (await this.reply(chatId, 'Стола нет. /newgame'));
        return this.join(room, user, null, msg);

      case 'leave': {
        if (!room) return;
        const r = R.sitOut(room, user.id, true);
        if (r.error) return void (await this.reply(chatId, 'Вы не за столом.', msg));
        return this.afterAction(room);
      }

      case 'table': {
        if (!room) return void (await this.reply(chatId, 'Стола нет. /newgame'));
        await this.newTableMessage(room);
        return;
      }

      case 'check':
      case 'call':
      case 'fold':
      case 'bet':
      case 'raise':
      case 'allin':
        return this.onTypedMove(room, user, cmd, msg);

      case 'next':
      case 'deal': {
        if (!room) return void (await this.reply(chatId, 'Стола нет. /newgame'));
        const r = R.nextHand(room, user.id, this.dealOpts(room));
        if (r.error) return void (await this.reply(chatId, this.explain(room, r.error), msg));
        return this.afterDeal(room, r);
      }

      case 'cards':
        // Never in the group. Point to the two private ways instead.
        return void (await this.reply(
          chatId,
          'Карты — в личке у бота или кнопкой «🂠 Мои карты» под столом: её ответ видите только вы.',
          msg
        ));

      case 'stack':
      case 'blinds':
      case 'levels':
      case 'timer':
        return this.onSettings(cmd, room, user, chatId);

      case 'kick':
      case 'rebuy':
      case 'host': {
        if (!room) return;
        if (!R.isHost(room, user.id)) return void (await this.reply(chatId, this.hostOnly(room), msg));
        const v = { kick: renderKick, rebuy: renderRebuy, host: renderTransfer }[cmd.cmd](room);
        const m = await this.outbox.post(chatId, v.text, v.keyboard);
        this.seen(room, m?.message_id);
        return;
      }

      case 'level': {
        if (!room) return;
        const r = R.bumpLevel(room, user.id);
        if (r.error) return void (await this.reply(chatId, this.explain(room, r.error), msg));
        await this.reply(chatId, `⏫ ${esc(room.notice)}`);
        await this.draw(room);
        return;
      }

      case 'undo': {
        if (!room) return;
        const r = R.undo(room, user.id);
        if (r.error) return void (await this.reply(chatId, this.explain(room, r.error), msg));
        await this.reply(chatId, `↩️ Отменено: ${esc(r.label)}`);
        await this.draw(room);
        return;
      }

      case 'pause':
      case 'resume': {
        if (!room) return;
        const r = R.setPaused(room, user.id, cmd.cmd === 'pause');
        if (r.error) return void (await this.reply(chatId, this.explain(room, r.error), msg));
        await this.draw(room);
        return;
      }

      case 'finish': {
        if (!room) return void (await this.reply(chatId, 'Стола нет.'));
        const r = R.endGame(room, user.id);
        if (r.error) return void (await this.reply(chatId, this.explain(room, r.error), msg));
        await this.finishUp(room);
        return;
      }

      case 'cancel': {
        if (!room) return;
        if (!R.isHost(room, user.id)) return void (await this.reply(chatId, this.hostOnly(room), msg));
        if (room.ui.tableMessageId) await this.outbox.dropKeyboard(chatId, room.ui.tableMessageId);
        this.rooms.delete(chatId);
        this.store.remove(chatId);
        await this.reply(chatId, 'Стол удалён. /newgame — создать новый.');
        return;
      }
      default:
        return;
    }
  }

  /**
   * Sit down — by /join or by the button. Mid-game you are dealt in from the
   * next hand. If the bot cannot write to you yet, you are told how to fix
   * it; a button press goes one step further and opens the private chat.
   */
  async join(room, user, ans, msg) {
    if (room.status === 'finished') {
      return ans ? ans('Игра завершена.') : void (await this.reply(room.chatId, 'Игра завершена.', msg));
    }
    const before = R.findPlayer(room, user.id);
    const wasOut = before && (before.sittingOut || before.left);
    const p = R.addPlayer(room, this.person(user));
    if (p.error) {
      const t = 'Хост удалил вас из этой игры.';
      return ans ? ans(t, { alert: true }) : void (await this.reply(room.chatId, t, msg));
    }
    const needDm = p.dm !== 'ok';
    const midGame = room.status !== 'lobby';
    const status = before && !wasOut ? 'Вы уже за столом.' : midGame ? 'Вы сядете со следующей раздачи.' : 'Вы за столом.';

    if (ans) {
      // One tap: seated, and — if the bot cannot write to you — straight into
      // the private chat to press Start. A callback answer may open exactly
      // this kind of link: t.me/<bot>?start=...
      const link = dmLink(this.botUsername);
      if (needDm && link) await ans(`${status} Нажмите Start — туда придут карты.`, { url: link });
      else await ans(status);
    } else if (needDm || midGame) {
      const link = dmLink(this.botUsername);
      const text =
        `${esc(user.name)}: ${status.toLowerCase()}` +
        (needDm ? ' Чтобы карты приходили в личку, нажмите кнопку и Start.' : '');
      const kb = needDm && link ? [[{ text: '🔑 Карты в личку', url: link }]] : null;
      const m = await this.outbox.post(room.chatId, text, kb, { reply_parameters: replyTo(msg) });
      this.seen(room, m?.message_id);
    }
    return this.draw(room);
  }

  /* ------------------------------------------------------- typed moves */

  /**
   * /check /call /fold /bet N /raise N /allin — the same moves as the buttons,
   * through the same `R.act`, behind the same identity check.
   *
   * A typed command carries no `seq`, so the double-tap guard is different:
   * two identical commands sent within a second by the same person are one
   * intention sent twice. That matters in one spot — when your move closes a
   * street and you are first to act on the next, a duplicate /check would
   * check a flop you have not seen yet.
   */
  async onTypedMove(room, user, cmd, msg) {
    const chatId = String(msg.chat.id);
    const say = (text) => this.reply(chatId, text, msg);
    if (!room) return void (await say('Стола нет. /newgame'));
    const h = room.hand;
    if (room.status === 'paused') return void (await say('Игра на паузе.'));
    if (room.status !== 'playing' || !h) return void (await say('Игра ещё не началась.'));
    if (h.phase !== 'betting') return void (await say('Раздача закончена. /next — следующая.'));

    if (h.actorId !== user.id) {
      const actor = nameOf(room, h.actorId);
      return void (await say(R.findPlayer(room, user.id) ? `Сейчас ходит ${esc(actor)}.` : `Вы не за столом. Ходит ${esc(actor)}.`));
    }

    const key = `${chatId}:${user.id}`;
    const prev = this.lastTyped.get(key);
    if (prev != null && Number.isFinite(msg.date) && msg.date - prev <= 1) {
      return void (await say('Похоже на повтор — предыдущий ход уже применён. Посмотрите стол и повторите, если нужно.'));
    }

    const legal = legalActions(room, user.id);
    if (!legal) return void (await say('Сейчас так сходить нельзя.'));

    let action = cmd.cmd;
    let amount = null;
    if (action === 'call' && legal.canCheck) action = 'check'; // nothing to call: that is a check
    if (action === 'check' && !legal.canCheck) {
      return void (await say(`Чек нельзя — перед вами ставка. /call ${legal.callAmount} или /fold.`));
    }
    if (action === 'bet' || action === 'raise') {
      if (!legal.canBet && !legal.canRaise) {
        // Two different reasons, and the player needs to hear the right one.
        if (legal.stack <= legal.toCall) {
          return void (await say(`Фишек хватает только на колл: /call ${legal.callAmount} — это и будет олл-ин.`));
        }
        return void (await say(this.explain(room, 'CANNOT_RAISE')));
      }
      amount = amountArg(cmd.rest);
      const range = `от ${legal.minTotal} до ${legal.maxTotal}`;
      if (amount == null) {
        return void (await say(`Сколько? Например <code>/${cmd.cmd} ${legal.minTotal}</code> — сумма ${range}.`));
      }
      if (amount < legal.minTotal || amount > legal.maxTotal) {
        return void (await say(
          `Можно ${range}. /raise N — это сколько всего будет стоять перед вами на этой улице.`
        ));
      }
      // Lenient about the word, strict about the chips: /bet into a bet is a
      // raise to that total, /raise with nothing to raise is a bet.
      action = legal.canBet ? 'bet' : 'raise';
    }

    const r = R.act(room, user.id, action, amount);
    if (r.error) return void (await say(this.explain(room, r.error)));
    if (Number.isFinite(msg.date)) this.lastTyped.set(key, msg.date);
    return this.afterAction(room);
  }

  async onSettings(cmd, room, user, chatId) {
    if (!room) return void (await this.reply(chatId, 'Стола нет. /newgame'));
    if (!R.isHost(room, user.id)) return void (await this.reply(chatId, this.hostOnly(room)));

    let patch = null;
    if (cmd.cmd === 'stack') {
      const n = intArg(cmd.args[0]);
      if (n == null) return void (await this.reply(chatId, 'Например: /stack 10000'));
      if (room.status !== 'lobby')
        return void (await this.reply(chatId, 'Стартовый стек заморожен после старта — иначе итоговый P/L соврёт.'));
      patch = { startingStack: n };
    } else if (cmd.cmd === 'blinds') {
      const sb = intArg(cmd.args[0]);
      const bb = intArg(cmd.args[1]) ?? (sb != null ? sb * 2 : null);
      if (sb == null || bb == null) return void (await this.reply(chatId, 'Например: /blinds 25 50'));
      if (bb < sb) return void (await this.reply(chatId, 'Большой блайнд не может быть меньше малого.'));
      patch = { smallBlind: sb, bigBlind: bb };
    } else if (cmd.cmd === 'timer') {
      const raw = (cmd.args[0] || '').toLowerCase();
      if (raw === 'off' || raw === 'выкл' || raw === '0') patch = { turnSeconds: 0 };
      else {
        const n = intArg(raw);
        if (n == null || n < 15 || n > 600) {
          return void (await this.reply(chatId, 'Например: /timer 60 — от 15 до 600 секунд на ход. /timer off — выключить.'));
        }
        patch = { turnSeconds: n };
      }
    } else {
      const raw = (cmd.args[0] || '').toLowerCase();
      if (raw === 'off' || raw === 'выкл') patch = { blindMode: 'fixed' };
      else {
        const m = intArg(raw);
        if (m == null) return void (await this.reply(chatId, 'Например: /levels 20 или /levels off'));
        patch = { blindMode: 'levels', levelMinutes: m };
      }
    }

    const r = R.updateSettings(room, user.id, patch);
    if (r.error) return void (await this.reply(chatId, this.explain(room, r.error)));
    if (room.notice) await this.reply(chatId, `⚙️ ${esc(room.notice)}`);
    await this.draw(room);
  }

  /* ------------------------------------------------- custom bet amount */

  async onAmountReply(room, msg, pb) {
    const who = identify(msg.from, msg.sender_chat);
    await this.outbox.remove(room.chatId, msg.message_id); // keep the chat clean

    if (!who.ok) return void (await this.reply(room.chatId, who.text));
    // The prompt is addressed to one person; anybody else replying to it is
    // trying to bet for them.
    if (who.user.id !== pb.userId) {
      return void (await this.reply(room.chatId, `Эту ставку делает ${esc(nameOf(room, pb.userId))}.`));
    }

    const total = amountArg(msg.text);
    const legal = legalActions(room, who.user.id);
    if (!legal || !(legal.canBet || legal.canRaise)) {
      room.ui.pendingBet = null;
      await this.outbox.remove(room.chatId, pb.promptMessageId);
      return void (await this.reply(room.chatId, 'Момент упущен — сейчас так сходить нельзя.'));
    }
    if (total == null || total < legal.minTotal || total > legal.maxTotal) {
      return void (await this.reply(
        room.chatId,
        `Нужна сумма от ${num(legal.minTotal)} до ${num(legal.maxTotal)}. Ответьте на то же сообщение ещё раз.`
      ));
    }

    room.ui.pendingBet = null;
    const verb = legal.canBet ? 'bet' : 'raise';
    const r = R.act(room, who.user.id, verb, total, room.seq);
    await this.outbox.remove(room.chatId, pb.promptMessageId);
    if (r.error) return void (await this.reply(room.chatId, this.explain(room, r.error)));
    await this.afterAction(room);
  }

  /* ------------------------------------------------------------ callbacks */

  async onCallback(cq) {
    const ans = (text, opts) => this.outbox.answer(cq.id, text, opts);

    // 1. WHO pressed it. Anonymous admins are refused here and nowhere else.
    // Only `cq.from` matters: a callback_query has no sender_chat of its own,
    // and `cq.message.sender_chat` describes whoever posted the message the
    // button sits on — in a channel's discussion group that is the channel,
    // which would refuse every real player at the table.
    const who = identify(cq.from);
    if (!who.ok) return ans(who.text, { alert: true });

    const parsed = decode(cq.data);
    if (!parsed) return ans('Кнопка не распознана.');

    const chatId = String(cq.message?.chat?.id ?? '');
    const room = this.room(chatId);
    if (!room) return ans('Стол не найден. /newgame');

    const user = who.user;
    switch (parsed.ns) {
      case NS.CARDS: return this.cbPeek(room, user, ans);
      case NS.LOBBY: return this.cbLobby(room, user, parsed, ans);
      case NS.ACT:   return this.cbAction(room, user, parsed, ans);
      case NS.GAME:  return this.cbGame(room, user, parsed, ans);
      case NS.HOST:  return this.cbHost(room, user, parsed, ans, cq);
      default:       return ans('Неизвестная кнопка.');
    }
  }

  /**
   * "🂠 Мои карты". The answer is a popup that Telegram shows ONLY to the
   * person who pressed, and it is computed from `from.id` — so pressing
   * somebody else's copy of the button still shows you your own cards.
   */
  cbPeek(room, user, ans) {
    return ans(peekText(room, user.id), { alert: true });
  }

  async cbLobby(room, user, { verb }, ans) {
    if (verb === 'sit') return this.join(room, user, ans);
    if (verb === 'leave') {
      const r = R.sitOut(room, user.id, true);
      await ans(r.error ? 'Вы и так не за столом.' : 'Вы встали из-за стола.');
      if (!r.error) await this.afterAction(room);
      return;
    }
    return ans('');
  }

  /**
   * A betting action. Three gates, in this order: is it a hand, is it YOUR
   * turn, is the button fresh. The refusal is always spoken out loud —
   * silently ignoring a press makes people think the bot has hung.
   */
  async cbAction(room, user, { verb, seq, args }, ans) {
    const h = room.hand;
    if (!h || h.phase !== 'betting') return ans('Сейчас не идёт торговля.');
    if (room.status === 'paused') return ans('Игра на паузе.');

    if (h.actorId !== user.id) {
      // A button carrying an old `seq` is a leftover from a state that has
      // already passed — most often your own second tap, after which the
      // clock moved on. Saying "it is X's turn" there is true but misleading:
      // the press did not fail, it simply arrived after its own effect.
      if (seq !== room.seq) return ans('Уже применено.');
      const actor = nameOf(room, h.actorId);
      return ans(R.findPlayer(room, user.id) ? `Сейчас ходит ${actor}.` : `Вы не за столом. Ходит ${actor}.`);
    }

    if (verb === 'allin') {
      // A stray tap must not cost somebody their whole stack.
      room.ui.armedAllIn = { userId: user.id };
      await ans('Нажмите ещё раз, чтобы подтвердить ALL-IN.');
      return this.draw(room);
    }
    if (verb === 'allincancel') {
      room.ui.armedAllIn = null;
      await ans('Отменено.');
      return this.draw(room);
    }
    if (verb === 'custom') {
      if (seq !== room.seq) return ans('Состояние изменилось — посмотрите кнопки ещё раз.');
      return this.promptAmount(room, user, ans);
    }
    if (verb === 'allinok') {
      if (!room.ui.armedAllIn || room.ui.armedAllIn.userId !== user.id)
        return ans('Сначала нажмите ALL-IN.');
    }

    const action = verb === 'allinok' ? 'allin' : verb;
    const amount = args.length ? argInt(args, 0) : null;
    const r = R.act(room, user.id, action, amount, seq);

    if (r.error === 'STALE') {
      // The double-tap case: the first press already moved the chips.
      await ans('Уже применено.');
      return this.draw(room);
    }
    if (r.error) return ans(this.explain(room, r.error));

    await ans('');
    return this.afterAction(room);
  }

  async promptAmount(room, user, ans) {
    const legal = legalActions(room, user.id);
    if (!legal || !(legal.canBet || legal.canRaise)) return ans('Сейчас повышать нельзя.');
    const msg = await this.outbox.post(
      room.chatId,
      `<a href="tg://user?id=${user.tgId}">${esc(user.name)}</a>, сумма от ${num(legal.minTotal)} ` +
        `до ${num(legal.maxTotal)} — ответьте числом на это сообщение.`,
      null,
      {
        reply_markup: {
          force_reply: true,
          selective: true, // only the mentioned player gets the reply box
          input_field_placeholder: String(legal.minTotal),
        },
      }
    );
    this.seen(room, msg?.message_id);
    room.ui.pendingBet = { userId: user.id, promptMessageId: msg.message_id };
    this.save(room);
    return ans('Введите сумму ответом на сообщение.');
  }

  /**
   * After chips moved: redraw — or, if that was the last hand of the game,
   * go straight to the results. Scheduling a redraw first would only have it
   * cancelled by `finishUp`, and the final showdown would never be shown.
   */
  async afterAction(room) {
    // An all-in board is shown street by street; the reveal posts the
    // results itself at the end if this was the last hand of the game.
    if (this.startReveal(room)) return this.draw(room);
    if (room.status === 'finished') return this.finishUp(room);
    await this.draw(room);
  }

  /** A hand was just dealt (or the game ended instead): cards out, table up. */
  async afterDeal(room, r) {
    if (r.finished) return this.finishUp(room);
    // Blinds alone can put everybody all-in: then the board is turned over
    // at once, and that may even end the game on the spot.
    const revealing = this.startReveal(room);
    await this.dealOut(room);
    if (room.status === 'finished' && !revealing) await this.finishUp(room);
  }

  async cbGame(room, user, { verb }, ans) {
    switch (verb) {
      case 'start': {
        const r = R.startGame(room, user.id, this.dealOpts(room));
        if (r.error) return ans(this.explain(room, r.error));
        await ans('Карты розданы — смотрите в личке.');
        return this.afterDeal(room, r);
      }
      case 'next': {
        const r = R.nextHand(room, user.id, this.dealOpts(room));
        if (r.error) return ans(this.explain(room, r.error));
        // Answer before the private messages go out: with nine players that
        // is nine requests, and the button must not spin through all of them.
        await ans('');
        return this.afterDeal(room, r);
      }
      case 'pause':
      case 'resume': {
        const r = R.setPaused(room, user.id, verb === 'pause');
        if (r.error) return ans(this.explain(room, r.error));
        await ans('');
        return this.draw(room);
      }
      default:
        return ans('');
    }
  }

  async cbHost(room, user, { verb, args }, ans, cq) {
    if (verb === 'close') {
      await ans('');
      return this.outbox.remove(room.chatId, cq.message.message_id);
    }
    if (!R.isHost(room, user.id)) return ans(this.hostOnly(room));

    const p = room.players[argInt(args, 0)];
    if (!p) return ans('Игрок не найден.');

    if (verb === 'kick') {
      const r = R.kickPlayer(room, user.id, p.id);
      if (r.error) return ans(this.explain(room, r.error));
      await ans(`${p.name} удалён.`);
      await this.editPanel(room, cq, renderKick(room));
      return this.afterAction(room);
    }
    if (verb === 'host') {
      const r = R.transferHost(room, user.id, p.id);
      if (r.error) return ans(this.explain(room, r.error));
      await ans(`${p.name} — новый хост.`);
      await this.outbox.remove(room.chatId, cq.message.message_id);
      return this.draw(room);
    }
    if (verb === 'rebuy') {
      const r = R.adjustStack(room, user.id, p.id, room.settings.startingStack);
      if (r.error) return ans(this.explain(room, r.error));
      await ans(`${p.name}: +${room.settings.startingStack}`);
      await this.editPanel(room, cq, renderRebuy(room));
      return this.draw(room);
    }
    return ans('');
  }

  async editPanel(room, cq, view) {
    try {
      await this.api.editMessageText(room.chatId, cq.message.message_id, view.text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: view.keyboard },
      });
    } catch (err) {
      if (!/message is not modified/i.test(String(err?.description ?? err?.message ?? ''))) this.log(err);
    }
  }

  /* ----------------------------------------------------- chat membership */

  async onLeft(chatId, member) {
    const room = this.room(chatId);
    if (!room) return;
    const r = R.markLeft(room, member.id);
    if (r.error) return;
    await this.afterAction(room);
  }

  async onJoined(chatId, members) {
    const me = members.find((m) => m.is_bot && this.botUsername && m.username === this.botUsername);
    if (me) await this.reply(chatId, HELP);
  }

  async onMyChatMember(u) {
    const status = u.new_chat_member?.status;
    // In a private chat this is the only notice that somebody blocked the bot
    // (or unblocked it): exactly the "can we send cards" signal.
    if (u.chat?.type === 'private') {
      const id = u.from?.id ?? u.chat.id;
      if (status === 'kicked') this.setDm(id, 'fail');
      else if (status === 'member') this.setDm(id, 'ok');
      return;
    }
    if (status === 'left' || status === 'kicked') {
      const chatId = String(u.chat.id);
      this.rooms.delete(chatId);
      this.store.remove(chatId);
    }
  }

  migrate(oldId, newId) {
    const room = this.room(oldId);
    if (!room) return;
    room.chatId = newId;
    // Message ids do not survive the migration either.
    room.ui.tableMessageId = null;
    room.ui.lastText = null;
    room.ui.lastKb = null;
    room.ui.lastMsgId = 0;
    room.ui.reveal = null; // its timer is keyed by the old id and will find nothing
    this.rooms.delete(oldId);
    this.rooms.set(newId, room);
    this.store.migrate(oldId, newId);
    this.save(room);
    return this.newTableMessage(room);
  }

  /* --------------------------------------------------------------- finish */

  async finishUp(room) {
    // Freeze the last hand where it stands — showing how it ENDED, buttons
    // gone — then post the results as their own message: it is the record of
    // the evening and belongs at the bottom of the chat.
    this.outbox.cancel(room.chatId);
    room.ui.reveal = null; // the final word is the whole board, not a frame of it
    if (room.ui.tableMessageId && room.hand) {
      const last = renderRoom({ ...room, status: 'playing' });
      try {
        await this.outbox.draw(room, { text: last.text, keyboard: [] });
      } catch (err) {
        this.log(err);
      }
    }
    room.ui.tableMessageId = null;
    await this.outbox.post(room.chatId, renderResults(room));
    this.save(room);
  }

  /* ---------------------------------------------------------------- utils */

  /** A message in the group; as a reply when it answers somebody's command. */
  async reply(chatId, text, toMsg = null) {
    try {
      const m = await this.outbox.post(chatId, text, null, toMsg ? { reply_parameters: replyTo(toMsg) } : {});
      this.seen(this.room(chatId), m?.message_id);
      return m;
    } catch (err) {
      this.log(err);
      return null;
    }
  }

  hostOnly(room) {
    return `Это может только хост — ${esc(nameOf(room, room.hostId))}.`;
  }

  /** Engine and room error codes turned into something a human can act on. */
  explain(room, code) {
    const map = {
      NOT_HOST: this.hostOnly(room),
      NOT_SEATED: 'Вы не за столом.',
      KICKED: 'Хост удалил вас из этой игры.',
      NOT_YOUR_TURN: `Сейчас ходит ${esc(nameOf(room, room.hand?.actorId))}.`,
      NOT_ENOUGH_PLAYERS: 'Нужно минимум два игрока с фишками. Хост может сделать /rebuy.',
      NOT_ENOUGH_CHIPS: 'Не хватает фишек.',
      BELOW_MIN_RAISE: 'Меньше минимального повышения.',
      CANNOT_CHECK: 'Чек сейчас нельзя — перед вами ставка.',
      CANNOT_CALL: 'Коллировать нечего.',
      CANNOT_BET: 'Ставку сейчас сделать нельзя.',
      CANNOT_RAISE: 'Повышать нельзя: короткий олл-ин не открыл торговлю заново.',
      NOTHING_TO_UNDO: 'Отменять нечего. Ставки и раздачи не отменяются — только действия хоста.',
      HAND_IN_PROGRESS: 'Раздача ещё идёт.',
      ALREADY_STARTED: 'Игра уже идёт.',
      GAME_FINISHED: 'Игра завершена.',
      GAME_PAUSED: 'Игра на паузе.',
      NOT_PLAYING: 'Игра ещё не началась.',
      CANNOT_KICK_HOST: 'Хоста удалить нельзя — сначала передайте права: /host.',
      STALE: 'Состояние изменилось — попробуйте ещё раз.',
      BAD_AMOUNT: 'Некорректная сумма.',
      NOT_LEVELS: 'Растущие блайнды выключены: /levels 20',
      LAST_LEVEL: 'Это последний уровень.',
      NO_PLAYER: 'Игрок не найден.',
    };
    return map[code] || `Не получилось: ${code}`;
  }
}

/* -------------------------------------------------------------- helpers */

const nameOf = (room, id) => room.players.find((p) => p.id === String(id))?.name ?? '—';

const replyTo = (msg) => (msg?.message_id ? { message_id: msg.message_id, allow_sending_without_reply: true } : undefined);

export function parseCommand(text, botUsername = '') {
  const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(String(text).trim());
  if (!m) return null;
  const [, cmd, addressed, rest] = m;
  // `/join@OtherBot` in a group is not ours to answer.
  if (addressed && botUsername && addressed.toLowerCase() !== botUsername.toLowerCase()) return null;
  const body = (rest || '').trim();
  return { cmd: cmd.toLowerCase(), rest: body, args: body ? body.split(/\s+/) : [] };
}

function intArg(v) {
  if (v == null) return null;
  const n = Math.round(Number(String(v).replace(',', '.')));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * A chip amount as people type it: "3000", "3 000", "3_000", "3 000" (NBSP).
 * Only whole digits — "3к" or "2.5" are refused, not guessed at: a guess about
 * somebody's chips is a bet they did not make.
 */
export function amountArg(text) {
  const s = String(text ?? '').replace(/[\s_   ]/g, '');
  if (!/^\d{1,12}$/.test(s)) return null;
  return Number(s);
}
