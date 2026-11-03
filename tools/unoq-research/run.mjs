import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { play, LIMIT, SEATS } from './simulator.mjs';
import { MODELS, LINEUPS, VERSION, agent, decide } from './strategies.mjs';
import { summarize, wilson } from './stats.mjs';
import { apply } from '../../bot/rating.js';
import { NullStore } from '../../bot/store.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'docs/bot-rating-data');
fs.mkdirSync(out, { recursive: true });
const files = ['tools/unoq-research/strategies.mjs','tools/unoq-research/simulator.mjs',
  'tools/unoq-research/stats.mjs','tools/unoq-research/run.mjs','tools/unoq-research/lobby.mjs',
  'bot/games/colors/rules.js','bot/games/colors/view.js','bot/games/colors/cards.js',
  'bot/games/colors/index.js','bot/games/colors/bot.js','bot/rating.js','bot/store.js'];
const hashes = () => Object.fromEntries(files.map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')]));
const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
const read = name => JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));
const scenarios = MODELS.flatMap(model => LINEUPS.map(lineup => ({ id: MODELS.indexOf(model) * 5 + LINEUPS.indexOf(lineup), model, lineup })));
const phase = process.argv[2];
const plan = { version: VERSION, seats: SEATS, stacking: true, turnSeconds: 30, maxActions: LIMIT,
  pilotPerScenario: 100, mainPerScenario: 2000, holdout: 10000, thresholdWinDifference: 0.05,
  thresholdReason: '5 percentage points is 20% relative to a fair 25% win rate; material for ranked opponents.',
  scenarios, seeds: 'deal = phaseBase + scenario * 20000 + index; pilot=1000000, main=10000000, holdout=100000000',
  lineupRule: 'mix: exactly one A/B/C, Fisher-Yates using separate lineup PRNG; others homogeneous',
  positionRule: 'focal seat = index % 4; first dealer seat 0; first turn seat 1',
  decisionSeeds: 'deal XOR imul(seat+1,0x9e3779b9), one independent PRNG state per player; lineup=deal XOR 0x34ab98ef',
  timing: '30s wait + 4s per focal action + 1.25s per opponent action + 0.4s per shout; everyone shouts before catches (>=0.9s)',
  analysis: 'Wilson 95% win CI; normal 95% mean CI (bounded points, n>=2000). Nine style contrasts: conservative Bonferroni z=2.78; equivalence requires entire interval inside +/-0.05.',
  failureRule: 'All launched games retained. Missing = nonwin/zero points, bounds also reported. Length conditional on completed; failure trace/snapshot saved.',
  rating: 'actual solo=0; conditional points from real points()/split() [20,12,6,-10]; baseline score 1000. From-zero reported separately; centered=points-7 and equal-rating pairwise Elo K24 separately.',
  selectionRule: 'Among 12 noncontrol main cells choose largest mean nominal points; tie -> lower scenario id. No tuning. Test 10000 fresh games of selected cell.',
  power: 'At p=0.25: n~=1176/arm for 5pp difference at 80% power, alpha .05; ~=1966/arm with 9-contrast Bonferroni. 2pp needs ~=12286/arm adjusted.',
  hashes: hashes() };

if (phase === 'register') { save('preregistered.json', plan); console.log('Registered before pilot/main.'); }
else if (phase === 'freeze') {
  const registered = read('preregistered.json');
  if (JSON.stringify(registered.hashes) !== JSON.stringify(hashes())) throw new Error('Sources changed since registration');
  const main = read('main-summary.json');
  const selected = main.scenarios.filter(s => s.lineup !== 'control').sort((a,b) => b.rating.nominal.mean - a.rating.nominal.mean || a.scenario - b.scenario)[0];
  save('holdout-lock.json', { version: VERSION, hashes: hashes(), selected: scenarios[selected.scenario],
    selectionRule: registered.selectionRule, mainSummarySha256: createHash('sha256').update(fs.readFileSync(path.join(out, 'main-summary.json'))).digest('hex'),
    criteria: { inflation: 'nominal lower 95% CI > 0', advantage: 'win lower 95% CI > 0.30 (fair 0.25 + practical 0.05)',
      equalLevel: 'style comparison corrected interval entirely inside +/-0.05 for each model',
      noRepair: 'No strategies modified after lock; repair requires new holdout seed namespace.' }, seedBase: 100_000_000, n: 10000 });
  console.log(JSON.stringify(selected));
} else if (['pilot','main','holdout'].includes(phase)) {
  const registered = read('preregistered.json');
  if (JSON.stringify(registered.hashes) !== JSON.stringify(hashes())) throw new Error('Sources changed; re-register BEFORE running any experiments');
  let chosen = scenarios, n = phase === 'pilot' ? 100 : 2000;
  if (phase === 'holdout') {
    const lock = read('holdout-lock.json');
    if (JSON.stringify(lock.hashes) !== JSON.stringify(hashes())) throw new Error('Holdout frozen sources changed');
    chosen = [lock.selected]; n = lock.n;
  }
  const all = [], summary = [], disagreement = { sampledViews: 0, AB: 0, AC: 0, BC: 0 };
  for (const s of chosen) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const r = await play({ phase, scenario: s.id, index: i, model: s.model, lineup: s.lineup,
        onView: phase === 'main' && s.id === 0 && i < 100 ? (v, seat) => {
          if (!v.legal.myTurn || v.legal.play.length < 2) return;
          // Counterfactual identical-input decisions; diagnostic RNG cannot affect play.
          const messages = ['A','B','C'].map(t => decide(agent(t, 9000 + i * 4 + seat), v));
          const key = m => JSON.stringify([m.t,m.card,m.color]);
          disagreement.sampledViews++;
          for (const [k,a,b] of [['AB',0,1],['AC',0,2],['BC',1,2]]) if (key(messages[a]) !== key(messages[b])) disagreement[k]++;
        } : null });
      rows.push(r); all.push(r);
      if (r.status !== 'completed') save(`failure-${phase}-${s.id}-${i}.json`, r);
      if ((i + 1) % 500 === 0) console.log(`${phase} ${s.id} ${i + 1}/${n}`);
    }
    const stats = { ...summarize(rows), lineup: s.lineup };
    // Replay exact same outcomes through unchanged apply()/NullStore. Counterfactual eligibility ONLY.
    stats.dailyReplay = {};
    for (const rotateIds of [false, true]) {
      const store = new NullStore(), deltas = [], statuses = {};
      for (const r of rows) {
        if (r.status !== 'completed') { deltas.push(0); continue; }
        const before = store.ratingOf('focal','colors')?.points || 0;
        const ids = ['s0','s1','s2','s3'].map((id, seat) => seat === r.focalSeat ? 'focal' : `bot${(seat-r.focalSeat+4)%4}${rotateIds ? `:${r.index}` : ''}`);
        const places = r.order.map(id => ({ id: ids[Number(id.slice(1))] }));
        const res = apply(store, { game: 'colors', round: `${phase}:${s.id}:${r.index}`, places,
          loserId: places.at(-1).id, at: 1_800_000_000_000 + Math.floor(r.index / 20) * 86400000 });
        const status = res.ok ? 'ok' : res.skipped;
        statuses[status] = (statuses[status] || 0) + 1;
        deltas.push((store.ratingOf('focal','colors')?.points || 0) - before);
      }
      stats.dailyReplay[rotateIds ? 'rotatingBotIds' : 'stableBotIds'] = {
        model: '20 sequential games/day, same focal, initial rating0, current all-gainers guard applies to bots too',
        endPoints: store.ratingOf('focal','colors')?.points || 0, statuses,
        netPerDay: deltas.reduce((s,x) => s+x,0) / (n/20),
      };
    }
    summary.push(stats);
    console.log(`${phase} ${s.id}: ${stats.completed}/${stats.launched}, wins=${stats.wins}, nominal=${stats.rating.nominal.mean.toFixed(3)}`);
  }
  const contrasts = [];
  if (phase === 'main') for (const model of MODELS) {
    const cells = summary.filter(s => s.model === model && ['A','B','C'].includes(s.lineup));
    for (let a = 0; a < 3; a++) for (let b = a+1; b < 3; b++) {
      const x = cells[a], y = cells[b], d = x.winRate-y.winRate;
      const h = 2.78 * Math.sqrt(x.winRate*(1-x.winRate)/x.launched + y.winRate*(1-y.winRate)/y.launched);
      const ci = [d-h,d+h];
      contrasts.push({ model, pair: [x.lineup,y.lineup], difference: d, correctedCi: ci,
        equivalenceAt5pp: ci[0] > -0.05 && ci[1] < 0.05 });
    }
  }
  const raw = Buffer.from(all.map(r => JSON.stringify(r)).join('\n') + '\n');
  const zipped = gzipSync(raw, { level: 9 });
  fs.writeFileSync(path.join(out, `${phase}-games.jsonl.gz`), zipped);
  save(`${phase}-summary.json`, { phase, version: VERSION, node: process.version,
    launched: all.length, completed: all.filter(r => r.status === 'completed').length,
    rawSha256: createHash('sha256').update(raw).digest('hex'), gzipSha256: createHash('sha256').update(zipped).digest('hex'),
    sourceHashes: hashes(), scenarios: summary, contrasts, disagreement });
} else if (phase === 'replay') {
  const p = process.argv[3], scenario = Number(process.argv[4]), index = Number(process.argv[5]);
  const rows = gunzipSync(fs.readFileSync(path.join(out, `${p}-games.jsonl.gz`))).toString().trim().split('\n').map(JSON.parse);
  const old = rows.find(r => r.scenario === scenario && r.index === index);
  if (!old) throw new Error('Unknown replay');
  const s = scenarios[scenario];
  const again = await play({ phase:p, scenario, index, model:s.model, lineup:s.lineup });
  if (JSON.stringify(old) !== JSON.stringify(again)) throw new Error(`Replay mismatch ${old.digest}/${again.digest}`);
  console.log(`Exact replay OK: ${p}/${scenario}/${index}, ${again.actions} actions, ${again.digest}`);
} else throw new Error('Usage: node tools/unoq-research/run.mjs register|pilot|main|freeze|holdout|replay PHASE SCENARIO INDEX');
