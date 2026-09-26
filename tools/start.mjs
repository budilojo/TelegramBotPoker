/**
 * Одна команда на весь вечер:
 *
 *   npm run go
 *
 * Поднимает туннель, сам вписывает его адрес в `.env`, проверяет, что стол
 * виден снаружи, и запускает бота. Обе половины живут в одном окне: пока оно
 * открыто, игра работает; Ctrl+C гасит сразу обе.
 *
 * Зачем. Раньше туннель и бот запускались в двух окнах, и адрес у бесплатного
 * cloudflared меняется при каждом запуске — его надо было переписать в двух
 * местах. Промах в любом из них давал «не открывается», причём без подсказки,
 * где именно. Теперь одно место остаётся человеку: адрес у @BotFather, и
 * команда говорит, нужно ли его трогать.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setEnvValue, getEnvValue } from './envfile.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
/** Адрес quick-туннеля в выводе cloudflared. */
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const WAIT_URL_MS = 60_000;

const say = (...a) => console.log('[старт]', ...a);
const bad = (...a) => console.error('[старт]', ...a);

/** Рамка вокруг того, что человек должен прочитать, а не пролистать. */
function banner(lines) {
  const width = Math.max(...lines.map((l) => [...l].length));
  const edge = '─'.repeat(width + 2);
  console.log(`\n┌${edge}┐`);
  for (const l of lines) console.log(`│ ${l}${' '.repeat(width - [...l].length)} │`);
  console.log(`└${edge}┘\n`);
}

/* --------------------------------------------------------------- проверки */

let envText = '';
try {
  envText = fs.readFileSync(ENV_FILE, 'utf8');
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  bad(`файла .env нет. Скопируйте .env.example в .env и впишите токен от @BotFather:\n         cp .env.example .env`);
  process.exit(1);
}
if (!getEnvValue(envText, 'BOT_TOKEN')) {
  bad('в .env нет строки BOT_TOKEN. Возьмите токен у @BotFather и впишите его туда.');
  process.exit(1);
}
const PORT = Number(getEnvValue(envText, 'PORT') || 8080);
const miniApp = getEnvValue(envText, 'MINIAPP');
const wasUrl = getEnvValue(envText, 'WEBAPP_URL');

/* --------------------------------------------------------------- туннель */

say('поднимаю туннель…');
const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let bot = null;
let stopping = false;

tunnel.on('error', (err) => {
  if (err.code === 'ENOENT') {
    bad('cloudflared не установлен. Поставьте его одной командой:\n         brew install cloudflared');
  } else {
    bad('не удалось запустить cloudflared:', err.message);
  }
  process.exit(1);
});

/** Адрес приходит в одной из строк вывода; какая именно — не обещано. */
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('за минуту туннель не выдал адрес')), WAIT_URL_MS);
  const watch = (chunk) => {
    const m = URL_RE.exec(String(chunk));
    if (!m) return;
    clearTimeout(timer);
    resolve(m[0]);
  };
  tunnel.stdout.on('data', watch);
  tunnel.stderr.on('data', watch);
  tunnel.on('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`cloudflared завершился с кодом ${code}`));
  });
}).catch((err) => {
  bad(err.message);
  bad('Запустите вручную и посмотрите, что он пишет:');
  bad(`  cloudflared tunnel --url http://localhost:${PORT}`);
  tunnel.kill();
  process.exit(1);
});

// Дальше туннель говорит только когда ломается: его обычный вывод — шум.
const onTunnelNoise = (chunk) => {
  const t = String(chunk);
  if (/ERR|error=/.test(t) && !/Failed to (fetch features|initialize DNS)/.test(t)) process.stderr.write(`[туннель] ${t}`);
};
tunnel.stdout.on('data', onTunnelNoise);
tunnel.stderr.on('data', onTunnelNoise);
tunnel.on('exit', (code) => {
  if (stopping) return;
  bad(`туннель упал (код ${code}) — стол перестал открываться. Остановите Ctrl+C и запустите снова.`);
});

say(`адрес стола: ${url}`);

/* ------------------------------------------------- .env и адрес у BotFather */

if (wasUrl !== url) {
  fs.writeFileSync(ENV_FILE, setEnvValue(envText, 'WEBAPP_URL', url));
  say('вписал этот адрес в .env');
}

/* ------------------------------------------------------------------- бот */

// Реальная переменная важнее файла — бот возьмёт адрес отсюда в любом случае.
bot = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'bot', 'index.js')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, WEBAPP_URL: url, PORT: String(PORT) },
});
bot.on('exit', (code) => {
  if (stopping) return;
  bad(`бот остановился (код ${code}).`);
  stop();
});

/** Ctrl+C гасит обе половины: одна без другой бесполезна. */
function stop() {
  if (stopping) return;
  stopping = true;
  bot?.kill('SIGINT');
  tunnel.kill('SIGINT');
  setTimeout(() => process.exit(0), 700).unref();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

/* ------------------------------------------- проверка, что стол виден извне */

/** Стол отвечает на /health — значит, туннель и бот сошлись. */
async function reachable(tries = 12) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, i ? 2000 : 1500));
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
      if (res.ok && (await res.json())?.ok) return true;
    } catch {
      /* туннель ещё поднимается */
    }
  }
  return false;
}

if (await reachable()) {
  const lines = ['✅ Стол открыт. Не закрывайте это окно, пока играете.', ''];
  if (wasUrl !== url) {
    lines.push('Адрес сменился — впишите его у @BotFather:', '');
    lines.push(`  ${url}`, '');
    lines.push(`  /myapps → ${miniApp || 'ваше приложение'} → Edit Web App URL`, '');
  }
  lines.push('Потом в группе: /game → «🎮 Выбрать игру».');
  banner(lines);
} else {
  banner([
    '⚠️ Туннель поднялся, но стол снаружи не отвечает.',
    '',
    'Проверьте, не занят ли порт другим ботом:',
    '  pkill -f bot/index.js',
    'и запустите снова: npm run go',
  ]);
}
