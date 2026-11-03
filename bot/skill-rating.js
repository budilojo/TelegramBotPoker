/**
 * Экспериментальная оценка силы. Только теневой сбор: не источник публичных
 * очков и не разрешение рейтинговой партии. Старый рейтинг не изменяется.
 * Правила допуска, подбор людей и калибровка ботов — отдельные задачи.
 */
export const INITIAL = 1000;
export const STEP = 32;
export const SYSTEM = 'pairwise-elo32-shadow-v1';

export function expectedScore(rating, opponent) {
  if (![rating, opponent].every(Number.isFinite)) throw new Error('Рейтинг должен быть конечным числом');
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

/** Все оценки — ДО партии. Один общий K, парные изменения противоположны.
 * Ничья — равное place. Места не обязаны быть последовательными при ничьей.
 * Деление на n−1 ограничивает влияние одной партии независимо от размера стола.
 */
export function skillDeltas(players, step = STEP) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 8) throw new Error('Нужно от 2 до 8 участников');
  if (!Number.isFinite(step) || step <= 0 || step > 64) throw new Error('Неверный шаг рейтинга');
  const seen = new Set();
  const rows = players.map(p => {
    if (p.id == null || String(p.id) === '' || seen.has(String(p.id))) throw new Error('Повторный или пустой участник');
    if (!Number.isFinite(p.rating) || !Number.isInteger(p.place) || p.place < 1) throw new Error('Неверный результат участника');
    seen.add(String(p.id));
    return { id: String(p.id), before: p.rating, place: p.place, delta: 0, expected: 0, score: 0 };
  });
  const divisor = rows.length - 1;
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j];
    const e = expectedScore(a.before, b.before);
    const s = a.place < b.place ? 1 : a.place === b.place ? 0.5 : 0;
    const delta = step * (s - e) / divisor;
    a.delta += delta; b.delta -= delta;
    a.expected += e / divisor; b.expected += (1 - e) / divisor;
    a.score += s / divisor; b.score += (1 - s) / divisor;
  }
  // Без округления и ограничения снизу: иначе сумма начнёт расти сама.
  return rows.map(r => ({ ...r, after: r.before + r.delta }));
}

/** Borrowed database: its owner opens/closes it. Additive tables, schema meta
 * and legacy rating tables are untouched. Every whole match is one transaction.
 */
export class SkillShadow {
  constructor(db, games) {
    this.db = db;
    this.games = new Set(games);
    if (!this.games.size) throw new Error('Не задан реестр игр');
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_shadow_players (
        system TEXT NOT NULL, game TEXT NOT NULL, user_id TEXT NOT NULL,
        rating REAL NOT NULL, played INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(system, game, user_id)
      );
      CREATE TABLE IF NOT EXISTS skill_shadow_rounds (
        system TEXT NOT NULL, game TEXT NOT NULL, round TEXT NOT NULL,
        at INTEGER NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(system, game, round)
      );
    `);
    this.getPlayer = db.prepare('SELECT rating, played FROM skill_shadow_players WHERE system = ? AND game = ? AND user_id = ?');
    this.getRound = db.prepare('SELECT input, result FROM skill_shadow_rounds WHERE system = ? AND game = ? AND round = ?');
    this.putPlayer = db.prepare(`INSERT INTO skill_shadow_players VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(system, game, user_id) DO UPDATE SET rating = excluded.rating,
      played = played + 1, updated_at = excluded.updated_at`);
    this.putRound = db.prepare('INSERT INTO skill_shadow_rounds VALUES (?, ?, ?, ?, ?, ?)');
  }

  player(game, id) {
    const row = this.getPlayer.get(SYSTEM, game, String(id));
    return row ? { rating: row.rating, played: row.played } : { rating: INITIAL, played: 0 };
  }

  apply({ game, round, places, ranks = null, draw = false, short = false, aborted = false, hasBots = false, at }) {
    if (!this.games.has(game)) throw new Error('Неизвестная игра теневого рейтинга');
    if (typeof round !== 'string' || !round || !Number.isSafeInteger(at)) throw new Error('Неверный идентификатор или время партии');
    if (!Array.isArray(places)) throw new Error('Нет результатов партии');
    // No names, cards, cosmetic data or client-provided scores in this ledger.
    const ids = places.map(p => {
      if (p?.id == null || String(p.id) === '') throw new Error('Пустой участник');
      return String(p.id);
    });
    if (new Set(ids).size !== ids.length || ids.length > 8) throw new Error('Неверный состав партии');
    if (ranks !== null && (!Array.isArray(ranks) || ranks.length !== ids.length
      || ranks.some(p => !Number.isInteger(p) || p < 1))) throw new Error('Неверные места участников');
    const positions = ranks ?? ids.map((_, i) => draw ? 1 : i + 1);
    const participants = ids.map((id, i) => ({ id, place: positions[i] }));
    const input = JSON.stringify({ participants: [...participants].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      ranksKnown: ranks !== null, draw: !!draw, short: !!short, aborted: !!aborted, hasBots: !!hasBots });
    this.db.exec('SAVEPOINT skill_shadow_round');
    try {
      const old = this.getRound.get(SYSTEM, game, round);
      if (old) {
        if (old.input !== input) throw new Error('Результат уже записанной партии изменён');
        this.db.exec('RELEASE skill_shadow_round');
        return { ...JSON.parse(old.result), replayed: true };
      }
      const skipped = hasBots ? 'BOTS_UNCALIBRATED' : aborted ? 'ABORTED' : short ? 'SHORT' : ids.length < 2 ? 'TOO_FEW'
        : draw && ids.length > 2 && ranks === null ? 'DRAW_PLACES_UNKNOWN' : null;
      const rows = skipped ? [] : skillDeltas(participants.map(p => ({ ...p, rating: this.player(game, p.id).rating })));
      const result = skipped ? { skipped, rows } : { ok: true, rows };
      for (const r of rows) this.putPlayer.run(SYSTEM, game, r.id, r.after, at);
      this.putRound.run(SYSTEM, game, round, at, input, JSON.stringify(result));
      this.db.exec('RELEASE skill_shadow_round');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO skill_shadow_round');
      this.db.exec('RELEASE skill_shadow_round');
      throw error;
    }
  }
}
