/** Public static fitting scenes: no net/state import, no hidden cards or fleet. */
import { itemById, itemsOfBundle } from './catalog.js';
import { itemArt } from './art.js';
import { GAMES, gamesOf } from './shop-model.js';
const image = (h, src) => h('img', { src, alt: '', 'aria-hidden': 'true', draggable: 'false' });
function nardySample(h, surface) {
  const row = (side, numbers) => {
    const half = positions => h('div.nd-half', positions.map((n) => {
      const pieces = n === 1 || n === 13
        ? Array.from({ length: 4 }, () => image(h, `/checkers/${n === 1 ? 'w' : 'b'}.svg`))
        : [];
      return h(`span.nd-pt.${side}${n % 2 ? '' : '.b'}`, h('span.nd-no.num', String(n)), h('span.nd-stack', pieces));
    }));
    return h(`div.nd-row.${side}`, half(numbers.slice(0, 6)), h('div.nd-bar'), half(numbers.slice(6)));
  };
  return h('div.col-sample-nardy', { ...surface, 'data-sample': 'nardy', role: 'img', 'aria-label': 'Образец доски нард с шашками' },
    h('div.nd-board',
      row('up', Array.from({ length: 12 }, (_, i) => 12 - i)),
      h('div.nd-mid'),
      row('down', Array.from({ length: 12 }, (_, i) => 13 + i))));
}

function seaSample(h, surface, own) {
  const title = own ? 'Ваше поле · образец' : 'Поле соперника · образец';
  const axis = labels => labels.map(label => h('span', String(label)));
  return h('section.col-block', h('h3.col-cap', title),
    h(`div.col-sample-sea.bs-frame${own ? '.bs-own' : ''}`, { ...surface, 'data-sample': 'battleship', role: 'img', 'aria-label': title },
      h('div.bs-corner'),
      h('div.bs-files', axis([...'АБВГДЕЖЗИК'])),
      h('div.bs-ranks', axis(Array.from({ length: 10 }, (_, i) => i + 1))),
      h('div.bs-grid',
        Array.from({ length: 100 }, (_, i) => h(`span.bs-cell${i === 45 ? '.hit' : i === 64 ? '.miss' : ''}`)),
        own ? h('span.bs-ship.h', { style: { '--x': 2, '--y': 2, '--len': 3 } }) : null)));
}

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
    const surface = { 'data-surface': x.collection, 'data-art': x.id };
    if (['cardback', 'unoq-cardback'].includes(x.slot)) {
      body = h('div.col-sample-hand.surface-felt', game === 'colors' ? surface : null, itemArt(h, x.id, true), itemArt(h, x.id), image(h, game === 'colors' ? '/colors/R5.svg' : '/cards/AS.svg'));
    } else if (x.slot === 'talisman') {
      body = h('div.col-sample-profile', h('span.col-sample-name', itemArt(h, x.id, true), 'Вы'),
        h('span.col-note', 'Талисман видите только вы'));
    } else if (['chess-board', 'checkers-board'].includes(x.slot)) {
      const cells = Array.from({ length: 64 }, (_, i) => {
        const dark = (Math.floor(i / 8) + i % 8) % 2 === 1;
        const pc = game === 'chess' && (i < 16 || i >= 48) ? `${i < 16 ? 'b' : 'w'}${i < 8 || i >= 56 ? 'RNBQKBNR'[i % 8] : 'P'}` : null;
        return h(`span.col-sample-cell${dark ? '.dark' : ''}`, pc ? image(h, `/chess/${pc}.svg`) : game === 'checkers' && dark && (i < 24 || i >= 40) ? h(`i${i < 24 ? '.black' : ''}${i === 17 ? '.king' : ''}`) : null);
      });
      body = h('div.col-sample-chess.ch-frame', { ...surface, 'data-sample': game, role: 'img', 'aria-label': `Образец: ${GAMES.find(([g]) => g === game)[1]}` },
        h('div.ch-ranks', Array.from({ length: 8 }, (_, i) => h('span', String(8 - i)))),
        h('div.col-sample-grid', cells), h('div'),
        h('div.ch-files', [...'abcdefgh'].map(file => h('span', file))));
    } else if (x.slot === 'nardy-board') {
      body = nardySample(h, surface);
    } else if (x.slot === 'battleship-panel') {
      body = h('div.col-block', seaSample(h, surface, true), seaSample(h, surface, false));
    } else if (x.slot === 'table') {
      body = h('div.col-sample.table.surface-felt', { ...surface, 'data-sample': game, role: 'img', 'aria-label': 'Образец общего стола' },
        h('div.col-sample-content', image(h, '/cards/AS.svg'), image(h, '/cards/KH.svg')));
    }
    result.push(h('section.col-block', h('h3.col-cap', x.title), body));
  }
  return result;
}
