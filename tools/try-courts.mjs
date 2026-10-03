/**
 * Примерка придворных карт: рисунок владельца — в настоящий шаблон карты,
 * в настоящих размерах.
 *
 *   node tools/try-courts.mjs   → design/cards-test.png
 *
 * Проверяется ровно одно, и глазами это не проверить: читается ли карта,
 * когда она маленькая. За столом карта соперника — 40 px шириной, своя в
 * руке — 74, открытая крупно — 110. Красивый рисунок, который на 40 px
 * превращается в кашу, игре не годится.
 *
 * Белый фон вокруг фигуры снимается заливкой ОТ КРАЯ, а не «всё белое
 * прозрачным»: внутри фигуры белого полно — лица, горностай, просветы
 * орнамента, — и глобальная прозрачность пробила бы в них дыры.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ART = path.join(ROOT, 'design', 'cards-art');
const OUT = path.join(ROOT, 'design');

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

const b64 = (f) => `data:image/webp;base64,${fs.readFileSync(path.join(ART, f)).toString('base64')}`;
const art = {
  korol: b64('korol.webp'),
  dama: b64('dama.webp'),
  valet: b64('valet.webp'),
  tuz: b64('tuz-pik.webp'),
  rubashka: b64('rubashka.webp'),
};

const page = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; background: #0A1216; color: #A9BCC0; font: 12px Inter, sans-serif; padding: 18px; }
  h2 { color: #F2F7F5; font-size: 14px; margin: 18px 0 8px; }
  .row { display: flex; align-items: flex-end; gap: 14px; margin-bottom: 6px; }
  .cap { color: #6E858B; font-size: 10px; margin-top: 4px; text-align: center; }
  .card { position: relative; background: #F7F4EC; border-radius: 7%; box-shadow: 0 2px 6px rgba(0,0,0,.5); overflow: hidden; }
  .card canvas { position: absolute; left: 11%; top: 11%; width: 78%; height: 78%; object-fit: contain; }
  .ix { position: absolute; font-weight: 800; line-height: .95; text-align: center; }
  .ix.tl { left: 4%; top: 3%; }
  .ix.br { right: 4%; bottom: 3%; transform: rotate(180deg); }
  .felt { background: radial-gradient(90% 70% at 50% 40%, #1E6E7E, #0A2E39); padding: 14px; border-radius: 14px; display: inline-block; }
</style>
<body><div id="app"></div>
<script>
/** Снять белое ВОКРУГ фигуры: заливка от краёв, внутренние белые не трогаем. */
async function cut(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height);
  const p = d.data, W = c.width, H = c.height;
  const white = (i) => p[i] > 238 && p[i + 1] > 238 && p[i + 2] > 238;
  const seen = new Uint8Array(W * H);
  const stack = [];
  for (let i = 0; i < W; i++) { stack.push(i, (H - 1) * W + i); }
  for (let j = 0; j < H; j++) { stack.push(j * W, j * W + W - 1); }
  while (stack.length) {
    const k = stack.pop();
    if (seen[k]) continue;
    const i = k * 4;
    if (!white(i)) continue;
    seen[k] = 1;
    p[i + 3] = 0;
    const cx = k % W, cy = (k / W) | 0;
    if (cx > 0) stack.push(k - 1);
    if (cx < W - 1) stack.push(k + 1);
    if (cy > 0) stack.push(k - W);
    if (cy < H - 1) stack.push(k + W);
  }
  x.putImageData(d, 0, 0);
  return c;
}

const ART = ${JSON.stringify(art)};
const RED = '#d4283b', BLACK = '#161a20';

async function card(w, rank, suit, who) {
  const el = document.createElement('div');
  el.className = 'card';
  el.style.width = w + 'px';
  el.style.height = Math.round(w * 1.4) + 'px';
  const ink = (suit === '♥' || suit === '♦') ? RED : BLACK;
  const cv = await cut(ART[who]);
  cv.style.filter = (suit === '♥' || suit === '♦') ? 'none' : 'none';
  el.appendChild(cv);
  for (const cls of ['tl', 'br']) {
    const ix = document.createElement('div');
    ix.className = 'ix ' + cls;
    ix.style.color = ink;
    ix.style.fontSize = Math.round(w * 0.22) + 'px';
    ix.innerHTML = rank + '<br>' + suit;
    el.appendChild(ix);
  }
  return el;
}

const app = document.getElementById('app');
function head(t) { const h = document.createElement('h2'); h.textContent = t; app.appendChild(h); }
function row() { const r = document.createElement('div'); r.className = 'row'; app.appendChild(r); return r; }
function cap(el, t) {
  const box = document.createElement('div');
  const c = document.createElement('div');
  c.className = 'cap'; c.textContent = t;
  box.appendChild(el); box.appendChild(c);
  return box;
}

(async () => {
  head('Как карта выглядит в игре');
  const r1 = row();
  for (const [w, t] of [[40, '40 px — карта соперника'], [74, '74 px — своя в руке'], [110, '110 px — открытая'], [170, '170 px — крупно']]) {
    r1.appendChild(cap(await card(w, 'К', '♥', 'korol'), t));
  }
  head('Три фигуры рядом — одна ли это колода');
  const r2 = row();
  r2.appendChild(cap(await card(110, 'К', '♠', 'korol'), 'король пик'));
  r2.appendChild(cap(await card(110, 'Д', '♥', 'dama'), 'дама червей'));
  r2.appendChild(cap(await card(110, 'В', '♦', 'valet'), 'валет бубён'));
  r2.appendChild(cap(await card(110, 'Т', '♠', 'tuz'), 'туз пик'));

  head('На сукне, как за столом');
  const felt = document.createElement('div');
  felt.className = 'felt';
  const r3 = document.createElement('div');
  r3.className = 'row';
  felt.appendChild(r3);
  app.appendChild(felt);
  for (const [rank, suit, who] of [['К', '♠', 'korol'], ['Д', '♥', 'dama'], ['В', '♦', 'valet'], ['Т', '♠', 'tuz']]) {
    r3.appendChild(await card(74, rank, suit, who));
  }
  const back = document.createElement('div');
  back.className = 'card';
  back.style.cssText = 'width:74px;height:104px;background:url(' + ART.rubashka + ') center/cover';
  r3.appendChild(back);

  document.body.dataset.done = '1';
})();
</script>`;

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 760, height: 900 }, deviceScaleFactor: 2 });
p.on('pageerror', (e) => console.log('ошибка страницы:', e.message));
await p.setContent(page);
await p.waitForSelector('body[data-done="1"]', { timeout: 30_000 });
await p.screenshot({ path: path.join(OUT, 'cards-test.png'), fullPage: true });
await browser.close();
console.log('примерка → design/cards-test.png');
