'use strict';
/**
 * «UNOQ» через мини-приложение: те же два железных правила, что у покера и
 * дурака.
 *
 *   НИКТО НЕ ВИДИТ ЧУЖИХ КАРТ — проверяется на ВСЁМ, что каждый телефон
 *   получил за целую партию, и на каждом сообщении в группе и в личках.
 *
 *   НИКТО НЕ ХОДИТ ЗА ДРУГОГО — у каждого своя подписанная страница; атака
 *   это быть не тем человеком или назваться другим в теле сообщения.
 *
 * И группа молчит: карточка и итоги, больше ничего.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, colorsStack, colorsDecks, colorsRandom, initDataFor, TEST_TOKEN, FakeClock } from './harness.js';
import { App } from './app.js';
import { Hub } from './hub.js';
import { Store } from './store.js';
import { IDLE_CLOSE_MS, IDLE_WARN_MS } from './app.js';
import { PLACE, LAST } from './rating.js';
import { TITLE } from './games/colors/rules.js';

const THREE = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') });

const groupPosts = (t) => t.tg.calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(t.chatId));
const everyText = (t) => t.tg.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => c.text);

/** Код карты «UNOQ» в JSON — ровно в кавычках, чтобы не ловить обрывки слов. */
const CARD_CODE = /"(?:[RYGB](?:[0-9]|S|V|P)|WC|WF)"/g;
/** Карта, названная словами в Telegram: «красная 5», «синий «стоп»». */
const CARD_WORD = /(красн|жёлт|зелён|син)(ая|ый|ую|ого)\s+(\d|«)/i;

/**
 * `/play` → хост создаёт лобби из хаба → остальные открывают его по карточке
 * и садятся → хост начинает. Все нажали Start в личке.
 */
async function begin(t, cast, { settings = {}, start = true } = {}) {
  const [host, ...rest] = Object.values(cast);
  for (const u of Object.values(cast)) await t.start(u);
  await t.cmd(host, '/play');
  t.openHub(host);
  await t.send(host, { t: 'create', game: 'colors', settings });
  const room = t.colors;
  for (const u of rest) {
    t.openRoom(u, room);
    await t.send(u, { t: 'sit' });
  }
  if (start) await t.send(host, { t: 'start' });
  return room;
}

const who = (cast, id) => Object.values(cast).find((u) => String(u.id) === String(id));

/**
 * Доиграть партию так, как это сделали бы страницы: каждый ход выбирается из
 * того, что СОБСТВЕННАЯ страница игрока называет законным, и шлётся с неё.
 */
async function playOut(t, cast, limit = 2000) {
  for (let i = 0; i < limit && t.colors.deal?.phase === 'play'; i++) {
    const d = t.colors.deal;
    const u = who(cast, d.turn);
    if (!u) break;
    const s = t.state(u);
    const L = s.legal;
    if (L.shout) await t.send(u, { t: 'shout' });
    if (L.play.length) {
      const card = L.play[0];
      const wild = card === 'WC' || card === 'WF';
      await t.send(u, { t: 'play', card, ...(wild ? { color: 'R' } : {}), seq: t.state(u).seq });
    } else if (L.draw) {
      await t.send(u, { t: 'draw', seq: s.seq });
    } else if (L.pass) {
      await t.send(u, { t: 'pass', seq: s.seq });
    } else {
      assert.fail(`${u.first_name}: страница не предлагает ни одного хода`);
    }
  }
  assert.equal(t.colors.deal.phase, 'over', 'партия доиграна до конца');
}

/** Каждая карта в состоянии должна быть своей, верхней на куче или из ленты. */
function onlyAllowedCards(state, label) {
  const json = JSON.stringify(state);
  const allowed = new Set([...(state.me?.cards || []), ...(state.me?.dealt || []), state.deal?.top].filter(Boolean));
  for (const e of state.deal?.events || []) if (e.card) allowed.add(e.card);
  if (state.deal?.drawn) allowed.add(state.deal.drawn);
  for (const m of json.match(CARD_CODE) || []) {
    const c = m.slice(1, -1);
    assert.ok(allowed.has(c), `${label}: в состоянии чужая карта ${c}`);
  }
  if (state.deal) {
    assert.equal(typeof state.deal.deck, 'number', `${label}: колода — только число`);
    assert.equal(typeof state.deal.discard, 'number', `${label}: сброс — только число`);
  }
  for (const k of ['hands', 'order', 'stats', 'pendingBy']) {
    assert.ok(!(k in (state.deal || {})), `${label}: нет поля ${k}`);
  }
}

/* ------------------------------------------------------------ приватность */

test('15. целая партия: в каждом состоянии любого телефона — только свои карты, куча и лента', async () => {
  const cast = THREE();
  const t = new Table({ colorsDeck: colorsDecks(5), colorsRand: colorsRandom(5) });
  await begin(t, cast);
  // Прохожий, который открыл ссылку, но не сел, смотрит всю партию.
  const guest = user(9999, 'Прохожий');
  t.openRoom(guest, t.colors);
  await playOut(t, cast);

  for (const u of [...Object.values(cast), guest]) {
    const states = t.page(u).inbox.filter((m) => m.t === 'state');
    assert.ok(states.length > 20, `${u.first_name} получал партию ход за ходом`);
    for (const [i, m] of states.entries()) onlyAllowedCards(m.state, `${u.first_name} #${i}`);
  }
  const seen = t.state(guest);
  assert.deepEqual(seen.me.cards, [], 'у прохожего нет карт');
  assert.ok(seen.players.every((p) => typeof p.count === 'number' && !('cards' in p)), 'чужие руки — числа');
});

test('15а. свои карты есть у хозяина с первой же сдачи — и ни у кого больше', async () => {
  const cast = THREE();
  const t = new Table({ colorsDeck: colorsDecks(6) });
  const room = await begin(t, cast);
  for (const u of Object.values(cast)) {
    const mine = room.deal.hands[String(u.id)];
    assert.deepEqual([...t.state(u).me.cards].sort(), [...mine].sort(), `${u.first_name} видит свои семь`);
    assert.deepEqual([...t.state(u).me.dealt].sort(), [...mine].sort(), 'и в порядке прихода — те же');
    for (const other of Object.values(cast).filter((o) => o !== u)) {
      const everything = t.received(other);
      const theirs = room.deal.hands[String(other.id)];
      for (const c of mine) {
        // Карта встречается в колоде дважды — чужая рука не в счёт, если
        // такая же карта законно лежит у него самого или на куче.
        if (theirs.includes(c) || room.deal.top === c) continue;
        assert.ok(!everything.includes(`"${c}"`), `${other.first_name} никогда не получал ${c} от ${u.first_name}`);
      }
    }
  }
});

test('15б. ни группа, ни личка не видят карты — только названный цвет', async () => {
  const cast = THREE();
  const t = new Table({ colorsDeck: colorsDecks(7), colorsRand: colorsRandom(7) });
  await begin(t, cast);
  await t.send(cast.dima, { t: 'visible', visible: false });
  await playOut(t, cast);
  await t.cmd(cast.ivan, '/finish');
  const texts = everyText(t);
  assert.ok(texts.some((x) => /Ваш ход|На вас \+/.test(x)), 'толчки в личку уходили');
  for (const x of texts) {
    assert.ok(!CARD_WORD.test(x), `карта словами в Telegram: ${x}`);
    const bare = x.replace(/https?:\S+/g, '');
    assert.ok(!/(?:^|[^A-Za-z0-9])(?:[RYGB](?:[0-9]|S|V|P)|WC|WF)(?![A-Za-z0-9])/.test(bare), `код карты в Telegram: ${x}`);
  }
});

/* ------------------------------------------------- никто за другого */

test('16. ход в чужую очередь — отказ с объяснением, и стол не двигается', async () => {
  const cast = THREE();
  const t = new Table();
  t.useColorsDeck(colorsStack(
    { 101: 'R1 R2 R3 R4 R5 R6 R7', 202: 'G1 G2 G3 G4 G5 G6 G7', 303: 'B1 B2 B3 B4 B5 B6 B7' },
    { top: 'G0' },
  ));
  const room = await begin(t, cast);
  assert.equal(room.deal.turn, '202', 'первым ходит Макс — он слева от сдающего');

  await t.send(cast.dima, { t: 'play', card: 'B1' });
  assert.equal(t.lastError(cast.dima).code, 'NOT_YOUR_TURN');
  assert.match(t.lastError(cast.dima).text, /Сейчас ходит Макс/);
  assert.equal(room.deal.top, 'G0', 'на куче ничего не изменилось');
  assert.ok(room.deal.hands['303'].includes('B1'), 'карта осталась у него');
});

test('17. подмена: сообщение с чужим id играет от своего имени, не от чужого', async () => {
  const cast = THREE();
  const t = new Table();
  t.useColorsDeck(colorsStack(
    { 101: 'R1 R2 R3 R4 R5 R6 R7', 202: 'G1 G2 G3 G4 G5 G6 G7', 303: 'B1 B2 B3 B4 B5 B6 B7' },
    { top: 'G0' },
  ));
  const room = await begin(t, cast);
  // Иван шлёт ход Макса, называя Макса всеми способами, какие есть у сообщения.
  // Стол считает ходящим того, чья ПОДПИСЬ на странице, — то есть Ивана.
  await t.send(cast.ivan, { t: 'play', card: 'G1', id: 202, userId: '202', seat: 1, from: { id: 202 }, name: 'Макс' });
  assert.equal(room.deal.top, 'G0', 'ничего не сыграно');
  assert.equal(t.lastError(cast.ivan).code, 'NOT_YOUR_TURN', 'это ход Макса, а пришло от Ивана');
  assert.match(t.lastError(cast.ivan).text, /Сейчас ходит Макс/);

  // А на своём ходу чужой картой не сыграешь и подавно: рука — своя.
  await t.send(cast.max, { t: 'play', card: 'R1', id: 101, name: 'Иван' });
  assert.equal(t.lastError(cast.max).code, 'NOT_YOUR_CARD', 'эта карта в руке у Ивана, а не у него');
  assert.ok(room.deal.hands['101'].includes('R1'), 'и осталась у Ивана');

  await t.send(cast.ivan, { t: 'play', card: 'R1', as: '202' });
  assert.equal(t.lastError(cast.ivan).code, 'NOT_YOUR_TURN');
  await t.send(cast.ivan, { t: 'draw', seat: 1 });
  assert.equal(t.lastError(cast.ivan).code, 'NOT_YOUR_TURN');
  assert.equal(room.deal.hands['202'].length, 7, 'Макс не взял карту, потому что кто-то так сказал');

  // «Последняя!» и «Поймал!» — тоже только за себя.
  room.deal.hands['202'] = ['G1', 'G2'];
  await t.send(cast.max, { t: 'play', card: 'G1' });
  await t.send(cast.ivan, { t: 'shout', seat: 1 });
  assert.equal(t.lastError(cast.ivan).code, 'NOT_ONE_CARD', 'за Макса «UNOQ» не нажать');
  assert.equal(room.deal.call.called, false);
  await t.send(cast.max, { t: 'catch' });
  assert.equal(t.lastError(cast.max).code, 'CATCH_SELF', 'и сам себя он не поймает');
});

test('17а. всякий отказ сказан словами, и страница возвращается к правде', async () => {
  const cast = THREE();
  const t = new Table();
  t.useColorsDeck(colorsStack(
    { 101: 'R1 R2 R3 R4 R5 R6 R7', 202: 'G1 B9 G3 G4 G5 G6 G7', 303: 'B1 B2 B3 B4 B5 B6 B7' },
    { top: 'G0' },
  ));
  await begin(t, cast);
  const before = t.page(cast.max).inbox.length;
  await t.send(cast.max, { t: 'play', card: 'B9' });
  const err = t.lastError(cast.max);
  assert.equal(err.code, 'CANNOT_PLAY');
  assert.match(err.text, /зелёный/);
  assert.ok(t.page(cast.max).inbox.slice(before).some((m) => m.t === 'state'), 'за отказом идёт свежее состояние');

  await t.send(cast.max, { t: 'play', card: 'ерунда' });
  assert.equal(t.lastError(cast.max).code, 'NOT_YOUR_CARD');
  await t.send(cast.max, { t: 'attack', card: 'G1' });
  assert.equal(t.lastError(cast.max).code, 'BAD_REQUEST', 'дурацкий ход за столом «UNOQ»');
  await t.send(cast.max, { t: 'draw' });
  assert.equal(t.lastError(cast.max).code, 'CAN_PLAY', 'есть чем ходить — брать не дают');
});

test('17б. кто только открыл ссылку — не играет, не начинает, не сдаёт следующую', async () => {
  const cast = THREE();
  const t = new Table({ colorsDeck: colorsDecks(3) });
  const room = await begin(t, cast, { start: false });
  const guest = user(9999, 'Прохожий');
  t.openRoom(guest, room);
  await t.send(guest, { t: 'start' });
  assert.equal(t.lastError(guest).code, 'NOT_HOST');
  await t.send(cast.ivan, { t: 'start' });
  await t.send(guest, { t: 'play', card: room.deal.hands[room.deal.turn][0] });
  assert.equal(t.lastError(guest).code, 'NOT_IN_DEAL', 'он вообще не в партии');
  await t.send(guest, { t: 'draw' });
  assert.equal(t.lastError(guest).code, 'NOT_IN_DEAL');
});

/* ------------------------------------------------------------- группа */

test('18. целая серия кладёт в группу ровно два сообщения: карточку и итоги', async () => {
  const cast = THREE();
  const t = new Table({ colorsDeck: colorsDecks(9), colorsRand: colorsRandom(9) });
  await begin(t, cast, { start: false });
  const posts = groupPosts(t).length;
  assert.equal(posts, 2, 'пока: карточка /play и карточка лобби');
  await t.send(cast.ivan, { t: 'start' });
  await playOut(t, cast);
  const card = t.tg.message(t.colors.ui.tableMessageId).text;
  assert.match(card, /последний —/);
  assert.match(card, /Счёт: /);
  await t.send(cast.max, { t: 'next' });
  await playOut(t, cast);
  assert.equal(groupPosts(t).length, posts, 'две партии — и ни одного нового сообщения в группе');

  await t.cmd(cast.ivan, '/finish');
  const all = groupPosts(t);
  assert.equal(all.length, posts + 1);
  const results = all.at(-1).text;
  assert.match(results, new RegExp(`ИТОГИ · ${TITLE.toUpperCase()}`), 'итоги подписаны именем игры, а не словом из прошлого');
  assert.match(results, /Партий сыграно: 2/);
  assert.match(t.tg.message(t.colors.ui.tableMessageId).text, /Игра завершена/);
  assert.equal(t.state(cast.dima).room.status, 'finished', 'телефоны тоже видят конец');
});

test('18а. карточка идёт за игрой правкой: чей ход, какой цвет, у кого одна карта', async () => {
  const cast = THREE();
  const t = new Table();
  t.useColorsDeck(colorsStack(
    { 101: 'R1 R2 R3 R4 R5 R6 R7', 202: 'G1 G2 G3 G4 G5 G6 G7', 303: 'B1 B2 B3 B4 B5 B6 B7' },
    { top: 'G0' },
  ));
  const room = await begin(t, cast);
  const text = () => t.tg.message(room.ui.tableMessageId).text;
  assert.match(text(), /Партия #1 · в колоде 86 · цвет зелёный \(квадрат\)/);
  assert.match(text(), /🎯 <b>Макс<\/b> ходит/);
  await t.send(cast.max, { t: 'play', card: 'G1' });
  assert.match(text(), /🎯 <b>Дима<\/b> ходит/);

  room.deal.hands['303'] = ['B2'];
  await t.send(cast.dima, { t: 'play', card: 'B2' });
  assert.ok(!/[RYGB][0-9]/.test(text()), 'карты с кучи в группе нет');
});

test('18б. «Последняя!» и «Поймал!» видно всем за столом, а в группе — только что одна карта', async () => {
  const cast = THREE();
  const t = new Table();
  t.useColorsDeck(colorsStack(
    { 101: 'R1 R2 R3 R4 R5 R6 R7', 202: 'G1 G2 G3 G4 G5 G6 G7', 303: 'B1 B2 B3 B4 B5 B6 B7' },
    { top: 'G0' },
  ));
  const room = await begin(t, cast);
  room.deal.hands['202'] = ['G1', 'G2'];
  await t.send(cast.max, { t: 'play', card: 'G1' });

  const seen = t.state(cast.dima);
  const macs = seen.players.find((p) => p.name === 'Макс');
  assert.equal(macs.alone, true, 'у Макса одна карта — это видно всем');
  assert.equal(macs.called, false, 'и что он ещё молчит — тоже');
  assert.equal(seen.legal.catch.seat, macs.seat, 'Диме предложено поймать');
  assert.equal(t.state(cast.max).legal.shout, true, 'а Максу — назваться');
  assert.equal(t.state(cast.max).legal.catch, null, 'себя он поймать не может');
  assert.match(t.tg.message(room.ui.tableMessageId).text, /Одна карта: Макс/);

  await t.send(cast.dima, { t: 'catch' });
  assert.equal(room.deal.hands['202'].length, 3, 'поймали — взял две');
  assert.equal(t.state(cast.ivan).deal.events.at(-1).kind, 'caught', 'и это есть в ленте у всех');
});

/* ------------------------------------------------------------- толчки */

test('19. тот, кого ждут с закрытым приложением, получает толчок — и он уходит, когда он сходил', async () => {
  const cast = THREE();
  const t = new Table();
  t.useColorsDeck(colorsStack(
    { 101: 'R1 R2 R3 R4 R5 R6 R7', 202: 'G1 G2 G3 G4 G5 G6 G7', 303: 'B1 B2 B3 B4 B5 B6 B7' },
    { top: 'G0' },
  ));
  const room = await begin(t, cast);
  await t.send(cast.dima, { t: 'visible', visible: false });
  await t.send(cast.max, { t: 'play', card: 'G1' });
  const ping = [...t.tg.messages.entries()].filter(([, m]) => m.chatId === '303' && /Ваш ход/.test(m.text)).at(-1);
  assert.ok(ping, 'Диму толкнули');
  assert.match(ping[1].text, /Цвет зелёный \(квадрат\)/, 'цвет назван вместе с фигурой — цветом одним нельзя');
  assert.equal(ping[1].markup.inline_keyboard[0][0].web_app.url, `https://poker.example/?room=${room.code}`);
  assert.ok(!t.tg.dms(101).some((x) => /Ваш ход/.test(x)), 'у Ивана приложение открыто');

  await t.send(cast.dima, { t: 'play', card: 'B1' });
  assert.equal(t.tg.message(ping[0]).deleted, true, 'сходил — толчок убран');
});

/* -------------------------------------------------------------- таймер */

test('20. таймер хода: истёк — взялась карта, ход перешёл, и другим это видно', async () => {
  const cast = THREE();
  const t = new Table({ colorsRand: colorsRandom(2) });
  t.useColorsDeck(colorsStack(
    { 101: 'R1 R2 R3 R4 R5 R6 R7', 202: 'G1 G2 G3 G4 G5 G6 G7', 303: 'B1 B2 B3 B4 B5 B6 B7' },
    { top: 'G0', deck: 'Y8' },
  ));
  const room = await begin(t, cast, { settings: { turnSeconds: 30 } });
  const s = t.state(cast.max);
  assert.equal(s.deal.deadline, t.clock.now() + 30_000, 'срок едет вместе с состоянием');
  await t.advance(29_000);
  assert.equal(room.deal.turn, '202', 'ещё его ход');
  await t.advance(1_000);
  assert.equal(room.deal.hands['202'].length, 8, 'бот взял за него одну карту');
  assert.ok(room.deal.hands['202'].includes('Y8'));
  assert.equal(room.deal.turn, '303', 'и передал ход');
  assert.match(t.state(cast.ivan).room.notice, /Макс: время вышло — бот взял карту/);
  assert.equal(t.state(cast.ivan).deal.turnSeat, 2, 'другим видно, чей теперь ход');
});

/* ------------------------------------------------------------ ушёл из чата */

test('21. ушёл из группы: втроём партия идёт дальше, вдвоём — прерывается и не считается', async () => {
  const cast = THREE();
  const t = new Table({ colorsDeck: colorsDecks(11) });
  const room = await begin(t, cast);
  await t.raw({
    message: {
      message_id: t.tg.nextId++, date: t.date, chat: { id: t.chatId, type: 'supergroup' },
      from: { id: 303, first_name: 'Дима' }, left_chat_member: { id: 303, first_name: 'Дима' },
    },
  });
  assert.equal(room.deal.phase, 'play', 'втроём партия продолжается без него');
  assert.ok(room.deal.quit.includes('303'));
  assert.deepEqual(room.deal.hands['303'], [], 'его карты ушли в сброс');
  const seen = t.state(cast.ivan);
  assert.equal(seen.players.find((p) => p.name === 'Дима').role, 'quit');

  // А вдвоём доигрывать не из чего.
  const t2 = new Table({ chatId: -1002, colorsDeck: colorsDecks(12) });
  const two = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };
  const room2 = await begin(t2, two);
  await t2.raw({
    message: {
      message_id: t2.tg.nextId++, date: t2.date, chat: { id: t2.chatId, type: 'supergroup' },
      from: { id: 202, first_name: 'Макс' }, left_chat_member: { id: 202, first_name: 'Макс' },
    },
  });
  assert.equal(room2.deal.phase, 'over');
  assert.equal(room2.deal.aborted, true);
  assert.equal(room2.history.at(-1).aborted, true, 'партия не засчитывается');
});

/* -------------------------------------------------------------- рейтинг */

test('22. рейтинг: доигранная партия даёт очки по местам, прерванная — ничего', async () => {
  const store = new Store(':memory:');
  const cast = THREE();
  const t = new Table({ store, colorsDeck: colorsDecks(21), colorsRand: colorsRandom(21) });
  const room = await begin(t, cast);
  await playOut(t, cast);

  const rows = store.ratingOf('colors', { limit: 20 }) ?? [];
  const places = room.history.at(-1).out;
  assert.equal(places.length, 3, 'три места');
  const got = Object.fromEntries((rows.length ? rows : []).map((r) => [String(r.userId ?? r.user_id), r.points ?? r.delta]));
  // Очки — за место: первому PLACE[0], последнему LAST.
  const first = places[0];
  const last = places.at(-1);
  assert.equal(room.rated[`${room.code}#1`].ok, true, 'партия засчитана');
  const applied = room.rated[`${room.code}#1`].rows;
  assert.equal(applied.find((r) => r.userId === first).delta, PLACE[0]);
  assert.equal(applied.find((r) => r.userId === last).delta, LAST);
  assert.equal(applied.find((r) => r.userId === last).fool, true, 'последний помечен последним');
  void got;

  // Прерванная — отказ со словами, а не тихое молчание.
  await t.send(cast.max, { t: 'next' });
  await t.send(cast.ivan, { t: 'abort' });
  assert.equal(room.rated[`${room.code}#2`].skipped, 'ABORTED');
  assert.match(room.rated[`${room.code}#2`].why, /не доиграна/);
  store.close();
});

/* ------------------------------------------------- заброшенный стол */

test('23. заброшенный стол «UNOQ» закрывается сам — как у остальных игр', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  await t.start(ivan);
  await t.cmd(ivan, '/play');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'colors', settings: {} });
  const code = t.colors.code;

  await t.clock.advance(IDLE_CLOSE_MS - IDLE_WARN_MS + 1000);
  const said = () => t.tg.calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(t.chatId)).map((c) => c.text);
  assert.ok(said().some((x) => /через минуту он закроется/.test(x)), 'предупредили');
  await t.clock.advance(IDLE_WARN_MS);
  assert.equal(t.app.roomByCode(code), null, 'стол закрыт');
  t.app.stop();
});

test('23а. начатую «UNOQ» таймер заброшенного стола не трогает', async () => {
  const cast = THREE();
  const t = new Table({ colorsDeck: colorsDecks(13) });
  const room = await begin(t, cast);
  assert.equal(room.status, 'playing');
  await t.clock.advance(IDLE_CLOSE_MS * 3);
  assert.ok(t.app.roomByCode(room.code), 'идёт игра — стол на месте');
  t.app.stop();
});

/* ------------------------------------------------------------ перезапуск */

test('24. перезапуск посреди партии: руки, колода и чей ход — на месте, страницы играют дальше', async () => {
  const store = new Store(':memory:');
  const cast = THREE();
  const t = new Table({ store, colorsDeck: colorsDecks(14) });
  const room = await begin(t, cast);
  const u = who(cast, room.deal.turn);
  const L = t.state(u).legal;
  if (L.play.length) await t.send(u, { t: 'play', card: L.play[0], color: 'R' });
  const snapshot = JSON.stringify({ hands: room.deal.hands, deck: room.deal.deck, top: room.deal.top, turn: room.deal.turn });

  const clock = new FakeClock();
  const app2 = new App({ api: t.tg, store, minIntervalMs: 0, botUsername: 'ChipTableBot', clock, runoutStepMs: 0, miniAppName: 'table' });
  const hub2 = new Hub(app2, { botToken: TEST_TOKEN });
  app2.attachHub(hub2);
  assert.equal(app2.load(), 1);
  await app2.resume();
  const room2 = app2.roomByCode(room.code);
  assert.equal(room2.game, 'colors');
  assert.equal(JSON.stringify({ hands: room2.deal.hands, deck: room2.deal.deck, top: room2.deal.top, turn: room2.deal.turn }), snapshot);
  assert.equal(room2.ui.tableMessageId, room.ui.tableMessageId, 'та же карточка, правкой');

  const mover = who(cast, room2.deal.turn);
  const inbox = [];
  const s = hub2.open({ initData: initDataFor(mover, { startParam: room2.code, clock }) }, (m) => inbox.push(m)).session;
  const state = [...inbox].reverse().find((m) => m.t === 'state').state;
  const card = state.legal.play[0];
  await hub2.handle(s, card ? { t: 'play', card, color: 'R' } : { t: 'draw' });
  assert.notEqual(room2.deal.turn, mover.id + '', 'переподключившаяся страница ходит');
  store.close();
});

/* ------------------------------------------------------------------ хаб */

test('25. «UNOQ» есть в хабе, лобби создаётся, и в группе появляется своя карточка', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/play');
  t.openHub(ivan);
  const games = t.state(ivan).games;
  assert.ok(games.some((g) => g.id === 'colors' && g.title === 'UNOQ' && g.min === 2 && g.max === 8), 'игра на витрине');

  const before = groupPosts(t).length;
  await t.send(ivan, { t: 'create', game: 'colors', settings: { stacking: false, turnSeconds: 60 } });
  const room = t.colors;
  assert.ok(room, 'стол создан');
  assert.equal(room.hostId, '101');
  assert.deepEqual(room.settings, { stacking: false, turnSeconds: 60 });
  assert.equal(groupPosts(t).length, before + 1, 'в группе ровно одна новая карточка');
  assert.match(groupPosts(t).at(-1).text, /🎨 <b>UNOQ<\/b>/);
  assert.equal(t.state(ivan).game, 'colors', 'и страница шагнула внутрь');
});
