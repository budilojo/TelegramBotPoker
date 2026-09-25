'use strict';
/**
 * Every message the bot writes. Pure functions `room -> { text, keyboard }`
 * with no Telegram imports, which is what makes the snapshot tests possible.
 *
 * Layout notes that are not obvious:
 *
 * - The player rows live in a <pre> block so the columns line up on a phone.
 *   Everything inside it is padded by VISUAL width (emoji and CJK take two
 *   cells), and the "who is on the clock" marker is a plain ASCII glyph —
 *   an emoji there would shift that one row and break the whole column.
 *   Cards are never put inside <pre>: suits are emoji and would do the same.
 * - Buttons are visible to everybody in the group. They are NOT a permission:
 *   every press is re-checked against `from.id` on the server.
 * - The group message never contains a card that is not public: the board,
 *   and at showdown the hands that must be shown (pot winners, all-ins; the
 *   other losers muck). Hole cards go to
 *   the private chat, or to the "🂠 Мои карты" popup that Telegram shows only
 *   to the person who pressed it.
 * - Command hints are wrapped in <code>. Telegram turns a bare `/allin` in a
 *   bot's message into a link that SENDS the command on tap — a stray tap on
 *   the hint line would shove somebody's stack. <code> is copied, not sent.
 */
import { legalActions, results, distribution } from '../server/game.js';
import { NS, encode } from './cb.js';
import {
  num, signed, esc, padEnd, padStart, hhmm, hhmmss, STREET_RU, ACTION_RU,
} from './fmt.js';
import { startBlocker, turnKey, AUTO_NEXT_MS } from './room.js';
import { cardsText, holeOf, boardShown } from './cards.js';

const NAME_W = 10;
const STACK_W = 8;

/** Pot-sized raise, same formula the web bet sheet uses. */
function potRaise(legal, f) {
  return Math.round(legal.myBet + legal.toCall + (legal.potTotal + legal.toCall) * f);
}

/** Players the table still shows: a removed player is only in the final results. */
const visible = (room) => room.players.filter((p) => !p.kicked);

/* ------------------------------------------------------------------ table */

/**
 * @param opts.botUsername  for the "open private chat" deep link
 */
export function renderRoom(room, opts = {}) {
  if (room.status === 'finished') return finishedView(room);
  if (room.status === 'lobby') return lobbyView(room, opts);
  const h = room.hand;
  if (!h) return lobbyView(room, opts);
  if (h.phase === 'complete') {
    return room.ui?.reveal?.handNo === h.no ? revealView(room) : completeView(room);
  }
  return bettingView(room);
}

/** `t.me/<bot>?start=cards` — opens the private chat with the Start button. */
export const dmLink = (botUsername) => (botUsername ? `https://t.me/${botUsername}?start=cards` : null);

/* ------------------------------------------------------------------ lobby */

function lobbyView(room, { botUsername = '' } = {}) {
  const s = room.settings;
  const seated = visible(room);

  const lines = [
    '♠️ <b>НОВЫЙ СТОЛ</b> · техасский холдем',
    '',
    `Стек ${num(s.startingStack)} · блайнды ${num(s.smallBlind)}/${num(s.bigBlind)}` +
      (s.blindMode === 'levels' ? ` · уровни по ${s.levelMinutes} мин` : '') +
      (s.turnSeconds ? ` · ⏱ ${s.turnSeconds} с на ход` : ''),
    '',
  ];

  if (seated.length === 0) {
    lines.push('<i>За столом пока никого.</i>');
  } else {
    const rows = seated.map((p) => {
      const tags = [];
      if (p.id === room.hostId) tags.push('хост');
      if (p.left) tags.push('вышел');
      else if (p.sittingOut) tags.push('встал');
      else if (p.dm !== 'ok') tags.push('нет лички');
      return `${padEnd(p.name, NAME_W + 2)}${padStart(num(p.stack), STACK_W)}${tags.length ? '  ' + tags.join(', ') : ''}`;
    });
    lines.push(`<pre>${esc(rows.join('\n'))}</pre>`);
  }

  lines.push('');
  const blocker = startBlocker(room);
  lines.push(
    blocker
      ? `<i>${esc(blocker)}</i>`
      : `<i>${seated.filter((p) => !p.sittingOut && !p.left).length} за столом. Хост может начинать.</i>`
  );
  const noDm = seated.filter((p) => !p.left && !p.sittingOut && p.dm !== 'ok');
  if (noDm.length) {
    lines.push(
      '',
      `🔑 Карты приходят в личку. ${esc(noDm.map((p) => p.name).join(', '))} — ` +
        'нажмите «Карты в личку» и Start. Без этого карты можно смотреть кнопкой «🂠 Мои карты».'
    );
  }
  if (room.notice) lines.push('', `<i>${esc(room.notice)}</i>`);

  const kb = [
    [btn('Сесть за стол', NS.LOBBY, 'sit', room.seq), btn('Встать', NS.LOBBY, 'leave', room.seq)],
    [btn('▶️ Начать игру', NS.GAME, 'start', room.seq)],
  ];
  const link = dmLink(botUsername);
  if (link) kb.push([{ text: '🔑 Карты в личку', url: link }]);
  return { text: lines.join('\n'), keyboard: kb };
}

/* ---------------------------------------------------------------- betting */

function header(room) {
  const h = room.hand;
  const s = room.settings;
  const parts = [`♠️ <b>РАЗДАЧА #${h.no}</b>`, STREET_RU[h.street] || h.street.toUpperCase()];
  if (s.blindMode === 'levels') parts.push(`Ур. ${room.level.index + 1}`);
  // The hand's start time, not the clock: a header that ticks every minute
  // would make every redraw a real edit and burn the chat's rate limit.
  parts.push(hhmm(h.startedAt || Date.now()));
  return parts.join(' · ');
}

function boardLine(room) {
  const b = room.hand.board || [];
  if (!b.length) return '🂠 <i>Карты розданы — смотрите в личке у бота.</i>';
  return `🂠 <b>${cardsText(b)}</b>`;
}

function potLine(room) {
  const h = room.hand;
  const s = room.settings;
  const btnName = room.players.find((p) => p.id === h.dealerId)?.name;
  const sub = [
    `<b>БАНК ${num(potNow(room))}</b>`,
    // Queued blinds are shown, not announced once and forgotten: they land at
    // the next deal and everyone should be able to see that coming.
    `блайнды ${num(s.smallBlind)}/${num(s.bigBlind)}` +
      (room.pendingBlinds ? ` → ${num(room.pendingBlinds.sb)}/${num(room.pendingBlinds.bb)}` : ''),
  ];
  if (btnName) sub.push(`D ${esc(btnName)}`);
  return sub.join(' · ');
}

function potNow(room) {
  return room.players.reduce((sum, p) => sum + (p.committed || 0), 0);
}

/** One row per player: marker, name, stack, status. */
function playerRows(room) {
  const h = room.hand;
  const rows = [];
  for (const p of room.players) {
    if (!p.inHand) continue;
    const isActor = h && h.actorId === p.id;
    rows.push(
      (
        (isActor ? '› ' : '  ') +
        padEnd(p.name, NAME_W) +
        padStart(num(p.stack), STACK_W) +
        '  ' + statusOf(room, p, isActor)
      ).trimEnd()
    );
  }
  for (const p of visible(room).filter((x) => !x.inHand)) {
    rows.push(
      '  ' + padEnd(p.name, NAME_W) + padStart(num(p.stack), STACK_W) + '  ' +
        (p.left ? 'вышел' : p.sittingOut ? 'пропуск' : p.stack <= 0 ? 'без фишек' : 'ждёт')
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

/** Players in this hand whose cards could not be delivered privately. */
function undelivered(room) {
  const h = room.hand;
  return room.players.filter((p) => p.inHand && !p.folded && h.holes?.[p.id] && p.dm === 'fail');
}

function bettingView(room) {
  const h = room.hand;
  const actor = room.players.find((p) => p.id === h.actorId);
  const legal = actor ? legalActions(room, actor.id) : null;

  const lines = [
    header(room),
    '',
    boardLine(room),
    '',
    potLine(room),
    `<pre>${esc(playerRows(room).join('\n'))}</pre>`,
  ];

  if (room.status === 'paused') {
    lines.push('⏸ <b>Пауза.</b> Хост продолжит игру.');
    return {
      text: lines.join('\n'),
      keyboard: [[btn('▶️ Продолжить', NS.GAME, 'resume', room.seq)], [peekButton()]],
    };
  }

  if (legal) {
    const bits = [];
    if (legal.currentBet > 0) bits.push(`ставка ${num(legal.currentBet)}`);
    if (legal.toCall > 0) bits.push(`коллировать ${num(legal.callAmount)}`);
    else bits.push('можно чекнуть');
    lines.push(`▶️ <b>${esc(actor.name)}</b> · ${bits.join(' · ')}`);
    lines.push(`<code>${esc(commandHints(legal))}</code>`);
    // A fixed time, not a countdown: a ticking number would turn every
    // second into an edit and burn the chat's rate limit in a minute.
    const t = room.turn;
    if (t && t.key === turnKey(room) && t.deadline != null) {
      lines.push(`⏱ ход до ${hhmmss(t.deadline)} — потом ${legal.canCheck ? 'чек' : 'фолд'}`);
    }
  }
  const lost = undelivered(room);
  if (lost.length) {
    lines.push(
      '',
      `⚠️ Не дошло в личку: ${esc(lost.map((p) => p.name).join(', '))} — смотрите кнопкой «🂠 Мои карты».`
    );
  }
  if (room.notice) lines.push('', `<i>${esc(room.notice)}</i>`);

  const kb = actionKeyboard(room, actor, legal);
  kb.push([peekButton()]);
  return { text: lines.join('\n'), keyboard: kb };
}

/** The typed equivalents of the buttons, with plain digits — they get copied. */
export function commandHints(legal) {
  const c = [];
  if (legal.canCheck) c.push('/check');
  if (legal.canCall) c.push('/call');
  if (legal.canBet) c.push(`/bet ${legal.minTotal}…${legal.maxTotal}`);
  if (legal.canRaise) c.push(`/raise ${legal.minTotal}…${legal.maxTotal}`);
  if ((legal.canBet || legal.canRaise) && legal.maxTotal > legal.currentBet) c.push('/allin');
  if (legal.toCall > 0) c.push('/fold');
  return c.join(' · ');
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

/**
 * Read-only and private, so it carries no live seq: an old copy of the table
 * still answers correctly, because the answer is computed at press time from
 * whoever pressed.
 */
const peekButton = () => btn('🂠 Мои карты', NS.CARDS, 'peek', 0);

/* ---------------------------------------------------------- hand complete */

function potLabel(pot) {
  return pot.sideNo === 0 ? 'MAIN POT' : `SIDE POT ${pot.sideNo}`;
}

function completeView(room) {
  const h = room.hand;
  const last = room.history.find((x) => x.no === h.no);
  const shown = h.shown || null;
  const title = h.aborted
    ? `♠️ <b>РАЗДАЧА #${h.no} ПРЕРВАНА</b>`
    : shown
      ? `♠️ <b>РАЗДАЧА #${h.no} · ВСКРЫТИЕ</b>`
      : `♠️ <b>РАЗДАЧА #${h.no} ЗАВЕРШЕНА</b>`;
  const lines = [`${title} · ${hhmm(h.endedAt || Date.now())}`, ''];

  if (h.board?.length) lines.push(`🂠 <b>${cardsText(h.board)}</b>`, '');

  if (h.aborted) {
    lines.push('<i>Игру завершили посреди раздачи — поставленные фишки вернулись владельцам.</i>');
  } else if (!shown) {
    for (const x of h.payouts || []) {
      lines.push(`🏆 <b>${esc(x.name)}</b> +${num(x.amount)} — остальные сбросили`);
    }
  } else {
    // Winnings and refunds, told apart: chips nobody called coming back are
    // not a won pot and get no trophy. Both figures come from the engine's
    // own `distribution` — the call that actually paid them.
    const { perPot } = distribution(room, h.pots);
    const won = new Map();
    const back = new Map();
    h.pots.forEach((pot, i) => {
      const into = pot.eligible.length > 1 ? won : back;
      for (const { id, share } of perPot[i]) into.set(id, (into.get(id) || 0) + share);
    });
    for (const p of room.players) {
      if (!won.has(p.id)) continue;
      lines.push(`🏆 <b>${esc(p.name)}</b> +${num(won.get(p.id))} · ${esc(shown[p.id]?.name ?? '')}`);
    }
    for (const p of room.players) {
      if (!back.has(p.id)) continue;
      lines.push(`↩️ ${esc(p.name)} +${num(back.get(p.id))} — возврат неуравненной ставки`);
    }

    // Only the hands that have to be shown: pot winners and all-ins. A
    // losing hand is mucked unseen — its name would give it away too — and a
    // folded hand is never shown at all.
    lines.push('');
    for (const p of room.players) {
      const sh = shown[p.id];
      if (sh) lines.push(`${esc(p.name)}: ${cardsText(sh.cards)} — ${esc(sh.name)}`);
      else if (h.mucked?.includes(p.id)) lines.push(`${esc(p.name)}: карты не показаны`);
    }
    if (h.pots.length > 1) {
      lines.push('');
      for (const pot of h.pots) {
        const names = pot.winners.map((id) => nameOf(room, id));
        const tag = pot.eligible.length === 1 ? ' (возврат)' : '';
        lines.push(`${potLabel(pot)} ${num(pot.amount)} → ${esc(names.join(' + '))}${tag}`);
      }
    }
  }

  lines.push('', h.aborted ? 'Стеки:' : `<b>Банк ${num(last ? last.pot : 0)}</b> · стеки:`);
  lines.push(
    `<pre>${esc(
      visible(room)
        .map((p) => padEnd(p.name, NAME_W + 2) + padStart(num(p.stack), STACK_W) +
          '  ' + signed(p.stack - p.stats.buyIn) +
          // Who will NOT be dealt next hand — the moment it matters is now.
          (p.left ? '  вышел' : p.sittingOut ? '  пропуск' : ''))
        .join('\n')
    )}</pre>`
  );
  if (room.notice) lines.push(`<i>${esc(room.notice)}</i>`);
  if (room.autoNext && room.status === 'playing') {
    lines.push(`<i>Следующая раздача сама через ${AUTO_NEXT_MS / 1000} с — или кнопкой.</i>`);
  }

  const kb = [];
  if (room.status === 'paused') kb.push([btn('▶️ Продолжить', NS.GAME, 'resume', room.seq)]);
  else kb.push([btn('🃏 Следующая раздача', NS.GAME, 'next', room.seq)]);
  kb.push([peekButton()]);
  return { text: lines.join('\n').trimEnd(), keyboard: kb };
}

/**
 * An all-in board being turned over, one street at a time. The outcome is
 * already decided (and paid) — this is only what the group is shown while
 * the cards come out. Tabled here: the all-in hands, as at a real table.
 * A player who is NOT all-in shows only if they win, so not before the end.
 */
function revealView(room) {
  const h = room.hand;
  const board = boardShown(room);
  const lines = [`♠️ <b>РАЗДАЧА #${h.no} · ОЛЛ-ИН</b> · ${hhmm(h.startedAt || Date.now())}`, ''];
  lines.push(board.length ? `🂠 <b>${cardsText(board)}</b>` : '🂠 <i>Борд ещё не открыт.</i>', '');
  for (const p of room.players) {
    const s = h.shown?.[p.id];
    if (s && p.allIn) lines.push(`${esc(p.name)}: ${cardsText(s.cards)}`);
  }
  const pot = h.pots.reduce((sum, x) => sum + x.amount, 0);
  lines.push('', `<b>БАНК ${num(pot)}</b>`, '<i>Открываем борд…</i>');
  return { text: lines.join('\n'), keyboard: [[peekButton()]] };
}

function finishedView(room) {
  return { text: renderResults(room), keyboard: [] };
}

/* ---------------------------------------------------------------- results */

export function renderResults(room) {
  // The engine already derives net and host from the same numbers it paid
  // out with; re-deriving them here would be a second source of truth. Only
  // the ordering differs: at the end of the evening, who is up matters more
  // than who has the biggest pile.
  const byId = new Map(room.players.map((p) => [p.id, p]));
  const rows = results(room)
    .map((r) => ({
      name: r.name,
      isHost: r.isHost,
      kicked: !!byId.get(r.id)?.kicked,
      left: !!byId.get(r.id)?.left,
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
      if (r.kicked) tags.push('удалён');
      else if (r.left) tags.push('вышел');
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
    `<i>${extra}</i>`,
    '',
    `<i>Раздач сыграно: ${room.handNo}. Сумма P/L: ${signed(sum)} — должна быть 0.</i>`,
  ].join('\n');
}

/* ------------------------------------------------------ private messages */

/** The private message with somebody's hole cards. Nothing else goes in it. */
export function renderHole(room, userId) {
  const cards = holeOf(room, userId);
  if (!cards) return null;
  const where = room.title ? ` · ${esc(room.title)}` : '';
  return [
    `🂠 <b>Раздача #${room.hand.no}</b>${where}`,
    '',
    `<b>${cardsText(cards)}</b>`,
    '',
    '<i>Ходить — в группе: кнопками под столом или командами /call, /raise 300, /fold.</i>',
  ].join('\n');
}

/* ------------------------------------------------------- host side panels */

export function renderKick(room) {
  const rows = room.players
    .map((p, seat) => ({ p, seat }))
    .filter(({ p }) => p.id !== room.hostId && !p.kicked)
    .map(({ p, seat }) => [btn(`✖️ ${p.name}`, NS.HOST, 'kick', room.seq, seat)]);
  rows.push([btn('Закрыть', NS.HOST, 'close', room.seq)]);
  return {
    text:
      '<b>Удалить из игры</b>\n\nФишки в банке остаются в банке, а результат игрока — в итогах вечера. ' +
      'Если он в олл-ине, его рука доиграет.',
    keyboard: rows,
  };
}

/** Handing the room over — a host who is leaving should not take it with them. */
export function renderTransfer(room) {
  const rows = room.players
    .map((p, seat) => ({ p, seat }))
    .filter(({ p }) => p.id !== room.hostId && !p.kicked && !p.left)
    .map(({ p, seat }) => [btn(`👑 ${p.name}`, NS.HOST, 'host', room.seq, seat)]);
  rows.push([btn('Закрыть', NS.HOST, 'close', room.seq)]);
  return {
    text: '<b>Передать права хоста</b>\n\nХост управляет настройками, докупками и завершением игры.',
    keyboard: rows,
  };
}

/**
 * Re-buys. Somebody busting out should not end the evening, and the amount is
 * added to their buy-in as well as their stack so the final P/L stays honest.
 */
export function renderRebuy(room) {
  const step = room.settings.startingStack;
  const rows = room.players
    .map((p, seat) => ({ p, seat }))
    .filter(({ p }) => !p.kicked)
    .map(({ p, seat }) => [
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
