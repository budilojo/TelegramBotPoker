'use strict';
/**
 * The bot's brain — the core of the game hub. The games themselves are
 * played in the Mini App (see hub.js) and their rules live in their own
 * modules (games/); the Telegram side is the lobby and the notifications:
 *
 *   - in the group: `/game` posts the hub card («🎮 Во что играем?») that
 *     opens the Mini App for THIS group; every game has ONE card of its own —
 *     posted once, then only ever edited (edits do not ring anybody's phone) —
 *     with the button that opens it; and the results at the end. A group may
 *     have several games going at once, each with its own card.
 *   - in private: "👉 your turn", only for somebody whose app is closed,
 *     and deleted again once the turn has passed.
 *
 * It also owns what has to run without anybody pressing anything: every
 * game's timers (the modules say what should run, this arms it).
 *
 * THE TWO RULES still hold, and are enforced where the moves now come in:
 * nobody acts for somebody else (identity = verified initData, hub.js), and
 * nobody sees somebody else's cards (each viewer gets their own state, from
 * the game module's view). The only moves the bot ever makes in somebody's
 * place are a turn timer's — switched on by the host.
 */
import crypto from 'node:crypto';
import { identify } from './identity.js';
import { Outbox } from './outbox.js';
import { NullStore } from './store.js';
import { esc } from './fmt.js';
import { Profiles } from './profile.js';
import { Training } from './train.js';
import { Collections } from './collections/index.js'; // collections
import { GAMES, GAME_LIST, HIDDEN_DRAFTS, gameOf } from './games/index.js';
import { apply as rateRound } from './rating.js';

/**
 * Справка НЕ НАЗЫВАЕТ ИГР. Ни одной — ни списком, ни примером.
 *
 * Игры появляются и уходят, а текст остаётся; стоит вписать сюда названия, и
 * через месяц бот врёт. Всё, что человеку нужно знать здесь, — что игру
 * выбирают в приложении. Какие там игры, он увидит на экране, где они и
 * живут.
 */
/** Стартовый код «игры с ботами»: `startapp=solo` или `?room=solo` из лички. */
export const SOLO_CODE = 'solo';
/** Брошенная партия с ботами закрывается сама, без сообщений, через три часа тишины. */
export const SOLO_IDLE_MS = 3 * 60 * 60_000;

/**
 * Команда → игра: лобби одной командой в группе. Команды объявляет сама игра
 * (`commands` модуля); покер живёт на /poker и /newgame.
 */
export const QUICK_GAMES = Object.fromEntries(GAME_LIST.flatMap((g) => (g.commands || []).map(([cmd]) => [cmd, g.id])));
/** Те же команды для меню «/» в группе — без скрытых псевдонимов (у них нет описания). */
export const QUICK_MENU = GAME_LIST.flatMap((g) => (g.commands || []).filter(([, about]) => about));

const HELP = [
  '🎮 <b>Игры в Telegram</b> — играем прямо в чате, в мини-приложении.',
  '',
  '<b>/game</b> — во что играем. Бот пришлёт карточку с кнопкой: выберите игру',
  'в приложении и создайте лобби; друзья присоединятся по его карточке.',
  '',
  '/table — показать карточки игр внизу чата',
  '/finish — завершить свою игру и показать итоги (хост)',
  '/cancel — удалить свою игру (хост)',
  '',
  'Чтобы бот мог напомнить, что ваш ход, — один раз нажмите Start у него в личке.',
].join('\n');

const HELP_DM = [
  '🎮 <b>Игры в Telegram</b>',
  '',
  'Сюда приходят напоминания «ваш ход» — только когда приложение у вас закрыто.',
  'Сама игра — в группе: напишите там /game и выберите игру.',
  'Или /game здесь — откроются игры ваших групп.',
  '',
  '🤖 Не с кем играть? /bot — партия с ботами прямо здесь, без группы.',
].join('\n');

/** callback_data кнопки «не присылать такое» под каждой рассылкой. */
export const ADS_OFF = 'ads:off';

/** Что видит игрок, пока идёт обслуживание, если владелец не написал своего. */
export const MAINTENANCE_TEXT = 'Обновляемся. Столы никуда не делись — вернёмся через несколько минут.';

/** `/finish` на игре, которая уже завершена: итоги не публикуются второй раз. */
export const ALREADY_FINISHED_TEXT = 'Игра уже завершена — итоги выше.';

const WELCOME_DM = '✅ Готово: если приложение будет закрыто, когда до вас дойдёт ход, — напомню здесь.';

/** Games a group may have going at once. Past this the hub asks to finish one. */
export const MAX_LIVE_PER_GROUP = 10;
/**
 * Отказ на переполнение — ОДИН на все двери.
 *
 * Дверей в группу две: кнопка в приложении и команда в чате. Запрет у них
 * общий, значит и объяснение должно быть общим, слово в слово: человек не
 * должен гадать, два это разных правила или одно.
 */
export const TOO_MANY_GAMES_TEXT = `В группе уже ${MAX_LIVE_PER_GROUP} незаконченных игр — завершите какую-нибудь.`;

/**
 * Рейтинг ещё не открыт людям.
 *
 * Экран готов и очки считаются, но показывать таблицу рано: в неё должны идти
 * партии из рейтинговых групп, а их ещё не завели (docs/ranked.md). Пустить
 * людей сейчас — значит показать им доску, собранную из домашних партий, и
 * потом её отнять. Открыть обратно — снять этот флаг, больше ничего.
 */
export const RATING_SOON = true;
export const RATING_SOON_TEXT = 'Рейтинг почти готов. Он откроется вместе с рейтинговыми группами: '
  + 'очки будут идти за партии в них, а не за домашние.';
/** A finished game stays (its results on open phones) this long after it ended. */
export const FINISHED_KEEP_MS = 30 * 60_000;
/** …and is dropped at start-up after this long, new game or not. */
export const FINISHED_MAX_MS = 24 * 60 * 60_000;

/**
 * Заброшенный стол: создали и не пришли.
 *
 * Стол в лобби живёт столько без единого признака жизни — и закрывается сам.
 * Признак жизни самый широкий: кто-то открыл стол в приложении, сел, встал,
 * поменял настройки. Одного открытия хватает: значит, за столом кто-то есть.
 *
 * Начатую игру это не трогает вообще. Там своё время на ход, свои правила, и
 * закрывать игру, в которой люди думают над картами, нельзя.
 */
export const IDLE_CLOSE_MS = 20 * 60_000;
/**
 * …а когда за столом уже двое, ждём втрое дольше. Двое — это не «создал и
 * забыл», это «ждём третьего»: такой стол закрывать через двадцать минут
 * обидно и неправильно.
 */
export const IDLE_READY_MS = 60 * 60_000;
/** За минуту до закрытия бот предупреждает в группе — вдруг кто-то рядом. */
export const IDLE_WARN_MS = 60_000;
/**
 * После перезапуска бота у стола есть столько, чтобы подать признаки жизни.
 * Открытые приложения переподключаются сами за секунды — живой стол успевает;
 * заброшенный закрывается вскоре после старта, а не через полные двадцать
 * минут и не мгновенно.
 */
export const IDLE_GRACE_MS = 2 * 60_000;
/** На столько сдвигается каждый следующий брошенный стол после перезапуска. */
export const IDLE_SPREAD_MS = 3_000;

/**
 * Начатая партия, которую никто не трогает: никто не открывал стол, не ходил,
 * не просил ничего. Свои часы на ход у игры есть, но когда все ушли, они
 * доигрывают стол за пустой комнатой, а сам стол остаётся в списке, занимает
 * место из десяти и висит в хабе. Через столько тишины партию завершает бот:
 * итоги уходят в группу, как после «/finish».
 *
 * Три часа — так решил владелец (2026-10-20). Для столов, играющих на рейтинг,
 * срок он обсудит отдельно: пока он один на все начатые партии с людьми.
 */
export const IDLE_PLAY_MS = 3 * 60 * 60_000;

export const IDLE_WARN_TEXT =
  '⏳ За этим столом давно тихо. Если никто не вернётся, через минуту он закроется.';
export const IDLE_PLAY_WARN_TEXT =
  '⏳ За этим столом давно никого нет. Если никто не вернётся, через минуту бот завершит игру и пришлёт итоги.';
export const IDLE_PLAY_CLOSED_TEXT =
  '🏁 За столом так никто и не вернулся — игра завершена. Итоги выше.';
export const IDLE_CLOSED_TEXT =
  '😔 Похоже, за этим столом так никто и не собрался. Стол закрыт — создавайте новый, когда соберётесь.';

/** The real clock. Tests pass a fake one and move time by hand. */
const REAL_CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

/** A group's public handle — `startapp=g_<code>`. Random, unrelated to the chat id. */
export function newGroupCode() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(10), (b) => abc[b % abc.length]).join('');
}

export const HUB_PREFIX = 'g_';

export class App {
  /**
   * @param deck           test seam: `(room) => number[52]` — a stacked poker deck
   * @param durakDeck      test seam: `(room) => string[36]` — a stacked durak deck
   * @param clock          `{ now, setTimeout, clearTimeout }` for the timers
   * @param runoutStepMs   pause between streets when an all-in board is shown
   * @param webappUrl      public HTTPS address of the Mini App
   * @param miniAppName    the short name registered with @BotFather (/newapp):
   *                       then the group button opens the app directly
   * @param ratingSoon     рейтинг ещё не открыт людям: кнопка есть, экран нет
   */
  constructor({
    api, store = new NullStore(), minIntervalMs = 1000, botUsername = '', onError = null, deck = null, durakDeck = null,
    clock = REAL_CLOCK, runoutStepMs = 1500, webappUrl = '', miniAppName = '', admins = [], ratingSoon = RATING_SOON,
    botRng = Math.random, collectionsDemo = false,
  } = {}) {
    this.api = api;
    this.store = store;
    this.botUsername = botUsername;
    /** Когда человек последний раз просил «поделиться»: заготовка — запрос к Telegram, чаще раза в две секунды не нужна. */
    this.lastShare = new Map();
    this.deck = deck;
    this.durakDeck = durakDeck;
    this.clock = clock;
    this.runoutStepMs = runoutStepMs;
    this.webappUrl = String(webappUrl || '').replace(/\/+$/, '');
    this.miniAppName = miniAppName;
    /** Рейтинг ещё не открыт людям — см. RATING_SOON. Снимается одним значением. */
    this.ratingSoon = !!ratingSoon;
    /**
     * Кто видит админку. Список приходит из `.env`, а не из чата: файл правит
     * тот, кто запускает бота, и подделать это сообщением нельзя.
     */
    this.admins = new Set([...admins].map((x) => String(x).trim()).filter(Boolean));
    /** Друзья-тестеры косметики (`COSMETICS_TESTERS` в `.env`): вещи разблокированы, как у админов. По умолчанию пусто. */
    this.cosmeticsTesters = new Set();
    /**
     * Режим обслуживания. Лежит в базе, а не в памяти: перезапуск не должен
     * снимать его сам — иначе он кончится в самый неподходящий момент.
     */
    this.maintenance = this.store.getSetting?.('maintenance', null) || { on: false, text: '', since: 0 };
    this.hub = null; // set by attachHub()
    /** Рассылки (bot/broadcast.js) — ставится снаружи; без неё админка просто без вкладки. */
    this.casts = null;
    this.log = onError || ((err) => console.error('[bot]', err?.description || err?.message || err));
    this.outbox = new Outbox(api, { minIntervalMs, onError: this.log, timers: clock });
    /** @type {Map<string, object>} room code -> room (a group may have several) */
    this.rooms = new Map();
    /** @type {Map<string, object>} chatId -> group { chatId, code, title, ui } */
    this.groups = new Map();
    /** `${kind}:${code}` -> { key, deadline, h } — every timer the bot holds */
    this.handles = new Map();
    /** private-chat work in flight (turn pings) — awaited by settle() */
    this.inflight = new Set();
    /** Случайность ботов (задержка, выбор): в тестах — повторимая. */
    this.botRng = botRng;
    /** Ник и аватар для показа (bot/profile.js): права они не дают. */
    this.profiles = new Profiles(this);
    /** Личный прогресс «Тренировки» в покере (bot/train.js): ни в вид стола, ни в рейтинг не идёт. */
    this.training = new Training(this);
    // collections: коллекция «Графит». Демосреда — только строгое `true` из серверной настройки (bot/index.js).
    this.collections = new Collections(this, { demo: collectionsDemo === true });
  }

  attachHub(hub) {
    this.hub = hub;
    return this;
  }

  /** Every game of a chat, oldest first. */
  roomsOf(chatId) {
    const id = String(chatId);
    return [...this.rooms.values()].filter((r) => r.chatId === id).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  /** The newest game of a chat — what "the table in this group" means for one game. */
  room(chatId) {
    return this.roomsOf(chatId).at(-1) || null;
  }

  roomByCode(code) {
    if (!code) return null;
    return this.rooms.get(String(code)) || null;
  }

  /** Put a room under its code (tools and tests build rooms by hand). */
  addRoom(room) {
    room.game = room.game || 'poker';
    this.rooms.set(room.code, room);
    return room;
  }

  groupByCode(code) {
    if (!code) return null;
    for (const g of this.groups.values()) if (g.code === code) return g;
    return null;
  }

  /** The group's hub record — created the first time somebody asks for it. */
  ensureGroup(chatId, title = '', { save = true } = {}) {
    const id = String(chatId);
    let g = this.groups.get(id);
    if (!g) {
      g = { chatId: id, code: newGroupCode(), title: '', ui: { hubMessageId: null } };
      this.groups.set(id, g);
    }
    if (title) g.title = String(title).slice(0, 64);
    if (save) this.saveGroup(g);
    return g;
  }

  saveGroup(g) {
    try {
      this.store.saveGroup(g);
    } catch (err) {
      this.log(err);
    }
  }

  /* ------------------------------------------------------------ статистика */

  isAdmin(userId) {
    return this.admins.has(String(userId));
  }

  /** Разблокирована ли косметика без покупки: администраторы и список тестеров. Решает только сервер. */
  cosmeticsUnlocked(userId) {
    return this.isAdmin(userId) || this.cosmeticsTesters.has(String(userId));
  }

  /* ---------------------------------------------------------- обслуживание */

  /** Идёт ли обслуживание: тогда игра стоит вся, кроме админки. */
  get down() {
    return !!this.maintenance.on;
  }

  /** Текст, который видит игрок. Свой, если задан, иначе общий. */
  get downText() {
    return this.maintenance.text || MAINTENANCE_TEXT;
  }

  /**
   * Включить или снять обслуживание. Включение замораживает часы (время на
   * ход не тратится), снятие — пускает их с того же места.
   */
  setMaintenance(on, text = '') {
    if (!on && !this.maintenance.on) return this.maintenance;
    const was = this.down;
    this.maintenance = { on: !!on, text: String(text || '').slice(0, 300), since: this.clock.now() };
    // Свои часы игры (уровни блайндов покера) стоят вместе с часами хода.
    if (was !== this.down) for (const room of this.rooms.values()) gameOf(room).freeze?.(room, this.down);
    try {
      this.store.setSetting?.('maintenance', this.maintenance);
    } catch (err) {
      this.log(err);
    }
    // Снимаем обслуживание — заброшенным столам отсчёт с нуля. Иначе стол,
    // простоявший всё обслуживание, закрылся бы в первую же секунду после
    // него: не потому что заброшен, а потому что бота не было.
    if (!on) for (const room of this.rooms.values()) {
      if (room.status === 'lobby') {
        room.idleAt = this.clock.now();
        room.idleWarned = false;
      }
    }
    this.syncClocks();
    this.hub?.broadcastAll();
    return this.maintenance;
  }

  /**
   * Завершить все живые игры с итогами в группы. Для «выключаю сервер
   * надолго»: честные итоги лучше стола, который никогда не оживёт.
   */
  async stopAll() {
    let n = 0;
    for (const room of [...this.rooms.values()]) {
      if (room.status === 'finished') continue;
      const r = gameOf(room).endGame(room, room.hostId, this.clock.now());
      if (r.error) continue;
      await this.finishUp(room);
      n += 1;
    }
    return n;
  }

  /** Человек открыл приложение. Второй раз за день ничего не добавит. */
  noteSeen(userId) {
    try {
      this.store.noteSeen(userId, this.clock.now());
    } catch (err) {
      this.log(err);
    }
  }

  /**
   * Что случилось с игрой: `created`, `round` (сдана раздача или партия),
   * `finished`. В строку не попадает ни имени, ни карты — только когда, какая
   * игра, в какой группе и сколько человек.
   */
  note(kind, room) {
    try {
      this.store.addEvent({
        at: this.clock.now(),
        kind,
        game: room.game,
        chatId: room.chatId,
        code: room.code,
        n: room.players.filter((p) => !p.kicked && !p.left).length,
      });
    } catch (err) {
      this.log(err);
    }
  }

  /** Что происходит прямо сейчас — это не из базы, а из памяти. */
  liveNow() {
    const rooms = [...this.rooms.values()].filter((r) => r.status !== 'finished');
    const playing = rooms.filter((r) => r.status === 'playing' || r.status === 'paused');
    const byGame = {};
    for (const r of playing) byGame[r.game] = (byGame[r.game] || 0) + 1;
    return {
      playing: playing.length,
      lobbies: rooms.length - playing.length,
      groups: new Set(rooms.filter((r) => !r.solo).map((r) => r.chatId)).size,
      solo: rooms.filter((r) => r.solo).length,
      online: this.hub?.people ?? 0,
      byGame,
    };
  }

  /* ---------------------------------------------------------- persistence */

  load() {
    const now = this.clock.now();
    let lobbies = 0; // чтобы развести брошенные столы по времени, а не закрывать залпом
    for (const g of this.store.loadGroups()) {
      this.groups.set(String(g.chatId), { ...g, ui: g.ui || { hubMessageId: null } });
    }
    for (const { chatId, code, game, data } of this.store.loadAll()) {
      // Стол игры-черновика, а черновики скрыты: не читать его как покер — оставить в базе как есть.
      if (HIDDEN_DRAFTS.has(game)) continue;
      try {
        const room = (GAMES[game] || gameOf(data)).deserialize(data);
        room.chatId = String(chatId); // the column wins: it is what a migration re-keys
        room.code = room.code || code;
        room.ui = room.ui || {};
        // Saved before a game could wait for several people at once.
        if (room.ui.ping) {
          const { key, userId, messageId } = room.ui.ping;
          room.ui.pings = messageId ? { [String(userId)]: { key, tgId: userId, messageId } } : {};
          delete room.ui.ping;
        }
        // A finished game an evening ago is nobody's any more.
        if (room.status === 'finished' && now - (room.finishedAt || 0) > FINISHED_MAX_MS) {
          this.store.remove(room.code);
          continue;
        }
        if (room.status !== 'finished' && !room.solo) {
          // Деплой не должен укорачивать жизнь стола: сколько он простоял,
          // видно по createdAt — он в базе есть. Стол, созданный за минуту
          // до перезапуска, получает свои оставшиеся девятнадцать, а не две.
          //
          // А по-настоящему старым лобби даётся короткий срок — и РАЗНЫЙ:
          // иначе первое, что делает бот после каждого деплоя, — пишет во
          // все группы разом и упирается в лимит Telegram, тормозя заодно
          // сообщения живых игр.
          // Начатой партии срок свой — дольше (IDLE_PLAY_MS), правило то же.
          const span = room.status === 'lobby' ? IDLE_CLOSE_MS : IDLE_PLAY_MS;
          const floor = now - span + IDLE_GRACE_MS + IDLE_SPREAD_MS * lobbies++;
          room.idleAt = Math.max(room.createdAt || 0, floor);
          room.idleWarned = false;
        }
        // Стол поднимается, только если строит вид, строку хаба и часы. Иначе
        // одна испорченная (или слишком старая) строка базы роняла часы и
        // перерисовку ВСЕХ столов, а на запуске — сам бот (аудит, E-02).
        // Строка остаётся в базе: её можно посмотреть и починить руками.
        const g = gameOf(room);
        if (this.down) g.freeze?.(room, true); // подняли во время обслуживания — часы игры стоят
        g.summary(room);
        g.view(room, '0', { now, botUsername: this.botUsername });
        g.clocks?.(this, room, now);
        this.rooms.set(room.code, room);
      } catch (err) {
        this.log(new Error(`стол ${code} (${game}) не поднят из базы: ${err?.message || err}`));
      }
    }
    return this.rooms.size;
  }

  save(room) {
    if (room.gone) return; // удалённый стол не воскрешать в базе
    try {
      this.store.save(room, gameOf(room).serialize(room, this.clock.now()));
    } catch (err) {
      this.log(err);
    }
  }

  /** After a restart: redraw every live card; open apps reconnect by themselves. */
  async resume() {
    this.syncClocks(); // timers come back with the time that was LEFT, not less
    let drawn = 0;
    for (const room of this.rooms.values()) {
      if (room.status === 'finished') continue;
      try {
        // Staggered: the global ceiling is ~30 messages a second.
        if (drawn++) await new Promise((r) => setTimeout(r, 50));
        await this.draw(room, { immediate: true });
      } catch (err) {
        this.log(err);
      }
    }
    return drawn;
  }

  /* ---------------------------------------------------------- the links */

  /**
   * The group button. A `web_app` button is not allowed in groups, so this is
   * a plain link: with a Mini App registered at @BotFather it opens the app
   * directly (`startapp` arrives signed, inside initData). Without one, it
   * opens the bot's private chat, and the bot answers with a `web_app` button.
   */
  tableLink(room) {
    if (!this.botUsername) return null;
    if (this.miniAppName) return `https://t.me/${this.botUsername}/${this.miniAppName}?startapp=${room.code}`;
    return `https://t.me/${this.botUsername}?start=t_${room.code}`;
  }

  /** The hub of a group: `g_<code>` tells it apart from a room code (which has no `_`). */
  hubLink(group) {
    if (!this.botUsername) return null;
    if (this.miniAppName) return `https://t.me/${this.botUsername}/${this.miniAppName}?startapp=${HUB_PREFIX}${group.code}`;
    return `https://t.me/${this.botUsername}?start=${HUB_PREFIX}${group.code}`;
  }

  /** «Играть с ботом» из группы: ссылка на экран игр с ботами (`startapp=solo`); без Mini App — через личку (`start=solo`). */
  soloLink() {
    if (!this.botUsername) return null;
    if (this.miniAppName) return `https://t.me/${this.botUsername}/${this.miniAppName}?startapp=${SOLO_CODE}`;
    return `https://t.me/${this.botUsername}?start=${SOLO_CODE}`;
  }

  /** A `web_app` button — private chats only. */
  webAppButton(room, text = '🃏 Открыть стол') {
    if (!this.webappUrl) return null;
    return { text, web_app: { url: `${this.webappUrl}/?room=${room.code}` } };
  }

  /* -------------------------------------------------------------- drawing */

  /**
   * Something changed. Everyone at the table gets their own view NOW (a
   * socket has no rate limit), the group card is re-rendered at most once a
   * second (Telegram does), and whoever the game waits for with their app
   * closed gets a nudge.
   */
  draw(room, { immediate = false } = {}) {
    this.profiles.settleNames(room); // ники и аватарки игроков — до того, как строятся виды
    this.collections.settle(room); // collections: снимок оформления (лобби — живой, раздача — заморожен)
    this.syncClocks(); // the view carries the turn deadline: set it first
    this.hub?.broadcast(room);
    // В базу — сразу, а не после ответа Telegram: не принял он карточку
    // (нет прав, сбой сети) — сыгранное всё равно переживёт перезапуск
    // (аудит, E-03). После карточки стол пишется ещё раз — с её номером.
    this.save(room);
    // Партия с ботами живёт только в приложении: ни карточки, ни лички.
    if (room.solo) return Promise.resolve();
    this.track(this.pingTurns(room));
    const produce = async () => {
      const view = gameOf(room).card(room, { link: this.tableLink(room) });
      const kbKey = JSON.stringify(view.keyboard?.length ? { inline_keyboard: view.keyboard } : null);
      const unchanged = room.ui.lastText === view.text && room.ui.lastKb === kbKey;
      const buried = !!room.ui.tableMessageId && (room.ui.lastMsgId || 0) - room.ui.tableMessageId >= 2;
      await this.outbox.draw(room, view, { move: buried && !unchanged });
      this.seen(room, room.ui.tableMessageId);
      this.save(room);
    };
    if (immediate) return produce();
    this.outbox.schedule(room.chatId, produce, room.code);
    return Promise.resolve();
  }

  track(promise) {
    if (!promise) return;
    const p = Promise.resolve(promise).catch((err) => this.log(err)).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  /**
   * Remember the newest message id in a chat — the measure of "buried". A
   * card's own id counts for its own room only: two games' cards must not
   * keep pushing each other to the bottom of the chat.
   */
  seen(room, messageId) {
    if (room && Number.isFinite(messageId)) room.ui.lastMsgId = Math.max(room.ui.lastMsgId || 0, messageId);
  }

  seenInChat(chatId, messageId) {
    for (const room of this.roomsOf(chatId)) this.seen(room, messageId);
  }

  /** Post the card again at the bottom of the chat; the old copy loses its button. */
  async newCard(room) {
    if (room.solo) return this.draw(room);
    this.outbox.cancel(room.chatId, room.code);
    const old = room.ui.tableMessageId;
    if (old) await this.outbox.dropKeyboard(room.chatId, old);
    room.ui.tableMessageId = null;
    room.ui.lastText = null;
    room.ui.lastKb = null;
    await this.draw(room, { immediate: true });
    this.save(room);
  }

  /** Test seam and shutdown: wait until every redraw and ping has gone out. */
  async settle() {
    for (let i = 0; i < 10; i++) {
      await this.outbox.drain();
      if (!this.inflight.size) return;
      await Promise.all([...this.inflight]);
    }
  }

  /* ------------------------------------------------------- "your turn" pings */

  /**
   * Whoever the game is waiting for, if they do not have the app open, gets a
   * private "👉 your turn" with a button that opens it. A ping for a turn that
   * has passed is deleted, so a private chat never fills up with stale calls
   * to act. Poker waits for one player at a time; durak may wait for several
   * (the defender, the players who may still throw in).
   */
  async pingTurns(room) {
    const g = gameOf(room);
    const wanted = () => (room.status === 'playing' ? g.waiting(room) : []);
    const isWanted = (w) => wanted().some((x) => x.id === w.id && x.key === w.key);
    const pings = (room.ui.pings ||= {});
    const want = wanted();
    for (const [uid, last] of Object.entries(pings)) {
      if (want.some((w) => w.id === uid && w.key === last.key)) continue;
      if (pings[uid] === last) delete pings[uid];
      if (last.messageId) await this.outbox.removePrivate(last.tgId, last.messageId);
    }
    for (const w of want) {
      if (room.ui.pings?.[w.id]?.key === w.key) continue;
      if (!isWanted(w)) continue; // the game moved on while we were busy
      const entry = { key: w.key, tgId: null, messageId: null };
      (room.ui.pings ||= {})[w.id] = entry;
      const p = room.players.find((x) => x.id === w.id);
      if (!p || p.dm !== 'ok') continue; // never pressed Start: nobody to write to
      if (this.hub?.isPresent(room.code, p.id)) continue; // looking at the table already
      const link = this.tableLink(room);
      const btn = this.webAppButton(room) || (link ? { text: '🃏 Открыть стол', url: link } : null);
      const r = await this.outbox.dm(p.tgId, g.pingText(room, p, w), btn ? [[btn]] : null);
      if (r.forbidden) this.setDm(p.id, 'fail', { redraw: false });
      if (!r.ok) continue;
      // Only remember it if the turn is still the same one we pinged about.
      if (room.ui.pings?.[w.id] === entry && isWanted(w)) Object.assign(entry, { tgId: p.tgId, messageId: r.message_id });
      else await this.outbox.removePrivate(p.tgId, r.message_id);
    }
  }

  /* ------------------------------------------------------------ the deal */

  /** `{ deck }` for the room layer: stacked in tests, shuffled otherwise. */
  dealOpts(room) {
    // Своя раздача у игры (колода дурака, жребий цвета в шахматах, уроки
    // школы покера): игра сама знает, что ей подменяют в тестах.
    const own = gameOf(room).dealOpts?.(room, this);
    if (own) return own;
    return this.deck ? { deck: () => this.deck(room) } : {};
  }

  /**
   * Can the bot write to this person? Known from Start ('ok'), a bounced
   * message ('fail'), or Telegram telling us they blocked/unblocked the bot.
   */
  setDm(userId, status, { redraw = true } = {}) {
    const id = String(userId);
    if (this.store.getDm(id) !== status) this.store.setDm(id, status);
    for (const room of this.rooms.values()) {
      const p = room.players.find((x) => x.id === id);
      if (!p || p.dm === status) continue;
      p.dm = status;
      if (redraw && room.status !== 'finished') this.draw(room);
    }
  }

  person(user) {
    return { id: user.id, tgId: user.tgId, name: user.name, dm: this.store.getDm(user.id) };
  }

  /**
   * A new game in a group — from /newgame or from the hub. Finished games of
   * this chat that nobody has looked at for a while are cleared out first.
   */
  createGame(gameId, { chatId, title = '', host, settings = null }) {
    const g = GAMES[gameId];
    if (!g) return { error: 'BAD_GAME' };
    this.purgeFinished(chatId);
    const room = g.create({ chatId: String(chatId), title, host: this.person(host), settings });
    if (room.error) return room;
    room.game = g.id;
    // От часов приложения, а не от Date.now() в правилах игры: по этому
    // времени считается возраст стола, и под поддельными часами в тестах
    // оно должно быть поддельным тоже.
    room.createdAt = Math.max(this.clock.now(), ...this.roomsOf(chatId).map((r) => (r.createdAt || 0) + 1));
    this.rooms.set(room.code, room);
    this.note('created', room);
    this.noteLive(room); // с этой секунды идёт отсчёт «за столом никого»
    return room;
  }

  /** Drop a game for good: its card loses the button, open apps are told. */
  async dropGame(room) {
    room.gone = true; // для тех, кто держит ссылку на стол (бот думает в потоке)
    if (room.ui.tableMessageId) await this.outbox.dropKeyboard(room.chatId, room.ui.tableMessageId);
    this.outbox.cancel(room.chatId, room.code);
    this.hub?.forget(room.code);
    this.rooms.delete(room.code);
    this.store.remove(room.code);
    this.syncClocks();
    this.hub?.broadcastGroup(room.chatId);
  }

  purgeFinished(chatId) {
    const now = this.clock.now();
    for (const room of this.roomsOf(chatId)) {
      if (room.status !== 'finished' || now - (room.finishedAt || 0) < FINISHED_KEEP_MS) continue;
      this.hub?.forget(room.code);
      this.rooms.delete(room.code);
      this.store.remove(room.code);
    }
  }

  /** Games of a chat that are not over yet. */
  liveRooms(chatId) {
    return this.roomsOf(chatId).filter((r) => r.status !== 'finished');
  }

  /**
   * Записать в рейтинг всё, что доиграно и ещё не засчитано.
   *
   * Зовётся после каждого хода и в конце игры — это безопасно: партия
   * засчитывается один раз, и за это отвечает не память процесса, а база
   * (строка журнала уникальна по человеку, игре и партии). Перезапуск между
   * концом партии и записью ничего не удвоит и ничего не потеряет.
   *
   * Итог каждой партии кладётся в `room.rated` — из него экран итогов берёт
   * «+20 · 3-е место», а отказ («партия не доиграна») объясняется словами.
   */
  rate(room) {
    // С ботами — тренировка: в рейтинг людей она не идёт.
    if (room.solo) return [];
    const rounds = gameOf(room).rounds?.(room) ?? [];
    if (!rounds.length) return [];
    const seen = (room.rated ||= {});
    const fresh = [];
    for (const r of rounds) {
      if (seen[r.id]) continue;
      let out;
      try {
        out = rateRound(this.store, { ...r, game: room.game, round: r.id, chatId: room.chatId, at: this.clock.now() });
      } catch (err) {
        this.log(err);
        continue; // рейтинг не должен ронять игру: сыграли — и ладно
      }
      seen[r.id] = out;
      fresh.push({ round: r.id, ...out });
    }
    return fresh;
  }

  /** Chips or cards moved: show it — or, if that ended the game, the results. */
  async afterAction(room) {
    // Something the game shows on its own clock (the poker all-in board): it
    // posts the results itself at the end if this was the last hand.
    if (gameOf(room).beginShow?.(this, room)) return this.draw(room);
    this.rate(room); // в дураке партию заканчивает ход, а не сдача следующей
    if (room.status === 'finished') return this.finishUp(room);
    await this.draw(room);
  }

  /** A hand was dealt (or the game ended instead). */
  async afterDeal(room, r) {
    if (r?.finished) return this.finishUp(room);
    this.note('round', room); // раздача в покере, партия в дураке
    this.collections.freeze(room); // collections: снимок оформления этой раздачи, один раз
    // Blinds alone can put everybody all-in: then the board is turned over at
    // once, and that may even end the game on the spot.
    const revealing = gameOf(room).beginShow?.(this, room);
    if (room.status === 'finished' && !revealing) return this.finishUp(room);
    await this.draw(room);
  }

  /** Settings, seats, roles — nothing that could end a hand. */
  async afterChange(room) {
    await this.draw(room);
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
   * Every game's timers, for every room. Idempotent: the game module works out
   * what should be running, this only makes the real timers match — arming
   * new ones, dropping ones nobody needs.
   */
  syncClocks() {
    if (this.down) return this.freezeClocks();
    const now = this.clock.now();
    const live = new Set();
    for (const room of this.rooms.values()) {
      // Ошибка в часах одного стола не должна снимать таймеры всем остальным.
      let clocks;
      try {
        clocks = [...this.coreClocks(room, now), ...(gameOf(room).clocks?.(this, room, now) || []), ...this.botClocks(room, now)];
      } catch (err) {
        this.log(err);
        continue;
      }
      for (const c of clocks) {
        const id = `${c.id}:${room.code}`;
        live.add(id);
        if (!c.keep) this.arm(id, c.timer, c.fire);
      }
    }
    for (const [id, cur] of this.handles) {
      if (!live.has(id)) {
        this.clock.clearTimeout(cur.h);
        this.handles.delete(id);
      }
    }
  }

  /**
   * Обслуживание: часы паркуются, таймеры снимаются. Остаток времени на ход
   * запоминается — за время обслуживания ничьё время не тратится. Бот не
   * ходит за игрока, и простой сервера тем более не должен.
   */
  freezeClocks() {
    const now = this.clock.now();
    for (const room of this.rooms.values()) {
      for (const t of [room.turn, room.autoNext]) {
        if (t && t.deadline != null) {
          t.remaining = Math.max(0, t.deadline - now);
          t.deadline = null;
        }
      }
    }
    for (const cur of this.handles.values()) this.clock.clearTimeout(cur.h);
    this.handles.clear();
  }

  /**
   * Часы самого ядра — одинаковые для всех игр. Пока они одни: на стол,
   * который создали и забыли.
   *
   * Шага два: сперва предупреждение в группу, через минуту — закрытие. Оба
   * идут через один и тот же таймер, потому что `arm` перевзводит его только
   * когда меняется ключ или срок, — а значит, лишний `syncClocks` ничего не
   * сбивает и ничего не дублирует.
   */
  coreClocks(room, now) {
    if (room.solo) {
      // Брошенная партия с ботами: тихо убрать через три часа без единого действия.
      const at = room.solo.seenAt ?? room.createdAt ?? now;
      return [{ id: 'idle', timer: { key: `solo:${at}`, deadline: at + SOLO_IDLE_MS }, fire: () => this.soloIdle(room.code, at) }];
    }
    if (room.status === 'finished') return [];
    const since = room.idleAt ?? room.createdAt ?? now;
    const seated = room.players.filter((p) => !p.left && !p.kicked).length;
    const span = room.status !== 'lobby' ? IDLE_PLAY_MS : seated >= 2 ? IDLE_READY_MS : IDLE_CLOSE_MS;
    const deadline = since + (room.idleWarned ? span : span - IDLE_WARN_MS);
    return [{
      id: 'idle',
      timer: { key: `${room.idleWarned ? 'close' : 'warn'}:${since}`, deadline },
      fire: () => this.idleStep(room),
    }];
  }

  /**
   * Признак жизни за столом: часы отсчитывают заново.
   *
   * Зовётся отовсюду, где человек что-то сделал со столом, — в том числе
   * когда просто открыл его в приложении. Открыл, посмотрел и закрыл — стол
   * всё равно живой: кто-то же его открывал.
   */
  noteLive(room) {
    if (!room || room.status === 'finished' || room.solo || !this.rooms.has(room.code)) return;
    const now = this.clock.now();
    room.idleAt = now;
    room.idleWarned = false;
    // Взводим часы этого стола, а не всех сразу: noteLive зовётся на каждое
    // сообщение страницы, а syncClocks обходит все столы бота.
    for (const c of this.coreClocks(room, now)) this.arm(`${c.id}:${room.code}`, c.timer, c.fire);
  }

  /** Сначала предупреждение, через минуту — закрытие. */
  async idleStep(room) {
    if (!this.rooms.has(room.code) || room.status === 'finished') return;
    const started = room.status !== 'lobby';
    const to = { message_id: room.ui?.tableMessageId };
    if (!room.idleWarned) {
      room.idleWarned = true;
      this.syncClocks(); // теперь таймер ведёт к закрытию, а не к предупреждению
      // С кнопкой, а не голым текстом: до стола минута, и листать чат вверх
      // за карточкой — это ровно то время, которого нет.
      try {
        await this.outbox.post(room.chatId, started ? IDLE_PLAY_WARN_TEXT : IDLE_WARN_TEXT, [[{ text: '🙋 Я тут, играем', url: this.tableLink(room) }]],
          to.message_id ? { reply_parameters: { message_id: to.message_id, allow_sending_without_reply: true } } : {});
      } catch (err) {
        this.log(err);
      }
      return;
    }
    if (started) {
      // Начатая партия: не стираем, а завершаем — итоги и рейтинг уходят как после /finish.
      if (!this.claimIdleGame(room)) return;
      await this.finishUp(room);
      await this.reply(room.chatId, IDLE_PLAY_CLOSED_TEXT, to);
      return;
    }
    if (!this.claimIdle(room)) return;
    // Стола уже нет в списке. Дальше — только показать это людям: убрать
    // кнопку с карточки, вернуть открытые приложения в хаб, объяснить словами.
    const chatId = room.chatId;
    await this.dropGame(room);
    await this.reply(chatId, IDLE_CLOSED_TEXT, to);
  }

  /**
   * Забрать заброшенный стол себе — ОДНИМ синхронным шагом, до первого
   * обращения к Telegram.
   *
   * Сеть идёт сотни миллисекунд, и за это время в бот успевает прийти что
   * угодно. Пока решение «закрываем» растянуто на время сети, оно двоится:
   *
   *   — успевает сработать второй таймер (его перевзводит любой `syncClocks`,
   *     а срок уже прошёл) — и стол закрывается дважды, с двумя грустными
   *     сообщениями в группу и двумя записями в журнал;
   *   — успевает прийти признак жизни: человек открыл стол ровно в эту
   *     секунду, а его сносят под ним.
   *
   * После этого шага стола нет ни в списке, ни в базе: второй таймер уйдёт
   * ни с чем, а `noteLive` на несуществующий стол тоже ничего не сделает.
   * Окна больше нет — не «обработано», а нет.
   */
  claimIdle(room) {
    if (!this.rooms.has(room.code) || room.status !== 'lobby' || !room.idleWarned) return false;
    this.rooms.delete(room.code);
    this.store.remove(room.code);
    this.note('idle', room);
    this.syncClocks(); // таймера у этого стола больше нет
    return true;
  }

  /**
   * То же, что `claimIdle`, но для начатой партии: завершить её ОДНИМ
   * синхронным шагом. Пока `endGame` не вернулся, признак жизни ещё успевает
   * отменить закрытие (`idleWarned` сбрасывается); после — партия уже
   * `finished`, и второй таймер уходит ни с чем.
   */
  claimIdleGame(room) {
    if (!this.rooms.has(room.code) || room.status === 'finished' || room.status === 'lobby' || !room.idleWarned) return false;
    const r = gameOf(room).endGame(room, room.hostId, this.clock.now());
    if (r.error || r.noop) return false;
    this.note('idle', room);
    return true;
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

  /** A one-off step on a game's own clock (the poker board, street by street). */
  after(id, key, ms, fn) {
    const cur = this.handles.get(id);
    if (cur) this.clock.clearTimeout(cur.h);
    const h = this.clock.setTimeout(() => {
      this.handles.delete(id);
      return this.guard(fn);
    }, ms);
    this.handles.set(id, { key, deadline: null, h });
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

  /* ------------------------------------------------------------- messages */

  async onMessage(msg) {
    if (msg.chat?.type === 'private') return this.onPrivate(msg);

    const chatId = String(msg.chat.id);

    // A group promoted to a supergroup changes chat.id. Re-key its games or
    // they are silently lost the moment somebody upgrades the group.
    if (msg.migrate_to_chat_id) return this.migrate(chatId, String(msg.migrate_to_chat_id));

    if (msg.left_chat_member) return this.onLeft(chatId, msg.left_chat_member);
    if (msg.new_chat_members?.length) return this.onJoined(chatId, msg.new_chat_members);
    if (typeof msg.text !== 'string') return;

    this.seenInChat(chatId, msg.message_id);
    // «Ща доиграю и сяду» в чате — это тоже «мы тут». Стол держит только
    // тот, кто за ним сидит, и только свой: чужая болтовня в группе ничьих
    // столов не продлевает.
    const who = String(msg.from?.id || '');
    for (const room of this.roomsOf(chatId)) {
      if (room.status === 'lobby' && room.players.some((p) => String(p.id) === who && !p.left && !p.kicked)) {
        this.noteLive(room);
      }
    }
    const cmd = parseCommand(msg.text, this.botUsername);
    if (!cmd) return;
    return this.onCommand(cmd, msg);
  }

  /**
   * The private chat. Start here is what lets the bot send "your turn".
   * `/start t_<code>` (a table) and `/start g_<code>` (a group's hub) come
   * from the group buttons when no Mini App is registered at @BotFather: the
   * answer is a `web_app` button, which Telegram allows in private chats only.
   * Nothing here seats anybody anywhere — a deep-link payload is text the
   * user controls.
   */
  async onPrivate(msg) {
    const who = identify(msg.from, msg.sender_chat);
    if (!who.ok) return;
    const user = who.user;
    this.setDm(user.id, 'ok'); // any private message means the chat is open

    const cmd = typeof msg.text === 'string' ? parseCommand(msg.text, this.botUsername) : null;
    if (cmd?.cmd === 'start') {
      const m = /^t_([a-z0-9]{4,32})$/.exec(cmd.rest);
      const room = m ? this.roomByCode(m[1]) : null;
      if (room) {
        const btn = this.webAppButton(room);
        const g = gameOf(room);
        const text = btn
          ? `${g.icon} ${g.id === 'poker' ? 'Стол' : g.title}${room.title ? ` «${esc(room.title)}»` : ''} — открывайте:`
          : 'Стол есть, но адрес мини-приложения не настроен (WEBAPP_URL). Скажите тому, кто запускает бота.';
        return void (await this.outbox.post(user.tgId, text, btn ? [[btn]] : null));
      }
      // Кнопка «🤖 Играть с ботом» под карточкой группы, когда у бота нет зарегистрированного Mini App.
      if (cmd.rest === SOLO_CODE) return this.sendSolo(user);
      if (!cmd.rest) return this.sendMyGames(user, `${WELCOME_DM}\n\n${HELP_DM}`);
      const gm = /^g_([a-z0-9]{4,32})$/.exec(cmd.rest);
      const group = gm ? this.groupByCode(gm[1]) : null;
      if (group) {
        const btn = this.webappUrl ? { text: '🎮 Выбрать игру', web_app: { url: `${this.webappUrl}/?room=${HUB_PREFIX}${group.code}` } } : null;
        const text = btn
          ? `🎮 Игры группы${group.title ? ` «${esc(group.title)}»` : ''} — открывайте:`
          : 'Адрес мини-приложения не настроен (WEBAPP_URL). Скажите тому, кто запускает бота.';
        return void (await this.outbox.post(user.tgId, text, btn ? [[btn]] : null));
      }
      return void (await this.outbox.post(user.tgId, WELCOME_DM));
    }
    if (cmd?.cmd === 'admin' && this.isAdmin(user.id)) return this.sendAdmin(user);
    // Владельцу обслуживание не мешает: ему как раз и надо его снять.
    if (this.down && !this.isAdmin(user.id)) {
      return void (await this.outbox.post(user.tgId, `⏸ <b>Идёт обслуживание</b>\n${esc(this.downText)}`));
    }
    if (['game', 'play', 'games', 'newgame'].includes(cmd?.cmd)) return this.sendMyGames(user);
    if (['bot', 'solo', ...Object.keys(QUICK_GAMES), 'poker'].includes(cmd?.cmd)) return this.sendSolo(user);
    return void (await this.outbox.post(user.tgId, HELP_DM));
  }

  /**
   * Кнопка в админку. Не админу `/admin` отвечает обычной справкой — о том,
   * что команда вообще есть, знать ему незачем.
   */
  async sendAdmin(user) {
    const btn = this.webappUrl ? { text: '📊 Админка', web_app: { url: `${this.webappUrl}/?room=admin` } } : null;
    const text = btn ? '📊 Цифры по игре — открывайте:' : 'Адрес мини-приложения не настроен (WEBAPP_URL).';
    await this.outbox.post(user.tgId, text, btn ? [[btn]] : null);
  }

  /**
   * In private the bot does not know which group you mean — the Mini App
   * does not either. So the button opens the app without a group, and the
   * app shows the groups you play in (see hub.js, `groupsOf`).
   */
  async sendMyGames(user, lead = null) {
    const mine = this.groupsOf(user.id);
    const rows = [];
    if (this.webappUrl && mine.length) rows.push([{ text: '🎮 Открыть игры', web_app: { url: `${this.webappUrl}/` } }]);
    if (this.webappUrl) rows.push([{ text: '🤖 Играть с ботом', web_app: { url: `${this.webappUrl}/?room=${SOLO_CODE}` } }]);
    const text = mine.length
      ? `${lead ? `${lead}\n\n` : ''}🎮 Игры ваших групп — открывайте. Или сыграйте с ботами прямо здесь.`
      : `${lead ? `${lead}\n\n` : ''}Игры с друзьями создаются в группе: добавьте меня в группу и напишите там /game.\nА с ботами можно играть прямо здесь.`;
    await this.outbox.post(user.tgId, text, rows.length ? rows : null);
  }

  /** «Играть с ботом» из лички: кнопка в приложение, на экран игр с ботами. */
  async sendSolo(user) {
    const btn = this.webappUrl ? { text: '🤖 Играть с ботом', web_app: { url: `${this.webappUrl}/?room=${SOLO_CODE}` } } : null;
    const text = btn ? '🤖 Партия с ботами — выбирайте игру и уровень:' : 'Адрес мини-приложения не настроен (WEBAPP_URL).';
    await this.outbox.post(user.tgId, text, btn ? [[btn]] : null);
  }

  /**
   * The groups this person plays in: they wrote a command there, or they sit
   * at one of its games. The only groups a page opened without a group may
   * show — the bot never lists a group to somebody it has not seen in it.
   */
  groupsOf(userId) {
    const id = String(userId);
    const out = new Map();
    for (const g of this.groups.values()) if (g.members?.includes(id)) out.set(g.chatId, g);
    for (const room of this.rooms.values()) {
      if (out.has(room.chatId) || room.status === 'finished' || room.solo) continue;
      if (room.players.some((p) => p.id === id && !p.kicked && !p.left)) out.set(room.chatId, this.ensureGroup(room.chatId, room.title));
    }
    return [...out.values()];
  }

  /** Somebody used a command in this group: they are one of its players. */
  noteMember(chatId, userId, title = '') {
    const g = this.ensureGroup(chatId, title, { save: false });
    const id = String(userId);
    g.members = g.members || [];
    if (!g.members.includes(id)) {
      g.members.push(id);
      if (g.members.length > 200) g.members.shift();
    }
    this.saveGroup(g);
    return g;
  }

  async onCommand(cmd, msg) {
    const chatId = String(msg.chat.id);
    const who = identify(msg.from, msg.sender_chat);

    if (this.down) {
      // Обслуживание: ни одной новой игры и ни одной карточки. Ответить всё
      // равно надо — иначе похоже, что бот умер.
      if (['game', 'play', 'games', 'newgame', 'poker', 'table', 'finish', 'cancel', ...Object.keys(QUICK_GAMES)].includes(cmd.cmd)) {
        return void (await this.reply(chatId, `⏸ <b>Идёт обслуживание</b>\n${esc(this.downText)}`, msg));
      }
    }
    if (cmd.cmd === 'start' || cmd.cmd === 'help') return void (await this.reply(chatId, HELP));
    if (!who.ok) return void (await this.reply(chatId, who.text, msg));

    const user = who.user;
    this.noteMember(chatId, user.id, msg.chat.title);

    switch (cmd.cmd) {
      case 'game':
      case 'play':
      case 'games': {
        const group = this.ensureGroup(chatId, msg.chat.title);
        await this.postHub(group);
        return;
      }

      case 'newgame':
      case 'poker': {
        const table = this.liveRooms(chatId).filter((r) => r.game === 'poker').at(-1);
        if (table) {
          return void (await this.reply(
            chatId,
            `Стол уже есть, хост — ${esc(nameOf(table, table.hostId))}. /table — показать его. ` +
              'Новый — после /finish или /cancel. Ещё одна игра — /game.',
            msg
          ));
        }
        // Предел общий для обеих дверей: он бережёт группу от свалки
        // карточек, и команде обходить его не за что.
        if (this.liveRooms(chatId).length >= MAX_LIVE_PER_GROUP) {
          return void (await this.reply(chatId, TOO_MANY_GAMES_TEXT, msg));
        }
        // As it always did, a new table replaces a poker table that is over.
        for (const old of this.roomsOf(chatId)) {
          if (old.game !== 'poker' || old.status !== 'finished') continue;
          this.hub?.forget(old.code);
          this.rooms.delete(old.code);
          this.store.remove(old.code);
        }
        const fresh = this.createGame('poker', { chatId, title: msg.chat.title, host: user });
        await this.newCard(fresh);
        this.hub?.broadcastGroup(chatId);
        return;
      }

      case 'table': {
        const live = this.liveRooms(chatId);
        if (!live.length) {
          const last = this.room(chatId);
          if (!last) return void (await this.reply(chatId, 'Игр нет. /game — выбрать игру.', msg));
          await this.newCard(last);
          return;
        }
        for (const room of live) await this.newCard(room);
        return;
      }

      case 'finish': {
        const room = this.hostTarget(chatId, user.id, { finished: true, code: cmd.rest });
        if (room?.ambiguous) return void (await this.reply(chatId, this.whichGame(room.ambiguous, 'finish'), msg));
        if (!room) {
          const any = this.liveRooms(chatId).at(-1) || this.room(chatId);
          return void (await this.reply(chatId, any ? this.hostOnly(any) : 'Стола нет.', msg));
        }
        const r = gameOf(room).endGame(room, user.id, this.clock.now());
        if (r.error) return void (await this.reply(chatId, this.hostOnly(room), msg));
        // Игра уже завершена: итоги в группе есть — повтор их не дублирует.
        if (r.noop) return void (await this.reply(chatId, ALREADY_FINISHED_TEXT, msg));
        await this.finishUp(room);
        return;
      }

      case 'cancel': {
        const room = this.hostTarget(chatId, user.id, { finished: true, code: cmd.rest });
        if (room?.ambiguous) return void (await this.reply(chatId, this.whichGame(room.ambiguous, 'cancel'), msg));
        if (!room) {
          const any = this.liveRooms(chatId).at(-1) || this.room(chatId);
          if (any) await this.reply(chatId, this.hostOnly(any), msg);
          return;
        }
        await this.dropGame(room);
        await this.reply(chatId, room.game === 'poker' ? 'Стол удалён. /newgame — создать новый.' : `${gameOf(room).icon} ${gameOf(room).title}: игра удалена. /game — новая игра.`);
        return;
      }

      default: {
        // /chess, /durak, /unoq — лобби одной командой, без захода в приложение.
        const gameId = QUICK_GAMES[cmd.cmd];
        if (gameId) return this.quickLobby(chatId, msg, user, gameId);
        return;
      }
    }
  }

  /**
   * Быстрое лобби: `/chess` — и в группе уже карточка с «Присоединиться».
   * Настройки — по умолчанию; их можно поменять в приложении, не выходя из
   * лобби. У дуэли хост может открыть несколько лобби подряд; у остальных игр
   * действует прежнее правило «одно открытое лобби на хоста» — тогда бот
   * просто напоминает о нём (карточка снова внизу чата).
   */
  async quickLobby(chatId, msg, user, gameId) {
    const g = GAMES[gameId];
    this.ensureGroup(chatId, msg.chat.title);
    if (g.maxPlayers !== 2) {
      const mine = this.liveRooms(chatId).find((r) => r.game === gameId && r.status === 'lobby' && r.hostId === String(user.id));
      if (mine) {
        await this.newCard(mine);
        return void (await this.reply(chatId, `У вас уже есть открытое лобби: ${g.icon} ${g.title}. Карточка выше.`, msg));
      }
    }
    if (this.liveRooms(chatId).length >= MAX_LIVE_PER_GROUP) {
      return void (await this.reply(chatId, TOO_MANY_GAMES_TEXT, msg));
    }
    const room = this.createGame(gameId, { chatId, title: msg.chat.title, host: user });
    if (room.error) return void (await this.reply(chatId, 'Не получилось создать лобби. Попробуйте ещё раз.', msg));
    await this.newCard(room);
    this.hub?.broadcastGroup(chatId);
  }

  /**
   * The game a host's command is about: the newest one they run in this chat.
   * Хост нескольких живых игр (дуэли разрешают несколько лобби сразу) без
   * кода не получает угадывания: бот не знает, какую из них он имел в виду, и
   * удалять «самую свежую» наугад нельзя — вернётся `{ ambiguous }`.
   */
  hostTarget(chatId, userId, { finished = false, code = '' } = {}) {
    const mine = (list) => list.filter((r) => r.hostId === String(userId));
    const live = mine(this.liveRooms(chatId));
    const want = String(code || '').trim().toUpperCase();
    if (want) return [...live, ...(finished ? mine(this.roomsOf(chatId)) : [])].find((r) => r.code.toUpperCase() === want) || null;
    if (live.length > 1) return { ambiguous: live };
    return live[0] || (finished ? mine(this.roomsOf(chatId)).at(-1) || null : null);
  }

  /**
   * «У вас несколько игр» — какую именно, пусть скажет сам хост кодом.
   *
   * К названию добавлена подробность игры: у дуэлей несколько столов одного
   * хоста это норма, и строки «♟ Шахматы — /cancel ABCD» отличались бы только
   * кодом. По коду выбрать можно, но узнать в нём нужный стол нельзя — а
   * «5 мин + 2 с · партия 2» человек со своей партией сопоставит.
   */
  whichGame(rooms, cmd) {
    const lines = rooms.map((r) => {
      const g = gameOf(r);
      const detail = g.summary(r)?.detail || '';
      return `${g.icon} ${g.title}${detail ? ` · ${detail}` : ''} — /${cmd} ${r.code}`;
    });
    return ['У вас несколько игр — какая именно?', ...lines].join('\n');
  }

  /** «🎮 Во что играем?» — the card that opens the Mini App for this group. */
  async postHub(group) {
    const old = group.ui?.hubMessageId;
    if (old) await this.outbox.dropKeyboard(group.chatId, old);
    const link = this.hubLink(group);
    const lines = ['🎮 <b>Во что играем?</b>', ''];
    for (const g of GAME_LIST) lines.push(`${g.icon} <b>${g.title}</b> — ${esc(g.blurb)}, ${g.minPlayers}–${g.maxPlayers} игроков`);
    lines.push('', '<i>Откройте приложение, выберите игру и создайте лобби — друзья присоединятся по его карточке. А если друзей рядом нет — можно сыграть с ботом.</i>');
    // Играть с ботом — личная партия: подпись Telegram даёт ей личность того, кто нажал, а не группы.
    const solo = this.soloLink();
    const rows = link ? [[{ text: '🎮 Выбрать игру', url: link }], ...(solo ? [[{ text: '🤖 Играть с ботом', url: solo }]] : [])] : null;
    try {
      const m = await this.outbox.post(group.chatId, lines.join('\n'), rows);
      group.ui = { ...(group.ui || {}), hubMessageId: m?.message_id ?? null };
      this.seenInChat(group.chatId, m?.message_id);
    } catch (err) {
      this.log(err);
    }
    this.saveGroup(group);
  }

  /**
   * Buttons from before the game moved to the Mini App may still sit in the
   * chat. Every press is answered — a silent one leaves a spinner and looks
   * like a dead bot.
   */
  async onCallback(cq) {
    const who = identify(cq.from);
    if (!who.ok) return this.outbox.answer(cq.id, who.text, { alert: true });
    // «🔕 Не присылать такое» под рассылкой — единственная кнопка, которая
    // работает и во время обслуживания: отписка не может ждать.
    if (cq.data === ADS_OFF) {
      this.store.setAds(who.user.id, 'off');
      return this.outbox.answer(cq.id, 'Больше не пришлю. Сообщения про вашу игру останутся.', { alert: true });
    }
    if (this.down) return this.outbox.answer(cq.id, `⏸ Идёт обслуживание. ${this.downText}`, { alert: true });
    const room = this.room(cq.message?.chat?.id ?? '');
    const link = room ? this.tableLink(room) : null;
    if (link && this.miniAppName) return this.outbox.answer(cq.id, '', { url: link });
    return this.outbox.answer(cq.id, 'Игра теперь идёт в мини-приложении — нажмите «Открыть стол».', { alert: true });
  }

  /* ----------------------------------------------------- chat membership */

  async onLeft(chatId, member) {
    for (const room of this.liveRooms(chatId)) {
      const r = gameOf(room).markLeft(room, member.id, this.clock.now());
      if (r.error) continue;
      await this.afterAction(room);
    }
  }

  async onJoined(chatId, members) {
    const me = members.find((m) => m.is_bot && this.botUsername && m.username === this.botUsername);
    if (me) await this.reply(chatId, HELP);
  }

  async onMyChatMember(u) {
    const status = u.new_chat_member?.status;
    // In a private chat this is the only notice that somebody blocked the bot
    // (or unblocked it): exactly the "can we send a ping" signal.
    if (u.chat?.type === 'private') {
      const id = u.from?.id ?? u.chat.id;
      if (status === 'kicked') this.setDm(id, 'fail');
      else if (status === 'member') this.setDm(id, 'ok');
      return;
    }
    // Бота добавили в группу — запомнить её сразу, даже если там ещё никто не
    // играл: иначе рассылка в группы о ней не узнает (списка своих чатов
    // Telegram боту не даёт).
    if ((status === 'member' || status === 'administrator') && u.chat?.id != null) {
      this.ensureGroup(String(u.chat.id), u.chat.title || '');
      return;
    }
    if (status === 'left' || status === 'kicked') return this.leftChat(String(u.chat.id));
  }

  /** Бота в группе больше нет: столы, хаб и запись группы — убрать. */
  leftChat(chatId) {
    // СНАЧАЛА УБРАТЬ, ПОТОМ РАССКАЗАТЬ.
    //
    // Тем, кому мы расскажем, страница тут же задаёт следующий вопрос —
    // «а что у меня осталось?» — и ответ она должна получить про уже
    // убранное. Пока разборка шла вперемешку с рассказом, человека уводили
    // к своим группам и показывали в списке ту самую группу, из которой
    // его только что выгнали: нажми — и получишь отказ.
    const codes = this.roomsOf(chatId).map((r) => r.code);
    for (const code of codes) this.rooms.delete(code);
    const group = this.groups.get(chatId);
    this.groups.delete(chatId);
    this.store.removeChat(chatId);
    this.syncClocks();
    for (const code of codes) this.hub?.forget(code);
    if (group) this.hub?.forgetGroup(group.code);
  }

  async migrate(oldId, newId) {
    const rooms = this.roomsOf(oldId);
    for (const room of rooms) {
      room.chatId = newId;
      // Message ids do not survive the migration either. The room code does,
      // so every open table keeps working without anybody noticing.
      room.ui.tableMessageId = null;
      room.ui.lastText = null;
      room.ui.lastKb = null;
      room.ui.lastMsgId = 0;
      gameOf(room).onMigrate?.(room);
    }
    const group = this.groups.get(oldId);
    if (group) {
      this.groups.delete(oldId);
      group.chatId = newId;
      group.ui = { hubMessageId: null };
      this.groups.set(newId, group);
    }
    this.store.migrate(oldId, newId);
    if (group) this.saveGroup(group);
    for (const room of rooms) this.save(room);
    for (const room of rooms) if (room.status !== 'finished') await this.newCard(room);
  }

  /* --------------------------------------------------------------- finish */

  async finishUp(room) {
    // The card says the game is over; the results go below it as their own
    // message — the one message of the evening worth a notification.
    const g = gameOf(room);
    if (room.solo) {
      // Итоги партии с ботами — на экране игрока, не в чате.
      this.note('finished', room);
      g.onFinish?.(room);
      this.hub?.broadcast(room);
      this.save(room);
      this.syncClocks();
      return;
    }
    this.rate(room);
    this.note('finished', room);
    this.outbox.cancel(room.chatId, room.code);
    g.onFinish?.(room);
    this.hub?.broadcast(room);
    this.track(this.pingTurns(room)); // drops any "your turn" still hanging around
    if (room.ui.tableMessageId) {
      try {
        await this.outbox.draw(room, g.card(room, { link: this.tableLink(room) }));
      } catch (err) {
        this.log(err);
      }
    }
    await this.outbox.post(room.chatId, g.results(room));
    this.save(room);
  }

  /* ---------------------------------------------------------------- utils */

  /** A message in the group; as a reply when it answers somebody's command. */
  async reply(chatId, text, toMsg = null) {
    try {
      const m = await this.outbox.post(chatId, text, null, toMsg ? { reply_parameters: replyTo(toMsg) } : {});
      this.seenInChat(chatId, m?.message_id);
      return m;
    } catch (err) {
      this.log(err);
      return null;
    }
  }

  /* ------------------------------------------------------ игры с ботами */

  /**
   * Партия с ботами — «одиночная»: без группы, без карточки в чате, без
   * рейтинга. Стол живёт под своим ключом `solo:<id>`, который никогда не
   * совпадёт с id телеграм-чата. На человека — одна такая партия: новая
   * заменяет прежнюю.
   *
   * Боты садятся как обычные игроки (`bot.seat` игры), а партия сразу
   * начинается — хост здесь сам человек, и ждать некого.
   */
  async createSolo(gameId, user, raw = {}) {
    const g = GAMES[gameId];
    if (!g?.bot) return { error: 'BAD_GAME' };
    const chatId = `solo:${user.id}`;
    // Старые убираются синхронно, без единого await до создания новой: иначе
    // две страницы одного человека, начавшие партию разом, оставляли две
    // живые партии (аудит, E-05). dropGame стола с ботами синхронен до конца
    // — у него нет карточки в чате.
    for (const old of this.roomsOf(chatId)) {
      if (old.status !== 'finished') this.track(this.dropGame(old));
      else {
        old.gone = true;
        this.hub?.forget(old.code);
        this.rooms.delete(old.code);
        this.store.remove(old.code);
      }
    }
    const settings = g.bot.settings ? g.bot.settings(raw) : raw;
    const room = this.createGame(gameId, { chatId, title: '', host: user, settings });
    if (room.error) return room;
    room.solo = { owner: String(user.id), seenAt: this.clock.now(), raw: soloRaw(raw) };
    g.bot.prepare?.(room, raw);
    const lineup = g.bot.lineup(raw, this.botRng);
    lineup.forEach((spec, i) => g.bot.seat(room, spec, i));
    let refused = null;
    await g.handle({
      app: this, hub: this.hub, session: { user, send() {}, visible: true }, room, uid: String(user.id),
      msg: { t: 'start' }, refuse: (code) => { refused = code; }, push() {},
    });
    if (refused) this.log(new Error(`solo start refused: ${refused}`));
    // Пока партия начиналась, её уже заменила другая страница того же человека.
    if (room.gone) return this.soloOf(user.id) || { error: 'BAD_GAME' };
    this.save(room);
    return room;
  }

  /** Живая партия с ботами этого человека, если есть. */
  soloOf(userId) {
    return this.liveRooms(`solo:${userId}`).at(-1) || null;
  }

  /** Три часа тишины: партию с ботами убрать без единого сообщения. */
  async soloIdle(code, at) {
    const room = this.rooms.get(code);
    if (!room?.solo || (room.solo.seenAt ?? room.createdAt) !== at) return;
    this.note('idle', room);
    await this.dropGame(room);
  }

  /**
   * Часы ботов: кого из ботов ждёт игра — тот через «человеческую» паузу и
   * ходит. Один таймер на стол: следующий бот ждёт, пока сходит этот, — как за
   * настоящим столом. Срок запоминается в комнате, чтобы лишняя перерисовка
   * его не отодвигала.
   */
  botClocks(room, now) {
    const g = gameOf(room);
    if (!g.bot || room.status !== 'playing' || !room.players.some((p) => p.bot)) {
      room.botDue = null;
      return [];
    }
    const w = this.botWaits(room)[0];
    if (!w) {
      room.botDue = null;
      return [];
    }
    const key = `${w.id}:${w.key}`;
    if (room.botDue?.key !== key) {
      const p = room.players.find((x) => x.id === w.id);
      const wait = Number(g.bot.delay?.(room, p, w, this.botRng));
      room.botDue = { key, deadline: now + (Number.isFinite(wait) && wait >= 0 ? wait : 900) };
    }
    const code = room.code;
    return [{ id: 'bot', timer: { key, deadline: room.botDue.deadline }, fire: () => this.botAct(code, key) }];
  }

  /**
   * Чего игра ждёт от ботов: ответы и реплики (`wants`: ответ на ничью, крик
   * «UNOQ!», «Поймал!») — первыми, потом ход, как от любого игрока. Реплика
   * про то, что только что случилось, и не ждёт, пока сходит следующий.
   */
  botWaits(room) {
    const g = gameOf(room);
    const isBot = (id) => !!room.players.find((p) => p.id === id)?.bot;
    return [...(g.bot?.wants?.(room, this.clock.now()) || []), ...g.waiting(room)].filter((w) => isBot(w.id));
  }

  /**
   * Бот ходит. Как человек: ему строится ЕГО вид стола (`view` — ровно то, что
   * увидел бы человек на его месте, без чужих карт), он выбирает действие, и
   * оно идёт через тот же `handle` с теми же проверками. Отказ — запасное
   * действие игры (сброс, «беру», «пас»): бот никогда не держит стол.
   */
  async botAct(code, key) {
    const room = this.rooms.get(code);
    if (!room || room.botDue?.key !== key) return;
    room.botDue = null;
    const g = gameOf(room);
    const current = () => this.botWaits(room).find((x) => `${x.id}:${x.key}` === key);
    const w = current();
    if (!w) return this.syncClocks();
    const me = room.players.find((p) => p.id === w.id);
    const now = this.clock.now();
    const view = g.view(room, me.id, { now, botUsername: '' });
    let msg = null;
    try {
      msg = await g.bot.decide({ room, view, me, wait: w, rng: this.botRng, now });
    } catch (err) {
      this.log(err);
    }
    // Пока бот думал, партия могла уйти дальше (человек сдался, обслуживание).
    if (!this.rooms.has(code) || this.down || !current()) return this.syncClocks();
    let refused = null;
    const run = (m) => g.handle({
      app: this, hub: this.hub, session: { user: { id: me.id, tgId: 0, name: me.name }, send() {}, visible: true },
      room, uid: me.id, msg: m, refuse: (c) => { refused = c; }, push() {},
    });
    if (msg) await run(msg);
    if (!msg || refused) {
      refused = null;
      const fb = g.bot.fallback?.(g.view(room, me.id, { now: this.clock.now(), botUsername: '' }), w);
      if (fb && current()) await run(fb);
      if (refused) this.log(new Error(`бот ${me.id} в ${code} не смог сходить: ${refused}`));
    }
    this.syncClocks();
  }

  /** Ссылка на приложение для рекламы в шеринге — без привязки к группе или столу. */
  appLink() {
    if (!this.botUsername) return null;
    return this.miniAppName ? `https://t.me/${this.botUsername}/${this.miniAppName}` : `https://t.me/${this.botUsername}`;
  }

  /**
   * «Поделиться итогом»: сообщение, которое игрок отправит В ВЫБРАННЫЙ ЧАТ ОТ
   * СВОЕГО ИМЕНИ (Bot API 8.0: `savePreparedInlineMessage` → в приложении
   * `Telegram.WebApp.shareMessage`). Бот сам ничего никуда не шлёт: человек
   * выбирает чат и жмёт «отправить». Внизу сообщения — имя бота и кнопка
   * «играть»: это и есть реклама.
   *
   * Поделиться может только игрок этого стола и только итогом сыгранной
   * партии. Если Telegram не принял заготовку (старый клиент, старое API), в
   * ответе остаются текст и ссылка — страница откроет обычное «поделиться
   * ссылкой».
   *
   * @returns {{ error: string } | { id: string|null, plain: string, link: string }}
   */
  async prepareShare(room, user) {
    const me = room.players.find((p) => p.id === String(user.id) && !p.kicked);
    if (!me) return { error: 'NOT_IN_GAME' };
    const g = gameOf(room);
    const link = this.appLink();
    const card = g.shareText?.(room, String(user.id), { botUsername: this.botUsername });
    if (!card) return { error: 'NOT_SHAREABLE' };
    if (!link) return { error: 'SHARE_UNAVAILABLE' };
    const now = this.clock.now();
    const last = this.lastShare.get(String(user.id)) ?? 0;
    if (now - last < 2000) return { error: 'TOO_FAST' };
    this.lastShare.set(String(user.id), now);
    let id = null;
    try {
      const prepared = await this.api.savePreparedInlineMessage?.(Number(user.tgId), {
        type: 'article',
        id: crypto.randomBytes(8).toString('hex'),
        title: card.title,
        description: card.plain.split('\n')[0],
        input_message_content: { message_text: card.html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
        reply_markup: { inline_keyboard: [[{ text: card.button, url: link }]] },
      }, { allow_user_chats: true, allow_bot_chats: false, allow_group_chats: true, allow_channel_chats: false });
      id = prepared?.id ?? null;
    } catch (err) {
      this.log(err); // не вышло — страница обойдётся ссылкой
    }
    return { id, plain: card.plain, link };
  }

  hostOnly(room) {
    return `Это может только хост — ${esc(nameOf(room, room.hostId))}.`;
  }
}

/* -------------------------------------------------------------- helpers */

/**
 * Настройки партии с ботами — для «Сыграть ещё». Хранится только то, что
 * понимают формы игр, и только простые значения: тело сообщения от страницы
 * не попадает в базу как есть.
 */
function soloRaw(raw = {}) {
  const out = {};
  for (const k of ['level', 'opponents', 'base', 'inc', 'bb', 'stack']) if (Number.isFinite(Number(raw[k]))) out[k] = Number(raw[k]);
  for (const k of ['side', 'variant', 'grow']) if (typeof raw[k] === 'string') out[k] = raw[k].slice(0, 16);
  if (raw.learn === true) out.learn = true;
  if (Number.isFinite(Number(raw.lesson))) out.lesson = Number(raw.lesson);
  if (Array.isArray(raw.types)) out.types = raw.types.slice(0, 8).map((x) => (typeof x === 'string' ? x.slice(0, 16) : null));
  return out;
}

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
