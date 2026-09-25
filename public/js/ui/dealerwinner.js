/**
 * "Кто забрал банк?" — the dealer's one critical screen.
 *
 * Design rules it follows, in order of importance:
 *   1. A single pot takes exactly two taps: pick a player, confirm.
 *   2. Nothing moves chips until the dealer confirms an explicit summary.
 *   3. Folded players and players not entitled to a side pot are never shown.
 *   4. The split maths shown here comes from the server, so the preview is
 *      literally the payout that will be applied.
 */
import { h, icon, fmt, mount as fill, tick } from '../util.js';
import { net } from '../net.js';
import { toast } from './overlay.js';

let current = null;

export const dealerWinnerOpen = () => !!current;

export function closeDealerWinner() {
  if (!current) return;
  current.el.remove();
  current = null;
}

export function openDealerWinner(app) {
  if (current) return render(app);

  const el = h('div.dw', { role: 'dialog', 'aria-modal': 'true' });
  document.body.append(el);
  current = { el, step: 0, split: new Set(), sig: null, review: false };
  render(app);
}

/** Pots with a single eligible player are uncalled bets coming back — the
 *  server already assigned them, so the dealer is never asked about them. */
const decidable = (pots) => pots.filter((p) => p.eligible.length > 1);

function render(app) {
  const s = app.state;
  const hand = s.hand;
  if (!hand || hand.phase !== 'showdown') return closeDealerWinner();

  const pots = hand.pots;
  const steps = decidable(pots);

  // Nothing to decide (everyone folded out) — the server settles it itself.
  if (steps.length === 0) return closeDealerWinner();

  if (current.step >= steps.length) current.review = true;
  const idx = Math.min(current.step, steps.length - 1);
  const pot = steps[idx];
  const potIndex = pots.indexOf(pot);
  const splitOn = current.split.has(potIndex);

  const sig = JSON.stringify([
    current.review,
    idx,
    splitOn,
    pots.map((p) => [p.amount, p.eligible, p.winners]),
    hand.preview,
    !!app.ui.pending,
  ]);
  if (current.sig === sig) return;
  current.sig = sig;

  fill(current.el, current.review ? reviewScreen(app, steps) : pickScreen(app, pot, potIndex, idx, steps, splitOn));
}

/* ------------------------------------------------------------ pick a pot */

function pickScreen(app, pot, potIndex, idx, steps, splitOn) {
  const s = app.state;
  const multi = steps.length > 1;
  const last = idx === steps.length - 1;
  const chosen = pot.winners || [];

  const potName = multi ? (potIndex === 0 ? 'Main pot' : `Side pot ${potIndex}`) : 'Pot';

  const head = h(
    'div.dw-head',
    h('div.step', { text: multi ? `Банк ${idx + 1} из ${steps.length}` : 'Раздача завершена' }),
    h('h2', { text: 'Кто забрал банк?' }),
    h('div.dw-pot-label', { style: { marginTop: '12px' }, text: potName }),
    h('div.dw-pot.num', { text: fmt(pot.amount) })
  );

  const body = h('div.dw-body');
  for (const id of pot.eligible) {
    const p = s.players.find((x) => x.id === id);
    if (!p) continue;
    const picked = chosen.includes(id);
    const share = picked ? shareOf(pot, id, chosen) : 0;
    body.append(
      h(
        'button.dw-pick',
        {
          type: 'button',
          'aria-pressed': String(picked),
          onclick: () => toggle(app, potIndex, id, splitOn),
        },
        h('span.mark', icon('check')),
        h(
          'span.grow',
          h('span.nm', { text: p.name }),
          h('span.sub.num', { text: `${fmt(p.stack)} фишек` })
        ),
        picked ? h('span.gain.num', { text: `+${fmt(share)}` }) : null
      )
    );
  }

  const foot = h('div.dw-foot');

  foot.append(
    h(
      'button.split-toggle',
      {
        type: 'button',
        'aria-pressed': String(splitOn),
        onclick: () => {
          tick();
          if (splitOn) {
            current.split.delete(potIndex);
            // Collapse back to a single winner so nothing ambiguous is left.
            if (chosen.length > 1) send(app, potIndex, [chosen[0]]);
          } else {
            current.split.add(potIndex);
          }
          current.sig = null;
          render(app);
        },
      },
      icon('split'),
      splitOn ? 'Один победитель' : 'Разделить банк'
    )
  );

  if (chosen.length === 1 && !splitOn) {
    const p = s.players.find((x) => x.id === chosen[0]);
    foot.append(
      h(
        'div.dw-selected',
        h('div.nm', { text: p?.name ?? '' }),
        h('div.gets', { text: `Получит +${fmt(pot.amount)}` })
      )
    );
  } else if (chosen.length > 1) {
    foot.append(
      h('div.dw-selected', h('div.gets', { text: `Банк делится на ${chosen.length}` }))
    );
  }

  const primary = h('button.btn.btn-primary.btn-lg', {
    disabled: chosen.length === 0 || !!app.ui.pending,
    text: !last ? 'Далее' : multi ? 'К распределению' : 'Подтвердить победителя',
    onclick: () => {
      tick(12);
      if (!last || multi) {
        current.step = idx + 1;
        current.review = idx + 1 >= steps.length;
        current.sig = null;
        render(app);
      } else {
        commit(app);
      }
    },
  });
  foot.append(primary);

  foot.append(
    h('button.btn.btn-ghost', {
      text: idx > 0 ? 'Назад' : 'Закрыть',
      onclick: () => {
        if (idx > 0) {
          current.step = idx - 1;
          current.sig = null;
          render(app);
        } else {
          closeDealerWinner();
        }
      },
    })
  );

  return [head, body, foot];
}

/* ------------------------------------------------------------- review    */

function reviewScreen(app, steps) {
  const s = app.state;
  const hand = s.hand;
  const preview = hand.preview || [];

  const head = h(
    'div.dw-head',
    h('div.step', { text: 'Проверьте перед подтверждением' }),
    h('h2', { text: 'Распределение' }),
    h('div.dw-pot-label', { style: { marginTop: '12px' }, text: 'Всего в банке' }),
    h('div.dw-pot.num', { text: fmt(hand.pots.reduce((a, p) => a + p.amount, 0)) })
  );

  const body = h('div.dw-body');

  // Per-pot breakdown, so an unusual side-pot split is explainable.
  hand.pots.forEach((pot, i) => {
    const name = hand.pots.length > 1 ? (i === 0 ? 'Main pot' : `Side pot ${i}`) : 'Pot';
    const solo = pot.eligible.length === 1;
    body.append(
      h(
        'div.pot-head',
        { style: { marginTop: i ? '16px' : '2px' } },
        h('span.nm', { text: solo ? `${name} · возврат` : name }),
        h('span.amt.num', { text: fmt(pot.amount) })
      )
    );
    const winners = pot.winners || [];
    for (const id of winners) {
      const p = s.players.find((x) => x.id === id);
      body.append(
        h(
          'div.dw-summary',
          h('div', h('div.nm', { text: p?.name ?? '?' })),
          h('div.amt', { text: `+${fmt(shareOf(pot, id, winners))}` })
        )
      );
    }
  });

  if (preview.length) {
    body.append(
      h('p.eyebrow', { style: { margin: '22px 0 6px' }, text: 'Итого на руки' }),
      ...preview.map((p) =>
        h(
          'div.dw-summary',
          h('div.nm', { text: p.name }),
          h('div.amt', { text: `+${fmt(p.amount)}` })
        )
      )
    );
  }

  const foot = h(
    'div.dw-foot',
    h('button.btn.btn-primary.btn-lg', {
      disabled: !!app.ui.pending,
      text: app.ui.pending ? 'Подтверждаем…' : 'Подтвердить результат',
      onclick: () => {
        tick(14);
        commit(app);
      },
    }),
    h('button.btn.btn-ghost', {
      text: 'Изменить',
      onclick: () => {
        current.review = false;
        current.step = Math.max(0, steps.length - 1);
        current.sig = null;
        render(app);
      },
    })
  );

  return [head, body, foot];
}

/* --------------------------------------------------------------- actions */

function shareOf(pot, id, winners) {
  if (!winners.length) return 0;
  const base = Math.floor(pot.amount / winners.length);
  const remainder = pot.amount - base * winners.length;
  // Mirrors the server's ordering closely enough for a per-row hint; the
  // authoritative per-player total is shown from `hand.preview`.
  return base + (winners.indexOf(id) < remainder ? 1 : 0);
}

function toggle(app, potIndex, playerId, splitOn) {
  const pot = app.state.hand.pots[potIndex];
  const chosen = pot.winners || [];
  let next;
  if (splitOn) {
    next = chosen.includes(playerId)
      ? chosen.filter((x) => x !== playerId)
      : [...chosen, playerId];
  } else {
    next = chosen.length === 1 && chosen[0] === playerId ? [] : [playerId];
  }
  tick();
  pot.winners = next; // optimistic paint, the server echoes it right back
  current.sig = null;
  render(app);
  send(app, potIndex, next);
}

function send(app, potIndex, winners) {
  net.send({ t: 'selectWinners', potIndex, winners });
}

function commit(app) {
  const hand = app.state.hand;
  if (!hand || hand.pots.some((p) => (p.winners || []).length === 0)) {
    toast('Выберите победителя каждого банка', 'err');
    return;
  }
  if (app.ui.pending) return; // double-tap guard
  closeDealerWinner();
  app.act({ t: 'confirmWinners' });
}
