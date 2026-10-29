#!/usr/bin/env node
/**
 * «На зубы» для серверной части коллекции «Графит»: по очереди возвращаем каждую поломку,
 * запускаем тесты — они ОБЯЗАНЫ упасть. Файл после каждой поломки возвращается как был.
 * Запуск: node tools/graphit-server-teeth.mjs
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const TESTS = ['bot/collections.test.js', 'bot/collections.privacy.test.js'];
const CASES = [
  { name: 'демосреда включена по умолчанию', file: 'bot/app.js',
    from: 'botRng = Math.random, collectionsDemo = false,', to: 'botRng = Math.random, collectionsDemo = true,' },
  { name: 'доверие полю demo из тела сообщения', file: 'bot/collections/index.js',
    from: "    const uid = String(user.id);\n    const op =", to: "    const uid = String(user.id);\n    if (msg?.demo === true) this.demo = true;\n    const op =" },
  { name: 'демо-строки базы читаются при выключенной демосреде', file: 'bot/collections/index.js',
    from: "    if (this.demo) for (const i of this.app.store.collDemoItems", to: "    if (true) for (const i of this.app.store.collDemoItems" },
  { name: 'снимок не замораживается (пересборка при каждой отправке)', file: 'bot/collections/index.js',
    from: "    if (room.status === 'lobby') {\n      room.look = this.build(room, 0);", to: "    if (true) {\n      room.look = this.build(room, 0);" },
  { name: 'стол берётся у не-хоста', file: 'bot/collections/index.js',
    from: 'const hostChoice = this.choiceOf(room.hostId);', to: 'const hostChoice = this.choiceOf(room.players.at(-1).id);' },
  { name: 'чужое владение/выбор уходит в вид', file: 'bot/collections/look.js',
    from: "return { v: 1, table: pick(l.table), backs, dealNo:", to: "return { v: 1, owned: l.frames, table: pick(l.table), backs, dealNo:" },
  { name: 'проверка владения пропущена', file: 'bot/collections/index.js',
    from: "    if (!this.owns(uid, it.id)) return fail('COL_NOT_OWNED');\n", to: '' },
  { name: 'повторный req выполняется заново', file: 'bot/collections/index.js',
    from: 'if (store.collReqSeen(uid, msg.req)) return', to: 'if (false) return' },
  { name: 'права не проверяются при снимке (демо выключили — выбор остаётся)', file: 'bot/collections/index.js',
    from: '|| !owned.has(r.item)) continue;', to: ') continue;' },
];

const run = () => spawnSync(process.execPath, ['--test', ...TESTS], { encoding: 'utf8' });
let bad = 0;
for (const c of CASES) {
  const src = fs.readFileSync(c.file, 'utf8');
  if (!src.includes(c.from)) { console.log(`?? ${c.name}: место поломки не найдено`); bad++; continue; }
  fs.writeFileSync(c.file, src.replace(c.from, c.to));
  let r;
  try { r = run(); } finally { fs.writeFileSync(c.file, src); }
  const fell = r.status !== 0;
  const n = (r.stdout.match(/^✖ /gm) || []).length;
  console.log(`${fell ? 'упал ' : 'НЕ УПАЛ'}  ${c.name}${fell ? ` (красных: ${n})` : ''}`);
  if (!fell) bad++;
}
const ok = run().status === 0;
console.log(ok ? 'после возврата кода тесты зелёные' : 'ВНИМАНИЕ: после возврата тесты красные');
process.exit(bad || !ok ? 1 : 0);
