'use strict';
/**
 * То, что человек должен прочитать, а не пролистать: черта сверху, черта
 * снизу, отступ слева.
 *
 * Правой стенки намеренно нет. Ширина эмодзи на экране зависит от терминала —
 * одни рисуют ✅ в одну клетку, другие в две, — и рамка со всех сторон у
 * половины из них выходит кривой. Черта сверху и снизу кривой не бывает.
 */
import { visualWidth } from '../bot/fmt.js';

/** Не шире окна терминала (и не уже, чем нужно для самой длинной строки). */
const MAX = 76;

/** @returns {string[]} строки рамки — печатать их отдельно, чтобы можно было проверить */
export function frame(lines) {
  const width = Math.min(Math.max(0, ...lines.map(visualWidth)) + 2, MAX);
  const rule = '─'.repeat(width);
  return ['', rule, ...lines.map((l) => (l ? ` ${l}` : '')), rule, ''];
}

export const banner = (lines) => console.log(frame(lines).join('\n'));
