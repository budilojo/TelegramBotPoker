/**
 * Помощник проверки «прыжков» экрана (волна 3, агент Z; правила — docs/scroll.md).
 *
 *   import { measure, assertNoJump } from './lib/scroll-probe.mjs';
 *   await assertNoJump(page, { scroller: '.sheet', label: 'форма покера' }, () => page.getByRole('button', { name: '100/200' }).click());
 *
 * Что делает: находит прокручиваемый элемент (или берёт тот, что назван в
 * `scroller` — CSS-селектор или 'document'), запоминает его `scrollTop` и
 * `scrollHeight`, помечает узел меткой-свойством `__probe`, на время действия включает
 * наблюдатель на каждом кадре (ловит «подпрыгнул и вернулся»), выполняет
 * действие и смотрит, что вышло:
 *   • `jumped`     — прокрутка хоть на кадр ушла от прежней больше чем на 1 px;
 *   • `recreated`  — прокручиваемый узел пересоздан (метки уже нет);
 *   • `focusLost`  — фокус был в поле ввода, а ушёл (кнопки в счёт не идут).
 * Запрещено «чинить» тест возвратом scrollTop — смысл проверки в том, что
 * браузер сохраняет позицию сам, потому что узел-скроллер тот же.
 *
 * Это Chromium с эмуляцией телефона, а не настоящий iOS/Android WebView:
 * поведение экранной клавиатуры и жестов Telegram он не воспроизводит.
 */

/** Подготовить страницу: найти скроллер, поставить метку, прокрутить до `at`, запустить наблюдатель. */
async function arm(page, { scroller, at }) {
  return page.evaluate(({ scroller, at }) => {
    const isScrollable = (el) => {
      if (el === document.scrollingElement) return el.scrollHeight > el.clientHeight + 1;
      const o = getComputedStyle(el).overflowY;
      return (o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 1;
    };
    let sel = scroller;
    let el = null;
    if (!sel || sel === 'auto') {
      for (const s of ['.sheet', '.lobby', '#app', 'document']) {
        const e = s === 'document' ? document.scrollingElement : document.querySelector(s);
        if (e && isScrollable(e)) { sel = s; el = e; break; }
      }
    } else el = sel === 'document' ? document.scrollingElement : document.querySelector(sel);
    if (!el) return { error: `скроллер «${scroller}» не найден или не прокручивается` };
    const max = el.scrollHeight - el.clientHeight;
    const target = at === 'current' ? el.scrollTop : at === 'bottom' ? max : at === 'top' ? 0 : typeof at === 'number' ? Math.min(at, max) : Math.round(max / 2);
    el.scrollTop = target;
    const tag = String(Math.random()).slice(2);
    const mark = sel === 'document' ? document.documentElement : el;
    mark.__probe = tag; // не атрибут: экран вправе переписать атрибуты, но не узел
    const q = () => (sel === 'document' ? document.scrollingElement : document.querySelector(sel));
    const before = el.scrollTop;
    const probe = {
      sel, tag, before, heightBefore: el.scrollHeight, clientBefore: el.clientHeight, max, samples: 0,
      lo: before, hi: before, recreated: false,
      activeBefore: document.activeElement && document.activeElement !== document.body ? document.activeElement.tagName : null,
      stop: false,
    };
    const tick = () => {
      const cur = q();
      if (!cur || (sel !== 'document' && cur.__probe !== tag)) probe.recreated = true;
      else { probe.lo = Math.min(probe.lo, cur.scrollTop); probe.hi = Math.max(probe.hi, cur.scrollTop); }
      probe.samples++;
      if (!probe.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__probe = probe;
    return { sel, before, max: probe.max, heightBefore: probe.heightBefore };
  }, { scroller, at });
}

async function settle(page, ms) {
  await page.evaluate((ms) => new Promise((r) => {
    let n = 0;
    const f = () => (++n < 3 ? requestAnimationFrame(f) : setTimeout(r, ms));
    requestAnimationFrame(f);
  }), ms);
}

async function disarm(page) {
  return page.evaluate(() => {
    const p = window.__probe;
    p.stop = true;
    const q = p.sel === 'document' ? document.scrollingElement : document.querySelector(p.sel);
    const alive = q && (p.sel === 'document' || q.__probe === p.tag);
    return {
      sel: p.sel, before: p.before, after: q ? q.scrollTop : null,
      lo: p.lo, hi: p.hi, recreated: p.recreated || !alive, samples: p.samples,
      heightBefore: p.heightBefore, heightAfter: q ? q.scrollHeight : null, maxAfter: q ? Math.max(0, q.scrollHeight - q.clientHeight) : null,
      activeBefore: p.activeBefore,
      activeAfter: document.activeElement && document.activeElement !== document.body ? document.activeElement.tagName : null,
    };
  });
}

/**
 * Выполнить `action` и вернуть замер.
 * @param {object} opts  target: локатор Playwright — перед замером его ставят в середину экрана (иначе Playwright сам
 *                       прокрутит к кнопке при клике и это примут за прыжок), at тогда не нужен;
 *                       scroller: CSS-селектор | 'document' | 'auto'; at: 'middle' | 'top' | 'bottom' | число;
 *                       settleMs: сколько ждать после действия (по умолчанию 400 — длиннее анимации шторки 280).
 */
export async function measure(page, opts, action) {
  if (opts.target) await opts.target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const armed = await arm(page, { scroller: opts.scroller, at: opts.target ? 'current' : (opts.at ?? 'middle') });
  if (armed.error) return { error: armed.error, jumped: true, recreated: false };
  await action();
  await settle(page, opts.settleMs ?? 400);
  const r = await disarm(page);
  // Если содержимое стало короче и прежняя позиция уже за концом, браузер честно
  // упирается в конец — это не скачок. Скачок — любое иное расхождение.
  const expected = r.maxAfter == null ? r.before : Math.min(r.before, r.maxAfter);
  let dev = r.after == null ? Infinity : Math.abs(r.after - expected);
  // «Подпрыгнул и вернулся»: на каком-то кадре ушло за пределы между прежним и итоговым.
  if (r.after != null) dev = Math.max(dev, r.hi - Math.max(r.before, r.after), Math.min(r.before, r.after) - r.lo);
  return {
    ...r, scrollable: armed.max > 1, max: armed.max, deviation: dev,
    jumped: dev > 1,
    focusLost: ['INPUT', 'TEXTAREA', 'SELECT'].includes(r.activeBefore) && r.activeAfter !== r.activeBefore,
  };
}

/** То же, но бросает ошибку с понятным текстом, если экран подпрыгнул. */
export async function assertNoJump(page, opts, action) {
  const m = await measure(page, opts, action);
  const where = opts.label ? `«${opts.label}»` : (m.sel || opts.scroller);
  if (m.error) throw new Error(`${where}: ${m.error}`);
  if (!m.scrollable) throw new Error(`${where}: нечего прокручивать (высота ${m.heightBefore}, окно ниже) — проверка ничего не доказывает; уменьшите окно или добавьте содержимое`);
  const bad = [];
  if (m.recreated) bad.push('прокручиваемый узел пересоздан');
  if (m.jumped) bad.push(`прокрутка ушла: было ${m.before}, стало ${m.after} (отклонение ${m.deviation})`);
  if (m.focusLost) bad.push('потерян фокус поля');
  if (bad.length) throw new Error(`${where}: ${bad.join('; ')}`);
  return m;
}
