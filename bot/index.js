'use strict';
/**
 * Entry point: long polling + wiring. All the logic lives in `app.js`, which
 * is why this file is short and has no tests of its own — there is nothing
 * here but plumbing.
 *
 * WHY grammY. The project is ESM with no build step, and grammY is ESM-native,
 * so it drops in without a transpiler. Its API surface is small and typed
 * (real JSDoc inference in an editor, no TypeScript required), its docs are
 * the best in this ecosystem, and — the deciding factor — `bot.api` is a
 * plain object of methods, which makes the whole bot testable by swapping it
 * for a stub. Telegraf would also work; its middleware/context model is
 * heavier and its API is harder to fake cleanly.
 *
 * WHY LONG POLLING. grammY's built-in poller processes updates strictly one
 * at a time, and needs no webhook registration. The Mini App does need a
 * public HTTPS address (Telegram opens nothing else), but that is a plain
 * static page plus a WebSocket on PORT — a tunnel in front of a laptop is
 * enough. Races between two people tapping at once cannot happen either way:
 * every change to a room is a synchronous function on a single thread. The
 * cost is that the process must stay awake — see README for hosting.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot } from 'grammy';
import { App } from './app.js';
import { Store } from './store.js';
import { Hub } from './hub.js';
import { startServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * `.env` in the project root, if there is one — so the token lives in a file
 * that git ignores instead of in shell history. A real environment variable
 * wins over the file: hosting panels set those, and they must not be
 * silently overridden by a stray local file. Built into Node, no dependency.
 */
const ENV_FILE = path.join(__dirname, '..', '.env');
try {
  process.loadEnvFile(ENV_FILE);
} catch (err) {
  if (err?.code !== 'ENOENT') console.error(`[bot] не удалось прочитать ${ENV_FILE}:`, err.message);
}

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error(
    'BOT_TOKEN не задан. Получите токен у @BotFather и положите его в файл .env в корне проекта:\n' +
      '  BOT_TOKEN=123456:AA...\n' +
      'или задайте переменную окружения BOT_TOKEN на хостинге.'
  );
  process.exit(1);
}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bot.db');
const DRAW_INTERVAL_MS = Number(process.env.DRAW_INTERVAL_MS || 1000);
const PORT = Number(process.env.PORT || 8080);
/** Public HTTPS address of this process — Telegram opens Mini Apps over HTTPS only. */
const WEBAPP_URL = (process.env.WEBAPP_URL || '').replace(/\/+$/, '');
/** Short name of the Mini App registered with @BotFather (/newapp). */
const MINIAPP = (process.env.MINIAPP || '').trim();

const bot = new Bot(TOKEN);
const store = new Store(DB_PATH);

/**
 * Первый разговор с Telegram: он же проверка токена. Показать тут стек —
 * значит оставить человека с сорока строками про grammy вместо одной
 * строки про то, что он вставил не тот токен.
 */
let me;
try {
  me = await bot.api.getMe();
} catch (err) {
  const code = err?.error_code ?? err?.error?.error_code;
  const what = String(err?.description ?? err?.message ?? err);
  if (code === 401) {
    console.error(
      'Telegram не принял токен (401). Скорее всего, он скопирован не целиком или отозван.\n' +
        'Возьмите его заново: @BotFather → /mybots → ваш бот → API Token,\n' +
        `и впишите в файл .env строкой BOT_TOKEN=… (сейчас там токен бота №${String(TOKEN).split(':')[0]}).`
    );
  } else if (/Network|fetch|ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(what)) {
    console.error('Нет связи с Telegram. Проверьте интернет (и VPN, если он включён) и запустите снова.');
  } else {
    console.error(`Telegram отказал при запуске: ${what}`);
  }
  store.close();
  process.exit(1);
}
const app = new App({
  api: bot.api,
  store,
  minIntervalMs: DRAW_INTERVAL_MS,
  botUsername: me.username,
  webappUrl: WEBAPP_URL,
  miniAppName: MINIAPP,
});
const hub = new Hub(app, { botToken: TOKEN });
app.attachHub(hub);

const restored = app.load();
console.log(`[bot] @${me.username} · восстановлено игр: ${restored} · база: ${DB_PATH}`);
if (!WEBAPP_URL) {
  console.warn('[bot] WEBAPP_URL не задан: стол не откроется. Нужен публичный HTTPS-адрес этого сервера — см. bot/README.md.');
} else if (!/^https:\/\//.test(WEBAPP_URL)) {
  console.warn(`[bot] WEBAPP_URL должен начинаться с https:// — Telegram не откроет ${WEBAPP_URL}`);
}
if (!MINIAPP) {
  console.warn('[bot] MINIAPP не задан: кнопка в группе откроет личку с ботом, а не сам стол. ' +
    'Зарегистрируйте приложение у @BotFather (/newapp) и впишите его короткое имя в .env.');
}

const web = startServer({
  hub,
  port: PORT,
  root: path.join(__dirname, '..', 'miniapp'),
  log: (...a) => console.error('[web]', ...a),
  onListen: () => console.log(`[bot] стол: http://localhost:${PORT}${WEBAPP_URL ? ` → ${WEBAPP_URL}` : ''}`),
});

/**
 * Занятый порт — самая частая осечка при втором запуске, и без этого она
 * выглядит как стек про EADDRINUSE. Говорим, что делать.
 */
web.server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Порт ${PORT} занят — похоже, бот уже запущен в другом окне.\n` +
        'Закройте его (Ctrl+C в том окне) или выполните:  pkill -f bot/index.js'
    );
  } else {
    console.error(`Не удалось открыть стол на порту ${PORT}: ${err.message}`);
  }
  process.exit(1);
});

/** The "/" menu: the games are played in the Mini App, the chat only needs these. */
const GROUP_COMMANDS = [
  ['game', 'во что играем: покер, дурак'],
  ['table', 'показать игры внизу чата'],
  ['finish', 'завершить свою игру (хост)'],
  ['help', 'как играть'],
];
const PRIVATE_COMMANDS = [['game', 'игры моих групп'], ['help', 'как играть']];
const asCommands = (list) => list.map(([command, description]) => ({ command, description }));
try {
  await bot.api.setMyCommands(asCommands(GROUP_COMMANDS), { scope: { type: 'all_group_chats' } });
  await bot.api.setMyCommands(asCommands(PRIVATE_COMMANDS), { scope: { type: 'all_private_chats' } });
} catch (err) {
  // A missing menu is cosmetic; the commands work without it.
  console.error('[bot] не удалось задать меню команд:', err?.description ?? err?.message ?? err);
}

// Everything goes through one handler: the App owns the routing.
bot.use(async (ctx) => {
  await app.handleUpdate(ctx.update);
});

bot.catch((err) => {
  console.error('[bot] необработанная ошибка:', err?.error?.description ?? err?.message ?? err);
});


let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[bot] ${signal} — останавливаюсь`);
  try {
    await bot.stop();
    app.stop(); // turn timers and the automatic deal come back from the database
    await web.close();
    await app.settle(); // flush any redraw that was still coalescing
  } catch (err) {
    console.error('[bot]', err);
  } finally {
    store.close();
    process.exit(0);
  }
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

await bot.start({
  // Privacy mode stays ON: the bot must not read the group's conversation.
  // Commands, replies to its own messages and callback queries arrive anyway,
  // and that is everything this design needs. `my_chat_member` also covers
  // private chats: it is how the bot learns that somebody blocked it.
  allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  onStart: async () => {
    console.log('[bot] long polling запущен');
    // Redraw every live table: the game must continue from exactly where it
    // stopped — same hand, same cards, same player on the clock.
    await app.resume();
  },
  drop_pending_updates: false,
});
