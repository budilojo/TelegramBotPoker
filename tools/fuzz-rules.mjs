/**
 * Фаззер правил: сотни партий случайными ЗАКОННЫМИ ходами, и после каждого
 * хода — проверка инвариантов.
 *
 *   node tools/fuzz-rules.mjs            покер и дурак по 500 партий
 *   node tools/fuzz-rules.mjs durak 2000 только дурак, 2000 партий
 *
 * Зачем он нужен рядом с обычными тестами: тест проверяет сценарий, который
 * придумал человек, а фаззер — те, которых человек не придумал. Карты
 * теряются и фишки не сходятся не в прямом сценарии, а в стечении, до
 * которого руками не доберёшься.
 *
 * Ход выбирается ТОЛЬКО из того, что игра сама назвала законным: фаззер не
 * ломится в запрещённое, он проверяет, что разрешённое не ломает стол.
 *
 * ГСЧ засеян: партия, на которой он упал, воспроизводится по номеру семени,
 * иначе находка бесполезна.
 */
import assert from 'node:assert/strict';
import * as P from '../bot/room.js';
import { legalActions } from '../server/game.js';
import * as D from '../bot/games/durak/rules.js';
import { shuffled36 } from '../bot/games/durak/cards.js';
import { seededRng, shuffled } from '../bot/deck.js';

const NAMES = ['Иван', 'Макс', 'Дима', 'Саша', 'Лев', 'Ёж', 'Марина', 'Пётр'];
const pick = (rnd, arr) => arr[rnd(arr.length)];

/* ------------------------------------------------------------------ покер */

/**
 * Фишки не создаются и не исчезают: сколько село за стол, столько и осталось,
 * где бы они сейчас ни лежали — в стеках, в банке или в текущих ставках.
 */
function pokerChips(room) {
  const h = room.hand;
  const inPlay = room.players.reduce((s, p) => s + p.stack, 0);
  if (!h || h.phase === 'complete') return inPlay;
  const pot = (h.pot || 0) + room.players.reduce((s, p) => s + (p.committed || 0), 0);
  return inPlay + pot;
}

function pokerInvariants(room, want, tag) {
  assert.equal(pokerChips(room), want, `${tag}: фишки не сошлись`);
  const h = room.hand;
  if (!h) return;
  const seen = [];
  for (const cards of Object.values(h.holes || {})) {
    assert.equal(cards.length, 2, `${tag}: у игрока не две карты`);
    seen.push(...cards);
  }
  seen.push(...(h.board || []));
  assert.ok((h.board || []).length <= 5, `${tag}: на борде больше пяти карт`);
  assert.equal(new Set(seen).size, seen.length, `${tag}: карта в двух местах сразу`);
  for (const p of room.players) {
    assert.ok(p.stack >= 0, `${tag}: отрицательный стек у ${p.name}`);
    // `allIn` живёт внутри раздачи: после `complete` банк уже разошёлся, а
    // флаги ждут следующей сдачи — это не поломка, а порядок вещей.
    if (h.phase === 'betting' && p.allIn) assert.equal(p.stack, 0, `${tag}: олл-ин с фишками в стеке`);
  }
}

function fuzzPoker(games, seed0) {
  let hands = 0;
  let moves = 0;
  for (let g = 0; g < games; g++) {
    const seed = seed0 + g;
    const rnd = seededRng(seed);
    const n = 2 + rnd(7);
    const tag = `покер seed=${seed} n=${n}`;
    const room = P.createRoom({ chatId: `-${seed}`, host: { id: 101, name: NAMES[0] }, startingStack: 1000, smallBlind: 10, bigBlind: 20 });
    for (let i = 1; i < n; i++) P.addPlayer(room, { id: 101 + i, name: NAMES[i] });
    const want = pokerChips(room);
    const deck = () => shuffled(rnd);
    let r = P.startGame(room, '101', { deck });
    assert.ok(!r.error, `${tag}: не началась — ${r.error}`);

    for (let hand = 0; hand < 12 && room.status === 'playing'; hand++) {
      let guard = 0;
      while (room.hand && room.hand.phase === 'betting' && guard++ < 400) {
        const id = room.hand.actorId;
        const l = legalActions(room, id);
        if (!l) break;
        const choices = [];
        if (l.canCheck) choices.push(['check']);
        if (l.canCall) choices.push(['call']);
        if (l.canFold) choices.push(['fold']);
        // Ставка и повышение — разные действия: `bet`, когда на улице ещё
        // никто не ставил, `raise` — когда ставка уже есть.
        if (l.canBet || l.canRaise) {
          choices.push(['allin']);
          const lo = l.minTotal ?? 0;
          const hi = l.maxTotal ?? lo;
          if (hi > lo) choices.push([l.canRaise ? 'raise' : 'bet', lo + rnd(hi - lo + 1)]);
        }
        assert.ok(choices.length, `${tag}: у игрока нет ни одного законного хода — тупик`);
        const [action, amount] = pick(rnd, choices);
        const res = P.act(room, id, action, amount);
        assert.ok(!res.error, `${tag}: законный ход ${action} отказан — ${res.error}`);
        moves += 1;
        pokerInvariants(room, want, `${tag} ход ${moves}`);
      }
      assert.ok(guard < 400, `${tag}: раздача не кончается`);
      hands += 1;
      pokerInvariants(room, want, `${tag} конец раздачи`);
      if (room.status !== 'playing') break;
      const nx = P.nextHand(room, '101', { deck });
      if (nx.error) break;
      // Новая сдача обязана начинаться с чистых флагов: заигравшийся `allIn`
      // или `folded` выкинул бы человека из раздачи, за которую он заплатил.
      //
      // Только если до торговли дошло: раздача, где все ушли в олл-ин одними
      // блайндами, доигрывается внутри самой сдачи, и после неё флаги стоят
      // по делу.
      for (const p of room.players) {
        if (!p.inHand || room.hand?.phase !== 'betting') continue;
        assert.equal(p.allIn && p.stack > 0, false, `${tag}: в новой раздаче олл-ин с фишками — флаг не сбросили`);
        assert.equal(p.folded, false, `${tag}: в новой раздаче ${p.name} уже сброшен — флаг не сбросили`);
      }
    }
  }
  return { games, hands, moves };
}

/* ------------------------------------------------------------------ дурак */

function durakCards(d) {
  return [
    ...Object.values(d.hands).flat(),
    ...d.talon,
    ...d.discard,
    ...d.table.flatMap((x) => (x.d ? [x.a, x.d] : [x.a])),
  ];
}

function durakInvariants(room, tag) {
  const d = room.deal;
  if (!d) return;
  const all = durakCards(d);
  assert.equal(all.length, 36, `${tag}: карт ${all.length}, а должно быть 36`);
  assert.equal(new Set(all).size, 36, `${tag}: карта встречается дважды`);
  assert.equal(new Set(d.out).size, d.out.length, `${tag}: место в порядке выхода повторяется`);
  if (d.phase !== 'play') return;
  assert.notEqual(d.attacker, d.defender, `${tag}: ходит сам на себя`);
  assert.ok(!d.out.includes(d.attacker), `${tag}: ходит уже вышедший`);
  assert.ok(!d.out.includes(d.defender), `${tag}: отбивается уже вышедший`);
  assert.ok(d.table.length <= 6, `${tag}: на столе больше шести карт`);
}

function fuzzDurak(games, seed0) {
  let deals = 0;
  let moves = 0;
  for (let g = 0; g < games; g++) {
    const seed = seed0 + g;
    const rnd = seededRng(seed);
    const n = 2 + rnd(5);
    const variant = rnd(2) ? 'perevodnoy' : 'podkidnoy';
    const tag = `дурак seed=${seed} n=${n} ${variant}`;
    const room = D.createRoom({ chatId: `-${seed}`, host: { id: 101, name: NAMES[0] }, variant });
    for (let i = 1; i < n; i++) D.addPlayer(room, { id: 101 + i, name: NAMES[i] });
    const deck = () => shuffled36(rnd);
    const r = D.startGame(room, '101', { deck, randInt: rnd });
    assert.ok(!r.error, `${tag}: не началась — ${r.error}`);
    durakInvariants(room, `${tag} сдача`);

    for (let game = 0; game < 8 && room.status === 'playing'; game++) {
      let guard = 0;
      while (room.deal.phase === 'play' && guard++ < 1500) {
        const d = room.deal;
        // Кого стол ждёт прямо сейчас — по его же правилам.
        const waiting = !d.table.length ? [d.attacker]
          : !D.allCovered(d) && !d.bout.taking ? [d.defender]
            : D.waitingThrowers(d);
        assert.ok(waiting.length, `${tag}: стол не ждёт никого, а партия идёт — тупик`);
        const who = pick(rnd, waiting);
        const L = D.legalFor(room, who);
        const choices = [];
        for (const c of L.attack) choices.push(['attack', c]);
        for (const [c, targets] of Object.entries(L.defend)) for (const t of targets) choices.push(['defend', c, t]);
        for (const c of L.transfer) choices.push(['transfer', c]);
        if (L.take) choices.push(['take']);
        if (L.pass) choices.push(['pass']);
        assert.ok(choices.length, `${tag}: у ${who} нет ни одного законного хода — тупик`);
        const [kind, card, target] = pick(rnd, choices);
        const res = kind === 'attack' ? D.attack(room, who, card)
          : kind === 'defend' ? D.defend(room, who, card, target)
            : kind === 'transfer' ? D.transfer(room, who, card)
              : kind === 'take' ? D.take(room, who)
                : D.pass(room, who);
        assert.ok(!res.error, `${tag}: законный ход ${kind} отказан — ${res.error}`);
        moves += 1;
        durakInvariants(room, `${tag} ход ${moves}`);
      }
      assert.ok(guard < 1500, `${tag}: партия не кончается`);
      deals += 1;
      durakInvariants(room, `${tag} конец партии`);
      const nx = D.nextGame(room, '101', { deck, randInt: rnd });
      if (nx.error) break;
    }
  }
  return { games, deals, moves };
}

/* ------------------------------------------------------------------ запуск */

const what = process.argv[2] || 'all';
const games = Number(process.argv[3]) || 500;
const t0 = Date.now();
if (what === 'all' || what === 'poker') {
  const r = fuzzPoker(games, 1000);
  console.log(`покер: ${r.games} столов, ${r.hands} раздач, ${r.moves} ходов — инварианты держатся`);
}
if (what === 'all' || what === 'durak') {
  const r = fuzzDurak(games, 5000);
  console.log(`дурак: ${r.games} столов, ${r.deals} партий, ${r.moves} ходов — инварианты держатся`);
}
console.log(`за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
