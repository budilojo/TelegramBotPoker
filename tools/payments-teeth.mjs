#!/usr/bin/env node
/**
 * «На зубы» для покупок за Stars: по очереди возвращаем каждую поломку защиты, запускаем тесты — они ОБЯЗАНЫ
 * упасть. Файл после каждой поломки возвращается как был. Запуск: node tools/payments-teeth.mjs
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const TESTS = ['bot/payments.test.js', 'bot/payments.client.test.js'];
const PAY = 'bot/payments/index.js';
const CASES = [
  { name: 'продажи открыты по умолчанию', file: 'bot/app.js',
    from: 'sales || salesConfig({})', to: "sales || salesConfig({ SALES_MODE: 'test', TG_TEST_ENV: '1' })" },
  { name: 'тестерский доступ и при выключенном режиме (прод меняется)', file: PAY,
    from: "    return this.cfg.mode !== 'off' && this.app.cosmeticsUnlocked(uid);", to: '    return this.app.cosmeticsUnlocked(uid);' },
  { name: 'вещь выдаётся уже на pre_checkout', file: PAY,
    from: "    if (r.ok) this.db.moveOrder(r.o.id, ['created', 'approved'], 'approved', this.now());", to: "    if (r.ok) { this.db.moveOrder(r.o.id, ['created', 'approved'], 'approved', this.now()); this.db.grant(r.o.id, r.o.items, r.o.userId, this.now()); }" },
  { name: 'pre_checkout не сверяет покупателя (пересланный счёт)', file: PAY,
    from: "if (String(q.from?.id ?? '') !== o.userId) return", to: 'if (false) return' },
  { name: 'pre_checkout не сверяет сумму', file: PAY,
    from: "if (q.currency !== 'XTR' || q.total_amount !== o.price) return", to: 'if (false) return' },
  { name: 'pre_checkout не проверяет срок счёта', file: PAY,
    from: "if (o.expiresAt <= now) return { ok: false, why: 'expired', o };", to: '' },
  { name: 'pre_checkout не видит смены цены', file: PAY,
    from: "if (priceOf(eff, o.item) !== o.price || this.cfg.terms !== o.terms) return", to: 'if (false) return' },
  { name: 'pre_checkout не видит остановки продаж', file: PAY,
    from: "{ stopped: this.db.stopped(), down: this.app.down });\n    if (!g.open) return { ok: false, why: 'closed', o };", to: "{ stopped: false, down: false });\n    if (!g.open) return { ok: false, why: 'closed', o };" },
  { name: 'выдача без сверки суммы/покупателя', file: PAY,
    from: "else if (o.userId !== String(payerId) || sp.currency !== 'XTR' || sp.total_amount !== o.price) kind = 'mismatch';", to: '' },
  { name: 'повторная оплата заказа выдаёт снова', file: PAY,
    from: "else if (o.state === 'paid' || o.state === 'refunded' || this.db.paymentsOfOrder(o.id).some((p) => p.kind === 'order')) kind = 'duplicate';", to: '' },
  { name: 'нет уникальности платежа (повтор события)', file: 'bot/payments/store.js',
    from: '  charge_id   TEXT PRIMARY KEY,', to: '  charge_id   TEXT,' , also: { file: PAY, from: '      if (known) return', to: '      if (false) return' } },
  { name: 'выдача не в транзакции (падение оставляет половину)', file: PAY,
    from: '    return this.db.tx(() => {\n      const known', to: '    return ((f) => f())(() => {\n      const known' },
  { name: 'покупатель берётся из тела страницы', file: PAY,
    from: 'const p = this.buy(uid, msg.item, msg.req)', to: 'const p = this.buy(msg.userId ? String(msg.userId) : uid, msg.item, msg.req)' },
  { name: 'комплект продаётся при частичном владении', file: PAY,
    from: "    if (have.length) return 'PAY_PARTIAL';\n", to: '' },
  { name: 'уже имеющуюся вещь можно купить', file: PAY,
    from: "    if (have.length === items.length) return 'PAY_OWNED';\n", to: '' },
  { name: 'второй счёт на то же при двойном нажатии', file: PAY,
    from: '    if (was) return was;', to: '' , also: { file: PAY, from: '    if (live) return this.invoiceMsg(live);', to: '' } },
  { name: 'возврат не снимает права', file: PAY,
    from: '        this.db.revokeOrder(p.orderId, now);\n', to: '' },
  { name: 'возврат не снимает надетую вещь в базе', file: PAY,
    from: '        this.app.collections.dropUnowned(p.userId);\n', to: '' },
  { name: 'снятие вида не учитывает другой источник права', file: 'bot/collections/index.js',
    from: '      if (!owned.has(r.item)) this.app.store.collChoiceClear', to: '      if (true) this.app.store.collChoiceClear' },
  { name: 'двойной возврат возможен', file: PAY,
    from: "    if (ref?.state === 'done') return { error: `По заказу", to: "    if (false) return { error: `По заказу",
    also: { file: PAY, from: "    if (ref.state === 'done') return 'Возврат уже выполнен — повторять нельзя.';", to: '' } },
  { name: 'повтор после таймаута без сверки', file: PAY,
    from: '    if (ref.attempts > 0) {', to: '    if (false) {' },
  { name: 'права снимаются без подтверждения Telegram (таймаут)', file: PAY,
    from: "        return `Telegram не подтвердил возврат", to: "        await this.afterRefund(this.closeRefund(p.chargeId, admin, 'x'));\n        return `Telegram не подтвердил возврат" },
  { name: 'код подтверждения возврата не проверяется', file: PAY,
    from: 'if (!c || c.code !== code || c.until < this.now()) return', to: 'if (!c) return' },
  { name: 'возврат доступен не владельцу', file: 'bot/app.js',
    from: 'if (PAY_ADMIN_COMMANDS.includes(cmd?.cmd) && this.isAdmin(user.id)) {', to: 'if (PAY_ADMIN_COMMANDS.includes(cmd?.cmd)) {',
    also: { file: PAY, from: '  async adminCommand(user, cmd, rest = \'\') {\n    if (!this.app.isAdmin(user.id)) return null;', to: '  async adminCommand(user, cmd, rest = \'\') {' } },
  { name: 'сверка верит сумме транзакции без заказа', file: PAY,
    from: "currency: 'XTR', total_amount: t.amount }", to: "currency: 'XTR', total_amount: this.db.order(orderOfPayload(src.invoice_payload))?.price }" },
  { name: 'восстановление заказа без сверки суммы', file: PAY,
    from: "if (items.length && price && sp.currency === 'XTR' && sp.total_amount === price &&", to: "if (items.length && price &&" },
  { name: 'pre_checkout не сверяет вещь в payload', file: PAY,
    from: "if (!o || (parsed.item && parsed.item !== o.item)) return", to: 'if (!o) return' },
  { name: 'история показывает чужие заказы', file: 'bot/payments/store.js',
    from: "'SELECT * FROM pay_order WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'", to: "'SELECT * FROM pay_order WHERE ? IS NOT NULL ORDER BY created_at DESC LIMIT ?'" },
  { name: 'оплата не обрабатывается во время обслуживания', file: 'bot/app.js',
    from: '      if (update.message?.successful_payment) return', to: '      if (update.message?.successful_payment && !this.down) return' },
  { name: '/paysupport молчит при закрытых продажах', file: 'bot/app.js',
    from: "    if (cmd?.cmd === 'paysupport') return", to: "    if (cmd?.cmd === 'paysupport' && this.payments.open) return" },
  { name: 'live открывается с документами-проектами', file: 'bot/payments/config.js',
    from: "      else if (!d.ok) reasons.push", to: '      else if (false) reasons.push' },
  { name: 'live открывается без контакта поддержки', file: 'bot/payments/config.js',
    from: "    if (!cfg.support) reasons.push", to: '    if (false) reasons.push' },
  { name: '«Ночной казино-клуб» попадает в продаваемое', file: 'bot/payments/config.js',
    from: 'export const SELLABLE = new Set(ITEMS.map((x) => x.id));', to: "export const SELLABLE = new Set([...ITEMS.map((x) => x.id), 'night-cardback']);" },
  { name: 'клиент считает вещь купленной по статусу окна оплаты', file: 'miniapp/collections/pay.js',
    from: "      phase = { name: 'confirming', item, order, since: d.now() };", to: "      phase = { name: status === 'paid' ? 'done' : 'confirming', item, order, since: d.now() }; if (status === 'paid') return emit();" },
  { name: 'клиент шлёт цену в запросе покупки', file: 'miniapp/collections/pay.js',
    from: "d.send({ t: 'pay', op: 'buy', item, req })", to: "d.send({ t: 'pay', op: 'buy', item, req, price: 1 })" },
];

const run = () => spawnSync(process.execPath, ['--test', ...TESTS], { encoding: 'utf8' });
let bad = 0;
for (const c of CASES) {
  const parts = [c, ...(c.also ? [c.also] : [])];
  const saved = new Map();
  let missing = false;
  for (const p of parts) {
    const src = saved.get(p.file) ?? fs.readFileSync(p.file, 'utf8');
    if (!saved.has(p.file)) saved.set(p.file, src);
    const cur = fs.readFileSync(p.file, 'utf8');
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
