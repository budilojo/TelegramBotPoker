'use strict';
/**
 * Formatting helpers for the table message. Pure, no Telegram imports.
 *
 * Everything here exists because the table is rendered inside a <pre> block:
 * columns must line up on a phone, and names come from Telegram, which means
 * they can contain HTML-special characters, emoji and control codes.
 */

/** 7550 -> "7 550". Used everywhere money is shown. */
export function num(n) {
  const v = Math.round(Number(n) || 0);
  const s = String(Math.abs(v));
  const parts = [];
  for (let i = s.length; i > 0; i -= 3) parts.unshift(s.slice(Math.max(0, i - 3), i));
  return (v < 0 ? '−' : '') + parts.join(' ');
}

/** Signed, for the P/L column: +1 200 / −450 / 0. */
export function signed(n) {
  const v = Math.round(Number(n) || 0);
  if (v === 0) return '0';
  return (v > 0 ? '+' : '') + num(v);
}

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/gu;

/**
 * Telegram first_name is free-form. Strip control characters (they would let
 * someone inject RTL overrides into the table) and cap the length.
 */
export function cleanName(raw, fallback = 'Игрок', max = 16) {
  const s = [...String(raw ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()]
    .slice(0, max)
    .join('')
    .trim();
  return s || fallback;
}

/**
 * Monospace column width of a string. Emoji and CJK occupy two cells in the
 * fonts Telegram uses for <pre>, so counting code points is not enough.
 */
export function visualWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f || cp === 0x200d) continue; // variation selector / ZWJ
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf)
  );
}

/** Cut to `width` monospace cells, adding an ellipsis when it does not fit. */
function clip(s, width) {
  if (visualWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of String(s)) {
    const cw = visualWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

export function padEnd(s, width) {
  const t = clip(s, width);
  return t + ' '.repeat(Math.max(0, width - visualWidth(t)));
}

export function padStart(s, width) {
  const t = clip(s, width);
  return ' '.repeat(Math.max(0, width - visualWidth(t))) + t;
}

/** 14:31 in the table's timezone. */
export function hhmm(ts, tz = process.env.TZ || undefined) {
  const d = new Date(ts);
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz,
    }).format(d);
  } catch {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

export const STREET_RU = {
  preflop: 'ПРЕФЛОП',
  flop: 'ФЛОП',
  turn: 'ТЁРН',
  river: 'РИВЕР',
};

/** Engine `lastAction` codes -> what the table shows next to a player. */
export const ACTION_RU = {
  FOLD: 'fold',
  CHECK: 'check',
  CALL: 'call',
  BET: 'bet',
  RAISE: 'raise',
  'ALL-IN': 'all-in',
  SB: 'SB',
  BB: 'BB',
};
