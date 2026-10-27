/**
 * Строка «Добавить на рабочий стол» в «Настройках». Логика состояний — в homescreen.js. Автоматических предложений нет.
 * Намеренно без импорта ui.js: реестр строк загружается и в Node (тесты), где нет `window`.
 */
import { createHomescreen, rowText } from './homescreen.js';

let ctl = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export default function homescreenRow(/* state */) {
  if (typeof document === 'undefined') return null;
  const tg = globalThis.Telegram?.WebApp || null;
  ctl?.dispose();
  ctl = createHomescreen(tg);
  const mine = ctl;
  const host = el('div', 'set-row col hs-row');
  host.dataset.hs = 'checking';
  const draw = ({ state, reason }) => {
    const t = rowText({ state, reason });
    host.dataset.hs = state;
    const sub = el('div', 'set-sub', t.sub);
    sub.setAttribute('aria-live', 'polite');
    const body = el('div', 'set-body');
    body.append(el('div', 'set-title', 'Добавить на рабочий стол'), sub);
    host.replaceChildren(body);
    if (t.btn) {
      const b = el('button', 'btn sm', t.btn);
      b.onclick = () => {
        try { tg?.HapticFeedback?.impactOccurred?.('medium'); } catch { /* не важно */ }
        state === 'failed' ? mine.retry() : mine.add();
      };
      host.append(b);
    }
  };
  mine.subscribe(draw);
  draw(mine.get());
  mine.start();
  return host;
}
