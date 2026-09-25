import { h, icon } from '../util.js';

export function mount(app) {
  return h(
    'div.screen.home.pad',
    h(
      'div.brand',
      h('div.brand-mark', icon('chip')),
      h('h1', { text: 'Chip Table' }),
      h('p.tag', {
        text: 'Виртуальные фишки для покера настоящими картами. Телефон вместо стопки фишек.',
      })
    ),
    h(
      'div',
      h(
        'div.home-actions',
        h('button.btn.btn-primary.btn-lg', {
          text: 'Создать комнату',
          onclick: () => app.go('create'),
        }),
        h('button.btn.btn-ghost.btn-lg', {
          text: 'Присоединиться',
          onclick: () => app.go('join'),
        })
      ),
      h('p.home-note', {
        html:
          'Карты сдаёте сами, как обычно.<br>Приложение считает только фишки, ставки и банк.',
      })
    )
  );
}

export function update() {}
