/** A short moderation trace. Incoming payloads and private game state never enter it. */
const MOVES = new Set(['act', 'attack', 'defend', 'transfer', 'take', 'pass', 'play', 'draw',
  'move', 'undo', 'roll', 'end', 'fire', 'resign', 'abort', 'uno', 'catch']);
const POKER = new Set(['fold', 'check', 'call', 'bet', 'raise', 'allin']);
const AUTOMATIC = new Set(['FARMED', 'GAINED', 'SHORT']);
const MAX_ROUNDS = 128;
const MAX_ACTIONS = 160;
const roundKey = room => room.game === 'poker' ? room.code : `${room.code}#${room.match?.no ?? room.deal?.no ?? room.gameNo}`;

export class RatingReview {
  traces = new Map();

  constructor(store) { this.store = store; }

  before(room, msg, actor) {
    if (room.solo || room.tournament || !MOVES.has(msg.t) || !room.players.some(p => String(p.id) === String(actor))) return null;
    const action = msg.t === 'act' ? POKER.has(msg.action) && msg.action : msg.t;
    if (!action) return null;
    let detail;
    if (action === 'move' && ['chess', 'checkers'].includes(room.game)
        && typeof msg.from === 'string' && typeof msg.to === 'string'
        && /^[a-h][1-8]$/.test(msg.from) && /^[a-h][1-8]$/.test(msg.to)) detail = `${msg.from} → ${msg.to}`;
    if (action === 'fire' && Number.isInteger(msg.cell) && msg.cell >= 0 && msg.cell < 100) {
      detail = `${'АБВГДЕЖЗИК'[msg.cell % 10]}${Math.floor(msg.cell / 10) + 1}`;
    }
    if (['bet', 'raise'].includes(action) && Number.isSafeInteger(msg.amount) && msg.amount > 0) detail = String(msg.amount);
    return { key: roundKey(room), actor: String(actor), action, seq: room.seq, ...(detail ? { detail } : {}) };
  }

  accepted(room, entry, now) {
    if (!entry || room.seq === entry.seq) return;
    const { key, seq, ...event } = entry;
    const trace = this.traces.get(key) ?? [];
    if (trace.length >= MAX_ACTIONS) trace.shift();
    trace.push({ at: now, ...event });
    this.traces.delete(key);
    this.traces.set(key, trace);
    if (this.traces.size > MAX_ROUNDS) this.traces.delete(this.traces.keys().next().value);
  }

  finish(room, round, outcome, now) {
    const key = String(round.id);
    const places = round.places.filter(p => p?.id != null).map(p => String(p.id));
    const watched = new Set(this.store.ratingWatch());
    const participants = [...new Set([...places, ...(this.traces.get(key) ?? []).map(event => event.actor)])];
    const monitored = participants.some(id => watched.has(id));
    if (monitored || AUTOMATIC.has(outcome.skipped)) {
      this.store.saveRatingReview({
        key, at: now, game: room.game, code: room.code, places, participants, watched: monitored,
        reason: outcome.skipped ?? null, actions: this.traces.get(key) ?? [],
      });
    }
    this.traces.delete(key);
  }
}
