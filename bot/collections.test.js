'use strict';
/**
 * Коллекция «Графит», сервер: протокол `{t:'col'}`, демосреда, хранение, снимок оформления комнаты.
 *
 *   ЛИЧНОСТЬ — только из подписанного initData (session.user); тело ничего не решает.
 *   ДЕМО — выключено, пока серверная настройка не скажет иное; ничем иным не включается.
 *   СНИМОК — лобби живое, раздача заморожена, следующая пересобирается.
 *   НЕИЗМЕННОСТЬ — оформление не меняет ходы, часы и рейтинг.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Table, user, ALICE, BOB, CAROL, demoOn, col, lastCol, send, grant, apply, clear, req, seatPoker, seatDurak, nextPokerHand } from './collections/testkit.js';
import { App } from './app.js';
import { gameOf } from './games/index.js';
import { Hub } from './hub.js';
import { Store, NullStore } from './store.js';
import { FakeClock, TEST_TOKEN, initDataFor, seededDecks, durakDecks } from './harness.js';
import { ERRORS, PER_MINUTE, REQ_KEEP } from '../miniapp/collections/protocol.js';
import { itemsOfBundle } from './../miniapp/collections/catalog.js';

const CB = 'graphit-cardback';
const TB = 'graphit-table';
const PR = 'graphit-profile';

/* ----------------------------------------------------------- демосреда */

test('по умолчанию демосреда выключена: состояние «недоступно», grant — COL_DEMO_OFF, apply — COL_OFF', async () => {
  const t = new Table();
  assert.equal(t.app.collections.enabled, false);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  assert.equal(col(t, ALICE).length, 0, 'при подключении в рабочем режиме ничего про коллекции не приходит');
  const s = await send(t, ALICE, { op: 'state' });
  assert.deepEqual(s, { t: 'col', op: 'state', v: 1, enabled: false, demo: false, owned: [], choice: { cardback: null, table: null, profile: null }, pending: { cardback: null, table: null, profile: null } });
  assert.equal((await grant(t, ALICE, CB)).error.code, 'COL_DEMO_OFF');
  assert.equal((await apply(t, ALICE, 'cardback', CB, 'sapphire')).error.code, 'COL_OFF');
  assert.equal((await clear(t, ALICE, 'cardback')).error.code, 'COL_OFF');
});

test('демосреду включает только опция процесса строго true; «1», 1, "true", " 1" и прочее — нет', () => {
  for (const v of [undefined, null, false, 0, 1, '1', ' 1', '1 ', 'true', 'yes', '', 'on', {}, [true]]) {
    const app = new App({ api: {}, collectionsDemo: v });
    assert.equal(app.collections.enabled, false, `collectionsDemo=${JSON.stringify(v)}`);
  }
  assert.equal(new App({ api: {}, collectionsDemo: true }).collections.enabled, true);
});

test('bot/index.js читает COLLECTIONS_DEMO только как «ровно 1», один раз, и передаёт опцией в App', () => {
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(src, /const COLLECTIONS_DEMO = process\.env\.COLLECTIONS_DEMO === '1';/);
  assert.match(src, /collectionsDemo: COLLECTIONS_DEMO/);
  assert.equal((src.match(/COLLECTIONS_DEMO/g) || []).length, 3, 'нигде больше переменная не читается');
  const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /^# COLLECTIONS_DEMO=1$/m, 'в образце — закомментировано');
  assert.match(env, /ТОЛЬКО для демонстрационной среды/);
});

test('поля тела demo, unlocked, price, item, admin, host демосреду не включают и права не дают', async () => {
  const t = new Table();
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  const lies = { demo: true, unlocked: true, price: 0, item: CB, enabled: true, admin: true, host: true, cosmeticsUnlocked: true };
  for (const body of [{ op: 'state' }, { op: 'grant', item: CB, req: req() }, { op: 'apply', slot: 'cardback', item: CB, color: 'petrol', req: req() }]) {
    const r = await send(t, ALICE, { ...body, ...lies });
    assert.ok(r.error || r.enabled === false, JSON.stringify(r));
    assert.equal(r.enabled === true, false);
  }
  assert.equal(t.app.collections.enabled, false);
  assert.deepEqual(t.app.store.collDemoItems(ALICE.id), [], 'ничего не выдано');
});

test('права администратора и cosmeticsUnlocked не заменяют демо-право', async () => {
  const t = new Table({ admins: [String(ALICE.id)] });
  t.app.cosmeticsTesters = new Set([String(ALICE.id)]);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  assert.equal(t.app.cosmeticsUnlocked(ALICE.id), true);
  assert.equal((await grant(t, ALICE, CB)).error.code, 'COL_DEMO_OFF');
  demoOn(t);
  assert.deepEqual(t.app.collections.ownedItems(ALICE.id), [], 'админ и тестер без демо-выдачи ничем не владеют');
  assert.equal((await apply(t, ALICE, 'cardback', CB, 'petrol')).error.code, 'COL_NOT_OWNED');
});

test('демо-строки в базе при выключенной демосреде игнорируются: owned пуст, выбор — база, apply закрыт', async () => {
  const store = new Store(':memory:');
  store.collDemoGrant(ALICE.id, CB, 1);
  store.collChoiceSet(ALICE.id, 'cardback', CB, 'petrol', 1);
  const t = new Table({ store });
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  const s = await send(t, ALICE, { op: 'state' });
  assert.equal(s.enabled, false);
  assert.deepEqual(s.owned, []);
  assert.deepEqual(s.choice, { cardback: null, table: null, profile: null });
  assert.equal(t.app.collections.owns(ALICE.id, CB), false);
  assert.deepEqual(t.app.collections.choiceOf(ALICE.id), { cardback: null, table: null, profile: null });
  // Тот же вечер в демосреде видит те же строки — значит, дело именно в настройке, а не в пустой базе.
  demoOn(t);
  assert.equal(t.app.collections.owns(ALICE.id, CB), true);
  assert.equal(t.app.collections.choiceOf(ALICE.id).cardback.color, 'petrol');
  store.close();
});

test('демо-право не становится реальным: после выключения демо снимок и состояние — база', async () => {
  const t = new Table();
  demoOn(t);
  const room = await seatPoker(t);
  await grant(t, ALICE, TB);
  await apply(t, ALICE, 'table', TB, 'bordeaux');
  assert.equal(room.look.table.item, TB);
  t.app.collections.demo = false;
  t.app.draw(room);
  assert.equal(room.look.table, null, 'нет права → база');
  assert.equal(t.state(ALICE).look.table, null);
});

/* ------------------------------------------------------------ протокол */

test('при подключении и переподключении (демо вкл.) приходит своё состояние', async () => {
  const t = new Table();
  demoOn(t);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  const s = lastCol(t, ALICE);
  assert.equal(s.enabled, true);
  assert.equal(s.demo, true);
  assert.deepEqual(s.owned, []);
  await grant(t, ALICE, PR);
  t.close(ALICE);
  t.openHub(ALICE);
  assert.deepEqual(lastCol(t, ALICE).owned, [{ item: PR, demo: true }]);
});

test('grant: предмет, комплект раскладывается на три предмета; повторный req ничего не удваивает', async () => {
  const t = new Table();
  demoOn(t);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  const r = req('bundle');
  const a = await grant(t, ALICE, 'graphit-bundle', r);
  assert.equal(a.op, 'grant');
  assert.deepEqual(a.owned.map((x) => x.item).sort(), [...itemsOfBundle('graphit-bundle')].sort());
  assert.ok(a.owned.every((x) => x.demo === true));
  const b = await grant(t, ALICE, 'graphit-bundle', r);
  assert.deepEqual(b.owned, a.owned);
  assert.equal(t.app.store.collDemoItems(ALICE.id).length, 3);
});

test('отказы словами: каждый код возвращается с текстом из словаря', async () => {
  const t = new Table();
  demoOn(t);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  await grant(t, ALICE, CB);
  const cases = [
    [{ op: 'nonsense' }, 'COL_OP'],
    [{}, 'COL_OP'],
    [{ op: 'grant', item: CB }, 'COL_OP'],                       // нет req
    [{ op: 'grant', item: CB, req: 'коротко' }, 'COL_OP'],
    [{ op: 'grant', item: CB, req: 'a'.repeat(65) }, 'COL_OP'],
    [{ op: 'grant', item: 'nope', req: req() }, 'COL_ITEM'],
    [{ op: 'grant', item: 'graphit', req: req() }, 'COL_ITEM'],  // не по префиксу
    [{ op: 'grant', item: '__proto__', req: req() }, 'COL_ITEM'],
    [{ op: 'apply', slot: 'hat', item: CB, color: 'petrol', req: req() }, 'COL_SLOT'],
    [{ op: 'apply', slot: 'table', item: CB, color: 'petrol', req: req() }, 'COL_SLOT'],
    [{ op: 'apply', slot: 'cardback', item: 'graphit-bundle', color: 'petrol', req: req() }, 'COL_SLOT'],
    [{ op: 'apply', slot: 'cardback', item: 'nope', color: 'petrol', req: req() }, 'COL_ITEM'],
    [{ op: 'apply', slot: 'cardback', item: CB, color: 'red', req: req() }, 'COL_COLOR'],
    [{ op: 'apply', slot: 'cardback', item: CB, req: req() }, 'COL_COLOR'],
    [{ op: 'apply', slot: 'table', item: TB, color: 'petrol', req: req() }, 'COL_NOT_OWNED'],
    [{ op: 'clear', slot: 'hat', req: req() }, 'COL_SLOT'],
    [{ op: 'clear', slot: 'cardback' }, 'COL_OP'],
  ];
  for (const [body, code] of cases) {
    const r = await send(t, ALICE, body);
    assert.equal(r.error?.code, code, JSON.stringify(body));
    assert.equal(r.error.text, ERRORS[code]);
    assert.match(r.error.text, /[а-я]/i, 'словами по-русски');
  }
  assert.deepEqual(t.app.store.collChoices(ALICE.id), [], 'отказы ничего не записали');
});

test('apply и clear: выбор виден в state, when=now в лобби; clear возвращает базу', async () => {
  const t = new Table();
  demoOn(t);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  await grant(t, ALICE, CB);
  const a = await apply(t, ALICE, 'cardback', CB, 'sapphire');
  assert.equal(a.op, 'apply');
  assert.deepEqual(a.choice.cardback, { item: CB, color: 'sapphire' });
  assert.equal(a.when, 'now');
  const b = await apply(t, ALICE, 'cardback', CB, 'petrol'); // переключатель цвета
  assert.equal(b.choice.cardback.color, 'petrol');
  const c = await clear(t, ALICE, 'cardback');
  assert.equal(c.choice.cardback, null);
  assert.equal(c.when, 'now');
});

test('личность — только из initData: userId/uid/owner/name в теле игнорируются; чужой id не задеть', async () => {
  const t = new Table();
  demoOn(t);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  t.openHub(BOB);
  await grant(t, ALICE, CB);
  const forged = { userId: ALICE.id, uid: String(ALICE.id), owner: ALICE.id, name: 'Алиса', user: { id: ALICE.id }, from: ALICE.id, id: ALICE.id };
  // Боб пробует «стать» Алисой: выдача и применение уходят Бобу (и отказываются, как положено Бобу).
  const g = await send(t, BOB, { op: 'grant', item: TB, req: req(), ...forged });
  assert.deepEqual(g.owned.map((x) => x.item), [TB], 'выдано Бобу');
  assert.deepEqual(t.app.store.collDemoItems(ALICE.id), [CB], 'у Алисы не прибавилось');
  const a = await send(t, BOB, { op: 'apply', slot: 'cardback', item: CB, color: 'petrol', req: req(), ...forged });
  assert.equal(a.error.code, 'COL_NOT_OWNED', 'рубашка Алисы Бобу не принадлежит');
  assert.equal(t.app.collections.choiceOf(ALICE.id).cardback, null);
  // У Алисы выбор тоже не появился из-за Боба
  await send(t, BOB, { op: 'clear', slot: 'cardback', req: req(), ...forged });
  assert.deepEqual((await send(t, ALICE, { op: 'state' })).owned.map((x) => x.item), [CB]);
});

test('чужой выбор не виден в ответах: состояние только своё', async () => {
  const t = new Table();
  demoOn(t);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  t.openHub(BOB);
  await grant(t, ALICE, 'graphit-bundle');
  await apply(t, ALICE, 'table', TB, 'bordeaux');
  const b = await send(t, BOB, { op: 'state' });
  assert.deepEqual(b.owned, []);
  assert.deepEqual(b.choice, { cardback: null, table: null, profile: null });
  assert.equal(t.received(BOB).includes('bordeaux'), false);
});

test('сессия администратора получает COL_OP и ничего не меняет', async () => {
  const t = new Table({ admins: [String(ALICE.id)] });
  demoOn(t);
  const r = t.openAdmin(ALICE);
  assert.ok(r.session);
  await t.hub.handle(r.session, { t: 'col', op: 'grant', item: CB, req: req() });
  const reply = t.page(ALICE).inbox.filter((m) => m.t === 'col').at(-1);
  assert.equal(reply.error.code, 'COL_OP');
  assert.deepEqual(t.app.store.collDemoItems(ALICE.id), []);
  assert.equal(t.page(ALICE).inbox.filter((m) => m.t === 'col').length, 1, 'и состояние при подключении админке не шлётся');
});

test('идемпотентность: повтор старого req не откатывает выбор (apply A, apply B, повтор A → остаётся B)', async () => {
  const t = new Table();
  demoOn(t);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  await grant(t, ALICE, CB);
  const r1 = req('first');
  await apply(t, ALICE, 'cardback', CB, 'sapphire', r1);
  await apply(t, ALICE, 'cardback', CB, 'petrol');
  const again = await apply(t, ALICE, 'cardback', CB, 'sapphire', r1);
  assert.equal(again.choice.cardback.color, 'petrol');
  assert.equal(again.error, undefined, 'повтор — не ошибка, а тот же результат');
});

test('идемпотентность: повтор req после перезапуска страницы (база) и ротация — не больше REQ_KEEP', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store });
  demoOn(t);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  for (let i = 0; i < REQ_KEEP + 15; i++) {
    t.clock.now(); // счётчик минуты — отдельно: ниже сдвигаем часы
    store.collReqAdd(ALICE.id, `old-req-${String(i).padStart(4, '0')}`, i, REQ_KEEP);
  }
  const n = store.db.prepare('SELECT COUNT(*) AS n FROM collection_req WHERE user_id = ?').get(String(ALICE.id)).n;
  assert.equal(n, REQ_KEEP);
  assert.equal(store.collReqSeen(ALICE.id, 'old-req-0000'), false, 'самый старый забыт');
  assert.equal(store.collReqSeen(ALICE.id, `old-req-${String(REQ_KEEP + 14).padStart(4, '0')}`), true);
  store.close();
});

test('гонка двух страниц одного игрока: тот же req — один эффект; разные req — по очереди, последний побеждает', async () => {
  const t = new Table();
  demoOn(t);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  // вторая страница того же человека (свой сеанс, тот же initData)
  const inbox2 = [];
  const second = t.hub.open({ initData: initDataFor(ALICE, { startParam: `g_${t.group.code}`, clock: t.clock }) }, (m) => inbox2.push(JSON.parse(JSON.stringify(m))));
  assert.ok(second.session);
  const same = req('same');
  await Promise.all([
    t.hub.handle(t.page(ALICE).session, { t: 'col', op: 'grant', item: 'graphit-bundle', req: same }),
    t.hub.handle(second.session, { t: 'col', op: 'grant', item: 'graphit-bundle', req: same }),
  ]);
  assert.equal(t.app.store.collDemoItems(ALICE.id).length, 3);
  await Promise.all([
    t.hub.handle(t.page(ALICE).session, { t: 'col', op: 'apply', slot: 'cardback', item: CB, color: 'sapphire', req: req('p1') }),
    t.hub.handle(second.session, { t: 'col', op: 'apply', slot: 'cardback', item: CB, color: 'bordeaux', req: req('p2') }),
  ]);
  const rows = t.app.store.collChoices(ALICE.id).filter((r) => r.slot === 'cardback');
  assert.equal(rows.length, 1, 'одна строка на слот');
  assert.equal(rows[0].color, 'bordeaux', 'выиграл тот, кто обработан последним');
  const mine = (await send(t, ALICE, { op: 'state' })).choice.cardback.color;
  assert.equal(mine, 'bordeaux', 'обе страницы видят одно и то же состояние');
});

test('лимит 20 в минуту по часам приложения (не по Date.now); неверные запросы тоже считаются', async () => {
  const t = new Table();
  demoOn(t);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  t.openHub(BOB);
  for (let i = 0; i < PER_MINUTE; i++) {
    const r = await send(t, ALICE, i % 2 ? { op: 'bogus' } : { op: 'state' });
    assert.notEqual(r.error?.code, 'COL_FAST', `запрос ${i + 1}`);
  }
  assert.equal((await send(t, ALICE, { op: 'state' })).error.code, 'COL_FAST');
  assert.equal((await send(t, BOB, { op: 'state' })).enabled, true, 'у другого человека свой счётчик');
  await t.advance(61_000);
  assert.equal((await send(t, ALICE, { op: 'state' })).enabled, true, 'через минуту по часам приложения — снова можно');
});

test('обслуживание: во время паузы запрос не принимается (как у остальных сообщений)', async () => {
  const t = new Table();
  demoOn(t);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  t.app.maintenance = { on: true, text: 'работы', since: 1 };
  await t.send(ALICE, { t: 'col', op: 'grant', item: CB, req: req() });
  assert.deepEqual(t.app.store.collDemoItems(ALICE.id), []);
});

/* ------------------------------------------------------ Store и NullStore */

test('NullStore и Store (SQLite) ведут себя одинаково на одной и той же последовательности', async () => {
  const run = async (store) => {
    const t = new Table({ store });
    demoOn(t);
    await t.cmd(ALICE, '/play');
    t.openHub(ALICE);
    const log = [];
    const keep = (r) => log.push(JSON.parse(JSON.stringify(r)));
    keep(await send(t, ALICE, { op: 'grant', item: CB, req: 'req-parity-0001' }));
    keep(await send(t, ALICE, { op: 'grant', item: CB, req: 'req-parity-0001' }));
    keep(await send(t, ALICE, { op: 'grant', item: 'graphit-bundle', req: 'req-parity-0002' }));
    keep(await send(t, ALICE, { op: 'apply', slot: 'table', item: TB, color: 'petrol', req: 'req-parity-0003' }));
    keep(await send(t, ALICE, { op: 'apply', slot: 'table', item: TB, color: 'sapphire', req: 'req-parity-0004' }));
    keep(await send(t, ALICE, { op: 'apply', slot: 'table', item: TB, color: 'petrol', req: 'req-parity-0003' }));
    keep(await send(t, ALICE, { op: 'apply', slot: 'profile', item: CB, color: 'petrol', req: 'req-parity-0005' }));
    keep(await send(t, ALICE, { op: 'clear', slot: 'table', req: 'req-parity-0006' }));
    keep(await send(t, ALICE, { op: 'apply', slot: 'cardback', item: CB, color: 'bordeaux', req: 'req-parity-0007' }));
    keep(await send(t, ALICE, { op: 'state' }));
    return log;
  };
  const sql = new Store(':memory:');
  const a = await run(new NullStore());
  const b = await run(sql);
  assert.deepEqual(a, b);
  assert.equal(b.at(-1).choice.cardback.color, 'bordeaux');
  assert.equal(b.at(-1).choice.table, null);
  sql.close();
});

test('версия схемы не поднята, три таблицы созданы; их структура — как в контракте', () => {
  const store = new Store(':memory:');
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, '5');
  const cols = (tbl) => store.db.prepare(`PRAGMA table_info(${tbl})`).all().map((c) => c.name).join(',');
  assert.equal(cols('collection_demo_grant'), 'user_id,item,granted_at');
  assert.equal(cols('collection_choice'), 'user_id,slot,item,color,updated_at');
  assert.equal(cols('collection_req'), 'user_id,req,at');
  // Реальных прав нет: такой таблицы не создано.
  const names = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.equal(names.filter((n) => n.startsWith('collection_')).sort().join(), 'collection_choice,collection_demo_grant,collection_req');
  store.close();
});

/* ----------------------------------------------------------- снимок: покер */

test('лобби живое: выбор виден в виде сразу — стол хоста, рубашка и рамка каждого', async () => {
  const t = new Table();
  demoOn(t);
  const room = await seatPoker(t);
  assert.equal(t.state(ALICE).look.table, null);
  await grant(t, ALICE, 'graphit-bundle');
  await grant(t, BOB, CB);
  await grant(t, BOB, TB);
  await apply(t, ALICE, 'table', TB, 'bordeaux');
  await apply(t, ALICE, 'profile', PR, 'sapphire');
  await apply(t, BOB, 'cardback', CB, 'petrol');
  await apply(t, BOB, 'table', TB, 'sapphire'); // стол Боба не хоста — не действует
  const v = t.state(CAROL);
  assert.deepEqual(v.look.table, { item: TB, color: 'bordeaux' }, 'стол — выбор хоста');
  assert.deepEqual(v.look.backs, [{ seat: 1, item: CB, color: 'petrol' }], 'рубашка Боба — по месту, без id');
  assert.equal(v.look.dealNo, 0);
  assert.deepEqual(v.players.find((p) => p.seat === 0).frame, { item: PR, color: 'sapphire' });
  assert.equal(v.players.find((p) => p.seat === 1).frame, null);
  // и в лобби можно передумать
  await apply(t, ALICE, 'table', TB, 'petrol');
  assert.equal(t.state(CAROL).look.table.color, 'petrol');
  assert.equal(room.look.dealNo, 0);
});

test('раздача заморожена: смена выбора хостом и не хостом не меняет look и не трогает ходы', async () => {
  const t = new Table();
  demoOn(t);
  const room = await seatPoker(t);
  await grant(t, ALICE, 'graphit-bundle');
  await grant(t, BOB, 'graphit-bundle');
  await apply(t, ALICE, 'table', TB, 'bordeaux');
  await apply(t, BOB, 'cardback', CB, 'sapphire');
  await t.send(ALICE, { t: 'start' });
  const frozen = JSON.stringify(t.state(CAROL).look);
  assert.equal(t.state(CAROL).look.dealNo, 1);
  const seq = room.seq;
  await apply(t, ALICE, 'table', TB, 'petrol');      // хост
  await apply(t, BOB, 'cardback', CB, 'petrol');     // не хост
  await apply(t, CAROL, 'profile', PR, 'petrol').catch(() => {});
  await grant(t, CAROL, PR);
  const r = await apply(t, CAROL, 'profile', PR, 'petrol');
  assert.equal(JSON.stringify(t.state(CAROL).look), frozen, 'look тот же, что при сдаче');
  assert.equal(JSON.stringify(t.state(ALICE).look), frozen);
  assert.equal(t.state(CAROL).players.find((p) => p.seat === 2).frame, null, 'рамка заморожена тоже');
  assert.equal(r.pending.profile, 'next-deal');
  assert.equal(r.when, 'next-deal');
  assert.equal((await send(t, ALICE, { op: 'state' })).pending.table, 'next-deal');
  assert.equal((await send(t, BOB, { op: 'state' })).pending.cardback, 'next-deal');
  assert.equal(room.seq, seq, 'порядковый номер хода не сдвинулся');
});

test('заморозка переживает переподключение, выход/возврат игрока и перенос хоста', async () => {
  const t = new Table();
  demoOn(t);
  const room = await seatPoker(t);
  await grant(t, ALICE, TB);
  await apply(t, ALICE, 'table', TB, 'bordeaux');
  await t.send(ALICE, { t: 'start' });
  const frozen = JSON.stringify(t.state(BOB).look);
  await grant(t, BOB, TB);
  await apply(t, BOB, 'table', TB, 'petrol');
  // переподключение
  t.close(BOB);
  t.open(BOB);
  assert.equal(JSON.stringify(t.state(BOB).look), frozen);
  // перенос хоста посреди раздачи: стол нового хоста — только со следующей
  await t.send(ALICE, { t: 'host', target: BOB.id, id: BOB.id, playerId: BOB.id, to: BOB.id, userId: BOB.id });
  if (room.hostId !== String(BOB.id)) await t.send(ALICE, { t: 'host', seat: 1 });
  assert.equal(room.hostId, String(BOB.id), 'хост перенесён');
  assert.equal(JSON.stringify(t.state(CAROL).look), frozen, 'снимок не пересобран');
  // выход/возврат
  await t.send(CAROL, { t: 'leave' });
  await t.send(CAROL, { t: 'sit' });
  assert.equal(JSON.stringify(t.state(ALICE).look), frozen);
});

test('следующая раздача пересобирает снимок: новый выбор и стол нового хоста', async () => {
  const t = new Table();
  demoOn(t);
  const room = await seatPoker(t);
  await grant(t, ALICE, 'graphit-bundle');
  await grant(t, BOB, 'graphit-bundle');
  await apply(t, ALICE, 'table', TB, 'bordeaux');
  await t.send(ALICE, { t: 'start' });
  await apply(t, ALICE, 'table', TB, 'sapphire');
  await apply(t, BOB, 'table', TB, 'petrol');
  await apply(t, BOB, 'cardback', CB, 'petrol');
  await t.send(ALICE, { t: 'host', target: BOB.id, to: BOB.id, id: BOB.id });
  if (room.hostId !== String(BOB.id)) await t.send(ALICE, { t: 'host', seat: 1 });
  assert.equal(room.hostId, String(BOB.id));
  assert.equal(t.state(ALICE).look.table.color, 'bordeaux', 'пока раздача идёт — прежнее');
  await nextPokerHand(t);
  const v = t.state(CAROL);
  assert.equal(v.look.dealNo, 2);
  assert.deepEqual(v.look.table, { item: TB, color: 'petrol' }, 'стол нового хоста (Боба)');
  assert.deepEqual(v.look.backs, [{ seat: 1, item: CB, color: 'petrol' }]);
  assert.equal((await send(t, BOB, { op: 'state' })).pending.table, null, 'отложенного больше нет');
});

test('нет права → база: предмет в выборе без владения в снимок не попадает (строка в базе есть, права нет)', async () => {
  const t = new Table();
  demoOn(t);
  await seatPoker(t);
  t.app.store.collChoiceSet(ALICE.id, 'table', TB, 'bordeaux', 1);   // выбор есть, выдачи нет
  t.app.store.collChoiceSet(BOB.id, 'cardback', CB, 'petrol', 1);
  t.app.store.collChoiceSet(BOB.id, 'profile', PR, 'nope-color', 1); // цвета нет в каталоге
  t.app.store.collChoiceSet(CAROL.id, 'profile', CB, 'petrol', 1);   // предмет не того слота
  await t.send(ALICE, { t: 'start' });
  const v = t.state(BOB);
  assert.equal(v.look.table, null);
  assert.deepEqual(v.look.backs, []);
  assert.ok(v.players.every((p) => p.frame === null));
});

test('предмет не для этой игры в снимок не идёт: рубашка в дураке отсутствует', async () => {
  const t = new Table();
  demoOn(t);
  const room = await seatDurak(t);
  await grant(t, ALICE, 'graphit-bundle');
  await apply(t, ALICE, 'cardback', CB, 'petrol');
  await apply(t, ALICE, 'table', TB, 'bordeaux');
  await t.send(ALICE, { t: 'start' });
  const v = t.state(BOB);
  assert.deepEqual(v.look.backs, []);
  assert.deepEqual(v.look.table, { item: TB, color: 'bordeaux' });
  assert.equal(room.look.backs[ALICE.id], undefined);
});

/* ------------------------------------------------------------------ дурак */

test('дурак: лобби живое, партия заморожена, «ещё одна партия» пересобирает', async () => {
  const t = new Table({ durakDeck: durakDecks(3) });
  demoOn(t);
  const room = await seatDurak(t);
  await grant(t, ALICE, 'graphit-bundle');
  await grant(t, BOB, PR);
  await apply(t, ALICE, 'table', TB, 'bordeaux');
  assert.equal(t.state(CAROL).look.table.color, 'bordeaux', 'лобби — сразу');
  await apply(t, BOB, 'profile', PR, 'sapphire');
  await t.send(ALICE, { t: 'start' });
  assert.equal(room.gameNo, 1);
  const frozen = JSON.stringify(t.state(CAROL).look);
  assert.equal(t.state(CAROL).look.dealNo, 1);
  await apply(t, ALICE, 'table', TB, 'petrol');
  await apply(t, BOB, 'profile', PR, 'petrol');
  assert.equal(JSON.stringify(t.state(CAROL).look), frozen, 'партия заморожена');
  assert.deepEqual(t.state(CAROL).players.find((p) => p.seat === 1).frame, { item: PR, color: 'sapphire' });
  assert.equal((await send(t, ALICE, { op: 'state' })).pending.table, 'next-deal');
  // довести партию до конца, не затрагивая правил: прервать её хостом и сдать следующую
  await t.send(ALICE, { t: 'abort' });
  await t.send(BOB, { t: 'next' });
  assert.equal(room.gameNo, 2);
  assert.deepEqual(t.state(CAROL).look.table, { item: TB, color: 'petrol' });
  assert.deepEqual(t.state(CAROL).players.find((p) => p.seat === 1).frame, { item: PR, color: 'petrol' });
  assert.equal(t.state(CAROL).look.dealNo, 2);
});

/* ---------------------------------------------- перезапуск и старые комнаты */

test('перезапуск: снимок комнаты и выбор людей переживают сохранение в базу и загрузку', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store });
  demoOn(t);
  const room = await seatPoker(t);
  await grant(t, ALICE, 'graphit-bundle');
  await grant(t, BOB, CB);
  await apply(t, ALICE, 'table', TB, 'bordeaux');
  await apply(t, ALICE, 'profile', PR, 'sapphire');
  await apply(t, BOB, 'cardback', CB, 'petrol');
  await t.send(ALICE, { t: 'start' });
  await apply(t, ALICE, 'table', TB, 'petrol'); // после сдачи: отложено
  const before = JSON.stringify(t.state(CAROL).look);

  const clock = new FakeClock();
  const app2 = new App({ api: t.tg, store, minIntervalMs: 0, botUsername: 'ChipTableBot', clock, runoutStepMs: 0, miniAppName: 'table', collectionsDemo: true });
  const hub2 = new Hub(app2, { botToken: TEST_TOKEN });
  app2.attachHub(hub2);
  app2.load();
  await app2.resume();
  const room2 = app2.roomByCode(room.code);
  assert.ok(room2);
  const inbox = [];
  const r = hub2.open({ initData: initDataFor(CAROL, { startParam: room.code, clock }) }, (m) => inbox.push(m));
  assert.ok(r.session);
  const st = inbox.filter((m) => m.t === 'state').at(-1).state;
  assert.equal(JSON.stringify(st.look), before, 'снимок после перезапуска — прежний, а не пересобранный');
  assert.equal(st.look.table.color, 'bordeaux');
  const mine = app2.collections.stateOf(ALICE.id);
  assert.deepEqual(mine.choice.table, { item: TB, color: 'petrol' }, 'выбор сохранён');
  assert.equal(mine.pending.table, 'next-deal');
  store.close();
});

test('старые комнаты без поля look читаются как база и не падают; демо выключено — look тоже база', async () => {
  const t = new Table();
  await seatPoker(t);
  await t.send(ALICE, { t: 'start' });
  const room = t.room;
  delete room.look;
  const copy = JSON.parse(JSON.stringify(room));
  assert.ok(!('look' in copy));
  const v = gameOf(room).view(room, BOB.id, { now: t.clock.now(), botUsername: '' });
  assert.deepEqual(v.look, { v: 1, table: null, backs: [], dealNo: 0 });
  for (const p of v.players) assert.equal(p.frame, null);
  // старая комната, загруженная в раздаче, при первой же перерисовке получает базовый снимок
  t.app.draw(room);
  assert.equal(room.look.table, null);
  assert.equal(room.look.dealNo, room.handNo);
  for (const p of t.state(BOB).players) assert.equal(p.frame, null);
  // и сериализация/десериализация поля не требует
  const R = await import('./room.js');
  const back = R.deserialize(JSON.parse(JSON.stringify(R.serialize(room))));
  assert.ok(back.look);
});

/* -------------------------------------- оформление не влияет на правила */

async function playScript(withLook) {
  const t = new Table({ deck: seededDecks(5) });
  if (withLook) demoOn(t);
  await seatPoker(t);
  if (withLook) {
    await grant(t, ALICE, 'graphit-bundle');
    await grant(t, BOB, 'graphit-bundle');
    await apply(t, ALICE, 'table', TB, 'bordeaux');
    await apply(t, ALICE, 'profile', PR, 'sapphire');
    await apply(t, BOB, 'cardback', CB, 'petrol');
    await apply(t, CAROL, 'profile', PR, 'petrol').catch(() => {});
  }
  const cast = { ALICE, BOB, CAROL };
  await t.send(ALICE, { t: 'start' });
  const trace = [];
  const strip = (st) => {
    const s = JSON.parse(JSON.stringify(st));
    delete s.look;
    delete s.room.code; // случайный код стола
    for (const p of s.players) delete p.frame;
    for (const p of s.results?.players ?? s.results ?? []) if (p && typeof p === 'object') delete p.frame;
    return s;
  };
  for (let hand = 0; hand < 2; hand++) {
    trace.push({ turn: t.room.turn, handNo: t.room.handNo });
    await t.runToShowdown(cast);
    trace.push(...[ALICE, BOB, CAROL].map((u) => strip(t.state(u))));
    if (hand === 0) await t.send(ALICE, { t: 'next' });
  }
  trace.push(JSON.parse(JSON.stringify(t.room.players.map((p) => [p.id, p.stack]))));
  trace.push(t.tg.messages.size);
  return { trace, rating: t.app.store.ratingTop?.('poker') ?? [], group: t.text() };
}

test('одна и та же колода с оформлением и без: одни и те же ходы, состояния (кроме look/frame), часы, рейтинг и карточка группы', async () => {
  const plain = await playScript(false);
  const dressed = await playScript(true);
  dressed.trace.forEach((x, i) => assert.deepEqual(x, plain.trace[i], `шаг ${i}`));
  assert.deepEqual(dressed.trace, plain.trace);
  assert.deepEqual(dressed.rating, plain.rating);
  assert.equal(dressed.group, plain.group, 'в карточку группы оформление не попадает');
});

test('карточка группы, итоговое сообщение и чат не содержат оформления', async () => {
  const t = new Table();
  demoOn(t);
  await seatPoker(t);
  await grant(t, ALICE, 'graphit-bundle');
  await apply(t, ALICE, 'table', TB, 'bordeaux');
  await apply(t, ALICE, 'profile', PR, 'sapphire');
  await t.send(ALICE, { t: 'start' });
  await t.send(ALICE, { t: 'finish' });
  const everything = JSON.stringify([...t.tg.messages.values()]);
  for (const needle of ['graphit', 'bordeaux', 'sapphire', 'cardback']) assert.equal(everything.includes(needle), false, needle);
  assert.equal(JSON.stringify(t.pages.get(String(ALICE.id)).inbox.filter((m) => m.t === 'chat')).includes('graphit'), false);
});
