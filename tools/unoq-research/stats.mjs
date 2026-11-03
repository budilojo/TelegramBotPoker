export const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
export function metrics(xs) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b), n = xs.length, m = mean(xs);
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)) : 0;
  const q = p => sorted[Math.floor((n - 1) * p)];
  return { n, mean: m, sd, median: q(0.5), p25: q(0.25), p75: q(0.75), p95: q(0.95),
    min: sorted[0], max: sorted.at(-1), ci95: [m - 1.96 * sd / Math.sqrt(n), m + 1.96 * sd / Math.sqrt(n)] };
}
export function wilson(w, n, z = 1.96) {
  if (!n) return null;
  const p = w / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / d;
  return [c - h, c + h];
}
export function summarize(rows) {
  const done = rows.filter(r => r.status === 'completed'), wins = done.filter(r => r.place === 1).length;
  const reasons = {};
  for (const r of rows.filter(r => r.status !== 'completed')) reasons[r.error] = (reasons[r.error] || 0) + 1;
  return { scenario: rows[0].scenario, model: rows[0].types[rows[0].focalSeat],
    launched: rows.length, completed: done.length, wins, places: [1, 2, 3, 4].map(p => done.filter(r => r.place === p).length),
    draws: done.filter(r => r.draw).length, winRate: wins / rows.length, winCi95: wilson(wins, rows.length),
    // Unfinished are counted as nonwins above. Also report conservative upper bound.
    winIncludingMissingBounds: [wins / rows.length, (wins + rows.length - done.length) / rows.length],
    statuses: Object.fromEntries(['completed','limit','aborted','error'].map(s => [s, rows.filter(r => r.status === s).length])), reasons,
    seats: [0,1,2,3].map(s => ({ seat: s, n: rows.filter(r => r.focalSeat === s).length,
      wins: rows.filter(r => r.focalSeat === s && r.place === 1).length })),
    actions: metrics(done.map(r => r.actions)), seconds: metrics(done.map(r => r.simulatedSeconds)),
    rating: Object.fromEntries(['ratingActual','nominal','fromZero','centered','pairwise24'].map(k => [k, metrics(rows.map(r => r[k]))])),
    views: rows.reduce((s, r) => s + r.views, 0),
    pointsPerHourNominal: 3600 * mean(rows.map(r => r.nominal)) / mean(rows.map(r => r.simulatedSeconds)) };
}
