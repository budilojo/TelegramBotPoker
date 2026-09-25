/**
 * "Who won the hand?" — the one decision the app cannot make itself, because
 * the cards are on a real table.
 *
 * Selection is shared state: whoever is closest to the cards taps, everybody
 * else sees it live. Confirmation is a second, deliberate tap.
 */
import { h, icon, fmt, mount as fill, tick } from '../util.js';
import { net } from '../net.js';
import { sheet, closeOverlay, toast } from './overlay.js';

let current = null;

export const winnerSheetOpen = () => !!current;

/** Close only if the winner sheet is the overlay that is up. */
export function closeWinnerSheet() {
  if (current) current.close();
}

export function openWinnerSheet(app) {
  if (current) return refreshWinnerSheet(app);

  const body = h('div.sheet-body');
  const confirmBtn = h('button.btn.btn-primary.btn-lg', { style: { marginTop: '10px' } });
  const hintEl = h('p.hint', { style: { textAlign: 'center', margin: '10px 0 0' } });

  const { close } = sheet(
    () => [
      h('div.sheet-title', { text: 'Кто выиграл раздачу?' }),
      h('div.sheet-sub', {
        text: 'Отметьте победителя. При ничьей — нескольких, банк разделится.',
      }),
      body,
      confirmBtn,
      hintEl,
    ],
    {
      onClose: () => {
        current = null;
      },
    }
  );

  current = { close, body, confirmBtn, hintEl, sig: null };
  confirmBtn.addEventListener('click', () => {
    const s = app.state;
    if (!s.hand || s.hand.pots.some((p) => p.winners.length === 0)) {
      toast('Выберите победителя каждого банка', 'err');
      return;
    }
    tick(14);
    closeOverlay();
    app.act({ t: 'confirmWinners' });
  });

  render(app);
}

export function refreshWinnerSheet(app) {
  if (!current) return;
  render(app);
}

function render(app) {
  const s = app.state;
  const hand = s.hand;
  if (!hand || hand.phase !== 'showdown') {
    closeOverlay();
    return;
  }

  // Cheap guard against rebuilding the DOM on unrelated state pushes.
  const sig = JSON.stringify(hand.pots.map((p) => [p.amount, p.eligible, p.winners]));
  if (current.sig === sig) return;
  current.sig = sig;

  const multi = hand.pots.length > 1;
  fill(
    current.body,
    ...hand.pots.map((pot, i) => potBlock(app, pot, i, multi))
  );

  const ready = hand.pots.every((p) => p.winners.length > 0);
  current.confirmBtn.disabled = !ready;
  const total = hand.pots.reduce((sum, p) => sum + p.amount, 0);
  current.confirmBtn.textContent = ready
    ? `Забрать ${fmt(total)}`
    : 'Выберите победителя';
  current.hintEl.textContent = multi
    ? 'Сайд-поты разыгрываются отдельно — у каждого свой победитель.'
    : '';
}

function potBlock(app, pot, index, multi) {
  const s = app.state;
  const name = multi
    ? index === 0
      ? 'Основной банк'
      : `Сайд-пот ${index}`
    : 'Банк';

  // Only one player could win it — that is an uncalled bet coming back, not
  // a decision anybody has to make.
  if (pot.eligible.length === 1) {
    const only = s.players.find((x) => x.id === pot.eligible[0]);
    return h(
      'div.pot-block',
      h(
        'div.pot-head',
        h('span.nm', { text: 'Возврат ставки' }),
        h('span.amt.num', { text: fmt(pot.amount) })
      ),
      h(
        'div.pick',
        { style: { borderStyle: 'dashed', pointerEvents: 'none' } },
        h('span.grow', h('span.nm', { text: only?.name ?? '—' })),
        h('span.split-amt.num', { text: `+${fmt(pot.amount)}` })
      )
    );
  }

  const list = h('div.pick-list');
  for (const id of pot.eligible) {
    const p = s.players.find((x) => x.id === id);
    if (!p) continue;
    const picked = pot.winners.includes(id);
    const share = picked
      ? Math.floor(pot.amount / pot.winners.length) +
        (pot.winners.indexOf(id) < pot.amount % pot.winners.length ? 1 : 0)
      : 0;

    list.append(
      h(
        'button.pick',
        {
          type: 'button',
          'aria-pressed': String(picked),
          onclick: () => toggle(app, index, id),
        },
        h('span.tick', icon('check')),
        h(
          'span.grow',
          h('span.nm', { text: p.name }),
          h('span.st.num', { style: { display: 'block' }, text: `${fmt(p.stack)} фишек` })
        ),
        picked ? h('span.split-amt.num', { text: `+${fmt(share)}` }) : null
      )
    );
  }

  return h(
    'div.pot-block',
    h(
      'div.pot-head',
      h('span.nm', { text: name }),
      h('span.amt.num', { text: fmt(pot.amount) })
    ),
    list
  );
}

function toggle(app, potIndex, playerId) {
  const pot = app.state.hand.pots[potIndex];
  const winners = pot.winners.includes(playerId)
    ? pot.winners.filter((x) => x !== playerId)
    : [...pot.winners, playerId];
  tick();
  // Optimistic local paint so the tap feels instant on a slow phone.
  pot.winners = winners;
  current.sig = null;
  render(app);
  net.send({ t: 'selectWinners', potIndex, winners });
}
