#!/usr/bin/env node
/**
 * «На зубы» для магазина в админке (шаг H): по очереди возвращаем каждую поломку защиты, запускаем тесты — они
 * ОБЯЗАНЫ упасть. Файл после каждой поломки возвращается как был. Запуск: node tools/adminshop-teeth.mjs
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const TESTS = ['bot/admin.shop.test.js', 'bot/payments.test.js'];
const ADM = 'bot/payments/admin.js';
const PAY = 'bot/payments/index.js';
const CASES = [
  { name: 'операции магазина без сверки с ADMINS', file: ADM,
    from: "    if (!this.app.isAdmin(admin)) return null;\n    const op = ASHOP_OPS", to: "    const op = ASHOP_OPS" },
  { name: 'хаб пускает «Магазин» с любой страницы', file: 'bot/hub.js',
    from: "const r = session.kind === 'admin' ? await this.app.payments.admin.handle(session.user, msg) : null;",
    to: "const r = await this.app.payments.admin.handle(session.user, msg);",
    also: { file: ADM, from: "    if (!this.app.isAdmin(admin)) return null;\n    const op = ASHOP_OPS", to: "    const op = ASHOP_OPS" } },
  { name: 'кто — из тела страницы', file: ADM,
    from: "    const admin = String(user?.id ?? '');", to: "    const admin = String(msg?.by ?? user?.id ?? '');" },
  { name: 'выдача пишется как покупка (pay_entitlement)', file: ADM,
    from: "partsOf(t.id).filter((it) => this.db.adminGrant(t.uid, it, admin, now))",
    to: "partsOf(t.id).filter((it) => { this.db.grant(`adm${now}`, [it], t.uid, now); return true; })" },
  { name: 'выдача не считается источником права', file: 'bot/collections/index.js',
    from: "    for (const i of this.app.store.pay?.adminItems(u) ?? []) add(i, 'admin');\n", to: '' },
  { name: '«Забрать» снимает и купленное', file: 'bot/payments/store.js',
    from: "    return this.db.prepare('UPDATE shop_grant SET revoked_at = ?, revoked_by = ? WHERE user_id = ? AND item = ? AND revoked_at IS NULL')\n      .run(at, String(by), String(userId), item).changes > 0;",
    to: "    this.db.prepare('UPDATE pay_entitlement SET revoked_at = ? WHERE user_id = ? AND item = ?').run(at, String(userId), item);\n    return this.db.prepare('UPDATE shop_grant SET revoked_at = ?, revoked_by = ? WHERE user_id = ? AND item = ? AND revoked_at IS NULL')\n      .run(at, String(by), String(userId), item).changes > 0;" },
  { name: '«Забрать» не снимает надетое', file: ADM,
    from: '      if (out.length) this.app.collections.dropUnowned(t.uid);\n', to: '' },
  { name: '«Забрать» снимает надетое, даже если вещь куплена', file: ADM,
    from: '      if (out.length) this.app.collections.dropUnowned(t.uid);\n',
    to: '      if (out.length) for (const it of out) { const s = itemById(it)?.slot; if (s) this.app.store.collChoiceClear(t.uid, s); }\n' },
  { name: 'подарок не виден при выключенных продажах', file: PAY,
    from: '    return this.db.hasAnyOrder(uid) || this.db.hasAdminGrant(uid);', to: '    return this.db.hasAnyOrder(uid);' },
  { name: 'подарок в /paysupport как покупка', file: PAY,
    from: ".filter((o) => o.state !== 'gift').map((o) => ({ ...o, stateText", to: ".map((o) => ({ ...o, stateText" },
  { name: 'повтор нажатия (req) выполняется второй раз', file: ADM,
    from: "      if (!this.db.adminReq(admin, msg.req, this.now())) return", to: "      if (false) return" },
  { name: 'менять можно без req', file: ADM,
    from: "      if (!isReq(msg.req)) return this.fail(op, 'REQ');\n", to: '' },
  { name: 'цена меняется без второго шага', file: ADM,
    from: "    return this.ask(admin, { kind: 'price', item: id, from, to,",
    to: "    this.db.setOfferPrice(id, to, admin, this.now());\n    return this.ask(admin, { kind: 'price', item: id, from, to," },
  { name: 'код подтверждения цены многоразовый', file: ADM,
    from: '    this.asks.delete(key);\n    const { action } = a;', to: '    const { action } = a;' },
  { name: 'код подтверждения не устаревает', file: ADM,
    from: "    if (!a || a.until < this.now()) return this.fail('confirm', 'CODE');", to: "    if (!a) return this.fail('confirm', 'CODE');" },
  { name: 'устаревшее «было» перетирает чужую смену цены', file: ADM,
    from: "      if (this.pay.offers().items[action.item] !== action.from) return this.fail('confirm', 'STALE');\n", to: '' },
  { name: 'цена вне 1…10000 принимается', file: ADM,
    from: "    if (!isPrice(to)) return this.fail('price', 'PRICE');", to: "    if (!(to > 0)) return this.fail('price', 'PRICE');" },
  { name: 'цена из базы не действует (сервер берёт файл)', file: PAY,
    from: '      if (o.price != null) items[id] = o.price;\n', to: '' },
  { name: 'смена цены переписывает уже выставленные заказы', file: 'bot/payments/store.js',
    from: "      ON CONFLICT(item) DO UPDATE SET price = excluded.price, by = excluded.by, updated_at = excluded.updated_at`).run(item, price, String(by), at);",
    to: "      ON CONFLICT(item) DO UPDATE SET price = excluded.price, by = excluded.by, updated_at = excluded.updated_at`).run(item, price, String(by), at);\n    this.db.prepare('UPDATE pay_order SET price = ? WHERE item = ?').run(price, item);" },
  { name: 'скрытая вещь продаётся', file: 'bot/payments/config.js',
    from: '  if (!SELLABLE.has(id) || isHidden(cfg, id)) return null;', to: '  if (!SELLABLE.has(id)) return null;' },
  { name: 'утверждение цен из админки не учитывается', file: PAY,
    from: '    return { ...base, approved: approved ?? base.approved, items, hidden: [...hidden] };', to: '    return { ...base, items, hidden: [...hidden] };' },
  { name: 'возврат из админки без кода', file: ADM,
    from: "    const text = await this.pay.refundConfirm(admin, String(msg.order ?? '').slice(0, 32), String(msg.code ?? '').slice(0, 16));",
    to: "    const pre = this.pay.refundPrepare(admin, String(msg.order ?? '').slice(0, 32));\n    const text = await this.pay.refundConfirm(admin, String(msg.order ?? '').slice(0, 32), pre?.code ?? '');" },
  { name: 'неудачный возврат показан как «готово»', file: ADM,
    from: "    if (!done) return { t: 'ashop', op: 'refundConfirm', error:", to: "    if (false) return { t: 'ashop', op: 'refundConfirm', error:" },
  { name: 'остановка из админки не та же, что /salesstop', file: ADM,
    from: '        this.pay.setStopped(admin, stop);', to: '' },
  { name: 'нет лимита частоты', file: ADM,
    from: "    if (this.tooFast(admin)) return this.fail(op, 'FAST');", to: '' },
  { name: 'журнал не пишется', file: 'bot/payments/store.js',
    from: "    this.db.prepare('INSERT INTO shop_admin_log (at, by, event, user_id, item, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')\n      .run(", to: "    void ((...a) => a)(" },
  { name: 'ники в общем состоянии вкладки', file: ADM,
    from: '      orders: this.db.recentOrders(15).map((o) => this.orderRow(o)),',
    to: '      orders: this.db.recentOrders(15).map((o) => ({ ...this.orderRow(o), nick: this.app.store.getProfile?.(o.userId)?.nickname ?? null })),\n      nicks: (this.app.store.findProfiles?.(\'а\', 50) ?? []).concat(this.app.store.findProfiles?.(\'и\', 50) ?? []),' },
  { name: 'поиск заказов по шаблону SQL', file: 'bot/payments/store.js',
    from: "    const asOrder = /^[0-9a-f]{3,16}$/.test(s) ? `${s}%` : null;", to: "    const asOrder = `${s}%`;" },
];

const run = () => spawnSync(process.execPath, ['--test', ...TESTS], { encoding: 'utf8' });
let bad = 0;
for (const c of CASES) {
  const parts = [c, ...(c.also ? [c.also] : [])];
  const saved = new Map();
  let missing = false;
  for (const p of parts) {
    if (!saved.has(p.file)) saved.set(p.file, fs.readFileSync(p.file, 'utf8'));
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
