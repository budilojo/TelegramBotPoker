import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadManifest, validateManifest, pathsOverlap, nextRunnable, simulate, isTerminal, parseAgentStatus, looksLikeLimit, snippet,
} from './graphit-run.mjs';

const real = loadManifest();
const clone = () => JSON.parse(JSON.stringify(real));
const all = () => true;

test('манифест «Графит»: корректен (задания и агенты на месте, зоны и решения не пересекаются, цикла нет)', () => {
  assert.deepEqual(validateManifest(real), []);
});

test('валидатор ловит цикл, пересечение зон, пересечение решений и пропавшее задание', () => {
  const a = clone();
  a.agents.find((x) => x.id === 'lead-contracts').deps = ['server'];
  assert.ok(validateManifest(a, { exists: all }).some((p) => p.includes('цикл')), 'цикл зависимостей');

  const b = clone();
  b.agents.find((x) => x.id === 'client').owns.push('bot/store.js');
  assert.ok(validateManifest(b, { exists: all }).some((p) => p.includes('зоны пересекаются')), 'зоны');

  const b2 = clone();
  b2.agents.find((x) => x.id === 'screens').owns.push('bot/collections/');
  assert.ok(validateManifest(b2, { exists: all }).some((p) => p.includes('зоны пересекаются')), 'папка против файла внутри неё');

  const c = clone();
  c.agents.find((x) => x.id === 'assets').decisions = [110, 114];
  assert.ok(validateManifest(c, { exists: all }).some((p) => p.includes('диапазоны решений')), 'решения');

  const d = clone();
  assert.ok(validateManifest(d, { exists: (p) => !p.endsWith('server.md') }).some((p) => p.includes('нет файла задания')), 'нет файла задания');

  const e = clone();
  e.agents.find((x) => x.id === 'lead-contracts').stubs.push('docs/nobody-owns-this.md');
  assert.ok(validateManifest(e, { exists: all }).some((p) => p.includes('заготовка')), 'заготовка без владельца');
});

test('pathsOverlap: файл, папка и родство', () => {
  assert.ok(pathsOverlap('bot/a.js', 'bot/a.js'));
  assert.ok(pathsOverlap('bot/collections/', 'bot/collections/x.js'));
  assert.ok(!pathsOverlap('bot/collections/', 'bot/collections.test.js'));
  assert.ok(!pathsOverlap('miniapp/collections.css', 'miniapp/collections-look.css'));
});

test('порядок запуска: контракт первым, зависимые после, интеграция последней; параллелизм не больше лимита', () => {
  const waves = simulate(real, 3);
  assert.deepEqual(waves[0].includes('lead-contracts'), true);
  assert.ok(waves.every((w) => w.length <= 3), 'не больше трёх одновременно');
  const flat = waves.flat();
  assert.equal(flat.at(-1), 'lead-integration');
  assert.ok(flat.indexOf('screens') > flat.indexOf('server') && flat.indexOf('screens') > flat.indexOf('assets'));
  for (const id of ['server', 'assets', 'client', 'homescreen']) assert.ok(flat.indexOf(id) > flat.indexOf('lead-contracts'), `${id} после контракта`);
  assert.equal(new Set(flat).size, real.agents.length, 'каждый агент ровно один раз');
});

test('планировщик: нет повторного старта слитого и бегущего; упавший в этом запуске не перезапускается; интеграция ждёт всех', () => {
  const st = (o) => ({ agents: o });
  const m = real;
  assert.deepEqual(nextRunnable(m, st({}), { maxParallel: 3 }).slice(0, 1), ['lead-contracts']);
  // контракт слит → server/assets/client + research (свободных мест 3 из-за research уже запущенного)
  const s1 = st({ 'lead-contracts': { status: 'merged' }, research: { status: 'running' } });
  assert.deepEqual(nextRunnable(m, s1, { maxParallel: 3 }), ['server', 'assets']);
  // слитое не стартует снова, бегущее не стартует
  const s2 = st({ 'lead-contracts': { status: 'merged' }, server: { status: 'merged' }, assets: { status: 'running' } });
  assert.ok(!nextRunnable(m, s2, { maxParallel: 5 }).includes('server'));
  assert.ok(!nextRunnable(m, s2, { maxParallel: 5 }).includes('assets'));
  assert.ok(!nextRunnable(m, s2, { maxParallel: 5 }).includes('screens'), 'screens ждёт assets');
  // упавший в этом запуске (settled) — не перезапускается; без settled (следующий запуск) — перезапускается
  const s3 = st({ 'lead-contracts': { status: 'failed', settled: true, attempts: 1 } });
  assert.ok(!nextRunnable(m, s3, { maxParallel: 3 }).includes('lead-contracts'));
  const s4 = st({ 'lead-contracts': { status: 'failed', settled: false, attempts: 1 } });
  assert.ok(nextRunnable(m, s4, { maxParallel: 3 }).includes('lead-contracts'));
  // исчерпаны попытки
  const s5 = st({ 'lead-contracts': { status: 'failed', attempts: 3 } });
  assert.ok(!nextRunnable(m, s5, { maxParallel: 3 }).includes('lead-contracts'));
  // интеграция запускается, когда все остальные закончили (хорошо или плохо), и не раньше
  const done = Object.fromEntries(m.agents.filter((a) => a.id !== 'lead-integration').map((a) => [a.id, { status: 'merged' }]));
  assert.deepEqual(nextRunnable(m, st(done), { maxParallel: 3 }), ['lead-integration']);
  const oneRunning = { ...done, screens: { status: 'running' } };
  assert.ok(!nextRunnable(m, st(oneRunning), { maxParallel: 3 }).includes('lead-integration'));
  const oneBlocked = { ...done, screens: { status: 'blocked' } };
  assert.deepEqual(nextRunnable(m, st(oneBlocked), { maxParallel: 3 }), ['lead-integration']);
  assert.ok(isTerminal({ status: 'conflict' }) && !isTerminal({ status: 'pending' }));
});

test('статус исполнителя: проверка формата', () => {
  const good = JSON.stringify({ id: 'server', status: 'done', summary: 'готово', at: '2026-10-27T12:00:00Z' });
  assert.equal(parseAgentStatus(good, 'server').ok, true);
  assert.equal(parseAgentStatus(good, 'assets').ok, false, 'чужой id');
  assert.equal(parseAgentStatus('{"id":"server","status":"сделано","summary":"x","at":"2026-10-27T12:00:00Z"}', 'server').ok, false, 'неизвестный статус');
  assert.equal(parseAgentStatus('{"id":"server","status":"done","summary":"x"}', 'server').ok, false, 'нет времени завершения');
  assert.equal(parseAgentStatus('{"id":"server","status":"done","at":"2026-10-27T12:00:00Z"}', 'server').ok, false, 'нет summary');
  assert.equal(parseAgentStatus('не json', 'server').ok, false);
});

test('упор в лимит узнаётся по тексту', () => {
  assert.ok(looksLikeLimit('Usage limit reached · limit resets 4:40am'));
  assert.ok(looksLikeLimit('rate limit exceeded'));
  assert.ok(!looksLikeLimit('всё хорошо, тесты зелёные'));
  assert.ok(looksLikeLimit("You've hit your limit · resets 8:20am"), 'формулировка «hit your limit»');
  assert.ok(looksLikeLimit("You've hit your session limit · resets 7:50pm (Asia/Yekaterinburg)"), 'настоящая формулировка из журнала владельца');
  assert.ok(looksLikeLimit('{"is_error":true,"result":"5-hour limit"}', true), 'при ошибке достаточно слова limit');
  assert.ok(!looksLikeLimit('limit order book', false), 'без ошибки слово limit само по себе не лимит');
  assert.equal(snippet('{"is_error":true,"result":"нет прав на папку"}'), 'нет прав на папку');
  assert.ok(snippet('просто текст').includes('просто'));
});
