/** Aggregate-only product metrics, with no names, hands, or per-player rows sent to admin. */
import { ymd, ymdBack } from './fmt.js';
import { itemById } from '../miniapp/collections/catalog.js';

export const PRODUCT_SCHEMA = `
CREATE TABLE IF NOT EXISTS product_use (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cosmetic', 'tournament')),
  item TEXT NOT NULL,
  PRIMARY KEY (day, user_id, kind, item)
);
CREATE INDEX IF NOT EXISTS seen_by_day ON seen (day);
`;

export function productMetrics(db, now, rooms) {
  const live = [...rooms].filter(r => r.tournament && ['playing', 'paused'].includes(r.status));
  const tournaments = { active: live.length, average: live.length ? live.reduce((n, r) => n + r.players.length, 0) / live.length : null };
  if (!db) return { tournaments, activity: null };

  const day = ymd(now), since = ymdBack(now, 6);
  const one = (sql, ...args) => db.prepare(sql).get(...args).n;
  const dau = one('SELECT COUNT(*) AS n FROM seen WHERE day = ?', day);
  const wau = one('SELECT COUNT(DISTINCT user_id) AS n FROM seen WHERE day BETWEEN ? AND ?', since, day);
  const nsm = one(`SELECT COUNT(DISTINCT s.user_id) AS n FROM seen s
    JOIN product_use u ON u.user_id = s.user_id AND u.day BETWEEN ? AND ?
    WHERE s.day BETWEEN ? AND ?`, since, day, since, day);
  const retention = (offset) => {
    const cohort = ymdBack(now, offset);
    const counts = db.prepare(`
      WITH first_seen AS (SELECT user_id, MIN(day) AS day FROM seen GROUP BY user_id)
      SELECT COUNT(*) AS cohort, COUNT(returned.user_id) AS returned FROM first_seen f
      LEFT JOIN seen returned ON returned.user_id = f.user_id AND returned.day = ?
      WHERE f.day = ?`).get(day, cohort);
    return { cohort: counts.cohort, returned: counts.returned };
  };
  const total = one('SELECT COUNT(DISTINCT user_id) AS n FROM seen WHERE day <= ?', day);
  const converted = one(`
    WITH acquisition AS (
      SELECT user_id FROM shop_grant WHERE granted_at <= ?
      UNION
      SELECT e.user_id FROM pay_entitlement e JOIN pay_order o ON o.id = e.order_id WHERE o.mode = 'live' AND e.granted_at <= ?
    )
    SELECT COUNT(*) AS n FROM acquisition a WHERE EXISTS (SELECT 1 FROM seen s WHERE s.user_id = a.user_id AND s.day <= ?)`, now, now, day);
  const installed = db.prepare(`
    SELECT COUNT(*) AS installed, COUNT(h.key) AS hidden
    FROM collection_choice c LEFT JOIN meta h ON h.key = 's:cosmetic:talisman-hidden:' || c.user_id AND h.value = 'true'
    WHERE c.slot = 'talisman'`).get();
  const usage = db.prepare(`
    SELECT item, COUNT(DISTINCT user_id) AS players FROM product_use
    WHERE kind = 'cosmetic' AND day BETWEEN ? AND ?
    GROUP BY item ORDER BY players DESC, item`).all(since, day);
  const top = usage.flatMap(row => {
    const item = itemById(row.item);
    return item ? [{ title: item.title, collection: item.collection ?? 'graphit', players: row.players }] : [];
  });
  const collections = ['sever', 'obsidian', 'chertezh'].map(collection => ({
    collection, top: top.filter(item => item.collection === collection).slice(0, 10),
  }));
  return { tournaments, activity: { dau, wau, nsm, d1: retention(1), d7: retention(7), total, converted, installed: { ...installed }, top: top.slice(0, 10), collections } };
}
