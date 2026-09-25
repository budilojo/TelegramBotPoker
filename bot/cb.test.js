'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, argInt, MAX_BYTES, NS } from './cb.js';

test('round-trips a payload', () => {
  assert.equal(encode(NS.ACT, 'raise', 37, 500), 'a:raise:37:500');
  assert.deepEqual(decode('a:raise:37:500'), { ns: 'a', verb: 'raise', seq: 37, args: ['500'] });
  assert.equal(argInt(decode('a:raise:37:500').args, 0), 500);
});

test('refuses to build anything Telegram would reject', () => {
  assert.throws(() => encode(NS.ACT, 'raise', 1, 'x'.repeat(80)), /too long/);
  // The realistic worst case still fits comfortably.
  const worst = encode(NS.WIN, 'pick', 999999, 9, 99);
  assert.ok(Buffer.byteLength(worst, 'utf8') <= MAX_BYTES, worst);
});

test('decoding never throws on hostile input', () => {
  for (const junk of [null, undefined, '', 'a', 'a:b', 'a:b:c', ':::', 'a::1', ':x:1', 42, {}, 'a:b:-1', 'a:b:1.5']) {
    assert.equal(decode(junk), null, `decode(${JSON.stringify(junk)}) should be null`);
  }
  assert.equal(decode('a:raise:' + '9'.repeat(70)), null, 'oversized payloads are dropped');
});

test('extra colons in arguments do not confuse the parser', () => {
  assert.deepEqual(decode('w:pick:7:0:3'), { ns: 'w', verb: 'pick', seq: 7, args: ['0', '3'] });
});

test('argInt is NaN-safe', () => {
  assert.equal(argInt(['abc'], 0), null);
  assert.equal(argInt([], 0), null);
  assert.equal(argInt(['0'], 0), 0);
  assert.equal(argInt(['12'], 0), 12);
});
