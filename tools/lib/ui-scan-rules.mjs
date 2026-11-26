/**
 * Правила автоскана вёрстки (tools/ui-scan.mjs), две половины:
 *
 *   collect()  выполняется В СТРАНИЦЕ и только меряет: прямоугольники, строки текста,
 *              что окажется под пальцем (elementFromPoint). Ничего не оценивает.
 *   analyze()  чистая функция в Node: из замеров делает находки. Проверяется без браузера
 *              (tools/ui-scan.test.js).
 *
 * collect() передаётся в page.evaluate целиком, поэтому она не может ссылаться на
 * что-то вне своего тела.
 */

/** Замеры верхнего слоя экрана: открытая шторка/чат/магазин закрывает всё, что под ними. */
export function collect() {
  const vw = innerWidth;
  const vh = innerHeight;
  const shown = (el) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  // Верхний слой: шторка, затем панель чата, затем магазин; иначе вся страница.
  const layer = ['#sheet-root .sheet', '.chat-panel', '.col-root']
    .map((s) => document.querySelector(s)).find((el) => el && shown(el)) || document.body;

  const box = (r) => ({ l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1) });
  const name = (el) => {
    const cls = [...el.classList].slice(0, 3).join('.');
    const data = ['data-card', 'data-sq', 'data-tab', 'data-item', 'data-act', 'data-seat'].find((a) => el.hasAttribute(a));
    return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (cls ? `.${cls}` : '') + (data ? `[${data}="${el.getAttribute(data)}"]` : '');
  };
  const path = (el) => {
    const out = [];
    for (let e = el; e && e !== document.body && out.length < 3; e = e.parentElement) out.unshift(name(e));
    return out.join(' > ') || 'body';
  };

  const INTERACTIVE = 'button,a[href],input,select,textarea,summary,[role=button],[role=radio],[role=tab],.dk-card,.cl-card';
  const nodes = [];
  const index = new Map();
  const walk = (el, parent, hidden, faded) => {
    if (el.nodeType !== 1) return;
    if (['SCRIPT', 'STYLE', 'TEMPLATE', 'OPTION', 'BR'].includes(el.tagName)) return;
    // Тосты и слой эффектов живут секунду — их мерить нечего.
    if (el.id === 'toast' || el.id === 'fx') return;
    const s = getComputedStyle(el);
    if (s.display === 'none') return;
    const opacity = faded * Number(s.opacity);
    const invisible = s.visibility === 'hidden' || opacity < 0.05;
    const r = el.getBoundingClientRect();
    const i = nodes.length;
    const decor = hidden || el.getAttribute('aria-hidden') === 'true';
    const node = {
      i, p: parent, sel: path(el), tag: el.tagName.toLowerCase(), cls: el.getAttribute('class') || '',
      rect: box(r), invisible, decor,
      ox: s.overflowX, oy: s.overflowY, pos: s.position, ellipsis: s.textOverflow === 'ellipsis',
      clamp: s.webkitLineClamp && s.webkitLineClamp !== 'none' ? Number(s.webkitLineClamp) : 0,
      boxed: (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') || parseFloat(s.borderLeftWidth) > 0 || parseFloat(s.borderRightWidth) > 0,
      sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight,
      transform: s.transform !== 'none', srOnly: (r.width <= 1.5 || r.height <= 1.5) && (s.position === 'absolute' || s.position === 'fixed'),
      interactive: el.matches(INTERACTIVE) && !el.disabled && s.pointerEvents !== 'none',
      media: el.tagName === 'IMG' || el.tagName === 'svg' || el.tagName === 'CANVAS',
      text: '', lines: [], coveredBy: null, reach: null, tap: null,
    };
    nodes.push(node);
    index.set(el, i);

    // Строки собственного текста: по буквам, чтобы видеть переносы внутри слова.
    if (!invisible && !['svg', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
      const range = document.createRange();
      const lines = [];
      let budget = 600;
      for (const t of el.childNodes) {
        if (t.nodeType !== 3 || !t.textContent.trim()) continue;
        const chars = t.textContent;
        for (let k = 0; k < chars.length && budget > 0; k++, budget--) {
          range.setStart(t, k);
          range.setEnd(t, k + 1);
          const c = range.getClientRects()[0];
          if (!c || c.width === 0) {
            if (lines.length) lines.at(-1).text += chars[k];
            continue;
          }
          const mid = (c.top + c.bottom) / 2;
          let line = lines.at(-1);
          if (!line || mid < line.t || mid > line.b) lines.push((line = { text: '', l: c.left, t: c.top, r: c.right, b: c.bottom }));
          line.text += chars[k];
          line.l = Math.min(line.l, c.left);
          line.r = Math.max(line.r, c.right);
        }
        node.text += chars;
      }
      node.text = [...node.text.replace(/\s+/g, ' ').trim()].slice(0, 80).join(''); // по символам: эмодзи не разрезаем
      node.lines = lines.filter((x) => x.text.trim()).map((x) => ({ text: x.text, ...box({ left: x.l, top: x.t, right: x.r, bottom: x.b }) }));
    }
    if (el.matches('input,select,textarea')) node.text = (el.value || el.placeholder || el.getAttribute('aria-label') || '').slice(0, 80);
    if (!node.text) node.label = (el.getAttribute('aria-label') || el.getAttribute('alt') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50);

    if (el.tagName !== 'svg') for (const kid of el.children) walk(kid, i, decor, opacity);
  };
  walk(layer, -1, false, 1);

  // Что под пальцем: пять точек элемента (или первой строки текста).
  const related = (hit, el) => hit && (hit === el || el.contains(hit) || hit.contains(el));
  const els = [...index.entries()];
  for (const [el, i] of els) {
    const n = nodes[i];
    if (n.invisible || n.decor || n.srOnly || !(n.interactive || n.lines.length)) continue;
    const r = n.interactive ? el.getBoundingClientRect() : { left: n.lines[0].l, top: n.lines[0].t, right: n.lines[0].r, bottom: n.lines[0].b };
    const w = r.right - r.left;
    const hgt = r.bottom - r.top;
    const pts = [[0.5, 0.5], [0.2, 0.3], [0.8, 0.3], [0.2, 0.7], [0.8, 0.7]]
      .map(([x, y]) => [r.left + w * x, r.top + hgt * y])
      .filter(([x, y]) => x >= 0 && x < vw && y >= 0 && y < vh);
    // Точки, обрезанные прокруткой родителя, не в счёт: туда просто ещё не докрутили.
    const inside = pts.filter(([x, y]) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const c = p.getBoundingClientRect();
        if (x < c.left || x > c.right || y < c.top || y > c.bottom) return false;
      }
      return true;
    });
    if (!inside.length) continue;
    let free = 0;
    let top = null;
    for (const [x, y] of inside) {
      const hit = document.elementFromPoint(x, y);
      // Элемент с pointer-events:none под пальцем не отзывается — это не «закрыт».
      if (!hit || related(hit, el) || getComputedStyle(el).pointerEvents === 'none') free++;
      else top = hit;
    }
    n.reach = free / inside.length;
    if (top && n.reach < 0.5) n.coveredBy = path(top);
    // Закрытое нижней панелью может открываться прокруткой: ставим элемент в середину своего списка и пробуем ещё раз.
    if (n.reach === 0) {
      let sc = el.parentElement;
      while (sc && !(/auto|scroll/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight + 2)) sc = sc.parentElement;
      if (sc) {
        const was = sc.scrollTop;
        const c = sc.getBoundingClientRect();
        const e = el.getBoundingClientRect();
        sc.scrollTo({ top: was + (e.top + e.height / 2) - (c.top + Math.min(c.height, vh - c.top) / 2), behavior: 'instant' });
        const now = el.getBoundingClientRect();
        const hit = document.elementFromPoint(now.left + now.width / 2, now.top + now.height / 2);
        if (related(hit, el)) { n.reach = 0.5; n.coveredBy = null; }
        sc.scrollTo({ top: was, behavior: 'instant' });
      }
    }
    // Зона нажатия может быть шире самого элемента (псевдоэлемент): пробуем крест 44×44.
    const b = el.getBoundingClientRect();
    if (n.interactive && (b.width < 43.5 || b.height < 43.5)) {
      const label = el.closest('label');
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      const dx = b.width < 43.5 ? 21 : 0;
      const dy = b.height < 43.5 ? 21 : 0;
      const wide = [[cx - dx, cy - dy], [cx + dx, cy + dy]].every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit && (hit === el || el.contains(hit));
      });
      const lb = label?.getBoundingClientRect();
      n.tap = { extended: wide || !!(lb && lb.width >= 43.5 && lb.height >= 43.5) };
    }
  }

  const doc = document.documentElement;
  return { vw, vh, docW: Math.max(doc.scrollWidth, document.body.scrollWidth), layer: path(layer), nodes };
}

/**
 * Что скан сознательно не считает дефектом — и почему. Каждая строка должна объяснять причину;
 * «чтобы было зелено» причиной не является.
 */
export const ALLOW = [
  { types: ['small-target'], sel: /ch-sq|bs-cell|nd-pt|ck-sq/, why: 'клетки доски и пункты нард: 8–12 в ряд на 320 px по 44 px не помещаются — это игровое поле' },
  { types: ['small-target', 'covered'], sel: /dk-card|cl-card/, why: 'веер карт в руке: карты нарочно перекрывают друг друга, открытая полоса и подъём карты — жест игры' },
  { types: ['offscreen', 'out-of-parent'], sel: /dk-deck|dk-discard/, why: 'колода и бита нарочно подрезаны краем стола (это проверяет npm run layout)' },
  { types: ['offscreen'], sel: /dk-trump/, why: 'козырь под колодой у края стола — часть той же нарочно подрезанной колоды' },
  { types: ['text-overlap'], sel: /amount-sub/, why: 'шторка суммы прокручивается: подпись уходит под закреплённую кнопку' },
  { types: ['text-overlap'], sel: /pod > div\.av/, why: 'число карт значком поверх аватара — так нарисовано место игрока' },
  { types: ['offscreen'], sel: /dk-card|cl-card|cl-hand/, why: 'большая рука прокручивается или складывается веером за край' },
  { types: ['hscroll-box'], sel: /col-chips|rt-chips|cl-hand|cl-row|dk-hand|gc-track|gc-pages|catalog|chat-quick|chat-tabs|col-hand|tr-strip|ln-strip|range-scroll|emoji|rx-/, why: 'ряд, который по замыслу листается пальцем вбок' },
  { types: ['covered'], by: /sheet-root|sheet-back|backdrop/, why: 'под шторкой — так и задумано' },
];

const EPS = 1.5;
const inter = (a, b) => ({ w: Math.min(a.r, b.r) - Math.max(a.l, b.l), h: Math.min(a.b, b.b) - Math.max(a.t, b.t) });
const clips = (v) => v === 'hidden' || v === 'clip';
const scrolls = (v) => v === 'auto' || v === 'scroll';
const LETTER = /[\p{L}]/u;
/** Одиночная половина суррогатной пары или знак замены: на экране это «�». */
const BARE_NUMBER = /(?<![\p{L}\p{N}_.\-/#:])\d{5,}(?![\p{L}\p{N}_.\-/])/u;
const BROKEN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\uFFFD/;

/** Серьёзность по умолчанию: block — действие недоступно; major — мешает читать или попасть; minor — косметика. */
const SEVERITY = {
  'hscroll-page': 'block', unreachable: 'block', 'covered-action': 'block',
  offscreen: 'major', clipped: 'major', 'out-of-box': 'major', 'text-overlap': 'major', 'covered-text': 'major',
  'word-break': 'major', 'small-target': 'major', 'hscroll-box': 'major', 'broken-char': 'major', 'bare-number': 'major', crushed: 'major', 'cut-label': 'major', 'under-fab': 'major',
  'out-of-parent': 'minor', ellipsis: 'minor', orphan: 'minor',
};

/**
 * @param {Array} passes замеры одного экрана при разных положениях прокрутки (первый — как открылся)
 * @returns {Array<{type,severity,sel,text,rect,detail,allowed?}>}
 */
export function analyze(passes, { allow = ALLOW } = {}) {
  const found = new Map();
  const add = (type, n, detail, extra = {}) => {
    const key = `${type}|${n.sel}|${n.text || n.label || ''}`;
    if (found.has(key)) return;
    const rule = allow.find((a) => a.types.includes(type) && (!a.sel || a.sel.test(n.sel)) && (!a.by || a.by.test(extra.by || '')));
    found.set(key, { type, severity: SEVERITY[type], sel: n.sel, text: n.text || n.label || '', rect: n.rect, detail, ...(rule ? { allowed: rule.why } : {}) });
  };

  for (const data of passes) {
    const { vw, vh, nodes, docW } = data;
    const up = (n) => (n.p >= 0 ? nodes[n.p] : null);
    const ancestors = (n) => {
      const out = [];
      for (let a = up(n); a; a = up(a)) out.push(a);
      return out;
    };
    if (docW > vw + EPS) add('hscroll-page', { sel: 'html', text: '', rect: { l: 0, t: 0, r: docW, b: vh } }, `страница шириной ${docW} при экране ${vw}`);

    const textNodes = [];
    for (const n of nodes) {
      if (n.invisible || n.srOnly) continue;
      const w = n.rect.r - n.rect.l;
      const hgt = n.rect.b - n.rect.t;
      const above = ancestors(n);
      // Текст есть, а ширины ему не досталось вовсе: соседи вытолкнули его из строки.
      if (w < 1.5 && hgt > 0 && n.text && !n.decor) add('crushed', n, 'тексту не досталось ни пикселя ширины — на экране его нет');
      if (w <= 0 || hgt <= 0) continue;
      const inHScroll = above.some((a) => scrolls(a.ox));
      const meaningful = !n.decor && (n.lines.length || n.interactive || n.media);

      if (scrolls(n.ox) && n.sw > n.cw + EPS && n.tag !== 'textarea' && n.tag !== 'input') add('hscroll-box', n, `внутри ${n.sw} px при видимых ${n.cw}`);

      // За краем экрана (внутри горизонтальной прокрутки это уже учтено выше).
      if (meaningful && !inHScroll && (n.rect.r > vw + EPS || n.rect.l < -EPS)) {
        add('offscreen', n, `слева ${n.rect.l}, справа ${n.rect.r} при экране ${vw}`);
      }

      // Кнопка или плашка вылезла из своей карточки.
      const holder = above.find((a) => a.boxed);
      if (holder && (n.interactive || n.boxed) && !n.decor && n.pos !== 'absolute' && n.pos !== 'fixed' && !n.transform && !inHScroll && !scrolls(holder.ox)) {
        const over = Math.max(n.rect.r - holder.rect.r, holder.rect.l - n.rect.l);
        if (over > EPS) add('out-of-parent', n, `выходит за ${holder.sel} на ${over.toFixed(0)} px`);
      }

      // Вне досягаемости: ниже/правее экрана и прокрутить нечем.
      if (n.interactive && !n.decor && (n.rect.t >= vh - 4 || n.rect.b > vh + hgt / 2)) {
        const canScroll = above.some((a) => scrolls(a.oy) && a.sh > a.ch + EPS) || scrolls(n.oy);
        if (!canScroll) add('unreachable', n, `ниже экрана (${n.rect.t}…${n.rect.b} при высоте ${vh}), прокрутки нет`);
      }

      if (n.interactive && !n.decor && n.tap && !n.tap.extended) add('small-target', n, `${w.toFixed(0)}×${hgt.toFixed(0)} px, нужно не меньше 44×44`);

      if (n.coveredBy && n.reach === 0) {
        // Закрыто в одном положении прокрутки, но открыто в другом — не дефект (ниже отсеется).
        n.covered = true;
      }

      if (BROKEN.test(n.text)) add('broken-char', n, 'на экране половина символа («�») — эмодзи разрезан пополам');

      // Правило проекта: числа с точками. Поля ввода и «ваш ID» — не числа игры.
      if (n.lines.length && !n.decor && !/\bID\b/.test(n.text) && BARE_NUMBER.test(n.text)) add('bare-number', n, 'большое число без точек (должно быть 1.000.000)');

      if (!n.lines.length || n.decor) continue;
      // Для «налезает» считается только то, что реально видно: срезанное родителем ни на что не налезает.
      const visible = n.lines.map((line) => [n, ...above].reduce((v, c) => ({
        l: c.ox === 'visible' ? v.l : Math.max(v.l, c.rect.l), r: c.ox === 'visible' ? v.r : Math.min(v.r, c.rect.r),
        t: c.oy === 'visible' ? v.t : Math.max(v.t, c.rect.t), b: c.oy === 'visible' ? v.b : Math.min(v.b, c.rect.b),
      }), line));
      textNodes.push({ ...n, seen: visible });

      // Обрезано: сам элемент или предок прячет то, что не поместилось.
      const clippers = [n, ...above];
      for (const line of n.lines) {
        let scrolledX = false;
        let scrolledY = false;
        for (const c of clippers) {
          scrolledX ||= scrolls(c.ox);
          scrolledY ||= scrolls(c.oy);
          const cutX = !scrolledX && clips(c.ox) ? Math.max(line.r - c.rect.r, c.rect.l - line.l) : 0;
          const cutY = !scrolledY && clips(c.oy) ? Math.max(line.b - c.rect.b, c.rect.t - line.t) : 0;
          if (cutX > EPS || cutY > Math.max(3, (line.b - line.t) * 0.25)) {
            const soft = ((n.ellipsis || c.ellipsis) && cutX > EPS) || n.clamp || c.clamp;
            // «…» — обычное сокращение длинного имени, пока видно хотя бы половину и не меньше ~5 букв.
            const wide = line.r - line.l;
            const seen = Math.min(line.r, c.rect.r) - Math.max(line.l, c.rect.l);
            const type = !soft ? 'clipped' : cutX > EPS && seen < wide / 2 && seen < 60 ? 'crushed' : 'ellipsis';
            // Надпись на самой кнопке, не поместившаяся целиком, — не «длинное имя», а сломанная кнопка.
            add(n.interactive && n.tag === 'button' && type !== 'clipped' ? 'cut-label' : type, n, `${type === 'ellipsis' ? 'текст свёрнут в «…»' : type === 'crushed' ? `от текста видно ${Math.max(0, seen).toFixed(0)} px из ${wide.toFixed(0)}` : 'буквы срезаны'} (${c.sel}, не поместилось ${Math.max(cutX, cutY).toFixed(0)} px)`);
            break;
          }
        }
      }
      // Буквы вылезли из кнопки/плашки.
      const frame = n.boxed ? n : above.find((a) => a.boxed);
      if (frame && !clips(frame.ox) && !scrolls(frame.ox) && !inHScroll) {
        const over = Math.max(...n.lines.map((l) => Math.max(l.r - frame.rect.r, frame.rect.l - l.l)));
        const between = above.slice(0, above.indexOf(frame) + 1);
        if (over > EPS && ![n, ...between].some((a) => clips(a.ox) || a.pos === 'absolute')) add('out-of-box', n, `буквы выходят за ${frame.sel} на ${over.toFixed(0)} px`);
      }
      // Переносы: разорванное слово и одинокие буквы в строке.
      for (let k = 1; k < n.lines.length; k++) {
        const prev = n.lines[k - 1].text;
        const next = n.lines[k].text;
        if (LETTER.test(prev.at(-1) || '') && LETTER.test(next[0] || '') && n.lines[k].t > n.lines[k - 1].t + 2) {
          add('word-break', n, `слово разорвано: «${prev.trim().slice(-12)}» | «${next.trim().slice(0, 12)}»`);
        }
      }
      if (n.lines.length > 1) {
        const lone = n.lines.find((l) => /^\p{L}$/u.test(l.text.trim()));
        const last = n.lines.at(-1).text.trim();
        if (lone) add('orphan', n, `одна буква в строке: «${lone.text.trim()}»`);
        else if (last.length <= 2 && LETTER.test(last)) add('orphan', n, `в последней строке только «${last}»`);
      }
    }

    // Текст поверх текста (не родственники).
    for (let i = 0; i < textNodes.length; i++) {
      const a = textNodes[i];
      const aUp = new Set(ancestors(a).map((x) => x.i));
      for (let j = i + 1; j < textNodes.length; j++) {
        const b = textNodes[j];
        if (aUp.has(b.i) || ancestors(b).some((x) => x.i === a.i)) continue;
        // Закрытый целиком текст уже посчитан как «закрыт».
        if (a.reach === 0 || b.reach === 0 || a.reach === null || b.reach === null) continue;
        const hit = a.seen.some((x) => b.seen.some((y) => {
          const o = inter(x, y);
          return o.w > 3 && o.h > 4;
        }));
        if (hit) add('text-overlap', a, `налезает на «${b.text.slice(0, 40)}» (${b.sel})`);
      }
    }
  }

  // Плавающая кнопка чата лежит поверх всего — смотрим, что под ней на только что открытом экране.
  // Там, где экран листается, это лишь косметика: можно сдвинуть.
  const first = passes[0]?.nodes || [];
  const fab = first.find((n) => /(^| )chat-fab( |$)/.test(n.cls) && !n.invisible);
  if (fab) {
    for (const n of first) {
      if (n === fab || n.invisible || n.decor || n.srOnly || !(n.interactive || n.lines.length)) continue;
      let own = false;
      let scrollable = false;
      for (let a = n; a; a = a.p >= 0 ? first[a.p] : null) {
        own ||= a === fab;
        scrollable ||= scrolls(a.oy) && a.sh > a.ch + 2;
      }
      if (own) continue;
      const hit = (n.interactive ? [n.rect] : n.lines).some((r) => {
        const o = inter(r, fab.rect);
        return o.w > 8 && o.h > 8;
      });
      if (!hit) continue;
      add('under-fab', n, `под кнопкой чата${scrollable ? ' (экран листается — можно сдвинуть)' : ''}`);
      if (scrollable) found.get(`under-fab|${n.sel}|${n.text || n.label || ''}`).severity = 'minor';
    }
  }

  // «Закрыто»: ни в одном положении прокрутки элемент не был свободен.
  const free = new Set();
  const covered = new Map();
  for (const data of passes) {
    for (const n of data.nodes) {
      if (n.reach === null || n.decor) continue;
      const key = `${n.sel}|${n.text || n.label || ''}`;
      if (n.reach > 0) free.add(key);
      else if (n.coveredBy) covered.set(key, n);
    }
  }
  for (const [key, n] of covered) {
    if (free.has(key)) continue;
    add(n.interactive ? 'covered-action' : 'covered-text', n, `закрыт: ${n.coveredBy}`, { by: n.coveredBy });
  }
  return [...found.values()];
}

/** Короткая сводка по находкам одного экрана: только то, что не отсеяно правилами. */
export const real = (findings) => findings.filter((f) => !f.allowed);
