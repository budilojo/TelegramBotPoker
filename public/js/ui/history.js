/** Hand history — a drawer, never the main screen. */
import { h, fmt, mount as fill, STREET_RU, ACTION_RU } from '../util.js';
import { sheet } from './overlay.js';

let current = null;

export function openHistory(app) {
  if (current) return;
  const body = h('div.sheet-body');
  const { close } = sheet(
    () => [
      h('div.sheet-title', { text: 'История игры' }),
      h('div.sheet-sub', { text: 'Все действия текущей и прошлых раздач' }),
      body,
    ],
    { onClose: () => (current = null) }
  );
  current = { close, body, sig: null };
  render(app);
}

export function refreshHistory(app) {
  if (current) render(app);
}

function render(app) {
  const s = app.state;
  const live = s.hand;
  const sig = JSON.stringify([live?.no, live?.log?.length, live?.phase, s.history.length]);
  if (current.sig === sig) return;
  current.sig = sig;

  const blocks = [];

  if (live && live.log?.length && live.phase !== 'complete') {
    blocks.push(handBlock(`Раздача #${live.no} · идёт`, live.log, null));
  }
  for (const past of s.history) {
    blocks.push(handBlock(`Раздача #${past.no}`, past.log, past.payouts));
  }

  fill(
    current.body,
    blocks.length
      ? blocks
      : h('div.empty', { text: 'Пока ничего не произошло.\nИстория появится после первых ставок.' })
  );
}

function handBlock(title, log, payouts) {
  const lines = [];
  for (const e of log || []) {
    if (e.type === 'street') {
      lines.push(h('div.hist-line.street', { text: STREET_RU[e.street] || e.street }));
      continue;
    }
    if (e.type === 'blind') {
      lines.push(line(e.name, `${e.label} ${fmt(e.amount)}`, ''));
      continue;
    }
    const label = ACTION_RU[e.type] || e.type;
    const amount =
      e.type === 'fold' || e.type === 'check'
        ? ''
        : fmt(e.total ?? e.amount ?? 0);
    lines.push(line(e.name, `${label}${amount ? ' ' + amount : ''}`, e.type === 'fold' ? 'fold' : ''));
  }
  for (const p of payouts || []) {
    lines.push(line(p.name, `выиграл +${fmt(p.amount)}`, 'win'));
  }

  return h(
    'div.hist-hand',
    h('div.hist-head', h('span', { text: title })),
    lines.length ? lines : h('div.hist-line', { style: { color: 'var(--faint)' }, text: '—' })
  );
}

function line(who, what, cls) {
  return h(
    'div.hist-line',
    { class: cls },
    h('span.who', { text: who }),
    h('span.what', { text: what })
  );
}
