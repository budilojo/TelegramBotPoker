'use strict';
/**
 * Setting one line in a `.env` file without touching the rest of it.
 *
 * The file is edited by a person: it has comments, blank lines and a token
 * that must survive untouched. So this is a line edit, not a rewrite of a
 * parsed object — everything that is not the key stays exactly as it was,
 * byte for byte.
 */

/** `KEY=value`, allowing `export KEY=…` and spaces around the sign. */
const lineFor = (key) => new RegExp(`^(\\s*(?:export\\s+)?${key})\\s*=.*$`);

/**
 * @returns the file's text with `KEY=value` set: the first real assignment is
 *          replaced, and if there is none, a new line is appended. A commented
 *          out `# KEY=…` is left alone — it is a hint, not a setting.
 */
export function setEnvValue(text, key, value) {
  const src = String(text ?? '');
  const lines = src.split('\n');
  const re = lineFor(key);
  const at = lines.findIndex((l) => re.test(l));
  if (at >= 0) {
    lines[at] = lines[at].replace(re, `$1=${value}`);
    return lines.join('\n');
  }
  // Appended at the end, on its own line, keeping the file's final newline.
  const tail = src.endsWith('\n') || src === '' ? '' : '\n';
  return `${src}${tail}${key}=${value}\n`;
}

/** The value of `KEY` in this text, or null. Comments and quotes are ignored. */
export function getEnvValue(text, key) {
  const re = lineFor(key);
  const line = String(text ?? '').split('\n').find((l) => re.test(l));
  if (line == null) return null;
  const raw = line.slice(line.indexOf('=') + 1).trim();
  return raw.replace(/^(['"])(.*)\1$/, '$2');
}
