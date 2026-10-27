/**
 * «Зубы» клиента коллекций: возвращаем по одной поломке в исходник и убеждаемся, что тест падает.
 *
 *   node tools/graphit-client-teeth.mjs
 *
 * Каждая запись: файл, что заменить, на что, какой тест обязан упасть. После каждой — файл возвращается
 * ровно как был (в конце проверяем, что дерево не изменилось). Не упал тест — защита ничего не охраняет, код выхода 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNIT = 'bot/collections.client.test.js';

const TEETH = [
  { name: 'показать выдачу до ответа сервера (владение ставится сразу при нажатии)', file: 'miniapp/collections/state.js',
    from: "return fire({ op: 'grant', item, req: d.genReq() });",
    to: "const r = fire({ op: 'grant', item, req: d.genReq() }); for (const id of (itemsOfBundle(item).length ? itemsOfBundle(item) : [item])) server.owned.push({ item: id, demo: true }); return r;", test: UNIT },
  { name: 'включить вход вне демо (достаточно enabled)', file: 'miniapp/collections/state.js',
    from: 'const visible = () => !!server && server.enabled && server.demo;', to: 'const visible = () => !!server && server.enabled;', test: UNIT },
  { name: 'считать демо по любой «правдивой» строке из сообщения', file: 'miniapp/collections/state.js',
    from: 'out.demo = msg.enabled === true && msg.demo === true;', to: 'out.demo = msg.enabled === true && !!msg.demo;', test: UNIT },
  { name: 'разрешить повтор по двойному нажатию (запрос уходит, даже пока ждём ответ)', file: 'miniapp/collections/state.js',
    from: "if (!visible() || wait || !connected) return false;\n      const it = itemById(item);", to: "if (!visible() || !connected) return false;\n      const it = itemById(item);", test: UNIT },
  { name: 'повтор после молчания сервера идёт с новым req (может удвоить выдачу)', file: 'miniapp/collections/state.js',
    from: 'if (w) return fire(w);', to: 'if (w) return fire({ ...w, req: d.genReq() });', test: UNIT },
  { name: 'ответ-отказ принимается за успех выбора', file: 'miniapp/collections/state.js',
    from: 'if (msg.error) {', to: 'if (msg.error && false) {', test: UNIT },
  { name: 'комплект можно выдать целиком при частичном владении', file: 'miniapp/collections/state.js',
    from: "if (it.kind === 'bundle' && api.ownedSome(item)) return false;", to: '', test: UNIT },
  { name: 'показать «Так видят друзья» в игре / вне примерки (карточка предмета)', file: 'miniapp/collections/item.js',
    from: "h('h3.col-cap', 'Цвет'),", to: "h('h3.col-cap', 'Так видят друзья'),", test: UNIT },
  { name: 'цвет выбранного — синий', file: 'miniapp/collections.css',
    from: '.col-sw[aria-checked="true"] { border-color: var(--text-primary);', to: '.col-sw[aria-checked="true"] { border-color: #2c6fd1;', test: UNIT },
  { name: 'выбор цвета держится только на цвете (галочку убрали)', file: 'miniapp/collections/item.js',
    from: "h('span.col-check', {", to: "h('span.col-nocheck', {", test: UNIT },
  { name: 'демо включается через localStorage', file: 'miniapp/collections/settings-row.js',
    from: 'if (!store.visible) return null;', to: "if (!store.visible && localStorage.getItem('demo') !== '1') return null;", test: UNIT },
  { name: 'написали «Купить» (выдуманная оплата)', file: 'miniapp/collections/item.js',
    from: "text: 'Получить для демонстрации'", to: "text: 'Купить'", test: UNIT },
];

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const touched = [...new Set(TEETH.map((t) => t.file))];
const original = Object.fromEntries(touched.map((f) => [f, read(f)]));
const restore = () => { for (const f of touched) fs.writeFileSync(path.join(ROOT, f), original[f]); };
process.on('exit', restore);
process.on('SIGINT', () => process.exit(130));

// Сначала: на целом коде тест зелёный (иначе «упал» ничего не значит).
const base = spawnSync(process.execPath, ['--test', UNIT], { cwd: ROOT, encoding: 'utf8' });
if (base.status !== 0) { console.error('на целом коде тест уже красный — зубы проверять не с чем'); process.exit(2); }

let bad = 0;
for (const t of TEETH) {
  const src = original[t.file];
  if (!src.includes(t.from)) { console.log(`✗ ${t.name}: в ${t.file} не нашлось места для поломки (код изменился?)`); bad++; continue; }
  fs.writeFileSync(path.join(ROOT, t.file), src.replace(t.from, t.to));
  const r = spawnSync(process.execPath, ['--test', t.test], { cwd: ROOT, encoding: 'utf8' });
  fs.writeFileSync(path.join(ROOT, t.file), src);
  const fell = r.status !== 0;
  console.log(`${fell ? '✓ упал' : '✗ НЕ УПАЛ'} — ${t.name}`);
  if (!fell) bad++;
}
restore();
for (const f of touched) if (read(f) !== original[f]) { console.log(`✗ ${f} не восстановлен`); bad++; }
console.log(bad ? `\nзубов нет: ${bad}` : `\nвсе ${TEETH.length} поломок ловятся`);
process.exit(bad ? 1 : 0);
