'use strict';
/**
 * Длинные нарды: доска, ходы, последовательности хода, конец партии. Без
 * людей, часов, сокетов и без кубиков — кубики бросает сервер (rules.js),
 * сюда приходят готовые числа.
 *
 * Правила — «Правила вида спорта „нарды“» (Минспорт, приказ № 734 от
 * 22.07.2024), раздел «Длинные нарды»; разбор и выбор — docs/nardy.md.
 *
 * Доска — 24 пункта по кругу, `b[0…23]`: плюс — белые шашки, минус — чёрные.
 * Каждый идёт своим путём из 24 шагов (индекс пути 0…23): белые — по
 * пунктам 0, 1, … 23; чёрные — 12, 13, … 23, 0, … 11. Индекс 0 — «голова»
 * (там в начале все 15), 18…23 — дом. Номер пункта для человека — абсолютный
 * пункт + 1 (см. ниже).
 *
 * Позиция: { b, off: { w, b }, t } — `off` — сколько шашек уже снято.
 *
 * Шаг (одна шашка на одно число кубика): { from, to, die } — `from` и `to`
 * абсолютные пункты 0…23, `to = -1` — шашку сняли с доски.
 *
 * Номера пунктов для человека — одни на всех и по доске, а не по игроку:
 * 1…24 против часовой стрелки от головы белых (у белых голова — 1, дом — 19…24;
 * у чёрных голова — 13, дом — 7…12). Так решил владелец: каждый видит свою
 * голову вверху справа, номера на доске не «переворачиваются» вместе с экраном.
 */

export const HEAD_LIMIT = 1;
export const other = (c) => (c === 'w' ? 'b' : 'w');
const sign = (c) => (c === 'w' ? 1 : -1);

/** Индекс пути цвета `c` для абсолютного пункта `p` — и обратно. */
export const idx = (c, p) => (c === 'w' ? p : (p + 12) % 24);
export const abs = (c, i) => (c === 'w' ? i : (i + 12) % 24);
/** Номер пункта для человека: одинаков для обоих — голова белых 1, голова чёрных 13. Цвет не нужен, оставлен для вызовов. */
export const pointNo = (_c, p) => p + 1;

/** Сколько шашек цвета `c` на пункте `p`. */
export const mine = (b, p, c) => Math.max(0, b[p] * sign(c));

export function startPosition() {
  const b = Array(24).fill(0);
  b[abs('w', 0)] = 15;
  b[abs('b', 0)] = -15;
  return { b, off: { w: 0, b: 0 }, t: 'w' };
}

export const clone = (pos) => ({ b: pos.b.slice(), off: { ...pos.off }, t: pos.t });

/** Все ли оставшиеся на доске шашки цвета `c` дома (индексы 18…23). */
export function allHome(pos, c) {
  for (let p = 0; p < 24; p++) if (mine(pos.b, p, c) && idx(c, p) < 18) return false;
  return true;
}

/* ------------------------------------------------------------- блок шести */

/**
 * Не заперты ли все 15 шашек соперника блоком из шести пунктов подряд.
 * Блок шести подряд строить можно, но только если хотя бы одна шашка
 * соперника уже прошла его (стоит дальше по своему пути) или снята с доски
 * (п. 20.5: «запрещено строить блок из шести шашек, запирающий все
 * пятнадцать шашек соперника даже в течение одного хода»).
 */
export function locksAll(pos, c) {
  const o = other(c);
  if (pos.off[o] > 0) return false;
  // Шесть пунктов подряд НА ПУТИ СОПЕРНИКА (j…j+5 по его индексам).
  let run = 0;
  for (let j = 0; j < 24; j++) {
    run = mine(pos.b, abs(o, j), c) ? run + 1 : 0;
    if (run >= 6) {
      // Блок кончается на j; есть ли шашка соперника дальше?
      let ahead = false;
      for (let k = j + 1; k < 24 && !ahead; k++) if (mine(pos.b, abs(o, k), o)) ahead = true;
      if (!ahead) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ ходы */

/**
 * Шаги одной шашкой на число `die` для того, чей ход. `head` — сколько шашек
 * уже снято с головы за этот ход, `headLimit` — сколько можно.
 */
export function steps(pos, die, { head = 0, headLimit = HEAD_LIMIT } = {}) {
  const c = pos.t;
  const out = [];
  const home = allHome(pos, c);
  let farthest = 24; // наименьший индекс пути среди своих шашек — самая дальняя от выхода
  for (let p = 0; p < 24; p++) if (mine(pos.b, p, c)) farthest = Math.min(farthest, idx(c, p));
  for (let p = 0; p < 24; p++) {
    if (!mine(pos.b, p, c)) continue;
    const i = idx(c, p);
    if (i === 0 && head >= headLimit) continue; // с головы — не больше положенного за ход
    const j = i + die;
    if (j <= 23) {
      const q = abs(c, j);
      if (pos.b[q] * sign(c) < 0) continue; // пункт занят соперником
      out.push({ from: p, to: q, die });
    } else if (home && (j === 24 || i === farthest)) {
      // Снять: точно по числу или, если число больше, — с самого дальнего пункта (п. 27.3).
      out.push({ from: p, to: -1, die });
    }
  }
  return out;
}

export function apply(pos, s) {
  const n = clone(pos);
  const c = n.t;
  n.b[s.from] -= sign(c);
  if (s.to < 0) n.off[c] += 1;
  else n.b[s.to] += sign(c);
  return n;
}

/** Кубики хода: два числа или четыре одинаковых (дубль). */
export const diceList = ([a, b]) => (a === b ? [a, a, a, a] : [a, b]);

/**
 * Все допустимые последовательности хода при броске `dice` — по правилам
 * обязательного хода (п. 26.6.3): сыграть столько чисел, сколько возможно;
 * если можно сыграть только одно из двух разных — большее. Каждый шаг
 * проверяется на блок шести «даже в течение одного хода».
 *
 * @returns {{ seqs: Array<Array<{from,to,die}>>, max: number }}
 */
export function sequences(pos, dice, { headLimit = HEAD_LIMIT } = {}) {
  const list = diceList(dice);
  const all = [];
  let max = 0;
  const walk = (p, left, head, path) => {
    let moved = false;
    const tried = new Set();
    for (let k = 0; k < left.length; k++) {
      const die = left[k];
      if (tried.has(die)) continue; // одинаковые числа — один и тот же выбор
      tried.add(die);
      for (const s of steps(p, die, { head, headLimit })) {
        const q = apply(p, s);
        if (locksAll(q, p.t)) continue;
        moved = true;
        path.push(s);
        walk({ ...q, t: p.t }, left.slice(0, k).concat(left.slice(k + 1)), head + (idx(p.t, s.from) === 0 ? 1 : 0), path);
        path.pop();
      }
    }
    if (!moved) {
      max = Math.max(max, path.length);
      all.push(path.slice());
    }
  };
  walk(pos, list, 0, []);
  let seqs = all.filter((s) => s.length === max);
  if (max === 1 && dice[0] !== dice[1]) {
    const big = Math.max(...dice);
    if (seqs.some((s) => s[0].die === big)) seqs = seqs.filter((s) => s[0].die === big);
  }
  if (max === 0) seqs = [[]];
  return { seqs, max };
}

const same = (a, b) => a.from === b.from && a.to === b.to && a.die === b.die;

/** Шаги, которыми можно продолжить ход после уже сыгранных `played`. */
export function nextSteps(seqs, played) {
  const out = [];
  for (const s of seqs) {
    if (s.length <= played.length) continue;
    if (!played.every((x, i) => same(x, s[i]))) continue;
    const n = s[played.length];
    if (!out.some((x) => same(x, n))) out.push(n);
  }
  return out;
}

/** Ход закончен: дальше по правилам играть нечего. */
export const turnDone = (seqs, played) => nextSteps(seqs, played).length === 0;

/** Сыграны ли шаги одной из допустимых последовательностей целиком (или её началом). */
export const prefixOk = (seqs, played) => seqs.some((s) => s.length >= played.length && played.every((x, i) => same(x, s[i])));

export const winner = (pos) => (pos.off.w === 15 ? 'w' : pos.off.b === 15 ? 'b' : null);

/** Запись шага для человека этого цвета: «24/18», «3/off» → «3/снята». */
export const stepText = (c, s) => `${pointNo(c, s.from)}/${s.to < 0 ? '⤓' : pointNo(c, s.to)}`;

/** Сколько очков пути осталось пройти всем шашкам цвета `c` до выхода. */
export function pips(pos, c) {
  let n = 0;
  for (let p = 0; p < 24; p++) n += mine(pos.b, p, c) * (24 - idx(c, p));
  return n;
}

/** Ключ позиции — для тестов и сверки. */
export const key = (pos) => `${pos.b.join(',')}|${pos.off.w},${pos.off.b}|${pos.t}`;
