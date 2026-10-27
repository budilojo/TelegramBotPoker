/**
 * Клиент коллекций — чистая логика состояния (miniapp/collections/state.js) и охранные проверки исходников.
 * Что проверяется: выдача и выбор только после ответа сервера, защита от двойного нажатия, повтор с тем же req,
 * вход только в демо, «Так видят друзья» только в примерке, art.js без выдумок.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, normalizeState, makeReq } from '../miniapp/collections/state.js';
import { isReq } from '../miniapp/collections/protocol.js';
import { artUrl, ART_KINDS } from '../miniapp/collections/art.js';
import collectionsRow from '../miniapp/collections/settings-row.js';
import { settingsRows } from '../miniapp/settings-rows.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const ST = (over = {}) => ({
  t: 'col', op: 'state', v: 1, enabled: true, demo: true, owned: [],
  choice: { cardback: null, table: null, profile: null }, pending: { cardback: null, table: null, profile: null }, ...over,
});

function rig(initial = ST()) {
  const sent = [];
  const timers = [];
  let reqN = 0;
  let open = true;
  const store = createStore({
    send: (m) => { if (!open) return false; sent.push(m); return true; },
    setTimer: (f, ms) => { timers.push({ f, ms }); return timers.length - 1; },
    clearTimer: (i) => { if (timers[i]) timers[i].dead = true; },
    genReq: () => `req-${String(++reqN).padStart(6, '0')}`,
  });
  if (initial) store.handle(initial);
  return { store, sent, timers, setOpen: (v) => { open = v; }, fireTimer: () => { const t = timers.filter((x) => !x.dead).pop(); t.dead = true; t.f(); } };
}

test('вход виден только когда сервер прислал enabled И demo', () => {
  assert.equal(rig(ST()).store.visible, true);
  assert.equal(rig(ST({ demo: false })).store.visible, false);
  assert.equal(rig(ST({ enabled: false })).store.visible, false);
  assert.equal(rig(null).store.visible, false, 'до первого ответа сервера входа нет');
  // demo без enabled — тоже не вход, а «строка/значения не из списка» не включают ничего
  assert.equal(rig(ST({ enabled: false, demo: true })).store.visible, false);
  assert.equal(rig(ST({ demo: 'true' })).store.visible, false);
  assert.equal(rig(ST({ demo: 1 })).store.visible, false);
});

test('вне демо ни выдача, ни выбор, ни очистка не уходят на сервер', () => {
  const { store, sent } = rig(ST({ demo: false, owned: [{ item: 'graphit-table', demo: true }] }));
  assert.equal(store.grant('graphit-cardback'), false);
  assert.equal(store.apply('table', 'graphit-table', 'sapphire'), false);
  assert.equal(store.clear('table'), false);
  assert.deepEqual(sent, []);
});

test('выдача: пока нет ответа сервера владения нет; после ответа — есть', () => {
  const { store, sent } = rig();
  assert.equal(store.grant('graphit-cardback'), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, 'grant');
  assert.ok(isReq(sent[0].req));
  let snap = store.snapshot();
  assert.deepEqual(snap.owned, [], 'до ответа предмет не выдан');
  assert.equal(snap.busy.op, 'grant');
  store.handle(ST({ op: 'grant', owned: [{ item: 'graphit-cardback', demo: true }] }));
  snap = store.snapshot();
  assert.deepEqual(snap.owned, ['graphit-cardback']);
  assert.equal(snap.busy, null);
});

test('ответ op:state на grant тоже засчитывается, если в нём виден результат', () => {
  const { store } = rig();
  store.grant('graphit-table');
  store.handle(ST({ owned: [{ item: 'graphit-table', demo: true }] }));
  assert.equal(store.snapshot().busy, null);
  assert.deepEqual(store.snapshot().owned, ['graphit-table']);
});

test('двойное нажатие: второй запрос не уходит, пока первый не ответил', () => {
  const { store, sent } = rig();
  assert.equal(store.grant('graphit-cardback'), true);
  assert.equal(store.grant('graphit-cardback'), false);
  assert.equal(store.grant('graphit-table'), false);
  assert.equal(store.clear('table'), false);
  assert.equal(sent.length, 1);
});

test('уже в коллекции: повторная выдача невозможна', () => {
  const { store, sent } = rig(ST({ owned: [{ item: 'graphit-cardback', demo: true }] }));
  assert.equal(store.grant('graphit-cardback'), false);
  assert.equal(sent.length, 0);
});

test('комплект: частично полученный не выдаётся одной кнопкой (правило цены не утверждено)', () => {
  const { store, sent } = rig(ST({ owned: [{ item: 'graphit-table', demo: true }] }));
  assert.equal(store.ownedSome('graphit-bundle'), true);
  assert.equal(store.own('graphit-bundle'), false);
  assert.deepEqual(store.missing('graphit-bundle'), ['graphit-cardback', 'graphit-profile']);
  assert.equal(store.grant('graphit-bundle'), false);
  assert.equal(sent.length, 0);
  // пустая коллекция — комплект выдаётся
  const r = rig();
  assert.equal(r.store.grant('graphit-bundle'), true);
  assert.equal(r.sent[0].item, 'graphit-bundle');
});

test('выбор: до ответа прежний выбор; после — новый; ответ с отказом оставляет прежний', () => {
  const owned = [{ item: 'graphit-cardback', demo: true }];
  const { store, sent } = rig(ST({ owned, choice: { cardback: { item: 'graphit-cardback', color: 'graphite' }, table: null, profile: null } }));
  assert.equal(store.apply('cardback', 'graphit-cardback', 'sapphire'), true);
  assert.equal(store.snapshot().choice.cardback.color, 'graphite', 'до ответа — прежний цвет');
  store.handle({ t: 'col', op: 'apply', error: { code: 'COL_COLOR', text: 'Такого цвета нет.' } });
  let snap = store.snapshot();
  assert.equal(snap.choice.cardback.color, 'graphite');
  assert.equal(snap.error.text, 'Такого цвета нет.');
  assert.equal(snap.error.again, true);
  assert.equal(snap.busy, null);
  // после явного отказа повтор идёт с НОВЫМ req
  const firstReq = sent[0].req;
  assert.equal(store.retry(), true);
  assert.notEqual(sent[1].req, firstReq);
  store.handle(ST({ op: 'apply', when: 'next-deal', owned, choice: { cardback: { item: 'graphit-cardback', color: 'sapphire' }, table: null, profile: null }, pending: { cardback: 'next-deal', table: null, profile: null } }));
  snap = store.snapshot();
  assert.equal(snap.choice.cardback.color, 'sapphire');
  assert.equal(snap.pending.cardback, 'next-deal');
  assert.equal(snap.when.cardback, 'next-deal');
  assert.equal(snap.error, null);
});

test('нет ответа: прежний вид, ошибка словами, повтор с ТЕМ ЖЕ req', () => {
  const { store, sent, fireTimer } = rig();
  store.grant('graphit-profile');
  fireTimer();
  const snap = store.snapshot();
  assert.deepEqual(snap.owned, [], 'владение не выдаётся без ответа');
  assert.match(snap.error.text, /не ответил/);
  assert.equal(store.retry(), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].req, sent[0].req, 'тот же req — сервер не удвоит');
  assert.equal(sent[1].op, 'grant');
});

test('нет связи при отправке: ничего не выдано, «Повторить» шлёт тот же запрос', () => {
  const { store, sent, setOpen } = rig();
  setOpen(false);
  assert.equal(store.grant('graphit-cardback'), false);
  assert.equal(store.snapshot().error.code, 'OFFLINE');
  assert.deepEqual(store.snapshot().owned, []);
  setOpen(true);
  assert.equal(store.retry(), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, 'grant');
});

test('разрыв связи: показанное прежнее остаётся, действия закрыты; владение не выдаётся', () => {
  const { store, sent } = rig(ST({ owned: [{ item: 'graphit-cardback', demo: true }] }));
  store.connection(false);
  const snap = store.snapshot();
  assert.equal(snap.link, 'offline');
  assert.deepEqual(snap.owned, ['graphit-cardback']);
  assert.equal(store.apply('cardback', 'graphit-cardback', 'petrol'), false);
  assert.equal(sent.length, 0);
  store.connection(true);
  assert.equal(store.apply('cardback', 'graphit-cardback', 'petrol'), true);
});

test('загрузка: до первого ответа link=loading; запрос state один раз за соединение', () => {
  const { store, sent } = rig(null);
  assert.equal(store.snapshot().link, 'loading');
  store.ensureState();
  store.ensureState();
  assert.equal(sent.filter((m) => m.op === 'state').length, 1);
  store.connection(false);
  store.connection(true);
  store.ensureState();
  assert.equal(sent.filter((m) => m.op === 'state').length, 2);
});

test('чужие и кривые данные отбрасываются: неизвестный предмет, цвет, слот', () => {
  const s = normalizeState({ enabled: true, demo: true, owned: [{ item: 'evil' }, { item: '__proto__' }, { item: 'graphit-bundle' }, { item: 'graphit-table' }],
    choice: { cardback: { item: 'graphit-table', color: 'sapphire' }, table: { item: 'graphit-table', color: 'pink' }, profile: { item: 'graphit-profile', color: 'petrol' } },
    pending: { cardback: 'later', table: 'next-deal' } });
  assert.deepEqual(s.owned.map((o) => o.item), ['graphit-table']);
  assert.equal(s.choice.cardback, null, 'предмет не из этого слота');
  assert.equal(s.choice.table, null, 'неизвестный цвет');
  assert.deepEqual(s.choice.profile, { item: 'graphit-profile', color: 'petrol' });
  assert.equal(s.pending.cardback, null);
  assert.equal(s.pending.table, 'next-deal');
  assert.equal(normalizeState(null).enabled, false);
});

test('сервер выключил коллекции — вход пропал', () => {
  const { store } = rig();
  assert.equal(store.visible, true);
  store.handle(ST({ enabled: false, demo: false }));
  assert.equal(store.visible, false);
});

test('makeReq даёт допустимый идентификатор', () => {
  for (let i = 0; i < 50; i++) assert.ok(isReq(makeReq()));
});

test('запрос уходит без чужих полей: только t, op, req, item/slot/color', () => {
  const { store, sent } = rig(ST({ owned: [{ item: 'graphit-table', demo: true }] }));
  store.apply('table', 'graphit-table', 'bordeaux');
  assert.deepEqual(Object.keys(sent[0]).sort(), ['color', 'item', 'op', 'req', 'slot', 't']);
});

/* ------------------------------------------------------------ art.js */

test('art.js: адреса только из списка и цветов каталога; чужого пути не бывает', () => {
  assert.equal(artUrl('cardback', 'sapphire', true), '/collections/art/cardback-detail-sapphire.svg');
  assert.equal(artUrl('cardback', 'petrol', false), '/collections/art/cardback-small-petrol.svg');
  assert.equal(artUrl('table', 'graphite', true), '/collections/art/table-ornament-graphite.svg');
  assert.equal(artUrl('mark', 'bordeaux'), '/collections/art/mark-bordeaux.svg');
  assert.equal(artUrl('cardback', '../../x'), null);
  assert.equal(artUrl('../x', 'petrol'), null);
  assert.equal(artUrl('cardback', 'pink'), null);
  assert.equal(artUrl('constructor', 'petrol'), null);
  assert.ok(ART_KINDS.length >= 8);
});

/* ------------------------------------------- охранные проверки исходников */

const COL_FILES = ['index', 'state', 'art', 'showcase', 'item', 'fitting', 'inventory', 'receive', 'settings-row'].map((n) => `miniapp/collections/${n}.js`);

test('«Так видят друзья» есть ТОЛЬКО в примерке', () => {
  for (const f of COL_FILES) {
    if (f.endsWith('/fitting.js')) continue;
    assert.ok(!read(f).includes('Так видят друзья'), `${f}: блок «Так видят друзья» вне примерки`);
  }
  assert.ok(read('miniapp/collections/fitting.js').includes('Так видят друзья'));
  for (const f of ['miniapp/games/poker.js', 'miniapp/games/durak.js', 'miniapp/ui.js', 'miniapp/app.js', 'miniapp/nav.js']) {
    assert.ok(!read(f).includes('Так видят друзья'), `${f}: блок в игре`);
  }
});

test('демо включает только ответ сервера: ни URL, ни localStorage, ни Telegram-данные в коде коллекций', () => {
  for (const f of COL_FILES) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/localStorage|sessionStorage|location\.(search|hash)|URLSearchParams|initDataUnsafe|start_param/.test(src), `${f}: демо/доступ из постороннего источника`);
    assert.ok(!/Date\.now\(\)/.test(src) || f.endsWith('index.js'), `${f}: время страницы`);
  }
});

test('нет выдуманной оплаты: ни «Купить», ни «Оплачено», ни «Успешная оплата» в экранах', () => {
  for (const f of COL_FILES) {
    const src = read(f);
    assert.ok(!/Купить|Оплачено|Оплата прошла|Успешная оплата|Спасибо за покупку/.test(src), `${f}: фиктивная оплата`);
  }
});

test('рубашки дурака не обещаются', () => {
  for (const f of COL_FILES) {
    const src = read(f);
    const bad = src.split('\n').filter((l) => /рубашк/i.test(l) && /дурак/i.test(l));
    assert.deepEqual(bad, [], `${f}: рубашка рядом с дураком`);
  }
});

test('строка «Настроек»: вне демо — null, и реестр её пропускает', () => {
  assert.equal(collectionsRow({}), null);
  assert.deepEqual(settingsRows({}, [collectionsRow]), []);
});

test('выделение цвета: не синее и не единственный признак (контур нейтральный + галочка)', () => {
  const css = read('miniapp/collections.css');
  const block = css.match(/\.col-sw\[aria-checked="true"\][^{]*\{[^}]*\}/g)?.join('\n') || '';
  assert.ok(block, 'нет правила выбранного цвета');
  assert.ok(/var\(--text-primary\)/.test(block), 'контур выбранного — светлый нейтральный токен');
  assert.ok(!/sapphire|#15263e|#a6b5c8|blue|#00|#2c6fd1|var\(--chip-3\)/i.test(block), 'контур выбранного не синий');
  const js = read('miniapp/collections/item.js');
  assert.ok(/col-check/.test(js), 'у выбранного есть галочка в разметке');
});
