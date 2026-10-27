/**
 * «На зубы» для графики «Графита»: в копию папки art/ вносится поломка, и
 * bot/collections.art.test.js (GRAPHIT_ART_DIR=копия) ОБЯЗАН упасть.
 * Целую папку проекта не трогаем. Выход 0 — все поломки поймали.
 *   node tools/graphit-art-teeth.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ART_DIR } from './build-graphit-art.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edit = (file, fn) => (dir) => { const p = path.join(dir, file); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); };

const BREAKS = [
  ['градиент в одном файле', edit('cardback-detail-petrol.svg', (t) => t.replace('<rect', '<linearGradient id="g"><stop offset="0"/></linearGradient><rect'))],
  ['фон-заливка через url(#g)', edit('cardback-small-graphite.svg', (t) => t.replace('fill="#20292E"', 'fill="url(#g)"'))],
  ['толщина линии в одном цвете', edit('cardback-small-bordeaux.svg', (t) => t.replace('stroke-width="5"', 'stroke-width="6"'))],
  ['цвет вне палитры', edit('mark-sapphire.svg', (t) => t.replace('#A6B5C8', '#D4AF37'))],
  ['цвет другого варианта', edit('mark-sapphire.svg', (t) => t.replace('#A6B5C8', '#B6BEC2'))],
  ['внешний href', edit('frame-small-petrol.svg', (t) => t.replace('<path', '<path href="https://example.com/x.svg"'))],
  ['элемент <image>', edit('thumb-table-graphite.svg', (t) => t.replace('</svg>', '<image href="data:image/png;base64,AAAA"/></svg>'))],
  ['скрипт', edit('mark-petrol.svg', (t) => t.replace('</svg>', '<script>alert(1)</script></svg>'))],
  ['тень (filter)', edit('table-diamond-graphite.svg', (t) => t.replace('<path', '<path filter="url(#s)"'))],
  ['прозрачность', edit('table-diamond-sapphire.svg', (t) => t.replace('<path', '<path opacity="0.5"'))],
  ['текст внутри SVG', edit('mark-graphite.svg', (t) => t.replace('</svg>', '<text>Ж</text></svg>'))],
  ['другой viewBox в одном цвете', edit('frame-detail-bordeaux.svg', (t) => t.replace('viewBox="0 0 120 120"', 'viewBox="0 0 121 120"'))],
  ['сдвиг элемента в одном цвете', edit('cardback-detail-sapphire.svg', (t) => t.replace('x="6"', 'x="7"'))],
  ['раздутый файл', edit('bundle-graphite.svg', (t) => t.replace('</svg>', `<!--${'x'.repeat(9000)}-->` + '</svg>'))],
  ['пропал файл', (dir) => fs.rmSync(path.join(dir, 'mark-petrol.svg'))],
  ['лишний файл', (dir) => fs.writeFileSync(path.join(dir, 'extra.svg'), '<svg/>')],
  ['файл изменён, манифест старый', edit('thumb-profile-petrol.svg', (t) => t.replace('</svg>', '<path d="M0 0" fill="none"/></svg>'))],
  ['рамка залита по центру', edit('frame-small-graphite.svg', (t) => t.replace('</svg>', '<circle cx="60" cy="60" r="30" fill="#20292E"/></svg>'))],
  ['рамка заходит на аватар', edit('frame-detail-petrol.svg', (t) => t.replace(/<circle cx="60" cy="60" r="[\d.]+"/, '<circle cx="60" cy="60" r="40"'))],
  ['декор не скрыт от чтения', edit('mark-bordeaux.svg', (t) => t.replace(' aria-hidden="true"', ''))],
];

let bad = 0;
for (const [name, brk] of BREAKS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphit-teeth-'));
  try {
    fs.cpSync(ART_DIR, dir, { recursive: true });
    brk(dir);
    const r = spawnSync(process.execPath, ['--test', '--disable-warning=ExperimentalWarning', 'bot/collections.art.test.js'], { cwd: ROOT, env: { ...process.env, GRAPHIT_ART_DIR: dir }, encoding: 'utf8' });
    const caught = r.status !== 0;
    if (!caught) bad++;
    console.log(`${caught ? 'ПОЙМАНО' : 'НЕ ПОЙМАНО'}  ${name}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// Контрольный прогон: без поломок тест зелёный.
const ok = spawnSync(process.execPath, ['--test', '--disable-warning=ExperimentalWarning', 'bot/collections.art.test.js'], { cwd: ROOT, encoding: 'utf8' });
console.log(`без поломок: ${ok.status === 0 ? 'зелёный' : 'КРАСНЫЙ'}`);
process.exit(bad || ok.status !== 0 ? 1 : 0);
