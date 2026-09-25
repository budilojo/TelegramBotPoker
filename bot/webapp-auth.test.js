'use strict';
/**
 * The Mini App's whole security model: a person is who Telegram signed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkInitData, signInitData, MAX_AGE_SEC } from './webapp-auth.js';

// A signed initData published in the tma.js documentation, with its token.
// Not produced by our own signer — so a bug shared by our signer and our
// checker cannot make this test pass.
const VECTOR = {
  token: '5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8',
  initData:
    'query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%22%2C' +
    '%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%2C' +
    '%22is_premium%22%3Atrue%7D&auth_date=1662771648&hash=c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2',
  at: 1662771648 * 1000,
};

test('a genuine initData signed by Telegram is accepted, and names the right person', () => {
  const r = checkInitData(VECTOR.initData, VECTOR.token, { now: VECTOR.at + 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.user.id, '279058397');
  assert.equal(r.user.name, 'Vladislav');
});

test('changing any single field breaks the signature', () => {
  const opts = { now: VECTOR.at + 1000 };
  const swaps = [
    ['279058397', '279058398'], // somebody else's id
    ['Vladislav', 'Vladimir'], // a different name
    ['auth_date=1662771648', 'auth_date=1662771649'], // a fresher date
  ];
  for (const [a, b] of swaps) {
    assert.equal(checkInitData(VECTOR.initData.replace(a, b), VECTOR.token, opts).reason, 'BAD_HASH', `${a} → ${b}`);
  }
  // Adding a field — say, a room to open — is tampering too.
  assert.equal(checkInitData(`${VECTOR.initData}&start_param=abc`, VECTOR.token, opts).reason, 'BAD_HASH');
});

test('the signature of one bot is worthless for another', () => {
  const r = checkInitData(VECTOR.initData, '5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx9', { now: VECTOR.at });
  assert.equal(r.reason, 'BAD_HASH');
});

test('an old initData is refused — a replayed session is not a session', () => {
  const r = checkInitData(VECTOR.initData, VECTOR.token, { now: VECTOR.at + (MAX_AGE_SEC + 60) * 1000 });
  assert.equal(r.reason, 'EXPIRED');
});

test('no initData, garbage, or a missing hash are refused without throwing', () => {
  for (const bad of [undefined, null, '', 'garbage', 'user=%7B%7D', 'hash=zz', 'hash=' + 'a'.repeat(64)]) {
    const r = checkInitData(bad, VECTOR.token, { now: VECTOR.at });
    assert.equal(r.ok, false, String(bad));
  }
});

test('the room to open travels inside the signature as start_param', () => {
  const token = '1:abc';
  const now = Date.now();
  const data = signInitData({ auth_date: Math.floor(now / 1000), user: { id: 5, first_name: 'Лена' }, start_param: 'a7k2m9qx' }, token);
  const r = checkInitData(data, token, { now });
  assert.equal(r.ok, true);
  assert.equal(r.startParam, 'a7k2m9qx');
});

test('a bot account cannot sit at the table', () => {
  const token = '1:abc';
  const now = Date.now();
  const data = signInitData({ auth_date: Math.floor(now / 1000), user: { id: 7, first_name: 'Bot', is_bot: true } }, token);
  assert.equal(checkInitData(data, token, { now }).reason, 'NO_USER');
});
