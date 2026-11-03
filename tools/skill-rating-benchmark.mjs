/** Synthetic outcomes for sensitivity checks. These are NOT played games or
 * human calibration. UNOQ played games live in tools/unoq-research instead. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { skillDeltas, expectedScore } from '../bot/skill-rating.js';

const output = fileURLToPath(new URL('../docs/bot-rating-data/skill-benchmark.json', import.meta.url));
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ x >>> 15, x | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const steps = [8, 16, 24, 32], seeds = [117, 503, 20261103, 43291, 97733];
const population = 80, training = 4000, validation = 1000;
const summary = [];
for (const n of [2, 4, 8]) for (const luck of [0, 0.5]) {
  const samples = [];
  for (const seed of seeds) {
    const random = rng(seed), normal = () => Array.from({ length: 12 }, () => random()).reduce((a, b) => a + b) - 6;
    const truth = Array.from({ length: population }, () => 1000 + normal() * 200);
    const ratings = steps.map(() => truth.map(() => 1000));
    const scores = steps.map(() => []), reference = [];
    for (let k = 0; k < training + validation; k++) {
      const seats = [];
      while (seats.length < n) { const id = Math.floor(random() * population); if (!seats.includes(id)) seats.push(id); }
      // Gumbel ranking implies the Elo pairwise probability; luck replaces the
      // entire ranking, preserving one observation per table rather than
      // pretending all pairwise outcomes at that table are independent.
      const randomOutcome = random() < luck;
      const order = seats.map(id => ({ id, value: (randomOutcome ? 0 : truth[id] * Math.LN10 / 400)
        - Math.log(-Math.log(Math.max(Number.EPSILON, random()))) })).sort((a, b) => b.value - a.value).map(p => p.id);
      for (let model = 0; model < steps.length; model++) {
        if (k < training) {
          for (const r of skillDeltas(order.map((id, i) => ({ id: String(id), rating: ratings[model][id], place: i + 1 })), steps[model])) ratings[model][Number(r.id)] = r.after;
        } else {
          let brier = 0, pairs = 0;
          for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
            const p = expectedScore(ratings[model][order[i]], ratings[model][order[j]]);
            brier += (1 - p) ** 2; pairs++;
          }
          scores[model].push(brier / pairs);
        }
      }
      if (k >= training) reference.push(0.25);
    }
    samples.push({ seed, models: steps.map((step, model) => ({ step, brier: mean(scores[model]),
      poolDrift: ratings[model].reduce((s, r) => s + r, 0) - population * 1000 })), referenceBrier: mean(reference) });
  }
  summary.push({ seats: n, randomRankingProbability: luck, samples, models: steps.map((step, i) => ({ step,
    meanBrier: mean(samples.map(s => s.models[i].brier)),
    minBrier: Math.min(...samples.map(s => s.models[i].brier)), maxBrier: Math.max(...samples.map(s => s.models[i].brier)),
    maxAbsPoolDrift: Math.max(...samples.map(s => Math.abs(s.models[i].poolDrift))) })) });
}

// Known residual attack: Elo alone cannot authenticate a new opponent.
let farmer = 1000;
for (let i = 0; i < 200; i++) farmer = skillDeltas([{ id: 'farmer', rating: farmer, place: 1 }, { id: `new:${i}`, rating: 1000, place: 2 }])[0].after;
const result = {
  kind: 'synthetic rating benchmark; not gameplay, not humans',
  assumption: '80 latent strengths; Gumbel ranking, optionally replaced with random ranking; random seating; no draws or collusion in the main matrix',
  trainingPerSeed: training, validationPerSeed: validation, seeds, steps, population,
  generatedOutcomes: summary.length * seeds.length * (training + validation),
  ratingReplays: summary.length * seeds.length * (training + validation) * steps.length,
  baselineBrier: 0.25, summary,
  residualAttack: { description: '200 arranged wins over fresh accounts seeded at 1000; no admission protections', initial: 1000, after: farmer },
  limitations: 'K is a sensitivity parameter, not measured luck of the seven games. Pairwise results within a table are dependent. No claim of human calibration or resistance to collusion.'
};
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
for (const row of summary) console.log(`${row.seats} seats, luck=${row.randomRankingProbability}: ${row.models.map(m => `K${m.step} Brier=${m.meanBrier.toFixed(4)}`).join('; ')}`);
console.log(`Synthetic outcomes: ${result.generatedOutcomes}; replays: ${result.ratingReplays}; fresh-account attack: ${farmer.toFixed(2)}`);
if (summary.some(r => r.models.some(m => m.maxAbsPoolDrift > 1e-6))) throw new Error('Rating pool is not conserved');
