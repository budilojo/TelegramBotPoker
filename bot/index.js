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
 * at a time, which removes an entire class of race between two people tapping
 * at once. It also needs no public URL, no TLS and no webhook registration,
 * so the same command runs on a laptop, a VPS or a container. The cost is
 * that the process must stay awake — see README for the hosting choice.
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot } from 'grammy';
import { App } from './app.js';
import { Store } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('BOT_TOKEN не задан. Получите токен у @BotFather и запустите:\n  BOT_TOKEN=... npm run bot');
  process.exit(1);
}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bot.db');
const DRAW_INTERVAL_MS = Number(process.env.DRAW_INTERVAL_MS || 1000);

const bot = new Bot(TOKEN);
const store = new Store(DB_PATH);

const me = await bot.api.getMe();
const app = new App({
  api: bot.api,
  store,
  minIntervalMs: DRAW_INTERVAL_MS,
  botUsername: me.username,
});

const restored = app.load();
console.log(`[bot] @${me.username} · восстановлено столов: ${restored} · база: ${DB_PATH}`);

/**
 * The "/" menu. /fold and /allin are deliberately NOT in it: a menu entry is
 * one tap, and those are the two moves a stray tap must never make. They work
 * when typed — typing is a decision.
 */
const GROUP_COMMANDS = [
  ['check', 'чек'],
  ['call', 'уравнять ставку'],
  ['raise', 'поднять ДО суммы: /raise 300'],
  ['bet', 'поставить: /bet 200'],
  ['next', 'следующая раздача'],
  ['table', 'показать стол внизу чата'],
  ['join', 'сесть за стол'],
  ['leave', 'встать из-за стола'],
  ['newgame', 'создать стол'],
  ['help', 'как играть'],
];
const PRIVATE_COMMANDS = [
  ['cards', 'мои карты в текущих раздачах'],
  ['help', 'как играть'],
];
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

/**
 * An optional health port. Some always-on hosts insist on a bound port, and
 * an uptime pinger needs something to ping. The bot itself does not need it.
 */
if (process.env.PORT) {
  http
    .createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bot: me.username, tables: app.rooms.size }));
    })
    .listen(Number(process.env.PORT), () => console.log(`[bot] health на :${process.env.PORT}`));
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[bot] ${signal} — останавливаюсь`);
  try {
    await bot.stop();
    app.stop(); // turn timers and the automatic deal come back from the database
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
