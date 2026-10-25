/**
 * Редактор матрицы 13×13 — ЧИСТАЯ модель без DOM (виджет range-grid.js только
 * рисует). Выбор рук, рисование протяжкой, строка/столбец целиком, готовые
 * наборы, отмена и повтор (до 50 шагов). Тесты гоняют её без браузера.
 *
 * Состояние — Map код → частота (0…1). Режим `steps: 2` — рука «в диапазоне»
 * или нет; `steps: 3` — ещё «иногда» (0,5): тап крутит 0 → 1 → 0,5 → 0.
 */
import { ALL_HANDS, handInfo, handAt, comboCount, rangePercent, formatRange, RANK_CHARS } from './hands.js';
import { topShare } from './data.js';

export const HISTORY_LIMIT = 50;

/** Готовые наборы: id → { title, make() → Set }. «Топ N %» — `top:N`. */
export const PRESETS = {
  pairs: { title: 'Пары', make: () => new Set(ALL_HANDS.filter((c) => handInfo(c).kind === 'pair')) },
  suited: { title: 'Одномастные', make: () => new Set(ALL_HANDS.filter((c) => handInfo(c).kind === 'suited')) },
  aces: { title: 'Туз-X', make: () => new Set(ALL_HANDS.filter((c) => c[0] === 'A' && c[1] !== 'A')) },
  broadway: { title: 'Бродвей', make: () => new Set(ALL_HANDS.filter((c) => handInfo(c).lo <= 4)) },
};

export function presetSet(id) {
  const m = /^top:(\d+(?:\.\d+)?)$/.exec(id);
  if (m) return topShare(Number(m[1]));
  if (!PRESETS[id]) throw new Error(`Неизвестный набор «${id}»`);
  return PRESETS[id].make();
}

/** Все руки ряда / столбца (0 = A…12 = 2) в виде кодов. */
export const rowCodes = (r) => Array.from({ length: 13 }, (_, c) => handAt(r, c));
export const colCodes = (c) => Array.from({ length: 13 }, (_, r) => handAt(r, c));
/** Подпись ряда/столбца. */
export const lineLabel = (i) => RANK_CHARS[i];

const cycle = (steps, f) => (steps === 3 ? (f === 0 ? 1 : f === 1 ? 0.5 : 0) : f > 0 ? 0 : 1);

export function createEditor({ steps = 2, initial = null, onChange = null } = {}) {
  let cur = new Map();
  if (initial) for (const [k, v] of initial instanceof Map ? initial : [...initial].map((c) => [c, 1])) if (v > 0) cur.set(k, v);
  let undoStack = [];
  let redoStack = [];
  let stroke = null; // { value, before }
  const listeners = new Set(onChange ? [onChange] : []);

  const clone = (m) => new Map(m);
  const emit = (codes) => { if (codes.length) for (const l of listeners) l(codes); };
  const diffKeys = (a, b) => ALL_HANDS.filter((c) => (a.get(c) || 0) !== (b.get(c) || 0));

  function commit(before) {
    const changed = diffKeys(before, cur);
    if (!changed.length) return false;
    undoStack.push(before);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    emit(changed);
    return true;
  }
  function put(code, f) { if (f > 0) cur.set(code, f); else cur.delete(code); }

  const api = {
    steps,
    get: (code) => cur.get(code) || 0,
    /** Копия состояния: Map код → частота. */
    snapshot: () => clone(cur),
    /** Массив кодов (steps 2) или объект { код: частота } (steps 3) — формат ответа упражнения. */
    answer: () => (steps === 3 ? Object.fromEntries(cur) : [...cur.keys()]),
    count: () => comboCount(cur),
    percent: () => rangePercent(cur),
    text: () => formatRange(cur),
    size: () => cur.size,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** Тап по клетке. */
    tap(code) {
      const before = clone(cur);
      put(code, cycle(steps, api.get(code)));
      return commit(before);
    },
    /** Начало протяжки: значение, которым красим, — противоположное первой клетке. */
    strokeStart(code) {
      stroke = { before: clone(cur), value: api.get(code) > 0 ? 0 : 1 };
      put(code, stroke.value);
      emit([code]);
    },
    /** Следующая клетка протяжки. */
    strokeMove(code) {
      if (!stroke) return;
      if ((cur.get(code) || 0) === stroke.value) return;
      put(code, stroke.value);
      emit([code]);
    },
    /** Конец протяжки: одна запись в истории на весь мазок. */
    strokeEnd() {
      if (!stroke) return false;
      const { before } = stroke;
      stroke = null;
      const changed = diffKeys(before, cur);
      if (!changed.length) return false;
      undoStack.push(before);
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      redoStack = [];
      return true;
    },
    /** Строка/столбец целиком: если все уже выбраны — снять, иначе выбрать. */
    toggleLine(codes) {
      const before = clone(cur);
      const all = codes.every((c) => api.get(c) > 0);
      for (const c of codes) put(c, all ? 0 : 1);
      return commit(before);
    },
    /** Добавить набор к выбранному (или `replace`). */
    applyPreset(id, { replace = false } = {}) {
      const before = clone(cur);
      if (replace) cur = new Map();
      for (const c of presetSet(id)) put(c, 1);
      return commit(before);
    },
    /** Заменить состояние целиком (например, эталон для режима «показать»). */
    load(setLike) {
      const before = clone(cur);
      cur = new Map(setLike instanceof Map ? [...setLike].filter(([, v]) => v > 0) : [...setLike].map((c) => [c, 1]));
      return commit(before);
    },
    clear() {
      const before = clone(cur);
      cur = new Map();
      return commit(before);
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    undo() {
      if (!undoStack.length) return false;
      const prev = undoStack.pop();
      redoStack.push(clone(cur));
      const changed = diffKeys(cur, prev);
      cur = prev;
      emit(changed);
      return true;
    },
    redo() {
      if (!redoStack.length) return false;
      const next = redoStack.pop();
      undoStack.push(clone(cur));
      const changed = diffKeys(cur, next);
      cur = next;
      emit(changed);
      return true;
    },
  };
  return api;
}
