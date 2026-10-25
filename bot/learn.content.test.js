'use strict';
/**
 * Содержание курса «Обучение»: порядок «от простого к сложному», живые ссылки на темы и
 * факты, никаких «голых» вероятностей в тексте, безопасная вёрстка. Числа-вероятности в
 * текстах — только через {{fact:…}} (их пересчитывает learn.facts.test.js) или {{in:…}}
 * (число из условия примера).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTIONS, allLessons } from '../miniapp/learn/sections.js';
import { TOPICS, LESSON_SECTIONS, isTopic } from '../miniapp/train/topics.js';
import { FACT_IDS, FORMATS, FACT_REF, INPUT_REF } from '../miniapp/learn/facts.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PLAY_NAMES = new Set([...read('miniapp/learn/play.js').matchAll(/^export const PLAY = \{([\s\S]*?)\};/gm)][0][1].matchAll(/(\w+):/g).map((m) => m[1]));
const SHOWS = new Set(['ladder', 'tree']);
const BLOCKS = new Set(['p', 'h', 'list', 'rule', 'show', 'play']);

/** Все строки урока, где живёт текст для игрока (варианты ответа — отдельно: это ответы, не утверждения). */
function texts(l) {
  const out = [['goal', l.goal]];
  l.blocks.forEach(([kind, a], i) => {
    if (kind === 'list') a.forEach((x, k) => out.push([`blocks[${i}][${k}]`, x]));
    else if (['p', 'h', 'rule'].includes(kind)) out.push([`blocks[${i}]`, a]);
  });
  l.remember.forEach((x, i) => out.push([`remember[${i}]`, x]));
  l.quiz.forEach((q, i) => { out.push([`quiz[${i}].q`, q.q], [`quiz[${i}].why`, q.why]); });
  return out;
}

test('каждая тема раздела — ровно один урок, раздел верный', () => {
  const lessons = allLessons();
  const seen = new Set();
  for (const l of lessons) {
    assert.ok(isTopic(l.topic), `тема «${l.topic}» есть в реестре`);
    assert.ok(!seen.has(l.topic), `дубль урока «${l.topic}»`);
    seen.add(l.topic);
    assert.equal(l.section, TOPICS.find((t) => t.id === l.topic).lessonSection, `раздел урока «${l.topic}»`);
  }
  for (const t of TOPICS.filter((x) => x.lessonSection)) assert.ok(seen.has(t.id), `у темы «${t.id}» нет урока`);
});

test('в каждом разделе 3–7 уроков, разделы идут в порядке реестра', () => {
  assert.deepEqual(SECTIONS.map((s) => s.id), LESSON_SECTIONS.map((s) => s.id));
  for (const s of SECTIONS) assert.ok(s.lessons.length >= 3 && s.lessons.length <= 7, `${s.id}: ${s.lessons.length}`);
});

test('«от простого к сложному»: needs ссылаются только на более ранние уроки', () => {
  const order = allLessons().map((l) => l.topic);
  for (const l of allLessons()) {
    for (const n of l.needs) {
      assert.ok(isTopic(n), `${l.topic}: needs «${n}» не тема`);
      assert.ok(order.indexOf(n) >= 0 && order.indexOf(n) < order.indexOf(l.topic), `${l.topic} требует «${n}», но тот идёт позже`);
    }
  }
});

test('форма урока: блоки, три пункта «запомните», проверка, схема или пример', () => {
  for (const l of allLessons()) {
    assert.ok(l.goal && l.goal.length > 10, `${l.topic}: goal`);
    assert.equal(l.remember.length, 3, `${l.topic}: remember — ровно 3`);
    assert.ok(l.quiz.length >= 1 && l.quiz.length <= 2, `${l.topic}: quiz 1–2`);
    for (const q of l.quiz) {
      assert.ok(q.options.length >= 2 && Number.isInteger(q.right) && q.right >= 0 && q.right < q.options.length, `${l.topic}: quiz right`);
      assert.ok(q.why.length > 10, `${l.topic}: разбор ответа`);
    }
    for (const b of l.blocks) {
      assert.ok(BLOCKS.has(b[0]), `${l.topic}: неизвестный блок ${b[0]}`);
      if (b[0] === 'play') assert.ok(PLAY_NAMES.has(b[1]), `${l.topic}: нет интерактива «${b[1]}»`);
      if (b[0] === 'show') assert.ok(SHOWS.has(b[1]), `${l.topic}: нет схемы «${b[1]}»`);
    }
    assert.ok(l.blocks.some((b) => b[0] === 'play' || b[0] === 'show'), `${l.topic}: нужна схема или интерактивный пример`);
  }
});

test('ссылки на факты живые, форматы существуют', () => {
  const ids = new Set(FACT_IDS);
  for (const l of allLessons()) for (const [where, t] of texts(l)) {
    for (const m of String(t).matchAll(FACT_REF)) {
      assert.ok(ids.has(m[1]), `${l.topic} ${where}: нет факта «${m[1]}»`);
      assert.ok(FORMATS[m[2]], `${l.topic} ${where}: нет формата «${m[2]}»`);
    }
  }
});

test('в текстах нет «голых» вероятностей: только {{fact}} и {{in}}', () => {
  for (const l of allLessons()) for (const [where, t] of texts(l)) {
    const bare = String(t).replace(FACT_REF, '').replace(INPUT_REF, '');
    assert.ok(!/\d\s?%/.test(bare), `${l.topic} ${where}: голый процент — «${bare.match(/.{0,20}\d\s?%/)?.[0]}»`);
    assert.ok(!/\b1\s*к\s*\d/i.test(bare), `${l.topic} ${where}: голое «1 к N»`);
    assert.ok(!/\d,\d+\s?%/.test(bare), `${l.topic} ${where}: голый процент с запятой`);
  }
});

test('«правило порядка» помечено везде, где урок даёт эмпирический совет', () => {
  // пометка есть как блок 'rule' в уроках, где говорится о диапазонах, размерах и зонах
  const need = ['starting-hands', 'open-raise', 'range-by-position', 'range-reading', 'cbet', 'spr', 'gto-basics', 'mdf', 'blockers', 'gto-advanced', 'draws', 'value-bluff', 'bet-sizing', 'implied-odds'];
  for (const t of need) assert.ok(allLessons().find((l) => l.topic === t).blocks.some((b) => b[0] === 'rule'), `в уроке «${t}» нужна пометка «правило порядка»`);
});

test('без innerHTML и внешних доменов; стили — токены, без градиентов и теней', () => {
  const files = fs.readdirSync(path.join(ROOT, 'miniapp/learn')).filter((f) => f.endsWith('.js')).map((f) => `miniapp/learn/${f}`)
    .concat(fs.readdirSync(path.join(ROOT, 'miniapp/learn/content')).map((f) => `miniapp/learn/content/${f}`));
  for (const f of files) {
    const src = read(f).replace('http://www.w3.org/2000/svg', ''); // пространство имён SVG — не сеть
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|html:\s/.test(src), `${f}: innerHTML/html:`);
    assert.ok(!/https?:\/\//.test(src), `${f}: внешний адрес`);
    assert.ok(!/\beval\(|new Function/.test(src), `${f}: eval`);
  }
  const css = read('miniapp/learn.css');
  assert.ok(!/gradient|box-shadow|text-shadow|filter:\s*blur/.test(css), 'learn.css: градиент/тень');
  assert.ok(!/font-size:\s*\d/.test(css.replace(/font:[^;]*;/g, '')), 'learn.css: размер шрифта только из шкалы');
});
