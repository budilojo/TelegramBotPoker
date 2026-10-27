/** Временно ломает по одной защите; всегда возвращает исходники. Не запускать одновременно с другими проверками. */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const mutations = [
  ['личность из подписи', 'bot/hub.js', 'this.shop.handle(session.user, msg)', 'this.shop.handle(msg.user || session.user, msg)'],
  ['белый список', 'bot/shop.js', "if (!isItem(msg.item))", 'if (false)'],
  ['действия', 'bot/shop.js', "if (!['view', 'want'].includes(msg.action))", 'if (false)'],
  ['вариант назначает сервер', 'bot/shop.js', "|| msg.variant !== variant", ''],
  ['известный вариант', 'bot/shop.js', "!['a', 'b'].includes(msg.variant) || msg.variant !== variant", 'false'],
  ['две группы цен', 'bot/shop.js', "Number(String(uid).slice(-1)) % 2 === 0", 'true'],
  ['частота', 'bot/shop.js', 'times.length >= PER_MINUTE', 'false'],
  ['подтверждение сброса', 'bot/shop.js', 'msg.confirm !== true', 'false'],
  ['дедупликация', 'bot/store.js', 'wanted_at = COALESCE(shop_interest.wanted_at, excluded.wanted_at)', 'wanted_at = excluded.wanted_at'],
  ['только свои отметки', 'bot/store.js', "WHERE user_id = ? AND wanted_at IS NOT NULL ORDER BY item", "WHERE ? IS NOT NULL AND wanted_at IS NOT NULL ORDER BY item"],
  ['только свой сброс', 'bot/store.js', "DELETE FROM shop_interest WHERE user_id = ?", "DELETE FROM shop_interest WHERE ? IS NOT NULL"],
  ['пульт только владельцу', 'bot/hub.js', 'if (!this.app.isAdmin(auth.user.id))', 'if (false)'],
  ['в пульте только суммы', 'bot/shop.js', 'return { item: item.id, variant, views, wants, percent:', "return { user_id: '810001', item: item.id, variant, views, wants, percent:"],
  ['разблокировка только по списку сервера', 'bot/app.js', 'return this.isAdmin(userId) || this.cosmeticsTesters.has(String(userId));', 'return true;'],
  ['тестеры из настроек, а не из тела', 'bot/shop.js', 'unlocked: this.app.cosmeticsUnlocked(uid)', 'unlocked: msg.unlocked === true || this.app.cosmeticsUnlocked(uid)'],
  ['тестеры не открыты по умолчанию', 'bot/app.js', 'this.cosmeticsTesters = new Set();', 'this.cosmeticsTesters = new Set([\'810001\']);'],
  ['открытые вещи не искажают спрос', 'bot/shop.js', 'if (this.app.cosmeticsUnlocked(uid)) return mine();', ''],
];

const run = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', 'bot/shop.test.js'], { encoding: 'utf8' });
const baseline = run();
assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
for (const [label, file, from, to] of mutations) {
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(source.includes(from), `нет точки поломки: ${label}`);
  try {
    fs.writeFileSync(file, source.replace(from, to));
    const result = run();
    assert.ok(result.status !== null && result.status !== 0 && /AssertionError/.test(result.stdout + result.stderr), `тест не поймал поломку: ${label}\n${result.stdout}\n${result.stderr}`);
    console.log(`Поймано: ${label}`);
  } finally { fs.writeFileSync(file, source); }
}
assert.equal(run().status, 0, 'после восстановления тесты должны пройти');
console.log(`Все ${mutations.length} поломок пойманы, код восстановлен.`);
