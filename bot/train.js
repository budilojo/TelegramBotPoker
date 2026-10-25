/**
 * «Тренировка» (покер): личный прогресс игрока — сервер (docs/poker-training.md).
 *
 * Всё про самого игрока: кто он — только из подписанного initData (`user`), поля
 * «чей» в теле сообщения нет и быть не может (если страница его всё же шлёт —
 * молча игнорируется). Прогресс личный: не попадает в вид стола, чат, рейтинг,
 * карточку группы. Время — часы приложения (`app.clock.now()`), не страницы.
 *
 * Сообщения страницы `{t:'train', op}`:
 *   get                                  → { t:'train', progress }
 *   result {ex, track, topic, level, score, ms, mistakes?, seed?}
 *                                        → { t:'train', progress, result }
 *   level  {skill, level}                // ручная смена сложности навыка
 *   reset                                // «Сбросить мой прогресс»
 *   placement | history | decisions-clear  → агент Y (bot/placement.js, handleY)
 */
import { TRACKS, SKILLS, LEVELS, LEVEL_NAMES, isTrack, isTopic, isSkill } from '../miniapp/train/topics.js';
import { DAY, LADDER, afterMistake, afterCorrect, isDue } from '../miniapp/train/srs.js';
import { nextRating, levelPassed, suggestLevel, isGood, isMastered } from '../miniapp/train/skills.js';

const skillOfTrack = (id) => TRACKS.find((t) => t.id === id)?.skill || null;
/** Строка базы ↔ строка повторения (miniapp/train/srs.js): step = mastery, «закреплена» = dueAt пуст. */
const toRow = (t) => (t ? { step: Math.min(t.mastery, LADDER.length), dueAt: t.dueAt ?? Infinity, lapses: t.lapses, done: t.dueAt == null } : null);
const fromRow = (topic, r) => ({
  topic, mastery: r.done ? LADDER.length : r.step, intervalDays: LADDER[Math.min(r.step, LADDER.length - 1)],
  dueAt: r.done ? null : r.dueAt, lapses: r.lapses,
});
const isWeak = (t) => t.dueAt != null;
const DAY_MS = DAY;

/** Не больше стольких результатов на игрока (старые стираются). */
export const KEEP_RESULTS = 500;
/** Частота: результатов в минуту и вообще запросов в минуту. */
export const RESULTS_PER_MIN = 40;
export const OPS_PER_MIN = 90;
const MIN_MS = 60_000;
const ACCURACY_DAYS = 30;
const MISTAKES_SHOWN = 10;

export const TRAIN_ERRORS = {
  TRAIN_BAD_OP: 'Такого действия в тренировке нет.',
  TRAIN_BAD_FIELD: 'В запросе лишние или неверные данные — обновите приложение.',
  TRAIN_BAD_TRACK: 'Такого направления в тренировке нет.',
  TRAIN_BAD_TOPIC: 'Такой темы в тренировке нет.',
  TRAIN_BAD_SKILL: 'Такого навыка нет.',
  TRAIN_BAD_LEVEL: 'Уровень — число от 1 до 5.',
  TRAIN_BAD_SCORE: 'Оценка — число от 0 до 1.',
  TRAIN_BAD_EX: 'Задание названо неверно.',
  TRAIN_FAST: 'Слишком много ответов подряд — немного подождите.',
  TRAIN_DOWN: 'Эту часть тренировки сейчас нельзя открыть.',
};

/** Поля, которыми страница «называет себя» — они не принимаются, но и не ломают запрос. */
const IDENTITY = new Set(['id', 'uid', 'userId', 'user_id', 'user', 'from', 'chat', 'chatId']);
const FIELDS = {
  get: ['t', 'op'],
  result: ['t', 'op', 'ex', 'track', 'topic', 'level', 'score', 'ms', 'mistakes', 'seed'],
  level: ['t', 'op', 'skill', 'level'],
  reset: ['t', 'op'],
};
const ID_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const CODE_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/i;

const intIn = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;

// Часть Y (диагностика уровня, журнал решений) — отдельный файл; пока его нет — операций нет.
let Y = null;
try {
  Y = await import('./placement.js');
} catch {
  Y = null;
}

export class Training {
  constructor(app) {
    this.app = app;
    /** userId -> { all: [время запросов], results: [время результатов] } */
    this.calls = new Map();
  }

  get store() {
    return this.app.store;
  }

  /** Принять сообщение. Вернёт то, что отправить странице: { t:'train', ... }. */
  handle(user, msg) {
    const uid = String(user.id);
    const op = msg?.op;
    if (typeof op !== 'string') return fail('TRAIN_BAD_OP');
    const now = this.app.clock.now();
    if (!this.allow(uid, op, now)) return fail('TRAIN_FAST');

    if (['placement', 'history', 'decisions-clear'].includes(op)) {
      if (!Y?.handleY) return fail('TRAIN_BAD_OP');
      const r = Y.handleY(msg, {
        userId: uid, store: this.store, now,
        saveSkills: (id, skills, via) => this.savePlacement(id, skills, via, now),
      });
      if (r?.error) return { t: 'train', error: { code: r.error, text: r.text || TRAIN_ERRORS[r.error] || TRAIN_ERRORS.TRAIN_BAD_OP } };
      return { t: 'train', ...(r || {}), progress: this.progress(uid, now) };
    }
    if (!FIELDS[op]) return fail('TRAIN_BAD_OP');
    for (const k of Object.keys(msg)) if (!FIELDS[op].includes(k) && !IDENTITY.has(k)) return fail('TRAIN_BAD_FIELD');

    if (op === 'get') return { t: 'train', progress: this.progress(uid, now) };
    if (op === 'reset') {
      this.store.trainReset(uid);
      this.store.deleteDecisions?.(uid);
      return { t: 'train', reset: true, progress: this.progress(uid, now) };
    }
    if (op === 'level') {
      if (!isSkill(msg.skill)) return fail('TRAIN_BAD_SKILL');
      if (!intIn(msg.level, 1, LEVELS)) return fail('TRAIN_BAD_LEVEL');
      const cur = this.skillRow(uid, msg.skill);
      this.store.trainSetSkill(uid, { ...cur, level: msg.level }, now);
      return { t: 'train', progress: this.progress(uid, now) };
    }
    return this.result(uid, msg, now);
  }

  /** Частота: по часам приложения, только в памяти. */
  allow(uid, op, now) {
    const c = this.calls.get(uid) || { all: [], results: [] };
    c.all = c.all.filter((t) => now - t < MIN_MS);
    c.results = c.results.filter((t) => now - t < MIN_MS);
    this.calls.set(uid, c);
    if (c.all.length >= OPS_PER_MIN) return false;
    if (op === 'result' && c.results.length >= RESULTS_PER_MIN) return false;
    c.all.push(now);
    if (op === 'result') c.results.push(now);
    return true;
  }

  skillRow(uid, skill, loaded = null) {
    const row = (loaded || this.store.trainLoad(uid)).skills.find((s) => s.skill === skill);
    return row ? { skill, level: row.level, rating: row.rating, n: row.n, updatedAt: row.updatedAt } : { skill, level: 1, rating: 0, n: 0, updatedAt: null };
  }

  /** Стартовые уровни навыков (от Y: «с нуля», диагностика, история). Рейтинг уже набранный не трогаем. */
  savePlacement(uid, skills, via, now = this.app.clock.now()) {
    if (!['zero', 'quiz', 'history'].includes(via)) return { error: 'TRAIN_BAD_FIELD', text: TRAIN_ERRORS.TRAIN_BAD_FIELD };
    if (!skills || typeof skills !== 'object') return { error: 'TRAIN_BAD_SKILL', text: TRAIN_ERRORS.TRAIN_BAD_SKILL };
    for (const [k, v] of Object.entries(skills)) {
      if (!isSkill(k)) return { error: 'TRAIN_BAD_SKILL', text: TRAIN_ERRORS.TRAIN_BAD_SKILL };
      if (!intIn(v, 1, LEVELS)) return { error: 'TRAIN_BAD_LEVEL', text: TRAIN_ERRORS.TRAIN_BAD_LEVEL };
    }
    const loaded = this.store.trainLoad(uid);
    for (const [k, v] of Object.entries(skills)) this.store.trainSetSkill(uid, { ...this.skillRow(uid, k, loaded), level: v }, now);
    return this.progress(uid, now);
  }

  result(uid, msg, now) {
    if (typeof msg.ex !== 'string' || !ID_RE.test(msg.ex)) return fail('TRAIN_BAD_EX');
    if (typeof msg.track !== 'string' || !isTrack(msg.track)) return fail('TRAIN_BAD_TRACK');
    if (typeof msg.topic !== 'string' || !isTopic(msg.topic)) return fail('TRAIN_BAD_TOPIC');
    if (!intIn(msg.level, 1, LEVELS)) return fail('TRAIN_BAD_LEVEL');
    if (typeof msg.score !== 'number' || !Number.isFinite(msg.score) || msg.score < 0 || msg.score > 1) return fail('TRAIN_BAD_SCORE');
    if (!intIn(msg.ms, 0, 3_600_000)) return fail('TRAIN_BAD_FIELD');
    if (msg.seed != null && !intIn(msg.seed, 0, 4_294_967_295)) return fail('TRAIN_BAD_FIELD');
    const codes = msg.mistakes ?? [];
    if (!Array.isArray(codes) || codes.length > 8 || codes.some((c) => typeof c !== 'string' || !CODE_RE.test(c))) return fail('TRAIN_BAD_FIELD');

    const { store } = this;
    const skill = skillOfTrack(msg.track);
    const before = store.trainLoad(uid);
    const row = this.skillRow(uid, skill, before);
    const score = Math.round(msg.score * 1000) / 1000;
    store.trainAddResult(uid, { ex: msg.ex, track: msg.track, topic: msg.topic, level: msg.level, score, ms: msg.ms, at: now }, KEEP_RESULTS);
    store.trainSetSkill(uid, { skill, level: row.level, rating: nextRating(row.rating, row.n, score), n: row.n + 1 }, row.updatedAt ?? 0);
    // updatedAt — момент смены УРОВНЯ (по нему считаем «серию»): обычный ответ его не двигает.
    // Первый ответ без записи уровня: updatedAt = 0, серия считается с начала.

    // Повторение: тема задания; ошибки — с кодами.
    const ok = isGood(score);
    const cur = toRow(before.topics.find((t) => t.topic === msg.topic));
    const next = ok ? afterCorrect(cur, now) : afterMistake(cur, now);
    if (next && next !== cur) store.trainSetTopic(uid, fromRow(msg.topic, next), now);
    for (const code of new Set(codes)) store.trainAddMistake(uid, msg.topic, code, now);

    // Пройден ли уровень направления (запоминаем навсегда: результаты стираются по ротации).
    const after = store.trainLoad(uid);
    let passedLevel = null;
    const same = after.results.filter((r) => r.track === msg.track && r.level === msg.level);
    const already = after.passed.some((p) => p.track === msg.track && p.level === msg.level);
    if (!already && levelPassed(same.map((r) => r.score).reverse())) {
      store.trainSetPass(uid, msg.track, msg.level, now);
      passedLevel = { track: msg.track, level: msg.level };
    }
    return { t: 'train', result: { ok, score, passedLevel }, progress: this.progress(uid, now) };
  }

  /** Что видит игрок на экране «Мой прогресс». Только его данные. */
  progress(uid, now = this.app.clock.now()) {
    const d = this.store.trainLoad(uid);
    const bySkill = (id) => d.skills.find((s) => s.skill === id);
    const skills = SKILLS.map((s) => {
      const row = bySkill(s.id);
      const level = row?.level ?? 1;
      const mine = d.results.filter((r) => skillOfTrack(r.track) === s.id);
      return {
        id: s.id, title: s.title, level, levelName: LEVEL_NAMES[level - 1],
        rating: Math.round(row?.rating ?? 0), n: row?.n ?? 0, placed: !!row,
        mastered: isMastered(row),
        suggest: row ? suggestLevel(level, mine.filter((r) => r.at > (row.updatedAt ?? 0)).map((r) => r.score).reverse()) : null,
      };
    });
    const since = now - ACCURACY_DAYS * DAY_MS;
    const tracks = TRACKS.map((t) => {
      const mine = d.results.filter((r) => r.track === t.id);
      const recent = mine.filter((r) => r.at >= since);
      const passed = d.passed.filter((p) => p.track === t.id).map((p) => p.level).sort((a, b) => a - b);
      return {
        id: t.id, level: skills.find((s) => s.id === t.skill).level, passed, passedCount: passed.length,
        total: mine.length, recent: recent.length,
        accuracy: recent.length ? Math.round((recent.filter((r) => isGood(r.score)).length / recent.length) * 100) : null,
        last: mine[0]?.at ?? null,
      };
    });
    const weak = d.topics.filter(isWeak).sort((a, b) => a.dueAt - b.dueAt)
      .map((t) => ({ topic: t.topic, dueAt: t.dueAt, due: isDue(toRow(t), now), lapses: t.lapses, intervalDays: t.intervalDays }));
    const mastered = d.topics.filter((t) => !isWeak(t) && t.mastery > 0).map((t) => t.topic);
    return {
      now,
      started: d.results.length > 0 || d.skills.length > 0,
      total: d.results.length,
      skills, tracks, weak, due: weak.filter((w) => w.due).map((w) => w.topic), masteredTopics: mastered,
      mistakes: d.mistakes.slice(0, MISTAKES_SHOWN),
      levelNames: LEVEL_NAMES,
    };
  }
}

function fail(code) {
  return { t: 'train', error: { code, text: TRAIN_ERRORS[code] } };
}
