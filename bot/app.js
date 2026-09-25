'use strict';
/**
 * The bot's brain. Takes normalised Telegram updates, decides what is allowed,
 * mutates the room, redraws the table. Knows nothing about long polling or
 * webhooks, and talks to Telegram only through an injected `api` port — which
 * is why the whole thing can be tested without a network.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: nobody ever acts for somebody else.
 * A button in a group chat is visible to everyone and can be pressed by
 * everyone, so a button is never a permission. Every single press is
 * re-checked here against `callback_query.from.id`, which Telegram signs and
 * a client cannot forge.
 *
 * Note on ordering: every state mutation below happens synchronously, before
 * the first `await`. Two updates that arrive in the same tick therefore cannot
 * interleave inside a mutation, and the second one sees the bumped `seq`.
 */
import { legalActions } from '../server/game.js';
import { identify } from './identity.js';
import { decode, argInt, NS } from './cb.js';
import * as R from './room.js';
import {
  renderRoom, renderResults, renderRoles, renderKick, renderRebuy, renderTransfer,
} from './render.js';
import { Outbox } from './outbox.js';
import { NullStore } from './store.js';
import { esc, num } from './fmt.js';

const HELP = [
  '♠️ <b>Chip Table</b> — фишки для покера настоящими картами.',
  'Карты раздаёте вы, бот считает фишки: стеки, ставки, банк, очередь, блайнды, сайд-поты.',
  '',
  '<b>/newgame</b> — создать стол (вы хост)',
  '<b>/join</b> — сесть за стол · <b>/leave</b> — встать',
  '<b>/table</b> — заново показать стол',
  '',
  '<b>Хост:</b>',
  '/stack 10000 — стартовый стек (до старта)',
  '/blinds 25 50 — блайнды (в игре — со следующей раздачи)',
  '/levels 20 | /levels off — растущие блайнды',
  '/roles — назначить дилера · /kick — удалить игрока',
  '/rebuy — докупка фишек · /host — передать права',
  '/level — поднять уровень блайндов досрочно',
  '/pause · /resume · /finish — итоги · /cancel — удалить стол',
].join('\n');

const GROUP_ONLY = 'Бот работает в групповом чате: добавьте меня в группу и напишите /newgame.';

export class App {
  constructor({ api, store = new NullStore(), minIntervalMs = 1000, botUsername = '', onError = null } = {}) {
    this.api = api;
    this.store = store;
    this.botUsername = botUsername;
    this.log = onError || ((err) => console.error('[bot]', err?.description || err?.message || err));
    this.outbox = new Outbox(api, { minIntervalMs, onError: this.log });
    /** @type {Map<string, object>} */
    this.rooms = new Map();
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
      this.store.save(room, R.serialize(room));
    } catch (err) {
      this.log(err);
    }
  }

  /** After a restart: redraw every live table so play resumes where it stopped. */
  async resume() {
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

  /** Schedule a redraw of the table message (coalesced, latest state wins). */
  draw(room, { immediate = false } = {}) {
    const produce = async () => {
      const view = renderRoom(room);
      await this.outbox.draw(room, view);
      this.save(room);
    };
    if (immediate) return produce();
    this.outbox.schedule(room.chatId, produce);
    return Promise.resolve();
  }

  /**
   * One table message per hand, as asked: the finished hand stays in the chat
   * as its own record, and the new one lands at the bottom where people are
   * actually looking instead of scrolled away above the conversation.
   */
  async newTableMessage(room) {
    this.outbox.cancel(room.chatId);
    const old = room.ui.tableMessageId;
    if (old) {
      await this.outbox.dropKeyboard(room.chatId, old);
      if (room.ui.pinnedMessageId === old) await this.outbox.unpin(room.chatId, old);
    }
    room.ui.tableMessageId = null;
    room.ui.lastText = null;
    room.ui.lastKb = null;
    await this.draw(room, { immediate: true });
    await this.outbox.pin(room.chatId, room.ui.tableMessageId);
    room.ui.pinnedMessageId = room.ui.tableMessageId;
    this.save(room);
  }

  /** Test seam: wait until every coalesced redraw has actually gone out. */
  settle() {
    return this.outbox.drain();
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
    }
  }

  room(chatId) {
    return this.rooms.get(String(chatId)) || null;
  }

  /* ------------------------------------------------------------- messages */

  async onMessage(msg) {
    const chatId = String(msg.chat.id);

    // A group promoted to a supergroup changes chat.id. Re-key the table or
    // it is silently lost the moment somebody upgrades the group.
    if (msg.migrate_to_chat_id) return this.migrate(chatId, String(msg.migrate_to_chat_id));

    if (msg.left_chat_member) return this.onLeft(chatId, msg.left_chat_member);
    if (msg.new_chat_members?.length) return this.onJoined(chatId, msg.new_chat_members);
    if (msg.pinned_message) return this.tidyPin(chatId, msg);
    if (typeof msg.text !== 'string') return;

    const room = this.room(chatId);

    // A reply to our ForceReply prompt: the "custom amount" path.
    const pb = room?.ui?.pendingBet;
    if (pb && msg.reply_to_message && msg.reply_to_message.message_id === pb.promptMessageId) {
      return this.onAmountReply(room, msg, pb);
    }

    const cmd = parseCommand(msg.text, this.botUsername);
    if (!cmd) return;
    return this.onCommand(cmd, msg);
  }

  async onCommand(cmd, msg) {
    const chatId = String(msg.chat.id);
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const who = identify(msg.from, msg.sender_chat);

    if (cmd.cmd === 'start' || cmd.cmd === 'help') return void (await this.reply(chatId, HELP));
    if (!isGroup) return void (await this.reply(chatId, GROUP_ONLY));
    if (!who.ok) return void (await this.reply(chatId, who.text));

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
        const fresh = R.createRoom({ chatId, host: { id: user.id, tgId: user.tgId, name: user.name } });
        this.rooms.set(chatId, fresh);
        await this.newTableMessage(fresh);
        return;
      }

      case 'join': {
        if (!room) return void (await this.reply(chatId, 'Стола нет. /newgame'));
        if (room.status === 'finished') return void (await this.reply(chatId, 'Игра завершена.'));
        R.addPlayer(room, { id: user.id, tgId: user.tgId, name: user.name });
        await this.draw(room);
        return;
      }

      case 'leave': {
        if (!room) return;
        const r = R.sitOut(room, user.id, true);
        if (r.error) return void (await this.reply(chatId, 'Вы не за столом.'));
        await this.draw(room);
        return;
      }

      case 'table': {
        if (!room) return void (await this.reply(chatId, 'Стола нет. /newgame'));
        await this.newTableMessage(room);
        return;
      }

      case 'stack':
      case 'blinds':
      case 'levels':
        return this.onSettings(cmd, room, user, chatId);

      case 'roles': {
        if (!room) return;
        if (!R.isHost(room, user.id)) return void (await this.reply(chatId, this.hostOnly(room)));
        const v = renderRoles(room);
        await this.outbox.post(chatId, v.text, v.keyboard);
        return;
      }

      case 'kick': {
        if (!room) return;
        if (!R.isHost(room, user.id)) return void (await this.reply(chatId, this.hostOnly(room)));
        const v = renderKick(room);
        await this.outbox.post(chatId, v.text, v.keyboard);
        return;
      }

      case 'rebuy': {
        if (!room) return;
        if (!R.isHost(room, user.id)) return void (await this.reply(chatId, this.hostOnly(room)));
        const v = renderRebuy(room);
        await this.outbox.post(chatId, v.text, v.keyboard);
        return;
      }

      case 'host': {
        if (!room) return;
        if (!R.isHost(room, user.id)) return void (await this.reply(chatId, this.hostOnly(room)));
        const v = renderTransfer(room);
        await this.outbox.post(chatId, v.text, v.keyboard);
        return;
      }

      case 'level': {
        if (!room) return;
        const r = R.bumpLevel(room, user.id);
        if (r.error) return void (await this.reply(chatId, this.explain(room, r.error)));
        await this.draw(room);
        await this.reply(chatId, `⏫ ${esc(room.notice)}`);
        return;
      }

      case 'pause':
      case 'resume': {
        if (!room) return;
        const r = R.setPaused(room, user.id, cmd.cmd === 'pause');
        if (r.error) return void (await this.reply(chatId, this.explain(room, r.error)));
        await this.draw(room);
        return;
      }

      case 'finish': {
        if (!room) return void (await this.reply(chatId, 'Стола нет.'));
        const r = R.endGame(room, user.id);
        if (r.error) return void (await this.reply(chatId, this.explain(room, r.error)));
        await this.finishUp(room);
        return;
      }

      case 'cancel': {
        if (!room) return;
        if (!R.isHost(room, user.id)) return void (await this.reply(chatId, this.hostOnly(room)));
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
    await this.draw(room);
    if (room.notice) await this.reply(chatId, `⚙️ ${esc(room.notice)}`);
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

    const total = intArg(String(msg.text).replace(/[\s_ ]/g, ''));
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
    const ans = (text, alert = false) => this.outbox.answer(cq.id, text, alert);

    // 1. WHO pressed it. Anonymous admins are refused here and nowhere else.
    // Only `cq.from` matters: a callback_query has no sender_chat of its own,
    // and `cq.message.sender_chat` describes whoever posted the message the
    // button sits on — in a channel's discussion group that is the channel,
    // which would refuse every real player at the table.
    const who = identify(cq.from);
    if (!who.ok) return ans(who.text, true);

    const parsed = decode(cq.data);
    if (!parsed) return ans('Кнопка не распознана.');

    const chatId = String(cq.message?.chat?.id ?? '');
    const room = this.room(chatId);
    if (!room) return ans('Стол не найден. /newgame');

    const user = who.user;
    switch (parsed.ns) {
      case NS.LOBBY: return this.cbLobby(room, user, parsed, ans);
      case NS.ACT:   return this.cbAction(room, user, parsed, ans);
      case NS.GAME:  return this.cbGame(room, user, parsed, ans);
      case NS.WIN:   return this.cbWinner(room, user, parsed, ans);
      case NS.HOST:  return this.cbHost(room, user, parsed, ans, cq);
      default:       return ans('Неизвестная кнопка.');
    }
  }

  async cbLobby(room, user, { verb }, ans) {
    if (room.status === 'finished') return ans('Игра завершена.');
    if (verb === 'sit') {
      const before = room.players.length;
      R.addPlayer(room, { id: user.id, tgId: user.tgId, name: user.name });
      await ans(before === room.players.length ? 'Вы уже за столом.' : 'Вы за столом.');
      return this.draw(room);
    }
    if (verb === 'leave') {
      const r = R.sitOut(room, user.id, true);
      await ans(r.error ? 'Вы и так не за столом.' : 'Вы встали из-за стола.');
      if (!r.error) await this.draw(room);
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
    room.ui.pendingBet = { userId: user.id, promptMessageId: msg.message_id };
    this.save(room);
    return ans('Введите сумму ответом на сообщение.');
  }

  /** After chips moved: redraw, and start a fresh message when a hand ends. */
  async afterAction(room) {
    await this.draw(room);
    if (room.status === 'finished') await this.finishUp(room);
  }

  async cbGame(room, user, { verb, seq }, ans) {
    switch (verb) {
      case 'start': {
        const r = R.startGame(room, user.id);
        if (r.error) return ans(this.explain(room, r.error));
        await ans('Поехали.');
        return this.newTableMessage(room);
      }
      case 'next': {
        if (!R.findPlayer(room, user.id)) return ans('Вы не за столом.');
        const r = R.nextHand(room, user.id);
        if (r.error) return ans(this.explain(room, r.error));
        await ans('');
        if (r.finished) return this.finishUp(room);
        return this.newTableMessage(room);
      }
      case 'undo': {
        const r = R.undo(room, user.id);
        if (r.error) return ans(this.explain(room, r.error));
        await ans(`Отменено: ${r.label}`);
        return this.draw(room);
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

  /**
   * Winner selection. The app never computes a share: the numbers shown are
   * `previewPayouts()`, which is the same engine call that moves the chips.
   */
  async cbWinner(room, user, { verb, seq, args }, ans) {
    if (!room.hand || room.hand.phase !== 'showdown') return ans('Банк уже закрыт.');
    if (!R.canDecideWinner(room, user.id)) {
      const d = R.dealers(room)[0];
      return ans(d ? `Победителя определяет ${d.name}.` : 'Вы не за столом.');
    }

    if (verb === 'pick') {
      if (seq !== room.seq) return ans('Состояние изменилось — посмотрите список ещё раз.');
      const r = R.toggleWinner(room, user.id, argInt(args, 0), argInt(args, 1));
      if (r.error) return ans(this.explain(room, r.error));
      await ans(r.on ? `${r.name} — забирает` : `${r.name} — снято`);
      return this.draw(room);
    }
    if (verb === 'next' || verb === 'back') {
      const r = verb === 'next' ? R.winnerNext(room, user.id) : R.winnerBack(room, user.id);
      if (r.error) return ans(this.explain(room, r.error));
      await ans('');
      return this.draw(room);
    }
    if (verb === 'ok') {
      const r = R.confirmWinners(room, user.id, seq);
      if (r.error === 'STALE') {
        await ans('Уже применено.');
        return this.draw(room);
      }
      if (r.error) return ans(this.explain(room, r.error));
      await ans('Банк роздан.');
      await this.draw(room);
      if (room.status === 'finished') await this.finishUp(room);
      return;
    }
    return ans('');
  }

  async cbHost(room, user, { verb, seq, args }, ans, cq) {
    if (verb === 'close') {
      await ans('');
      return this.outbox.remove(room.chatId, cq.message.message_id);
    }
    if (!R.isHost(room, user.id)) return ans(this.hostOnly(room));

    if (verb === 'role') {
      const seat = argInt(args, 0);
      const p = room.players[seat];
      if (!p) return ans('Игрок не найден.');
      const next = R.roleOf(p) === 'dealer' ? 'player' : 'dealer';
      const r = R.setRole(room, user.id, p.id, next);
      if (r.error) return ans(this.explain(room, r.error));
      await ans(r.deferred ? 'Сменится со следующей раздачи.' : 'Готово.');
      await this.editPanel(room, cq, renderRoles(room));
      return this.draw(room);
    }
    if (verb === 'kick') {
      const seat = argInt(args, 0);
      const p = room.players[seat];
      if (!p) return ans('Игрок не найден.');
      const r = R.kickPlayer(room, user.id, p.id);
      if (r.error) return ans(this.explain(room, r.error));
      await ans(`${p.name} удалён.`);
      await this.editPanel(room, cq, renderKick(room));
      return this.draw(room);
    }
    if (verb === 'host') {
      const seat = argInt(args, 0);
      const p = room.players[seat];
      if (!p) return ans('Игрок не найден.');
      const r = R.transferHost(room, user.id, p.id);
      if (r.error) return ans(this.explain(room, r.error));
      await ans(`${p.name} — новый хост.`);
      await this.outbox.remove(room.chatId, cq.message.message_id);
      return this.draw(room);
    }
    if (verb === 'rebuy') {
      const seat = argInt(args, 0);
      const p = room.players[seat];
      if (!p) return ans('Игрок не найден.');
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
    await this.draw(room);
  }

  async onJoined(chatId, members) {
    const me = members.find((m) => m.is_bot && this.botUsername && m.username === this.botUsername);
    if (me) await this.reply(chatId, HELP);
  }

  async onMyChatMember(u) {
    const status = u.new_chat_member?.status;
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
    room.ui.pinnedMessageId = null;
    room.ui.lastText = null;
    room.ui.lastKb = null;
    this.rooms.delete(oldId);
    this.rooms.set(newId, room);
    this.store.migrate(oldId, newId);
    this.save(room);
    return this.newTableMessage(room);
  }

  /** Delete the "pinned a message" service notice we caused ourselves. */
  async tidyPin(chatId, msg) {
    const room = this.room(chatId);
    if (!room) return;
    if (msg.pinned_message?.message_id !== room.ui.pinnedMessageId) return;
    await this.outbox.remove(chatId, msg.message_id);
  }

  /* --------------------------------------------------------------- finish */

  async finishUp(room) {
    // Freeze the last hand where it stands, then post the results as their own
    // message: it is the record of the evening and belongs at the bottom of
    // the chat, not hidden inside a message that keeps getting edited.
    this.outbox.cancel(room.chatId);
    if (room.ui.tableMessageId) await this.outbox.dropKeyboard(room.chatId, room.ui.tableMessageId);
    if (room.ui.pinnedMessageId) await this.outbox.unpin(room.chatId, room.ui.pinnedMessageId);
    room.ui.tableMessageId = null;
    room.ui.pinnedMessageId = null;
    await this.outbox.post(room.chatId, renderResults(room));
    this.save(room);
  }

  /* ---------------------------------------------------------------- utils */

  reply(chatId, text) {
    return this.outbox.post(chatId, text).catch((err) => this.log(err));
  }

  hostOnly(room) {
    return `Это может только хост — ${nameOf(room, room.hostId)}.`;
  }

  /** Engine and room error codes turned into something a human can act on. */
  explain(room, code) {
    const dealer = R.dealers(room)[0]?.name;
    const map = {
      NOT_HOST: this.hostOnly(room),
      NOT_ALLOWED: `Это может хост${dealer ? ` или дилер (${dealer})` : ''}.`,
      DEALER_DECIDES: dealer ? `Победителя определяет ${dealer}.` : 'Сейчас нельзя.',
      DEALER_DEALS: dealer ? `Следующую раздачу сдаёт ${dealer}.` : 'Сейчас нельзя.',
      NOT_YOUR_TURN: `Сейчас ходит ${nameOf(room, room.hand?.actorId)}.`,
      NOT_ENOUGH_PLAYERS: 'Нужно минимум два игрока с фишками.',
      NOT_ENOUGH_CHIPS: 'Не хватает фишек.',
      BELOW_MIN_RAISE: 'Меньше минимального повышения.',
      CANNOT_CHECK: 'Чек сейчас нельзя — перед вами ставка.',
      CANNOT_CALL: 'Коллировать нечего.',
      CANNOT_BET: 'Ставку сейчас сделать нельзя.',
      CANNOT_RAISE: 'Повышать нельзя: короткий олл-ин не открыл торговлю заново.',
      NO_WINNER_SELECTED: 'Сначала отметьте, кто забрал банк.',
      NOTHING_TO_UNDO: 'Отменять нечего.',
      HAND_IN_PROGRESS: 'Раздача ещё идёт.',
      ALREADY_STARTED: 'Игра уже идёт.',
      GAME_FINISHED: 'Игра завершена.',
      GAME_PAUSED: 'Игра на паузе.',
      NOT_PLAYING: 'Игра ещё не началась.',
      CANNOT_KICK_HOST: 'Хоста удалить нельзя — сначала передайте права.',
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
