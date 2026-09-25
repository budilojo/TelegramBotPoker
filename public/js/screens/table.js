/**
 * The table. Everything a player needs in one glance: pot, my stack, whose
 * turn it is, and the only buttons that are legal right now.
 *
 * DOM is built once and updated in place so CSS transitions and the chip
 * animation survive state pushes from the server.
 */
import {
  h, icon, fmt, mount as fill, countTo, flash, tick, plural, contenders,
  blindText, STREET_RU,
} from '../util.js';
import { net } from '../net.js';
import { confirm } from '../ui/overlay.js';
import { openBetSheet, potRaise } from '../ui/betsheet.js';
import {
  openWinnerSheet, refreshWinnerSheet, winnerSheetOpen, closeWinnerSheet,
} from '../ui/winner.js';
import { openHistory, refreshHistory } from '../ui/history.js';
import { openRoomMenu, openPlayerPanel } from '../ui/hostmenu.js';
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

/**
 * The dealer on duty, if any. The host keeps permission to settle a pot even
 * when a dealer is assigned — that is the fallback for a dead dealer phone —
 * but permission is not an invitation: while the dealer is present and
 * online, this is their call, and nothing should be pushed at the player.
 */
function dutyDealer(s) {
  const d = s.dealerRoleId ? s.players.find((p) => p.id === s.dealerRoleId) : null;
  return d && d.connected ? d : null;
}

export function mount(app) {
  const codeBadge = h('span.code-badge.num');
  const handLabel = h('div.sub');
  const players = h('div.players');
  const potLabel = h('p.eyebrow', { text: 'Pot' });
  const potValue = h('div.pot-value.num', { text: '0' });
  const potSub = h('div.pot-sub');
  const myStack = h('div.v.num', { text: '0' });
  const myBetBox = h('div.side');
  const myBadges = h('div.me-badges');
  const actionbar = h('div.actionbar');
  const streetStrip = h('div.street-strip');

  const el = h(
    'div.screen.table-screen',
    h(
      'header.topbar',
      codeBadge,
      h('div.grow', handLabel),
      h('button.icon-btn', { 'aria-label': 'История', onclick: () => openHistory(app) }, icon('list')),
      h('button.icon-btn', { 'aria-label': 'Меню', onclick: () => openRoomMenu(app) }, icon('menu'))
    ),
    streetStrip,
    h('div.felt', players),
    h(
      'div.pot-zone',
      potLabel,
      potValue,
      potSub
    ),
    h(
      'div.me-strip',
      h('div.grow', h('div.k', { text: 'Мой стек' }), myStack, myBadges),
      myBetBox
    ),
    actionbar
  );

  el._refs = {
    codeBadge, handLabel, players, potLabel, potValue, potSub,
    myStack, myBetBox, myBadges, actionbar, streetStrip,
  };
  el._cards = new Map();
  el._actionSig = null;
  el._payoutKey = null;
  el._streetSig = null;
  return el;
}

export function update(app) {
  const s = app.state;
  if (!s) return;
  const el = app.view;
  const r = el._refs;
  const me = s.players.find((p) => p.id === s.you);
  const hand = s.hand;

  r.codeBadge.textContent = s.code;
  r.handLabel.textContent = handSub(app);

  renderStreetStrip(r.streetStrip, el, s);
  renderPlayers(app, el, r.players, me);
  renderPot(app, el, r, s, me);
  renderMe(r, s, me);
  renderActions(app, el, r, s, me);

  // Winner picking is the only moment the app *needs* a human decision — and
  // when a dealer is running the table, it is not this player's decision.
  if (hand?.phase === 'showdown' && s.canDecideWinner && !dutyDealer(s)) {
    if (winnerSheetOpen()) refreshWinnerSheet(app);
    else if (!app.ui.pending) openWinnerSheet(app);
  } else if (winnerSheetOpen() && (hand?.phase !== 'showdown' || dutyDealer(s))) {
    closeWinnerSheet();
  }
  refreshHistory(app);

  animatePayout(app, el, r);
}

/* ---------------------------------------------------------------- street */

function renderStreetStrip(strip, el, s) {
  const cur = s.hand?.street ?? 'preflop';
  const phase = s.hand?.phase ?? '';
  const sig = `${cur}|${phase}|${s.hand?.currentBet}`;
  if (el._streetSig === sig) return;
  el._streetSig = sig;

  // Once betting is over the street no longer matters — say what does.
  if (phase === 'showdown' || phase === 'complete') {
    return fill(
      strip,
      h(
        'span.seg.on',
        h('i.dot'),
        h('span', {
          text: phase === 'showdown' ? 'Вскрытие — кто выиграл?' : 'Раздача завершена',
        })
      )
    );
  }

  fill(
    strip,
    ...STREETS.map((st) =>
      h(
        'span.seg',
        { class: st === cur ? 'on' : '' },
        h('i.dot'),
        h('span', { text: STREET_RU[st] })
      )
    ),
    h('span.spacer')
  );
}

/* --------------------------------------------------------------- players */

function renderPlayers(app, el, container, me) {
  const s = app.state;
  // Seat order starting just after me, so the table reads like a real one.
  const idx = s.players.findIndex((p) => p.id === s.you);
  const rotated = idx < 0
    ? s.players
    : [...s.players.slice(idx + 1), ...s.players.slice(0, idx)];
  const ordered = rotated.filter((p) => p.role !== 'dealer');

  container.classList.toggle('single', ordered.length === 1);

  const seen = new Set();
  ordered.forEach((p, i) => {
    seen.add(p.id);
    let card = el._cards.get(p.id);
    if (!card) {
      card = buildCard(app, p);
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

function buildCard(app, player) {
  const nameEl = h('div.pname');
  const stackEl = h('div.pstack.num', { text: '0' });
  const betEl = h('div.pbet', { style: { display: 'none' } });
  const badges = h('div.badges');
  const flag = h('div.act-flag');
  const el = h('div.pcard', badges, nameEl, stackEl, betEl, flag);

  let lastAction = null;
  let lastStack = null;

  // Tapping a player is how the host reaches per-player controls.
  el.addEventListener('click', () => {
    const s = app.state;
    if (s.hostId !== s.you) return;
    openPlayerPanel(app, player.id);
  });

  return {
    el,
    playerId: player.id,
    update(p, s) {
      const hand = s.hand;
      const isTurn = hand?.phase === 'betting' && hand.actorId === p.id;
      const out = !p.inHand;

      fill(
        nameEl,
        !p.connected ? h('span.offline-dot', { title: 'Нет связи' }) : null,
        h('span', { text: p.name })
      );

      if (lastStack === null) stackEl.dataset.v = String(p.stack);
      countTo(stackEl, p.stack, lastStack === null ? 0 : 520);
      lastStack = p.stack;

      if (p.bet > 0) {
        betEl.style.display = '';
        fill(betEl, h('i.chip-dot'), h('span', { text: fmt(p.bet) }));
      } else {
        betEl.style.display = 'none';
      }

      const badgeList = [];
      if (p.id === s.dealerId) badgeList.push(['BTN', 'pos-D']);
      if (hand && p.id === hand.sbId) badgeList.push(['SB', 'pos-SB']);
      if (hand && p.id === hand.bbId) badgeList.push(['BB', 'pos-BB']);
      fill(
        badges,
        ...badgeList.map(([t, cls]) => h('span.pos-badge', { class: cls, text: t }))
      );

      el.classList.toggle('turn', isTurn);
      el.classList.toggle('folded', !!p.folded);
      el.classList.toggle('allin', !!p.allIn && !p.folded);
      el.classList.toggle('out', out && !p.folded);

      let label = '';
      let cls = '';
      // Sitting out only describes someone who is not in the current hand —
      // a player who steps away mid-hand still has chips in the pot.
      if (out && p.sittingOut) {
        label = 'пропускает';
      } else if (p.waiting) {
        label = 'ждёт раздачи';
      } else if (out && p.stack === 0) {
        label = 'без фишек';
      } else if (out) {
        label = 'не в раздаче';
      } else if (p.folded) {
        label = 'fold';
        cls = 'fold';
      } else if (p.allIn) {
        label = 'all-in';
        cls = 'allin';
      } else if (isTurn) {
        label = 'ходит';
        cls = 'aggr';
      } else if (p.lastAction && p.lastAction !== 'SB' && p.lastAction !== 'BB') {
        // Blind posts are already shown by the SB/BB badge — no need to repeat.
        label = p.lastAction.toLowerCase();
        cls = /RAISE|BET/.test(p.lastAction) ? 'aggr' : '';
      }
      flag.className = `act-flag ${cls}`;
      flag.textContent = label;
      if (label && p.lastAction && p.lastAction !== lastAction) flash(flag, 'pop');
      lastAction = p.lastAction;
    },
  };
}

/* ------------------------------------------------------------------- pot */

function renderPot(app, el, r, s, me) {
  const prevPot = Number(r.potValue.dataset.v ?? s.pot);
  countTo(r.potValue, s.pot, app.prev ? 520 : 0);
  if (s.pot !== prevPot && s.pot > prevPot) flash(r.potValue, 'bump');

  const hand = s.hand;
  if (!hand) {
    r.potSub.textContent = '';
    return;
  }
  r.potLabel.textContent = hand.phase === 'complete' ? 'Выиграно' : 'Pot';
  if (hand.phase === 'complete' && hand.payouts?.length) {
    const txt = hand.payouts
      .map((p) => `${p.name} +${fmt(p.amount)}`)
      .join(' · ');
    fill(r.potSub, h('b', { text: txt }));
  } else if (hand.phase === 'showdown') {
    // When a dealer runs the table this is not our call to make, so say who
    // is making it instead of handing the player an instruction they cannot
    // act on.
    const decider = dutyDealer(s) ?? (s.canDecideWinner ? null : s.players.find((p) => p.id === s.dealerRoleId));
    r.potSub.textContent = decider
      ? `${decider.name} определяет победителя`
      : hand.pots.length > 1
        ? `${hand.pots.length} ${plural(hand.pots.length, 'банк', 'банка', 'банков')} — укажите победителей`
        : 'Кто выиграл раздачу?';
  } else if (hand.runout) {
    r.potSub.textContent = 'All-in — досдавайте карты до конца';
  } else if (hand.currentBet > 0) {
    const inPlay = me && me.inHand && !me.folded && !me.allIn;
    const toCall = inPlay ? Math.max(0, hand.currentBet - me.bet) : 0;
    r.potSub.textContent = toCall
      ? `Ставка ${fmt(hand.currentBet)} · вам коллировать ${fmt(toCall)}`
      : `Ставка ${fmt(hand.currentBet)}`;
  } else {
    r.potSub.textContent = `Блайнды ${fmt(s.settings.smallBlind)}/${fmt(s.settings.bigBlind)}`;
  }
}

/* -------------------------------------------------------------------- me */

function renderMe(r, s, me) {
  if (!me) return;
  countTo(r.myStack, me.stack, 520);
  r.myStack.classList.toggle('lo', me.stack > 0 && me.stack < s.settings.bigBlind * 5);

  if (me.bet > 0) {
    fill(
      r.myBetBox,
      h('div.k', { text: 'В банке' }),
      h('div.v.num', { text: fmt(me.bet) })
    );
  } else {
    fill(r.myBetBox);
  }

  // My own position is as important as everyone else's — show it here, since
  // there is no player card for me on the table.
  const pos = [];
  if (me.id === s.dealerId) pos.push(['BTN', 'pos-D']);
  if (s.hand && me.id === s.hand.sbId) pos.push(['SB', 'pos-SB']);
  if (s.hand && me.id === s.hand.bbId) pos.push(['BB', 'pos-BB']);

  // Once the hand is paid out these say nothing useful — the stack does.
  const live = s.hand && s.hand.phase !== 'complete';
  const tags = [];
  if (live && me.folded) tags.push(['tag-off', 'Вы сбросили']);
  else if (live && me.allIn) tags.push(['tag-host', 'All-in']);
  if (me.sittingOut && !me.inHand) tags.push(['tag-wait', 'Пропускаю раздачи']);
  else if (me.waiting) tags.push(['tag-wait', 'Со следующей раздачи']);
  if (me.stack === 0 && !me.inHand && !me.waiting) tags.push(['tag-off', 'Без фишек']);
  if (me.isHost) tags.push(['tag-host', 'Хост']);

  fill(
    r.myBadges,
    ...pos.map(([t, cls]) => h('span.pos-badge', { class: cls, text: t })),
    ...tags.map(([cls, text]) => h('span.tag-pill', { class: cls, text }))
  );
}

/* --------------------------------------------------------------- actions */

function renderActions(app, el, r, s, me) {
  const hand = s.hand;
  const legal = s.legal;
  const pending = !!app.ui.pending;

  const sig = JSON.stringify([
    s.status, hand?.phase, hand?.actorId, hand?.no, legal, pending, me?.inHand, me?.folded, s.seq,
  ]);
  if (el._actionSig === sig) return;
  el._actionSig = sig;

  if (s.status === 'paused') {
    return fill(r.actionbar, note('Игра на паузе', 'Хост возобновит её'));
  }
  if (!hand) {
    return fill(r.actionbar, note('Ожидание', 'Раздача вот-вот начнётся'));
  }

  if (hand.phase === 'complete') {
    // Mirrors the server: with a dealer assigned, only they (or the host as
    // fallback) start the next hand, so nobody is shown a button that errors.
    const mayDeal = !s.hasDealer || !!me?.isHost;
    if (!mayDeal) {
      const d = s.players.find((p) => p.id === s.dealerRoleId);
      return fill(
        r.actionbar,
        note('Раздача завершена', d ? `${d.name} начнёт следующую` : 'Ждём дилера')
      );
    }
    const canDeal = contenders(s.players).length >= 2;
    return fill(
      r.actionbar,
      h('button.btn.btn-primary.btn-lg', {
        text: canDeal ? 'Следующая раздача' : 'Подвести итоги',
        disabled: pending,
        onclick: () => app.act({ t: 'nextHand' }),
      })
    );
  }

  if (hand.phase === 'showdown') {
    const onDuty = dutyDealer(s);
    if (!s.canDecideWinner || onDuty) {
      const d = onDuty ?? s.players.find((p) => p.id === s.dealerRoleId);
      const kids = [
        h(
          'div.wait-note',
          h('span.pulse-dots', h('i'), h('i'), h('i')),
          h('span', {}, d ? h('b.who', { text: d.name }) : 'Дилер', ' определяет победителя')
        ),
      ];
      // The host may still step in — offered, never forced.
      if (s.canDecideWinner) {
        kids.push(
          h('button.btn.btn-ghost.btn-sm', {
            style: { width: '100%' },
            text: 'Определить победителя самому',
            onclick: () => openWinnerSheet(app),
          })
        );
      }
      return fill(r.actionbar, ...kids);
    }
    return fill(
      r.actionbar,
      h('button.btn.btn-primary.btn-lg', {
        text: 'Кто выиграл раздачу?',
        onclick: () => openWinnerSheet(app),
      })
    );
  }

  // --- betting -------------------------------------------------------------
  if (!legal) {
    const actor = s.players.find((p) => p.id === hand.actorId);
    if (!me?.inHand) {
      return fill(
        r.actionbar,
        note(me?.waiting ? 'Вы вступите со следующей раздачи' : 'Вы не в этой раздаче',
          actor ? `Ходит ${actor.name}` : '')
      );
    }
    if (me.folded) return fill(r.actionbar, note('Вы сбросили карты', 'Ждём конца раздачи'));
    if (me.allIn) return fill(r.actionbar, note('Вы all-in', 'Досдавайте карты'));

    const waiting = h(
      'div.wait-note',
      h('span.pulse-dots', h('i'), h('i'), h('i')),
      h('span', {}, 'Ходит ', h('b.who', { text: actor?.name ?? '—' }))
    );
    const kids = [waiting];
    // A player whose phone died must not freeze the table.
    if (actor && !actor.connected && s.hostId === s.you) {
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
    return fill(r.actionbar, ...kids);
  }

  // It is my turn.
  const kids = [];
  const canAggress = legal.canBet || legal.canRaise;

  if (canAggress) {
    const half = potRaise(legal, 0.5);
    const full = potRaise(legal, 1);
    const quick = h(
      'div.act-grid',
      { style: { gridAutoColumns: '1fr' } },
      quickBtn(app, '½ POT', half, legal),
      quickBtn(app, 'POT', full, legal),
      h('button.quick.gold', {
        style: { minHeight: '44px' },
        text: `ALL-IN ${fmt(legal.maxTotal)}`,
        onclick: () =>
          confirm({
            title: 'Поставить весь стек?',
            body: `${fmt(legal.stack)} фишек уходят в банк.`,
            ok: `All-in ${fmt(legal.maxTotal)}`,
            onOk: () => app.act({ t: 'action', action: 'allin' }),
          }),
      })
    );
    kids.push(quick);
  }

  const main = h('div.act-grid');

  if (!legal.canCheck) {
    main.append(
      actBtn('act-fold', 'FOLD', null, () => app.act({ t: 'action', action: 'fold' }), pending)
    );
  }
  if (legal.canCheck) {
    main.append(
      actBtn('act-check', 'CHECK', null, () => app.act({ t: 'action', action: 'check' }), pending)
    );
  } else if (legal.canCall) {
    main.append(
      actBtn(
        'act-call',
        legal.isCallAllIn ? 'CALL ALL-IN' : 'CALL',
        fmt(legal.callAmount),
        () => app.act({ t: 'action', action: 'call' }),
        pending
      )
    );
  }
  if (canAggress) {
    main.append(
      actBtn('act-raise', legal.canBet ? 'BET' : 'RAISE', null, () => openBetSheet(app), pending)
    );
  }

  kids.push(main);
  fill(r.actionbar, ...kids);
}

function quickBtn(app, label, total, legal) {
  const clamped = Math.min(legal.maxTotal, Math.max(legal.minTotal, total));
  const disabled = clamped >= legal.maxTotal || clamped < legal.minTotal;
  return h('button.quick', {
    style: { minHeight: '44px' },
    text: `${label} ${fmt(clamped)}`,
    disabled,
    onclick: () => {
      tick();
      app.act({
        t: 'action',
        action: legal.canBet ? 'bet' : 'raise',
        amount: clamped,
      });
    },
  });
}

function actBtn(cls, label, amount, onclick, pending) {
  const b = h(
    'button.act',
    {
      class: cls,
      disabled: pending,
      onclick: (e) => {
        // Instant visual lock: the second tap of a double-tap hits a dead button.
        e.currentTarget.classList.add('sent');
        onclick();
      },
    },
    h('span', { text: label }),
    amount ? h('span.amt.num', { text: amount }) : null
  );
  return b;
}

function note(title, sub) {
  return h(
    'div.wait-note',
    h('span', {}, title, sub ? h('div', { style: { fontSize: '12.5px', opacity: '.7', marginTop: '2px' }, text: sub }) : null)
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
    const target =
      pay.playerId === app.state.you
        ? el.querySelector('.me-strip')
        : el._cards.get(pay.playerId)?.el;
    if (target) flyChips(r.potValue, target, chipCount(pay.amount, bb));
  }
  tick(18);
}
