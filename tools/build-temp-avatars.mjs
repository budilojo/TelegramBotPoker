// Временные аватарки av01…av12: плоские значки зверей на цветном фоне.
// Пока владелец не сгенерировал настоящие PNG (docs/next-wave-2/images-avatars.md),
// клиент берёт их. Запуск: node tools/build-temp-avatars.mjs
// Только плоские заливки, без градиентов и без золота. Фон — как в таблице промптов.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'miniapp', 'avatars');
const DARK = '#10181C';
const WHITE = '#F2F7F5';
const eye = (x, y, r = 5) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${DARK}"/>`;
const bigEye = (x, y, r, pr, fill = WHITE) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/><circle cx="${x}" cy="${y}" r="${pr}" fill="${DARK}"/>`;

const A = {
  av01: ['#2F5D7C', 'лиса', `
    <path d="M22 58 L32 14 L58 42 L70 42 L96 14 L106 58 Q106 104 64 112 Q22 104 22 58Z" fill="#E8803A"/>
    <path d="M32 24 L34 44 L48 38Z M96 24 L94 44 L80 38Z" fill="#3A2418"/>
    <path d="M26 70 Q64 64 102 70 Q94 106 64 112 Q34 106 26 70Z" fill="${WHITE}"/>
    ${eye(48, 62)}${eye(80, 62)}<circle cx="64" cy="92" r="6" fill="${DARK}"/>`],
  av02: ['#6A4C7D', 'сова', `
    <path d="M28 40 L40 22 L52 38Z M100 40 L88 22 L76 38Z" fill="#8B5E3C"/>
    <ellipse cx="64" cy="68" rx="40" ry="42" fill="#8B5E3C"/>
    <ellipse cx="64" cy="82" rx="26" ry="22" fill="#F0DEBB"/>
    ${bigEye(46, 62, 17, 8, '#F0DEBB')}${bigEye(82, 62, 17, 8, '#F0DEBB')}
    <path d="M58 72 L70 72 L64 86Z" fill="#E8803A"/>`],
  av03: ['#8A5A44', 'медведь', `
    <circle cx="32" cy="38" r="14" fill="#5A3A29"/><circle cx="96" cy="38" r="14" fill="#5A3A29"/>
    <circle cx="64" cy="68" r="40" fill="#5A3A29"/>
    <ellipse cx="64" cy="82" rx="20" ry="15" fill="#D9B38C"/>
    ${eye(48, 60)}${eye(80, 60)}<ellipse cx="64" cy="77" rx="7" ry="5" fill="${DARK}"/>`],
  av04: ['#3E7C6E', 'кот', `
    <path d="M26 62 L30 18 L56 40 L72 40 L98 18 L102 62 Q102 104 64 110 Q26 104 26 62Z" fill="#8E9AA3"/>
    <path d="M32 28 L34 42 L46 38Z M96 28 L94 42 L82 38Z" fill="#E8A9B4"/>
    <ellipse cx="64" cy="88" rx="22" ry="17" fill="${WHITE}"/>
    ${bigEye(47, 62, 10, 4, '#8BD19A')}${bigEye(81, 62, 10, 4, '#8BD19A')}
    <path d="M58 80 L70 80 L64 87Z" fill="#E8A9B4"/>`],
  av06: ['#5C6B4A', 'енот', `
    <circle cx="34" cy="36" r="12" fill="#A9B0B4"/><circle cx="94" cy="36" r="12" fill="#A9B0B4"/>
    <circle cx="64" cy="68" r="40" fill="#C3C9CC"/>
    <path d="M24 56 Q64 44 104 56 L100 78 Q64 68 28 78Z" fill="#2B3236"/>
    ${bigEye(46, 64, 7, 3.5)}${bigEye(82, 64, 7, 3.5)}
    <ellipse cx="64" cy="88" rx="16" ry="12" fill="${WHITE}"/><circle cx="64" cy="84" r="5" fill="${DARK}"/>`],
  av07: ['#C0623F', 'лягушка', `
    <ellipse cx="64" cy="72" rx="46" ry="38" fill="#5FB36A"/>
    <circle cx="40" cy="40" r="16" fill="#5FB36A"/><circle cx="88" cy="40" r="16" fill="#5FB36A"/>
    ${bigEye(40, 40, 11, 5)}${bigEye(88, 40, 11, 5)}
    <path d="M32 80 Q64 106 96 80" fill="none" stroke="${DARK}" stroke-width="5" stroke-linecap="round"/>
    <circle cx="56" cy="64" r="2.5" fill="${DARK}"/><circle cx="72" cy="64" r="2.5" fill="${DARK}"/>`],
  av08: ['#4B6A9B', 'пингвин', `
    <ellipse cx="64" cy="72" rx="40" ry="44" fill="#1F2A3A"/>
    <ellipse cx="64" cy="82" rx="28" ry="34" fill="${WHITE}"/>
    ${bigEye(50, 58, 8, 4)}${bigEye(78, 58, 8, 4)}
    <path d="M54 72 L74 72 L64 86Z" fill="#E8803A"/>`],
  av09: ['#9C5B7B', 'кролик', `
    <ellipse cx="46" cy="30" rx="11" ry="28" fill="#EDE6EA"/><ellipse cx="82" cy="30" rx="11" ry="28" fill="#EDE6EA"/>
    <ellipse cx="46" cy="32" rx="5" ry="20" fill="#E8A9B4"/><ellipse cx="82" cy="32" rx="5" ry="20" fill="#E8A9B4"/>
    <circle cx="64" cy="78" r="34" fill="#EDE6EA"/>
    ${eye(50, 72)}${eye(78, 72)}<path d="M59 84 L69 84 L64 90Z" fill="#E8A9B4"/>`],
  av10: ['#B0713B', 'тигр', `
    <circle cx="32" cy="38" r="13" fill="#E58A2F"/><circle cx="96" cy="38" r="13" fill="#E58A2F"/>
    <circle cx="64" cy="68" r="40" fill="#E58A2F"/>
    <path d="M64 30 L64 46 M52 32 L56 46 M76 32 L72 46 M26 66 L40 68 M28 80 L40 78 M102 66 L88 68 M100 80 L88 78" stroke="${DARK}" stroke-width="5" stroke-linecap="round"/>
    <ellipse cx="64" cy="86" rx="22" ry="16" fill="${WHITE}"/>
    ${eye(49, 62)}${eye(79, 62)}<path d="M58 80 L70 80 L64 88Z" fill="${DARK}"/>`],
  av11: ['#3C6B5A', 'панда', `
    <circle cx="32" cy="36" r="14" fill="${DARK}"/><circle cx="96" cy="36" r="14" fill="${DARK}"/>
    <circle cx="64" cy="68" r="40" fill="${WHITE}"/>
    <ellipse cx="47" cy="64" rx="11" ry="14" fill="${DARK}" transform="rotate(20 47 64)"/><ellipse cx="81" cy="64" rx="11" ry="14" fill="${DARK}" transform="rotate(-20 81 64)"/>
    <circle cx="48" cy="63" r="4" fill="${WHITE}"/><circle cx="80" cy="63" r="4" fill="${WHITE}"/>
    <ellipse cx="64" cy="84" rx="8" ry="6" fill="${DARK}"/>`],
  av12: ['#7B4F9E', 'осьминог', `
    <path d="M22 78 Q22 22 64 22 Q106 22 106 78 L106 92 Q98 106 92 92 Q88 108 78 94 Q72 110 64 96 Q56 110 50 94 Q40 108 36 92 Q30 106 22 92Z" fill="#5AA9B8"/>
    ${bigEye(46, 62, 12, 6)}${bigEye(82, 62, 12, 6)}
    <path d="M52 82 Q64 92 76 82" fill="none" stroke="${DARK}" stroke-width="4" stroke-linecap="round"/>`],
};

fs.mkdirSync(out, { recursive: true });
for (const [id, [bg, title, body]] of Object.entries(A)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img"><title>${title}</title><rect width="128" height="128" fill="${bg}"/>${body.replace(/\n\s*/g, '')}</svg>\n`;
  fs.writeFileSync(path.join(out, `${id}.svg`), svg);
}
console.log(`готово: ${Object.keys(A).length} файлов в ${out}`);
