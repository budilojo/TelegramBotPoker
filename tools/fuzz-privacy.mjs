/**
 * Фаззер приватности методом «невмешательства» (аудит, фаза 2).
 *
 *   node --disable-warning=ExperimentalWarning tools/fuzz-privacy.mjs [игра|all] [партий] [первое_зерно]
 *
 * Партии целиком, через хаб, за столом только боты (каждый ходит по своему
 * виду — как в «играх с ботами»). При КАЖДОЙ перерисовке стола и для КАЖДОГО,
 * кто на него смотрит (игроки и зритель), берётся копия стола, в которой
 * перемешано всё, чего этот человек знать не может: чужие руки, колода,
 * сброс, ещё не открытый борд, чужой флот (кроме уже обстрелянного). Его вид
 * обязан совпасть побайтно. Карточка в группе и строка хаба — то же, для
 * «никого»: им не положено знать ничего скрытого.
 *
 * Различие — утечка, прямая или косвенная (длина, порядок, статус). При
 * падении печатаются игра, зерно, шаг и разница — повтор одной командой.
 */
import assert from 'node:assert/strict';
import { Table, user, seededDecks, durakDecks, colorsDecks, botRandom } from '../bot/harness.js';
import { seededRng, shuffled } from '../bot/deck.js';
import { GAMES } from '../bot/games/index.js';
import { boardShown } from '../bot/cards.js';
import { FLEET, shipCells, halo, placements, checkFleet } from '../bot/games/battleship/board.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

/** Перемешать значения по местам: `slots` — [массив, индекс]. */
function permute(rnd, slots) {
  const vals = slots.map(([a, i]) => a[i]);
  for (let i = vals.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [vals[i], vals[j]] = [vals[j], vals[i]];
  }
  slots.forEach(([a, i], k) => (a[i] = vals[k]));
}

/* --------------------------------------------- что скрыто от человека: по игре */

const PERTURB = {
  /** Покер: чужие карманные, колода, неоткрытый борд; во время вскрытия по улице — итог руки. */
  poker(room, viewer, rnd) {
    const h = room.hand;
    if (!h) return;
    const shownIds = h.phase === 'complete' && h.shown ? new Set(Object.keys(h.shown)) : new Set();
    const slots = [];
    for (const [id, cards] of Object.entries(h.holes || {})) {
      if (id === viewer || shownIds.has(id)) continue;
      cards.forEach((_, i) => slots.push([cards, i]));
    }
    const seen = boardShown(room).length;
    for (let i = seen; i < (h.board || []).length; i++) slots.push([h.board, i]);
    permute(rnd, slots);
    if (h.deck) h.deck = shuffled(rnd);
    const revealing = room.ui?.reveal?.handNo === h.no;
    if (revealing) {
      for (const s of Object.values(h.shown || {})) {
        s.name = `тайна${rnd(1000)}`;
        s.score = rnd(1e6);
        s.best = shuffled(rnd).slice(0, 5);
      }
      const rec = room.history?.find((x) => x.no === h.no);
      if (rec?.board) rec.board = shuffled(rnd).slice(0, 5);
      if (rec?.shown) for (const k of Object.keys(rec.shown)) rec.shown[k] = `тайна${rnd(1000)}`;
    }
    for (const u of room.undo || []) {
      if (u.hand?.deck) u.hand.deck = shuffled(rnd);
      for (const [id, cards] of Object.entries(u.hand?.holes || {})) if (id !== viewer) u.hand.holes[id] = shuffled(rnd).slice(0, cards.length);
    }
  },

  /** Дурак: чужие руки, колода (кроме козыря под ней), сброс. */
  durak(room, viewer, rnd) {
    const d = room.deal;
    if (!d || d.phase !== 'play') return;
    const slots = [];
    for (const id of d.order) if (id !== viewer) d.hands[id].forEach((_, i) => slots.push([d.hands[id], i]));
    for (let i = 0; i < d.talon.length - 1; i++) slots.push([d.talon, i]); // последняя — козырь, она на виду
    d.discard.forEach((_, i) => slots.push([d.discard, i]));
    permute(rnd, slots);
  },

  /** UNOQ: чужие руки, колода, сброс под верхней картой. */
  colors(room, viewer, rnd) {
    const d = room.deal;
    if (!d || d.phase !== 'play') return;
    const drawnAt = d.drawn && d.turn !== viewer ? d.hands[d.turn]?.indexOf(d.drawn) : -1;
    const slots = [];
    for (const id of d.order) if (id !== viewer && d.hands[id]) d.hands[id].forEach((_, i) => slots.push([d.hands[id], i]));
    d.deck.forEach((_, i) => slots.push([d.deck, i]));
    d.discard.forEach((_, i) => slots.push([d.discard, i]));
    permute(rnd, slots);
    if (drawnAt >= 0) d.drawn = d.hands[d.turn][drawnAt];
  },

  /**
   * Морской бой: у соперника (для зрителя — у обоих) переставить корабль, в
   * который ещё не попали, на другое законное место, не задевающее ни одного
   * выстрела. Результаты всех выстрелов не меняются — вид обязан не измениться.
   */
  battleship(room, viewer, rnd) {
    const m = room.match;
    if (!m || m.over || m.phase !== 'battle') return;
    const mine = m.ids.indexOf(viewer);
    for (const s of [0, 1]) {
      if (s === mine || !m.fleets[s]) continue;
      const shots = new Set(m.shots[1 - s].map((x) => x.c));
      const fleet = m.fleets[s];
      const free = fleet.map((ship, i) => i).filter((i) => !shipCells(fleet[i]).some((c) => shots.has(c)));
      if (!free.length) continue;
      const i = free[rnd(free.length)];
      const others = fleet.filter((_, k) => k !== i);
      const busy = new Set([...shots]);
      for (const o of others) for (const c of [...shipCells(o), ...halo(o)]) busy.add(c);
      const spots = placements(fleet[i].len, busy);
      if (!spots.length) continue;
      const spot = spots[rnd(spots.length)];
      const next = [...others.slice(0, i), spot, ...others.slice(i)];
      if (checkFleet(next).error) continue;
      m.fleets[s] = next;
    }
  },
};

/* ------------------------------------------------------------------ прогон */

const SETUPS = {
  poker: { n: [2, 3, 4, 5, 6], settings: () => ({ startingStack: 1000, smallBlind: 50, bigBlind: 100 }) },
  durak: { n: [2, 3, 4, 5, 6], settings: (rnd) => ({ variant: rnd(2) ? 'transfer' : 'simple' }) },
  colors: { n: [2, 3, 4, 5], settings: () => ({}) },
  battleship: { n: [2], settings: () => ({ base: 0 }) },
};

const SPY = user(999, 'Зритель');

function viewersOf(room) {
  return [...room.players.map((p) => p.id), SPY.id === undefined ? '999' : String(SPY.id)];
}

const norm = (v) => JSON.stringify(v);

/** Одна проверка: для каждого смотрящего — вид не зависит от скрытого. */
function checkRoom(game, room, rnd, ctx) {
  const g = GAMES[game];
  const now = ctx.now();
  for (const viewer of viewersOf(room)) {
    const base = norm(g.view(room, viewer, { now, botUsername: 'B' }));
    for (let k = 0; k < ctx.tries; k++) {
      const twin = clone(room);
      PERTURB[game](twin, viewer, rnd);
      const other = norm(g.view(twin, viewer, { now, botUsername: 'B' }));
      if (other !== base) {
        const a = JSON.parse(base);
        const b = JSON.parse(other);
        let diff = '';
        try {
          assert.deepEqual(b, a);
        } catch (e) {
          diff = e.message.split('\n').slice(0, 40).join('\n');
        }
        throw new Error(`${game}: вид ${viewer === '999' ? 'зрителя' : `игрока ${viewer}`} зависит от скрытого (${ctx.where()})\n${diff}`);
      }
    }
  }
  // Личное «ваш ход» — только то, что знает сам получатель.
  for (const w of room.status === 'playing' ? g.waiting(room) : []) {
    const p = room.players.find((x) => x.id === w.id);
    if (!p) continue;
    const ping = norm(g.pingText(room, p, w));
    for (let k = 0; k < ctx.tries; k++) {
      const twin = clone(room);
      PERTURB[game](twin, p.id, rnd);
      if (norm(g.pingText(twin, twin.players.find((x) => x.id === p.id), w)) !== ping) {
        throw new Error(`${game}: «ваш ход» для ${p.id} зависит от скрытого (${ctx.where()})`);
      }
    }
  }
  // Карточка в группе и строка хаба — никому не положено скрытого.
  const card = norm(g.card(room, { link: 'L' }));
  const sum = norm(g.summary(room));
  for (let k = 0; k < ctx.tries; k++) {
    const twin = clone(room);
    PERTURB[game](twin, '__nobody__', rnd);
    if (norm(g.card(twin, { link: 'L' })) !== card) throw new Error(`${game}: карточка в группе зависит от скрытого (${ctx.where()})`);
    if (norm(g.summary(twin)) !== sum) throw new Error(`${game}: строка хаба зависит от скрытого (${ctx.where()})`);
    if (room.status === 'finished' && norm(g.results(twin)) !== norm(g.results(room))) {
      throw new Error(`${game}: итоги в группе зависят от скрытого (${ctx.where()})`);
    }
  }
}

/** Морской бой ботов не имеет: случайная расстановка и случайные выстрелы по своему виду. */
async function battleshipDriver(t, room, rnd, cast) {
  const m = () => room.match;
  for (const u of cast) await t.send(u, { t: 'random' });
  for (const u of cast) await t.send(u, { t: 'ready' });
  for (let guard = 0; guard < 400 && m() && !m().over; guard++) {
    const who = cast.find((u) => m().ids[m().turn] === String(u.id));
    if (!who) break;
    const st = t.state(who);
    const enemy = st.match.boards[1 - st.match.mySide];
    const known = new Set([...enemy.shots.map((x) => x.c), ...enemy.around]);
    const free = [];
    for (let c = 0; c < 100; c++) if (!known.has(c)) free.push(c);
    await t.send(who, { t: 'fire', cell: free[rnd(free.length)], shot: st.match.shots });
  }
}

export async function runGame(game, seed, { tries = 2, maxSteps = 4000, log = () => {} } = {}) {
  const rnd = seededRng(seed);
  const setup = SETUPS[game];
  const n = setup.n[rnd(setup.n.length)];
  const t = new Table({
    runoutStepMs: 1500, // олл-ин открывается по улице — самое тонкое место покера
    deck: seededDecks(seed), durakDeck: durakDecks(seed), colorsDeck: colorsDecks(seed), botRng: botRandom(seed),
    battleshipRand: () => rnd(1000) / 1000, battleshipFleetRand: () => rnd(1_000_000) / 1_000_000,
  });
  const cast = Array.from({ length: n }, (_, i) => user(101 + i, `Игрок${i + 1}`));
  await t.cmd(cast[0], '/game');
  t.openHub(cast[0]);
  await t.send(cast[0], { t: 'create', game, settings: setup.settings(rnd) });
  const room = [...t.app.rooms.values()].find((r) => r.game === game);
  t.close(cast[0]);
  for (const u of cast) t.openRoom(u, room);
  for (const u of cast.slice(1)) await t.send(u, { t: 'sit' });
  t.openRoom(SPY, room);

  let step = 0;
  const ctx = { tries, now: () => t.clock.now(), where: () => `зерно ${seed}, игроков ${n}, шаг ${step}` };
  const broadcast = t.hub.broadcast.bind(t.hub);
  let failure = null;
  t.hub.broadcast = (r) => {
    if (r === room && !failure) {
      step += 1;
      try {
        checkRoom(game, room, rnd, ctx);
      } catch (e) {
        failure = e;
      }
    }
    return broadcast(r);
  };

  await t.send(cast[0], { t: 'start' });
  if (game === 'battleship') {
    await battleshipDriver(t, room, rnd, cast);
  } else {
    // Все места — боты: ходят сами, по своему виду, через тот же handle.
    const specs = GAMES[game].bot.lineup({ opponents: 1, level: 3 }, () => 0.5);
    for (const p of room.players) p.bot = { ...specs[0] };
    t.app.syncClocks();
    let hands = 0;
    for (; step < maxSteps && room.status !== 'finished' && !failure; ) {
      const before = step;
      await t.advance(2500);
      if (game === 'poker' && room.status === 'playing' && room.hand?.phase === 'complete') {
        hands += 1;
        if (hands > 25) {
          await t.send(cast[0], { t: 'finish' });
          break;
        }
        await t.send(cast[0], { t: 'next' });
      }
      if ((game === 'durak' || game === 'colors') && room.deal?.phase === 'over') {
        await t.send(cast[0], { t: 'finish' });
        break;
      }
      if (step === before && room.status !== 'finished') {
        // Никто не ходит — стол встал: это тоже находка, но не приватности.
        log(`${game} зерно ${seed}: стол встал (статус ${room.status}, шаг ${step})`);
        break;
      }
    }
  }
  t.app.stop();
  if (failure) throw failure;
  if (t.errors.length) throw new Error(`${game} зерно ${seed}: ошибки в логе: ${t.errors.map(String).slice(0, 3).join('; ')}`);
  return { steps: step, players: n, status: room.status };
}

/* --------------------------------------------------------------- из консоли */

if (import.meta.url === `file://${process.argv[1]}`) {
  const [which = 'all', count = '20', first = '1'] = process.argv.slice(2);
  const games = which === 'all' ? Object.keys(PERTURB) : [which];
  const total = {};
  const started = Date.now();
  let failed = 0;
  for (const game of games) {
    total[game] = { games: 0, checks: 0 };
    for (let s = Number(first); s < Number(first) + Number(count); s++) {
      try {
        const r = await runGame(game, s, { log: (x) => console.log('  ·', x) });
        total[game].games += 1;
        total[game].checks += r.steps;
      } catch (e) {
        failed += 1;
        console.log(`✖ ${e.message}`);
        if (failed > 5) process.exit(1);
      }
    }
    console.log(`${game}: партий ${total[game].games}, перерисовок проверено ${total[game].checks}`);
  }
  console.log(`итого за ${Math.round((Date.now() - started) / 1000)} с: ${JSON.stringify(total)}${failed ? `, падений ${failed}` : ''}`);
  process.exit(failed ? 1 : 0);
}
