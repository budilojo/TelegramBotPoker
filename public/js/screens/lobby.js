/**
 * Lobby. Nothing starts by itself: the host gathers people, hands out roles
 * and presses the one big button at the bottom.
 */
import { h, icon, fmt, mount as fill, initials, plural, contenders, tick } from '../util.js';
import { net, joinUrl } from '../net.js';
import { toast } from '../ui/overlay.js';
import { openRoomMenu, openPlayerPanel, openSettingsSheet } from '../ui/hostmenu.js';

export function mount(app) {
  const roomName = h('div.title');
  const subLine = h('div.sub');
  const codeText = h('span.num');
  const peopleEl = h('div.lobby-meta');
  const settingsBox = h('div.settings-grid');
  const qrBox = h('div.qr-wrap');
  const list = h('div.seat-list');
  const foot = h('div.sticky-foot');
  const rolesHint = h('p.hint', { style: { margin: '10px 2px 0' } });
  const blindsNote = h('p.hint', { style: { margin: '10px 2px 0' } });
  const editBtn = h('button.link-btn', { text: 'Изменить' });

  const copyBtn = h(
    'button.code-copy',
    { 'aria-label': 'Скопировать код комнаты', onclick: copyCode },
    codeText,
    icon('copy')
  );

  async function copyCode() {
    tick();
    const code = app.state.code;
    try {
      await navigator.clipboard.writeText(code);
      toast(`Код ${code} скопирован`, 'ok');
    } catch {
      toast(`Код комнаты: ${code}`, 'info', 5000);
    }
  }

  async function share() {
    const url = joinUrl(app.state.code);
    try {
      if (navigator.share) return void (await navigator.share({ title: 'Chip Table', url }));
    } catch {
      return; // cancelled
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Ссылка скопирована', 'ok');
    } catch {
      toast(url, 'info', 6000);
    }
  }

  editBtn.addEventListener('click', () => {
    if (app.state.hostId !== app.state.you) return toast('Настройки меняет хост', 'info');
    openSettingsSheet(app);
  });

  const el = h(
    'div.screen',
    h(
      'header.topbar',
      h('div.grow', roomName, subLine),
      h('button.icon-btn', { 'aria-label': 'Меню комнаты', onclick: () => openRoomMenu(app) }, icon('menu'))
    ),
    h(
      'div.scroll',
      h(
        'div.pad',
        { style: { paddingTop: '16px' } },
        h(
          'div.join-card',
          h('p.eyebrow', { text: 'Код подключения' }),
          copyBtn,
          qrBox,
          peopleEl,
          h(
            'div.row',
            { style: { gap: '8px', marginTop: '14px' } },
            h('button.btn.btn-ghost.btn-sm', { style: { flex: '1' }, onclick: share }, icon('share'), 'Ссылка'),
            h('button.btn.btn-ghost.btn-sm', { style: { flex: '1' }, onclick: copyCode }, icon('copy'), 'Код')
          )
        ),
        h(
          'div.row-between',
          { style: { margin: '26px 0 10px' } },
          h('p.eyebrow', { text: 'Настройки игры' }),
          editBtn
        ),
        settingsBox,
        blindsNote,
        h('p.eyebrow', { style: { margin: '26px 0 10px' }, text: 'Участники' }),
        list,
        rolesHint,
        h('div', { style: { height: '24px' } })
      )
    ),
    foot
  );

  el._refs = { roomName, subLine, blindsNote, codeText, peopleEl, settingsBox, qrBox, list, foot, rolesHint, editBtn };
  el._qrFor = null;
  el._seats = new Map();
  return el;
}

export function update(app) {
  const s = app.state;
  if (!s) return;
  const el = app.view;
  const r = el._refs;
  const isHost = s.hostId === s.you;

  r.roomName.textContent = s.name;
  r.subLine.textContent = s.hostName ? `Лобби · хост ${s.hostName}` : 'Лобби';
  r.codeText.textContent = s.code;
  r.editBtn.style.display = isHost ? '' : 'none';

  if (el._qrFor !== s.code) {
    el._qrFor = s.code;
    const url = joinUrl(s.code);
    fill(
      r.qrBox,
      h('img', {
        src: `/api/qr?u=${encodeURIComponent(url)}`,
        alt: `QR для входа в комнату ${s.code}`,
        style: { width: '100%', height: '100%', display: 'block', borderRadius: '10px' },
      })
    );
  }

  const n = s.players.length;
  const online = s.players.filter((p) => p.connected).length;
  r.peopleEl.textContent =
    online === n
      ? `${n} ${plural(n, 'участник', 'участника', 'участников')} на связи`
      : `${n} ${plural(n, 'участник', 'участника', 'участников')}, в сети ${online}`;

  fill(
    r.settingsBox,
    stat('Стек', fmt(s.settings.startingStack)),
    stat('Small', fmt(s.settings.smallBlind)),
    stat('Big', fmt(s.settings.bigBlind))
  );

  const b = s.blinds;
  r.blindsNote.textContent =
    b?.mode === 'levels'
      ? `Блайнды растут: уровень по ${b.levelMinutes} мин, следующий ${fmt(b.next?.sb ?? 0)}/${fmt(b.next?.bb ?? 0)}`
      : 'Блайнды фиксированные.';

  renderSeats(app, el, r.list);

  r.rolesHint.textContent = isHost
    ? 'Нажмите на участника, чтобы назначить роль, передать права хоста или удалить его.'
    : s.hasDealer
      ? 'Дилер раздаёт карты и отмечает, кто забрал банк.'
      : 'Роли назначает хост.';

  const playable = contenders(s.players).length;
  const ready = playable >= 2;

  if (isHost) {
    fill(
      r.foot,
      h('button.btn.btn-primary.btn-lg', {
        text: ready ? 'Начать игру' : 'Нужно минимум 2 игрока',
        disabled: !ready || !!app.ui.pending,
        onclick: () => app.act({ t: 'start' }),
      }),
      !ready
        ? h('p.hint', {
            style: { textAlign: 'center', margin: '8px 0 0' },
            text: 'Дилер не занимает место за столом — нужны участники с ролью Player.',
          })
        : null
    );
  } else {
    const me = s.players.find((p) => p.id === s.you);
    const isDealer = me?.role === 'dealer';
    fill(
      r.foot,
      h('button.btn', {
        class: me?.ready ? 'btn-primary' : 'btn-ghost',
        text: me?.ready ? '✓ Вы готовы' : 'Я готов',
        onclick: () => {
          tick();
          net.send({ t: 'ready', value: !me?.ready });
        },
      }),
      h('p.hint', {
        style: { textAlign: 'center', margin: '8px 0 0' },
        text: isDealer ? 'Вы дилер. Игру начинает хост.' : 'Игру начинает хост',
      })
    );
  }
}

function stat(k, v) {
  return h('div.stat-box', h('div.k', { text: k }), h('div.v.num', { text: v }));
}

/* ------------------------------------------------------------ seat list  */

function renderSeats(app, el, list) {
  const s = app.state;
  const seen = new Set();
  s.players.forEach((p, i) => {
    seen.add(p.id);
    let row = el._seats.get(p.id);
    if (!row) {
      row = buildSeat(app, p);
      el._seats.set(p.id, row);
      list.append(row.el);
    }
    row.update(p, s);
    if (list.children[i] !== row.el) list.insertBefore(row.el, list.children[i] || null);
  });
  for (const [id, row] of el._seats) {
    if (!seen.has(id)) {
      row.el.remove();
      el._seats.delete(id);
    }
  }
}

function buildSeat(app, player) {
  const avatar = h('div.avatar');
  const nm = h('div.nm');
  const roleLine = h('div.role-line');
  const right = h('div.seat-right');
  const el = h('button.seat.seat-btn', { type: 'button' }, avatar, h('div.grow', nm, roleLine), right);

  el.addEventListener('click', () => {
    if (app.state.hostId !== app.state.you) return;
    tick();
    openPlayerPanel(app, player.id);
  });

  return {
    el,
    update(p, s) {
      const isHost = s.hostId === s.you;
      const dealer = p.role === 'dealer';

      avatar.textContent = initials(p.name);
      avatar.classList.toggle('off', !p.connected);
      avatar.classList.toggle('avatar-dealer', dealer);

      fill(
        nm,
        !p.connected ? h('span.offline-dot', { title: 'Не в сети' }) : null,
        h('span', { text: p.name }),
        p.id === s.you ? h('span.tag-pill.tag-you', { text: 'Вы' }) : null
      );

      // "HOST • DEALER" — the permission first, then the game role.
      const parts = [];
      if (p.isHost) parts.push(h('span.role-host', { text: 'HOST' }));
      parts.push(
        h('span', {
          class: dealer ? 'role-dealer' : 'role-player',
          text: dealer ? 'DEALER' : 'PLAYER',
        })
      );
      if (p.pendingRole)
        parts.push(
          h('span.role-pending', {
            text: `→ ${p.pendingRole === 'dealer' ? 'DEALER' : 'PLAYER'}`,
          })
        );
      if (!p.connected) parts.push(h('span.role-off', { text: 'НЕ В СЕТИ' }));
      fill(roleLine, ...withDots(parts));

      fill(
        right,
        h('div.seat-stack.num', { text: fmt(p.stack) }),
        isHost ? icon('chev', 'seat-chev') : null
      );
      el.classList.toggle('is-tappable', isHost);
      el.classList.toggle('seat-dealer', dealer);
    },
  };
}

/** Interleave a "•" between role chips. */
function withDots(nodes) {
  const out = [];
  nodes.forEach((n, i) => {
    if (i) out.push(h('span.role-dot', { text: '•' }));
    out.push(n);
  });
  return out;
}
