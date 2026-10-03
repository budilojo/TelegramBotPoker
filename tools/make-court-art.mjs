/**
 * Готовит рисунки придворных карт к вшиванию в колоду.
 *
 *   node tools/make-court-art.mjs   → tools/court-art.json
 *
 * Что здесь делается и почему именно так:
 *
 *   1. БЕЛЫЙ ФОН СНИМАЕТСЯ ЗАЛИВКОЙ ОТ КРАЯ, а не «всё белое прозрачным».
 *      Внутри фигуры белого полно — лица, горностай, просветы орнамента; от
 *      глобальной прозрачности в них были бы дыры.
 *   2. РИСУНОК ОБРЕЗАЕТСЯ ПО СОДЕРЖИМОМУ. У сгенерированных картинок поля
 *      разные; если не обрезать, король встанет на карте выше дамы.
 *   3. РАЗМЕР ДАВИТСЯ ДО НУЖНОГО. Карта в игре не шире 170 px, значит
 *      рисунок в 300 px по ширине — с запасом на экраны с двойной точкой.
 *   4. НА ВЫХОДЕ base64, а не файлы рядом. Карта грузится как <img src=…svg>,
 *      а SVG внутри <img> не имеет права тянуть внешние картинки — только то,
 *      что лежит в нём самом.
 *
 * Делается браузером: своего декодера webp и кодировщика в Node нет, а
 * Chromium здесь и так есть — им же снимаются все остальные скриншоты.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ART = path.join(ROOT, 'design', 'cards-art');
const OUT = path.join(ROOT, 'tools', 'court-art.json');

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

/** Что берём, как широко и нужно ли снимать фон. */
const PLAN = [
  { key: 'korol', file: 'korol.webp', width: 300, cut: true },
  { key: 'dama', file: 'dama.webp', width: 300, cut: true },
  { key: 'valet', file: 'valet.webp', width: 300, cut: true },
  { key: 'tuzPik', file: 'tuz-pik.webp', width: 260, cut: true },
  { key: 'rubashka', file: 'rubashka.webp', width: 220, cut: false, ratio: 280 / 200 },
];

const src = Object.fromEntries(
  PLAN.map((p) => [p.key, `data:image/webp;base64,${fs.readFileSync(path.join(ART, p.file)).toString('base64')}`])
);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('ошибка страницы:', e.message));

const built = await page.evaluate(async ({ src, plan }) => {
  const out = {};
  for (const p of plan) {
    const img = new Image();
    img.src = src[p.key];
    await img.decode();

    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0);

    let box = { l: 0, t: 0, r: c.width, b: c.height };

    if (p.cut) {
      const d = x.getImageData(0, 0, c.width, c.height);
      const px = d.data;
      const W = c.width;
      const H = c.height;
      const white = (i) => px[i] > 238 && px[i + 1] > 238 && px[i + 2] > 238;
      const seen = new Uint8Array(W * H);
      const stack = [];
      for (let i = 0; i < W; i++) stack.push(i, (H - 1) * W + i);
      for (let j = 0; j < H; j++) stack.push(j * W, j * W + W - 1);
      while (stack.length) {
        const k = stack.pop();
        if (seen[k]) continue;
        const i = k * 4;
        if (!white(i)) continue;
        seen[k] = 1;
        px[i + 3] = 0;
        const cx = k % W;
        const cy = (k / W) | 0;
        if (cx > 0) stack.push(k - 1);
        if (cx < W - 1) stack.push(k + 1);
        if (cy > 0) stack.push(k - W);
        if (cy < H - 1) stack.push(k + W);
      }
      x.putImageData(d, 0, 0);

      // Обрезать по содержимому: поля у сгенерированных картинок разные.
      let l = W; let t = H; let r = 0; let b = 0;
      for (let cy = 0; cy < H; cy++) {
        for (let cx = 0; cx < W; cx++) {
          if (px[(cy * W + cx) * 4 + 3] > 8) {
            if (cx < l) l = cx;
            if (cx > r) r = cx;
            if (cy < t) t = cy;
            if (cy > b) b = cy;
          }
        }
      }
      box = { l, t, r: r + 1, b: b + 1 };
    }

    const sw = box.r - box.l;
    const sh = box.b - box.t;
    const w = p.width;
    const h = Math.round(p.ratio ? w * p.ratio : (w * sh) / sw);

    const o = document.createElement('canvas');
    o.width = w;
    o.height = h;
    const ox = o.getContext('2d');
    ox.imageSmoothingQuality = 'high';
    if (p.ratio) {
      // Рубашка кроется по месту: узор без верха и низа, обрезать можно как угодно.
      const k = Math.max(w / sw, h / sh);
      const dw = sw * k;
      const dh = sh * k;
      ox.drawImage(c, box.l, box.t, sw, sh, (w - dw) / 2, (h - dh) / 2, dw, dh);
    } else {
      ox.drawImage(c, box.l, box.t, sw, sh, 0, 0, w, h);
    }
    out[p.key] = { data: o.toDataURL('image/webp', 0.86), w, h };
  }
  return out;
}, { src, plan: PLAN });

await browser.close();

fs.writeFileSync(OUT, `${JSON.stringify(built, null, 0)}\n`);
const kb = (s) => Math.round((s.length * 0.75) / 1024);
console.log(
  Object.entries(built)
    .map(([k, v]) => `${k}: ${v.w}×${v.h}, ~${kb(v.data)} КБ`)
    .join('\n')
);
