#!/usr/bin/env node
/**
 * «На зубы» для поддержки в боте: по очереди возвращаем каждую поломку защиты, запускаем тесты —
 * они ОБЯЗАНЫ упасть. Файл после каждой поломки возвращается как был. Запуск: node tools/support-teeth.mjs
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const TESTS = ['bot/support.test.js'];
const S = 'bot/support.js';
const CASES = [
  { name: 'неадмин отвечает владельцем (снята проверка ADMINS везде)', file: S,
    from: 'if (!this.app.isAdmin(owner.id)) return null;', to: '',
    also: [{ file: 'bot/app.js', from: 'if (this.isAdmin(user.id)) {\n      const res', to: 'if (true) {\n      const res' },
      { file: 'bot/admin-bot.js', from: 'if (!this.app.isAdmin(who.user.id)) {', to: 'if (false) {' }] },
  { name: 'ответ уходит не автору обращения', file: S,
    from: 'await this.app.outbox.post(t.user_id, SUP.reply(body)', to: "await this.app.outbox.post('202', SUP.reply(body)" },
  { name: 'автор обращения берётся из текста сообщения', file: S,
    from: 'const id = t ? t.id : this.store.open(user.id, now);', to: 'const id = t ? t.id : this.store.open((/id (\\d+)/.exec(raw) || [])[1] || user.id, now);' },
  { name: 'нет лимита в минуту', file: S, from: '>= SUPPORT_LIMITS.perMinute', to: '>= 99999' },
  { name: 'нет лимита в сутки', file: S, from: '>= SUPPORT_LIMITS.perDay', to: '>= 99999' },
  { name: 'нет предела длины', file: S, from: 'raw.length > SUPPORT_LIMITS.maxLen', to: 'false' },
  { name: 'фото и файлы принимаются как текст', file: S, from: "if (typeof msg.text !== 'string') return refuse(SUP.textOnly);", to: "if (typeof msg.text !== 'string') msg = { ...msg, text: 'вложение' };" },
  { name: 'пароли и токены не скрываются', file: S, from: "out = out.replace(re, () => { flagged = true; return '••••'; });", to: 'out = out.replace(re, (m) => m);' },
  { name: 'заблокированный пишет владельцу', file: S, from: 'if (this.store.isBlocked(user.id)) {\n      await this.app.outbox.post(user.tgId, SUP.blocked);\n      return true;', to: 'if (false) {\n      return true;' },
  { name: 'чужое обращение можно закрыть кнопкой', file: S, from: 't.user_id !== user.id', to: 'false' },
  { name: 'повтор одного reply отправляется дважды', file: S, from: "if (key && !this.store.claimReply(owner.id, key, t.id, now)) return '';", to: '' },
  { name: 'недоставка не сообщается владельцу', file: S, from: 'if (err?.error_code === 403) {', to: 'if (false) {' },
  { name: 'срок хранения не действует', file: S, from: '    this.store.purge(now);\n', to: '' },
  { name: 'обращения теряются при перезапуске (таблицы во временной базе)', file: 'bot/store.js',
    from: '    this.support = new SupportStore(this.db);', to: "    this.support = new SupportStore(new DatabaseSync(':memory:'));" },
  { name: 'любой текст в личке — обращение (нет режима)', file: 'bot/app.js', from: 'this.support.inMode(user.id)', to: 'true' },
  { name: 'ссылка ?start=support не открывает поддержку', file: 'bot/app.js', from: "if (cmd.rest === 'support') return this.support.enter(user);", to: '' },
  { name: '/paysupport не зовёт писать в бота при PAY_SUPPORT=bot', file: 'bot/payments/texts.js', from: "if (contact === 'bot')", to: 'if (false)' },
  { name: 'в /paysupport нет кнопки поддержки', file: 'bot/app.js', from: 'this.payments.supportText(user.id), OPEN_KB', to: 'this.payments.supportText(user.id), null' },
];

const run = () => spawnSync(process.execPath, ['--test', ...TESTS], { encoding: 'utf8' });
let bad = 0;
for (const c of CASES) {
  const parts = [c, ...(c.also ? [].concat(c.also) : [])];
  const saved = new Map();
  let missing = false;
  for (const p of parts) {
    const cur = fs.readFileSync(p.file, 'utf8');
    if (!saved.has(p.file)) saved.set(p.file, cur);
    if (!cur.includes(p.from)) { missing = true; break; }
    fs.writeFileSync(p.file, cur.replace(p.from, p.to));
  }
  let r = null;
  try { if (!missing) r = run(); } finally { for (const [f, src] of saved) fs.writeFileSync(f, src); }
  if (missing) { console.log(`?? ${c.name}: место поломки не найдено`); bad++; continue; }
  const fell = r.status !== 0;
  const n = (r.stdout.match(/^✖ /gm) || []).length;
  console.log(`${fell ? 'упал ' : 'НЕ УПАЛ'}  ${c.name}${fell ? ` (красных: ${n})` : ''}`);
  if (!fell) bad++;
}
const ok = run().status === 0;
console.log(ok ? 'после возврата кода тесты зелёные' : 'ВНИМАНИЕ: после возврата тесты красные');
process.exit(bad || !ok ? 1 : 0);
