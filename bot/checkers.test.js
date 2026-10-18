'use strict';
/**
 * Шашки через мини-приложение — с настоящими страницами через хаб:
 *
 *   НИКТО НЕ ХОДИТ ЗА ДРУГОГО — личность только из подписанного initData;
 *   чужой цвет, id и место в теле сообщения ничего не значат.
 *
 *   НИКТО НЕ ПОЛУЧАЕТ ЧУЖИХ ХОДОВ — законные ходы приходят только тому, чей
 *   сейчас ход; проверяется всё, что получил каждый телефон за партию.
 *
 * Плюс то, что отличает шашки: нельзя сходить, не побив; серия на одно поле
 * разными путями требует пути; часы, перезапуск, рейтинг, ничья.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { Store } from './store.js';
import { PLACE } from './rating.js';
import { fromFen, key, legalMoves, make, sqName, startPosition, mustCapture } from './games/checkers/board.js';

const IVAN = user(101, 'Иван');
const MAX = user(202, 'Макс');
const DIMA = user(303, 'Дима');

const groupPosts = (t) => t.tg.calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(t.chatId));
const errors = (t, u) => t.page(u).inbox.filter((m) => m.t === 'error');

async function lobby(t, host = IVAN, settings = { base: 0 }) {
  await t.start(host);
  if (!t.group) await t.cmd(host, '/play');
  t.openHub(host);
  await t.send(host, { t: 'create', game: 'checkers', settings, reqId: 'k1' });
  return t.checkers;
}

/** Хост создаёт стол, гость садится, хост начинает. Белые — у хоста (жребий < 0,5). */
async function duel(t, settings = { base: 0 }) {
  const room = await lobby(t, IVAN, settings);
  await t.start(MAX);
  t.openRoom(MAX, room);
  await t.send(MAX, { t: 'sit' });
  await t.send(IVAN, { t: 'start' });
  return room;
}

const whoMoves = (room) => ((room.match.pos.t === 'w') === (room.match.white === '101') ? IVAN : MAX);

/** Сыграть ходы записью («c3-d4», «d4:f6») со страниц тех, чей они. */
async function play(t, room, moves) {
  for (const mv of moves) {
    const squares = mv.split(/[-:]/);
    const u = whoMoves(room);
    await t.send(u, { t: 'move', from: squares[0], to: squares.at(-1), ...(mv.includes(':') ? { path: squares } : {}), ply: room.match.moves.length });
    assert.equal(t.lastError(u)?.code ?? null, null, `${mv} от ${u.first_name} принят`);
  }
}

/**
 * N полуходов без конца партии: каждый раз первый законный ход, который не
 * отдаёт шашку под бой, если такой есть. Записью — чтобы слать со страниц.
 */
function quietGame(n) {
  let p = startPosition();
  const out = [];
  for (let i = 0; i < n; i++) {
    const ms = legalMoves(p);
    const safe = ms.find((m) => !mustCapture(make(p, m)).length) || ms[0];
    out.push(safe.path.map(sqName).join(safe.caps.length ? ':' : '-'));
    p = make(p, safe);
  }
  return out;
}
const LONG = quietGame(20);

/** Поставить позицию посреди партии (как будто до неё доиграли), не трогая остального. */
function setPosition(room, fen) {
  const m = room.match;
  m.pos = fromFen(fen);
  m.seen = { [key(m.pos)]: 1 };
}

test('партия двух страниц: каждый ход — со своего телефона, цвета и запись у обоих', async () => {
  const t = new Table();
  const room = await duel(t);
  assert.equal(room.game, 'checkers');
  assert.equal(t.state(IVAN).me.color, 'w');
  assert.equal(t.state(MAX).me.color, 'b');
  await play(t, room, ['c3-d4', 'f6-e5']);
  const s = t.state(IVAN);
  assert.deepEqual(s.match.moves, ['c3-d4', 'f6-e5']);
  assert.deepEqual(s.legal.must, ['d4'], 'шашка, которой надо бить, помечена');
  assert.deepEqual(s.legal.moves, [{ from: 'd4', to: 'f6', path: ['d4', 'f6'], caps: ['e5'] }]);
  await play(t, room, ['d4:f6']);
  assert.deepEqual(t.state(MAX).match.last, { from: 'd4', to: 'f6', path: ['d4', 'f6'], caps: ['e5'], n: 'd4:f6' });
});

test('нельзя сходить, не побив, когда бить обязательно — отказ словами, позиция та же', async () => {
  const t = new Table();
  const room = await duel(t);
  await play(t, room, ['c3-d4', 'f6-e5']);
  const before = JSON.stringify(room.match.pos);
  await t.send(IVAN, { t: 'move', from: 'a3', to: 'b4', ply: 2 });
  assert.equal(t.lastError(IVAN).code, 'MUST_CAPTURE');
  assert.match(t.lastError(IVAN).text, /Бить обязательно/);
  assert.equal(JSON.stringify(room.match.pos), before);
  assert.equal(room.match.moves.length, 2);
});

test('никто не ходит за другого: чужая очередь, зритель, подделка цвета и id в теле', async () => {
  const t = new Table();
  const room = await duel(t);
  await t.start(DIMA);
  t.openRoom(DIMA, room);
  await t.send(MAX, { t: 'move', from: 'c3', to: 'd4', uid: '101', id: '101', color: 'w', userId: 101 });
  assert.equal(errors(t, MAX).at(-1).code, 'NOT_YOUR_TURN');
  assert.match(errors(t, MAX).at(-1).text, /ходит соперник/);
  await t.send(DIMA, { t: 'move', from: 'c3', to: 'd4', uid: '101' });
  assert.equal(errors(t, DIMA).at(-1).code, 'NOT_IN_GAME');
  for (const msg of [{ t: 'resign' }, { t: 'draw' }, { t: 'abort' }, { t: 'start' }, { t: 'takeback' }]) await t.send(DIMA, msg);
  assert.equal(room.match.moves.length, 0);
  assert.equal(room.match.over, null, 'зритель ничего не решил за двоих');
  await t.send(MAX, { t: 'settings', base: 60 });
  await t.send(MAX, { t: 'kick', seat: 0 });
  assert.equal(room.settings.base, 0);
  assert.equal(room.players.find((p) => p.id === '101').kicked, false);
  await t.send(IVAN, { t: 'attack', card: 'S6' });
  assert.equal(errors(t, IVAN).at(-1).code, 'BAD_REQUEST', 'действия чужих игр не проходят');
});

test('ходы приходят только тому, чей сейчас ход; ждущему и зрителю — ни одного за всю партию', async () => {
  const t = new Table();
  const room = await duel(t);
  await t.start(DIMA);
  t.openRoom(DIMA, room);
  assert.equal(t.state(IVAN).legal.moves.length, 7);
  for (const u of [MAX, DIMA]) assert.deepEqual(t.state(u).legal, { myTurn: false });
  await play(t, room, LONG.slice(0, 8));
  for (const [u, color] of [[IVAN, 'w'], [MAX, 'b'], [DIMA, null]]) {
    const states = t.page(u).inbox.filter((x) => x.t === 'state' && x.state.game === 'checkers');
    assert.ok(states.length > 3, `${u.first_name} получал состояния`);
    for (const m of states) {
      if (m.state.legal.myTurn) assert.equal(m.state.match.turn, color, `${u.first_name} получил ходы не в свой ход`);
      else {
        assert.equal(m.state.legal.moves, undefined);
        assert.equal(m.state.legal.must, undefined);
      }
    }
  }
});

test('две серии на одно поле: без пути — просьба выбрать, с путём — ход; отказ возвращает позицию', async () => {
  const t = new Table();
  const room = await duel(t);
  await play(t, room, LONG.slice(0, 4));
  setPosition(room, 'W:WKh4,Kd8:Bg1,e3,a5,e5,c7,e7');
  const before = t.page(IVAN).inbox.length;
  await t.send(IVAN, { t: 'move', from: 'd8', to: 'f2', ply: 4 });
  assert.equal(t.lastError(IVAN).code, 'NEED_PATH');
  assert.match(t.lastError(IVAN).text, /выберите путь/);
  assert.ok(t.page(IVAN).inbox.slice(before).some((m) => m.t === 'state'), 'страница получила настоящую позицию');
  const refusals = errors(t, IVAN).length;
  await t.send(IVAN, { t: 'move', from: 'd8', to: 'f2', path: ['d8', 'f6', 'd4', 'f2'], ply: 4 });
  assert.equal(errors(t, IVAN).length, refusals, 'с путём — без отказа');
  assert.equal(room.match.moves.at(-1).n, 'd8:f6:d4:f2');
  assert.deepEqual(room.match.moves.at(-1).caps.sort(), ['e3', 'e5', 'e7']);
});

test('мусор в пути не роняет сервер и не выбирает ход за игрока: отказ «такой серии нет»', async () => {
  const t = new Table();
  const room = await duel(t);
  await play(t, room, LONG.slice(0, 4));
  setPosition(room, 'W:WKh4,Kd8:Bg1,e3,a5,e5,c7,e7');
  const want = { 42: 'NEED_PATH', obj: 'NEED_PATH', long: 'NEED_PATH', junk: 'BAD_PATH', bad: 'BAD_PATH', wrongLine: 'BAD_PATH' };
  const paths = { 42: 42, obj: { x: 1 }, long: Array(100).fill('d4'), junk: [null, {}, 'zz'], bad: ['d8', 'zz', 'f2'], wrongLine: ['d8', 'a5', 'f2'] };
  for (const [name, path] of Object.entries(paths)) {
    await t.send(IVAN, { t: 'move', from: 'd8', to: 'f2', path, ply: 4 });
    assert.equal(t.lastError(IVAN)?.code, want[name], name);
  }
  assert.equal(room.match.moves.length, 4, 'ни один кривой путь не стал ходом');
  await t.send(IVAN, { t: 'move', from: 'd8', to: 'f2', path: ['d8', 'b6', 'f2'], ply: 4 });
  assert.equal(room.match.moves.at(-1).n, 'd8:b6:f2');
});

test('группа молчит про позицию: в карточке ни доски, ни ходов; итоги — один раз', async () => {
  const t = new Table();
  const room = await duel(t);
  await play(t, room, LONG.slice(0, 6));
  const card = t.tg.message(room.ui.tableMessageId);
  assert.match(card.text, /Шашки/);
  assert.doesNotMatch(card.text, /[a-h][1-8][-:][a-h][1-8]/, 'ни одного хода записью');
  await t.send(MAX, { t: 'resign' });
  await t.send(IVAN, { t: 'finish' });
  const results = groupPosts(t).filter((c) => /ИТОГИ · ШАШКИ/.test(c.text));
  assert.equal(results.length, 1);
  assert.match(results[0].text, /Иван\s+1 · 0 · 0/);
});

test('«ваш ход» в личку тому, чей ход, если приложение закрыто, и снимается после хода', async () => {
  const t = new Table();
  const room = await duel(t);
  await t.start(MAX);
  await t.send(MAX, { t: 'visible', visible: false });
  await t.send(IVAN, { t: 'move', from: 'c3', to: 'd4' });
  const ping = [...t.tg.messages.entries()].filter(([, m]) => m.chatId === '202' && /Ваш ход/.test(m.text)).at(-1);
  assert.ok(ping, 'Максу напомнили');
  assert.match(ping[1].text, /Шашки/);
  assert.match(ping[1].text, /Соперник: 1\. c3-d4/);
  assert.ok(!t.tg.dms(101).some((x) => /Ваш ход/.test(x)), 'Иван смотрит на стол — ему не пишем');
  await t.send(MAX, { t: 'move', from: 'f6', to: 'e5' });
  assert.equal(t.tg.message(ping[0]).deleted, true, 'сходил — напоминание убрано');
  assert.equal(room.match.moves.length, 2);
});

test('часы: время вышло — выигрывает соперник, в рейтинге +20', async () => {
  const t = new Table({ store: new Store(':memory:') });
  const room = await duel(t, { base: 60 });
  await play(t, room, LONG);
  assert.equal(t.state(IVAN).match.clock.timed, true);
  await t.advance(59_000);
  assert.equal(room.match.over, null);
  await t.advance(1_000);
  assert.deepEqual(room.match.over, { winner: 'b', kind: 'time' });
  assert.equal(t.app.store.ratingOf(202, 'checkers').points, PLACE[0]);
  t.app.store.close();
});

test('рейтинг: короткая сдача очков не даёт; побить все шашки — даёт при любой длине', async () => {
  const t = new Table({ store: new Store(':memory:') });
  const room = await duel(t);
  await play(t, room, LONG.slice(0, 4));
  await t.send(MAX, { t: 'resign' });
  assert.equal(t.app.store.ratingOf(101, 'checkers'), null, 'сдался на втором ходу — очков нет');
  assert.match(room.rated[`${room.code}#1`].why, /короче 10 ходов/);
  await t.send(IVAN, { t: 'next' });
  // Макс теперь белыми. Короткая партия, но конец естественный — шашек не осталось.
  await play(t, room, ['c3-d4', 'f6-e5']);
  setPosition(room, 'W:Wc3:Bd4');
  await play(t, room, ['c3:e5']);
  assert.deepEqual(room.match.over, { winner: 'w', kind: 'nopieces' });
  assert.equal(t.app.store.ratingOf(202, 'checkers').points, PLACE[0]);
  t.app.store.close();
});

test('ничья в рейтинг очков не даёт — и это сказано словами', async () => {
  const t = new Table({ store: new Store(':memory:') });
  const room = await duel(t);
  await play(t, room, LONG.slice(0, 2));
  await t.send(IVAN, { t: 'draw' });
  assert.equal(t.state(MAX).canAnswerDraw, true);
  await t.send(MAX, { t: 'draw' });
  assert.deepEqual(room.match.over, { winner: null, kind: 'agreed' });
  assert.equal(t.app.store.ratingOf(101, 'checkers'), null);
  assert.match(room.rated[`${room.code}#1`].why, /ничья — очков нет/);
  t.app.store.close();
});

test('перезапуск посреди партии: позиция, часы и обязательное взятие — как были', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store });
  const room = await duel(t, { base: 300 });
  await play(t, room, ['c3-d4', 'f6-e5']);
  await t.advance(100_000);
  t.app.save(room);

  const t2 = new Table({ store, clock: t.clock });
  t2.app.load();
  const back = t2.app.roomByCode(room.code);
  assert.equal(back.game, 'checkers');
  assert.equal(back.match.moves.length, 2);
  assert.ok(back.turn.remaining > 199_000 && back.turn.remaining <= 200_000);
  await t2.start(IVAN);
  t2.openRoom(IVAN, back);
  assert.deepEqual(t2.state(IVAN).legal.must, ['d4']);
  await t2.send(IVAN, { t: 'move', from: 'a3', to: 'b4', ply: 2 });
  assert.equal(t2.lastError(IVAN).code, 'MUST_CAPTURE');
  store.close();
});

test('/checkers в группе: лобби одной командой, повторно — ещё одно (дуэль)', async () => {
  const t = new Table();
  await t.start(IVAN);
  await t.cmd(IVAN, '/checkers');
  const lobbies = () => t.app.liveRooms(String(t.chatId)).filter((r) => r.game === 'checkers' && r.status === 'lobby');
  assert.equal(lobbies().length, 1);
  const card = t.tg.message(lobbies()[0].ui.tableMessageId);
  assert.match(card.text, /Шашки/);
  assert.equal(card.markup.inline_keyboard[0][0].text, '🔘 Присоединиться');
  await t.cmd(IVAN, '/checkers');
  assert.equal(lobbies().length, 2);
});
