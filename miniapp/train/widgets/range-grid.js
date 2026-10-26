/**
 * Виджет «Матрица 13×13» — ввод и показ диапазона рук. Агент W, волна 3.
 *
 * Контракт Тренировки (docs/poker-training.md §3):
 *   mount({ setup, value, disabled, onChange, result }) → Element
 *   update(el, props)
 * `value` — ответ: массив кодов ['AA','AKs'] (steps 2) или объект
 * { AA: 1, AKs: 0.5 } (steps 3). `setup.grid`:
 *   mode    'edit' | 'readonly' | 'diff' | 'heat' | 'flag'   (по умолчанию edit)
 *   steps   2 | 3   — две или три степени (иногда = 0,5)
 *   ref     показать эталон/диапазон (readonly, heat) — массив или объект
 *   presets ['pairs','suited','aces','top:10']  (по умолчанию — они)
 *   text    true — поле «77+, ATs+, KQo»
 *   hint    строка-подсказка под матрицей
 * В режиме diff (есть `result`) верный ответ — `result.solution`, ответ игрока — `value`.
 * В режиме flag игрок отмечает «неверные» клетки готового диапазона `setup.grid.ref`;
 * в разборе `result.solution` — массив неверных клеток.
 *
 * Рендер: DOM матрицы строится ОДИН раз; нажатие меняет только изменившиеся
 * клетки (иначе экран «подпрыгивает»). Ничего не грузит извне.
 */
import { ALL_HANDS, handInfo, handAt, RANK_CHARS, combosOf, diff, freqOf, tryParseRange } from '../ranges/hands.js';
import { createEditor, rowCodes, colCodes, PRESETS } from '../ranges/grid.js';

const CSS_HREF = '/ranges.css';
function ensureCss() {
  if (typeof document === 'undefined') return;
  if ([...document.querySelectorAll('link[rel=stylesheet]')].some((l) => (l.getAttribute('href') || '').includes('ranges.css'))) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = CSS_HREF;
  document.head.appendChild(l);
}

const TAP_SLOP = 8; // пикселей: дальше — это уже не тап
const ZOOM_CELL = 44;
const DEFAULT_PRESETS = ['pairs', 'suited', 'aces', 'top:10'];
const PRESET_TITLE = (id) => (PRESETS[id] ? PRESETS[id].title : /^top:/.test(id) ? `Топ ${id.slice(4)} %` : id);

const fmtPercent = (p) => String(p).replace('.', ',');
const toMap = (v) => {
  if (!v) return new Map();
  if (v instanceof Map) return v;
  if (Array.isArray(v)) return new Map(v.map((c) => [c, 1]));
  return new Map(Object.entries(v).filter(([, f]) => f > 0));
};

function el(tag, cls, attrs) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export function mount(props) {
  ensureCss();
  const st = { props, mode: 'edit', marks: new Set(), steps: 2, zoom: false, draw: false, focus: 'AA', ed: null, cells: new Map(), board: null, loupe: null, lp: [] };
  const root = el('div', 'rg');
  root._rg = st;

  const top = el('div', 'rg-top');
  const count = el('div', 'rg-count', { 'aria-live': 'polite' });
  const tools = el('div', 'rg-tools');
  const btn = (label, aria) => { const b = el('button', 'k-btn k-btn--ghost k-btn--compact', { type: 'button', 'aria-label': aria || label }); b.textContent = label; return b; };
  const bUndo = btn('Отмена', 'Отменить');
  const bRedo = btn('Повтор', 'Повторить');
  const bZoom = btn('Крупно', 'Увеличить матрицу');
  const bDraw = btn('Рисовать', 'Режим рисования протяжкой');
  bZoom.setAttribute('aria-pressed', 'false');
  bDraw.setAttribute('aria-pressed', 'false');
  tools.append(bUndo, bRedo, bZoom, bDraw);
  top.append(count);

  const presets = el('div', 'rg-presets');
  const textRow = el('div', 'rg-text');
  const textIn = el('input', 'k-input', { type: 'text', inputmode: 'text', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', placeholder: '77+, ATs+, KQo', 'aria-label': 'Диапазон строкой' });
  const bApply = btn('Применить', 'Применить строку к матрице');
  textRow.append(textIn, bApply);
  const err = el('div', 'rg-err', { role: 'alert' });

  const wrap = el('div', 'rg-wrap');
  const board = el('div', 'rg-board', { role: 'grid', 'aria-label': 'Матрица стартовых рук 13 на 13', tabindex: '0' });
  st.board = board;
  wrap.appendChild(board);
  const loupe = el('div', 'rg-loupe', { 'aria-hidden': 'true' });
  loupe.hidden = true;
  for (let i = 0; i < 9; i++) { const c = el('div', 'rg-lp' + (i === 4 ? ' mid' : '')); c.appendChild(document.createElement('span')); loupe.appendChild(c); st.lp.push(c); }
  st.loupe = loupe;
  const legend = el('div', 'rg-legend');
  const hint = el('div', 'rg-hint');

  // шапка столбцов, затем ряды
  board.appendChild(el('div', 'rg-h rg-corner', { role: 'presentation' }));
  for (let c = 0; c < 13; c++) { const h = el('div', 'rg-h', { 'data-col': String(c) }); h.textContent = RANK_CHARS[c]; board.appendChild(h); }
  for (let r = 0; r < 13; r++) {
    const h = el('div', 'rg-h', { 'data-row': String(r) });
    h.textContent = RANK_CHARS[r];
    board.appendChild(h);
    for (let c = 0; c < 13; c++) {
      const code = handAt(r, c);
      const i = handInfo(code);
      const cell = el('div', 'rg-c ' + i.kind, { role: 'gridcell', 'data-h': code, tabindex: '-1' });
      const s = el('span');
      s.textContent = code.slice(0, 2);
      cell.appendChild(s);
      if (i.kind !== 'pair') { const x = el('span', 'rg-sfx'); x.textContent = code[2]; cell.appendChild(x); }
      board.appendChild(cell);
      st.cells.set(code, cell);
    }
  }

  // матрица сразу под счётчиком: на 568 px она должна быть на виду, кнопки — под ней
  root.append(top, wrap, loupe, legend, tools, presets, textRow, err, hint);

  /* ---------------------------------------------------------- отрисовка */

  const label = (code, f, extra) => `${code}, ${combosOf(code)} комбо${f ? `, ${f === 1 ? 'выбрано' : 'иногда'}` : ''}${extra ? `, ${extra}` : ''}`;

  function paintCell(code, state) {
    const cell = st.cells.get(code);
    const f = state.f || 0;
    cell.style.setProperty('--f', String(f));
    const cls = ['rg-c', handInfo(code).kind];
    if (f > 0 && !state.cls) cls.push('f', f === 1 ? 'f1' : 'fh');
    if (state.cls) cls.push(...state.cls.split(' '));
    if (st.focus === code) cls.push('focus-ring');
    cell.className = cls.filter((c) => c !== 'focus-ring').join(' ');
    cell.setAttribute('aria-label', label(code, f, state.say));
    cell.setAttribute('aria-selected', f > 0 ? 'true' : 'false');
  }

  /** Состояние клетки в текущем режиме. */
  function stateOf(code) {
    const { mode } = st;
    if (mode === 'diff' && st.diffInfo) {
      const d = st.diffInfo;
      const u = freqOf(st.userMap, code);
      const r = freqOf(st.refMap, code);
      if (d.missedSet.has(code)) return { f: 0, cls: 'missed', say: 'пропущена' };
      if (d.extraSet.has(code)) return { f: u, cls: 'extra', say: 'лишняя' };
      if (d.offSet.has(code)) return { f: u, cls: 'off f', say: 'частота отличается' };
      if (u > 0 && r > 0) return { f: u, cls: 'hit f f1', say: 'верно' };
      return { f: 0 };
    }
    if (mode === 'flag') {
      const ref = freqOf(st.refMap, code);
      const flagged = st.ed.get(code) > 0;
      if (st.flagResult) {
        const wrong = st.flagResult.wrong.has(code);
        if (wrong && flagged) return { f: 1, cls: 'hit f f1', say: 'ошибка найдена' };
        if (wrong) return { f: ref, cls: 'missed', say: 'ошибку не нашли' };
        if (flagged) return { f: ref, cls: 'extra', say: 'отмечено зря' };
        return { f: ref, cls: ref ? 'f' : '' };
      }
      return { f: ref, cls: ref ? (flagged ? 'off f' : 'f f1') : (flagged ? 'off' : ''), say: flagged ? 'отмечена как ошибка' : '' };
    }
    if (mode === 'readonly' || mode === 'heat') {
      const f = freqOf(st.refMap, code);
      // Обведённая рука задания: рамка, а не цвет (видно и тем, кто не различает зелёное и красное)
      return st.marks.has(code) ? { f, cls: f > 0 ? 'f f1 mk' : 'mk', say: 'рука из задания' } : { f };
    }
    return { f: st.ed.get(code) };
  }

  function paintAll() { for (const c of ALL_HANDS) paintCell(c, stateOf(c)); }
  function paintSome(codes) { for (const c of codes) paintCell(c, stateOf(c)); }

  function refreshCount() {
    let combos;
    let pct;
    const map = st.mode === 'edit' || st.mode === 'flag' ? (st.mode === 'flag' ? st.refMap : st.ed.snapshot()) : st.refMap;
    combos = 0;
    for (const [c, f] of map) combos += combosOf(c) * f;
    pct = Math.round((combos / 1326) * 1000) / 10;
    const n = Math.round(combos * 10) / 10;
    let txt = `${fmtPercent(pct)} % · ${String(n).replace('.', ',')} комбо`;
    if (st.mode === 'flag') txt = `Отмечено клеток: ${st.ed.size()}`;
    count.textContent = txt;
    bUndo.disabled = !st.ed.canUndo();
    bRedo.disabled = !st.ed.canRedo();
    bUndo.setAttribute('aria-disabled', String(bUndo.disabled));
    bRedo.setAttribute('aria-disabled', String(bRedo.disabled));
  }

  function emitAnswer() {
    if (st.emitQueued) return;
    st.emitQueued = true;
    queueMicrotask(() => {
      st.emitQueued = false;
      refreshCount();
      if (!st.silent) st.props.onChange?.(st.ed.answer());
    });
  }

  /* ---------------------------------------------------- режимы и данные */

  function configure(p, first) {
    st.props = p;
    const g = p.setup?.grid || {};
    const result = p.result || null;
    let mode = g.mode || 'edit';
    st.steps = g.steps === 3 ? 3 : 2;
    st.refMap = toMap(result && g.mode !== 'flag' && g.mode !== 'readonly' ? result.solution : g.ref);
    st.marks = new Set(Array.isArray(g.mark) ? g.mark : []);
    if (result && (mode === 'edit' || mode === 'diff' || mode === 'flag')) {
      if (mode === 'flag') {
        const wrong = new Set(Array.isArray(result.solution) ? result.solution : []);
        const marked = new Set(Array.isArray(p.value) ? p.value : []);
        st.flagResult = { wrong, marked };
        st.refMap = toMap(g.ref);
      } else {
        mode = 'diff';
      }
    } else {
      st.flagResult = null;
    }
    st.mode = mode;
    const disabled = !!p.disabled || !!result || mode === 'readonly' || mode === 'heat' || mode === 'diff';
    st.disabled = disabled;
    root.classList.toggle('ro', disabled);
    // редактор: пересоздаём, только если изменился steps
    if (!st.ed || st.ed.steps !== st.steps) {
      st.unsub?.();
      st.ed = createEditor({ steps: st.steps });
      st.unsub = st.ed.subscribe((codes) => { paintSome(codes); emitAnswer(); });
    }
    const wantUser = toMap(p.value);
    if (mode !== 'diff') {
      // внешнее значение (после перерисовки экрана) вернуть в редактор, не стирая историю лишний раз
      const cur = st.ed.snapshot();
      let same = cur.size === wantUser.size;
      if (same) for (const [k, v] of wantUser) if (cur.get(k) !== v) { same = false; break; }
      if (!same) { st.silent = true; st.ed.load(wantUser); queueMicrotask(() => { st.silent = false; }); }
    }
    st.userMap = wantUser;
    if (mode === 'diff') {
      const d = diff(st.userMap, st.refMap);
      st.diffInfo = { ...d, missedSet: new Set(d.missed), extraSet: new Set(d.extra), offSet: new Set(d.off.map((o) => o.hand)) };
    } else st.diffInfo = null;

    // подсказки/наборы/строка/легенда
    presets.replaceChildren();
    textRow.hidden = err.hidden = !(g.text && mode === 'edit' && !disabled);
    err.textContent = '';
    const editing = (mode === 'edit' || mode === 'flag') && !disabled;
    const showTools = mode === 'edit' && !disabled;
    bUndo.hidden = bRedo.hidden = !editing;
    bDraw.hidden = !showTools;
    bZoom.hidden = false;
    presets.hidden = !showTools;
    if (showTools) {
      for (const id of g.presets || DEFAULT_PRESETS) {
        const b = btn(PRESET_TITLE(id), `Добавить: ${PRESET_TITLE(id)}`);
        b.dataset.preset = id;
        presets.appendChild(b);
      }
      const clr = btn('Очистить', 'Очистить матрицу');
      clr.dataset.preset = 'clear';
      presets.appendChild(clr);
    }
    legend.replaceChildren();
    const L = (cls, t) => { const s = el('span'); const i = el('i', cls); s.append(i, document.createTextNode(t)); legend.appendChild(s); };
    if (mode === 'diff') { L('hit', 'верно'); L('missed', 'пропущено'); L('extra', 'лишнее'); if (st.diffInfo.off.length) L('off', 'частота другая'); }
    else if (mode === 'flag' && st.flagResult) { L('hit', 'ошибка найдена'); L('missed', 'ошибку не нашли'); L('extra', 'отмечено зря'); }
    else if (mode === 'heat') { L('hit', 'всегда'); L('off', 'иногда (высота заливки = частота)'); }
    legend.hidden = !legend.childNodes.length;
    hint.textContent = g.hint || (mode === 'edit' && !disabled ? 'Нажимайте клетки. «Рисовать» — протяжка пальцем. Нажатие по букве — весь ряд или столбец.' : '');
    hint.hidden = !hint.textContent;
    root.classList.toggle('draw', st.draw && !disabled);
    paintAll();
    refreshCount();
    if (first) fitCell();
  }

  /* ------------------------------------------------------------ размеры */

  function fitCell() {
    const w = Math.floor(root.clientWidth || (typeof window !== 'undefined' ? window.innerWidth - 32 : 288));
    const cell = st.zoom ? ZOOM_CELL : Math.max(18, Math.floor(w / 14));
    root.style.setProperty('--rg-cell', `${cell}px`);
  }
  if (typeof ResizeObserver !== 'undefined') {
    st.ro = new ResizeObserver(() => { if (!st.zoom) fitCell(); });
    queueMicrotask(() => { if (root.isConnected) st.ro.observe(root); });
  }
  bZoom.addEventListener('click', () => {
    st.zoom = !st.zoom;
    wrap.classList.toggle('zoom', st.zoom);
    bZoom.setAttribute('aria-pressed', String(st.zoom));
    bZoom.textContent = st.zoom ? 'Обычно' : 'Крупно';
    fitCell();
  });
  bDraw.addEventListener('click', () => {
    st.draw = !st.draw;
    bDraw.setAttribute('aria-pressed', String(st.draw));
    root.classList.toggle('draw', st.draw);
    wrap.classList.toggle('draw', st.draw);
  });

  /* ------------------------------------------------------------- ввод */

  const cellAt = (e) => {
    const r = board.getBoundingClientRect();
    const size = r.width / 14;
    const col = Math.floor((e.clientX - r.left) / size) - 1;
    const row = Math.floor((e.clientY - r.top) / size) - 1;
    if (col < 0 || row < 0 || col > 12 || row > 12) return null;
    return handAt(row, col);
  };

  function flagTap(code) {
    // режим flag: отметка — переключатель, «иногда» не нужно
    st.ed.tap(code);
  }

  let down = null;
  function showLoupe(e, code) {
    const info = handInfo(code);
    const rr = root.getBoundingClientRect();
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const cell = st.lp[(dr + 1) * 3 + dc + 1];
      const r2 = info.row + dr;
      const c2 = info.col + dc;
      if (r2 < 0 || c2 < 0 || r2 > 12 || c2 > 12) { cell.style.visibility = 'hidden'; continue; }
      cell.style.visibility = '';
      const cc = handAt(r2, c2);
      const f = st.ed.get(cc);
      cell.firstChild.textContent = cc;
      cell.style.setProperty('--f', String(f));
      cell.classList.toggle('f', f > 0);
    }
    loupe.hidden = false;
    const w = 144;
    let x = e.clientX - rr.left - w / 2;
    x = Math.max(0, Math.min(rr.width - w, x));
    let y = e.clientY - rr.top - 144 - 36;
    if (y < 0) y = e.clientY - rr.top + 56;
    loupe.style.left = `${x}px`;
    loupe.style.top = `${y}px`;
  }

  board.addEventListener('pointerdown', (e) => {
    if (st.disabled) return;
    if (e.target.closest('[data-row],[data-col]')) return; // шапка — по click
    const code = cellAt(e);
    if (!code) return;
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    const paint = !touch || st.draw;
    down = { id: e.pointerId, code, x: e.clientX, y: e.clientY, paint, touch, moved: false, stroking: false, last: code };
    if (paint && (st.mode === 'edit')) { try { board.setPointerCapture(e.pointerId); } catch {} }
    if (touch && st.draw && st.mode === 'edit') showLoupe(e, code);
    st.focus = code;
  });
  board.addEventListener('pointermove', (e) => {
    if (!down || e.pointerId !== down.id) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_SLOP) down.moved = true;
    if (!down.paint || st.mode !== 'edit') return;
    const code = cellAt(e);
    if (!code) return;
    if (!down.stroking && code !== down.code) { st.ed.strokeStart(down.code); down.stroking = true; }
    if (down.stroking && code !== down.last) { st.ed.strokeMove(code); down.last = code; }
    if (down.touch) showLoupe(e, code);
  });
  const finish = (e, cancel) => {
    if (!down || e.pointerId !== down.id) return;
    const d = down;
    down = null;
    loupe.hidden = true;
    try { board.releasePointerCapture(e.pointerId); } catch {}
    if (cancel) { if (d.stroking) { st.ed.strokeEnd(); st.ed.undo(); } return; }
    if (d.stroking) { st.ed.strokeEnd(); return; }
    if (d.moved && !d.paint) return; // это была прокрутка, а не нажатие
    if (st.mode === 'flag') flagTap(d.code);
    else st.ed.tap(d.code);
  };
  board.addEventListener('pointerup', (e) => finish(e, false));
  board.addEventListener('pointercancel', (e) => finish(e, true));
  board.addEventListener('lostpointercapture', () => { loupe.hidden = true; });

  // шапка: ряд / столбец целиком
  board.addEventListener('click', (e) => {
    if (st.disabled || st.mode !== 'edit') return;
    const h = e.target.closest('[data-row],[data-col]');
    if (!h) return;
    if (h.dataset.row != null) st.ed.toggleLine(rowCodes(Number(h.dataset.row)));
    else st.ed.toggleLine(colCodes(Number(h.dataset.col)));
  });
  for (const h of board.querySelectorAll('[data-row],[data-col]')) h.classList.add('line');

  // клавиатура: стрелки — по клеткам, пробел/Enter — выбрать
  board.addEventListener('keydown', (e) => {
    const info = handInfo(st.focus) || handInfo('AA');
    let { row, col } = info;
    if (e.key === 'ArrowRight') col = Math.min(12, col + 1);
    else if (e.key === 'ArrowLeft') col = Math.max(0, col - 1);
    else if (e.key === 'ArrowDown') row = Math.min(12, row + 1);
    else if (e.key === 'ArrowUp') row = Math.max(0, row - 1);
    else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!st.disabled) { if (st.mode === 'flag') flagTap(st.focus); else if (st.mode === 'edit') st.ed.tap(st.focus); }
      return;
    } else return;
    e.preventDefault();
    st.focus = handAt(row, col);
    st.cells.get(st.focus).focus();
  });
  board.addEventListener('focus', (e) => { if (e.target === board) st.cells.get(st.focus).focus(); });

  // кнопки
  bUndo.addEventListener('click', () => st.ed.undo());
  bRedo.addEventListener('click', () => st.ed.redo());
  presets.addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b || st.disabled) return;
    if (b.dataset.preset === 'clear') st.ed.clear();
    else st.ed.applyPreset(b.dataset.preset);
  });
  bApply.addEventListener('click', () => {
    const r = tryParseRange(textIn.value);
    if (!r.ok) { err.textContent = r.error; textIn.setAttribute('aria-invalid', 'true'); return; }
    err.textContent = '';
    textIn.removeAttribute('aria-invalid');
    st.ed.load(r.set);
  });
  st.reconfigure = (p) => configure(p, false);
  configure(props, true);
  return root;
}

/** Применить новые props (новое значение, результат, disabled) без пересборки DOM. */
export function update(root, props) {
  const st = root._rg;
  if (!st) return;
  st.props = props;
  // повторная настройка пересоздаёт только то, что изменилось (клетки не создаются заново)
  st.reconfigure?.(props);
}
