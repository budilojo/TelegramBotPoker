/**
 * Примерочная: настоящий вид покерного стола БЕЗ сервера — три игрока, карты, банк, борд, ваш круг.
 * Рубашка, сукно, рамка, звание, реакции и эффект победы — те же, что и за живым столом
 * (`backImg`, стили сукна, `frameOn`, `titleEl`, `winFx`), только данные выдуманные.
 *
 * Почему отдельная лёгкая раскладка, а не `renderTable()` из poker.js: тот целиком живёт на
 * состоянии сервера (`state`, `prev`, `dealOrder`, анимации раздачи) и на живом `#app`; тащить
 * сюда фальшивое состояние значило бы гонять игровой код ради картинки. Здесь — те же классы
 * (`.av`, `.card`, `.plate`-подпись, сукно `--cos-felt`) без дублирования самих вещей.
 *
 *   renderFitting(container, { onBack })   рисует примерочную в `container`; вызывает витрина (L)
 *
 * Обновление вида правит узлы на месте (`replaceChildren` у трёх блоков), а не пересоздаёт экран:
 * прокрутка и фокус остаются (`docs/scroll.md`).
 */
import { h, backImg, cardImg, avatar, fmt } from '../ui.js';
import { getLook, onLook, clearLook } from './look.js';
import { itemById } from './catalog.js';
import { frameOn, titleEl, winFx, fxOff } from './apply.js';
import { tryReaction, face } from '../reactions.js';

const DEMO = [
  { name: 'Макс', hue: 40, stack: 12400 },
  { name: 'Зоя', hue: 260, stack: 8150 },
];

export function renderFitting(container, { onBack } = {}) {
  const stage = h('div.cf-stage');
  const hero = h('div.cf-hero');
  const rx = h('div.cf-rx');
  const note = h('div.cf-note');

  const seat = (p, side) => h(`div.cf-seat.${side}`,
    avatar(p.name, p.hue),
    h('div.cf-mini', backImg(), backImg()),
    h('div.cf-nm', p.name));

  function paint() {
    const look = getLook();
    stage.replaceChildren(
      h('div.cf-felt'),
      seat(DEMO[0], 'l'),
      seat(DEMO[1], 'r'),
      h('div.cf-mid',
        h('div.cf-pot', `Банк ${fmt(2400)}`),
        h('div.cf-board', cardImg('QD'), cardImg('JC'), cardImg('10S'), backImg(), backImg())));
    const me = frameOn(avatar('Вы', 200, '', null));
    me.setAttribute('data-fit-me', '1');
    hero.replaceChildren(
      h('div.cf-cards', cardImg('AS'), cardImg('KH')),
      me,
      h('div.cf-who', h('b', 'Вы'), titleEl(), h('span.cf-stack.num', fmt(15000))));
    const mine = look.reactions.map(itemById).filter(Boolean);
    rx.replaceChildren(...mine.map((x) => h('button.k-btn.k-btn--secondary', {
      type: 'button', 'data-fit-rx': x.id, 'aria-label': `${x.title} (примерка)`,
      onclick: () => tryReaction(x.id, me),
    }, face(x.id))));
    rx.hidden = mine.length === 0;
    const bits = [];
    if (look.effect) bits.push(fxOff() ? 'Эффект победы выключен (меню стола → «Показывать эффекты»).' : 'Нажмите «Сыграть эффект победы».');
    bits.push('Это примерка: другие игроки вашего вида не видят.');
    note.textContent = bits.join(' ');
  }

  const root = h('div.cos-fit',
    h('div.cf-head', h('b', 'Примерочная'), h('button.k-btn.k-btn--secondary', {
      type: 'button', 'data-fit': 'back', onclick: () => (onBack ? onBack() : history.back()),
    }, 'Назад')),
    stage, hero, rx,
    h('div.cf-actions',
      h('button.k-btn.k-btn--secondary', { type: 'button', 'data-fit': 'clear', onclick: () => clearLook() }, 'Снять всё'),
      h('button.k-btn.k-btn--primary', { type: 'button', 'data-fit': 'fx', onclick: () => { winFx({}); } }, 'Сыграть эффект победы')),
    note);
  container.replaceChildren(root);
  paint();
  const off = onLook(() => {
    if (!root.isConnected) return off();
    paint();
  });
  return off;
}
