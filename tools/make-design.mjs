/**
 * Макеты экранов в SVG — по картинкам, которые нарисовал владелец.
 *
 *   node tools/make-design.mjs        → design/*.svg
 *
 * Почему генератор, а не пять файлов руками: экраны состоят из одного и того
 * же — карта, рубашка, аватар, плашка, чип, кнопка. Руками это тысячи строк,
 * в которых опечатку не видно; здесь каждая вещь описана один раз.
 *
 * Что получается на выходе — обычный SVG: группы названы по-русски, текст
 * настоящий, цвета из палитры игры (docs/design.md). Перетащите в Figma —
 * откроется слоями, всё двигается и красится. Правки владельца возвращаются
 * из Figma как SVG и переносятся в вёрстку; генератор их не перезатирает,
 * пока его не запустят заново.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'design');

/* ------------------------------------------------------------- палитра */

const C = {
  bg: '#0A1216',
  panel: '#13212A',
  panel2: '#17252E',
  sheet: '#182B35',
  line: 'rgba(255,255,255,0.10)',
  ink: '#F2F7F5',
  mid: '#A9BCC0',
  low: '#6E858B',
  green: '#2EE08C',
  greenInk: '#0A2016',
  gold: '#F2C96B',
  red: '#E8574C',
  blue: '#52B8FF',
  face: '#F7F4EC',
  cardInk: '#16202A',
  cardRed: '#D2342B',
};

const FONT = "Inter, -apple-system, 'Segoe UI', Roboto, sans-serif";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r2 = (n) => Math.round(n * 100) / 100;

/* -------------------------------------------------------------- кирпичи */

const g = (name, ...kids) => `<g id="${esc(name)}">\n${kids.filter(Boolean).join('\n')}\n</g>`;

const rect = (x, y, w, h, { r = 0, fill = 'none', stroke = null, sw = 1, opacity = null, dash = null } = {}) =>
  `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" rx="${r}" fill="${fill}"` +
  `${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ''}${dash ? ` stroke-dasharray="${dash}"` : ''}` +
  `${opacity != null ? ` opacity="${opacity}"` : ''}/>`;

const text = (x, y, s, { size = 13, weight = 700, fill = C.ink, anchor = 'start', spacing = null } = {}) =>
  `<text x="${r2(x)}" y="${r2(y)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"` +
  `${spacing ? ` letter-spacing="${spacing}"` : ''}>${esc(s)}</text>`;

const circle = (cx, cy, r, { fill = 'none', stroke = null, sw = 2 } = {}) =>
  `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ''}/>`;

/** Плашка-таблетка с текстом по центру: чип состояния, метка, маленькая кнопка. */
function chip(x, y, w, h, label, { fill = C.panel, ink = C.mid, stroke = null, size = 11, weight = 700 } = {}) {
  return [rect(x, y, w, h, { r: h / 2, fill, stroke, sw: 1 }),
    text(x + w / 2, y + h / 2 + size * 0.36, label, { size, weight, fill: ink, anchor: 'middle' })].join('\n');
}

/** Прямоугольная кнопка: крупное слово, под ним при желании мелкое. */
function button(x, y, w, h, label, { fill = C.panel, ink = C.ink, stroke = null, sub = null, size = 15, r = 14 } = {}) {
  const dy = sub ? -4 : 0;
  return [rect(x, y, w, h, { r, fill, stroke, sw: 1.5 }),
    text(x + w / 2, y + h / 2 + size * 0.36 + dy, label, { size, weight: 800, fill: ink, anchor: 'middle' }),
    sub ? text(x + w / 2, y + h / 2 + 16, sub, { size: 11, weight: 700, fill: ink, anchor: 'middle' }) : null,
  ].filter(Boolean).join('\n');
}

/** Аватар: в игре сюда встаёт фотография из Telegram, в макете — силуэт. */
function avatar(cx, cy, r, { ring = null, sw = 3 } = {}) {
  return [
    `<clipPath id="av${r2(cx)}x${r2(cy)}"><circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}"/></clipPath>`,
    circle(cx, cy, r, { fill: '#25424F' }),
    `<g clip-path="url(#av${r2(cx)}x${r2(cy)})">`,
    circle(cx, cy - r * 0.18, r * 0.36, { fill: '#8AA6B0' }),
    `<ellipse cx="${r2(cx)}" cy="${r2(cy + r * 0.82)}" rx="${r2(r * 0.66)}" ry="${r2(r * 0.52)}" fill="#8AA6B0"/>`,
    '</g>',
    circle(cx, cy, r, { stroke: ring || 'rgba(255,255,255,0.35)', sw: ring ? sw : 1.5 }),
  ].join('\n');
}

/** Карта лицом. Индекс в углу, масть крупно внизу — как на настоящей. */
function card(rank, suit, x, y, { w = 52, rot = 0 } = {}) {
  const h = w * 1.4;
  const ink = suit === '♥' || suit === '♦' ? C.cardRed : C.cardInk;
  const body = [
    rect(0, 0, w, h, { r: w * 0.16, fill: C.face, stroke: 'rgba(0,0,0,0.25)' }),
    text(w * 0.13, w * 0.36, rank, { size: w * 0.3, weight: 800, fill: ink }),
    text(w * 0.13, w * 0.62, suit, { size: w * 0.24, weight: 700, fill: ink }),
    text(w * 0.76, h * 0.9, suit, { size: w * 0.46, weight: 700, fill: ink, anchor: 'middle' }),
  ].join('\n');
  return `<g transform="translate(${r2(x)} ${r2(y)})${rot ? ` rotate(${rot} ${r2(w / 2)} ${r2(h / 2)})` : ''}">\n${body}\n</g>`;
}

/** Рубашка: своя, геометрическая — ромб и кант, ничего скачанного. */
function back(x, y, { w = 52, rot = 0 } = {}) {
  const h = w * 1.4;
  const body = [
    rect(0, 0, w, h, { r: w * 0.16, fill: '#1B4A63', stroke: '#0A2028' }),
    rect(w * 0.08, w * 0.08, w * 0.84, h - w * 0.16, { r: w * 0.09, stroke: 'rgba(127,216,232,0.45)' }),
    `<path d="M${r2(w * 0.2)} ${r2(h / 2)} L${r2(w / 2)} ${r2(h * 0.2)} L${r2(w * 0.8)} ${r2(h / 2)} L${r2(w / 2)} ${r2(h * 0.8)} Z" fill="none" stroke="rgba(127,216,232,0.3)"/>`,
    circle(w / 2, h / 2, w * 0.13, { stroke: 'rgba(127,216,232,0.35)', sw: 1 }),
  ].join('\n');
  return `<g transform="translate(${r2(x)} ${r2(y)})${rot ? ` rotate(${rot} ${r2(w / 2)} ${r2(h / 2)})` : ''}">\n${body}\n</g>`;
}

/** Пустое место под карту — пунктирная рамка. */
const slot = (x, y, w, { fill = 'rgba(0,0,0,0.22)', stroke = 'rgba(255,255,255,0.35)' } = {}) =>
  rect(x, y, w, w * 1.4, { r: w * 0.16, fill, stroke, dash: '5 4' });

/** Значок «столько-то карт на руках» — две рубашки и число. */
function cardsCount(x, y, n, { size = 11 } = {}) {
  return [
    `<g transform="translate(${r2(x)} ${r2(y - 9)})">`,
    rect(0, 1, 7, 10, { r: 1.5, fill: C.mid, opacity: 0.55 }),
    rect(3, 0, 7, 10, { r: 1.5, fill: C.mid }),
    '</g>',
    text(x + 14, y, String(n), { size, weight: 800, fill: C.mid }),
  ].join('\n');
}

const W = 360;
const H = 780;

function page(title, ...kids) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  ${title}, ${W}×${H} — экран телефона, в котором живёт игра.

  Собрано генератором tools/make-design.mjs по макету владельца. Группы
  названы по-русски, текст настоящий, цвета из docs/design.md. Перетащите в
  Figma — откроется слоями.
-->
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
<defs>
  <radialGradient id="suknoDurak" cx="50%" cy="34%" r="76%">
    <stop offset="0%" stop-color="#1E6E7E"/><stop offset="58%" stop-color="#12495A"/><stop offset="100%" stop-color="#0A2E39"/>
  </radialGradient>
  <radialGradient id="suknoPoker" cx="50%" cy="36%" r="74%">
    <stop offset="0%" stop-color="#2A7B55"/><stop offset="58%" stop-color="#145436"/><stop offset="100%" stop-color="#0A3322"/>
  </radialGradient>
  <linearGradient id="zoloto" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#F2C96B" stop-opacity="0.16"/><stop offset="100%" stop-color="#F2C96B" stop-opacity="0.04"/>
  </linearGradient>
  <filter id="razmytie" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="7"/></filter>
  <linearGradient id="zolotoFon" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#F2C96B" stop-opacity="0.14"/><stop offset="100%" stop-color="#F2C96B" stop-opacity="0.05"/>
  </linearGradient>
  <clipPath id="ekran"><rect width="${W}" height="${H}"/></clipPath>
</defs>
<g clip-path="url(#ekran)">
${rect(0, 0, W, H, { fill: C.bg })}
${kids.filter(Boolean).join('\n')}
</g>
</svg>
`;
}

/* =================================================== 1. СТОЛ ДУРАКА */

function durak() {
  const seat = (name, n, cx, cy, { turn = false } = {}) => g(`Место ${name}`,
    avatar(cx, cy, 26, { ring: turn ? C.green : null }),
    text(cx, cy + 46, name, { size: 12.5, weight: 700, fill: C.ink, anchor: 'middle' }),
    `<g transform="translate(${r2(cx - 14)} ${r2(cy + 64)})">${cardsCount(0, 0, n)}</g>`);

  const pair = (a, b, x, y) => [card(a[0], a[1], x, y, { w: 50, rot: -6 }), card(b[0], b[1], x + 22, y - 4, { w: 50, rot: 5 })].join('\n');

  return page('Стол дурака',
    g('Верх',
      rect(12, 16, 96, 32, { r: 16, fill: C.panel, stroke: 'rgba(255,255,255,0.10)' }),
      text(28, 37, 'Стол 4827', { size: 12, weight: 700, fill: C.mid }),
      text(176, 37, 'Козырь:', { size: 13, weight: 700, fill: C.ink, anchor: 'end' }),
      text(184, 38, '♣', { size: 16, weight: 800, fill: C.green }),
      rect(316, 16, 32, 32, { r: 16, fill: C.panel, stroke: 'rgba(255,255,255,0.10)' }),
      text(332, 36, '⋯', { size: 15, weight: 800, fill: C.mid, anchor: 'middle' })),

    g('Сукно', `<path d="M-14 250 A192 174 0 0 1 374 250 L374 486 A34 34 0 0 1 340 520 L20 520 A34 34 0 0 1 -14 486 Z" fill="url(#suknoDurak)"/>`),

    g('Соперники',
      seat('Ирина', 6, 58, 100),
      seat('Алексей', 5, 180, 82, { turn: true }),
      seat('Ольга', 6, 302, 100)),

    // Колода у левого края, подрезана им; козырь торчит рангом наружу.
    g('Колода',
      // Поворот вокруг ЦЕНТРА карты: тогда угол с рангом уезжает вправо и
      // остаётся на экране, а не за краем вместе с остальной колодой.
      `<g transform="translate(-6 196) rotate(90 25 35)">${card('10', '♣', 0, 0, { w: 50 })}</g>`,
      back(-26, 214, { w: 50 }),
      back(-22, 210, { w: 50 }),
      back(-18, 206, { w: 50 })),

    // Бита у правого края: видно край веера, и только.
    g('Бита',
      back(318, 210, { w: 50, rot: -7 }),
      back(324, 214, { w: 50, rot: 4 }),
      back(330, 208, { w: 50, rot: -2 })),

    g('Кон',
      pair(['9', '♠'], ['К', '♥'], 78, 256),
      pair(['7', '♣'], ['Д', '♦'], 198, 256),
      pair(['8', '♥'], ['10', '♥'], 78, 372),
      g('Ждёт ответа',
        card('6', '♠', 212, 372, { w: 50 }),
        slot(204, 364, 66, { fill: 'none', stroke: C.blue }))),

    g('Действия',
      button(16, 560, 156, 54, 'Пас', { fill: C.panel, ink: C.mid, stroke: 'rgba(255,255,255,0.14)', r: 16 }),
      button(188, 560, 156, 54, 'Бить', { fill: C.green, ink: C.greenInk, r: 16 })),

    g('Моя рука',
      ...['6♦', '9♣', 'В♥', 'Д♠', 'К♦', 'Т♣'].map((c, i) => {
        const rank = c.slice(0, -1);
        const suit = c.slice(-1);
        const mid = 2.5;
        return card(rank, suit, 6 + i * 58, 646 + Math.abs(i - mid) * 5, { w: 74, rot: (i - mid) * 4 });
      })));
}

/* =================================================== 2. СТОЛ ПОКЕРА */

function pokerBody() {
  const seat = (name, stack, act, cx, cy, { actFill = C.panel, actInk = C.mid, actStroke = null } = {}) => g(`Место ${name}`,
    back(cx - 20, cy - 34, { w: 20, rot: -8 }),
    back(cx - 4, cy - 34, { w: 20, rot: 8 }),
    avatar(cx, cy, 24),
    rect(cx - 44, cy + 28, 88, 36, { r: 12, fill: C.panel, stroke: 'rgba(255,255,255,0.10)' }),
    text(cx, cy + 43, name, { size: 11.5, weight: 700, fill: C.mid, anchor: 'middle' }),
    text(cx, cy + 58, stack, { size: 13, weight: 800, fill: C.ink, anchor: 'middle' }),
    act ? chip(cx - 34, cy + 70, 68, 22, act, { fill: actFill, ink: actInk, stroke: actStroke }) : null);

  return [
    g('Верх',
      rect(12, 16, 92, 32, { r: 16, fill: C.panel, stroke: 'rgba(255,255,255,0.10)' }),
      text(30, 37, 'Флоп', { size: 12.5, weight: 700, fill: C.ink }),
      text(180, 37, 'Блайнды 50 / 100', { size: 12.5, weight: 700, fill: C.mid, anchor: 'middle' }),
      rect(316, 16, 32, 32, { r: 16, fill: C.panel, stroke: 'rgba(255,255,255,0.10)' }),
      text(332, 36, '⋯', { size: 15, weight: 800, fill: C.mid, anchor: 'middle' })),

    g('Сукно', `<ellipse cx="180" cy="330" rx="168" ry="268" fill="url(#suknoPoker)"/>`),

    g('Соперники',
      seat('Алексей', '4 350', 'Чек', 180, 110),
      seat('Ирина', '3 200', 'Ставка 300', 52, 178, { actStroke: C.gold, actInk: C.gold }),
      seat('Максим', '6 780', 'Колл 300', 308, 178),
      seat('Сергей', '2 150', 'Фолд', 52, 418),
      seat('Ольга', '5 600', 'Чек', 308, 418)),

    g('Банк',
      rect(114, 248, 132, 44, { r: 14, fill: 'rgba(3,32,20,0.55)', stroke: 'rgba(255,255,255,0.14)' }),
      text(180, 265, 'Банк', { size: 10.5, weight: 700, fill: C.mid, anchor: 'middle' }),
      circle(136, 279, 7, { fill: C.red }),
      circle(146, 279, 7, { fill: '#F7F4EC' }),
      text(196, 286, '1 350', { size: 18, weight: 800, fill: C.ink, anchor: 'middle' })),

    g('Борд',
      card('Т', '♠', 60, 308, { w: 48 }),
      card('К', '♥', 116, 308, { w: 48 }),
      card('7', '♣', 172, 308, { w: 48 }),
      slot(228, 308, 48, { fill: 'rgba(3,40,26,0.5)' }),
      slot(284, 308, 48, { fill: 'rgba(3,40,26,0.5)' }),
      chip(132, 384, 96, 22, 'Ставка: 300', { fill: 'rgba(0,0,0,0.35)', ink: C.mid })),

    g('Мои карты',
      card('Д', '♥', 94, 472, { w: 82, rot: -7 }),
      card('10', '♥', 184, 466, { w: 82, rot: 6 }),
      chip(126, 592, 108, 26, 'Пара дам', { fill: C.panel, ink: C.green, stroke: 'rgba(46,224,140,0.5)', size: 12 })),

    g('Я',
      rect(12, 630, 336, 62, { r: 16, fill: C.panel, stroke: 'rgba(255,255,255,0.10)' }),
      text(28, 653, 'Вы', { size: 16, weight: 800, fill: C.ink }),
      circle(66, 648, 5, { fill: C.green }),
      text(332, 653, '4 720', { size: 16, weight: 800, fill: C.ink, anchor: 'end' }),
      text(28, 671, 'Ваш ход', { size: 12, weight: 700, fill: C.mid }),
      rect(28, 678, 268, 6, { r: 3, fill: 'rgba(255,255,255,0.12)' }),
      rect(28, 678, 176, 6, { r: 3, fill: C.green }),
      text(332, 683, '20 с', { size: 11, weight: 700, fill: C.mid, anchor: 'end' })),

    g('Действия',
      button(12, 704, 104, 60, 'Сбросить', { fill: 'rgba(232,87,76,0.12)', ink: C.red, stroke: C.red, sub: '300', size: 14 }),
      button(128, 704, 104, 60, 'Колл', { fill: C.green, ink: C.greenInk, sub: '300', size: 14 }),
      button(244, 704, 104, 60, 'Рейз', { fill: C.gold, ink: '#2A1F06', sub: '900', size: 14 })),
  ];
}

const poker = () => page('Стол покера', ...pokerBody());

/* ============================================= 6. ИТОГИ ПАРТИИ */

function results() {
  const row = (y, place, name, what, ratingLine, delta, kind) => {
    const border = kind === 'win' ? C.green : kind === 'last' ? C.gold : 'rgba(255,255,255,0.07)';
    const fill = kind === 'win' ? 'rgba(46,224,140,0.07)' : kind === 'last' ? 'rgba(242,201,107,0.07)' : C.panel;
    const badge = kind === 'win' ? C.green : kind === 'last' ? C.gold : '#2A3B45';
    const badgeInk = kind === 'plain' ? C.mid : '#0D1A12';
    return g(`Строка ${name}`,
      rect(12, y, 336, 88, { r: 18, fill, stroke: border, sw: kind === 'plain' ? 1 : 2 }),
      circle(46, y + 44, 19, { fill: badge }),
      text(46, y + 50, String(place), { size: 16, weight: 800, fill: badgeInk, anchor: 'middle' }),
      avatar(100, y + 44, 25),
      text(136, y + 34, name, { size: 16, weight: 800, fill: C.ink }),
      text(136, y + 53, what, { size: 11.5, weight: 600, fill: C.mid }),
      text(136, y + 70, ratingLine, { size: 11, weight: 700, fill: kind === 'last' ? C.gold : C.green }),
      text(338, y + 50, delta, { size: 19, weight: 800, anchor: 'end',
        fill: delta.startsWith('+') ? C.green : kind === 'last' ? C.gold : C.ink }));
  };

  return page('Итоги партии',
    g('Заголовок',
      text(180, 52, 'ИГРА ЗАВЕРШЕНА', { size: 11, weight: 800, fill: C.gold, anchor: 'middle', spacing: '3' }),
      text(180, 104, 'Вы победили!', { size: 34, weight: 800, fill: C.ink, anchor: 'middle' }),
      text(180, 132, 'Спасибо за игру. Отличная партия!', { size: 13.5, weight: 600, fill: C.mid, anchor: 'middle' })),

    row(164, 1, 'Алексей', 'Собрал стрит', '+20 очков · 3-е место в рейтинге', '+3 450', 'win'),
    row(264, 2, 'Ирина', 'Собрала две пары', '+12 очков · 5-е место', '+1 200', 'plain'),
    row(364, 3, 'Максим', 'Собрал пару', '+6 очков · 9-е место', '−800', 'plain'),
    row(464, 4, 'Ольга', 'Без комбинации', '−10 очков · 14-е место', '−3 850', 'last'),

    g('Как считали',
      text(180, 592, 'Фишки — по правилам стола, очки — по рейтингу.', { size: 11.5, weight: 600, fill: C.low, anchor: 'middle' }),
      text(180, 610, 'Партия доиграна до конца, поэтому зачтена.', { size: 11.5, weight: 600, fill: C.low, anchor: 'middle' })),

    g('Кнопки',
      button(12, 686, 162, 62, 'Закрыть', { fill: 'transparent', ink: C.mid, stroke: 'rgba(255,255,255,0.18)', size: 16, r: 18 }),
      button(186, 686, 162, 62, 'Сыграть ещё', { fill: C.green, ink: C.greenInk, size: 16, r: 18 })));
}

/* ========================================== 7. ШТОРКА: СТАВКА */

function bet() {
  const preset = (x, top, sum, on) => g(`Размер ${top}`,
    rect(x, 630, 104, 60, { r: 14, fill: on ? 'rgba(46,224,140,0.10)' : C.panel, stroke: on ? C.green : 'rgba(255,255,255,0.12)', sw: on ? 2 : 1 }),
    text(x + 52, 655, top, { size: 13, weight: 800, fill: on ? C.ink : C.mid, anchor: 'middle' }),
    text(x + 52, 675, sum, { size: 13, weight: 800, fill: on ? C.green : C.low, anchor: 'middle' }));

  return page('Шторка: ставка',
    `<g filter="url(#razmytie)" opacity="0.85">\n${pokerBody().join('\n')}\n</g>`,
    rect(0, 0, W, H, { fill: '#03090C', opacity: 0.62 }),

    g('Шторка',
      rect(0, 430, W, 350, { r: 26, fill: C.sheet, stroke: 'rgba(255,255,255,0.08)' }),
      rect(160, 444, 40, 5, { r: 3, fill: 'rgba(255,255,255,0.28)' }),

      text(20, 484, 'СДЕЛАТЬ СТАВКУ', { size: 11, weight: 800, fill: C.mid, spacing: '2.5' }),
      text(20, 548, '600', { size: 52, weight: 800, fill: C.gold }),
      text(20, 578, 'Выберите размер ставки', { size: 13, weight: 600, fill: C.mid }),

      g('Ползунок',
        rect(20, 600, 320, 8, { r: 4, fill: 'rgba(255,255,255,0.14)' }),
        rect(20, 600, 116, 8, { r: 4, fill: C.green }),
        circle(136, 604, 15, { fill: '#FFFFFF' }),
        text(20, 626, '100', { size: 12, weight: 700, fill: C.low }),
        text(340, 626, '2 000', { size: 12, weight: 700, fill: C.low, anchor: 'end' })),

      preset(20, '1/2 банка', '600', true),
      preset(128, 'Банк', '1 200', false),
      preset(236, 'Олл-ин', '4 720', false),

      button(20, 706, 320, 58, 'Сделать ставку 600', { fill: C.green, ink: C.greenInk, size: 16, r: 16 })));
}

/* ========================================================= 3. ХАБ */

function hub() {
  const icon = (x, y, kind) => {
    const box = rect(x, y, 56, 56, { r: 16, fill: kind === 'poker' ? '#12503A' : kind === 'durak' ? '#123B4A' : '#1A222A' });
    const inner = kind === 'poker' ? [card('Т', '♠', x + 8, y + 12, { w: 24, rot: -10 }), card('К', '♥', x + 24, y + 10, { w: 24, rot: 8 })]
      : kind === 'durak' ? [card('К', '♥', x + 8, y + 12, { w: 24, rot: -10 }), card('9', '♠', x + 24, y + 10, { w: 24, rot: 8 })]
        : kind === 'domino' ? [
          rect(x + 10, y + 20, 18, 26, { r: 4, fill: '#E4E8E8' }), circle(x + 19, y + 27, 2.5, { fill: '#16202A' }), circle(x + 19, y + 39, 2.5, { fill: '#16202A' }),
          rect(x + 30, y + 16, 18, 26, { r: 4, fill: '#CFD6D6' }), circle(x + 39, y + 23, 2.5, { fill: '#16202A' }), circle(x + 39, y + 35, 2.5, { fill: '#16202A' })]
          : [rect(x + 10, y + 10, 36, 36, { r: 6, fill: '#3E2C1E' }),
            rect(x + 10, y + 10, 18, 18, { fill: '#6B4F36' }), rect(x + 28, y + 28, 18, 18, { fill: '#6B4F36' }),
            circle(x + 21, y + 36, 8, { fill: '#E9E2D2' }), circle(x + 37, y + 20, 8, { fill: '#1A1A1A' })];
    return [box, ...inner].join('\n');
  };

  const gameRow = (y, kind, title, sub1, sub2, people, on) => g(`Игра ${title}`,
    rect(12, y, 336, 90, { r: 18, fill: on ? C.panel : 'rgba(19,33,42,0.55)', stroke: on ? 'rgba(46,224,140,0.35)' : 'rgba(255,255,255,0.07)' }),
    icon(26, y + 17, kind),
    text(96, y + 28, title, { size: 16, weight: 800, fill: on ? C.ink : C.mid }),
    text(96, y + 46, sub1, { size: 11.5, weight: 600, fill: on ? C.mid : C.low }),
    text(96, y + 62, sub2, { size: 11.5, weight: 600, fill: on ? C.mid : C.low }),
    text(96, y + 80, people, { size: 11, weight: 600, fill: C.low }),
    on ? button(254, y + 27, 82, 36, 'Играть', { fill: C.green, ink: C.greenInk, size: 13, r: 12 })
      : button(254, y + 27, 82, 36, 'Скоро', { fill: '#22303A', ink: C.low, size: 13, r: 12 }));

  const openRow = (y, title, sub) => g(`Открытая игра ${title}`,
    rect(12, y, 336, 60, { r: 14, fill: C.panel }),
    icon(22, y + 2, 'durak'),
    text(92, y + 26, title, { size: 13.5, weight: 700, fill: C.ink }),
    text(92, y + 44, sub, { size: 11, weight: 600, fill: C.low }),
    button(234, y + 14, 100, 32, 'Войти', { fill: C.green, ink: C.greenInk, size: 12.5, r: 11 }));

  return page('Хаб: выбор игры',
    g('Заголовок',
      text(16, 46, 'Выберите игру', { size: 27, weight: 800, fill: C.ink }),
      text(16, 78, 'из группы', { size: 27, weight: 800, fill: C.green }),
      text(16, 102, 'Играйте с участниками группы', { size: 13, weight: 600, fill: C.mid })),

    gameRow(118, 'poker', 'Покер', 'Техасский холдем', 'на 2–9 игроков', '12 играют', true),
    gameRow(216, 'durak', 'Дурак', 'Подкидной и переводной', 'на 2–6 игроков', '8 играют', true),
    gameRow(314, 'domino', 'Домино', 'Классическое', 'на 2–4 игроков', 'Скоро', false),
    gameRow(412, 'checkers', 'Шашки', 'Русские', 'и международные', 'Скоро', false),

    g('Рейтинг',
      rect(12, 514, 336, 66, { r: 18, fill: 'url(#zoloto)', stroke: 'rgba(242,201,107,0.55)' }),
      text(36, 557, '🏆', { size: 26, anchor: 'middle' }),
      text(64, 542, 'Рейтинг группы', { size: 16, weight: 800, fill: C.ink }),
      text(64, 561, 'Лидеры и своя статистика', { size: 11.5, weight: 600, fill: C.mid }),
      text(332, 555, '›', { size: 20, weight: 800, fill: C.mid, anchor: 'end' })),

    g('Открытые игры',
      text(16, 610, 'Открытые игры', { size: 16, weight: 800, fill: C.ink }),
      text(344, 610, 'Все игры ›', { size: 12, weight: 700, fill: C.mid, anchor: 'end' })),
    openRow(624, 'Холдем, стол 2487', '6 / 9 · блайнды 50 / 100'),
    openRow(692, 'Дурак, стол 3112', '3 / 4 · подкидной'),

    text(180, 772, 'Играть можно только с участниками группы', { size: 11, weight: 600, fill: C.low, anchor: 'middle' }));
}

/* ==================================================== 4. РЕЙТИНГ */

function rating() {
  const row = (y, place, name, sub, points, { me = false, medal = null } = {}) => g(`Строка ${name}`,
    rect(12, y, 336, 66, { r: 16, fill: me ? C.panel2 : C.panel, stroke: me ? C.green : 'rgba(255,255,255,0.07)', sw: me ? 2 : 1 }),
    medal ? text(38, y + 40, medal, { size: 22, anchor: 'middle' })
      : text(38, y + 40, String(place), { size: 16, weight: 800, fill: me ? C.green : C.low, anchor: 'middle' }),
    avatar(78, y + 33, 20),
    text(108, y + 29, name, { size: 15, weight: 800, fill: C.ink }),
    text(108, y + 48, sub, { size: 11, weight: 600, fill: C.low }),
    text(336, y + 31, points, { size: 17, weight: 800, fill: C.gold, anchor: 'end' }),
    text(336, y + 48, 'очков', { size: 10.5, weight: 600, fill: C.low, anchor: 'end' }));

  return page('Рейтинг',
    g('Верх',
      rect(12, 16, 40, 36, { r: 12, fill: C.panel, stroke: 'rgba(255,255,255,0.10)' }),
      text(32, 40, '‹', { size: 20, weight: 800, fill: C.ink, anchor: 'middle' }),
      text(30, 100, '🏆', { size: 30, anchor: 'middle' }),
      text(56, 100, 'Рейтинг игроков', { size: 24, weight: 800, fill: C.ink }),
      text(56, 122, 'Кто чего стоит — за месяц и за всё время', { size: 12, weight: 600, fill: C.mid })),

    g('Переключатель игры',
      button(12, 142, 164, 44, 'Дурак', { fill: C.green, ink: C.greenInk, size: 14, r: 22 }),
      button(184, 142, 164, 44, 'Покер', { fill: C.panel, ink: C.mid, stroke: 'rgba(255,255,255,0.10)', size: 14, r: 22 })),

    g('Переключатель срока',
      chip(12, 196, 120, 34, 'За месяц', { fill: C.green, ink: C.greenInk, size: 12.5, weight: 800 }),
      chip(140, 196, 130, 34, 'За всё время', { fill: C.panel, ink: C.mid, stroke: 'rgba(255,255,255,0.10)', size: 12.5 })),

    row(244, 1, 'Алексей', '312 партий · побед 68%', '12 450', { medal: '🥇' }),
    row(318, 2, 'Ирина', '284 партии · побед 62%', '11 980', { medal: '🥈' }),
    row(392, 3, 'Максим', '275 партий · побед 59%', '10 320', { medal: '🥉' }),
    row(466, 4, 'Ольга', '230 партий · побед 58%', '9 760'),
    row(540, 5, 'Вы', '198 партий · побед 55%', '8 420', { me: true }),
    row(614, 6, 'Сергей', '185 партий · побед 53%', '7 910'),

    g('Как считается',
      text(16, 706, 'Очки за место: первым +20, вторым +12, третьим +6,', { size: 11, weight: 600, fill: C.low }),
      text(16, 723, 'дураком −10. Ниже нуля не падает.', { size: 11, weight: 600, fill: C.low }),
      text(16, 740, 'Считаются доигранные партии, не больше 10 в сутки', { size: 11, weight: 600, fill: C.low }),
      text(16, 757, 'с одним и тем же составом.', { size: 11, weight: 600, fill: C.low })));
}

/* ====================================================== 5. ЛОББИ */

function lobby() {
  const taken = (x, y, name) => g(`Место ${name}`,
    rect(x, y, 96, 108, { r: 16, fill: C.panel2, stroke: 'rgba(255,255,255,0.08)' }),
    avatar(x + 48, y + 44, 28),
    text(x + 48, y + 92, name, { size: 12.5, weight: 700, fill: C.ink, anchor: 'middle' }));

  const free = (x, y) => g('Свободно',
    rect(x, y, 96, 108, { r: 16, fill: 'rgba(255,255,255,0.02)', stroke: 'rgba(255,255,255,0.22)', dash: '6 5' }),
    circle(x + 48, y + 44, 22, { stroke: 'rgba(255,255,255,0.3)', sw: 1.5 }),
    text(x + 48, y + 51, '+', { size: 22, weight: 700, fill: C.mid, anchor: 'middle' }),
    text(x + 48, y + 92, 'Свободно', { size: 11.5, weight: 600, fill: C.low, anchor: 'middle' }));

  const item = (y, title, sub, glyph, last) => g(`Пункт ${title}`,
    rect(28, y + 10, 34, 34, { r: 11, fill: '#1B2A33' }),
    text(45, y + 33, glyph, { size: 15, anchor: 'middle' }),
    text(74, y + 28, title, { size: 14.5, weight: 800, fill: C.ink }),
    text(74, y + 46, sub, { size: 11, weight: 600, fill: C.low }),
    text(330, y + 34, '›', { size: 18, weight: 800, fill: C.mid, anchor: 'end' }),
    last ? null : `<line x1="28" y1="${y + 56}" x2="332" y2="${y + 56}" stroke="rgba(255,255,255,0.07)"/>`);

  return page('Лобби: стол собирается',
    g('Заголовок',
      text(16, 52, 'Покер', { size: 30, weight: 800, fill: C.ink }),
      text(16, 78, 'Ждём игроков, чтобы начать', { size: 13, weight: 600, fill: C.mid })),

    g('Места',
      rect(12, 100, 336, 252, { r: 20, fill: C.panel }),
      taken(24, 114, 'Алексей'), taken(132, 114, 'Ирина'), taken(240, 114, 'Максим'),
      free(24, 230), free(132, 230), free(240, 230)),

    g('Правила стола',
      chip(12, 366, 140, 34, 'Блайнды 50 / 100', { fill: 'rgba(46,224,140,0.10)', ink: C.green, stroke: 'rgba(46,224,140,0.6)', size: 12 }),
      chip(158, 366, 86, 34, '6 игроков', { fill: C.panel, ink: C.mid, stroke: 'rgba(255,255,255,0.10)', size: 12 }),
      chip(250, 366, 98, 34, 'Без лимита', { fill: C.panel, ink: C.mid, stroke: 'rgba(255,255,255,0.10)', size: 12 }),
      chip(12, 408, 96, 34, 'Анте: нет', { fill: C.panel, ink: C.mid, stroke: 'rgba(255,255,255,0.10)', size: 12 }),
      chip(114, 408, 128, 34, 'Таймбанк 30 с', { fill: C.panel, ink: C.mid, stroke: 'rgba(255,255,255,0.10)', size: 12 }),
      chip(248, 408, 100, 34, 'Ребай: да', { fill: C.panel, ink: C.mid, stroke: 'rgba(255,255,255,0.10)', size: 12 })),

    g('Хозяину стола',
      rect(12, 462, 336, 130, { r: 20, fill: C.panel }),
      item(472, 'Настройки стола', 'Правила, таймер, ребаи', '⚙', false),
      item(537, 'Пригласить игроков', 'Ссылка в чат группы', '👥', true)),

    g('Кнопки',
      button(12, 648, 336, 60, 'Начать игру', { fill: C.green, ink: C.greenInk, size: 17, r: 18 }),
      button(12, 720, 336, 54, 'Покинуть стол', { fill: 'transparent', ink: C.mid, stroke: 'rgba(255,255,255,0.18)', size: 15, r: 16 })));
}

/* --------------------------------------------------------------- вывод */

const files = {
  'durak-stol.svg': durak(),
  'poker-stol.svg': poker(),
  'hub.svg': hub(),
  'reyting.svg': rating(),
  'lobby-poker.svg': lobby(),
  'itogi.svg': results(),
  'stavka.svg': bet(),
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), body);
console.log(`макеты: ${Object.keys(files).length} → design/`);
