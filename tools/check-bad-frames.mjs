/**
 * Проверка после выкатки (аудит B-02): «кривые» кадры WebSocket — те самые,
 * которыми до исправления любой человек из интернета ронял бота, — больше
 * его не роняют.
 *
 *   node tools/check-bad-frames.mjs                  # бот на этом же сервере, порт 8080
 *   node tools/check-bad-frames.mjs ws://127.0.0.1:8080/ws
 *
 * Шлёт пять плохих кадров, каждый в своём соединении, потом обычный ping и
 * ждёт pong. Ни подписи, ни Telegram не нужно — как и нападающему.
 * Что бот не перезапускался, проверяйте до и после:
 *   systemctl show worldcard -p MainPID -p NRestarts
 * Цифры не должны измениться.
 */
import WebSocket from 'ws';

const url = process.argv[2] || 'ws://127.0.0.1:8080/ws';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const ws = new WebSocket(url);
  const inbox = [];
  ws.on('message', (b) => {
    try {
      inbox.push(JSON.parse(String(b)));
    } catch {
      /* не JSON — не наше */
    }
  });
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.on('error', () => {}); // разрыв сервером — ожидаемый исход
      resolve({ ws, inbox, closed });
    });
    ws.on('error', reject);
  });
}

const frames = {
  'больше 16 КБ': (ws) => ws.send('x'.repeat(17 * 1024)),
  'битый UTF-8': (ws) => ws._socket.write(Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0xff ^ 1, 0xfe ^ 2])),
  'без маски': (ws) => ws._socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69])),
  'чужой опкод': (ws) => ws._socket.write(Buffer.from([0x83, 0x80, 1, 2, 3, 4])),
  'фрагмент без начала': (ws) => ws._socket.write(Buffer.from([0x80, 0x80, 1, 2, 3, 4])),
};

let ok = true;
for (const [name, shoot] of Object.entries(frames)) {
  try {
    const p = await connect();
    shoot(p.ws);
    await Promise.race([p.closed, wait(3000)]);
    await wait(300);
    console.log(`· «${name}» — отправлен`);
  } catch (err) {
    ok = false;
    console.log(`✗ «${name}»: не удалось даже соединиться — ${err.message}. Бот лежит?`);
  }
}

try {
  const p = await connect();
  p.ws.send('{"t":"ping"}');
  for (let i = 0; i < 100 && !p.inbox.some((m) => m.t === 'pong'); i++) await wait(30);
  if (p.inbox.some((m) => m.t === 'pong')) console.log('· после всех кадров бот отвечает (pong)');
  else {
    ok = false;
    console.log('✗ после кадров бот не ответил на ping');
  }
  p.ws.close();
} catch (err) {
  ok = false;
  console.log(`✗ после кадров соединиться не вышло — ${err.message}. Похоже, бот упал.`);
}

console.log(ok ? 'B-02: бот кривыми кадрами не роняется — ок' : 'B-02: ПРОБЛЕМА — смотрите journalctl -u worldcard -n 50');
process.exit(ok ? 0 : 1);
