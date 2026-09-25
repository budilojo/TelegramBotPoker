/**
 * Dealer mode.
 *
 * The dealer is holding real cards in one hand and the phone in the other,
 * so this screen is deliberately sparse: the whole table at a glance, and a
 * single large button at the bottom that says what to do next.
 */
import {
  h, icon, fmt, mount as fill, countTo, flash, tick, plural, contenders,
  blindText, STREET_RU,
} from '../util.js';
import { net } from '../net.js';
import { confirm } from '../ui/overlay.js';
import { openHistory, refreshHistory } from '../ui/history.js';
import { openRoomMenu } from '../ui/hostmenu.js';
import { openDealerWinner, dealerWinnerOpen, closeDealerWinner } from '../ui/dealerwinner.js';
import { flyChips, chipCount } from '../ui/chips.js';

const STREETS = ['preflop', 'flop', 'turn', 'river'];

/** "Раздача #3 · Ур. 2 · 12:34" — the hand and the blind clock in one line. */
function handSub(app) {
  const s = app.state;
  const blinds = blindText(s, app.stateAt);
  if (!s.hand) return blinds || 'Подготовка';
  // The blind clock costs room, so the hand number goes short to keep the
  // whole line on one row at 375px.
  return blinds ? `#${s.hand.no} · ${blinds}` : `Раздача #${s.hand.no}`;
}

/** Called once a second by the shell; touches nothing but the clock. */
export function tickClock(app) {
  const el = app.view?._refs?.handLabel;
  if (el) el.textContent = handSub(app);
}

export function mount(app) {
  const codeBadge = h('span.code-badge.num');
  const handLabel = h('div.sub');
  const streetStrip = h('div.street-strip');
  const list = h('div.dealer-list');
  const potLabel = h('p.eyebrow', { text: 'Pot' });
  const potValue = h('div.pot-value.num', { text: '0' });
  const potSub = h('div.pot-sub');
  const foot = h('div.actionbar');

  const el = h(
    'div.screen.table-screen',
    h(
      'header.topbar',
      codeBadge,
      h('div.grow', handLabel),
      h('button.icon-btn', { 'aria-label': 'История', onclick: () => openHistory(app) }, icon('list')),
      h('button.icon-btn', { 'aria-label': 'Меню комнаты', onclick: () => openRoomMenu(app) }, icon('menu'))
    ),
    h('div.dealer-banner', icon('deal'), 'Режим дилера'),
    streetStrip,
    h('div.felt', list),
    h('div.pot-zone', potLabel, potValue, potSub),
    foot
  );

  el._refs = { codeBadge, handLabel, streetStrip, list, potLabel, potValue, potSub, foot };
  el._cards = new Map();
  el._footSig = null;
  el._streetSig = null;
  el._payoutKey = null;
  return el;
}

export function update(app) {
  const s = app.state;
  if (!s) return;
  const el = app.view;
  const r = el._refs;
  const hand = s.hand;

  r.codeBadge.textContent = s.code;
  r.handLabel.textContent = handSub(app);

  renderStreet(r.streetStrip, el, s);
  renderPlayers(app, el, r.list);
  renderPot(app, r, s);
  renderFoot(app, el, r, s);

  // The winner screen is the dealer's whole job — open it as soon as the
  // betting is done, and close it the moment the hand is settled.
  if (hand?.phase === 'showdown' && s.canDecideWinner) {
    if (!dealerWinnerOpen() && !app.ui.pending) openDealerWinner(app);
  } else if (dealerWinnerOpen() && hand?.phase !== 'showdown') {
    closeDealerWinner();
  }

  refreshHistory(app);
  animatePayout(app, el, r);
}

/* ---------------------------------------------------------------- street */

function renderStreet(strip, el, s) {
  const cur = s.hand?.street ?? 'preflop';
  const phase = s.hand?.phase ?? '';
  const sig = `${cur}|${phase}`;
  if (el._streetSig === sig) return;
  el._streetSig = sig;

  if (phase === 'showdown' || phase === 'complete') {
    return fill(
      strip,
      h(
        'span.seg.on',
        h('i.dot'),
        h('span', {
          text: phase === 'showdown' ? 'Торговля окончена' : 'Раздача завершена',
        })
      )
    );
  }
  fill(
    strip,
    ...STREETS.map((st) =>
      h('span.seg', { class: st === cur ? 'on' : '' }, h('i.dot'), h('span', { text: STREET_RU[st] }))
    ),
    h('span.spacer')
  );
}

/* --------------------------------------------------------------- players */

function renderPlayers(app, el, container) {
  const s = app.state;
  // Dealers run the table, they do not sit at it.
  const seated = s.players.filter((p) => p.role !== 'dealer');

  const seen = new Set();
  seated.forEach((p, i) => {
    seen.add(p.id);
    let card = el._cards.get(p.id);
    if (!card) {
      card = buildCard();
      el._cards.set(p.id, card);
      container.append(card.el);
    }
    card.update(p, s);
    if (container.children[i] !== card.el)
      container.insertBefore(card.el, container.children[i] || null);
  });
  for (const [id, card] of el._cards) {
    if (!seen.has(id)) {
      card.el.remove();
      el._cards.delete(id);
    }
  }
}

function buildCard() {
  const nm = h('div.nm');
  const st = h('div.st.num', { text: '0' });
  const side = h('div.side');
  const el = h('div.dcard', h('div.who', nm, st), side);
  let lastStack = null;
  let lastAction = null;

  return {
    el,
    update(p, s) {
      const hand = s.hand;
      const isTurn = hand?.phase === 'betting' && hand.actorId === p.id;
      const out = !p.inHand;

      const badges = [];
      if (p.id === s.dealerId) badges.push(['BTN', 'pos-D']);
      if (hand && p.id === hand.sbId) badges.push(['SB', 'pos-SB']);
      if (hand && p.id === hand.bbId) badges.push(['BB', 'pos-BB']);

      fill(
        nm,
        !p.connected ? h('span.offline-dot', { title: 'Не в сети' }) : null,
        h('span', { text: p.name }),
        ...badges.map(([t, cls]) => h('span.pos-badge', { class: cls, text: t }))
      );

      if (lastStack === null) st.dataset.v = String(p.stack);
      countTo(st, p.stack, lastStack === null ? 0 : 520);
      lastStack = p.stack;

      let label = '';
      let cls = '';
      if (out && p.sittingOut) label = 'пропускает';
      else if (p.waiting) label = 'ждёт раздачи';
      else if (out && p.stack === 0) label = 'без фишек';
      else if (out) label = 'не в раздаче';
      else if (p.folded) (label = 'fold'), (cls = 'fold');
      else if (p.allIn) (label = 'all-in'), (cls = 'allin');
      else if (isTurn) (label = 'ходит'), (cls = 'turn');
      else if (p.lastAction && p.lastAction !== 'SB' && p.lastAction !== 'BB')
        label = p.lastAction.toLowerCase();

      fill(
        side,
        p.bet > 0 ? h('div.dbet', h('i.chip-dot'), h('span', { text: fmt(p.bet) })) : null,
        label ? h('div.dstate', { class: cls, text: label }) : null
      );
      if (label && p.lastAction !== lastAction) flash(side, 'pop');
      lastAction = p.lastAction;

      el.classList.toggle('turn', isTurn);
      el.classList.toggle('folded', !!p.folded);
      el.classList.toggle('allin', !!p.allIn && !p.folded);
      el.classList.toggle('out', out && !p.folded);
    },
  };
}

/* ------------------------------------------------------------------- pot */

function renderPot(app, r, s) {
  const prev = Number(r.potValue.dataset.v ?? s.pot);
  countTo(r.potValue, s.pot, app.prev ? 520 : 0);
  if (s.pot > prev) flash(r.potValue, 'bump');

  const hand = s.hand;
  r.potLabel.textContent = hand?.phase === 'complete' ? 'Выиграно' : 'Pot';
  if (!hand) return void (r.potSub.textContent = '');

  if (hand.phase === 'complete' && hand.payouts?.length) {
    fill(
      r.potSub,
      h('b', { text: hand.payouts.map((p) => `${p.name} +${fmt(p.amount)}`).join(' · ') })
    );
  } else if (hand.phase === 'showdown') {
    r.potSub.textContent =
      hand.pots.length > 1
        ? `${hand.pots.length} ${plural(hand.pots.length, 'банк', 'банка', 'банков')} — укажите победителей`
        : 'Укажите победителя';
  } else if (hand.runout) {
    r.potSub.textContent = 'All-in — досдавайте карты до конца';
  } else if (hand.currentBet > 0) {
    r.potSub.textContent = `Текущая ставка ${fmt(hand.currentBet)}`;
  } else {
    r.potSub.textContent = `Блайнды ${fmt(s.settings.smallBlind)}/${fmt(s.settings.bigBlind)}`;
  }
}

/* ------------------------------------------------------------ foot / CTA */

function renderFoot(app, el, r, s) {
  const hand = s.hand;
  const pending = !!app.ui.pending;
  const sig = JSON.stringify([s.status, hand?.phase, hand?.actorId, hand?.no, pending, s.seq]);
  if (el._footSig === sig) return;
  el._footSig = sig;

  if (s.status === 'paused') return fill(r.foot, note('Игра на паузе', 'Хост возобновит её'));
  if (!hand) return fill(r.foot, note('Ожидание', 'Раздача вот-вот начнётся'));

  if (hand.phase === 'complete') {
    const canDeal = contenders(s.players).length >= 2;
    return fill(
      r.foot,
      h('button.btn.btn-primary.btn-lg', {
        text: canDeal ? 'Следующая раздача' : 'Подвести итоги',
        disabled: pending,
        onclick: () => app.act({ t: 'nextHand' }),
      })
    );
  }

  if (hand.phase === 'showdown') {
    return fill(
      r.foot,
      h(
        'button.btn.btn-primary.btn-lg',
        { disabled: pending, onclick: () => openDealerWinner(app) },
        icon('gavel'),
        'Определить победителя'
      )
    );
  }

  // Betting in progress — the dealer just watches, unless somebody is stuck.
  const actor = s.players.find((p) => p.id === hand.actorId);
  const kids = [
    h(
      'div.wait-note',
      h('span.pulse-dots', h('i'), h('i'), h('i')),
      h('span', {}, 'Ходит ', h('b.who', { text: actor?.name ?? '—' }))
    ),
  ];
  if (actor && !actor.connected) {
    kids.push(
      h('button.btn.btn-ghost.btn-sm', {
        style: { width: '100%' },
        text: `${actor.name} не в сети — сделать fold за него`,
        onclick: () =>
          confirm({
            title: `Fold за ${actor.name}?`,
            body: 'Используйте, только если игрок точно отошёл.',
            ok: 'Сделать fold',
            danger: true,
            onOk: () => net.send({ t: 'forceFold', playerId: actor.id }),
          }),
      })
    );
  }
  fill(r.foot, ...kids);
}

function note(title, sub) {
  return h(
    'div.wait-note',
    h(
      'span',
      {},
      title,
      sub
        ? h('div', { style: { fontSize: '12.5px', opacity: '.7', marginTop: '2px' }, text: sub })
        : null
    )
  );
}

/* ---------------------------------------------------------- win animation */

function animatePayout(app, el, r) {
  const hand = app.state.hand;
  if (!hand || hand.phase !== 'complete' || !hand.payouts?.length) return;
  const key = `${app.state.code}:${hand.no}`;
  if (el._payoutKey === key) return;
  el._payoutKey = key;

  const bb = app.state.settings.bigBlind;
  for (const pay of hand.payouts) {
    const target = el._cards.get(pay.playerId)?.el;
    if (target) flyChips(r.potValue, target, chipCount(pay.amount, bb));
  }
  tick(18);
}
