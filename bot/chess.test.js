'use strict';
/**
 * Шахматы через мини-приложение: те же два железных правила, что у остальных
 * игр, и то, ради чего игра и появилась, — дуэли.
 *
 *   НИКТО НЕ ХОДИТ ЗА ДРУГОГО — личность только из подписанного initData;
 *   чужой цвет, чужой id и место в теле сообщения ничего не значат.
 *
 *   НИКТО НЕ ПОЛУЧАЕТ ЧУЖИХ ХОДОВ — в шахматах нет скрытых карт, поэтому
 *   проверяется другое: законные ходы приходят только тому, чей сейчас ход.
 *
 *   У ХОСТА МОЖЕТ БЫТЬ НЕСКОЛЬКО ЛОББИ СРАЗУ — в играх на двоих. Остальные
 *   игры живут по прежнему правилу: одно открытое лобби на хоста.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { Store } from './store.js';
import { PLACE, LAST } from './rating.js';

const IVAN = user(101, 'Иван');
const MAX = user(202, 'Макс');
const DIMA = user(303, 'Дима');

const groupPosts = (t) => t.tg.calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(t.chatId));
const live = (t, game = 'chess') => t.app.liveRooms(String(t.chatId)).filter((r) => r.game === game);
/** 10 ходов каждым (20 полуходов) без повторов: достаточно для рейтинга. */
const LONG = [
  ['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'c4'], ['f8', 'c5'], ['c2', 'c3'], ['g8', 'f6'],
  ['d2', 'd3'], ['d7', 'd6'], ['e1', 'g1'], ['e8', 'g8'], ['b1', 'd2'], ['a7', 'a6'], ['d2', 'b3'], ['c5', 'b6'],
  ['c1', 'g5'], ['h7', 'h6'], ['g5', 'h4'], ['c8', 'g4'],
];
const FOOLS = [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']];

async function lobby(t, host = IVAN, settings = { base: 0 }, reqId = 'c1') {
  await t.start(host);
  if (!t.group) await t.cmd(host, '/play');
  t.openHub(host);
  await t.send(host, { t: 'create', game: 'chess', settings, reqId });
  return t.chess;
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

/** Сыграть ходы со страниц тех, чей они. */
async function play(t, room, moves) {
  for (const [from, to, promo] of moves) {
    const m = room.match;
    const u = (m.pos.t === 'w') === (m.white === '101') ? IVAN : MAX;
    await t.send(u, { t: 'move', from, to, ...(promo ? { promo } : {}), ply: m.moves.length });
    assert.equal(t.lastError(u)?.code ?? null, null, `${from}${to} от ${u.first_name} принят`);
  }
}

const errors = (t, u) => t.page(u).inbox.filter((m) => m.t === 'error');

/* ------------------------------------------------------------ дуэльные лобби */

test('дуэли: у хоста несколько лобби сразу, у каждого своя карточка, повтор reqId не плодит стол', async () => {
  const t = new Table();
  const a = await lobby(t, IVAN, { base: 300 }, 'a');
  const cardA = a.ui.tableMessageId;
  const posts = groupPosts(t).length;

  t.openHub(IVAN);
  await t.send(IVAN, { t: 'create', game: 'chess', settings: { base: 60 }, reqId: 'b' });
  assert.equal(live(t).length, 2, 'второе лобби того же хоста в той же игре');
  const b = live(t)[1];
  assert.notEqual(b.code, a.code);
  assert.equal(b.settings.base, 60, 'у второго свои часы');
  assert.equal(a.ui.tableMessageId, cardA, 'карточка первого не тронута');
  assert.equal(groupPosts(t).length, posts + 1, 'в группе одна новая карточка');

  t.openHub(IVAN);
  await t.send(IVAN, { t: 'create', game: 'chess', settings: { base: 60 }, reqId: 'b' });
  assert.equal(live(t).length, 2, 'тот же reqId — тот же стол, не третий');
  assert.equal(t.state(IVAN).room.code, b.code, 'хост снова на этом же столе');
});

test('дуэли: два лобби — две независимые партии с одним и тем же соперником', async () => {
  const t = new Table();
  const a = await lobby(t, IVAN, { base: 0 }, 'a');
  t.openHub(IVAN);
  await t.send(IVAN, { t: 'create', game: 'chess', settings: { base: 0 }, reqId: 'b' });
  const b = live(t)[1];
  await t.start(MAX);
  for (const r of [a, b]) {
    t.openRoom(MAX, r);
    await t.send(MAX, { t: 'sit' });
    await t.send(IVAN, { t: 'join', code: r.code }).catch(() => {});
  }
  // Иван открывает каждый стол и начинает партию.
  for (const r of [a, b]) {
    t.openRoom(IVAN, r);
    await t.send(IVAN, { t: 'start' });
  }
  t.openRoom(IVAN, a);
  await t.send(IVAN, { t: 'move', from: 'e2', to: 'e4' });
  assert.equal(a.match.moves.length, 1);
  assert.equal(b.match.moves.length, 0, 'ход в одной партии не затронул другую');
  assert.notEqual(a.match.pos, b.match.pos);
});

test('остальные игры: правило «одно лобби на хоста» осталось, reqId его не обходит', async () => {
  const t = new Table();
  await t.start(IVAN);
  await t.cmd(IVAN, '/play');
  t.openHub(IVAN);
  await t.send(IVAN, { t: 'create', game: 'colors', settings: {}, reqId: 'x' });
  t.openHub(IVAN);
  await t.send(IVAN, { t: 'create', game: 'colors', settings: {}, reqId: 'y' });
  assert.equal(live(t, 'colors').length, 1, 'UNOQ: второе лобби не создано');
  t.openHub(IVAN);
  await t.send(IVAN, { t: 'create', game: 'durak', settings: {} });
  t.openHub(IVAN);
  await t.send(IVAN, { t: 'create', game: 'durak', settings: {} });
  assert.equal(live(t, 'durak').length, 1, 'дурак: тоже одно');
});

test('шахматы со старой страницы без reqId: одно лобби, как раньше — двойной тап безопасен', async () => {
  const t = new Table();
  await t.start(IVAN);
  await t.cmd(IVAN, '/play');
  t.openHub(IVAN);
  await t.send(IVAN, { t: 'create', game: 'chess', settings: {} });
  t.openHub(IVAN);
  await t.send(IVAN, { t: 'create', game: 'chess', settings: {} });
  assert.equal(live(t).length, 1);
});

test('лимит живых столов в группе действует и на дуэли', async () => {
  const t = new Table();
  await lobby(t, IVAN, {}, 'n0');
  for (let i = 1; i < 12; i++) {
    t.openHub(IVAN);
    await t.send(IVAN, { t: 'create', game: 'chess', settings: {}, reqId: `n${i}` });
  }
  assert.equal(live(t).length, 10);
  assert.match(errors(t, IVAN).at(-1).text, /незаконченных игр/);
});

test('/cancel и /finish при нескольких своих играх: бот спрашивает, какую, и ничего не удаляет наугад', async () => {
  const t = new Table();
  const a = await lobby(t, IVAN, {}, 'a');
  t.openHub(IVAN);
  await t.send(IVAN, { t: 'create', game: 'chess', settings: {}, reqId: 'b' });
  const b = live(t)[1];

  await t.cmd(IVAN, '/cancel');
  assert.equal(live(t).length, 2, 'ничего не удалено');
  assert.match(t.lastPost(), /несколько игр/);
  assert.ok(t.lastPost().includes(`/cancel ${a.code}`) && t.lastPost().includes(`/cancel ${b.code}`), 'коды названы');

  await t.cmd(IVAN, `/cancel ${a.code}`);
  assert.deepEqual(live(t).map((r) => r.code), [b.code], 'удалена именно названная');
  await t.cmd(IVAN, '/cancel');
  assert.equal(live(t).length, 0, 'осталась одна — команда без кода работает, как раньше');
});

test('несколько дуэлей одного хоста различимы: и в хабе, и в ответе бота', async () => {
  const t = new Table();
  // Худший случай: оба стола одной игры, одного хоста, с одними соперниками.
  // Отличаются только часами — и кодом.
  const a = await lobby(t, IVAN, { base: 300, inc: 2 }, 'a');
  t.openHub(IVAN);
  await t.send(IVAN, { t: 'create', game: 'chess', settings: { base: 60, inc: 0 }, reqId: 'b' });
  const b = live(t)[1];

  // 1. Хаб отдаёт строке то, чем стол опознаётся: свой код и свою подробность.
  t.openHub(IVAN);
  const hub = t.state(IVAN);
  assert.equal(hub.kind, 'hub');
  const rows = hub.lobbies.filter((l) => l.game === 'chess');
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((r) => r.code)).size, 2, 'коды разные');
  assert.ok(rows.every((r) => r.detail), 'у каждой строки есть подробность');
  assert.equal(new Set(rows.map((r) => r.detail)).size, 2, 'подробности разные — столы различимы по смыслу');

  // 2. Бот, спрашивая «какая именно», тоже называет не только код.
  await t.cmd(IVAN, '/cancel');
  const asked = t.lastPost();
  assert.match(asked, /несколько игр/);
  for (const r of [a, b]) assert.ok(asked.includes(`/cancel ${r.code}`), `код ${r.code} назван`);
  const lines = asked.split('\n').filter((l) => l.includes('/cancel '));
  assert.equal(lines.length, 2);
  assert.equal(new Set(lines.map((l) => l.replace(/ — \/cancel \w+$/, ''))).size, 2,
    'строки отличаются не только кодом: по ним видно, какая партия какая');
});

test('/cancel с чужим кодом: чужую игру не удалить', async () => {
  const t = new Table();
  const a = await lobby(t, IVAN, {}, 'a');
  await t.start(MAX);
  await t.cmd(MAX, `/cancel ${a.code}`);
  assert.equal(live(t).length, 1, 'игра Ивана жива');
});

/* ---------------------------------------------------------- партия и доска */

test('партия двух страниц до мата: каждый ход — с его телефона, итоги в группе один раз', async () => {
  const t = new Table();
  const room = await duel(t);
  assert.equal(t.state(IVAN).me.color, 'w');
  assert.equal(t.state(MAX).me.color, 'b');
  await play(t, room, FOOLS);

  assert.deepEqual(room.match.over, { winner: 'b', kind: 'mate' });
  const s = t.state(IVAN);
  assert.equal(s.match.over.why, 'мат');
  assert.deepEqual(s.match.moves, ['f3', 'e5', 'g4', 'Qh4#']);
  assert.equal(s.match.check, 'e1', 'король под матом подсвечен');
  assert.equal(s.canNext, true);
  assert.equal(t.state(MAX).score.find((r) => r.name === 'Макс').wins, 1);

  await t.send(IVAN, { t: 'next' });
  assert.equal(room.match.white, '202', 'цвета сменились');
  assert.equal(t.state(MAX).me.color, 'w');
  await t.send(IVAN, { t: 'finish' });
  const results = groupPosts(t).filter((c) => /ИТОГИ · ШАХМАТЫ/.test(c.text));
  assert.equal(results.length, 1);
  assert.match(results[0].text, /Макс\s+1 · 0 · 0/);
});

test('никто не ходит за другого: чужая очередь, зритель, подделка цвета и id в теле', async () => {
  const t = new Table();
  const room = await duel(t);
  await t.start(DIMA);
  t.openRoom(DIMA, room);

  // Макс (чёрные) пытается сходить за белых, назвавшись Иваном и белыми.
  await t.send(MAX, { t: 'move', from: 'e2', to: 'e4', uid: '101', id: '101', color: 'w', userId: 101 });
  assert.equal(errors(t, MAX).at(-1).code, 'NOT_YOUR_TURN');
  assert.match(errors(t, MAX).at(-1).text, /ходит соперник/, 'отказ объяснён словами');
  // Зритель — тем более.
  await t.send(DIMA, { t: 'move', from: 'e2', to: 'e4', uid: '101' });
  assert.equal(errors(t, DIMA).at(-1).code, 'NOT_IN_GAME');
  await t.send(DIMA, { t: 'resign' });
  await t.send(DIMA, { t: 'draw' });
  await t.send(DIMA, { t: 'abort' });
  await t.send(DIMA, { t: 'start' });
  assert.equal(room.match.moves.length, 0);
  assert.equal(room.match.over, null, 'ни сдаться, ни отменить, ни предложить за двоих зритель не смог');
  assert.equal(room.hostId, '101');

  // Гость не управляет столом: ни настройки, ни удаление, ни передача.
  await t.send(MAX, { t: 'settings', base: 60 });
  await t.send(MAX, { t: 'kick', seat: 0 });
  await t.send(MAX, { t: 'host', seat: 1 });
  assert.equal(room.settings.base, 0);
  assert.equal(room.hostId, '101');
  assert.equal(room.players.find((p) => p.id === '101').kicked, false);
  // Чужие действия других игр не проходят.
  await t.send(IVAN, { t: 'attack', card: 'S6' });
  assert.equal(errors(t, IVAN).at(-1).code, 'BAD_REQUEST');
});

test('ходы приходят только тому, чей сейчас ход; ждущему и зрителю — ни одного', async () => {
  const t = new Table();
  const room = await duel(t);
  await t.start(DIMA);
  t.openRoom(DIMA, room);

  const w = t.state(IVAN);
  assert.equal(w.legal.myTurn, true);
  assert.equal(w.legal.to.e2.length, 2, 'e3 и e4');
  assert.deepEqual(w.legal.promo, []);
  for (const u of [MAX, DIMA]) {
    const s = t.state(u);
    assert.deepEqual(s.legal, { myTurn: false }, `${u.first_name}: ходов нет`);
  }
  await play(t, room, [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3']]);

  // За всю партию ни один не-ходивший не получил ни одного списка ходов.
  const everyone = [[IVAN, 'w'], [MAX, 'b'], [DIMA, null]];
  for (const [u, color] of everyone) {
    for (const m of t.page(u).inbox.filter((x) => x.t === 'state' && x.state.game === 'chess')) {
      const turn = m.state.match?.turn;
      if (m.state.legal.myTurn) assert.equal(turn, color, `${u.first_name} получил ходы не в свой ход`);
      else assert.equal(m.state.legal.to, undefined);
    }
  }
});

test('проигранный ход возвращает на страницу настоящую позицию', async () => {
  const t = new Table();
  const room = await duel(t);
  const before = t.page(IVAN).inbox.length;
  await t.send(IVAN, { t: 'move', from: 'e2', to: 'e5' });
  const got = t.page(IVAN).inbox.slice(before);
  assert.equal(got.find((m) => m.t === 'error').code, 'ILLEGAL');
  assert.ok(got.some((m) => m.t === 'state'), 'и состояние пришло заново');
  assert.equal(room.match.moves.length, 0);
});

test('превращение: пешка у края просит выбор, ход без фигуры отвергается', async () => {
  const t = new Table();
  const room = await duel(t);
  const { fromFen } = await import('./games/chess/board.js');
  room.match.pos = fromFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  await t.send(IVAN, { t: 'move', from: 'a7', to: 'a8' });
  assert.equal(errors(t, IVAN).at(-1).code, 'NEED_PROMO');
  assert.ok(t.state(IVAN).legal.promo.includes('a7a8'), 'страница знает, какие ходы требуют выбора');
  await t.send(IVAN, { t: 'move', from: 'a7', to: 'a8', promo: 'q' });
  assert.equal(room.match.pos.b[56], 'Q');
});

/* ----------------------------------------------------------- группа и личка */

test('группа молчит про позицию: карточка и итоги, в них ни доски, ни фигур по клеткам', async () => {
  const t = new Table();
  const room = await duel(t);
  await play(t, room, [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3']]);
  const texts = t.tg.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => c.text);
  const card = texts.filter((x) => /Шахматы/.test(x)).at(-1);
  assert.match(card, /Партия #1/);
  assert.match(card, /Идёт игра — доска в приложении/, 'карточка говорит, где смотреть, а не пересказывает позицию');
  assert.doesNotMatch(texts.join('\n'), /rnbqkbnr|♞|♘|♟️?[a-h][1-8]/, 'позиция в чат не уходит');
  await play(t, room, [['b8', 'c6'], ['f1', 'c4'], ['g8', 'f6'], ['d2', 'd3']]);
  await t.send(MAX, { t: 'resign' });
  assert.match(t.text(), /Иван<\/b>, сдался/, 'на карточке результат');
});

test('«ваш ход» уходит в личку тому, чей ход, если приложение закрыто, и снимается после хода', async () => {
  const t = new Table();
  const room = await duel(t);
  await t.start(MAX);
  await t.send(MAX, { t: 'visible', visible: false });
  await t.send(IVAN, { t: 'move', from: 'e2', to: 'e4' });
  const ping = [...t.tg.messages.entries()].filter(([, m]) => m.chatId === '202' && /Ваш ход/.test(m.text)).at(-1);
  assert.ok(ping, 'Максу напомнили');
  assert.match(ping[1].text, /Соперник: 1\. e4/);
  assert.ok(!t.tg.dms(101).some((x) => /Ваш ход/.test(x)), 'Иван смотрит на стол — ему не пишем');
  await t.send(MAX, { t: 'move', from: 'e7', to: 'e5' });
  assert.equal(t.tg.message(ping[0]).deleted, true, 'сходил — напоминание убрано');
  assert.equal(room.match.moves.length, 2);
});

/* ------------------------------------------------------------------- часы */

test('часы: время вышло — выигрывает соперник, у всех на экране, в рейтинге +20 и −10', async () => {
  const t = new Table({ store: new Store(':memory:') });
  const room = await duel(t, { base: 60 });
  await play(t, room, LONG);
  const s = t.state(IVAN);
  assert.equal(s.match.clock.timed, true);
  assert.equal(s.match.clock.mover, 'w');
  assert.equal(s.match.clock.deadline, t.clock.now() + 60_000, 'срок едет вместе с состоянием');
  assert.equal(s.match.clock.first, false);

  await t.advance(59_000);
  assert.equal(room.match.over, null);
  await t.advance(1_000);
  assert.deepEqual(room.match.over, { winner: 'b', kind: 'time' });
  assert.match(t.state(MAX).room.notice, /Макс выиграл: время вышло/);
  assert.equal(t.state(IVAN).match.over.winner, 'b');
  assert.equal(t.app.store.ratingOf(202, 'chess').points, PLACE[0], 'победителю +20');
  // «−10» записано в журнал, но очки не уходят ниже нуля (store.ratingOf).
  assert.equal(t.app.store.ratingOf(101, 'chess').points, 0);
  assert.equal(t.app.store.ratingOf(101, 'chess').played, 1, 'а партия проигравшему записана');
  assert.equal(room.rated[`${room.code}#1`].rows.find((r) => r.userId === '101').delta, LAST);
  t.app.store.close();
});

test('карточка в группе не правится от хода к ходу: блиц не засыпает Telegram запросами', async () => {
  const t = new Table();
  const room = await duel(t);
  const edits = () => t.tg.calls.filter((c) => c.method === 'editMessageText').length;
  const before = edits();
  await play(t, room, LONG);
  assert.equal(edits(), before, 'двадцать ходов — ни одной правки карточки');
  await t.send(MAX, { t: 'resign' });
  assert.ok(edits() > before, 'а итог партии на карточке появился');
});

test('рейтинг: короткая сдача очков не даёт, длинная — даёт', async () => {
  const t = new Table({ store: new Store(':memory:') });
  const room = await duel(t);
  await play(t, room, [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6']]);
  await t.send(MAX, { t: 'resign' });
  assert.equal(t.app.store.ratingOf(101, 'chess'), null, 'сдался на втором ходу — очков нет');
  assert.match(room.rated[`${room.code}#1`].why, /короче 10 ходов/);
  await t.send(IVAN, { t: 'next' });
  await play(t, room, LONG);
  await t.send(IVAN, { t: 'resign' });
  assert.equal(t.app.store.ratingOf(202, 'chess').points, PLACE[0], 'Иван сдался в длинной партии — победа Макса засчитана');
  t.app.store.close();
});

test('рейтинг: мат на пятом ходу считается — короткий конец естественный', async () => {
  const t = new Table({ store: new Store(':memory:') });
  const room = await duel(t);
  await play(t, room, FOOLS);
  assert.equal(t.app.store.ratingOf(202, 'chess').points, PLACE[0]);
  t.app.store.close();
});

test('часы: пока никто не пришёл на первый ход, партия отменяется и в рейтинг не идёт', async () => {
  const t = new Table({ store: new Store(':memory:') });
  const room = await duel(t, { base: 0 });
  assert.equal(t.state(MAX).match.clock.first, true);
  await t.advance(59_999);
  assert.equal(room.match.over, null);
  await t.advance(1);
  assert.equal(room.match.over.kind, 'aborted');
  assert.match(t.state(IVAN).room.notice, /не сделал первый ход/);
  assert.equal(t.app.store.ratingOf(101, 'chess'), null, 'ни строчки в рейтинге');
  assert.match(room.rated[`${room.code}#1`].why, /не доиграна/);
  t.app.store.close();
});

test('ничья в рейтинг очков не даёт — и это сказано словами', async () => {
  const t = new Table({ store: new Store(':memory:') });
  const room = await duel(t);
  await play(t, room, [['e2', 'e4'], ['e7', 'e5']]);
  await t.send(IVAN, { t: 'draw' });
  assert.equal(t.state(MAX).match.drawOffer.byColor, 'w');
  assert.equal(t.state(MAX).canAnswerDraw, true);
  assert.equal(t.state(IVAN).canAnswerDraw, false, 'своё предложение не принять');
  await t.send(MAX, { t: 'draw' });
  assert.deepEqual(room.match.over, { winner: null, kind: 'agreed' });
  assert.equal(t.app.store.ratingOf(101, 'chess'), null);
  assert.equal(t.app.store.ratingOf(202, 'chess'), null);
  assert.match(room.rated[`${room.code}#1`].why, /ничья — очков нет/);
  t.app.store.close();
});

test('обслуживание не съедает время на часах', async () => {
  const t = new Table({ store: new Store(':memory:'), admins: ['101'] });
  const room = await duel(t, { base: 60 });
  await play(t, room, [['e2', 'e4'], ['e7', 'e5']]);
  await t.advance(20_000);
  t.openAdmin(IVAN);
  await t.send(IVAN, { t: 'maintenance', on: true });
  assert.equal(room.turn.deadline, null, 'часы остановлены');
  assert.ok(room.turn.remaining > 39_000 && room.turn.remaining <= 40_000);
  await t.advance(10 * 60_000);
  assert.equal(room.match.over, null, 'за время обслуживания флажок не упал');
  await t.send(IVAN, { t: 'maintenance', on: false });
  const left = room.turn.deadline - t.clock.now();
  assert.ok(left > 39_000 && left <= 40_000, `после снятия осталось ${Math.round(left / 1000)} с`);
  t.app.store.close();
});

test('перезапуск бота: стол и часы поднимаются из базы с тем же остатком', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store });
  const room = await duel(t, { base: 300 });
  await play(t, room, [['e2', 'e4'], ['e7', 'e5']]);
  await t.advance(100_000);
  t.app.save(room);

  const t2 = new Table({ store, clock: t.clock });
  t2.app.load();
  const back = t2.app.roomByCode(room.code);
  assert.ok(back, 'стол вернулся');
  assert.equal(back.game, 'chess');
  assert.equal(back.match.moves.length, 2);
  assert.ok(back.turn.remaining > 199_000 && back.turn.remaining <= 200_000, 'у белых осталось ~200 с');
  store.close();
});

test('зритель смотрит партию: видит доску и ходы, но не может сесть третьим', async () => {
  const t = new Table();
  const room = await duel(t);
  await t.start(DIMA);
  t.openRoom(DIMA, room);
  await t.send(DIMA, { t: 'sit' });
  assert.equal(errors(t, DIMA).at(-1).code, 'TABLE_FULL');
  assert.equal(t.state(DIMA).me.seated, false);
  await play(t, room, [['e2', 'e4']]);
  assert.deepEqual(t.state(DIMA).match.moves, ['e4'], 'зритель видит ход');
});

/* ------------------------------------------------------------------- откат */

test('откат через приложение: просит один, разрешает другой; зритель и сам просящий ничего не решают', async () => {
  const t = new Table();
  const room = await duel(t);
  await t.start(DIMA);
  t.openRoom(DIMA, room);
  await play(t, room, [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3']]);

  assert.equal(t.state(IVAN).canTakeback, true);
  assert.equal(t.state(DIMA).canTakeback, false, 'зрителю кнопки нет');
  await t.send(DIMA, { t: 'takeback' });
  assert.equal(errors(t, DIMA).at(-1).code, 'NOT_IN_GAME');
  assert.equal(room.match.takeback, null);

  await t.send(IVAN, { t: 'takeback' });
  assert.equal(room.match.takeback.by, '101');
  assert.equal(t.state(MAX).canAnswerTakeback, true, 'у соперника — «Разрешить / Отказать»');
  assert.equal(t.state(IVAN).canAnswerTakeback, false, 'свою просьбу самому не разрешить');
  assert.equal(t.state(MAX).match.takeback.byColor, 'w');
  await t.send(IVAN, { t: 'takeback' }); // повтор — не разрешение
  assert.equal(room.match.moves.length, 3, 'сам себе не разрешил');
  await t.send(DIMA, { t: 'declinetb' });
  assert.equal(room.match.takeback.by, '101', 'зритель отказать за Макса не может');

  // Макс (чёрные) пытается «разрешить» от имени Ивана: чужие поля игнорируются.
  await t.send(MAX, { t: 'takeback', uid: '101', color: 'w' });
  assert.equal(room.match.moves.length, 2, 'Макс разрешил — вернулся ход Nf3');
  assert.deepEqual(t.state(DIMA).match.moves, ['e4', 'e5'], 'зритель видит вернувшуюся позицию');
  assert.equal(t.state(IVAN).legal.myTurn, true);
  assert.match(t.state(IVAN).room.notice ?? '', /вернул ход|Иван/);
});

test('откат: отказ объясняется, запись и позиции для просмотра приходят со всеми клетками', async () => {
  const t = new Table();
  const room = await duel(t);
  await play(t, room, [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6']]);
  await t.send(MAX, { t: 'takeback' });
  await t.send(IVAN, { t: 'declinetb' });
  assert.equal(room.match.takeback, null);
  await t.send(MAX, { t: 'takeback' });
  assert.equal(errors(t, MAX).at(-1).code, 'TAKEBACK_COOLDOWN');
  assert.match(errors(t, MAX).at(-1).text, /ещё раз через пару ходов/);
  const log = t.state(IVAN).match.log;
  assert.deepEqual(log.map((x) => [x.from, x.to]), [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6']]);
  assert.equal(log[3].san, 'Nc6');
});

/* ------------------------------------------------- быстрое лобби и «поделиться» */

const lobbies = (t, game = 'chess') => t.app.liveRooms(String(t.chatId)).filter((r) => r.game === game && r.status === 'lobby');

test('/chess в группе: лобби одной командой, и повторно — ещё одно (дуэль); карточка с «Присоединиться»', async () => {
  const t = new Table();
  await t.start(IVAN);
  await t.cmd(IVAN, '/chess');
  assert.equal(lobbies(t).length, 1);
  const room = lobbies(t)[0];
  assert.equal(room.hostId, '101');
  assert.deepEqual(room.settings, { base: 600, inc: 0, side: 'random' }, 'настройки по умолчанию');
  const card = t.app.outbox ? t.tg.message(room.ui.tableMessageId) : null;
  assert.match(card.text, /Шахматы/);
  assert.equal(card.markup.inline_keyboard[0][0].text, '♟ Присоединиться');
  await t.cmd(IVAN, '/chess');
  assert.equal(lobbies(t).length, 2, 'у дуэли — несколько лобби подряд');
});

test('/durak и /unoq: одно лобби на хоста, повтор напоминает о нём; чужое лобби не мешает', async () => {
  const t = new Table();
  await t.start(IVAN);
  await t.cmd(IVAN, '/durak');
  await t.cmd(IVAN, '/durak');
  assert.equal(lobbies(t, 'durak').length, 1, 'второе не создано');
  assert.match(t.lastPost(), /уже есть открытое лобби: 🃏 Дурак/);
  await t.cmd(MAX, '/durak');
  assert.equal(lobbies(t, 'durak').length, 2, 'у другого хоста — своё');
  await t.cmd(IVAN, '/unoq');
  assert.equal(lobbies(t, 'colors').length, 1);
  assert.equal(lobbies(t, 'colors')[0].hostId, '101');
});

test('быстрые команды: лимит 10 столов и обслуживание действуют и на них', async () => {
  const t = new Table({ admins: ['101'] });
  await t.start(IVAN);
  for (let i = 0; i < 12; i++) await t.cmd(IVAN, '/chess');
  assert.equal(lobbies(t).length, 10);
  assert.match(t.lastPost(), /незаконченных игр/);
  const t2 = new Table({ admins: ['101'] });
  await t2.start(IVAN);
  t2.app.setMaintenance(true, 'Скоро вернёмся');
  await t2.cmd(IVAN, '/chess');
  assert.equal(lobbies(t2).length, 0, 'во время обслуживания лобби не создаётся');
  assert.match(t2.lastPost(), /Идёт обслуживание/);
});

test('«+ Новое лобби» из лобби: та же игра и настройки, хост — тот, кто нажал; только со страницы из хаба', async () => {
  const t = new Table();
  const first = await lobby(t, IVAN, { base: 180, inc: 2, side: 'black' }, 'q1');
  const posts = groupPosts(t).length;
  await t.send(IVAN, { t: 'again', reqId: 'quick1' });
  assert.equal(lobbies(t).length, 2);
  const second = lobbies(t)[1];
  assert.deepEqual(second.settings, first.settings, 'те же часы и цвет');
  assert.equal(second.hostId, '101');
  assert.equal(groupPosts(t).length, posts + 1, 'своя карточка в группе');
  assert.equal(t.state(IVAN).room.code, second.code, 'хост сразу в новом лобби');
  await t.send(IVAN, { t: 'again', reqId: 'quick1' });
  assert.equal(lobbies(t).length, 2, 'повтор того же reqId — не третье');

  // Страница, открытая по карточке (не из хаба), этой кнопки не имеет.
  await t.start(MAX);
  t.openRoom(MAX, first);
  await t.send(MAX, { t: 'again', reqId: 'x' });
  assert.equal(errors(t, MAX).at(-1).code, 'NOT_FROM_HUB');
  assert.equal(lobbies(t).length, 2);
});

test('«+ Новое лобби»: страница группы A не создаёт лобби по столу группы B', async () => {
  const t = new Table();
  await lobby(t, IVAN, {}, 'a1');
  const foreign = t.app.createGame('chess', { chatId: '-777', title: 'Чужая', host: { id: 555, tgId: 555, name: 'Чужой' } });
  t.openHub(IVAN);
  t.hub.enterRoom(t.page(IVAN).session, foreign); // страница каким-то образом оказалась за чужим столом
  await t.send(IVAN, { t: 'again', reqId: 'steal' });
  assert.equal(errors(t, IVAN).at(-1).code, 'NOT_FROM_HUB');
  assert.equal(t.app.liveRooms('-777').length, 1, 'в чужой группе ничего не появилось');
  assert.equal(lobbies(t).length, 1, 'и в нашей тоже');
});

test('поделиться итогом: игрок получает заготовку сообщения; в ней имена, исход и реклама бота', async () => {
  const t = new Table({ botUsername: 'ChipTableBot', miniAppName: 'table' });
  const room = await duel(t);
  await play(t, room, FOOLS);
  await t.send(MAX, { t: 'share' });
  const msg = t.page(MAX).inbox.filter((m) => m.t === 'share').at(-1);
  assert.ok(msg, 'страница получила ответ');
  assert.equal(msg.id, 'prep1', 'id заготовки — по нему страница вызовет shareMessage');
  assert.equal(msg.link, 'https://t.me/ChipTableBot/table');
  assert.match(msg.text, /Шахматы: Иван ⚪ — ⚫ Макс/);
  assert.match(msg.text, /Победил Макс — мат, 2 хода/);
  assert.match(msg.text, /@ChipTableBot/, 'в тексте — имя бота');
  const sent = t.tg.prepared.at(-1);
  assert.equal(sent.userId, '202', 'заготовка — для того, кто нажал, и отправит её он сам');
  assert.equal(sent.result.reply_markup.inline_keyboard[0][0].url, 'https://t.me/ChipTableBot/table', 'кнопка «Сыграть со мной» ведёт в бота');
  assert.equal(sent.result.input_message_content.parse_mode, 'HTML');
  assert.equal(sent.opts.allow_group_chats, true);
  assert.equal(sent.opts.allow_channel_chats, false);
  assert.ok(!/legal|FEN|rnbqk/.test(sent.result.input_message_content.message_text), 'позиции в сообщении нет');
});

test('поделиться: только игрок стола и только итогом сыгранной партии; имена экранируются; частые нажатия не плодят запросы', async () => {
  const t = new Table({ botUsername: 'ChipTableBot', miniAppName: 'table' });
  const room = await duel(t);
  await t.start(DIMA);
  t.openRoom(DIMA, room);
  await play(t, room, FOOLS);
  await t.send(DIMA, { t: 'share' });
  assert.equal(errors(t, DIMA).at(-1).code, 'NOT_IN_GAME', 'зритель чужой итог от своего имени не отправляет');
  assert.equal(t.tg.prepared ?? undefined, undefined, 'заготовка не создана');
  await t.send(IVAN, { t: 'share' });
  await t.send(IVAN, { t: 'share' });
  assert.equal(errors(t, IVAN).at(-1).code, 'TOO_FAST');
  assert.equal(t.tg.prepared.length, 1, 'второе нажатие подряд не ушло в Telegram');

  // Пока партия идёт, делиться нечем.
  const t4 = new Table({ botUsername: 'ChipTableBot', miniAppName: 'table' });
  await duel(t4);
  await t4.send(IVAN, { t: 'share' });
  assert.equal(errors(t4, IVAN).at(-1).code, 'NOT_SHAREABLE');

  // Отменённая партия — не итог.
  const t2 = new Table({ botUsername: 'ChipTableBot', miniAppName: 'table' });
  const r2 = await duel(t2);
  await t2.send(IVAN, { t: 'abort' });
  await t2.send(IVAN, { t: 'share' });
  assert.equal(errors(t2, IVAN).at(-1).code, 'NOT_SHAREABLE');

  // Имя игрока с разметкой не ломает HTML сообщения.
  const t3 = new Table({ botUsername: 'ChipTableBot', miniAppName: 'table' });
  const r3 = await duel(t3);
  r3.players.find((p) => p.id === '101').name = '<b>Иван</b> & Ко';
  await play(t3, r3, FOOLS);
  await t3.send(MAX, { t: 'share' });
  const html = t3.tg.prepared.at(-1).result.input_message_content.message_text;
  assert.match(html, /&lt;b&gt;Иван&lt;\/b&gt; &amp; Ко/);
  assert.ok(!html.includes('<b>'), 'чужая разметка не прошла');
});

test('поделиться: Telegram не принял заготовку — страница всё равно получает текст и ссылку для запасного пути', async () => {
  const t = new Table({ botUsername: 'ChipTableBot', miniAppName: 'table' });
  const room = await duel(t);
  await play(t, room, FOOLS);
  t.tg.failNext = { method: 'savePreparedInlineMessage', error: new Error('Bad Request: method not found') };
  await t.send(IVAN, { t: 'share' });
  const msg = t.page(IVAN).inbox.filter((m) => m.t === 'share').at(-1);
  assert.equal(msg.id, null, 'заготовки нет');
  assert.match(msg.text, /Победил Макс/);
  assert.equal(msg.link, 'https://t.me/ChipTableBot/table');
});
