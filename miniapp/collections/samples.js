/** Public static fitting scenes: no net/state import, no hidden cards or fleet. */
import { itemById, itemsOfBundle } from './catalog.js';
import { itemArt } from './art.js';
import { GAMES, gamesOf } from './shop-model.js';
const image = (h, src) => h('img', { src, alt: '', 'aria-hidden': 'true', draggable: 'false' });
export function fittingSamples(h, id, game) {
  const it = itemById(id), ids = it.kind === 'bundle' ? itemsOfBundle(id) : [id];
  const entries = ids.map(itemById).filter(x => gamesOf(x).includes(game));
  const result = [];
  const frame = entries.find(x => x.slot === 'frame'), badge = entries.find(x => x.slot === 'badge');
  if (frame || badge) result.push(h('section.col-block', h('h3.col-cap', 'Так видят друзья · профиль'),
    h('div.col-sample-profile', h('div.col-sample-avatar', image(h, '/avatars/av01.svg'), frame ? itemArt(h, frame.id, true) : null),
      h('span.col-sample-name', badge ? itemArt(h, badge.id, true) : null, 'Вы'))));
  for (const x of entries.filter(x => !['frame', 'badge'].includes(x.slot))) {
    let body;
    if (['cardback', 'unoq-cardback'].includes(x.slot)) {
      body = h('div.col-sample-hand', itemArt(h, x.id, true), itemArt(h, x.id), image(h, game === 'colors' ? '/colors/R5.svg' : '/cards/AS.svg'));
    } else if (['chess-board', 'checkers-board'].includes(x.slot)) {
      const cells = Array.from({ length: 64 }, (_, i) => {
        const dark = (Math.floor(i / 8) + i % 8) % 2 === 1;
        const pc = game === 'chess' && (i < 16 || i >= 48) ? `${i < 16 ? 'b' : 'w'}${i < 8 || i >= 56 ? 'RNBQKBNR'[i % 8] : 'P'}` : null;
        return h(`span.col-sample-cell${dark ? '.dark' : ''}`, pc ? image(h, `/chess/${pc}.svg`) : game === 'checkers' && dark && (i < 24 || i >= 40) ? h(`i${i < 24 ? '.black' : ''}${i === 17 ? '.king' : ''}`) : null);
      });
      body = h('div.col-sample', { 'data-sample': game, role: 'img', 'aria-label': `Образец: ${GAMES.find(([g]) => g === game)[1]}` },
        h('div.col-sample-content.col-sample-grid', cells), itemArt(h, x.id, true));
    } else if (x.slot === 'nardy-board') {
      body = h('div.col-sample.nardy', { 'data-sample': game, role: 'img', 'aria-label': 'Образец доски нард с шашками и кубиками' },
        h('div.col-sample-content.col-sample-points', Array.from({ length: 24 }, (_, i) => h('span.col-sample-point', [0, 5, 12, 17].includes(i) ? Array.from({ length: 3 }, () => h(i < 12 ? 'i' : 'i.white')) : null))),
        itemArt(h, x.id, true), h('span.col-sample-dice', '⚄ ⚂'));
    } else if (x.slot === 'battleship-panel') {
      body = h('div.col-block', ['Ваше поле · образец', 'Поле соперника · образец'].map((title, side) => h('section.col-block', h('h3.col-cap', title),
        h('div.col-sample.sea', { 'data-sample': game, role: 'img', 'aria-label': title },
          h('div.col-sample-content', Array.from({ length: 100 }, (_, i) => h(`span.col-sea-cell${!side && [22, 23, 24].includes(i) ? '.ship' : ''}`, i === 45 ? '×' : i === 64 ? '•' : ''))), itemArt(h, x.id, true)))));
    } else if (x.slot === 'table') {
      body = h('div.col-sample.table', { 'data-sample': game, role: 'img', 'aria-label': 'Образец общего стола' }, itemArt(h, x.id, true),
        h('div.col-sample-content', image(h, '/cards/AS.svg'), image(h, '/cards/KH.svg')));
    }
    result.push(h('section.col-block', h('h3.col-cap', x.title), body));
  }
  return result;
}
