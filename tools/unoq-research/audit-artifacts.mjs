import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { play, seeds } from './simulator.mjs';
import { summarize } from './stats.mjs';

const root = new URL('../../', import.meta.url);
const data = new URL('docs/bot-rating-data/', root);
const read = name => JSON.parse(fs.readFileSync(new URL(name, data), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const registration = read('preregistered.json'), lock = read('holdout-lock.json');
for (const [file, expected] of Object.entries(registration.hashes)) assert.equal(hash(fs.readFileSync(new URL(file, root))), expected, file);
assert.equal(hash(fs.readFileSync(new URL('main-summary.json', data))), lock.mainSummarySha256);
assert.deepEqual(lock.hashes, registration.hashes);
const seen = new Set(), phases = [];
let replays = 0;
for (const phase of ['pilot', 'main', 'holdout']) {
  const summary = read(`${phase}-summary.json`), zipped = fs.readFileSync(new URL(`${phase}-games.jsonl.gz`, data)), raw = gunzipSync(zipped);
  assert.equal(hash(zipped), summary.gzipSha256); assert.equal(hash(raw), summary.rawSha256);
  const rows = raw.toString().trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, summary.launched);
  for (const row of rows) {
    assert.equal(row.phase, phase); assert.deepEqual(row.seed, seeds(phase, row.scenario, row.index));
    assert.ok(!seen.has(row.seed.deal), 'одна раздача не попала в две выборки'); seen.add(row.seed.deal);
  }
  for (const s of summary.scenarios) {
    const cells = rows.filter(r => r.scenario === s.scenario);
    assert.equal(cells.length, phase === 'holdout' ? lock.n : phase === 'pilot' ? registration.pilotPerScenario : registration.mainPerScenario);
    const stats = summarize(cells);
    for (const key of Object.keys(stats)) assert.deepEqual(stats[key], s[key], `${phase}/${s.scenario}/${key}`);
    for (const old of [cells[0], cells.at(-1)]) {
      const again = await play({ phase, scenario: old.scenario, index: old.index, model: s.model, lineup: s.lineup });
      assert.deepEqual(again, old); replays++;
    }
  }
  phases.push({ phase, launched: rows.length, completed: rows.filter(r => r.status === 'completed').length,
    views: rows.reduce((n, r) => n + r.views, 0), sha256: summary.rawSha256 });
}
const result = { sourceHashesVerified: Object.keys(registration.hashes).length, uniqueDealSeeds: seen.size, exactReplays: replays, phases };
fs.writeFileSync(fileURLToPath(new URL('integrity.json', data)), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
