'use strict';
/**
 * WHO opened the Mini App. The same rule as for buttons in the group — a
 * person is who Telegram says they are — carried over to the table.
 *
 * Telegram hands the Mini App an `initData` query string signed with the
 * bot's token: HMAC-SHA256 over the fields, keyed by
 * HMAC-SHA256("WebAppData", token). The page sends that string to the server
 * verbatim, and the server checks the signature before believing a single
 * field in it. A user id typed into the page, a room code in the URL — none
 * of that is identity; only a valid signature is.
 */
import crypto from 'node:crypto';

/** initData older than this is refused: it would be a replayed session. */
export const MAX_AGE_SEC = 24 * 60 * 60;

const secretFor = (botToken) => crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();

/** The exact string Telegram signs: every field but `hash`, sorted, `k=v` joined by \n. */
function dataCheckString(params) {
  return [...params.entries()]
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/**
 * @returns {{ok:true, user:{id:string, tgId:number, name:string}, startParam:string|null, authDate:number}
 *          |{ok:false, reason:'MISSING'|'BAD_HASH'|'EXPIRED'|'NO_USER'}}
 */
export function checkInitData(initData, botToken, { now = Date.now(), maxAgeSec = MAX_AGE_SEC } = {}) {
  if (typeof initData !== 'string' || !initData || !botToken) return { ok: false, reason: 'MISSING' };
  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'MISSING' };
  }
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: 'BAD_HASH' };

  const expected = crypto.createHmac('sha256', secretFor(botToken)).update(dataCheckString(params)).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'BAD_HASH' };
  }

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > maxAgeSec) return { ok: false, reason: 'EXPIRED' };

  let raw;
  try {
    raw = JSON.parse(params.get('user') || 'null');
  } catch {
    raw = null;
  }
  if (!raw || typeof raw.id !== 'number' || raw.is_bot) return { ok: false, reason: 'NO_USER' };

  return {
    ok: true,
    user: {
      id: String(raw.id),
      tgId: raw.id,
      name: String(raw.first_name || raw.username || `Игрок ${raw.id}`),
    },
    startParam: params.get('start_param') || null,
    authDate,
  };
}

/**
 * Build a signed initData string — what Telegram does. For tests and for the
 * local preview of the table; never used to accept anything.
 */
export function signInitData(fields, botToken) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const hash = crypto.createHmac('sha256', secretFor(botToken)).update(dataCheckString(params)).digest('hex');
  params.set('hash', hash);
  return params.toString();
}
