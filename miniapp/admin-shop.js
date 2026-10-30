/**
 * Пульт владельца, вкладка «Магазин»: готовность к продаже, цены, скрыть/показать, выдать/забрать, заказы и возврат.
 *
 * Страница ничего не решает: каждое нажатие — просьба `{ t:'ashop', op, … }`, которую сервер сверяет с подписанным
 * initData и списком ADMINS. Цена и возврат — двумя шагами: сервер сам присылает «было → стало» с кодом, и только
 * «Подтвердить» с этим кодом что-то меняет. Тексты — MESSAGES.md, «Магазин в админке».
 */
import { h, fmt, haptic, toast, showSheet, closeSheet } from './ui.js';
import { bus, send } from './net.js';

/** Что набрано и найдено на вкладке: живёт между перерисовками, новые цифры его не стирают. */
const ui = { who: '', user: null, found: null, oq: '', orders: null, price: {} };

const stars = (n) => (n == null ? 'нет цены' : `${fmt(n)} ⭐`);
const newReq = () => `adm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const ask = (op, body = {}) => { haptic.tap(); send({ t: 'ashop', op, ...body }, { lock: false }); };
const act = (op, body = {}) => { haptic.tap(); send({ t: 'ashop', op, req: newReq(), ...body }); };

const SOURCE = { purchase: 'куплено', admin: 'выдано вами', staff: 'доступ тестера', demo: 'демо' };
const ORDER = {
  paid: 'оплачен', refunded: 'возвращён', refund_pending: 'возврат в обработке', review: 'на проверке',
  created: 'счёт не оплачен', approved: 'оплата идёт', cancelled: 'отменён',
};
const EVENT = {
  price: 'цена', approve: 'утверждение цен', hide: 'скрыта', show: 'показана', grant: 'выдано', revoke: 'забрано',
  'sales-stop': 'продажи остановлены', 'sales-resume': 'остановка снята', refund: 'возврат', 'refund-no': 'возврат не прошёл',
};

const when = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/* ---------------------------------------------------------- ответы сервера */

bus.onAdminShop = (msg) => {
  if (msg.error) {
    toast(msg.error.text || 'Не получилось', 3600);
    return;
  }
  if (msg.op === 'ask') return confirmAsk(msg.ask);
  if (msg.op === 'user') {
    ui.user = msg.user ?? null;
    ui.found = msg.found ?? null;
  }
  if (msg.op === 'orders') ui.orders = Array.isArray(msg.orders) ? msg.orders : [];
  if (msg.user) ui.user = msg.user;
  if (msg.text) toast(msg.text, 3600);
  // Возврат прошёл — найденный список заказов перечитать, чтобы в нём было новое состояние.
  if (msg.op === 'refundConfirm' && ui.orders) ask('orders', { q: ui.oq });
  bus.render();
};

/** Второй шаг: сервер сказал, что именно произойдёт, и дал код. Без «Подтвердить» ничего не меняется. */
function confirmAsk(a) {
  if (!a?.code) return;
  const refund = a.kind === 'refund';
  const title = refund ? 'Вернуть звёзды?' : a.kind === 'approve' ? (a.on ? 'Утвердить цены?' : 'Снять утверждение?') : 'Сменить цену?';
  showSheet('ashop-ask', () => h('div',
    h('h3', title),
    h('div.hint', a.text),
    h('div.sheet-row',
      h('button.btn.wide', { onclick: () => closeSheet() }, 'Отмена'),
      h(`button.btn.primary.wide${refund ? '.danger' : ''}`, {
        'data-act': 'ashop-confirm',
        onclick: () => {
          closeSheet();
          if (refund) act('refundConfirm', { order: a.order, code: a.code });
          else act('confirm', { code: a.code });
        },
      }, refund ? `Вернуть ${fmt(a.amount)} ⭐` : 'Подтвердить'))));
}

/* -------------------------------------------------------------- вкладка */

export function shopTab(s) {
  const v = s.shop;
  if (!v) return h('div.hint', 'Магазин на этом сервере не подключён.');
  return h('div.ashop',
    readiness(v),
    h('div.section-label', 'Вещи и цены'),
    h('div.box', v.items.map(itemRow)),
    h('div.hint', 'Цена меняется для новых заказов. Уже выставленный счёт со старой ценой Telegram не даст оплатить — человек откроет вещь заново. ' +
      '«Скрыть» убирает вещь из продажи; купленное и выданное остаётся у людей.'),
    giveBox(v),
    ordersBox(v),
    logBox(v));
}

function readiness(v) {
  const head = v.open ? (v.mode === 'test' ? '🛒 Продажи открыты — тестовая среда' : '🛒 Продажи открыты') : '🛒 Продажи закрыты';
  return h('div',
    h('div.section-label', 'Готовность к продаже'),
    h('div.box',
      h('div.tool-head', head),
      h('div.tool-line', h('span', 'Режим'), h('b', v.mode)),
      h('div.tool-line', h('span', 'Цены утверждены'), h('b', v.approved ? 'да' : 'нет')),
      h('div.tool-line', h('span', 'Оплата идёт / на проверке / возвратов'), h('b.num', `${fmt(v.inFlight)} / ${fmt(v.review)} / ${fmt(v.refunds)}`)),
      v.reasons.length
        ? h('ul.ashop-reasons', { 'aria-label': 'Чего не хватает' }, v.reasons.map((r) => h('li', r)))
        : h('div.hint', 'Все условия выполнены.'),
      v.stopped
        ? h('button.btn.primary.wide', { 'data-act': 'ashop-resume', onclick: () => act('sales', { stop: false }) }, '▶️ Возобновить продажи')
        : h('button.btn.wide.danger', { 'data-act': 'ashop-stop', onclick: confirmStop }, '⏹ Остановить новые продажи'),
      h('button.btn.wide', { 'data-act': 'ashop-approve', onclick: () => ask('approve', { on: !v.approved }) },
        v.approved ? 'Снять утверждение цен' : 'Утвердить цены')),
    h('div.hint', 'Утверждение цен — только одно из условий. Режим, документы и поддержка задаются на сервере; ' +
      'пока причины выше не исчезнут, никто ничего купить не сможет.'));
}

function confirmStop() {
  haptic.tap();
  showSheet('ashop-stop', () => h('div',
    h('h3', 'Остановить новые продажи?'),
    h('div.hint', 'Новые счета перестанут выставляться. Уже оплаченное выдаётся, возвраты и сверка работают. То же, что /salesstop.'),
    h('div.sheet-row',
      h('button.btn.wide', { onclick: () => closeSheet() }, 'Нет'),
      h('button.btn.primary.wide.danger', { onclick: () => { closeSheet(); act('sales', { stop: true }); } }, 'Остановить'))));
}

function itemRow(it) {
  const draft = ui.price[it.id] ?? '';
  const state = it.hidden ? 'скрыта' : it.price == null ? 'нет цены' : it.sells ? 'продаётся' : 'не продаётся, пока закрыто';
  const input = h('input.inp.ashop-price', {
    type: 'number', inputmode: 'numeric', min: '1', max: '10000', step: '1', placeholder: it.price == null ? 'Цена' : String(it.price),
    value: draft, 'aria-label': `Новая цена: ${it.title}`,
    oninput: (e) => { ui.price[it.id] = e.target.value; },
  });
  return h('div.ashop-item', { 'data-item': it.id },
    h('div.gr-head',
      h('span.gr-name', it.title),
      h('span.gr-n.num', stars(it.price))),
    h('div.ashop-meta', `${state}${it.base != null && it.base !== it.price ? ` · по умолчанию ${stars(it.base)}` : ''}`),
    h('div.ashop-row',
      input,
      h('button.btn', {
        'data-act': 'ashop-price',
        onclick: () => {
          const n = Number(ui.price[it.id]);
          if (!Number.isInteger(n)) return toast('Введите цену — целое число звёзд');
          ask('price', { item: it.id, price: n });
        },
      }, 'Цена'),
      h('button.btn', { 'data-act': it.hidden ? 'ashop-show' : 'ashop-hide', onclick: () => act('hide', { item: it.id, hidden: !it.hidden }) },
        it.hidden ? 'Показать' : 'Скрыть')));
}

/* ------------------------------------------------------- выдать / забрать */

function giveBox(v) {
  const input = h('input.inp', {
    placeholder: 'Telegram id или ник', value: ui.who, 'aria-label': 'Кому: Telegram id или ник',
    oninput: (e) => { ui.who = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') find(); },
  });
  const u = ui.user;
  return h('div',
    h('div.section-label', 'Выдать или забрать'),
    h('div.box',
      h('div.ashop-row', input, h('button.btn', { 'data-act': 'ashop-find', onclick: find }, 'Найти')),
      ui.found
        ? (ui.found.length
          ? h('div.ashop-found', ui.found.map((f) => h('button.btn', { onclick: () => { ui.who = f.id; ask('user', { q: f.id }); } }, `${f.nick} · ${f.id}`)))
          : h('div.hint', 'По этому нику никого нет. Ник — из профиля игрока; можно ввести Telegram id.'))
        : null,
      u ? userCard(u, v) : null),
    h('div.hint', 'Выдача — подарок от администратора: не покупка, звёзд не списывает, в «Мои покупки» игрок видит её с пометкой. ' +
      '«Забрать» снимает только вашу выдачу: купленное остаётся, вернуть покупку — возвратом ниже.'));
}

function find() {
  const q = ui.who.trim();
  if (!q) return toast('Введите Telegram id или ник');
  ui.user = null;
  ask('user', { q });
}

function userCard(u, v) {
  const have = new Map(u.items.map((x) => [x.item, x.source]));
  return h('div.ashop-user', { 'data-user': u.id },
    h('div.tool-head', u.nick ? `${u.nick} · ${u.id}` : `id ${u.id}`),
    v.items.map((it) => {
      const parts = it.kind === 'bundle' ? null : have.get(it.id);
      // «Забрать» — только там, где есть ваша выдача (у комплекта — хотя бы у одной его вещи).
      const mine = it.kind === 'bundle' ? v.items.some((x) => x.kind !== 'bundle' && have.get(x.id)?.includes('admin')) : !!parts?.includes('admin');
      return h('div.ashop-give', { 'data-item': it.id },
        h('div',
          h('div.gr-name', it.title),
          h('div.ashop-meta', it.kind === 'bundle' ? 'все три вещи' : parts ? parts.map((x) => SOURCE[x] || x).join(', ') : 'нет')),
        h('div.ashop-row',
          h('button.btn.primary', { 'data-act': 'ashop-grant', onclick: () => act('grant', { user: u.id, item: it.id }) }, 'Выдать'),
          mine
            ? h('button.btn.danger', { 'data-act': 'ashop-revoke', onclick: () => confirmRevoke(u, it) }, 'Забрать')
            : null));
    }),
    u.orders?.length ? h('div.ashop-meta', `Заказов: ${fmt(u.orders.length)} — в списке заказов по id ${u.id}`) : null);
}

function confirmRevoke(u, it) {
  haptic.tap();
  showSheet('ashop-revoke', () => h('div',
    h('h3', 'Забрать выданное?'),
    h('div.sub', `${it.title} · ${u.nick ? `${u.nick} · ` : ''}${u.id}`),
    h('div.hint', 'Снимется только ваша выдача. Если человек вещь купил, она останется у него. Надетое снимется, только если права не осталось совсем.'),
    h('div.sheet-row',
      h('button.btn.wide', { onclick: () => closeSheet() }, 'Нет'),
      h('button.btn.primary.wide.danger', { onclick: () => { closeSheet(); act('revoke', { user: u.id, item: it.id }); } }, 'Забрать'))));
}

/* ----------------------------------------------------- заказы и журнал */

function ordersBox(v) {
  const list = ui.orders ?? v.orders;
  const input = h('input.inp', {
    placeholder: 'id игрока или номер заказа', value: ui.oq, 'aria-label': 'Поиск заказа',
    oninput: (e) => { ui.oq = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') ask('orders', { q: ui.oq.trim() }); },
  });
  return h('div',
    h('div.section-label', ui.orders ? 'Заказы — найдено' : 'Последние заказы'),
    h('div.box',
      h('div.ashop-row', input, h('button.btn', { 'data-act': 'ashop-orders', onclick: () => ask('orders', { q: ui.oq.trim() }) }, 'Найти')),
      list.length ? list.map(orderRow) : h('div.hint', 'Заказов нет.')),
    h('div.hint', 'Возврат — тем же путём, что /refund в боте: сначала сервер покажет сумму и код, деньги уходят только после «Вернуть». Второй раз вернуть нельзя.'));
}

const orderRow = (o) => h('div.ashop-order', { 'data-order': o.id },
  h('div.gr-head', h('span.gr-name', o.title), h('span.gr-n.num', stars(o.price))),
  h('div.ashop-meta.num', `${o.id} · id ${o.userId} · ${when(o.at)}${o.test ? ' · тест' : ''}`),
  h('div.ashop-row',
    h('span.ashop-state', ORDER[o.state] || o.state),
    o.state === 'paid' || o.state === 'refund_pending' || o.state === 'review'
      ? h('button.btn.danger', { 'data-act': 'ashop-refund', onclick: () => ask('refund', { order: o.id }) }, 'Возврат')
      : null));

function logBox(v) {
  if (!v.log?.length) return null;
  return h('div',
    h('div.section-label', 'Журнал магазина'),
    h('div.box', v.log.map((l) => h('div.ashop-log',
      h('span.num', when(l.at)),
      h('span', [EVENT[l.event] || l.event, l.item, l.userId ? `id ${l.userId}` : null,
        l.before != null || l.after != null ? `${l.before ?? '—'} → ${l.after ?? '—'}` : null].filter(Boolean).join(' · ')),
      h('span.ashop-meta', `кто: ${l.by}`)))));
}
