/**
 * Крошечный помощник построения DOM для виджетов Тренировки (агент X).
 * Свой, а не `ui.js`: `ui.js` тянет за собой Telegram и рисует шторки, а
 * виджеты должны грузиться и в тестах/превью без него.
 * `el('div.a.b', {onclick, 'aria-label': '…'}, дети…)`. Тексты — только через
 * textContent (никакого innerHTML: в заданиях бывают чужие строки).
 */
export function el(tag, attrs, ...kids) {
  const [name, ...cls] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (cls.length) node.className = cls.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    kids.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className += (node.className ? ' ' : '') + v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) node.style.setProperty(sk, String(sv));
        else node.style[sk] = sv;
      }
    } else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

/** Поставить/снять класс по условию. */
export const flag = (node, cls, on) => node.classList.toggle(cls, !!on);

/**
 * Клавиатура телефона не должна закрывать кнопку: пока поле в фокусе, снизу
 * виджета добавляется запас, равный высоте клавиатуры (по visualViewport).
 * Прокрутку не трогаем — запас просто даёт странице докрутиться самой.
 */
export function keepAboveKeyboard(input, host) {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    host.style.setProperty('--tm-kb', `${document.activeElement === input ? kb : 0}px`);
  };
  input.addEventListener('focus', apply);
  input.addEventListener('blur', () => host.style.setProperty('--tm-kb', '0px'));
  vv.addEventListener('resize', apply);
}
