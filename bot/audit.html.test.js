'use strict';
/**
 * Аудит, фаза 5 (F-1): чужой текст не становится разметкой Telegram.
 *
 * Имена игроков и название группы — что угодно: теги, ссылки, `&`, кавычки,
 * RTL-переворот, невидимые символы, очень длинные. Партии всех игр идут с
 * такими именами (фаззер `tools/fuzz-games.mjs`), и КАЖДОЕ сообщение бота в
 * разметке HTML — карточки, правки, итоги, «ваш ход», ответы на команды —
 * проверяется строгим разбором по правилам Telegram:
 *   - только разрешённые теги, все закрыты и вложены правильно;
 *   - ни одного «голого» `<` или `&` (Telegram такое сообщение не примет —
 *     и карточка стола перестанет обновляться для всей группы);
 *   - ни одной ссылки и ни одного тега, пришедшего из имени.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTable } from '../tools/fuzz-games.mjs';
import { htmlProblems } from './fmt.js';
import { GAME_LIST } from './games/index.js';

/** Теги, которые принимает Telegram в parse_mode HTML. */
const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'span', 'tg-spoiler', 'a', 'tg-emoji', 'code', 'pre', 'blockquote']);

/** Разбор текста, как это делает Telegram. Возвращает список нарушений. */
export function telegramHtmlProblems(text) {
  const out = [];
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^<>]*)>|&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);|[<>&]/g;
  let m;
  while ((m = re.exec(text))) {
    const [all, close, tag, attrs] = m;
    if (all === '<' || all === '&') {
      out.push(`голый «${all}» в позиции ${m.index}`);
      continue;
    }
    if (all === '>') continue; // Telegram терпит «>» в тексте
    if (all.startsWith('&')) {
      if (!/^&(lt|gt|amp|quot|#\d+|#x[0-9a-fA-F]+);$/.test(all)) out.push(`сущность ${all}`);
      continue;
    }
    const t = tag.toLowerCase();
    if (!ALLOWED.has(t)) {
      out.push(`тег <${t}>`);
      continue;
    }
    if (close) {
      if (stack.pop() !== t) out.push(`</${t}> закрывает не то`);
    } else {
      if (t === 'a') out.push(`ссылка <a${attrs}>`); // ни один текст бота ссылок не содержит
      stack.push(t);
    }
  }
  if (stack.length) out.push(`не закрыты: ${stack.join(', ')}`);
  return out;
}

/** Имена-атаки. Каждое — то, что может прийти в first_name из Telegram. */
const NAMES = [
  '<b>Жирный</b>', '</pre>', '<a href="tg://user?id=1">Я</a>', 'Tom & Jerry', 'A&amp;B', '"><script>',
  '‮анзакоп', 'Ну​ль', '<', '&', '<i>', 'x'.repeat(80), '<tg-spoiler>', '&lt;b&gt;', "O'Reilly", '😀👨‍👩‍👧',
];
const TITLE = '<b>Группа</b> & «"друзья"» <a href="https://evil">клик</a>';

for (const g of GAME_LIST) {
  test(`АУДИТ F-1: ${g.title} — ядовитые имена и название группы не ломают и не внедряют разметку`, async () => {
    let checked = 0;
    for (let seed = 1; seed <= 3; seed++) {
      await runTable(g.id, seed, 300, {
        names: NAMES.slice((seed * 3) % NAMES.length).concat(NAMES),
        title: TITLE,
        onDone: (t) => {
          // Всё, что бот шлёт через outbox, — с parse_mode HTML; заготовка шеринга — тоже.
          for (const c of t.tg.calls) {
            const text = c.method === 'savePreparedInlineMessage' ? c.result?.input_message_content?.message_text : c.text;
            if (typeof text !== 'string') continue;
            if (!['sendMessage', 'editMessageText', 'savePreparedInlineMessage'].includes(c.method)) continue;
            const bad = telegramHtmlProblems(text);
            checked += 1;
            assert.deepEqual(bad, [], `${g.id}, зерно ${seed}, ${c.method}: ${bad.join('; ')}\n${text.slice(0, 400)}`);
          }
        },
      });
    }
    assert.ok(checked > 10, `проверено сообщений: ${checked}`);
  });
}

test('АУДИТ F-1: сам разбор ловит то, что должен', () => {
  assert.deepEqual(telegramHtmlProblems('<b>ok</b> &lt; &amp; 5 > 3'), []);
  assert.ok(telegramHtmlProblems('<b>x').length);
  assert.ok(telegramHtmlProblems('a < b').length);
  assert.ok(telegramHtmlProblems('Tom & Jerry').length);
  assert.ok(telegramHtmlProblems('<script>').length);
  assert.ok(telegramHtmlProblems('<a href="x">y</a>').length);
  assert.ok(telegramHtmlProblems('<b><i>x</b></i>').length);
});

test('АУДИТ F-1: разбор в тесте и разбор рассылки (fmt.js) согласны', () => {
  for (const text of ['<b>x</b>', '<b>x', 'a & b', '&lt;', '<i><b>x</i></b>', '<script>', 'ok']) {
    assert.equal(htmlProblems(text).length === 0, telegramHtmlProblems(text).length === 0, text);
  }
});
