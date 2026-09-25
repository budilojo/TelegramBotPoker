'use strict';
/**
 * The table message. A pure function `room -> { text, keyboard }` with no
 * Telegram imports, which is what makes the snapshot tests possible.
 *
 * Layout notes that are not obvious:
 *
 * - The player rows live in a <pre> block so the columns line up on a phone.
 *   Everything inside it is padded by VISUAL width (emoji and CJK take two
 *   cells), and the "who is on the clock" marker is a plain ASCII glyph —
 *   an emoji there would shift that one row and break the whole column.
 * - Buttons are visible to everybody in the group. They are NOT a permission:
 *   every press is re-checked against `from.id` on the server.
 */
import { legalActions, canDeal, results } from '../server/game.js';
import { NS, encode } from './cb.js';
import {
  num, signed, esc, padEnd, padStart, hhmm, STREET_RU, ACTION_RU,
} from './fmt.js';
import { roleOf, dealers, openPots, preview, startBlocker } from './room.js';

const NAME_W = 10;
const STACK_W = 8;

/** Pot-sized raise, same formula the web bet sheet uses. */
function potRaise(legal, f) {
  return Math.round(legal.myBet + legal.toCall + (legal.potTotal + legal.toCall) * f);
}

/* ------------------------------------------------------------------ table */

export function renderRoom(room) {
  if (room.status === 'finished') return finishedView(room);
  if (room.status === 'lobby') return lobbyView(room);
  const h = room.hand;
  if (!h) return lobbyView(room);
  if (h.phase === 'complete') return completeView(room);
  if (h.phase === 'showdown') {
    return room.ui.winner?.review ? reviewView(room) : winnerView(room);
  }
  return bettingView(room);
}

/* ------------------------------------------------------------------ lobby */

function lobbyView(room) {
  const s = room.settings;
  const seated = room.players.filter((p) => roleOf(p) === 'player');
  const dl = dealers(room);

  const lines = [
    '♠️ <b>НОВЫЙ СТОЛ</b>',
    '',
    `Стек ${num(s.startingStack)} · блайнды ${num(s.smallBlind)}/${num(s.bigBlind)}` +
      (s.blindMode === 'levels' ? ` · уровни по ${s.levelMinutes} мин` : ''),
    '',
  ];

  if (room.players.length === 0) {
    lines.push('<i>За столом пока никого.</i>');
  } else {
    const rows = room.players.map((p) => {
      const tags = [];
      if (p.id === room.hostId) tags.push('хост');
      if (roleOf(p) === 'dealer') tags.push('дилер');
      if (p.left) tags.push('вышел');
      return `${padEnd(p.name, NAME_W + 2)}${padStart(num(p.stack), STACK_W)}${tags.length ? '  ' + tags.join(', ') : ''}`;
    });
    lines.push(`<pre>${esc(rows.join('\n'))}</pre>`);
  }

  lines.push('');
  const blocker = startBlocker(room);
  lines.push(
    blocker
      ? `<i>${esc(blocker)}</i>`
      : `<i>${seated.filter(canDeal).length} за столом${dl.length ? `, дилер: ${esc(dl[0].name)}` : ''}. Хост может начинать.</i>`
  );
  if (room.notice) lines.push(`\n<i>${esc(room.notice)}</i>`);

  const kb = [
    [btn('Сесть за стол', NS.LOBBY, 'sit', room.seq), btn('Встать', NS.LOBBY, 'leave', room.seq)],
    [btn('▶️ Начать игру', NS.GAME, 'start', room.seq)],
  ];
  return { text: lines.join('\n'), keyboard: kb };
}

/* ---------------------------------------------------------------- betting */

function header(room, extra = '') {
  const h = room.hand;
  const s = room.settings;
  // On an all-in runout the engine never advances the street — the rest of
  // the board is dealt as a formality. Printing "ПРЕФЛОП" while everyone is
  // turning cards over on a full board would be a lie.
  const stage = h.phase === 'showdown' ? 'ВСКРЫТИЕ' : STREET_RU[h.street] || h.street.toUpperCase();
  const parts = [`♠️ <b>РАЗДАЧА #${h.no}</b>`, stage];
  if (s.blindMode === 'levels') parts.push(`Ур. ${room.level.index + 1}`);
  // The hand's start time, not the clock: a header that ticks every minute
  // would make every redraw a real edit and burn the chat's rate limit.
  parts.push(hhmm(h.startedAt || Date.now()));
  const btnName = room.players.find((p) => p.id === h.dealerId)?.name;
  const sub = [
    `<b>БАНК  ${num(potNow(room))}</b>`,
    // Queued blinds are shown, not announced once and forgotten: they land at
    // the next deal and everyone should be able to see that coming.
    `блайнды ${num(s.smallBlind)}/${num(s.bigBlind)}` +
      (room.pendingBlinds ? ` → ${num(room.pendingBlinds.sb)}/${num(room.pendingBlinds.bb)}` : ''),
  ];
  if (btnName) sub.push(`D ${esc(btnName)}`);
  return [parts.join(' · '), '', sub.join(' · ') + extra].join('\n');
}

function potNow(room) {
  return room.players.reduce((sum, p) => sum + (p.committed || 0), 0);
}

/** One row per player: marker, name, stack, status. */
function playerRows(room, { showStatus = true } = {}) {
  const h = room.hand;
  const rows = [];
  for (const p of room.players) {
    if (!p.inHand && roleOf(p) === 'dealer') continue;
    if (!p.inHand && !p.committed) {
      // Sitting out / waiting for the next hand — shown greyed at the bottom.
      continue;
    }
    const isActor = h && h.actorId === p.id;
    rows.push(
      (isActor ? '› ' : '  ') +
        padEnd(p.name, NAME_W) +
        padStart(num(p.stack), STACK_W) +
        (showStatus ? '  ' + statusOf(room, p, isActor) : '')
    );
  }
  const bench = room.players.filter(
    (p) => !p.inHand && !p.committed && roleOf(p) !== 'dealer'
  );
  for (const p of bench) {
    rows.push(
      '  ' + padEnd(p.name, NAME_W) + padStart(num(p.stack), STACK_W) + '  ' +
        (p.left ? 'вышел' : p.sittingOut ? 'пропуск' : 'ждёт')
    );
  }
  return rows;
}

function statusOf(room, p, isActor) {
  if (isActor) return '← ходит';
  if (p.folded) return 'fold';
  if (p.allIn) return `all-in${p.bet ? ' ' + num(p.bet) : ''}`;
  if (p.lastAction) {
    const label = ACTION_RU[p.lastAction] || String(p.lastAction).toLowerCase();
    const showAmt = p.lastAmount > 0 && p.lastAction !== 'CHECK' && p.lastAction !== 'FOLD';
    return showAmt ? `${label} ${num(p.bet || p.lastAmount)}` : label;
  }
  const h = room.hand;
  if (h && p.id === h.dealerId) return 'BTN';
  if (h && p.id === h.sbId) return 'SB';
  if (h && p.id === h.bbId) return 'BB';
  return '';
}

function bettingView(room) {
  const h = room.hand;
  const actor = room.players.find((p) => p.id === h.actorId);
  const legal = actor ? legalActions(room, actor.id) : null;

  const lines = [header(room), '', `<pre>${esc(playerRows(room).join('\n'))}</pre>`];

  if (room.status === 'paused') {
    lines.push('', '⏸ <b>Пауза.</b> Хост продолжит игру.');
    return { text: lines.join('\n'), keyboard: [[btn('▶️ Продолжить', NS.GAME, 'resume', room.seq)]] };
  }

  if (legal) {
    const bits = [];
    if (legal.currentBet > 0) bits.push(`Ставка ${num(legal.currentBet)}`);
    if (legal.toCall > 0) bits.push(`коллировать ${num(legal.callAmount)}`);
    else bits.push('можно чекнуть');
    lines.push('', `▶️ <b>${esc(actor.name)}</b> · ${bits.join(' · ')}`);
  }
  if (room.notice) lines.push('', `<i>${esc(room.notice)}</i>`);

  return { text: lines.join('\n'), keyboard: actionKeyboard(room, actor, legal) };
}

/**
 * Only the actions that are legal *right now*. FOLD disappears when checking
 * is free — folding for nothing is never right, and on a phone it is the most
 * expensive accidental tap there is.
 */
export function actionKeyboard(room, actor, legal) {
  if (!actor || !legal) return [];
  const seq = room.seq;
  const armed = room.ui.armedAllIn && room.ui.armedAllIn.userId === actor.id;

  if (armed) {
    return [
      [btn(`⚠️ ПОДТВЕРДИТЬ ALL-IN ${num(legal.maxTotal)}`, NS.ACT, 'allinok', seq)],
      [btn('Отмена', NS.ACT, 'allincancel', seq)],
    ];
  }

  const rows = [];
  const first = [];
  if (legal.canFold && legal.toCall > 0) first.push(btn('FOLD', NS.ACT, 'fold', seq));
  if (legal.canCheck) first.push(btn('CHECK', NS.ACT, 'check', seq));
  else if (legal.canCall) {
    first.push(
      btn(
        legal.isCallAllIn ? `CALL ${num(legal.callAmount)} (all-in)` : `CALL ${num(legal.callAmount)}`,
        NS.ACT,
        'call',
        seq
      )
    );
  }
  if (first.length) rows.push(first);

  const verb = legal.canBet ? 'bet' : legal.canRaise ? 'raise' : null;
  if (verb) {
    const bb = room.settings.bigBlind;
    const presets = [
      ['½ банка', potRaise(legal, 0.5)],
      ['банк', potRaise(legal, 1)],
      ['+BB', legal.currentBet + bb],
      ['+5BB', legal.currentBet + bb * 5],
    ]
      .map(([label, total]) => [label, Math.round(total)])
      // A preset below the minimum raise or above the stack is not an option,
      // and anything that equals the stack is just ALL-IN under another name.
      .filter(([, total]) => total >= legal.minTotal && total < legal.maxTotal);

    const seen = new Set();
    const unique = presets.filter(([, t]) => (seen.has(t) ? false : (seen.add(t), true)));
    unique.sort((a, b) => a[1] - b[1]);

    for (let i = 0; i < unique.length; i += 2) {
      rows.push(
        unique.slice(i, i + 2).map(([label, total]) =>
          btn(`${label} · ${num(total)}`, NS.ACT, verb, seq, total)
        )
      );
    }
    rows.push([btn('✏️ Своя сумма', NS.ACT, 'custom', seq)]);
  }

  // ALL-IN is an aggressive action, so it is gated by the same flags as BET
  // and RAISE — the web app does exactly this. When a player is raise-locked
  // by somebody's short all-in, shoving would re-open betting that the rules
  // say is closed. When they simply cannot cover the call, the CALL button
  // already reads "(all-in)" and covers the case.
  if (verb && legal.maxTotal > legal.currentBet) {
    rows.push([btn(`ALL-IN ${num(legal.maxTotal)}`, NS.ACT, 'allin', seq)]);
  }
  return rows;
}

/* --------------------------------------------------------------- showdown */

function potLabel(pot) {
  return pot.sideNo === 0 ? 'MAIN POT' : `SIDE POT ${pot.sideNo}`;
}

function winnerView(room) {
  const h = room.hand;
  const w = room.ui.winner;
  const pot = h.pots[w.potIndex];
  const steps = openPots(room);
  const at = steps.indexOf(w.potIndex);

  const lines = [
    header(room, ''),
    '',
    `<pre>${esc(playerRows(room).join('\n'))}</pre>`,
    '',
    `🏆 <b>${potLabel(pot)} · ${num(pot.amount)}</b>` +
      (steps.length > 1 ? `   (банк ${at + 1} из ${steps.length})` : ''),
    'Кто забрал? Можно отметить нескольких — банк разделится.',
  ];

  const refunds = h.pots.filter((p) => p.eligible.length === 1);
  if (refunds.length) {
    lines.push(
      '',
      ...refunds.map(
        (p) =>
          `<i>${potLabel(p)} ${num(p.amount)} — ВОЗВРАТ ${esc(nameOf(room, p.eligible[0]))}</i>`
      )
    );
  }
  if (!dealers(room).length) lines.push('', '<i>Дилер не назначен — победителя отмечает любой за столом.</i>');
  else lines.push('', `<i>Победителя определяет ${esc(dealers(room)[0].name)}.</i>`);

  // Folded players are never offered — the one dealer mistake that is
  // impossible to make here.
  const rows = [];
  const cands = pot.eligible.map((id) => ({ id, seat: room.players.findIndex((p) => p.id === id) }));
  for (let i = 0; i < cands.length; i += 2) {
    rows.push(
      cands.slice(i, i + 2).map(({ id, seat }) => {
        const on = pot.winners.includes(id);
        return btn(
          `${on ? '✅ ' : ''}${nameOf(room, id)}`,
          NS.WIN, 'pick', room.seq, w.potIndex, seat
        );
      })
    );
  }
  const nav = [];
  if (at > 0) nav.push(btn('← Назад', NS.WIN, 'back', room.seq));
  nav.push(btn(at + 1 < steps.length ? 'Далее →' : 'К распределению →', NS.WIN, 'next', room.seq));
  rows.push(nav);
  rows.push([btn('↩️ Отменить', NS.GAME, 'undo', room.seq)]);
  return { text: lines.join('\n'), keyboard: rows };
}

function reviewView(room) {
  const h = room.hand;
  const lines = [
    `♠️ <b>РАЗДАЧА #${h.no} · РАСПРЕДЕЛЕНИЕ</b>`,
    '',
  ];

  for (const pot of h.pots) {
    const names = pot.winners.map((id) => nameOf(room, id));
    const tag = pot.eligible.length === 1 ? ' (возврат)' : '';
    lines.push(`${potLabel(pot)} · ${num(pot.amount)} → ${esc(names.join(', ') || '—')}${tag}`);
  }

  // These numbers come from the engine's own `distribution()` — the same call
  // that will move the chips — so the preview cannot disagree with the result.
  const pay = preview(room);
  lines.push('', '<b>На руки:</b>');
  lines.push(
    `<pre>${esc(
      pay.map((x) => padEnd(x.name, NAME_W + 2) + padStart('+' + num(x.amount), STACK_W)).join('\n')
    )}</pre>`
  );
  lines.push('', '<i>Фишки двигаются только после подтверждения.</i>');

  return {
    text: lines.join('\n'),
    keyboard: [
      [btn('← Назад', NS.WIN, 'back', room.seq)],
      [btn('✅ Подтвердить', NS.WIN, 'ok', room.seq)],
    ],
  };
}

function completeView(room) {
  const h = room.hand;
  const last = room.history[0];
  const lines = [
    `♠️ <b>РАЗДАЧА #${h.no} ЗАВЕРШЕНА</b> · ${hhmm(h.endedAt || Date.now())}`,
    '',
    `<b>БАНК  ${num(last ? last.pot : 0)}</b>`,
    '',
  ];
  const pay = h.payouts || [];
  if (pay.length) {
    lines.push(
      `<pre>${esc(
        pay.map((x) => padEnd(x.name, NAME_W + 2) + padStart('+' + num(x.amount), STACK_W)).join('\n')
      )}</pre>`
    );
  }
  lines.push('', '<b>Стеки:</b>');
  lines.push(
    `<pre>${esc(
      room.players
        .filter((p) => roleOf(p) !== 'dealer')
        .map((p) => padEnd(p.name, NAME_W + 2) + padStart(num(p.stack), STACK_W) +
          '  ' + signed(p.stack - p.stats.buyIn))
        .join('\n')
    )}</pre>`
  );
  if (room.notice) lines.push('', `<i>${esc(room.notice)}</i>`);

  const dl = dealers(room);
  lines.push('', dl.length ? `<i>Следующую раздачу сдаёт ${esc(dl[0].name)}.</i>` : '');

  return {
    text: lines.join('\n').trimEnd(),
    keyboard: [
      [btn('🃏 Следующая раздача', NS.GAME, 'next', room.seq)],
      [btn('↩️ Отменить результат', NS.GAME, 'undo', room.seq)],
    ],
  };
}

function finishedView(room) {
  return { text: renderResults(room), keyboard: [] };
}

/* ---------------------------------------------------------------- results */

export function renderResults(room) {
  // The engine already derives net, role and host from the same numbers it
  // paid out with; re-deriving them here would be a second source of truth.
  // Only the ordering differs: for an end-of-evening table, who is up matters
  // more than who has the biggest pile.
  const rows = results(room)
    .map((r) => ({
      name: r.name,
      role: r.role,
      isHost: r.isHost,
      stack: r.stack,
      net: r.net,
      hands: r.handsPlayed,
      pots: r.potsWon,
      biggest: r.biggestPot,
    }))
    .sort((a, b) => b.net - a.net || b.stack - a.stack);

  const body = rows
    .map(
      (r) =>
        padEnd(r.name, NAME_W + 2) +
        padStart(num(r.stack), STACK_W) +
        padStart(signed(r.net), STACK_W + 1)
    )
    .join('\n');

  const extra = rows
    .map((r) => {
      const tags = [];
      if (r.isHost) tags.push('хост');
      if (r.role === 'dealer') tags.push('дилер');
      const t = tags.length ? ` (${tags.join(', ')})` : '';
      return `${esc(r.name)}${t}: раздач ${r.hands}, банков ${r.pots}, крупнейший ${num(r.biggest)}`;
    })
    .join('\n');

  const sum = rows.reduce((s, r) => s + r.net, 0);
  return [
    '🏁 <b>ИТОГИ</b>',
    '',
    `<pre>${esc(body)}</pre>`,
    '',
    `<i>${esc(extra)}</i>`,
    '',
    `<i>Сумма P/L: ${signed(sum)} — должна быть 0.</i>`,
  ].join('\n');
}

/* ------------------------------------------------------- host side panels */

export function renderRoles(room) {
  const rows = room.players.map((p, seat) => [
    btn(
      `${roleOf(p) === 'dealer' ? '🃏' : '🎲'} ${p.name} — ${roleOf(p) === 'dealer' ? 'дилер' : 'игрок'}` +
        (p.pendingRole ? ` → ${p.pendingRole === 'dealer' ? 'дилер' : 'игрок'}` : ''),
      NS.HOST, 'role', room.seq, seat
    ),
  ]);
  rows.push([btn('Закрыть', NS.HOST, 'close', room.seq)]);
  return {
    text:
      '<b>Роли</b>\n\nДилер раздаёт карты, не сидит за столом и не рискует фишками — ' +
      'и именно он отмечает, кто забрал банк.\nНажатие переключает роль. Дилер в комнате один.',
    keyboard: rows,
  };
}

export function renderKick(room) {
  const rows = room.players
    .map((p, seat) => ({ p, seat }))
    .filter(({ p }) => p.id !== room.hostId)
    .map(({ p, seat }) => [btn(`✖️ ${p.name}`, NS.HOST, 'kick', room.seq, seat)]);
  rows.push([btn('Закрыть', NS.HOST, 'close', room.seq)]);
  return { text: '<b>Удалить из игры</b>\n\nФишки в банке остаются в банке.', keyboard: rows };
}

/** Handing the room over — a host who is leaving should not take it with them. */
export function renderTransfer(room) {
  const rows = room.players
    .map((p, seat) => ({ p, seat }))
    .filter(({ p }) => p.id !== room.hostId)
    .map(({ p, seat }) => [btn(`👑 ${p.name}`, NS.HOST, 'host', room.seq, seat)]);
  rows.push([btn('Закрыть', NS.HOST, 'close', room.seq)]);
  return {
    text: '<b>Передать права хоста</b>\n\nХост управляет настройками, ролями и завершением игры.',
    keyboard: rows,
  };
}

/**
 * Re-buys. Somebody busting out should not end the evening, and the amount is
 * added to their buy-in as well as their stack so the final P/L stays honest.
 */
export function renderRebuy(room) {
  const step = room.settings.startingStack;
  const rows = room.players.map((p, seat) => [
    btn(`${p.name}: ${num(p.stack)} → ${num(p.stack + step)}`, NS.HOST, 'rebuy', room.seq, seat),
  ]);
  rows.push([btn('Закрыть', NS.HOST, 'close', room.seq)]);
  return {
    text:
      `<b>Докупка</b>\n\nОдин стартовый стек — ${num(step)} фишек. ` +
      'Сумма идёт и в стек, и в бай-ин, поэтому в итогах докупка не выглядит выигрышем.',
    keyboard: rows,
  };
}

/* ------------------------------------------------------------------ utils */

const nameOf = (room, id) => room.players.find((p) => p.id === id)?.name ?? '?';

function btn(text, ns, verb, seq, ...args) {
  return { text, callback_data: encode(ns, verb, seq, ...args) };
}

export { btn, nameOf };
