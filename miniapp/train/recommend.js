/**
 * Рекомендуемые следующие задания для экрана «Тренировка» (агент Y). Чистая
 * функция без DOM — единый источник для экрана (V берёт её, а не считает своё).
 * Форма `progress` — как в `docs/poker-training.md` §4 (V).
 *
 * Порядок: (1) тема, которой пора повторить (срок пришёл); (2) следующий
 * непройденный уровень направления — там, где у игрока меньше всего пройдено;
 * (3) закрепить — пройденное направление с самой низкой точностью.
 * Если в банке нет упражнений под рекомендацию — её не предлагаем.
 */
import { TRACKS, LEVELS, topicById, trackById, isTrack } from './topics.js';

export function recommend(progress, { bank, limit = 3 } = {}) {
  const out = [];
  const seen = new Set();
  const has = (q) => !bank || bank.exercisesOf(q).length > 0;
  const push = (r) => {
    const key = `${r.kind}:${r.track}:${r.topic || ''}:${r.level}`;
    if (out.length >= limit || seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };
  const skillLevel = (skill) => progress?.skills?.[skill]?.level ?? 1;

  // 1. Повторить: сначала самые просроченные.
  const due = (progress?.due || []).filter((d) => topicById(d.topic) && isTrack(d.track))
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
  for (const d of due) {
    const level = skillLevel(topicById(d.topic).skill);
    if (has({ topic: d.topic, level }) || has({ topic: d.topic })) {
      push({ kind: 'review', track: d.track, topic: d.topic, level, why: `Повторить тему «${topicById(d.topic).title}»` });
    }
  }
  // 2. Следующий непройденный уровень: направления с меньшим числом пройденных — раньше.
  const rows = TRACKS.map((t, i) => {
    const passed = new Set(progress?.tracks?.[t.id]?.passed || []);
    let level = skillLevel(t.skill);
    while (level <= LEVELS && passed.has(level)) level++;
    return { t, i, level, passedN: passed.size };
  }).filter((r) => r.level <= LEVELS).sort((a, b) => a.passedN - b.passedN || a.i - b.i);
  for (const r of rows) {
    if (has({ track: r.t.id, level: r.level })) push({ kind: 'next', track: r.t.id, level: r.level, why: `Пройти уровень ${r.level}: ${r.t.title}` });
  }
  // 3. Закрепить.
  const done = TRACKS.map((t) => ({ t, p: progress?.tracks?.[t.id] }))
    .filter((x) => x.p?.passed?.length && typeof x.p.accuracy30 === 'number')
    .sort((a, b) => a.p.accuracy30 - b.p.accuracy30);
  for (const { t, p } of done) {
    const level = Math.max(...p.passed);
    if (has({ track: t.id, level })) push({ kind: 'consolidate', track: t.id, level, why: `Закрепить: ${t.title}, точность ${Math.round(p.accuracy30 * 100)}%` });
  }
  return out;
}

export { trackById };
