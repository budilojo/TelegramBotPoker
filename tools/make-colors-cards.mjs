/**
 * Собирает 54 лица «Радуги» и рубашку для мини-приложения:
 *   miniapp/colors/R0.svg, R7.svg, GS.svg, BV.svg, YP.svg, WC.svg, WF.svg, back.svg
 *
 *   node tools/make-colors-cards.mjs
 *
 * Один стиль, одно место его менять. Интерфейс собирает любую руку из этих
 * файлов — ничего не рисуется на каждую руку заново.
 *
 * Карта обязана читаться дважды: крупно в руке (110 px) и ногтем у соперника
 * (40 px). Поэтому форм мало, линии толстые, мелких деталей нет совсем.
 *
 * ФИГУРА ЦВЕТА — не украшение. Вся игра стоит на четырёх цветах, а
 * «красный — зелёный» это ровно та пара, которую не различают дальтоники:
 * около восьми процентов мужчин, то есть примерно один в каждой компании из
 * шести. Поэтому у каждого цвета есть своя фигура (круг, треугольник,
 * квадрат, ромб), она стоит в двух углах каждой карты, и выключателя для неё
 * нет.
 *
 * Знаки особых карт берутся из design/colors/*.svg (их рисует
 * tools/make-colors-art.mjs) и ВШИВАЮТСЯ в карту целиком, а не ссылкой:
 * карта грузится как `<img src="…svg">`, а SVG внутри <img> не имеет права
 * тянуть внешние картинки — браузер их просто не покажет.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ART = path.join(ROOT, 'design', 'colors');
const OUT = path.join(ROOT, 'miniapp', 'colors');

const W = 200;
const H = 280;
const INK = '#16181D';
const DEEP = '#1B2A4A';
const FONT = "-apple-system, 'SF Pro Display', 'Helvetica Neue', Inter, 'Segoe UI', Roboto, Arial, sans-serif";

const COLOR = { R: '#E04A3F', Y: '#F2B22E', G: '#2FA355', B: '#2D6FD8' };
/** Тёмный тон того же цвета — для нижнего слоя и подложки под блик. */
const DARK = { R: '#B03227', Y: '#C9891A', G: '#1F7B3C', B: '#1F4FA6' };
const SIGNS = ['S', 'V', 'P'];
const SIGN_FILE = { S: 'stop.svg', V: 'reverse.svg', P: 'plus2.svg' };

/* -------------------------------------------------------------- фигуры цвета */

/**
 * Фигура цвета в коробке 100×100, чтобы её можно было поставить любым
 * размером. Белая с тёмным контуром — читается и на своём цвете, и на белом.
 */
const SHAPE = {
  R: '<circle cx="50" cy="50" r="38"/>',
  Y: '<path d="M50 8 92 82H8Z" stroke-linejoin="round"/>',
  G: '<rect x="12" y="12" width="76" height="76" rx="8"/>',
  B: '<path d="M50 6 94 50 50 94 6 50Z" stroke-linejoin="round"/>',
};

function shape(c, cx, cy, size) {
  const k = size / 100;
  return (
    `<g transform="translate(${r2(cx - size / 2)} ${r2(cy - size / 2)}) scale(${r3(k)})" ` +
    `fill="#fff" stroke="${INK}" stroke-width="${r2(7 / k)}">${SHAPE[c]}</g>`
  );
}

const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

/* ------------------------------------------------------- знаки особых карт */

/** Внутренности нарисованного знака, без обёртки <svg>, с его системой координат. */
function signBody(file) {
  const raw = fs.readFileSync(path.join(ART, file), 'utf8');
  const inner = raw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  const box = /viewBox="([^"]+)"/.exec(raw);
  const [, , vw, vh] = (box ? box[1] : '0 0 120 120').split(/\s+/).map(Number);
  return { inner, vw, vh };
}
const SIGN_ART = Object.fromEntries(SIGNS.map((s) => [s, signBody(SIGN_FILE[s])]));
const WILD_ART = signBody('wild.svg');

/** Знак размером `size`, по центру (cx, cy). Белый контур — чтобы не слипался с полем. */
function sign(art, cx, cy, size, { halo = true } = {}) {
  const k = size / Math.max(art.vw, art.vh);
  const g = `<g transform="translate(${r2(cx - (art.vw * k) / 2)} ${r2(cy - (art.vh * k) / 2)}) scale(${r3(k)})">${art.inner}</g>`;
  if (!halo) return g;
  // Та же фигура под низом, толстым белым пером: знак нарисован тёмным, а
  // лежит на цветном поле — без подложки он с полем сливается.
  const under = art.inner.replace(/stroke="(?!#fff)[^"]*"/g, 'stroke="#fff"').replace(/fill="(?!none)[^"]*"/g, 'fill="#fff"');
  return (
    `<g transform="translate(${r2(cx - (art.vw * k) / 2)} ${r2(cy - (art.vh * k) / 2)}) scale(${r3(k)})" ` +
    `stroke-width="22" stroke="#fff" fill="#fff" opacity=".95">${under}</g>` + g
  );
}

/* ------------------------------------------------------------------ карта */

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>\n`;

/** Белая скруглённая рамка карты и цветное поле под ней — общее у всех лиц. */
function field(c) {
  const main = c ? COLOR[c] : DEEP;
  const dark = c ? DARK[c] : '#121C33';
  return (
    `<rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="20" fill="#fff" stroke="#d6dbe1" stroke-width="3"/>` +
    `<rect x="12" y="12" width="${W - 24}" height="${H - 24}" rx="13" fill="${main}"/>` +
    // Блик: светлый овал наискось, как на макете. Он ничего не значит — он
    // только отличает карту от плоского прямоугольника.
    `<ellipse cx="${W / 2 - 14}" cy="${H / 2 - 18}" rx="64" ry="104" fill="#fff" opacity=".13" transform="rotate(-18 ${W / 2} ${H / 2})"/>` +
    `<path d="M12 ${H - 60}q40 28 ${W - 24} 12V${H - 25}a13 13 0 0 1-13 13H25a13 13 0 0 1-13-13Z" fill="${dark}" opacity=".3"/>`
  );
}

/** Крупная цифра в центре — белая с тёмным контуром, как на макете. */
function digit(n) {
  const common = `x="${W / 2}" y="${H / 2}" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" font-weight="800" font-size="150"`;
  return (
    `<text ${common} fill="none" stroke="${INK}" stroke-width="14" stroke-linejoin="round">${n}</text>` +
    `<text ${common} fill="#fff">${n}</text>`
  );
}

/** Та же цифра ногтем в углу. Угла два — карту держат и так, и так. */
function cornerDigit(n, x, y) {
  const common = `x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" font-weight="800" font-size="40"`;
  return (
    `<text ${common} fill="none" stroke="${INK}" stroke-width="7" stroke-linejoin="round">${n}</text>` +
    `<text ${common} fill="#fff">${n}</text>`
  );
}

/** Цветная карта: цифра или знак. */
function face(c, s) {
  const isNum = /^[0-9]$/.test(s);
  const centre = isNum ? digit(s) : sign(SIGN_ART[s], W / 2, H / 2, 112);
  const small = isNum
    ? cornerDigit(s, 40, 44) + cornerDigit(s, W - 40, H - 44)
    : sign(SIGN_ART[s], 42, 46, 46, { halo: false }) + sign(SIGN_ART[s], W - 42, H - 46, 46, { halo: false });
  // Фигура цвета — в двух оставшихся углах, по диагонали от знака: карту
  // видно и когда она наполовину накрыта соседней в веере.
  return svg(field(c) + small + centre + shape(c, W - 40, 44, 34) + shape(c, 40, H - 44, 34));
}

/** Бесцветные: «смена цвета» и «смена цвета +4». */
function wild(four) {
  const centre = sign(WILD_ART, W / 2, H / 2 - (four ? 18 : 0), four ? 104 : 124, { halo: false });
  const plus = four
    ? `<text x="${W / 2}" y="${H / 2 + 76}" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" ` +
      `font-weight="800" font-size="56" fill="none" stroke="${INK}" stroke-width="10" stroke-linejoin="round">+4</text>` +
      `<text x="${W / 2}" y="${H / 2 + 76}" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" ` +
      `font-weight="800" font-size="56" fill="#fff">+4</text>`
    : '';
  // На бесцветной карте стоят все четыре фигуры: она подходит к любому цвету,
  // и это должно быть видно, а не выучено.
  const all = ['R', 'Y', 'G', 'B'];
  const corners = [[40, 44], [W - 40, 44], [40, H - 44], [W - 40, H - 44]];
  const marks = all.map((c, i) => shape(c, corners[i][0], corners[i][1], 30)).join('');
  return svg(field(null) + centre + plus + marks);
}

/**
 * Рубашка: мазки четырёх цветов, расходящиеся из нескольких центров, —
 * узор с макета. Без верха и низа: карту нельзя прочесть перевёрнутой, и по
 * ней ничего нельзя угадать.
 */
function back() {
  const swirl = (cx, cy, r, turn) =>
    Array.from({ length: 8 }, (_, i) => {
      const a = turn + (i * Math.PI) / 4;
      const col = [COLOR.R, COLOR.Y, COLOR.G, COLOR.B][i % 4];
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const bx = cx + Math.cos(a + 0.62) * r * 0.55;
      const by = cy + Math.sin(a + 0.62) * r * 0.55;
      return `<path d="M${r2(cx)} ${r2(cy)}Q${r2(bx)} ${r2(by)} ${r2(x)} ${r2(y)}" stroke="${col}"/>`;
    }).join('');
  return svg(
    `<defs><clipPath id="c"><rect x="12" y="12" width="${W - 24}" height="${H - 24}" rx="13"/></clipPath></defs>` +
      `<rect x="2" y="2" width="${W - 4}" height="${H - 4}" rx="20" fill="#fff" stroke="#d6dbe1" stroke-width="3"/>` +
      `<g clip-path="url(#c)">` +
      `<rect x="12" y="12" width="${W - 24}" height="${H - 24}" fill="${DEEP}"/>` +
      `<g fill="none" stroke-width="15" stroke-linecap="round">` +
      swirl(62, 76, 74, 0.2) +
      swirl(150, 150, 74, 1.1) +
      swirl(60, 216, 74, 2.0) +
      `</g></g>` +
      `<rect x="12" y="12" width="${W - 24}" height="${H - 24}" rx="13" fill="none" stroke="#fff" stroke-width="6" opacity=".9"/>`
  );
}

/* ------------------------------------------------------------------ сборка */

fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const c of Object.keys(COLOR)) {
  for (const s of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ...SIGNS]) {
    fs.writeFileSync(path.join(OUT, `${c}${s}.svg`), face(c, s));
    n++;
  }
}
fs.writeFileSync(path.join(OUT, 'WC.svg'), wild(false));
fs.writeFileSync(path.join(OUT, 'WF.svg'), wild(true));
fs.writeFileSync(path.join(OUT, 'back.svg'), back());
n += 3;
console.log(`готово: ${n} файлов → miniapp/colors/`);
