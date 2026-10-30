/**
 * Каталог игр карточками: страницы, «‹ ›», точки, свайп (прокрутка со «защёлкой»).
 * Работает без жестов: кнопки и точки — обычные кнопки от 44 px. Список игр приходит
 * снаружи (из реестра), число страниц считается из него. Позиция запоминается по ключу,
 * поэтому возврат на экран открывает ту же страницу.
 */
import { h, haptic } from './ui.js';
import { perPage, paginate, clampPage, pageAt, pageLabel, rememberPage, recallPage } from './catalog-pager.js';

const arrow = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;

/**
 * @param games    список игр (как пришёл с сервера)
 * @param key      по чему запоминать страницу
 * @param card     (game) => Element
 * @param empty    текст, когда игр нет
 */
export function gameCatalog({ games, key, card, empty = 'Игр пока нет.' }) {
  const list = Array.isArray(games) ? games : [];
  if (!list.length) return h('div.hint.gc-empty', empty);
  const pages = paginate(list, perPage(window.innerHeight));
  const count = pages.length;
  let page = recallPage(key, count);

  const track = h('div.gc-track', { tabindex: '-1', 'aria-label': 'Каталог игр' },
    pages.map((items, i) => h('div.gc-page', { 'data-page': String(i) }, items.map(card))));
  const root = h('div.gc-pager', track);
  if (count === 1) return root; // одна страница: ни кнопок, ни точек

  const label = h('div.gc-pagelabel', { 'aria-live': 'polite' });
  const prev = h('button.gc-nav.gc-prev', { type: 'button', 'aria-label': 'Предыдущая страница', html: arrow('M15 5l-7 7 7 7'), onclick: () => to(page - 1, true) });
  const next = h('button.gc-nav.gc-next', { type: 'button', 'aria-label': 'Следующая страница', html: arrow('M9 5l7 7-7 7'), onclick: () => to(page + 1, true) });
  const dots = pages.map((_, i) => h('button.gc-dot', { type: 'button', 'aria-label': pageLabel(i, count), onclick: () => to(i, true) }));
  const bar = h('div.gc-bar', prev, h('div.gc-dots', dots), next);
  root.append(bar, label);

  function mark() {
    page = clampPage(page, count);
    prev.disabled = page === 0;
    next.disabled = page === count - 1;
    label.textContent = pageLabel(page, count);
    dots.forEach((d, i) => { d.classList.toggle('on', i === page); d.setAttribute('aria-current', i === page ? 'true' : 'false'); });
    rememberPage(key, page);
  }
  function to(i, smooth) {
    page = clampPage(i, count);
    if (smooth) haptic.soft?.();
    track.scrollTo?.({ left: page * track.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
    mark();
  }
  let settle = null;
  track.addEventListener('scroll', () => {
    clearTimeout(settle);
    settle = setTimeout(() => { const p = pageAt(track.scrollLeft, track.clientWidth, count); if (p !== page) { page = p; mark(); } }, 80);
  }, { passive: true });
  // Узел попадает в страницу позже (экран собирают целиком): позицию выставляем, когда он уже виден.
  requestAnimationFrame(() => { track.scrollTo?.({ left: page * track.clientWidth, behavior: 'instant' }); });
  mark();
  return root;
}
