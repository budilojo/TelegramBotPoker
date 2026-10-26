/**
 * «Вид» — что из косметики включено на ЭТОМ телефоне (режим примерки).
 *
 *   getLook()          { cardback, felt, frame, effect, title, reactions:[…] } — id вещей или null
 *   setLook(patch)     {cardback:'nc-back-1'} · {bundle:'nc-bundle'} · {felt:null}; лишнее и чужое игнорируется
 *   clearLook()        снять всё
 *   onLook(fn)         подписка на изменения; возвращает «отписаться»
 *   previewFor(item,ms) применить вещь на ms (10 с) и вернуть как было; возвращает «отменить»
 *   lookClass()        строка классов для CSS (служебное)
 *
 * Хранится в localStorage (с try/catch: без него живёт до перезагрузки) и НЕ уходит на
 * сервер и к другим игрокам — это только вид у вас. Вещь принимается, только если она есть
 * в каталоге и подходит к ячейке (рубашка — в cardback и т. д.).
 */
import { itemById } from './catalog.js';

const KEY = 'cosmetics-look';
/** ячейка вида → вид вещи в каталоге */
const SLOTS = { cardback: 'cardback', felt: 'felt', frame: 'frame', effect: 'effect', title: 'title' };
const EMPTY = () => ({ cardback: null, felt: null, frame: null, effect: null, title: null, reactions: [] });

let cur = null;
let memory = null; // запас, если localStorage недоступен
const subs = new Set();

function clean(raw) {
  const out = EMPTY();
  if (!raw || typeof raw !== 'object') return out;
  for (const [slot, kind] of Object.entries(SLOTS)) {
    const it = itemById(raw[slot]);
    if (it && it.kind === kind) out[slot] = it.id;
  }
  if (Array.isArray(raw.reactions)) {
    out.reactions = [...new Set(raw.reactions.filter((id) => itemById(id)?.kind === 'reaction'))].slice(0, 3);
  }
  return out;
}

function load() {
  if (cur) return cur;
  try {
    const t = localStorage.getItem(KEY);
    cur = clean(t ? JSON.parse(t) : memory);
  } catch {
    cur = clean(memory);
  }
  return cur;
}

function save() {
  memory = cur;
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* приватный режим: до перезагрузки */ }
}

function emit() {
  for (const fn of [...subs]) { try { fn(getLook()); } catch { /* подписчик не должен ломать остальных */ } }
}

export const getLook = () => {
  const l = load();
  return { ...l, reactions: [...l.reactions] };
};

/** Положить вещь в свою ячейку (набор раскладывается по ячейкам). Возвращает, изменилось ли что-то. */
function put(next, it) {
  if (!it) return false;
  if (it.kind === 'bundle') {
    let ch = false;
    const seen = new Set();
    for (const id of it.items || []) {
      const x = itemById(id);
      if (!x || x.kind === 'bundle') continue;
      if (x.kind === 'reaction') { if (!next.reactions.includes(id)) { next.reactions.push(id); ch = true; } continue; }
      if (seen.has(x.kind)) continue; // для набора берётся первая рубашка и первая рамка
      seen.add(x.kind);
      if (next[x.kind] !== id) { next[x.kind] = id; ch = true; }
    }
    return ch;
  }
  if (it.kind === 'reaction') {
    if (next.reactions.includes(it.id)) return false;
    next.reactions = [...next.reactions, it.id].slice(-3);
    return true;
  }
  if (!(it.kind in SLOTS) || next[it.kind] === it.id) return false;
  next[it.kind] = it.id;
  return true;
}

export function setLook(patch) {
  if (!patch || typeof patch !== 'object') return getLook();
  const next = { ...load(), reactions: [...load().reactions] };
  let changed = false;
  for (const [key, val] of Object.entries(patch)) {
    if (key === 'bundle' || key === 'reaction') {
      if (put(next, itemById(val))) changed = true;
    } else if (key === 'reactions') {
      const r = clean({ reactions: val }).reactions;
      if (JSON.stringify(r) !== JSON.stringify(next.reactions)) { next.reactions = r; changed = true; }
    } else if (key in SLOTS) {
      if (val == null) { if (next[key] !== null) { next[key] = null; changed = true; } continue; }
      const it = itemById(val);
      if (it && it.kind === SLOTS[key] && next[key] !== it.id) { next[key] = it.id; changed = true; }
    }
  }
  if (changed) { cur = next; save(); emit(); }
  return getLook();
}

export function clearLook() {
  cur = EMPTY();
  save();
  emit();
  return getLook();
}

export function onLook(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

let previewTimer = null;
let previewBack = null;

/** Применить вещь на `ms` миллисекунд и вернуть прежний вид. Возвращает «отменить сейчас». */
export function previewFor(item, ms = 10_000) {
  const it = typeof item === 'string' ? itemById(item) : item && itemById(item.id);
  if (!it) return () => {};
  if (previewTimer == null) previewBack = getLook();
  clearTimeout(previewTimer);
  const next = { ...load(), reactions: [...load().reactions] };
  if (put(next, it)) { cur = next; emit(); } // без save(): примерка временная
  const stop = () => {
    clearTimeout(previewTimer);
    previewTimer = null;
    if (previewBack) { cur = clean(previewBack); previewBack = null; save(); emit(); }
  };
  previewTimer = setTimeout(stop, ms);
  return stop;
}

export function lookClass() {
  const l = load();
  return ['cardback', 'felt', 'frame', 'effect', 'title'].filter((k) => l[k]).map((k) => `look-${k}`).join(' ');
}

/** Только для тестов: сбросить память модуля. */
export function _reset() {
  cur = null;
  memory = null;
  subs.clear();
  clearTimeout(previewTimer);
  previewTimer = null;
  previewBack = null;
}
