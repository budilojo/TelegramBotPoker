/** Toasts, bottom sheets and confirm dialogs — the shared overlay layer. */
import { h, icon, tick } from '../util.js';

const host = () => document.getElementById('toasts');

let lastToast = { text: '', at: 0 };

export function toast(text, kind = 'info', ms = 2600) {
  // Collapse duplicate messages (a rejected double-tap fires twice).
  const now = Date.now();
  if (text === lastToast.text && now - lastToast.at < 1200) return;
  lastToast = { text, at: now };

  const name = kind === 'ok' ? 'check' : kind === 'err' ? 'warn' : 'info';
  const el = h('div.toast', { class: kind, role: 'status' }, icon(name), h('span', { text }));
  host().append(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  }, ms);
}

/* ------------------------------------------------------------------ sheet */

let openLayer = null;

/**
 * Bottom sheet. `build(close)` returns the sheet's children.
 * Tapping the scrim or pressing Escape closes it.
 */
export function sheet(build, opts = {}) {
  closeOverlay();
  const scrim = h('div.scrim');
  const panel = h('div.sheet', { role: 'dialog', 'aria-modal': 'true' });
  const close = () => closeOverlay();

  panel.append(h('div.grabber'));
  const kids = build(close);
  panel.append(...(Array.isArray(kids) ? kids : [kids]));

  scrim.append(panel);
  scrim.addEventListener('pointerdown', (e) => {
    if (e.target === scrim && opts.dismissible !== false) close();
  });
  document.body.append(scrim);
  openLayer = { el: scrim, onClose: opts.onClose };
  return { close, panel };
}

/** Centered modal dialog, for confirmations. */
export function dialog(build, opts = {}) {
  closeOverlay();
  const scrim = h('div.scrim.center');
  const panel = h('div.dialog', { role: 'alertdialog', 'aria-modal': 'true' });
  const close = () => closeOverlay();
  const kids = build(close);
  panel.append(...(Array.isArray(kids) ? kids : [kids]));
  scrim.append(panel);
  scrim.addEventListener('pointerdown', (e) => {
    if (e.target === scrim && opts.dismissible !== false) close();
  });
  document.body.append(scrim);
  openLayer = { el: scrim, onClose: opts.onClose };
  return { close, panel };
}

export function closeOverlay() {
  if (!openLayer) return;
  const { el, onClose } = openLayer;
  openLayer = null;
  el.remove();
  onClose?.();
}

export const overlayOpen = () => !!openLayer;

/**
 * Destructive actions always route through here — a mis-tap on a phone must
 * never cost somebody their stack.
 */
export function confirm({ title, body, ok = 'Подтвердить', danger = false, onOk }) {
  return dialog((close) => [
    h('h2.sheet-title', { text: title }),
    body ? h('p.hint', { style: { marginTop: '8px' }, text: body }) : null,
    h(
      'div.stack-v',
      { style: { marginTop: '22px' } },
      h('button.btn', {
        class: danger ? 'btn-danger' : 'btn-primary',
        text: ok,
        onclick: () => {
          tick(12);
          close();
          onOk?.();
        },
      }),
      h('button.btn.btn-ghost', { text: 'Отмена', onclick: close })
    ),
  ]);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOverlay();
});
