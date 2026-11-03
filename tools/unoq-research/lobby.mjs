// Functional prototype of the proposed SERVER lifecycle. Not connected to App/Hub/UI.
import { createHmac } from 'node:crypto';

// Prototype commitment: same human/day => same ordered styles, independent of
// table ID, display names, difficulty and requested number of bots. Server key only.
// A real service needs durable match tickets; this prototype fixes a whole day.
export function assignmentFor(serverKey, humanId, day, count) {
  if (!Number.isInteger(count) || count < 0 || count > 3) throw new Error('count');
  const digest = createHmac('sha256', serverKey).update(JSON.stringify([String(humanId), day])).digest();
  const styles = ['A', 'B', 'C'];
  for (let i = 2; i > 0; i--) { const j = digest[i] % (i + 1); [styles[i], styles[j]] = [styles[j], styles[i]]; }
  return styles.slice(0, count).map((style, i) => Object.freeze({ id: `computer:${i}`, computer: true, style }));
}
export class Lobby {
  constructor({ now = () => 0, assign, start, seats = 4 }) {
    this.now = now; this.assign = assign; this.start = start; this.seats = seats;
    this.people = new Map(); this.deadline = null; this.level = 1; this.status = 'waiting';
    this.assignment = null;
  }
  join(id) {
    if (this.status !== 'waiting') return { error: 'STARTED' };
    if (this.deadline !== null && this.now() >= this.deadline) { this.tick(); return { error: 'STARTED' }; }
    if (!this.people.has(id) && this.people.size >= this.seats) return { error: 'FULL' };
    this.people.set(id, this.people.get(id) || false);
    if (this.deadline === null) this.deadline = this.now() + 30_000;
    return { ok: true };
  }
  difficulty(level) {
    if (this.status !== 'waiting' || (this.deadline !== null && this.now() >= this.deadline)) {
      this.tick(); return { error: 'STARTED' };
    }
    if (![0, 1].includes(level)) return { error: 'LEVEL' };
    this.level = level; return { ok: true };
  }
  ready(id) {
    if (this.status !== 'waiting' || !this.people.has(id)) return { error: 'NOT_WAITING' };
    this.people.set(id, true);
    if ([...this.people.values()].every(Boolean)) this.launch();
    return { ok: true };
  }
  skip(id) {
    // Each present person must consent to skip; otherwise wait until deadline.
    return this.ready(id);
  }
  tick() {
    if (this.status === 'waiting' && this.deadline !== null && this.now() >= this.deadline) this.launch();
  }
  launch() {
    if (this.status !== 'waiting' || !this.people.size) return;
    this.status = 'started'; // lock BEFORE callbacks, including reentrant start
    this.assignment = Object.freeze(this.assign(this.seats - this.people.size, this.level));
    this.snapshot = Object.freeze({ people: Object.freeze([...this.people.keys()]), bots: this.assignment,
      level: this.level, eligibleHypothesis: this.level === 1 });
    this.start(this.snapshot);
  }
}
