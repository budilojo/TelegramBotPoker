/**
 * Применение «вида» на экране: сукно, рамка аватара, звание, эффект победы, переключатель эффектов.
 * Всё — только на этом телефоне (режим примерки): на сервер не уходит, другим не показывается.
 * Рубашка карт применяется в `ui.js` (`backImg`) через `art.js`, реакции — в `reactions.js`.
 *
 * Подключается импортом: при загрузке подписывается на `onLook`, обновляет сукно и просит
 * экран перерисоваться (`bus.render`), кроме примерочной — она обновляет себя сама.
 */
import { h, REDUCED, spawn, haptic } from '../ui.js';
import { bus } from '../net.js';
import { itemById } from './catalog.js';
import { getLook, onLook } from './look.js';
import { artSrc, REAL_ART } from './art.js';

/* ----------------------------------------------------------------- сукно */

/** Сукно — на <html>: цвет из каталога и (когда есть настоящий файл) текстура. */
export function applyFelt() {
  const root = document.documentElement;
  const it = itemById(getLook().felt);
  if (!it) {
    delete root.dataset.cosFelt;
    root.style.removeProperty('--cos-felt');
    root.style.removeProperty('--cos-felt-tex');
    return;
  }
  root.dataset.cosFelt = it.id;
  root.style.setProperty('--cos-felt', it.tokens?.felt || '#4a0f1f');
  if (REAL_ART && it.file) root.style.setProperty('--cos-felt-tex', `url(${it.file})`);
  else root.style.removeProperty('--cos-felt-tex');
}

/* ---------------------------------------------------------------- рамка */

/** Рамка поверх круга аватара — кладётся внутрь `.av`, не меняя его размеров. Только у вашего аватара. */
export function frameOn(av) {
  const it = itemById(getLook().frame);
  const src = artSrc(it);
  if (!av || !src) return av;
  av.classList.add('cos-framed');
  const img = h('img.cos-frame', { src, alt: '', draggable: 'false', 'data-frame': it.id });
  img.addEventListener('error', () => img.remove(), { once: true });
  av.append(img);
  return av;
}

/* --------------------------------------------------------------- звание */

/** Строка-звание под ником («Крупье») или null. */
export function titleEl() {
  const it = itemById(getLook().title);
  return it ? h('div.cos-title', { 'data-title': it.id }, it.title) : null;
}

/* ------------------------------------------------- «не показывать эффекты» */

const FX_KEY = 'fx-off';
let fxFallback = false;
export function fxOff() {
  try {
    return localStorage.getItem(FX_KEY) === '1' || fxFallback;
  } catch {
    return fxFallback;
  }
}
export function setFxOff(on) {
  try {
    if (on) localStorage.setItem(FX_KEY, '1');
    else localStorage.removeItem(FX_KEY);
    fxFallback = false;
  } catch {
    fxFallback = on;
  }
  if (on) stopFx();
}

/** Пункт меню стола «Не показывать эффекты» — есть, только когда выбран эффект победы. */
export function effectsMenuItem(closeSheet) {
  if (!getLook().effect) return null;
  const off = fxOff();
  return h('button.menu-item', {
    'data-fx-toggle': off ? 'off' : 'on',
    onclick: () => { setFxOff(!off); haptic.soft?.(); closeSheet?.(); },
  }, off ? 'Показывать эффекты' : 'Не показывать эффекты', h('small', off ? 'сейчас скрыты на этом телефоне' : 'дождь из фишек при победе; только у вас'));
}

/* ------------------------------------------------------- эффект победы */

const MAX_PARTICLES = 22;
let live = [];

function stopFx() {
  for (const el of live) el.remove();
  live = [];
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopFx(); });

/**
 * «Дождь из фишек»: ≤22 частиц падают 1–2 секунды в слое #fx (поверх стола, без нажатий — pointer-events:none
 * у слоя). Не мигает: частицы только падают и гаснут. Выключен при `prefers-reduced-motion`, в «Не показывать
 * эффекты», при скрытой вкладке и когда эффект не выбран. Возвращает, запустился ли.
 */
export function winFx({ delay = 0 } = {}) {
  const it = itemById(getLook().effect);
  if (!it || REDUCED || fxOff() || document.hidden) return false;
  stopFx();
  const W = document.documentElement.clientWidth;
  const H = document.documentElement.clientHeight;
  const chip = artSrc(it);
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const star = i % 3 === 2;
    const x = (W * (i + 0.5 + (Math.random() - 0.5) * 0.7)) / MAX_PARTICLES;
    const drift = (Math.random() - 0.5) * 60;
    const size = star ? 16 : 22 + Math.round(Math.random() * 8);
    const dur = 1100 + Math.random() * 400;
    const el = spawn(star ? 'span.cos-fx.cos-fx-star' : 'img.cos-fx.cos-fx-chip', { x, y: -size }, [
      { transform: 'translate(0, 0) rotate(0deg)', opacity: 0 },
      { opacity: 1, offset: 0.12 },
      { opacity: 1, offset: 0.8 },
      { transform: `translate(${drift}px, ${H * 0.9}px) rotate(${(Math.random() - 0.5) * 540}deg)`, opacity: 0 },
    ], { duration: dur, delay: delay + Math.random() * 400, easing: 'cubic-bezier(0.4, 0, 0.9, 0.6)' },
    star ? null : { src: chip, alt: '', draggable: 'false' });
    if (!el) continue;
    if (star) { el.textContent = '★'; el.style.fontSize = `${size}px`; }
    else { el.style.width = `${size}px`; el.style.height = `${size}px`; el.style.margin = `${-size / 2}px 0 0 ${-size / 2}px`; }
    live.push(el);
    const done = () => { live = live.filter((x) => x !== el); };
    el.addEventListener('animationend', done);
    setTimeout(done, delay + 2200);
  }
  return live.length > 0;
}

/* ------------------------------------------------------------ подключение */

applyFelt();
onLook(() => {
  applyFelt();
  // Примерочная обновляет себя сама; живой стол и остальные — перерисовкой экрана.
  if (!document.querySelector('.cos-fit')) bus.render?.();
});
