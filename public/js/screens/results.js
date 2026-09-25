import { h, icon, fmt, signed, mount as fill, plural } from '../util.js';
import { net } from '../net.js';
import { openHistory } from '../ui/history.js';

export function mount(app) {
  const list = h('div');
  const stats = h('div.settings-grid', { style: { marginTop: '18px' } });

  const el = h(
    'div.screen',
    h(
      'header.topbar',
      h('div.grow', h('div.title', { text: 'Итоги' })),
      h('button.icon-btn', { 'aria-label': 'История', onclick: () => openHistory(app) }, icon('list'))
    ),
    h(
      'div.scroll',
      h(
        'div.pad',
        h(
          'div.result-hero',
          h('div.gg', { text: 'Game over' }),
          h('h1', { text: 'Итоги игры' })
        ),
        list,
        h('p.eyebrow', { style: { margin: '26px 0 10px' }, text: 'Статистика' }),
        stats,
        h('div', { style: { height: '40px' } })
      )
    ),
    h(
      'div.sticky-foot',
      h('button.btn.btn-primary.btn-lg', {
        text: 'Новая игра',
        onclick: () => {
          net.leave();
          app.state = null;
          app.nav = 'home';
          app.render();
        },
      })
    )
  );

  el._refs = { list, stats };
  return el;
}

export function update(app) {
  const s = app.state;
  if (!s) return;
  const r = app.view._refs;
  const rows = s.results || [];

  fill(
    r.list,
    ...rows.map((p, i) =>
      h(
        'div.rank',
        { class: i === 0 && p.stack > 0 ? 'first' : '', style: { animationDelay: `${i * 45}ms` } },
        h('div.pos', { text: i === 0 && p.stack > 0 ? '★' : String(i + 1) }),
        h(
          'div.grow',
          h(
            'div.nm',
            h('span', { text: p.name }),
            p.role === 'dealer'
              ? h('span.tag-pill', { class: 'tag-wait', text: 'Dealer' })
              : null
          ),
          h('div.sub', {
            text:
              p.role === 'dealer' && p.handsPlayed === 0
                ? 'раздавал карты'
                : `${p.potsWon} ${plural(p.potsWon, 'банк', 'банка', 'банков')} · лучший ${fmt(p.biggestPot)}`,
          })
        ),
        h(
          'div.fin',
          h('div.tot.num', { text: fmt(p.stack) }),
          h('div.net.num', {
            class: p.net > 0 ? 'up' : p.net < 0 ? 'down' : 'flat',
            text: signed(p.net),
          })
        )
      )
    )
  );

  const biggest = rows.reduce((m, p) => Math.max(m, p.biggestPot), 0);
  const totalChips = rows.reduce((sum, p) => sum + p.stack, 0);
  fill(
    r.stats,
    stat('Раздач', String(s.handNo)),
    stat('Крупнейший банк', fmt(biggest)),
    stat('Фишек в игре', fmt(totalChips))
  );
}

function stat(k, v) {
  return h('div.stat-box', h('div.k', { text: k }), h('div.v.num', { text: v }));
}
