/**
 * Аватарка бота и баннер приложения — собранные из настоящих карт игры.
 *
 *   node tools/make-avatar.mjs
 *
 * Почему не нейросетью. Сгенерированная картинка узнаётся мгновенно: мягкие
 * блики, «почти правильные» масти, лишние пальцы на рубашке. Здесь вместо
 * генерации — геометрия: тот же фетр, что на столе, те же карты из
 * miniapp/cards, те же цвета из style.css. Получается не «похоже на игру», а
 * буквально её кусок.
 *
 * Отдаёт в preview/brand/:
 *   avatar-512.png      — квадрат для @BotFather (в Telegram обрежется в круг)
 *   banner-640x360.png  — картинка мини-приложения (/newapp)
 *
 * Нужен Playwright с Chromium, как для tools/preview.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'preview', 'brand');
const CARDS = path.join(ROOT, 'miniapp', 'cards');

const card = (code) => fs.readFileSync(path.join(CARDS, `${code}.svg`), 'utf8');

/**
 * Фетр. Не плоская заливка: пятно света сверху слева и тёмные края — то же,
 * что на столе в игре, иначе карты висят в пустоте.
 */
const FELT = `
  background:
    radial-gradient(120% 90% at 30% 8%, #1c7a4f 0%, #11583a 42%, #0b3d28 70%, #071b12 100%);
`;

/** Одна карта: наклон, тень и тонкая тёмная кромка, чтобы белое не сливалось. */
const put = (code, { x, y, rot, w }) => `
  <div class="card" style="
    left:${x}px; top:${y}px; width:${w}px;
    transform: rotate(${rot}deg);
  ">${card(code)}</div>`;

const page = ({ w, h, cards, ring = false }) => `<!doctype html>
<meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${w}px; height:${h}px; overflow:hidden; }
  body { ${FELT} position:relative; }
  /* Крапинка сукна: чуть заметный шум, чтобы фон не выглядел «пластиковым». */
  .grain {
    position:absolute; inset:0; opacity:.16; mix-blend-mode:overlay;
    background-image:
      repeating-linear-gradient(45deg, rgba(255,255,255,.10) 0 1px, transparent 1px 3px),
      repeating-linear-gradient(-45deg, rgba(0,0,0,.10) 0 1px, transparent 1px 3px);
  }
  /* Золотая кромка по краю — та же, что у фишек и итогов в игре. */
  .ring {
    position:absolute; inset:0; border-radius:50%;
    box-shadow: inset 0 0 0 5px rgba(242,201,107,.5), inset 0 0 44px rgba(0,0,0,.5);
  }
  .card { position:absolute; transform-origin:50% 100%; filter: drop-shadow(0 10px 18px rgba(0,0,0,.55)); }
  .card svg { width:100%; height:auto; display:block; border-radius:6%; }
  .shine {
    position:absolute; inset:0;
    background: radial-gradient(70% 55% at 32% 6%, rgba(255,255,255,.14), transparent 60%);
    pointer-events:none;
  }
</style>
<div class="grain"></div>
${cards}
<div class="shine"></div>
${ring ? '<div class="ring"></div>' : ''}
`;

/*
 * Аватарка. Веер из трёх карт, туз спереди — силуэт узнаётся даже размером с
 * ноготь, а это единственное, что от аватарки требуется. Всё важное — в
 * середине: по кругу Telegram срежет углы.
 */
const avatar = page({
  w: 512, h: 512, ring: true,
  // Веер из одной точки: все три карты лежат в одном месте и отличаются только
  // поворотом вокруг нижнего края — так держат карты в руке. Ширина подобрана
  // так, чтобы веер целиком помещался в круг, которым Telegram обрежет углы.
  cards: [
    put('6H', { x: 164, y: 136, rot: -19, w: 185 }),
    put('KD', { x: 164, y: 136, rot: 0, w: 185 }),
    put('AS', { x: 164, y: 136, rot: 19, w: 185 }),
  ].join(''),
});

/*
 * Баннер приложения: карты справа, слева спокойное сукно — туда потом можно
 * положить подпись, не наезжая на карты.
 */
const banner = page({
  w: 640, h: 360,
  // Веер из той же точки, что и на аватарке, только из четырёх карт и мельче:
  // он должен целиком помещаться в кадр, а не упираться в край.
  cards: [
    put('6H', { x: 365, y: 103, rot: -27, w: 130 }),
    put('10S', { x: 365, y: 103, rot: -9, w: 130 }),
    put('KD', { x: 365, y: 103, rot: 9, w: 130 }),
    put('AS', { x: 365, y: 103, rot: 27, w: 130 }),
  ].join(''),
});

/**
 * «Как это увидят люди»: тот же кружок размером с аватарку в списке чатов, в
 * шапке и в профиле. Аватарку судят по маленькому кружку, а не по картинке
 * 512×512 — поэтому она и проверяется маленьким кружком.
 */
const proof = (dataUrl) => `<!doctype html><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:520px; height:200px; background:#17212b; display:flex; align-items:center;
         gap:28px; padding:0 30px; font-family:-apple-system, 'SF Pro Text', Arial, sans-serif; color:#8a9aa8; }
  .one { display:flex; flex-direction:column; align-items:center; gap:10px; }
  .one img { border-radius:50%; display:block; }
  .one span { font-size:11px; }
</style>
${[[108, 'профиль'], [54, 'список чатов'], [34, 'шапка'], [20, 'мелко']]
    .map(([px, label]) => `<div class="one"><img src="${dataUrl}" width="${px}" height="${px}"><span>${px}px · ${label}</span></div>`)
    .join('')}
`;

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const [name, html, w, h] of [
  ['avatar-512.png', avatar, 512, 512],
  ['banner-640x360.png', banner, 640, 360],
]) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(html);
  await p.waitForTimeout(120);
  await p.screenshot({ path: path.join(OUT, name) });
  await p.close();
  console.log(`· ${name}`);
}
// Кружки разного размера — на них и смотрим, прежде чем нести к @BotFather.
const shot = fs.readFileSync(path.join(OUT, 'avatar-512.png')).toString('base64');
const pv = await browser.newPage({ viewport: { width: 520, height: 200 }, deviceScaleFactor: 2 });
await pv.setContent(proof(`data:image/png;base64,${shot}`));
await pv.waitForTimeout(120);
await pv.screenshot({ path: path.join(OUT, 'kak-vyglyadit.png') });
await pv.close();
console.log('· kak-vyglyadit.png');

await browser.close();
console.log(`готово → ${path.relative(process.cwd(), OUT)}/`);
