import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHomescreen, rowText, STATES } from '../miniapp/homescreen.js';

/** Фиктивные часы и фиктивный Telegram. */
function clock() {
  let t = 0, id = 0; const q = new Map();
  return {
    setTimer: (fn, ms) => { q.set(++id, { at: t + ms, fn }); return id; },
    clearTimer: (i) => q.delete(i),
    advance(ms) { t += ms; for (const [i, x] of [...q]) if (x.at <= t && q.has(i)) { q.delete(i); x.fn(); } },
    pending: () => q.size,
  };
}
function fakeTg({ version = true, status = 'missed', respond = true, addThrows = false, noMethods = false } = {}) {
  const handlers = {}; const calls = [];
  const tg = {
    calls, handlers,
    isVersionAtLeast: (v) => { calls.push(['v', v]); return version; },
    onEvent: (n, f) => { handlers[n] = f; }, offEvent: (n) => { delete handlers[n]; },
    emit: (n, d) => handlers[n]?.(d),
    pendingCb: null,
  };
  if (!noMethods) {
    tg.checkHomeScreenStatus = (cb) => { calls.push(['check']); if (respond) cb(tg.status ?? status); else tg.pendingCb = cb; };
    tg.addToHomeScreen = () => { calls.push(['add']); if (addThrows) throw new Error('WebAppMethodUnsupported'); };
  }
  return tg;
}
const mk = (tg, c = clock()) => ({ c, h: createHomescreen(tg, { setTimer: c.setTimer, clearTimer: c.clearTimer }) });

test('нет Telegram или нет методов или версия мала → «недоступно», методы не вызываются', () => {
  for (const tg of [null, fakeTg({ noMethods: true }), fakeTg({ version: false })]) {
    const { h } = mk(tg); h.start();
    assert.equal(h.get().state, 'unavailable');
    assert.equal(h.add(), false);
    assert.equal(h.get().state, 'unavailable');
    if (tg) assert.ok(!tg.calls.some(([k]) => k === 'add' || k === 'check'));
  }
});

test('версия проверяется по 8.0', () => {
  const tg = fakeTg(); mk(tg);
  assert.deepEqual(tg.calls.find(([k]) => k === 'v'), ['v', '8.0']);
});

test('статусы проверки: missed/unknown → можно добавить; added → уже; unsupported → недоступно; мусор → ошибка', () => {
  const exp = { missed: 'can', unknown: 'can', added: 'added', unsupported: 'unavailable', weird: 'failed', undefined: 'failed' };
  for (const [st, want] of Object.entries(exp)) {
    const tg = fakeTg({ status: st === 'undefined' ? null : st });
    const { h } = mk(tg); h.start();
    assert.equal(h.get().state, want, st);
  }
});

test('проверка без ответа: таймаут → ошибка, а не вечное «проверяем»', () => {
  const tg = fakeTg({ respond: false }); const { h, c } = mk(tg); h.start();
  assert.equal(h.get().state, 'checking');
  c.advance(5999); assert.equal(h.get().state, 'checking');
  c.advance(2); assert.deepEqual(h.get(), { state: 'failed', reason: 'check' });
  assert.equal(c.pending(), 0);
});

test('успех объявляется только после homeScreenAdded', () => {
  const tg = fakeTg(); const { h } = mk(tg); h.start();
  assert.equal(h.add(), true);
  assert.equal(h.get().state, 'pending'); // вызов без ошибки — ещё не успех
  tg.emit('homeScreenAdded');
  assert.equal(h.get().state, 'added');
});

test('события нет, таймаут, повторная проверка говорит «added» → добавлено', () => {
  const tg = fakeTg(); const { h, c } = mk(tg); h.start(); h.add();
  tg.status = 'added';
  c.advance(30000);
  assert.equal(h.get().state, 'added');
});

test('события нет, повторная проверка «missed»/«unknown» → не добавлено, с повтором', () => {
  for (const st of ['missed', 'unknown']) {
    const tg = fakeTg(); const { h, c } = mk(tg); h.start(); h.add();
    tg.status = st; c.advance(30000);
    assert.deepEqual(h.get(), { state: 'failed', reason: 'declined' }, st);
    assert.equal(h.retry(), true);
    assert.equal(h.get().state, 'pending');
  }
});

test('события нет и проверка молчит → ошибка по таймауту, не вечный спиннер', () => {
  const tg = fakeTg(); const { h, c } = mk(tg); h.start(); h.add();
  tg.checkHomeScreenStatus = () => {}; // молчит
  c.advance(30000); assert.equal(h.get().state, 'pending');
  c.advance(6001); assert.equal(h.get().state, 'failed');
  assert.equal(c.pending(), 0);
});

test('addToHomeScreen бросает исключение → ошибка', () => {
  const tg = fakeTg({ addThrows: true }); const { h } = mk(tg); h.start(); h.add();
  assert.deepEqual(h.get(), { state: 'failed', reason: 'add' });
});

test('повторное нажатие в ожидании не вызывает метод второй раз', () => {
  const tg = fakeTg(); const { h } = mk(tg); h.start();
  assert.equal(h.add(), true); assert.equal(h.add(), false); assert.equal(h.add(), false);
  assert.equal(tg.calls.filter(([k]) => k === 'add').length, 1);
});

test('нельзя добавить, пока идёт проверка и когда уже добавлено', () => {
  const tg = fakeTg({ respond: false }); const a = mk(tg); a.h.start();
  assert.equal(a.h.add(), false);
  const tg2 = fakeTg({ status: 'added' }); const b = mk(tg2); b.h.start();
  assert.equal(b.h.add(), false);
  assert.ok(!tg2.calls.some(([k]) => k === 'add'));
});

test('необязательное событие homeScreenFailed: ожидание → ошибка; вне ожидания игнорируется', () => {
  const tg = fakeTg(); const { h } = mk(tg); h.start();
  tg.emit('homeScreenFailed'); assert.equal(h.get().state, 'can');
  h.add(); tg.emit('homeScreenFailed');
  assert.deepEqual(h.get(), { state: 'failed', reason: 'declined' });
});

test('подписка получает смены; dispose отписывает и снимает таймеры', () => {
  const tg = fakeTg(); const { h, c } = mk(tg); const seen = [];
  h.subscribe((s) => seen.push(s.state)); h.start(); h.add();
  assert.deepEqual(seen, ['can', 'pending']); // начальное «checking» уже было — повторной смены нет
  h.dispose(); assert.equal(c.pending(), 0); assert.equal(Object.keys(tg.handlers).length, 0);
});

test('тексты: у каждого состояния есть пояснение; кнопка только в «можно» и «ошибка»; нет слов об успехе вне «added»', () => {
  for (const s of STATES) {
    const t = rowText({ state: s, reason: s === 'failed' ? 'add' : null });
    assert.ok(t.sub.length > 5, s);
    assert.equal(!!t.btn, s === 'can' || s === 'failed', s);
    if (s !== 'added') assert.ok(!/уже на рабочем|добавлено/i.test(t.sub.replace('не подтвердил добавление', '')), s);
  }
});

test('автоматического предложения нет: ни в модуле, ни в строке нет вызова add вне обработчика кнопки', () => {
  const row = fs.readFileSync(new URL('../miniapp/homescreen-row.js', import.meta.url), 'utf8');
  const mod = fs.readFileSync(new URL('../miniapp/homescreen.js', import.meta.url), 'utf8');
  assert.equal((row.match(/\.add\(\)/g) || []).length, 1);
  assert.match(row, /b\.onclick = \(\) => \{[\s\S]*?mine\.add\(\)/);
  assert.ok(!/\bsetInterval\b/.test(mod + row));
  assert.ok(!/https?:\/\//.test(mod.replace(/core\.telegram\.org[^\s]*/g, '') + row), 'внешних адресов нет');
});
