/** UX research is deliberately separate from aggregate product counters: consent and deletion are per session. */
import { randomUUID } from 'node:crypto';
import { GAMES } from './games/index.js';
import { checkInitData } from './webapp-auth.js';

const EVENTS = new Set(['app_open', 'home_view', 'game_select', 'room_form_open', 'room_settings_change', 'room_created', 'invite_open', 'game_start', 'error', 'scenario_exit']);
const SCREENS = new Set(['boot', 'home', 'hub', 'solo', 'room', 'settings', 'train', 'learn', 'other']);
const TABLES = ['profiles', 'users', 'seen', 'ratings', 'ratings_group', 'rating_log', 'shop_interest', 'shop_tab', 'collection_demo_grant', 'collection_choice', 'collection_req', 'train_skill', 'train_result', 'train_topic', 'train_mistake', 'train_pass', 'decision_log', 'product_use', 'shop_grant', 'pay_order', 'pay_payment', 'pay_entitlement', 'pay_refund', 'pay_log'];
const text = 'Доступно только авторизованным тестировщикам UX-Test.';
export class UX {
  constructor({ app, botToken, testers = [], enabled = false }) {
    if (!enabled) throw new Error('UX-Test выключен');
    this.calls = new Map();
    this.app = app; this.botToken = botToken; this.testers = new Set(testers.map(String));
    this.db = app.store.db;
    if (app.store.getSetting('ux-environment') !== 'ux-test') throw new Error('База не принадлежит UX-Test');
    this.db.exec(`CREATE TABLE IF NOT EXISTS ux_session (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, recording INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ux_event (session TEXT NOT NULL, at INTEGER NOT NULL, name TEXT NOT NULL, screen TEXT NOT NULL, game TEXT);`);
  }
  request(msg) {
    const auth = checkInitData(msg?.initData, this.botToken, { now: this.app.clock.now() });
    if (!auth.ok) return { status: 401, error: 'Откройте UX-Test из Telegram.' };
    const uid = String(auth.user.id), tester = this.testers.has(uid), op = msg.op;
    const now = this.app.clock.now(), minute = Math.floor(now / 60000);
    if (this.calls.size > 1000) for (const [key, value] of this.calls) if (value.minute !== minute) this.calls.delete(key);
    const count = this.calls.get(uid)?.minute === minute ? this.calls.get(uid).n + 1 : 1;
    this.calls.set(uid, { minute, n: count });
    if (count > 180) return { status: 429, error: 'Слишком много запросов UX-Test. Подождите минуту.' };
    const fail = (error = text) => ({ status: 403, error });
    if (op === 'info') return { environment: 'UX-Test', userId: uid, tester, profile: !!this.db.prepare('SELECT 1 FROM profiles WHERE user_id = ?').get(uid), onboarding: 'В приложении нет общего onboarding' };
    if (op === 'reset') {
      if (!tester) return fail();
      // No awaits between checking rooms and the transaction: another action cannot enter halfway through reset.
      const occupied = [...this.app.rooms.values()].some(r => !['finished', 'closed'].includes(r.status) &&
        (String(r.hostId) === uid || r.players.some(p => String(p.id) === uid && !p.left && !p.kicked)));
      if (occupied) return { status: 409, error: 'Сначала выйдите из незавершённых игр или завершите свои столы штатной кнопкой, затем повторите сброс.' };
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const table of TABLES) this.db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(uid);
        this.app.store.support.eraseUser(uid);
        this.db.prepare('DELETE FROM support_user WHERE user_id = ?').run(uid);
        this.db.prepare('DELETE FROM meta WHERE key = ?').run('s:cosmetic:talisman-hidden:' + uid);
        this.db.prepare('DELETE FROM ux_event WHERE session IN (SELECT id FROM ux_session WHERE user_id = ?)').run(uid);
        this.db.prepare('DELETE FROM ux_session WHERE user_id = ?').run(uid);
        // Group records remain intact; remove only this user's remembered membership.
        for (const g of this.app.groups.values()) {
          if (g.members?.includes(uid)) {
            const next = { ...g, members: g.members.filter(id => id !== uid) };
            this.app.store.saveGroup(next);
          }
        }
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
      for (const g of this.app.groups.values()) if (g.members) g.members = g.members.filter(id => id !== uid);
      this.app.profiles.cache.delete(uid); this.app.profiles.changes.delete(uid);
      this.app.training.calls.delete(uid);
      this.app.collections.limits.delete(uid);
      this.app.payments.limits.delete(uid);
      this.app.payments.buying.delete(uid);
      return { ok: true };
    }
    if (op === 'consent') {
      if (this.db.prepare('SELECT COUNT(*) n FROM ux_session WHERE user_id = ?').get(uid).n >= 20) return { status: 429, error: 'Удалите прежние сессии перед новой записью.' };
      const id = randomUUID();
      this.db.prepare('INSERT INTO ux_session VALUES (?, ?, 1)').run(id, uid);
      return { session: id };
    }
    if (op === 'export') {
      if (!tester) return fail();
      return { events: this.db.prepare('SELECT e.* FROM ux_event e ORDER BY at, rowid LIMIT 10000').all() };
    }
    const session = this.db.prepare('SELECT * FROM ux_session WHERE id = ? AND user_id = ?').get(String(msg.session || ''), uid);
    if (!session) return fail('Тестовая сессия не найдена.');
    if (op === 'delete') {
      this.db.prepare('DELETE FROM ux_event WHERE session = ?').run(session.id);
      this.db.prepare('DELETE FROM ux_session WHERE id = ?').run(session.id);
      return { ok: true };
    }
    if (op === 'stop') {
      this.db.prepare('UPDATE ux_session SET recording = 0 WHERE id = ?').run(session.id);
      return { ok: true };
    }
    if (op === 'event' && session.recording) {
      if (!EVENTS.has(msg.name) || !SCREENS.has(msg.screen)) return { status: 400, error: 'Неизвестное событие.' };
      if (this.db.prepare('SELECT COUNT(*) AS n FROM ux_event WHERE session = ?').get(session.id).n >= 2000) return { status: 429, error: 'Лимит сессии.' };
      // Never accept arbitrary metadata, error messages, URLs, user names or Telegram payloads.
      const game = Object.hasOwn(GAMES, msg.game) ? msg.game : null;
      this.db.prepare('INSERT INTO ux_event VALUES (?, ?, ?, ?, ?)').run(session.id, this.app.clock.now(), msg.name, msg.screen, game);
      return { ok: true };
    }
    return { status: 400, error: 'Неизвестное действие UX-Test.' };
  }
}
