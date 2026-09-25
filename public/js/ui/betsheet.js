/**
 * Bet / raise sizing. Optimised for "pick a number in two seconds with one
 * thumb": quick fractions first, a fat slider second, manual entry last.
 *
 * Every value here is a TOTAL street bet (what the player's bet becomes),
 * which is exactly what the server validates against.
 */
import { h, fmt, clamp, tick } from '../util.js';
import { sheet } from './overlay.js';

/** Pot-sized raise: call first, then bet `f` of the resulting pot. */
export function potRaise(legal, f) {
  const P = legal.potTotal;
  const C = legal.toCall;
  return Math.round(legal.myBet + C + (P + C) * f);
}

export function openBetSheet(app) {
  const s = app.state;
  const legal = s.legal;
  if (!legal || !(legal.canBet || legal.canRaise)) return;

  const bb = s.settings.bigBlind;
  const min = legal.minTotal;
  const max = legal.maxTotal;
  const isRaise = !legal.canBet;
  const step = Math.max(1, Math.round(bb / 2));

  const quantize = (v) => {
    const c = clamp(Math.round(v), min, max);
    if (c >= max - step / 2) return max;
    if (c <= min) return min;
    const snapped = Math.round(c / step) * step;
    return clamp(snapped, min, max);
  };

  let value = quantize(Math.min(max, Math.max(min, potRaise(legal, 0.5))));

  const amountEl = h('div.bet-amount.num');
  const metaEl = h('div.bet-meta');
  const slider = h('input.slider', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: '1',
    value: String(value),
    'aria-label': 'Размер ставки',
    oninput: (e) => setValue(Number(e.target.value), false),
  });
  const manual = h('input.input.input-num', {
    type: 'text',
    inputmode: 'numeric',
    'aria-label': 'Сумма вручную',
    oninput: (e) => {
      const v = e.target.value.replace(/\D/g, '');
      e.target.value = v;
      if (v) setValue(Number(v), false, true);
    },
    onblur: () => setValue(value, true),
  });
  const confirmBtn = h('button.btn.btn-primary.btn-lg');

  function setValue(v, snap = true, fromManual = false) {
    value = snap ? quantize(v) : clamp(Math.round(v), min, max);
    slider.value = String(value);
    slider.style.setProperty(
      '--pct',
      `${max === min ? 100 : ((value - min) / (max - min)) * 100}%`
    );
    amountEl.textContent = fmt(value);
    amountEl.classList.toggle('max', value >= max);
    if (!fromManual) manual.value = String(value);

    const adds = value - legal.myBet;
    const left = legal.stack - adds;
    metaEl.textContent =
      value >= max
        ? `Весь стек — ${fmt(legal.stack)} фишек в банк`
        : `Добавите ${fmt(adds)} · останется ${fmt(left)}`;

    const word = value >= max ? 'ALL-IN' : isRaise ? 'RAISE' : 'BET';
    confirmBtn.textContent = value >= max ? `ALL-IN ${fmt(value)}` : `${word} ${fmt(value)}`;
    quickButtons.forEach((b) => b.sync?.(value));
  }

  const fractions = [
    ['+BB', () => value + bb],
    ['+5BB', () => value + bb * 5],
    ['½ POT', () => potRaise(legal, 0.5)],
    ['¾ POT', () => potRaise(legal, 0.75)],
    ['POT', () => potRaise(legal, 1)],
    ['ALL-IN', () => max],
  ];

  const quickButtons = fractions.map(([label, calc]) => {
    const btn = h('button.quick', {
      type: 'button',
      class: label === 'ALL-IN' ? 'gold' : '',
      text: label,
      onclick: () => {
        tick();
        setValue(calc());
      },
    });
    btn.sync = () => {
      const target = clamp(calc(), min, max);
      // Hide options that cannot change anything (e.g. ½ POT below the min).
      btn.disabled = label.includes('POT') && (calc() < min || calc() > max);
      if (label === 'ALL-IN') btn.disabled = false;
      if (label.startsWith('+')) btn.disabled = value >= max;
      void target;
    };
    return btn;
  });

  const close = sheet((close) => [
    h('div.sheet-title', { text: isRaise ? 'Рейз' : 'Ставка' }),
    h('div.sheet-sub', {
      text: `Минимум ${fmt(min)} · максимум ${fmt(max)}`,
    }),
    amountEl,
    metaEl,
    h('div.slider-wrap', slider),
    h('div.quick-grid', { style: { gridTemplateColumns: 'repeat(3,1fr)' } }, quickButtons),
    h(
      'div.bet-manual',
      h('button.stepper', {
        type: 'button',
        'aria-label': 'Меньше',
        text: '−',
        onclick: () => {
          tick();
          setValue(value - step);
        },
      }),
      h('div.grow', manual),
      h('button.stepper', {
        type: 'button',
        'aria-label': 'Больше',
        text: '+',
        onclick: () => {
          tick();
          setValue(value + step);
        },
      })
    ),
    confirmBtn,
    h('button.btn.btn-ghost', {
      style: { marginTop: '8px' },
      text: 'Отмена',
      onclick: close,
    }),
  ]).close;

  confirmBtn.addEventListener('click', () => {
    const action = value >= max ? 'allin' : isRaise ? 'raise' : 'bet';
    close();
    app.act({ t: 'action', action, amount: value });
  });

  setValue(value);
}
