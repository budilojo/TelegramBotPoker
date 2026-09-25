import { h, icon, fmt, store, mount as fill, plural } from '../util.js';
import { net } from '../net.js';
import { toast } from '../ui/overlay.js';

const LEN = 4;

export function mount(app) {
  let code = (app.ui.joinCode || '').toUpperCase().slice(0, LEN);
  let lookup = null; // null | 'checking' | {room} | {error}
  let seq = 0;

  const cells = Array.from({ length: LEN }, () => h('div.code-cell'));
  const entry = h('div.code-entry');
  const input = h('input.code-input', {
    type: 'text',
    inputmode: 'text',
    autocapitalize: 'characters',
    autocomplete: 'one-time-code',
    autocorrect: 'off',
    spellcheck: 'false',
    maxlength: String(LEN),
    'aria-label': 'Код комнаты',
    value: code,
    oninput: (e) => {
      code = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, LEN);
      e.target.value = code;
      paintCells();
      check();
    },
  });
  entry.append(h('div.code-cells', cells), input);

  const roomInfo = h('div', { style: { minHeight: '92px', marginTop: '20px' } });

  const nameInput = h('input.input', {
    type: 'text',
    placeholder: 'Ваше имя',
    maxlength: 16,
    autocomplete: 'nickname',
    enterkeyhint: 'go',
    value: store.get('chiptable.name', ''),
    oninput: () => paintButton(),
    onkeydown: (e) => {
      if (e.key === 'Enter') join();
    },
  });
  const nameField = h(
    'label.field',
    { style: { marginTop: '18px', display: 'none' } },
    h('span.label', { text: 'Ваше имя' }),
    nameInput
  );

  const submit = h('button.btn.btn-primary.btn-lg', {
    text: 'Присоединиться',
    disabled: true,
    onclick: join,
  });

  function paintCells() {
    for (let i = 0; i < LEN; i++) {
      const c = cells[i];
      c.textContent = code[i] || '';
      c.classList.toggle('filled', !!code[i]);
      c.classList.toggle('active', i === code.length && document.activeElement === input);
    }
  }

  function paintButton() {
    const ok = lookup && lookup.room && nameInput.value.trim().length > 0;
    submit.disabled = !ok;
  }

  async function check() {
    if (code.length < LEN) {
      lookup = null;
      fill(roomInfo);
      nameField.style.display = 'none';
      paintButton();
      return;
    }
    const mine = ++seq;
    lookup = 'checking';
    fill(
      roomInfo,
      h('div.card.card-tight.row', h('span.spin', { class: 'spin' }), h('span.hint', { text: 'Ищем комнату…' }))
    );
    try {
      const res = await fetch(`/api/room/${encodeURIComponent(code)}`);
      if (mine !== seq) return;
      if (!res.ok) {
        lookup = { error: res.status === 404 ? 'not_found' : 'server' };
        showError();
        return;
      }
      const room = await res.json();
      if (mine !== seq) return;
      lookup = { room };
      showRoom(room);
    } catch {
      if (mine !== seq) return;
      lookup = { error: 'server' };
      showError();
    }
    paintButton();
  }

  function showError() {
    entry.classList.remove('shake');
    void entry.offsetWidth;
    entry.classList.add('shake');
    nameField.style.display = 'none';
    fill(
      roomInfo,
      h(
        'div.card.card-tight',
        { style: { borderColor: 'rgba(255,95,95,.3)' } },
        h(
          'div.row',
          { style: { alignItems: 'flex-start' } },
          h('span', { style: { marginTop: '2px', color: 'var(--danger)' } }, icon('warn')),
          h(
            'div.grow',
            h('div', { style: { fontWeight: '700', color: 'var(--danger)' }, text: 'Комната не найдена' }),
            h('div.hint', {
              style: { marginTop: '2px' },
              text: 'Проверьте код — его видно на экране у того, кто создал игру.',
            })
          )
        )
      )
    );
    paintButton();
  }

  function showRoom(room) {
    const started = room.status !== 'lobby';
    fill(
      roomInfo,
      h(
        'div.card.card-tight',
        { style: { borderColor: 'rgba(46,224,140,.3)' } },
        h(
          'div.row-between',
          h(
            'div',
            h('div', {
              style: { fontWeight: '700' },
              text: `Комната ${room.code}`,
            }),
            h('div.hint', {
              style: { marginTop: '2px' },
              text: [
                room.hostName ? `хост ${room.hostName}` : null,
                `${room.players} ${plural(room.players, 'игрок', 'игрока', 'игроков')}`,
                `блайнды ${fmt(room.settings.smallBlind)}/${fmt(room.settings.bigBlind)}`,
              ]
                .filter(Boolean)
                .join(' · '),
            })
          ),
          h('span.tag-pill', {
            class: started ? 'tag-wait' : 'tag-you',
            text: started ? 'Идёт игра' : 'Лобби',
          })
        ),
        started
          ? h('div.hint', {
              style: { marginTop: '10px', color: 'var(--info)' },
              text: 'Игра уже началась — вы вступите со следующей раздачи.',
            })
          : null
      )
    );
    nameField.style.display = '';
    if (!nameInput.value.trim()) setTimeout(() => nameInput.focus(), 120);
    paintButton();
  }

  function join() {
    const name = nameInput.value.trim();
    if (!lookup?.room || !name) return;
    store.set('chiptable.name', name);
    submit.disabled = true;
    submit.textContent = 'Подключаемся';
    const sent = net.send({ t: 'join', code, name });
    if (!sent) toast('Ждём соединение с сервером…', 'info');
    setTimeout(() => {
      submit.textContent = 'Присоединиться';
      paintButton();
    }, 4000);
  }

  input.addEventListener('focus', paintCells);
  input.addEventListener('blur', paintCells);
  entry.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    input.focus();
  });

  paintCells();
  if (code.length === LEN) check();
  else setTimeout(() => input.focus(), 260);

  return h(
    'div.screen',
    h(
      'header.topbar',
      h('button.icon-btn', { 'aria-label': 'Назад', onclick: () => app.go('home') }, icon('back')),
      h('div.grow', h('div.title', { text: 'Вход по коду' }))
    ),
    h(
      'div.scroll',
      h(
        'div.pad',
        { style: { paddingTop: '26px' } },
        h('p.eyebrow', { style: { textAlign: 'center', marginBottom: '14px' }, text: 'Код комнаты' }),
        entry,
        roomInfo,
        nameField
      )
    ),
    h('div.sticky-foot', submit)
  );
}

export function update() {}
