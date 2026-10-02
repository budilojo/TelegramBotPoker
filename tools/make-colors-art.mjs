/**
 * Знаки особых карт «Радуги» и рубашка — кодом, а не генератором.
 *
 *   node tools/make-colors-art.mjs   → design/colors/*.svg + design/colors.png
 *
 * Почему кодом: все четыре знака — это окружности и прямые. Генератор на
 * каждый запрос даёт свою толщину линии, свои поля и свой оттенок; на столе
 * они лежат рядом, и разнобой видно сразу. Здесь толщина, поля и цвета
 * заданы числами — значит одинаковы всегда.
 *
 * Знак обязан читаться дважды: крупно в центре карты и в углу размером с
 * ноготь. Поэтому линии толстые, форм мало, мелких деталей нет совсем.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'design', 'colors');

/** Цвета игры. Тёмный — контур и всё, что не цветное. */
const C = { red: '#E04A3F', yellow: '#F2B22E', green: '#2FA355', blue: '#2D6FD8', ink: '#16181D', deep: '#1B2A4A' };

const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>\n`;

/* «+2»: две карты веером и плюс. Цифру ставит код карты, не картинка. */
const plus2 = svg(120, 120, `
  <g fill="#fff" stroke="${C.ink}" stroke-width="8" stroke-linejoin="round">
    <rect x="8" y="26" width="40" height="58" rx="8" transform="rotate(-12 28 55)"/>
    <rect x="30" y="32" width="40" height="58" rx="8" transform="rotate(9 50 61)"/>
  </g>
  <g stroke-linecap="round">
    <path d="M95 26v38M76 45h38" stroke="#fff" stroke-width="26"/>
    <path d="M95 26v38M76 45h38" stroke="${C.ink}" stroke-width="13"/>
  </g>`);

/* «Стоп»: перечёркнутый круг — знак «тебе сюда нельзя». */
const stop = svg(120, 120, `
  <g fill="none" stroke="${C.ink}" stroke-width="11" stroke-linecap="round">
    <circle cx="60" cy="60" r="38"/>
    <path d="M33 33l54 54"/>
  </g>`);

/* «Разворот»: две стрелки навстречу друг другу по кругу. */
const reverse = svg(120, 120, `
  <g fill="none" stroke="${C.ink}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
    <path d="M26 72a34 34 0 0 1 60-27"/>
    <path d="M94 48a34 34 0 0 1-60 27"/>
    <path d="M86 25v20H66"/>
    <path d="M34 95V75h20"/>
  </g>`);

/* «Смена цвета»: четыре капли краски кругом — единственный цветной знак. */
const wild = svg(120, 120, `
  <g stroke="#fff" stroke-width="5">
    <path d="M60 60 60 16A44 44 0 0 1 104 60Z" fill="${C.red}"/>
    <path d="M60 60h44A44 44 0 0 1 60 104Z" fill="${C.yellow}"/>
    <path d="M60 60v44A44 44 0 0 1 16 60Z" fill="${C.green}"/>
    <path d="M60 60H16A44 44 0 0 1 60 16Z" fill="${C.blue}"/>
  </g>
  <circle cx="60" cy="60" r="44" fill="none" stroke="${C.ink}" stroke-width="7"/>`);

/* Рубашка: мазки четырёх цветов из центра. Узор без верха и низа — его можно
   обрезать как угодно, и он останется собой. */
const back = svg(200, 280, `
  <rect width="200" height="280" rx="14" fill="${C.deep}"/>
  <g fill="none" stroke-width="13" stroke-linecap="round" opacity=".95">
    ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
      const a = (i * Math.PI) / 4;
      const col = [C.red, C.yellow, C.green, C.blue][i % 4];
      const x = 100 + Math.cos(a) * 112;
      const y = 140 + Math.sin(a) * 112;
      const cx = 100 + Math.cos(a + 0.5) * 62;
      const cy = 140 + Math.sin(a + 0.5) * 62;
      return `<path d="M100 140Q${cx.toFixed(0)} ${cy.toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)}" stroke="${col}"/>`;
    }).join('')}
  </g>
  <circle cx="100" cy="140" r="26" fill="${C.deep}" stroke="#fff" stroke-width="6"/>
  <rect x="5" y="5" width="190" height="270" rx="12" fill="none" stroke="#fff" stroke-width="7" opacity=".9"/>`);

const files = { 'plus2.svg': plus2, 'stop.svg': stop, 'reverse.svg': reverse, 'wild.svg': wild, 'back.svg': back };
fs.mkdirSync(OUT, { recursive: true });
for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), body);

/* Лист на проверку: те же знаки крупно, на карте и в углу — где им и жить. */
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const card = (color, sign, size) => `
  <div class="card ${color}" style="--w:${size}px">
    <div class="corner">${sign}</div>
    <div class="mid">${sign}</div>
  </div>`;

const page = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#0F1A14;font:14px -apple-system,system-ui,sans-serif;color:#cfe3d6;padding:28px}
  h2{font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;opacity:.6;margin:26px 0 12px}
  .row{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}
  .card{width:var(--w);aspect-ratio:2/3;border-radius:calc(var(--w)/9);background:#fff;position:relative;
        box-shadow:0 6px 18px rgba(0,0,0,.45);overflow:hidden}
  .card.red{background:${C.red}}.card.yellow{background:${C.yellow}}
  .card.green{background:${C.green}}.card.blue{background:${C.blue}}
  .card::after{content:"";position:absolute;inset:6%;border-radius:calc(var(--w)/12);background:#fff}
  .mid{position:absolute;inset:0;display:grid;place-items:center;z-index:2}
  .mid img{width:56%}
  .corner{position:absolute;top:5%;left:6%;width:20%;z-index:3}
  .corner img{width:100%}
  .plain{display:flex;gap:18px;background:#fff;padding:18px;border-radius:14px}
  .plain img{width:96px}
</style>
<h2>Знаки сами по себе</h2>
<div class="plain">
  <img src="plus2.svg"><img src="stop.svg"><img src="reverse.svg"><img src="wild.svg">
</div>
<h2>На карте: 170, 110, 74 и 40 пикселей — как в игре</h2>
<div class="row">
  ${[170, 110, 74, 40].map((s) => card('red', '<img src="plus2.svg">', s)).join('')}
  ${[170, 110, 74, 40].map((s) => card('blue', '<img src="stop.svg">', s)).join('')}
</div>
<div class="row" style="margin-top:14px">
  ${[170, 110, 74, 40].map((s) => card('green', '<img src="reverse.svg">', s)).join('')}
  ${[170, 110, 74, 40].map((s) => card('yellow', '<img src="wild.svg">', s)).join('')}
</div>
<h2>Рубашка</h2>
<div class="row">
  <img src="back.svg" style="width:170px;border-radius:14px">
  <img src="back.svg" style="width:110px;border-radius:10px">
  <img src="back.svg" style="width:74px;border-radius:7px">
  <img src="back.svg" style="width:40px;border-radius:4px">
</div>`;

fs.writeFileSync(path.join(OUT, 'sheet.html'), page);
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 980, height: 900 }, deviceScaleFactor: 2 });
await p.goto(`file://${path.join(OUT, 'sheet.html')}`);
await p.screenshot({ path: path.join(ROOT, 'design', 'colors.png'), fullPage: true });
await browser.close();
console.log('готово:', Object.keys(files).join(', '), '→ design/colors.png');
