'use strict';
/**
 * `callback_data` codec.
 *
 * Telegram caps callback_data at 64 BYTES, so nothing structured goes in
 * there — no JSON, no Telegram ids (10-13 digits each). The format is
 * `<ns>:<verb>:<seq>[:arg[:arg]]`, where `seq` is the room's monotonic
 * counter at render time. A button rendered against an older state carries
 * an older seq and is refused, which is what makes a double tap harmless.
 *
 * Players are addressed by SEAT INDEX, not by id: two bytes instead of
 * thirteen. A seat index can only go stale if the seat list changed, and any
 * change bumps `seq`, so a stale index can never be applied.
 */

export const MAX_BYTES = 64;

export function encode(ns, verb, seq, ...args) {
  const data = [ns, verb, seq, ...args].join(':');
  const size = Buffer.byteLength(data, 'utf8');
  if (size > MAX_BYTES) {
    throw new Error(`callback_data too long (${size}B > ${MAX_BYTES}): ${data}`);
  }
  return data;
}

/**
 * @returns {{ns:string, verb:string, seq:number, args:string[]}|null}
 *          null for anything malformed — never throws on user input.
 */
export function decode(data) {
  if (typeof data !== 'string' || !data) return null;
  if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) return null;
  const parts = data.split(':');
  if (parts.length < 3) return null;
  const [ns, verb, rawSeq, ...args] = parts;
  if (!ns || !verb) return null;
  const seq = Number(rawSeq);
  if (!Number.isInteger(seq) || seq < 0) return null;
  return { ns, verb, seq, args };
}

/** Parse a positional integer argument; NaN-safe. */
export function argInt(args, i) {
  const n = Number(args[i]);
  return Number.isInteger(n) ? n : null;
}

/* Namespaces kept as constants so the handler table and the renderer cannot
   drift apart on a typo. */
export const NS = {
  ACT: 'a', // betting actions
  LOBBY: 'j', // sit down / leave
  GAME: 'g', // start, next hand, pause
  CARDS: 'c', // "my cards" — answered privately to whoever pressed
  HOST: 'h', // host panels: kick, re-buy, hand over
};
