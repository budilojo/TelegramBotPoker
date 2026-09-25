import { h, icon, fmt, store } from '../util.js';
import { net } from '../net.js';
import { toast } from '../ui/overlay.js';

const STACK_PRESETS = [1000, 5000, 10000, 25000];
const BLIND_PRESETS = [
  [10, 20],
  [25, 50],
  [50, 100],
  [100, 200],
];

export function mount(app) {
  const saved = store.get('chiptable.prefs', {});
  const model = {
    name: store.get('chiptable.name', ''),
    stack: saved.stack ?? 10000,
    sb: saved.sb ?? 50,
    bb: saved.bb ?? 100,
  };

  const nameInput = h('input.input', {
    type: 'text',
    value: model.name,
    placeholder: 'Например, Ваня',
    maxlength: 16,
    autocomplete: 'nickname',
    enterkeyhint: 'done',
    oninput: (e) => {
      model.name = e.target.value;
      validate();
    },
  });

  const stackInput = h('input.input.input-num', {
    type: 'text',
    inputmode: 'numeric',
    value: String(model.stack),
    oninput: (e) => {
      const v = e.target.value.replace(/\D/g, '');
      e.target.value = v;
      model.stack = Number(v) || 0;
      syncStackChips();
      validate();
    },
  });

  const sbInput = h('input.input.input-num', {
    type: 'text',
    inputmode: 'numeric',
    value: String(model.sb),
    oninput: (e) => {
      const v = e.target.value.replace(/\D/g, '');
      e.target.value = v;
      model.sb = Number(v) || 0;
      syncBlindChips();
      validate();
    },
  });

  const bbInput = h('input.input.input-num', {
    type: 'text',
    inputmode: 'numeric',
    value: String(model.bb),
    oninput: (e) => {
      const v = e.target.value.replace(/\D/g, '');
      e.target.value = v;
      model.bb = Number(v) || 0;
      syncBlindChips();
      validate();
    },
  });

  const stackChips = STACK_PRESETS.map((v) =>
    h('button.chip-pick', {
      type: 'button',
      text: fmt(v),
      onclick: () => {
        model.stack = v;
        stackInput.value = String(v);
        syncStackChips();
        validate();
      },
    })
  );

  const blindChips = BLIND_PRESETS.map(([sb, bb]) =>
    h('button.chip-pick', {
      type: 'button',
      text: `${fmt(sb)} / ${fmt(bb)}`,
      onclick: () => {
        model.sb = sb;
        model.bb = bb;
        sbInput.value = String(sb);
        bbInput.value = String(bb);
        syncBlindChips();
        validate();
      },
    })
  );

  const syncStackChips = () =>
    stackChips.forEach((c, i) =>
      c.setAttribute('aria-pressed', String(STACK_PRESETS[i] === model.stack))
    );
  const syncBlindChips = () =>
    blindChips.forEach((c, i) =>
      c.setAttribute(
        'aria-pressed',
        String(BLIND_PRESETS[i][0] === model.sb && BLIND_PRESETS[i][1] === model.bb)
      )
    );

  const note = h('p.hint', { style: { marginTop: '10px' } });
  const submit = h('button.btn.btn-primary.btn-lg', {
    text: 'Создать комнату',
    onclick: create,
  });

  function problem() {
    if (!model.name.trim()) return 'Введите своё имя';
    if (model.sb < 1) return 'Small blind должен быть больше нуля';
    if (model.bb < model.sb) return 'Big blind не может быть меньше small blind';
    if (model.stack < model.bb * 5)
      return `Стартовый стек слишком мал — минимум ${fmt(model.bb * 5)}`;
    return null;
  }

  function validate() {
    const p = problem();
    submit.disabled = !!p;
    if (p) {
      note.textContent = p;
      note.style.color = 'var(--warn)';
    } else {
      const bbs = Math.floor(model.stack / model.bb);
      note.textContent = `Стек = ${bbs} больших блайндов. Комфортная игра — от 50 BB.`;
      note.style.color = '';
    }
  }

  function create() {
    if (problem()) return;
    store.set('chiptable.name', model.name.trim());
    store.set('chiptable.prefs', { stack: model.stack, sb: model.sb, bb: model.bb });
    submit.disabled = true;
    submit.textContent = 'Создаём';
    const sent = net.send({
      t: 'create',
      name: model.name.trim(),
      startingStack: model.stack,
      smallBlind: model.sb,
      bigBlind: model.bb,
    });
    if (!sent) toast('Ждём соединение с сервером…', 'info');
    setTimeout(() => {
      submit.disabled = false;
      submit.textContent = 'Создать комнату';
      validate();
    }, 4000);
  }

  syncStackChips();
  syncBlindChips();
  validate();

  return h(
    'div.screen',
    h(
      'header.topbar',
      h('button.icon-btn', { 'aria-label': 'Назад', onclick: () => app.go('home') }, icon('back')),
      h('div.grow', h('div.title', { text: 'Новая комната' }))
    ),
    h(
      'div.scroll',
      h(
        'div.pad',
        { style: { paddingTop: '20px', paddingBottom: '20px' } },
        h(
          'div.stack-v',
          { style: { gap: '22px' } },
          h('label.field', h('span.label', { text: 'Ваше имя' }), nameInput),
          h(
            'div.field',
            h('span.label', { text: 'Стартовый стек' }),
            stackInput,
            h('div.chips-row', { style: { marginTop: '10px' } }, stackChips)
          ),
          h(
            'div.field',
            h('span.label', { text: 'Блайнды' }),
            h(
              'div.row',
              h('div.grow', sbInput),
              h('span', { style: { color: 'var(--muted)', fontWeight: '700' }, text: '/' }),
              h('div.grow', bbInput)
            ),
            h('div.chips-row', { style: { marginTop: '10px' } }, blindChips),
            note
          )
        )
      )
    ),
    h('div.sticky-foot', submit)
  );
}

export function update() {}
