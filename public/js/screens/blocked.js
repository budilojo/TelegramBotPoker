import { h, icon } from '../util.js';
import { net } from '../net.js';

/**
 * The same seat is open somewhere else (another tab, another phone).
 * Rather than have the two sessions fight over the socket, this tab stands
 * down and offers to take the seat deliberately.
 */
export function mount(app) {
  return h(
    'div.screen.home.pad',
    h(
      'div.brand',
      { style: { marginTop: '16vh' } },
      h('div.brand-mark', { style: { background: 'var(--card-hi)' } }, icon('users')),
      h('h1', { style: { fontSize: '26px', textAlign: 'center' }, text: 'Игра открыта в другом месте' }),
      h('p.tag', {
        text: 'Ваше место занято другой вкладкой или устройством. Чтобы играть здесь, заберите его.',
      })
    ),
    h(
      'div.stack-v',
      h('button.btn.btn-primary.btn-lg', {
        text: 'Играть на этом устройстве',
        onclick: () => {
          app.ui.blocked = null;
          net.takeOver();
          app.render();
        },
      }),
      h('button.btn.btn-ghost', {
        text: 'Выйти',
        onclick: () => {
          app.ui.blocked = null;
          net.clearSession();
          net.takeOver();
          app.state = null;
          app.nav = 'home';
          app.render();
        },
      })
    )
  );
}

export function update() {}
