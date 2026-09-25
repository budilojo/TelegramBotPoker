import { h, icon } from '../util.js';
import { net } from '../net.js';

/**
 * Shown while a remembered seat is being reclaimed — after a refresh, a lock
 * screen, or a dropped connection. There is always a way out if the room is
 * really gone.
 */
export function mount(app) {
  const escape = h('div', { style: { opacity: '0', transition: 'opacity .4s' } });

  setTimeout(() => {
    escape.style.opacity = '1';
  }, 3500);

  escape.append(
    h('p.hint', {
      style: { textAlign: 'center', marginBottom: '12px' },
      text: 'Не получается вернуться за стол?',
    }),
    h('button.btn.btn-ghost', {
      text: 'Выйти на главную',
      onclick: () => {
        net.clearSession();
        app.state = null;
        app.nav = 'home';
        app.render();
      },
    })
  );

  return h(
    'div.screen.home.pad',
    h(
      'div.brand',
      { style: { marginTop: '18vh' } },
      h('div.brand-mark', icon('chip')),
      h('h1', { style: { fontSize: '24px' }, text: 'Возвращаемся за стол' }),
      h('p.tag', { text: `Комната ${net.session?.code ?? ''} — восстанавливаем ваш стек` }),
      h('div.pulse-dots', { style: { marginTop: '6px' } }, h('i'), h('i'), h('i'))
    ),
    escape
  );
}

export function update() {}
