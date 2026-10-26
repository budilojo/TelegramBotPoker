#!/usr/bin/env node
/**
 * Симуляция рейтинга (волна 4, агент G). Чистый Node, без зависимостей, фиксированный seed.
 * Код продукта не меняет. Текущие защиты от накрутки прогоняются через НАСТОЯЩИЙ bot/rating.js
 * (на NullStore из bot/store.js) — это «как сейчас». Предложенная система («Лига») написана здесь же,
 * в разделе LEAGUE, — это модель предложения, а не код продукта.
 *
 * Запуск:   node tools/sim-rating.mjs            (всё, ~10 с)
 *           node tools/sim-rating.mjs --seed 7   (другой seed; по умолчанию 20261026)
 *           node tools/sim-rating.mjs --part quality|attacks|bank
 * Один и тот же seed → один и тот же вывод слово в слово.
 */
import { apply as rateRound, PER_DAY } from '../bot/rating.js';
import { NullStore } from '../bot/store.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SEED = Number(arg('--seed', 20261026));
const PART = arg('--part', 'all');

/* ------------------------------------------------------------------ случайность */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.normal = () => { let u = 0; while (!u) u = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next()); };
  next.int = (n) => Math.floor(next() * n);
  return next;
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
const int = (x) => Math.round(x).toLocaleString('ru-RU');

function ranks(xs) { // средние ранги (для Спирмена с повторами)
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}
function pearson(a, b) {
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}
const spearman = (a, b) => pearson(ranks(a), ranks(b));
const pct = (xs) => { const r = ranks(xs); return r.map((x) => (100 * x) / (xs.length - 1)); }; // 0..100

/* ------------------------------------------------------------------ игры */
/**
 * n — сколько человек в обычной партии; noise — «шум» исхода при силе игроков со стандартным
 * отклонением 1 (чем больше шум, тем больше удачи); luck — доля удачи = noise² / (1 + noise²);
 * draw — порог ничьей для дуэлей; cat — категория для варианта B.
 * Это допущения модели, а не измерения реальных партий (замеров на живых людях нет).
 */
const GAMES = {
  chess:      { n: 2, noise: 0.35, draw: 0.25, cat: 'ум' },
  checkers:   { n: 2, noise: 0.40, draw: 0.20, cat: 'ум' },
  battleship: { n: 2, noise: 1.00, draw: 0,    cat: 'ум' },
  nardy:      { n: 2, noise: 1.40, draw: 0,    cat: 'удача' },
  durak:      { n: 4, noise: 1.20, draw: 0,    cat: 'удача' },
  poker:      { n: 6, noise: 1.80, draw: 0,    cat: 'удача' },
  unoq:       { n: 4, noise: 3.00, draw: 0,    cat: 'удача' },
};
const GN = Object.keys(GAMES);
for (const g of GN) GAMES[g].luck = GAMES[g].noise ** 2 / (1 + GAMES[g].noise ** 2);

/** Сыграть партию: вернуть места (индексы игроков, первый — победитель) и признак ничьей. */
function play(R, game, skills /* силы в этой игре */) {
  const G = GAMES[game];
  const perf = skills.map((s) => s + G.noise * R.normal());
  const order = perf.map((p, i) => i).sort((a, b) => perf[b] - perf[a]);
  const draw = G.n === 2 && Math.abs(perf[0] - perf[1]) < G.draw;
  return { order, draw };
}

/* ------------------------------------------------------------------ системы рейтинга */

/** Текущие очки за место (копия таблицы из bot/rating.js; в разделе атак используется сам bot/rating.js). */
const PLACE = [20, 12, 6], REST = 3, LAST = -10;
const placePoints = (i, n, last = true) => (last && i === n - 1 ? LAST : PLACE[i] ?? REST);

/** LEAGUE: предложение. Многоигроковый Эло: для каждой пары мест — ожидаемый результат по рейтингам. */
const LEAGUE = {
  start: 1000, scale: 400,
  K: 24, provisionalK: 48, provisionalGames: 10,
  /** вес игры: чем больше удачи, тем меньше один исход говорит о силе → тем меньше шаг */
  weight: (game) => Math.max(0.35, 1 - GAMES[game].luck),
};
function leagueDelta(ratings, games, ids, order, draw, game, pairWeight = () => 1) {
  // pairWeight(self, opp, gain) — множитель к дельте игрока self против opp; gain=true, если дельта положительная
  // ratings: Map id→R, games: Map id→сколько сыграно; order — места
  const n = ids.length;
  const out = new Map(ids.map((id) => [id, 0]));
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const A = ids[order[a]], B = ids[order[b]];
    const ea = 1 / (1 + 10 ** ((ratings.get(B) - ratings.get(A)) / LEAGUE.scale));
    const sa = draw ? 0.5 : 1;
    const kA = (games.get(A) < LEAGUE.provisionalGames ? LEAGUE.provisionalK : LEAGUE.K) * LEAGUE.weight(game);
    const kB = (games.get(B) < LEAGUE.provisionalGames ? LEAGUE.provisionalK : LEAGUE.K) * LEAGUE.weight(game);
    const dA = (kA * (sa - ea)) / (n - 1), dB = (kB * ((1 - sa) - (1 - ea))) / (n - 1);
    out.set(A, out.get(A) + dA * pairWeight(A, B, dA > 0));
    out.set(B, out.get(B) + dB * pairWeight(B, A, dB > 0));
  }
  return out;
}

/**
 * Один «сезон» честной игры. systems — набор рейтингов, которые обновляются на одних и тех же партиях,
 * чтобы сравнение не зависело от того, кому что выпало.
 */
function season(R, players, plan) {
  const S = {
    cPts: new Map(),        // C: очки по играм (как сейчас) key `${id}:${game}`
    aSum: new Map(),        // A-сумма: те же очки, сложенные в одно число
    aElo: new Map(),        // A-Эло: одна Лига
    bElo: new Map(),        // B-Эло: по категориям, ключ `${id}:${cat}`
    cElo: new Map(),        // C-Эло: Эло по каждой игре, ключ `${id}:${game}` (контроль: Эло vs очки)
  };
  const played = new Map(), playedGame = new Map(), playedCat = new Map();
  for (const p of players) {
    S.aSum.set(p.id, 0); S.aElo.set(p.id, LEAGUE.start); played.set(p.id, 0);
    for (const g of GN) { S.cPts.set(`${p.id}:${g}`, 0); S.cElo.set(`${p.id}:${g}`, LEAGUE.start); playedGame.set(`${p.id}:${g}`, 0); }
    for (const c of ['ум', 'удача']) { S.bElo.set(`${p.id}:${c}`, LEAGUE.start); playedCat.set(`${p.id}:${c}`, 0); }
  }
  const byId = new Map(players.map((p) => [p.id, p]));
  for (const { game } of plan) {
    const G = GAMES[game];
    const cand = players.filter((p) => p.games.includes(game));
    // собрать стол из n разных желающих, взвешенно по активности
    const table = [];
    const guard = new Set();
    while (table.length < G.n && guard.size < cand.length) {
      const w = cand.map((p) => (guard.has(p.id) ? 0 : p.activity));
      const tot = w.reduce((s, x) => s + x, 0);
      let r = R() * tot, k = 0;
      while (k < cand.length - 1 && (r -= w[k]) > 0) k++;
      guard.add(cand[k].id); table.push(cand[k]);
    }
    if (table.length < G.n) continue;
    const { order, draw } = play(R, game, table.map((p) => p.skill[game]));
    const ids = table.map((p) => p.id);
    // C и A-сумма
    if (!draw) order.forEach((ti, place) => {
      const id = ids[ti], d = placePoints(place, G.n);
      const k = `${id}:${game}`;
      S.cPts.set(k, Math.max(0, S.cPts.get(k) + d));
      S.aSum.set(id, Math.max(0, S.aSum.get(id) + d));
    });
    // A-Эло
    const dA = leagueDelta(S.aElo, played, ids, order, draw, game);
    for (const [id, d] of dA) S.aElo.set(id, Math.max(0, S.aElo.get(id) + d));
    // B-Эло по категории
    const cat = G.cat;
    const bR = new Map(ids.map((id) => [id, S.bElo.get(`${id}:${cat}`)]));
    const bG = new Map(ids.map((id) => [id, playedCat.get(`${id}:${cat}`)]));
    for (const [id, d] of leagueDelta(bR, bG, ids, order, draw, game)) S.bElo.set(`${id}:${cat}`, Math.max(0, S.bElo.get(`${id}:${cat}`) + d));
    // C-Эло по игре
    const cR = new Map(ids.map((id) => [id, S.cElo.get(`${id}:${game}`)]));
    const cG = new Map(ids.map((id) => [id, playedGame.get(`${id}:${game}`)]));
    for (const [id, d] of leagueDelta(cR, cG, ids, order, draw, game)) S.cElo.set(`${id}:${game}`, Math.max(0, S.cElo.get(`${id}:${game}`) + d));
    for (const id of ids) {
      played.set(id, played.get(id) + 1);
      playedGame.set(`${id}:${game}`, playedGame.get(`${id}:${game}`) + 1);
      playedCat.set(`${id}:${cat}`, playedCat.get(`${id}:${cat}`) + 1);
    }
  }
  return { S, played, playedGame, byId };
}

function makePopulation(R, N, { activityMode = 'wide' } = {}) {
  const players = [];
  for (let i = 0; i < N; i++) {
    const g = R.normal();
    const skill = {};
    for (const game of GN) skill[game] = g + 0.5 * R.normal(); // общая сила + особенность игры
    const activity = activityMode === 'wide' ? Math.exp(1.0 * R.normal()) : 1; // независимо от силы
    players.push({ id: `p${i}`, g, skill, activity, games: GN, kind: 'обычный' });
  }
  return players;
}
/** План сезона: каждая «партия» выбирает игру по популярности. */
function makePlan(R, count) {
  const pop = { chess: 3, checkers: 2, battleship: 2, nardy: 2, durak: 4, poker: 3, unoq: 2 };
  const tot = Object.values(pop).reduce((a, b) => a + b, 0);
  return Array.from({ length: count }, () => {
    let r = R() * tot;
    for (const g of GN) if ((r -= pop[g]) <= 0) return { game: g };
    return { game: 'durak' };
  });
}

/* ------------------------------------------------------------------ ЧАСТЬ 1: качество рейтинга */
function quality() {
  qualityTable('flat');
  qualityTable('wide');
  volumeAndSpecialization();
}
function qualityTable(mode) {
  const N = 240, MATCHES = 9000; // ≈ 9000 партий на 240 человек; в среднем ≈ 60 партий на человека
  const out = {};
  const runs = [1, 2, 3].map((rep) => {
    const R = rng(SEED + 100 * rep);
    // силы — одни и те же во всех прогонах (rep отличается только удачей партий) → сравнение «повторяемости»
    const pop = makePopulation(rng(SEED), N, { activityMode: mode });
    const plan = makePlan(R, MATCHES);
    return season(R, pop, plan);
  });
  const pop = makePopulation(rng(SEED), N, { activityMode: mode });
  const cats = { ум: ['chess', 'checkers', 'battleship'], удача: ['nardy', 'durak', 'poker', 'unoq'] };
  const trueG = pop.map((p) => p.g);
  const trueGame = (g) => pop.map((p) => p.skill[g]);
  const trueCat = (c) => pop.map((p) => mean(cats[c].map((g) => p.skill[g])));

  const metric = (get, truthOf, minPlayed) => {
    // «точность»: Спирмен рейтинга с настоящей силой среди тех, кто сыграл достаточно; «повторяемость»: Спирмен двух прогонов
    const accs = [], reps = [];
    for (const unit of get.units) {
      const valid = pop.map((p, i) => (get.played(runs[0], p.id, unit) >= minPlayed ? i : -1)).filter((i) => i >= 0);
      if (valid.length < 20) continue;
      const truth = truthOf(unit);
      accs.push(mean(runs.map((r) => spearman(valid.map((i) => get.val(r, pop[i].id, unit)), valid.map((i) => truth[i])))));
      reps.push(mean([[0, 1], [0, 2], [1, 2]].map(([a, b]) => spearman(valid.map((i) => get.val(runs[a], pop[i].id, unit)), valid.map((i) => get.val(runs[b], pop[i].id, unit))))));
    }
    return { acc: mean(accs), rep: mean(reps) };
  };
  const sys = {
    'C  очки по каждой игре (как сейчас)': { units: GN, val: (r, id, g) => r.S.cPts.get(`${id}:${g}`), played: (r, id, g) => r.playedGame.get(`${id}:${g}`), truth: trueGame },
    'C* Эло по каждой игре (контроль)': { units: GN, val: (r, id, g) => r.S.cElo.get(`${id}:${g}`), played: (r, id, g) => r.playedGame.get(`${id}:${g}`), truth: trueGame },
    'A1 сумма тех же очков в одно число': { units: ['all'], val: (r, id) => r.S.aSum.get(id), played: (r, id) => r.played.get(id), truth: () => trueG },
    'A2 единая «Лига» (Эло)': { units: ['all'], val: (r, id) => r.S.aElo.get(id), played: (r, id) => r.played.get(id), truth: () => trueG },
    'B  две категории (Эло)': { units: ['ум', 'удача'], val: (r, id, c) => r.S.bElo.get(`${id}:${c}`), played: (r, id, c) => mean(cats[c].map((g) => r.playedGame.get(`${id}:${g}`))) * cats[c].length, truth: trueCat },
  };
  console.log(mode === 'flat' ? '--- а) все играют примерно одинаково много ---' : '--- б) как в жизни: одни играют в 20 раз больше других (сила и активность не связаны) ---');
  console.log(`Сезон: ${N} игроков, ${MATCHES} партий (≈ ${f1((MATCHES * 3.2) / N)} партий на человека), 3 повтора с одинаковыми игроками и разной удачей.`);
  console.log('Точность = корреляция Спирмена рейтинга с настоящей силой (1.00 — идеал). Повторяемость = Спирмен между двумя сезонами тех же людей (чем выше, тем меньше решает удача).');
  console.log('Считаются игроки, сыгравшие в своей единице рейтинга ≥ 15 партий.\n');
  console.log('Система                                  | Точность | Повторяемость');
  console.log('-----------------------------------------|----------|--------------');
  for (const [name, s] of Object.entries(sys)) {
    const m = metric(s, s.truth, 15);
    out[name] = m;
    console.log(`${name.padEnd(41)}| ${f2(m.acc).padStart(8)} | ${f2(m.rep).padStart(12)}`);
  }
  console.log('\nОговорка: у C и B «настоящая сила» — своя для игры / категории, у A — общая. Сравнивать точность между строками нужно с этим в уме;');
  console.log('честнее всего сравнение A1 и A2 (одна и та же цель, один и тот же ответ, разная формула) и C и C* (то же для «по играм»).');

  return out;
}

function volumeAndSpecialization() {
  const N = 240, MATCHES = 9000;
  const R1 = rng(SEED + 100);
  const pop = makePopulation(rng(SEED), N, { activityMode: 'wide' });
  const r0 = season(R1, pop, makePlan(R1, MATCHES));
  // --- эффект объёма: при независимости силы и активности рейтинг не должен зависеть от числа партий
  console.log('\nЭффект объёма (богатеет тот, кто просто больше играет). Сила и активность независимы.');
  console.log('Показатель = (средний процентиль рейтинга у самой активной пятой части) − (у самой малоактивной пятой части). 0 — честно, 100 — решает только объём.');
  const act = pop.map((p) => r0.played.get(p.id));
  const order = ranks(act);
  const q = (i) => order[i] / (N - 1);
  const topQ = pop.map((p, i) => i).filter((i) => q(i) >= 0.8), botQ = pop.map((p, i) => i).filter((i) => q(i) <= 0.2);
  const ratingVec = {
    'A1 сумма очков': pop.map((p) => r0.S.aSum.get(p.id)),
    'A2 Лига (Эло)': pop.map((p) => r0.S.aElo.get(p.id)),
    'B  категория «удача» (Эло)': pop.map((p) => r0.S.bElo.get(`${p.id}:удача`)),
    'C  дурак, очки': pop.map((p) => r0.S.cPts.get(`${p.id}:durak`)),
  };
  for (const [name, v] of Object.entries(ratingVec)) {
    const P = pct(v);
    console.log(`  ${name.padEnd(30)} ${f1(mean(topQ.map((i) => P[i])) - mean(botQ.map((i) => P[i])))}  (активные ≈ ${f1(mean(topQ.map((i) => P[i])))}-й процентиль, малоактивные ≈ ${f1(mean(botQ.map((i) => P[i])))}-й)`);
  }
  console.log('  Среднее число партий: самые активные ' + f1(mean(topQ.map((i) => act[i]))) + ', самые малоактивные ' + f1(mean(botQ.map((i) => act[i]))) + '.');

  // --- специализация: игрок средней силы (g=0) играет только в одну игру против всех-играющих
  console.log('\nСпециализация. 20 «узких» игроков средней силы (во всех играх 0) играют ТОЛЬКО в одну игру; 20 таких же «разносторонних» — во все. Все — по 60 партий.');
  console.log('Показатель — средний процентиль в общем списке системы (50 — честно: средний игрок должен быть посередине, как ни играй).');
  const gamesTest = ['chess', 'durak', 'poker', 'unoq'];
  const sysPct = {}, gamesCount = {};
  const runSpec = (g, mult) => {
    const R = rng(SEED + 777);
    const crowd = makePopulation(R, 200, { activityMode: 'flat' });
    const mine = [];
    for (let i = 0; i < 20; i++) mine.push({ id: `s${i}`, g: 0, skill: Object.fromEntries(GN.map((x) => [x, 0])), activity: mult, games: g === 'ВСЕ' ? GN : [g], kind: 'узкий' });
    const players = [...crowd, ...mine];
    const res = season(R, players, makePlan(R, Math.round((players.length * 60) / 3.2)));
    return { players, res };
  };
  for (const g of [...gamesTest, 'ВСЕ']) {
    // число партий у «узких» подгоняем под 60, иначе мы сравниваем объём, а не специализацию
    let mult = 1, run;
    for (let it = 0; it < 6; it++) {
      run = runSpec(g, mult);
      const obs = mean(run.players.filter((p) => p.kind === 'узкий').map((p) => run.res.played.get(p.id)));
      if (Math.abs(obs - 60) < 3) break;
      mult *= 60 / Math.max(obs, 1);
    }
    const { players, res } = run;
    gamesCount[g] = mean(players.filter((p) => p.kind === 'узкий').map((p) => res.played.get(p.id)));
    sysPct[g] = {};
    const mineIdx = players.map((p, i) => (p.kind === 'узкий' ? i : -1)).filter((i) => i >= 0);
    const take = (vec) => { const P = pct(vec); return mean(mineIdx.map((i) => P[i])); };
    sysPct[g]['A1 сумма очков'] = take(players.map((p) => res.S.aSum.get(p.id)));
    sysPct[g]['A2 Лига (Эло)'] = take(players.map((p) => res.S.aElo.get(p.id)));
    if (g !== 'ВСЕ') {
      const who = players.map((p, i) => (res.playedGame.get(`${p.id}:${g}`) >= 5 ? i : -1)).filter((i) => i >= 0);
      const P = pct(who.map((i) => res.S.cPts.get(`${players[i].id}:${g}`)));
      sysPct[g]['C  очки внутри игры'] = mean(who.map((i, k) => (players[i].kind === 'узкий' ? P[k] : null)).filter((x) => x != null));
    }
  }
  console.log('  Играют только в…   | A1 сумма очков | A2 Лига (Эло) | C очки внутри игры | партий у «узких»');
  for (const g of [...gamesTest, 'ВСЕ']) {
    console.log(`  ${(g === 'ВСЕ' ? 'во все игры' : g).padEnd(18)} | ${f1(sysPct[g]['A1 сумма очков']).padStart(14)} | ${f1(sysPct[g]['A2 Лига (Эло)']).padStart(13)} | ${sysPct[g]['C  очки внутри игры'] != null ? f1(sysPct[g]['C  очки внутри игры']).padStart(18) : '—'.padStart(18)} | ${f1(gamesCount[g])}`);
  }
}

/* ------------------------------------------------------------------ ЧАСТЬ 2: накрутка */
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 2, 9); // 2 ноября 2026, 9:00 UTC — дальше сутки за сутками

/**
 * Накрутка против НАСТОЯЩЕГО bot/rating.js. cfg.guards=false → пишем в хранилище напрямую (store.rate),
 * минуя apply: это «без защит», то есть что было бы, если бы дневных пределов не было.
 */
function realRun({ days, perDay, game, guards = true, make }) {
  const store = new NullStore();
  let seq = 0, gained = new Map(), blocked = 0, counted = 0;
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < perDay; k++) {
      const at = T0 + d * DAY + k * 60_000;
      const g = typeof game === 'function' ? game(k) : game;
      const { places, loserId } = make(d, k);
      const round = `r${seq++}`;
      let res;
      if (guards) res = rateRound(store, { game: g, round, places, loserId, at });
      else {
        res = { ok: true, rows: [] };
        const of = places.length;
        places.forEach((p, i) => store.rate({ userId: p.id, game: g, round, place: i + 1, of, delta: placePointsReal(i, of), at }));
      }
      if (res.ok) counted++; else blocked++;
    }
  }
  const total = (id) => ['chess', 'checkers', 'battleship', 'nardy', 'durak', 'poker', 'unoq'].reduce((s, g) => s + (store.ratingOf(id, g)?.points ?? 0), 0);
  return { store, total, counted, blocked };
}
const placePointsReal = (i, n) => (i === n - 1 ? LAST : PLACE[i] ?? REST);

/** Лига с защитами (предложение): повторы тех же соперников дешевеют, потолок в сутки на человека НА ВСЮ лигу, новички не кормят. */
function leagueAttack({ days, perDay, make, guards = true, startRatings = {}, startGames = {} }) {
  const ratings = new Map(Object.entries(startRatings));
  const games = new Map(Object.entries(startGames));
  const R0 = (id) => { if (!ratings.has(id)) ratings.set(id, LEAGUE.start); if (!games.has(id)) games.set(id, 0); };
  let counted = 0, blocked = 0;
  const gainedDay = new Map();
  const pairDay = new Map();
  for (let d = 0; d < days; d++) {
    gainedDay.clear(); pairDay.clear();
    for (let k = 0; k < perDay; k++) {
      const { ids, order, draw, game } = make(d, k);
      ids.forEach(R0);
      const key = (a, b) => [a, b].sort().join('|');
      const nth = (a, b) => pairDay.get(key(a, b)) ?? 0;
      // Повторы одной и той же пары дешевеют в обе стороны (иначе друзья, которые просто часто играют
      // друг с другом, незаслуженно тонули бы). Остальное действует только на ПРИБАВКУ.
      const pw = (self, opp, gain) => {
        let w = 1;
        if (guards) {
          w *= 0.5 ** nth(self, opp);                    // 1-й раз за день ×1, 2-й ×0.5, 3-й ×0.25 …
          if (gain && games.get(opp) < 5) w *= 0.25;     // победа над «непроверенным» (<5 партий) — четверть
          if (gain && ratings.get(self) - ratings.get(opp) > 400) w = 0; // победа над тем, кто слабее на 400+, очков не даёт
        }
        return w;
      };
      const dl = leagueDelta(ratings, games, ids, order, draw, game, pw);
      let any = false;
      for (const [id, v] of dl) {
        let take = v;
        if (guards && take > 0) {
          const left = DAILY_GAIN_CAP - (gainedDay.get(id) ?? 0);   // потолок прироста за сутки
          take = Math.min(take, Math.max(0, left));
          gainedDay.set(id, (gainedDay.get(id) ?? 0) + take);
        }
        if (Math.abs(take) > 1e-9) any = true;
        ratings.set(id, Math.max(0, ratings.get(id) + take));
      }
      for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) pairDay.set(key(ids[a], ids[b]), nth(ids[a], ids[b]) + 1);
      ids.forEach((id) => games.set(id, games.get(id) + 1));
      if (any) counted++; else blocked++;
    }
  }
  return { ratings, games, counted, blocked };
}
const DAILY_GAIN_CAP = 60; // очков Лиги в сутки на человека в плюс (предложение, см. docs/rating-bank.md)

function attacks() {
  const DAYS = 7;
  // «честный» ориентир: человек играет 5 партий в день, силой чуть выше среднего
  // (в текущей системе — настоящими правилами; результат берём усреднением по 200 «честным неделям»)
  const R = rng(SEED + 5);
  const HON_PER_DAY = 5;
  const duelGames = ['chess', 'checkers', 'battleship', 'nardy'];
  const honestReal = [];
  for (let rep = 0; rep < 200; rep++) {
    const me = { id: 'me' }, others = Array.from({ length: 30 }, (_, i) => ({ id: `o${i}` }));
    const skill = { me: 0.5 }; for (const o of others) skill[o.id] = R.normal();
    const r = realRun({ days: DAYS, perDay: HON_PER_DAY, game: (k) => ['chess', 'durak', 'poker', 'nardy', 'checkers'][k % 5], make: (d, k) => {
      const opp = others.slice().sort(() => R() - 0.5);
      const n = [2, 4, 6, 2, 2][k % 5];
      const table = [me, ...opp.slice(0, n - 1)];
      const sk = table.map((p) => skill[p.id]);
      const perf = sk.map((s) => s + 1.0 * R.normal());
      const ord = perf.map((_, i) => i).sort((a, b) => perf[b] - perf[a]);
      return { places: ord.map((i) => table[i]), loserId: table[ord[ord.length - 1]].id };
    } });
    honestReal.push(r.total('me'));
  }
  const honest = mean(honestReal);

  const honestL = [];
  for (let rep = 0; rep < 200; rep++) {
    const fld = Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, s: R.normal() }));
    const ratings = new Map([['me', 1000], ...fld.map((f) => [f.id, 1000 + 200 * f.s])]);
    const games = new Map([['me', 50], ...fld.map((f) => [f.id, 50])]);
    const pairs = new Map(); let gainedToday = 0, day = -1;
    for (let k = 0; k < DAYS * HON_PER_DAY; k++) {
      if (Math.floor(k / HON_PER_DAY) !== day) { day = Math.floor(k / HON_PER_DAY); pairs.clear(); gainedToday = 0; }
      const o = fld[R.int(fld.length)];
      const win = 0.5 + 1.0 * R.normal() > o.s + 1.0 * R.normal();
      const dl = leagueDelta(ratings, games, ['me', o.id], win ? [0, 1] : [1, 0], false, 'chess', (self, opp) => 0.5 ** (pairs.get([self, opp].sort().join('|')) ?? 0));
      pairs.set(['me', o.id].sort().join('|'), (pairs.get(['me', o.id].sort().join('|')) ?? 0) + 1);
      for (const [id, v] of dl) ratings.set(id, ratings.get(id) + v);
    }
    honestL.push(ratings.get('me') - 1000);
  }
  honestL.sort((a, b) => a - b);
  console.log(`Условия: неделя (${DAYS} дн.); у «накрутчика» бюджет — сколько партий в день он реально сыграет. Честный игрок (сила чуть выше средней)`);
  console.log(`играет ${HON_PER_DAY} партий в день в разных играх и за неделю в сегодняшней системе набирает в среднем ≈ ${int(honest)} очков (по 200 таких недель).`);
  console.log('«Сегодня» = настоящий bot/rating.js (защиты: ≤10 партий в сутки у состава, ≤10 плюсовых партий в сутки у человека в игре, ничьи и короткие партии без очков).');
  console.log('«Без защит» = те же партии, но запись минуя защиты.\n');

  const pair = (a, b, d, k) => (k % 2 === 0 ? [a, b] : [b, a]); // по очереди выигрывают
  const rowsOut = [];
  const addRow = (label, today, nothing, league, note = '') => rowsOut.push({ label, today, nothing, league, note });

  for (const budget of [20, 40]) {
    // (а) двое сливают друг другу: по очереди выигрывают в дуэлях (шахматы/шашки/нарды/морской бой по кругу)
    const A = { id: 'A' }, B = { id: 'B' };
    const mk = (d, k) => { const [w, l] = pair(A, B, d, k); return { places: [w, l], loserId: l.id }; };
    const gameAt = (k) => duelGames[k % duelGames.length];
    const today = realRun({ days: DAYS, perDay: budget, game: gameAt, make: mk });
    const none = realRun({ days: DAYS, perDay: budget, game: gameAt, guards: false, make: mk });
    // Лига: те же партии, новые аккаунты по 1000, «проверенность» набрана (≥5 партий) — худший для защиты случай
    const mkL = (d, k) => { const [w, l] = pair('A', 'B', d, k); return { ids: [w, l], order: [0, 1], draw: false, game: gameAt(k) }; };
    const start = { A: 1000, B: 1000 }, sg = { A: 50, B: 50 };
    const ligue = leagueAttack({ days: DAYS, perDay: budget, make: mkL, guards: true, startRatings: start, startGames: sg });
    const ligueNo = leagueAttack({ days: DAYS, perDay: budget, make: mkL, guards: false, startRatings: start, startGames: sg });
    addRow(`(а) двое по очереди «сливают» друг другу, ${budget} партий/день`, today.total('A'), none.total('A'), ligue.ratings.get('A') - 1000, `Лига без новых защит: ${f1(ligueNo.ratings.get('A') - 1000)}`);
    // (а2) один всегда выигрывает
    const mk2 = () => ({ places: [A, B], loserId: 'B' });
    const t2 = realRun({ days: DAYS, perDay: budget, game: gameAt, make: mk2 });
    const n2 = realRun({ days: DAYS, perDay: budget, game: gameAt, guards: false, make: mk2 });
    const mkL2 = (d, k) => ({ ids: ['A', 'B'], order: [0, 1], draw: false, game: gameAt(k) });
    const l2 = leagueAttack({ days: DAYS, perDay: budget, make: mkL2, startRatings: start, startGames: sg });
    const l2n = leagueAttack({ days: DAYS, perDay: budget, make: mkL2, guards: false, startRatings: start, startGames: sg });
    addRow(`(а2) один всегда выигрывает у второго, ${budget} партий/день`, t2.total('A'), n2.total('A'), l2.ratings.get('A') - 1000, `Лига без новых защит: ${f1(l2n.ratings.get('A') - 1000)}`);
    // (б) мультиаккаунты: один основной + 4 подставных, каждое утро — новые подставные
    const mkM = (d, k) => ({ places: [{ id: 'M' }, { id: `puppet-${d}-${k % 4}` }], loserId: `puppet-${d}-${k % 4}` });
    const tM = realRun({ days: DAYS, perDay: budget, game: gameAt, make: mkM });
    const nM = realRun({ days: DAYS, perDay: budget, game: gameAt, guards: false, make: mkM });
    const mkLM = (d, k) => ({ ids: ['M', `puppet-${d}-${k % 4}`], order: [0, 1], draw: false, game: gameAt(k) });
    const lM = leagueAttack({ days: DAYS, perDay: budget, make: mkLM, startRatings: { M: 1000 }, startGames: { M: 50 } });
    const lMn = leagueAttack({ days: DAYS, perDay: budget, make: mkLM, guards: false, startRatings: { M: 1000 }, startGames: { M: 50 } });
    addRow(`(б) мультиаккаунты: основной + 4 новых «болванчика» в день, ${budget} партий/день`, tM.total('M'), nM.total('M'), lM.ratings.get('M') - 1000, `Лига без новых защит: ${f1(lMn.ratings.get('M') - 1000)}`);
  }
  // (б2) терпеливый: 20 «выдержанных» подставных (у каждого уже по 50 партий), основной бьёт их по 40 партий в день месяц
  {
    const puppets = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${i}`, 1000]));
    const pg = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${i}`, 50]));
    const mk = (d, k) => ({ ids: ['M', `q${(d * 7 + k) % 20}`], order: [0, 1], draw: false, game: duelGames[k % 4] });
    const r30 = leagueAttack({ days: 30, perDay: 40, make: mk, startRatings: { M: 1000, ...puppets }, startGames: { M: 50, ...pg } });
    const r30n = leagueAttack({ days: 30, perDay: 40, make: mk, guards: false, startRatings: { M: 1000, ...puppets }, startGames: { M: 50, ...pg } });
    const r7 = leagueAttack({ days: 7, perDay: 40, make: mk, startRatings: { M: 1000, ...puppets }, startGames: { M: 50, ...pg } });
    addRow('(б2) терпеливый: 20 «выдержанных» подставных (по 50 партий), 40 партий/день', NaN, NaN, r7.ratings.get('M') - 1000, `за 30 дней: Лига +${f1(r30.ratings.get('M') - 1000)} (без новых защит +${f1(r30n.ratings.get('M') - 1000)}); «сегодня» за 30 дней ≈ ${int(30 * 40 * 20)}`);
  }
  // (в) боты. Сегодня партии с ботами в рейтинг не идут вообще (app.rate: if (room.solo) return []).
  {
    const budget = 40;
    const mkB = () => ({ places: [{ id: 'H' }, { id: 'BOT' }], loserId: 'BOT' });
    const hypo = realRun({ days: DAYS, perDay: budget, game: 'chess', guards: true, make: mkB }); // если бы боты шли в рейтинг
    const hypoNo = realRun({ days: DAYS, perDay: budget, game: 'chess', guards: false, make: mkB });
    addRow('(в) бот-фарм, 40 партий/день: ТЕКУЩИЙ код (партии с ботами не идут в рейтинг)', 0, 0, 0, 'проверено по коду: bot/app.js, rate(): «if (room.solo) return []»');
    addRow('(в’) то же, но ЕСЛИ БЫ боты шли в рейтинг (гипотеза, чтобы оценить цену запрета)', hypo.total('H'), hypoNo.total('H'), NaN, 'шахматы с ботом, 40 партий/день, бот всегда проигрывает');
  }
  // (г) выход перед проигрышем: хост распускает стол, когда проигрывает (партия «не доиграна» → без очков никому)
  {
    const res = [];
    for (const [label, abortWhenLosing] of [['честно доигрывает', false], ['распускает стол, когда проигрывает', true]]) {
      const Rg = rng(SEED + 9);
      const vals = [];
      for (let rep = 0; rep < 200; rep++) {
        const store = new NullStore();
        let seq = 0;
        for (let d = 0; d < DAYS; d++) for (let k = 0; k < 5; k++) {
          const at = T0 + d * DAY + k * 60_000;
          const perf = [0.5 + 1.0 * Rg.normal(), 1.0 * Rg.normal()];
          const win = perf[0] > perf[1];
          const places = win ? [{ id: 'me' }, { id: 'x' + k }] : [{ id: 'x' + k }, { id: 'me' }];
          rateRound(store, { game: 'chess', round: `g${seq++}`, places, loserId: places[1].id, aborted: abortWhenLosing && !win && Rg() < 0.8, at });
        }
        vals.push(store.ratingOf('me', 'chess')?.points ?? 0);
      }
      res.push([label, mean(vals)]);
    }
    addRow('(г) хост распускает проигрываемые партии (80% проигрышей), 5 партий/день', res[1][1], res[0][1], NaN, `честный игрок той же силы: ${int(res[0][1])} → с «выходом» ${int(res[1][1])}. Защита сегодня: нет (записано как «не доиграна»)`);
  }
  console.log('Очки за неделю, набранные нападающим (для Лиги — изменение числа Лиги, старт 1000):\n');
  console.log('Атака                                                                      | Сегодня | Без защит | Лига (новые защиты) | примечание');
  console.log('---------------------------------------------------------------------------|---------|-----------|---------------------|-----------');
  for (const r of rowsOut) console.log(`${r.label.padEnd(75)}| ${(Number.isNaN(r.today) ? '—' : int(r.today)).padStart(7)} | ${(Number.isNaN(r.nothing) ? '—' : int(r.nothing)).padStart(9)} | ${(Number.isNaN(r.league) ? '—' : (r.league >= 0 ? '+' : '') + f1(r.league)).padStart(19)} | ${r.note}`);
  console.log(`\nОриентир: честный игрок за неделю ≈ ${int(honest)} очков сегодня. В Лиге такой же честный игрок (сила +0.5) за неделю в среднем меняется на ${f1(mean(honestL))} (90-й процентиль ${f1(honestL[Math.floor(honestL.length * 0.9)])}; рейтинги соперников уже верные). Лига: потолок прироста ${DAILY_GAIN_CAP}/сутки на человека (≤ ${DAILY_GAIN_CAP * DAYS}/нед.).`);

  // (д) «играю только с новичками»
  console.log('\n(д) «Играю только с новичками». Сильный игрок (сила +2) за неделю играет 35 партий: либо с равными, либо только с самыми слабыми.');
  const Rn = rng(SEED + 11);
  const mkField = (n) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, s: Rn.normal() }));
  const field = mkField(120);
  const weak = field.slice().sort((a, b) => a.s - b.s).slice(0, 30);
  const peers = field.filter((f) => Math.abs(f.s - 1.5) < 0.6).slice(0, 30);
  const runD = (opps, system) => {
    const vals = [];
    for (let rep = 0; rep < 200; rep++) {
      const store = new NullStore();
      const ratings = new Map([['S', 1400], ...field.map((f) => [f.id, 1000 + 200 * f.s])]);
      const games = new Map([['S', 50], ...field.map((f) => [f.id, 50])]);
      let seq = 0;
      for (let d = 0; d < 7; d++) for (let k = 0; k < 5; k++) {
        const o = opps[Rn.int(opps.length)];
        const win = 2 + 0.5 * Rn.normal() > o.s + 0.5 * Rn.normal();
        const places = win ? [{ id: 'S' }, { id: o.id }] : [{ id: o.id }, { id: 'S' }];
        const at = T0 + d * DAY + k * 60_000;
        if (system === 'points') rateRound(store, { game: 'chess', round: `d${seq++}`, places, loserId: places[1].id, at });
        else {
          const ids = places.map((p) => p.id);
          const dl = leagueDelta(ratings, games, ids, [0, 1], false, 'chess', () => 1);
          for (const [id, v] of dl) ratings.set(id, ratings.get(id) + v);
          games.set('S', games.get('S') + 1);
        }
      }
      vals.push(system === 'points' ? store.ratingOf('S', 'chess')?.points ?? 0 : ratings.get('S') - 1400);
    }
    return mean(vals);
  };
  const pPeer = runD(peers, 'points'), pWeak = runD(weak, 'points');
  const lPeer = runD(peers, 'league'), lWeak = runD(weak, 'league');
  console.log('                          | с равными (за 35 партий) | только со слабыми (за 35 партий) | во сколько раз «с новичками» выгоднее');
  console.log(`  Сегодня (очки)          | ${f1(pPeer).padStart(24)} | ${f1(pWeak).padStart(32)} | ×${f2(pWeak / pPeer)}`);
  console.log(`  Лига (Эло)              | ${f1(lPeer).padStart(24)} | ${f1(lWeak).padStart(32)} | ×${f2(lWeak / lPeer)}`);
  console.log('  (шахматы; за один и тот же срок и число партий; в «Сегодня» защита от «только с новичками» не предусмотрена вообще)');
}

/* ------------------------------------------------------------------ ЧАСТЬ 3: банк */
function gini(xs) {
  const a = xs.slice().sort((x, y) => x - y), n = a.length, s = a.reduce((p, c) => p + c, 0);
  if (!s) return 0;
  let cum = 0; for (let i = 0; i < n; i++) cum += (i + 1) * a[i];
  return (2 * cum) / (n * s) - (n + 1) / n;
}
function bank() {
  console.log('Модель: 100 равных по силе игроков, 300 дуэльных партий на человека с равными шансами 50/50 (чистая удача).');
  console.log('Что смотрим: расходится ли «богатство» само собой (Джини: 0 — поровну, 1 — всё у одного).\n');
  const N = 100, ROUNDS = 300 * N / 2;
  const sims = {};
  for (const [name, fn] of Object.entries({
    'кошелёк, ставка = 10% кошелька': (R, w, a, b) => { const stake = Math.min(w[a], w[b]) * 0.1; return stake; },
    'кошелёк, ставка = 1.000 (фиксированный стол)': (R, w, a, b) => Math.min(1000, w[a], w[b]),
  })) {
    const R = rng(SEED + 31), w = new Array(N).fill(10000);
    for (let i = 0; i < ROUNDS; i++) {
      let a = R.int(N), b = R.int(N); if (a === b) b = (b + 1) % N;
      const stake = fn(R, w, a, b);
      if (R() < 0.5) { w[a] += stake; w[b] -= stake; } else { w[a] -= stake; w[b] += stake; }
    }
    const s = w.slice().sort((x, y) => y - x);
    sims[name] = { g: gini(w), top10: s.slice(0, 10).reduce((p, c) => p + c, 0) / w.reduce((p, c) => p + c, 0), broke: w.filter((x) => x < 1000).length };
  }
  console.log('Кошелёк без подпитки (сумма фишек в мире постоянна):');
  for (const [k, v] of Object.entries(sims)) console.log(`  ${k.padEnd(48)} Джини ${f2(v.g)} · у 10% богатейших ${f1(v.top10 * 100)}% всех фишек · «разорились» (<1.000): ${v.broke} из ${N}`);
  console.log('  → даже при равной силе кошелёк сам превращается в «богатые и нищие»; нищим нужна подпитка, а подпитка — это печатание фишек.\n');

  // печатание: подарок новому аккаунту
  console.log('Печатание фишек новыми аккаунтами. Если каждый новый аккаунт получает стартовые 10.000, мультиаккаунтер забирает их проигрышем самому себе (Telegram даёт только id аккаунта, «одного человека» отличить нечем):');
  for (const accounts of [1, 5, 20]) {
    const printed = (accounts - 1) * 10000;
    console.log(`  основной + ${String(accounts - 1).padStart(2)} подставных: «из воздуха» ${int(printed).padStart(9)} фишек`);
  }
  console.log('\nПередача проигрышем (двое «друзей»): за N партий по 1.000 весь банк одного переходит к другому без остатка;');
  const w = [10000, 10000]; for (let i = 0; i < 10; i++) { w[0] += 1000; w[1] -= 1000; }
  console.log(`  10 партий по 1.000 → у основного ${int(w[0])}, у второго ${int(w[1])}. Любой кошелёк с реальной ценностью (открывает столы/преимущество) этим обходится.`);
  console.log('  Без ценности (только число) — обходится тоже, но выигрыша нет: поэтому банк НЕ должен ничего открывать в рейтинговых играх.');
}

/* ------------------------------------------------------------------ запуск */
const H = (t) => console.log(`\n=== ${t} ===\n`);
console.log(`sim-rating · seed ${SEED} · node ${process.version.split('.')[0]}`);
if (PART === 'all' || PART === 'quality') { H('1. Качество рейтинга при честной игре'); quality(); }
if (PART === 'all' || PART === 'attacks') { H('2. Накрутка'); attacks(); }
if (PART === 'all' || PART === 'bank') { H('3. Банк-кошелёк'); bank(); }
