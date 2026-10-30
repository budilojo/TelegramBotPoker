'use strict';
/**
 * Поддержка внутри бота: игрок → владелец → игрок. Через стенд (Table): настоящий App, настоящий AdminBot,
 * заглушка Telegram. Защиты проверены «на зубы» — tools/support-teeth.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Table, user } from './harness.js';
import { Store } from './store.js';
import { salesConfig, gate } from './payments/config.js';
import { SUPPORT_LIMITS, scrub } from './support.js';

const OWNER = user(101, 'Иван');
const ALICE = user(202, 'Алиса');
const BOB = user(303, 'Боб');
let mid = 5000;

/** Личное сообщение со всеми служебными полями Telegram. */
const upd = (from, text, extra = {}) => ({
  update_id: ++mid,
  message: { message_id: ++mid, chat: { id: from.id, type: 'private' }, from, date: 1, ...(text != null ? { text } : {}), ...extra },
});
const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Стенд с админ-ботом: обращения уходят в него (как в проде, когда ADMIN_BOT_TOKEN задан). */
function rig({ store = new Store(':memory:'), viaAdminBot = true } = {}) {
  const t = new Table({ store, admins: ['101'] });
  if (viaAdminBot) t.app.notifyAdmins = (text) => t.adminBot.notify(text);
  t.adminTg.dmOpen.add('101');
  t.tg.dmOpen.add('101');
  for (const u of [ALICE, BOB]) t.tg.dmOpen.add(String(u.id));
  return t;
}
const write = async (t, from, text, extra) => { await t.raw(upd(from, text, extra)); };
const open = async (t, from) => { await t.start(from, 'support'); };
const ownerSeen = (t) => t.adminTg.dms(101);
const playerSeen = (t, u) => t.tg.dms(u.id);
/** Ответ владельца (reply) на последнее сообщение админ-бота с обращением. */
async function ownerReplies(t, text, { lastN = 1, via = 'admin' } = {}) {
  const tg = via === 'admin' ? t.adminTg : t.tg;
  const mine = [...tg.messages.values()].filter((m) => m.chatId === '101' && /Обращение №/.test(m.text));
  const target = mine.at(-lastN);
  const fn = via === 'admin' ? (u) => t.adminBot.handleUpdate(u) : (u) => t.raw(u);
  await fn(upd(OWNER, text, { reply_to_message: { message_id: 1, from: { id: 999, is_bot: true }, text: plain(target.text) } }));
  await t.app.settle();
}
const ownerSays = async (t, text, via = 'admin') => {
  if (via === 'admin') await t.adminBot.handleUpdate(upd(OWNER, text));
  else await t.raw(upd(OWNER, text));
  await t.app.settle();
};

test('игрок → владелец → игрок: обращение доходит с номером и id, ответ приходит от имени бота', async () => {
  const t = rig();
  await open(t, ALICE);
  assert.match(t.lastDm(ALICE), /Напишите вопрос одним сообщением/);
  assert.match(t.lastDm(ALICE), /Пароли/);
  await write(t, ALICE, 'Не появилась вещь после оплаты');
  assert.match(t.lastDm(ALICE), /Обращение №1 передано/);
  const got = plain(ownerSeen(t).at(-1));
  assert.match(got, /^📩 Обращение №1 · id 202/);
  assert.match(got, /Не появилась вещь после оплаты/);
  assert.doesNotMatch(got, /Алиса/, 'имя игрока владельцу не подтягиваем — только номер и id');

  await ownerReplies(t, 'Проверили, вещь выдана');
  assert.equal(t.lastDm(ALICE).replace(/<[^>]+>/g, ''), '💬 Поддержка: Проверили, вещь выдана');
  assert.match(ownerSeen(t).at(-1), /Ответ по обращению №1 отправлен/);
  t.app.store.close();
});

test('запасной путь: /reply <№> текст', async () => {
  const t = rig();
  await open(t, ALICE);
  await write(t, ALICE, 'вопрос');
  await ownerSays(t, '/reply 1 Здравствуйте, разберёмся');
  assert.match(t.lastDm(ALICE), /Поддержка:.*Здравствуйте, разберёмся/);
  await ownerSays(t, '/reply');
  assert.match(ownerSeen(t).at(-1), /Формат: \/reply/);
  await ownerSays(t, '/reply 99 привет');
  assert.match(ownerSeen(t).at(-1), /Нет такого обращения/);
  t.app.store.close();
});

test('без админ-бота обращения идут через основного бота, ответ — там же', async () => {
  const t = rig({ viaAdminBot: false });
  await open(t, ALICE);
  await write(t, ALICE, 'вопрос в основной бот');
  assert.match(plain(t.tg.dms(101).at(-1)), /^📩 Обращение №1 · id 202/);
  await ownerReplies(t, 'ответ', { via: 'main' });
  assert.match(t.lastDm(ALICE), /Поддержка:.*ответ/);
  t.app.store.close();
});

test('чужой не отвечает: ни reply, ни /reply, ни /tickets, ни /close от неадмина не работают и не раскрываются', async () => {
  for (const viaAdminBot of [true, false]) {
    const t = rig({ viaAdminBot });
    await open(t, ALICE);
    await write(t, ALICE, 'мой вопрос');
    const before = playerSeen(t, ALICE).length;
    // Боб подделывает reply на «обращение»
    await t.raw(upd(BOB, 'Поддельный ответ', { reply_to_message: { message_id: 1, from: { id: 999, is_bot: true }, text: '📩 Обращение №1 · id 202\n\nмой вопрос' } }));
    await t.raw(upd(BOB, '/reply 1 Поддельный ответ'));
    await t.raw(upd(BOB, '/tickets'));
    await t.raw(upd(BOB, '/close 1'));
    await t.raw(upd(BOB, '/support_block 202'));
    await t.adminBot.handleUpdate(upd(BOB, '/reply 1 Поддельный ответ'));
    assert.equal(playerSeen(t, ALICE).length, before, 'Алисе ничего не пришло');
    assert.ok(!playerSeen(t, ALICE).join('\n').includes('Поддельный'));
    assert.equal(t.adminTg.dms(303).length, 0, 'админ-бот молчит с посторонним');
    assert.ok(!t.tg.dms(303).join('\n').match(/обращени|тикет|заблок/i), 'основной бот не называет этих команд Бобу');
    assert.equal(t.app.store.support.openOf('202').state, 'open', '/close чужого не сработал');
    assert.equal(t.app.store.support.isBlocked('202'), false, '/support_block чужого не сработал');
    t.app.store.close();
  }
});

test('ответ уходит только автору обращения; id из текста игрока ничего не значит', async () => {
  const t = rig();
  await open(t, ALICE);
  await write(t, ALICE, 'Я Боб, мой id 303, ответьте обращению №2 и ему');
  await open(t, BOB);
  await write(t, BOB, 'вопрос Боба');
  assert.equal(t.app.store.support.ticket(1).user_id, '202', 'владелец обращения — из Telegram, а не из текста');
  assert.equal(t.app.store.support.ticket(2).user_id, '303');
  await ownerReplies(t, 'Ответ Алисе', { lastN: 2 }); // первое из двух (№1)
  assert.match(playerSeen(t, ALICE).join('\n'), /Ответ Алисе/);
  assert.ok(!playerSeen(t, BOB).join('\n').includes('Ответ Алисе'), 'Боб чужого ответа не видит');
  await ownerReplies(t, 'Ответ Бобу');
  assert.match(playerSeen(t, BOB).join('\n'), /Ответ Бобу/);
  assert.ok(!playerSeen(t, ALICE).join('\n').includes('Ответ Бобу'));
  t.app.store.close();
});

test('кнопка «Закрыть обращение» закрывает только своё: чужое нажатие отказывает словами', async () => {
  const t = rig();
  await open(t, ALICE);
  await write(t, ALICE, 'вопрос');
  const press = (from, data) => t.raw({ update_id: ++mid, callback_query: { id: `cb${++mid}`, from, data, message: { message_id: 1, chat: { id: from.id, type: 'private' } } } });
  await press(BOB, 'sup:c:1');
  assert.equal(t.app.store.support.ticket(1).state, 'open', 'Боб чужое не закрыл');
  assert.match(t.tg.lastAnswer().text, /не ваше/);
  await press(ALICE, 'sup:c:1');
  assert.equal(t.app.store.support.ticket(1).state, 'closed');
  assert.match(ownerSeen(t).at(-1), /закрыл обращение №1/);
  // следующее сообщение — новое обращение
  await open(t, ALICE);
  await write(t, ALICE, 'снова');
  assert.match(t.lastDm(ALICE), /Обращение №2 передано/);
  t.app.store.close();
});

test('лимиты: 5 в минуту, 20 в сутки, длина до 2000, только текст', async () => {
  const t = rig();
  await open(t, ALICE);
  for (let i = 1; i <= SUPPORT_LIMITS.perMinute; i++) await write(t, ALICE, `сообщение ${i}`);
  const delivered = () => ownerSeen(t).filter((x) => /Обращение №/.test(x)).length;
  assert.equal(delivered(), 5);
  await write(t, ALICE, 'шестое за минуту');
  assert.equal(delivered(), 5, 'шестое владельцу не ушло');
  assert.match(t.lastDm(ALICE), /не больше 5 сообщений в минуту/);

  // дальше по 5 раз в минуту — до суточного предела
  let sent = 5;
  while (sent < SUPPORT_LIMITS.perDay) {
    await t.advance(61_000);
    for (let i = 0; i < 5 && sent < SUPPORT_LIMITS.perDay; i++, sent++) await write(t, ALICE, `ещё ${sent}`);
  }
  assert.equal(delivered(), 20);
  await t.advance(61_000);
  await write(t, ALICE, 'двадцать первое');
  assert.equal(delivered(), 20);
  assert.match(t.lastDm(ALICE), /20 в сутки/);
  await t.advance(24 * 3600_000);
  await write(t, ALICE, 'на следующий день');
  assert.equal(delivered(), 21, 'через сутки снова можно');

  // длина и вложения
  await t.advance(61_000);
  await write(t, ALICE, 'я'.repeat(SUPPORT_LIMITS.maxLen + 1));
  assert.match(t.lastDm(ALICE), /не больше 2000 знаков/);
  await write(t, ALICE, 'я'.repeat(SUPPORT_LIMITS.maxLen));
  assert.equal(delivered(), 22, '2000 знаков — можно');
  await write(t, ALICE, null, { photo: [{ file_id: 'x' }] });
  assert.match(t.lastDm(ALICE), /Пока только текст/);
  assert.equal(delivered(), 22);
  t.app.store.close();
});

test('лимит считается на человека: Боб не страдает от спама Алисы', async () => {
  const t = rig();
  await open(t, ALICE);
  for (let i = 0; i < 7; i++) await write(t, ALICE, `спам ${i}`);
  await open(t, BOB);
  await write(t, BOB, 'нормальный вопрос');
  assert.match(t.lastDm(BOB), /передано/);
  t.app.store.close();
});

test('пароль, код и токен в тексте скрыты: игрок предупреждён, владелец видит пометку, в базе целого нет', async () => {
  const t = rig();
  await open(t, ALICE);
  const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw9';
  await write(t, ALICE, `мой пароль: hunter2secret, токен ${token}, код из смс 482913`);
  assert.match(t.lastDm(ALICE), /похоже на пароль, код или токен/);
  const toOwner = ownerSeen(t).at(-1);
  assert.match(toOwner, /скрыто/);
  const everywhere = JSON.stringify([...t.adminTg.messages.values()]) + JSON.stringify(t.app.store.support.db.prepare('SELECT * FROM support_msg').all());
  for (const s of ['hunter2secret', token, '482913']) assert.ok(!everywhere.includes(s), `«${s}» нигде не хранится и не пересылается`);
  assert.deepEqual(scrub('просто вопрос про заказ ord_12'), { text: 'просто вопрос про заказ ord_12', flagged: false });
  t.app.store.close();
});

test('блокировка: заблокированный не доходит до владельца, разблокировка возвращает', async () => {
  const t = rig();
  await open(t, ALICE);
  await write(t, ALICE, 'нормально');
  await ownerSays(t, '/support_block 202');
  assert.match(ownerSeen(t).at(-1), /заблокирован/);
  const n = ownerSeen(t).length;
  await write(t, ALICE, 'спам');
  assert.equal(ownerSeen(t).length, n);
  assert.match(t.lastDm(ALICE), /не принимаются/);
  await ownerSays(t, '/support_unblock 202');
  await write(t, ALICE, 'я снова');
  assert.match(ownerSeen(t).at(-1), /я снова/);
  await ownerSays(t, '/support_block abc');
  assert.match(ownerSeen(t).at(-1), /Формат/);
  t.app.store.close();
});

test('/tickets и /close: список открытых, владелец закрывает, игрок узнаёт', async () => {
  const t = rig();
  await open(t, ALICE);
  await write(t, ALICE, 'один');
  await open(t, BOB);
  await write(t, BOB, 'два');
  await ownerSays(t, '/tickets');
  assert.match(plain(ownerSeen(t).at(-1)), /№1 · id 202.*ждёт ответа/);
  assert.match(plain(ownerSeen(t).at(-1)), /№2 · id 303/);
  await ownerSays(t, '/close 1');
  assert.match(ownerSeen(t).at(-1), /закрыто/);
  assert.match(t.lastDm(ALICE), /закрыто поддержкой/);
  await ownerSays(t, '/tickets');
  assert.doesNotMatch(ownerSeen(t).at(-1), /№1/);
  await ownerSays(t, '/close 1');
  assert.match(ownerSeen(t).at(-1), /уже закрыто/);
  t.app.store.close();
});

test('недоставка: игрок заблокировал бота — владелец узнаёт, ничего не пропадает', async () => {
  const t = rig();
  await open(t, ALICE);
  await write(t, ALICE, 'вопрос');
  t.tg.dmOpen.delete('202'); // игрок заблокировал бота
  await ownerReplies(t, 'ответ в пустоту');
  assert.match(ownerSeen(t).at(-1), /не доставлен: игрок заблокировал бота/);
  assert.equal(t.app.store.getDm('202'), 'fail');
  t.app.store.close();
});

test('повтор доставки одного и того же reply ничего не удваивает', async () => {
  const t = rig();
  await open(t, ALICE);
  await write(t, ALICE, 'вопрос');
  const target = [...t.adminTg.messages.values()].find((m) => /Обращение №1/.test(m.text));
  const same = upd(OWNER, 'Единственный ответ', { reply_to_message: { message_id: 1, from: { id: 9, is_bot: true }, text: plain(target.text) } });
  await t.adminBot.handleUpdate(same);
  await t.adminBot.handleUpdate(same);
  await t.adminBot.handleUpdate(structuredClone(same));
  const replies = playerSeen(t, ALICE).filter((x) => /Единственный ответ/.test(x));
  assert.equal(replies.length, 1);
  // и /reply тоже
  const cmd = upd(OWNER, '/reply 1 Второй ответ');
  await t.adminBot.handleUpdate(cmd);
  await t.adminBot.handleUpdate(cmd);
  assert.equal(playerSeen(t, ALICE).filter((x) => /Второй ответ/.test(x)).length, 1);
  t.app.store.close();
});

test('перезапуск бота с файловой базой: обращения на месте, ответ после перезапуска доходит, повтор не удваивает', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'support-'));
  const file = path.join(dir, 'bot.db');
  try {
    let t = rig({ store: new Store(file) });
    await open(t, ALICE);
    await write(t, ALICE, 'вопрос до перезапуска');
    const ownerMsg = plain([...t.adminTg.messages.values()].find((m) => /Обращение №1/.test(m.text)).text);
    const reply = upd(OWNER, 'ответ после перезапуска', { reply_to_message: { message_id: 1, from: { id: 9, is_bot: true }, text: ownerMsg } });
    t.app.store.close();

    t = rig({ store: new Store(file) });
    assert.equal(t.app.store.support.openOf('202')?.id, 1, 'обращение пережило перезапуск');
    assert.equal(t.app.store.support.msgs(1)[0].text, 'вопрос до перезапуска');
    await t.adminBot.handleUpdate(reply);
    assert.match(t.lastDm(ALICE), /ответ после перезапуска/);
    t.app.store.close();

    t = rig({ store: new Store(file) });
    await t.adminBot.handleUpdate(reply); // Telegram прислал тот же апдейт ещё раз после второго перезапуска
    assert.equal(t.tg.dms(202).length, 0, 'повторный апдейт после перезапуска игроку ничего не шлёт');
    await write(t, ALICE, 'дополнение');
    assert.match(plain(ownerSeen(t).at(-1)), /^📩 Обращение №1 \(дополнение\)/, 'номер продолжается, обращение не задвоилось');
    t.app.store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('не команда в личке вне режима поддержки — обычная справка, обращение не создаётся', async () => {
  const t = rig();
  await write(t, BOB, 'привет, как дела');
  assert.equal(t.app.store.support.openList().length, 0);
  assert.equal(ownerSeen(t).filter((x) => /Обращение/.test(x)).length, 0);
  assert.match(t.lastDm(BOB), /Игры в Telegram/);
  // обращение из /paysupport: кнопка
  await t.dm(BOB, '/paysupport');
  const kb = [...t.tg.messages.values()].at(-1).markup.inline_keyboard.flat();
  assert.ok(kb.some((b) => b.callback_data === 'sup:open'), 'в /paysupport есть кнопка «Написать в поддержку»');
  t.app.store.close();
});

test('/paysupport и /terms ведут в бота; PAY_SUPPORT=bot — заданный контакт, но продажи остаются закрытыми', async () => {
  const t = rig();
  t.app.payments.cfg.support = 'bot';
  await t.dm(ALICE, '/paysupport');
  assert.match(t.lastDm(ALICE), /Напишите прямо сюда/);
  assert.doesNotMatch(t.lastDm(ALICE), /Напишите: bot/);
  await t.dm(ALICE, '/terms');
  const kb = [...t.tg.messages.values()].at(-1).markup.inline_keyboard.flat();
  assert.ok(kb.some((b) => b.callback_data === 'sup:open'));
  // кнопка открывает режим обращения
  await t.raw({ update_id: ++mid, callback_query: { id: `cb${++mid}`, from: ALICE, data: 'sup:open', message: { message_id: 1, chat: { id: 202, type: 'private' } } } });
  assert.match(t.lastDm(ALICE), /Напишите вопрос одним сообщением/);

  const cfg = salesConfig({ SALES_MODE: 'live', PAY_SUPPORT: 'bot' });
  assert.equal(cfg.support, 'bot');
  const g = gate(cfg);
  assert.equal(g.open, false, 'контакт задан, но остальное пусто — live не открывается');
  assert.ok(!g.reasons.some((r) => /контакт поддержки/.test(r)), 'контакт — не причина отказа');
  assert.ok(g.reasons.length >= 2, 'причины остались: цены/документы');
  t.app.store.close();
});

test('поддержка выключена, если некому отвечать (ADMINS пуст): честный отказ, обращение не создаётся', async () => {
  const t = new Table({ store: new Store(':memory:') });
  t.tg.dmOpen.add('202');
  await t.start(ALICE, 'support');
  assert.match(t.lastDm(ALICE), /некому ответить/);
  await t.raw(upd(ALICE, 'вопрос'));
  assert.equal(t.app.store.support.openList().length, 0);
  t.app.store.close();
});

test('срок хранения: закрытые обращения старше 12 месяцев стираются, свежие и открытые — нет; удаление по запросу', async () => {
  const t = rig();
  await open(t, ALICE);
  await write(t, ALICE, 'старое');
  await ownerSays(t, '/close 1');
  await open(t, BOB);
  await write(t, BOB, 'открытое');
  await t.advance(13 * 30 * 86_400_000);
  await open(t, ALICE);
  await write(t, ALICE, 'новое'); // каждое новое обращение подчищает старьё
  const s = t.app.store.support;
  assert.equal(s.ticket(1), null, 'закрытое старше года стёрто вместе с текстами');
  assert.equal(s.msgs(1).length, 0);
  assert.ok(s.ticket(2), 'открытое не трогаем');
  assert.equal(s.eraseUser('303'), 1);
  assert.equal(s.ticket(2), null);
  t.app.store.close();
});
