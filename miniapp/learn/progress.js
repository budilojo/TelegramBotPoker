/**
 * Что прочитано. Храним на телефоне (localStorage), как у «Школы покера»: это удобство,
 * а не учёт; пропало — ничего страшного (решение 052). Серверу о чтении уроков знать нечего.
 */
const KEY = 'learn.read';
const QKEY = 'learn.quiz';

function load(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v;
  } catch {
    return null;
  }
}
function save(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* приватный режим */ }
}

export function readTopics() {
  const v = load(KEY);
  return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
}

export function markRead(topic) {
  const s = readTopics();
  if (s.has(topic)) return;
  s.add(topic);
  save(KEY, [...s]);
}

/** Лучший результат «проверьте себя» по теме: сколько верных из скольких. */
export function quizBest(topic) {
  const v = load(QKEY);
  return v && typeof v === 'object' ? v[topic] || null : null;
}
export function saveQuiz(topic, right, total) {
  const v = load(QKEY);
  const all = v && typeof v === 'object' ? v : {};
  const prev = all[topic];
  if (!prev || right > prev.right) all[topic] = { right, total };
  save(QKEY, all);
}
