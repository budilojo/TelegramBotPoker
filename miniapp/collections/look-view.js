/**
 * Оформление «Графит» на игровых экранах: чтение `view.look` и `players[].frame`.
 * Контракт: docs/graphit-launch/contracts.md, разделы 5, 6, 9.
 *
 * Первая половина файла — чистые функции без DOM (их проверяют тесты в Node).
 * Вторая — три маленьких помощника, которые вешают картинки на уже построенные
 * элементы; всё, что они делают, при любой ошибке сводится к базовому виду
 * (классика проекта), игра не страдает и страница не падает.
 *
 * Правила, которые здесь охраняются:
 *  • вид не меняется посреди раздачи: клиент держит снимок и обновляет его только
 *    когда меняется номер раздачи (`dealNo`) или комната, либо идёт лобби;
 *  • неизвестный предмет, цвет не из каталога, чужой слот → база (null);
 *  • файла нет / не загрузился → база, и больше его не просим;
 *  • лица карт не трогаем никогда — только рубашку места.
 */
import { ITEMS, COLORS, itemById, isColor, publicEntry } from './catalog.js';

const ART_DIR = '/collections/art/';
const KINDS = ['cardback-small', 'table-ornament', 'table-diamond', 'frame-small', 'mark'];

/** Какой предмет каталога допустим в каком поле вида. */
const SLOT_ITEM = { back: 'graphit-cardback', table: 'graphit-table', frame: 'graphit-profile' };

/** Адреса, которые не загрузились: второй раз не просим (база). */
const failed = new Set();
export const markFailed = (url) => { if (typeof url === 'string') failed.add(url); };
export const isFailed = (url) => failed.has(url);
export const resetFailed = () => failed.clear();

/** `/collections/art/<вид>-<цвет>.svg` либо null (неизвестный вид/цвет, файл не грузился). */
export function artUrl(kind, color) {
  if (!KINDS.includes(kind) || !isColor(color)) return null;
  const url = `${ART_DIR}${kind}-${color}.svg`;
  return failed.has(url) ? null : url;
}

/** Цвет предмета из каталога (для CSS-переменных, не для окраски интерфейса). */
export const colorInfo = (color) => COLORS.find((c) => c.id === color) ?? null;

/** Запись `{item, color}` из вида → она же, если предмет ровно тот, что положен в это поле; иначе null. */
function entry(raw, field) {
  if (!raw || typeof raw !== 'object') return null;
  return publicEntry(raw, { back: 'cardback', table: 'table', frame: ['profile', 'frame'] }[field]);
}

/** Стол комнаты: `{color, ornament, diamond}` (адреса могут быть null — тогда без этого слоя) либо null. */
export function tableOf(look) {
  const e = entry(look?.table, 'table');
  if (!e) return null;
  if (itemById(e.item)?.collection) { const src = gameAsset(e, 'table'); return src ? { color: 'v2', ornament: src, diamond: null } : null; }
  const ornament = artUrl('table-ornament', e.color);
  const diamond = artUrl('table-diamond', e.color);
  return ornament || diamond ? { color: e.color, ornament, diamond } : null;
}

/** Рубашка закрытых карт этого места: `{color, src}` либо null. Одна запись на место; лишнее игнорируется. */
export function backOf(look, seat) {
  if (!Array.isArray(look?.backs) || !Number.isInteger(seat)) return null;
  const raw = look.backs.find((b) => b && b.seat === seat);
  const e = entry(raw, 'back');
  const src = e && (itemById(e.item)?.collection ? gameAsset(e, 'cardback') : artUrl('cardback-small', e.color));
  return src ? { color: e.color, src } : null;
}

/** Рамка и знак игрока (`players[i].frame`): `{color, frame, mark}` либо null. */
export function frameOf(frame) {
  const e = entry(frame, 'frame');
  if (!e) return null;
  if (itemById(e.item)?.collection) { const src = gameAsset(e, 'frame'); return src ? { color: 'v2', frame: src, mark: null } : null; }
  const f = artUrl('frame-small', e.color);
  const m = artUrl('mark', e.color);
  return f || m ? { color: e.color, frame: f, mark: m } : null;
}

/**
 * «Держатель снимка»: вид не меняется посреди раздачи.
 * `hold(roomKey, status, look)` возвращает тот `look`, который надо показывать:
 *  • лобби — всегда свежий (выбор там действует сразу);
 *  • идёт раздача/партия — тот, что взят при её начале; новый берём только при смене комнаты или `dealNo`;
 *  • нет `look` (старый сервер, игра без оформления) — база (null).
 * Переподключение приносит тот же `dealNo`, поэтому держатель ничего не меняет.
 */
export function makeHolder() {
  let kept = null; // { roomKey, dealNo, look }
  return {
    hold(roomKey, status, look) {
      if (!look || typeof look !== 'object') { kept = null; return null; }
      const dealNo = Number.isInteger(look.dealNo) ? look.dealNo : 0;
      const sameDeal = kept && kept.roomKey === roomKey && kept.dealNo === dealNo && status !== 'lobby';
      if (!sameDeal) kept = { roomKey, dealNo, look };
      else if (look.v === 2) {
        // A server revocation can remove a frozen decoration; it cannot add/change one mid-hand.
        const next = { ...kept.look };
        for (const key of ['table', 'board', 'deckBack']) if (!look[key]) next[key] = null;
        if (Array.isArray(next.backs)) next.backs = next.backs.filter((b) => look.backs?.some((x) => x.seat === b.seat && x.item === b.item && x.color === b.color));
        kept.look = next;
      }
      return kept.look;
    },
    reset() { kept = null; },
  };
}

/* ------------------------------------------------------------------ DOM */

const make = (tag, cls, attrs = {}) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

/** Картинка-украшение: не читается экраном, не ловит нажатия; при ошибке — исчезает и адрес запоминается. */
function deco(url, cls, onFail) {
  const img = make('img', cls, { src: url, alt: '', 'aria-hidden': 'true', draggable: 'false' });
  img.addEventListener('error', () => { markFailed(url); img.remove(); onFail?.(); }, { once: true });
  return img;
}

/**
 * Стол хоста: орнамент по краю овала и центральный ромб — слоями ВНУТРИ `felt`
 * (под сиденьями, картами, банком; нажатия не ловят). Раскладка не меняется: слои абсолютные.
 */
export function dressTable(felt, look) {
  try {
    const t = tableOf(look);
    if (!felt || !t) return false;
    felt.classList.add('gr-table', `gr-${t.color}`);
    felt.dataset.grTable = t.color;
    if (t.ornament) felt.append(deco(t.ornament, 'gr-orn', () => {
      if (t.color === 'v2') { felt.classList.remove('gr-table', 'gr-v2'); delete felt.dataset.grTable; }
    }));
    if (t.diamond) felt.append(deco(t.diamond, 'gr-dia'));
    return true;
  } catch { return false; }
}

/**
 * Ромб центра — декор, и «центр свободен»: ставим его на первое место из списка, где он не лежит
 * ни под банком, ни под картами, ни под ставкой, ни под сиденьями; нет такого места — прячем.
 * Меряем готовую раскладку (после `layoutTable`/`layoutDurak`); сами они не меняются.
 * `avoid` — селекторы того, что должно оставаться читаемым; `root` — где их искать.
 */
const SPOTS = [0.78, 0.9, 0.66, 0.5, 0.34, 0.22, 0.1];
export function placeDiamond(felt, root, avoid) {
  try {
    const dia = felt?.querySelector('img.gr-dia');
    if (!dia || !root) return;
    const fr = felt.getBoundingClientRect();
    if (!fr.width || !fr.height) return;
    const pad = 6;
    const rects = [...root.querySelectorAll(avoid)].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    const size = dia.getBoundingClientRect().width || 28;
    const cx = fr.left + fr.width / 2;
    for (const y of SPOTS) {
      const cy = fr.top + fr.height * y;
      const box = { l: cx - size / 2 - pad, r: cx + size / 2 + pad, t: cy - size / 2 - pad, b: cy + size / 2 + pad };
      if (rects.some((r) => r.left < box.r && r.right > box.l && r.top < box.b && r.bottom > box.t)) continue;
      dia.style.display = '';
      dia.style.top = `${(y * 100).toFixed(1)}%`;
      return;
    }
    dia.style.display = 'none';
  } catch { /* декор: без ромба игра не страдает */ }
}
export const POKER_AVOID = '.center .pot, .center .board > *, .center .bet-line, .center .result-line, .seat .pod, .seat .info, .seat .plate';
export const DURAK_AVOID = '.dk-pair, .dk-line, .dk-deck, .dk-discard, .dk-seat .pod, .dk-seat .info, .dk-seat .plate';

/** Рубашка места в игре: готовый `<img>` с классом `card` либо null (тогда рисуется обычная). */
export function backImgFor(look, seat, cls = '') {
  try {
    const b = backOf(look, seat);
    if (!b) return null;
    const img = make('img', `card gr-back${cls ? ` ${cls}` : ''}`, { src: b.src, alt: 'back', draggable: 'false' });
    img.dataset.grBack = b.color;
    img.addEventListener('error', () => { markFailed(b.src); img.removeAttribute('data-gr-back'); img.classList.remove('gr-back'); img.src = '/cards/back.svg'; }, { once: true });
    return img;
  } catch { return null; }
}

/**
 * Рамка вокруг уже построенного аватара — только лобби и итоги. Возвращает обёртку
 * (аватар внутри, размер как у аватара, рамка шире него и не обрезает) либо сам аватар, если рамки нет.
 */
export function frameAvatar(av, frame) {
  try {
    const f = frameOf(frame);
    if (!av || !f || !f.frame || av.dataset?.v2Frame) return av;
    if (f.color === 'v2') {
      av.classList.add('cv2-avatar'); av.dataset.v2Frame = frame.item;
      av.append(deco(f.frame, 'cv2-frame', () => { delete av.dataset.v2Frame; }));
      return av;
    }
    const wrap = make('span', `gr-ava gr-${f.color}`);
    wrap.dataset.grFrame = f.color;
    wrap.append(av);
    wrap.append(deco(f.frame, 'gr-frame', () => { wrap.classList.add('gr-bare'); delete wrap.dataset.grFrame; }));
    return wrap;
  } catch { return av; }
}

/**
 * Имя со знаком: `<span class="gr-nm">` — знак слева, имя сокращается многоточием (знак не расширяет строку);
 * полное имя — в подписи (`aria-label` + `title`). Без знака возвращает `null` (вызывающий оставит как было).
 */
export function nameWithMark(name, frame, badge = null) {
  try {
    const b = gameAsset(badge, 'badge');
    const f = frameOf(frame);
    const src = b || f?.mark;
    if (!src) return null;
    const box = make('span', 'gr-nm', { 'aria-label': String(name), title: String(name) });
    const mark = deco(src, 'gr-mark', () => box.classList.add('gr-nomark'));
    mark.dataset.grMark = b ? badge.item : f.color;
    if (b) { const title = itemById(badge.item).title; box.setAttribute('aria-label', `${name} · ${title}`); mark.title = title; }
    const text = make('span', 'gr-nm-t');
    text.textContent = String(name);
    box.append(mark, text);
    return box;
  } catch { return null; }
}

/** Resolve only catalog-owned paths; preview never supplies a public choice or a URL. */
export function gameAsset(raw, slot, game = null) {
  const e = publicEntry(raw, slot, game);
  const src = e && itemById(e.item)?.assets?.game;
  return typeof src === 'string' && src.startsWith('/collections/v2-art/') && !failed.has(src) ? src : null;
}

/** External art frame. The board, coordinates and all interactive children retain their geometry. */
export function dressBoard(el, look, game) {
  const slot = game === 'battleship' ? 'battleship-panel' : `${game}-board`;
  const src = gameAsset(look?.board, slot, game);
  if (el && src) {
    el.classList.add('cv2-board'); el.dataset.v2Board = look.board.item;
    el.append(deco(src, `cv2-board-art cv2-${game}`, () => { delete el.dataset.v2Board; }));
  }
  return el;
}
export function deckBackImg(look, cls = '') {
  const src = gameAsset(look?.deckBack, 'unoq-cardback', 'colors');
  if (!src) return null;
  const img = make('img', `cl-img cv2-deck-back ${cls}`, { src, alt: 'Закрытая карта', draggable: 'false' });
  img.addEventListener('error', () => { markFailed(src); img.src = '/colors/back.svg'; img.classList.remove('cv2-deck-back'); }, { once: true });
  return img;
}
