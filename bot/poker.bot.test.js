'use strict';
/**
 * Покер против ботов.
 *
 *   ЧЕСТНО. Бот решает по своему `view` — тому, что сервер показал бы человеку
 *   на его месте. Тесты ловят каждый вид, который бот получил за партию: в нём
 *   его собственные карты и ни одной чужой.
 *
 *   ВЫБОР. 18 характеров × 4 уровня, от 1 до 7 соперников; невыбранные
 *   характеры — случайные и разные.
 *
 *   ГРАНИЦЫ. Человек не ходит за бота; за столом с ботами нет ни настроек, ни
 *   докупок, ни удалений. Фишки кончились у человека — партия окончена.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, botRandom } from './harness.js';
import { seededRng } from './deck.js';
import { GAMES } from './games/index.js';
import pokerBot, { TYPES, LEVELS, equity, decidePoker, strength } from './games/poker/bot.js';
import { best5, compare } from './eval.js';
import { cardCode } from './view.js';

const IVAN = user(101, 'Иван');
const g = GAMES.poker;

const card = (code) => {
  for (let c = 0; c < 52; c++) if (cardCode(c) === code) return c;
  throw new Error(code);
};

async function pokerVsBots(t, settings) {
  await t.start(IVAN);
  t.openSolo(IVAN);
  await t.send(IVAN, { t: 'play', game: 'poker', settings });
  return t.app.soloOf('101');
}

/**
 * Играть, пока не кончится партия или шаги: человек ходит по `strategy`,
 * между раздачами жмёт «Следующая раздача», боты ходят сами по часам.
 */
async function play(t, room, strategy, steps = 400) {
  for (let i = 0; i < steps && room.status !== 'finished'; i++) {
    const s = t.state(IVAN);
    if (s.legal) await t.send(IVAN, { t: 'act', ...strategy(s.legal), seq: s.seq });
    else if (s.hand?.phase === 'complete' && s.canNext) await t.send(IVAN, { t: 'next' });
    else await t.advance(2_500);
  }
}

/** Осторожный человек: бесплатно — чек, дёшево — уравнять, дорого — сбросить. */
const careful = (l) => ({ action: l.canCheck ? 'check' : l.toCall <= 200 ? 'call' : 'fold' });
const shoving = () => ({ action: 'allin' });

/** Подменить решение ботов, чтобы видеть каждый вид, который они получили. */
function spyOnBots() {
  const seen = [];
  const original = g.bot.decide;
  g.bot.decide = (args) => {
    seen.push({ id: args.me.id, view: structuredClone(args.view), holes: structuredClone(args.room.hand?.holes || {}) });
    return original(args);
  };
  return { seen, restore: () => { g.bot.decide = original; } };
}

test('выбор: больше 15 характеров, 4 уровня, у каждого описание', () => {
  const cat = pokerBot.catalog();
  assert.ok(cat.types.length > 15, `характеров ${cat.types.length}`);
  assert.equal(new Set(cat.types.map((x) => x.id)).size, cat.types.length, 'id не повторяются');
  assert.equal(new Set(cat.types.map((x) => x.name)).size, cat.types.length, 'имена не повторяются');
  for (const x of cat.types) assert.ok(x.blurb.length > 10, `описание у «${x.name}»`);
  assert.deepEqual(cat.levels, LEVELS.map((l) => l.name));
  assert.equal(cat.levels.length, 4);
  assert.equal(cat.levelHints.length, 4);
  for (const x of TYPES) assert.ok(x.short.length <= 9, `«${x.short}» влезает под аватар`);
  assert.equal(new Set(TYPES.map((x) => x.short)).size, TYPES.length, 'за столом характеры не путаются');
});

test('состав: от 1 до 7 соперников, выбранные характеры — как выбраны, остальные — разные', () => {
  const rng = botRandom(7);
  assert.equal(pokerBot.lineup({ opponents: 0 }, rng).length, 1);
  assert.equal(pokerBot.lineup({ opponents: 99 }, rng).length, 7);
  assert.equal(pokerBot.lineup({ opponents: 'много' }, rng).length, 3, 'чепуха — по умолчанию');
  const seven = pokerBot.lineup({ opponents: 7, level: 2 }, rng);
  assert.equal(new Set(seven.map((x) => x.type)).size, 7, 'семь разных характеров');
  assert.ok(seven.every((x) => x.level === 2));
  const mine = pokerBot.lineup({ opponents: 3, level: 9, types: ['shark', 'нет-такого', 'shark'] }, rng);
  assert.equal(mine[0].type, 'shark');
  assert.notEqual(mine[1].type, 'нет-такого', 'неизвестный характер заменён');
  assert.ok(TYPES.some((x) => x.id === mine[1].type));
  assert.equal(mine[2].type, 'shark', 'два одинаковых — если человек так выбрал');
  assert.equal(mine[0].level, 3, 'уровень зажат в 0…3');
});

test('два одинаковых характера за столом различаются номером', async () => {
  const t = new Table({ botRng: botRandom(3) });
  const room = await pokerVsBots(t, { opponents: 3, level: 1, types: ['shark', 'shark', 'rock'] });
  assert.deepEqual(room.players.filter((p) => p.bot).map((p) => p.name), ['Акула', 'Акула 2', 'Камень']);
});

test('сила руки: тузы сильнее семёрки-двойки, флеш-рояль не проигрывает', () => {
  const rng = botRandom(1);
  const aces = equity([card('AS'), card('AH')], [], 1, 3000, rng);
  const trash = equity([card('7S'), card('2H')], [], 1, 3000, rng);
  assert.ok(aces > 0.8 && aces < 0.9, `AA против одного ≈ 85%, вышло ${aces}`);
  assert.ok(trash > 0.28 && trash < 0.4, `72 против одного ≈ 35%, вышло ${trash}`);
  const royal = equity([card('AS'), card('KS')], ['QS', 'JS', '10S'].map(card), 3, 500, rng);
  assert.equal(royal, 1);
});

test('быстрая оценка руки — тот же порядок, что у best5, на 30.000 парах раздач', () => {
  const rnd = botRandom(77);
  const draw = (n) => {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(rnd() * (52 - i));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck.slice(0, n);
  };
  for (let k = 0; k < 30_000; k++) {
    const n = 5 + (k % 3); // 5, 6 и 7 карт
    const a = draw(n);
    const b = draw(n);
    const slow = Math.sign(compare(best5(a).score, best5(b).score));
    const fast = Math.sign(strength(a) - strength(b));
    assert.equal(fast, slow, `${a} против ${b}`);
  }
  // Редкие руки — отдельно: колесо, стрит-флеш, два сета, три пары.
  const c = (s) => s.split(' ').map(card);
  assert.ok(strength(c('AS 2S 3S 4S 5S 9H 9D')) > strength(c('KH KD KS KC 2D 3C 4H')), 'стрит-флеш до пятёрки сильнее каре');
  assert.ok(strength(c('AH 2D 3C 4S 5H KD QD')) < strength(c('2H 3D 4C 5S 6H KD QD')), 'колесо — младший стрит');
  assert.equal(Math.sign(strength(c('9H 9D 9S 5C 5H 5D 2C')) - strength(c('9H 9D 9S 5C 5H 2D 2C'))), 0, 'два сета = фулл-хаус девятки на пятёрках');
  assert.ok(strength(c('9H 9D 5S 5C 3H 3D AC')) > strength(c('9H 9D 5S 5C 3H 3D KC')), 'три пары: кикер — туз');
  assert.ok(strength(c('9H 9D 5S 5C 4H 4D 2C')) > strength(c('9H 9D 5S 5C 3H 3D 2C')), 'три пары: кикер — карта третьей пары');
});

test('решение: со слабой рукой против большой ставки профи сбрасывает, с натсом — не сбрасывает', () => {
  const view = (cards, board) => ({
    seq: 5,
    room: { settings: { startingStack: 10000, smallBlind: 50, bigBlind: 100 } },
    me: { cards },
    hand: { board },
    players: [{ isMe: true, inHand: true }, { isMe: false, inHand: true, folded: false }],
    legal: { toCall: 3000, callAmount: 3000, canCheck: false, canCall: true, canBet: false, canRaise: true, minTotal: 6000, maxTotal: 9000, potTotal: 3500, stack: 9000, currentBet: 3000, myBet: 0 },
  });
  for (let seed = 1; seed <= 20; seed++) {
    const weak = decidePoker(view(['7S', '2H'], ['KD', 'QC', '9H']), { type: 'math', level: 3 }, botRandom(seed));
    assert.equal(weak.action, 'fold', `слабая рука, seed ${seed}`);
    const nuts = decidePoker(view(['AS', 'KS'], ['QS', 'JS', '10S']), { type: 'math', level: 3 }, botRandom(seed));
    assert.notEqual(nuts.action, 'fold', `флеш-рояль, seed ${seed}`);
    assert.equal(nuts.seq, 5, 'ход привязан к виду стола');
  }
});

test('страх: чужой олл-ин до флопа не уравнивают рукой «посредственнее среднего» — ни один характер, любой уровень', () => {
  // Стек 100 блайндов, сопернику (пока он один) ставят весь стек: уравнивать — отдать всё.
  const view = (cards) => ({
    seq: 3,
    room: { settings: { startingStack: 10000, smallBlind: 50, bigBlind: 100 } },
    me: { cards },
    hand: { board: [] },
    players: [{ isMe: true, inHand: true }, { isMe: false, inHand: true, folded: false }, { isMe: false, inHand: true, folded: false }, { isMe: false, inHand: true, folded: false }],
    legal: { toCall: 9900, callAmount: 9900, canCheck: false, canCall: true, canBet: false, canRaise: false, minTotal: 10000, maxTotal: 10000, potTotal: 10200, stack: 9900, currentBet: 10000, myBet: 100 },
  });
  const mediocre = [['9S', '4H'], ['KD', '3C'], ['JC', '7D'], ['10H', '5S'], ['QS', '2D']];
  for (const type of TYPES) {
    if (['station', 'fish', 'gambler'].includes(type.id)) continue; // эти уравнивают по своей природе — для них отдельный тест ниже
    for (let level = 1; level <= 3; level++) {
      for (const hole of mediocre) {
        const d = decidePoker(view(hole), { type: type.id, level }, botRandom(level * 31 + hole[0].length));
        assert.equal(d.action, 'fold', `${type.name}, ур. ${level}, ${hole.join(' ')} — должен сбросить`);
      }
    }
  }
  // С тузами уравнивают (страх не должен превратить бота в труса).
  for (const id of ['rock', 'math', 'tag']) {
    const d = decidePoker(view(['AS', 'AH']), { type: id, level: 3 }, botRandom(5));
    assert.notEqual(d.action, 'fold', `${id}: пара тузов против олл-ина не сбрасывается`);
  }
});

test('страх, в живую: человек идёт олл-ин первым — боты почти не уравнивают друг за другом (раньше уравнивали в среднем двое из четырёх)', async () => {
  let multi = 0;
  let big = 0;
  const SEEDS = 16;
  for (let s = 1; s <= SEEDS; s++) {
    const t = new Table({ botRng: botRandom(s * 101) });
    const spy = spyOnBots();
    try {
      const room = await pokerVsBots(t, { opponents: 4, level: 1 });
      const rows = [];
      const wrap = g.bot.decide;
      g.bot.decide = (args) => {
        const out = wrap(args);
        const l = args.view.legal;
        if (!args.view.hand?.board?.length) rows.push(out?.action === 'allin' || (out?.action === 'call' && l.toCall >= 0.5 * (l.stack + l.myBet)));
        return out;
      };
      for (let i = 0; i < 60 && room.hand?.phase !== 'complete'; i++) {
        const st = t.state(IVAN);
        if (st.legal) await t.send(IVAN, { t: 'act', action: 'allin', seq: st.seq });
        else await t.advance(2500);
      }
      g.bot.decide = wrap;
      const n = rows.filter(Boolean).length;
      big += n;
      if (n >= 2) multi++;
    } finally {
      spy.restore();
      t.app.stop();
    }
  }
  assert.ok(big / SEEDS < 1, `ботов, уравнявших олл-ин или пошедших ва-банк, на раздачу: ${(big / SEEDS).toFixed(2)} (раньше было ≈2)`);
  assert.ok(multi / SEEDS < 0.25, `раздач, где пошли сразу двое и больше: ${multi} из ${SEEDS} (раньше ≈ 78%)`);
});

test('покер с ботами: партия идёт сама, боты ходят по своему виду и не видят чужих карт', async () => {
  const t = new Table({ botRng: botRandom(11) });
  const spy = spyOnBots();
  try {
    const room = await pokerVsBots(t, { opponents: 3, level: 1 });
    assert.ok(room.solo);
    assert.equal(room.game, 'poker');
    assert.equal(room.players.length, 4);
    assert.equal(room.players.filter((p) => p.bot).length, 3);
    assert.equal(room.status, 'playing', 'раздача сразу');
    for (const p of room.players.filter((x) => x.bot)) {
      assert.equal(p.name, TYPES.find((x) => x.id === p.bot.type).short, 'за столом бот зовётся своим характером');
    }
    assert.equal(new Set(room.players.map((p) => p.name)).size, 4, 'имена разные');

    await play(t, room, careful, 300);
    assert.ok(room.handNo >= 5, `сыграно раздач: ${room.handNo}`);
    assert.ok(spy.seen.length > 20, `ботам пришлось решать: ${spy.seen.length}`);
    for (const { id, view, holes } of spy.seen) {
      assert.ok(view.legal, 'бот решает только в свой ход');
      assert.deepEqual(view.me.cards, holes[id].map(cardCode), 'в виде — карты самого бота');
      for (const p of view.players.filter((x) => !x.isMe)) assert.equal(p.cards, null, `чужие карты скрыты от ${id}`);
      const others = Object.entries(holes).filter(([pid]) => pid !== id).flatMap(([, cs]) => cs.map(cardCode));
      const json = JSON.stringify(view);
      for (const c of others) {
        if (!(view.hand?.board || []).includes(c)) assert.ok(!json.includes(`"${c}"`), `карта ${c} соперника не попала к ${id}`);
      }
    }
    assert.deepEqual(t.errors, [], 'ни один ход бота не отклонён');
    // Человек получил за партию только своё: чужие карты — лишь на вскрытии.
    for (const m of t.page(IVAN).inbox.filter((x) => x.t === 'state' && x.state.hand?.phase === 'betting')) {
      for (const p of m.state.players.filter((x) => !x.isMe)) assert.equal(p.cards, null, 'чужих карт посреди торговли нет');
    }
  } finally {
    spy.restore();
  }
});

test('человек не ходит за бота и не правит стол с ботами', async () => {
  const t = new Table({ botRng: botRandom(4) });
  const room = await pokerVsBots(t, { opponents: 2, level: 0 });
  // Дождаться хода бота: у человека в этот момент законных действий нет.
  for (let i = 0; i < 10 && room.hand.actorId === '101'; i++) {
    await t.send(IVAN, { t: 'act', action: 'call', seq: t.state(IVAN).seq });
  }
  assert.notEqual(room.hand.actorId, '101');
  const before = room.seq;
  await t.send(IVAN, { t: 'act', action: 'fold', seq: room.seq });
  assert.equal(t.lastError(IVAN).code, 'NOT_YOUR_TURN');
  assert.equal(room.seq, before, 'за бота никто не сходил');
  for (const msg of [
    { t: 'settings', bigBlind: 2 }, { t: 'kick', seat: 1 }, { t: 'rebuy', seat: 0 }, { t: 'host', seat: 1 },
    { t: 'leave' }, { t: 'role', seat: 1, role: 'dealer' }, { t: 'sit' },
  ]) {
    await t.send(IVAN, msg);
    assert.equal(t.lastError(IVAN).code, 'SOLO_ONLY', msg.t);
    assert.match(t.lastError(IVAN).text, /с ботами/);
  }
  assert.equal(room.settings.bigBlind, 100);
  assert.equal(room.players.length, 3);
  assert.ok(room.players.every((p) => !p.kicked));
});

test('фишки у человека кончились — партия окончена, без группы и рейтинга; «Сыграть ещё» — те же соперники', async () => {
  const t = new Table({ botRng: botRandom(2) });
  const room = await pokerVsBots(t, { opponents: 4, level: 3, types: ['shark', 'math'] });
  const types = room.players.filter((p) => p.bot).map((p) => p.bot.type);
  assert.deepEqual(types.slice(0, 2), ['shark', 'math']);
  await play(t, room, shoving, 400);
  assert.equal(room.status, 'finished', 'партия закончилась');
  const me = room.players.find((p) => p.id === '101');
  const bots = room.players.filter((p) => p.bot && p.stack > 0);
  assert.ok(me.stack === 0 || bots.length === 0, 'кончились фишки у человека или у всех ботов');
  const chats = [...t.tg.messages.values()].map((m) => m.chatId);
  assert.ok(chats.every((c) => c === '101'), `сообщения только в личку человека, а были: ${chats}`);
  assert.deepEqual(t.app.rate(room), [], 'в рейтинг не идёт');

  const seen = t.page(IVAN).inbox.length;
  await t.send(IVAN, { t: 'again' });
  const got = t.page(IVAN).inbox.slice(seen);
  assert.equal(got.some((m) => m.t === 'gone'), false, 'страница не получает «Игру удалили» на кнопке «Сыграть ещё»');
  assert.equal(got.some((m) => m.t === 'error' || m.t === 'fatal'), false, 'и ошибок тоже');
  assert.equal(got.at(-1)?.t, 'state', 'последнее — состояние нового стола');
  const next = t.app.soloOf('101');
  assert.notEqual(next.code, room.code, 'новый стол');
  assert.equal(next.players.filter((p) => p.bot).length, 4);
  assert.ok(next.players.filter((p) => p.bot).every((p) => p.bot.level === 3));
  assert.deepEqual(next.players.filter((p) => p.bot).slice(0, 2).map((p) => p.bot.type), ['shark', 'math']);
  assert.equal(t.state(IVAN).room.code, next.code, 'человек сразу за новым столом');
  assert.equal(next.status, 'playing');
});

test('человек проиграл всё, пока боты живы — партия кончается сразу, без раздач между ботами', async () => {
  const t = new Table({ botRng: botRandom(9) });
  const room = await pokerVsBots(t, { opponents: 5, level: 3 });
  await play(t, room, shoving, 400);
  const me = room.players.find((p) => p.id === '101');
  assert.equal(me.stack, 0, 'при этом раскладе человек проигрывает всё (если сид поменяют — подберите другой)');
  assert.equal(room.status, 'finished');
  assert.ok(room.players.filter((p) => p.bot && p.stack > 0).length >= 2, 'боты ещё при фишках');
  const hands = room.handNo;
  await t.advance(60_000);
  assert.equal(room.handNo, hands, 'боты без человека не играют');
});
