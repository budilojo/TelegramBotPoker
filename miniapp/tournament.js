import { h, fmt, haptic, showSheet, closeSheet, toast } from './ui.js';
import { send } from './net.js';

const sendAction = (t) => { haptic.tap(); send({ t }); };
const DEFAULT_LEVELS = '25 50 300\n50 100 300\n100 200 300\n200 400 300';

const TOUR_STATUS = { lobby: 'Регистрация', playing: 'В игре', paused: 'Пауза', finished: 'Итоги' };

export function tournamentEntry(state) {
  const mine = state.myTournaments ?? [];
  const row = (title, subtitle, onclick) => h('button.set-row.tour-entry', { type: 'button', onclick },
    h('div.set-body', h('div.set-title', title), h('div.set-sub', subtitle)));
  return h('section.set-block',
    h('div.section-label', 'Турниры'),
    mine.map(t => row(t.title, TOUR_STATUS[t.status], () => {
      haptic.tap();
      send({ t: 'tournament-resume', code: t.code });
    })),
    mine.some(t => t.host && t.status !== 'finished') ? null : row('Создать турнир', 'Покер на одном столе · до 8 игроков', tournamentCreate));
}

export function tournamentCreate() {
  const input = (label, field) => h('label.tour-input', h('span', label), field);
  const draft = { name: '', seats: '8', stack: '10000', schedule: DEFAULT_LEVELS };
  const update = key => e => { draft[key] = e.target.value; };
  showSheet('tournament-create', () => {
    const name = h('input.inp', { required: true, maxlength: 40, placeholder: 'Вечерний холдем', value: draft.name, oninput: update('name') });
    const seats = h('input.inp', { type: 'number', min: 2, max: 8, required: true, value: draft.seats, oninput: update('seats') });
    const stack = h('input.inp', { type: 'number', min: 2, max: 100_000_000, required: true, value: draft.stack, oninput: update('stack') });
    const schedule = h('textarea.inp', { required: true, rows: 4, maxlength: 600, oninput: update('schedule') }, draft.schedule);
    return h('form.tour-form', { onsubmit: e => {
      e.preventDefault();
      const levels = schedule.value.trim().split(/\n/).map(line => {
        const values = line.trim().split(/\s+/).map(Number);
        return values.length === 3 ? { small: values[0], big: values[1], seconds: values[2] } : null;
      });
      send({ t: 'tournament-create', name: name.value, seats: seats.valueAsNumber, stack: stack.valueAsNumber, levels });
    } },
    h('h3', 'Создать покерный турнир'),
    input('Название', name),
    h('div.grid2', input('Мест за столом', seats), input('Стартовый стек', stack)),
    input('Уровни блайндов', schedule),
    h('p.hint', 'По одному уровню на строку. Три числа через пробел: малый блайнд, большой блайнд и длительность в секундах.'),
    h('button.btn.primary.wide', { type: 'submit' }, 'Создать турнир'));
  });
}

function shareLink(url) {
  document.dispatchEvent(new CustomEvent('ux-step', { detail: { name: 'invite_open', game: 'poker' } }));
  showSheet('tournament-share', () => {
    const field = h('input.inp', { readonly: true, value: url, 'aria-label': 'Ссылка на турнир', onclick: e => e.currentTarget.select() });
    return h('div.tour-form',
      h('h3', 'Пригласить в турнир'),
      field,
      h('button.btn.primary.wide', { onclick: async () => {
        try { await navigator.clipboard.writeText(url); closeSheet(); toast('Ссылка скопирована'); }
        catch { field.focus(); field.select(); toast('Скопируйте выделенную ссылку'); }
      } }, 'Скопировать ссылку'));
  });
}

export function tournamentTopup(s, countdown = false) {
  const { canRebuy, canAddon } = s.tournament;
  if (!canRebuy && !canAddon) return null;
  const timer = countdown && s.autoNextAt ? h('small', { 'data-count': s.autoNextAt, 'data-prefix': 'раздача через ' }) : null;
  return h('button.btn.wide', { onclick: () => sendAction(canRebuy ? 'tour-rebuy' : 'tour-addon') },
    canRebuy ? 'Докупка' : 'Добавка', timer);
}

const blinds = (level) => level ? `${fmt(level.small)} / ${fmt(level.big)}` : '—';

export function tournamentSummary(s, showTable) {
  const t = s.tournament;
  const waiting = s.room.status === 'lobby';
  const finished = s.room.status === 'finished';
  const phase = waiting ? 'Регистрация' : finished ? 'Турнир завершён' : s.room.status === 'paused' ? 'Пауза' : 'В игре';
  const seconds = Math.ceil((t.remaining || 0) / 1000);
  const count = t.deadline ? h('b.num', { 'data-count': t.deadline }) : !waiting && !finished && seconds
    ? h('b.num', `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`) : null;
  const actions = [];
  if (waiting && !s.me.seated) actions.push(h('button.btn.primary.wide', { onclick: () => sendAction('sit') }, 'Занять место'));
  if (waiting && s.me.isHost) actions.push(h('button.btn.primary.wide', { disabled: t.leaders.length < 2, onclick: () => sendAction('start') }, 'Начать турнир'));
  actions.push(tournamentTopup(s));
  if (!waiting && !finished) actions.push(h('button.btn.primary.wide', { onclick: showTable }, 'К столу'));
  if (s.room.status === 'paused' && s.me.isHost) actions.push(h('button.btn.wide', { onclick: () => sendAction('resume') }, 'Продолжить'));
  actions.push(h('button.btn.wide', { onclick: () => shareLink(t.share || location.href) }, 'Поделиться ссылкой'));

  return h('div.lobby.tour',
    h('button.back-link', { onclick: () => sendAction('hub') }, '← К играм'),
    h('header', h('div.sub', `Покерный турнир · ${phase}`), h('h1', s.room.title), h('p.hint', `Игроков ${fmt(t.leaders.length)} из ${fmt(t.seats)}`)),
    h('div.box.tour-level',
      h('div', h('strong', `Уровень ${fmt(t.level)}`), count),
      h('div', 'Текущие блайнды', h('b.num', blinds(t.current))),
      h('div', 'Следующие блайнды', h('b.num', blinds(t.next))),
      !waiting && !finished ? h('p.hint', 'Новые блайнды вступают в силу со следующей раздачи.') : null),
    h('section', h('h2.section-label', 'Турнирная таблица'),
      h('ol.tour-leaders', t.leaders.map((p, i) => h('li.box.tour-player',
        h('span.num', fmt(i + 1)), h('div', h('strong', p.name),
          h('div.hint', p.eliminated ? 'Выбыл' : waiting ? 'Зарегистрирован' : finished ? 'Завершил' : 'В игре')),
        h('b.num', fmt(p.stack)), h('div.hint.tour-topup', `Докупки: ${fmt(p.rebuy)} · Добавки: ${fmt(p.addon)}`))))),
    h('div.tour-actions', actions));
}
