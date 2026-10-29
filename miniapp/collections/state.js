/**
 * Состояние клиента коллекций — чистая логика (без DOM; проверяется в Node).
 * Контракт: docs/graphit-launch/contracts.md, разделы 2 и 8.
 *
 * Правила, которые здесь держатся:
 *  • владение и выбор — только то, что сообщил сервер (`server`); ничего не «предполагается» локально;
 *  • одновременно в пути один запрос: второй нажим не уходит (защита от двойного нажатия);
 *  • успех — только после ответа сервера; до ответа «прежний вид» (server не меняется);
 *  • повтор после «нет ответа» идёт с тем же `req` (сервер не удвоит), после явного отказа — с новым;
 *  • вход (`visible`) — только когда сервер прислал enabled && demo; никаких других источников.
 */
import { COLORS, DEFAULT_COLOR, ITEMS, SLOTS, itemById, itemsOfBundle, missingForBundle, isColor } from './catalog.js';
import { ERRORS, isReq } from './protocol.js';

/** Подпись демонстрации: строка «Настроек», витрина, получение. */
export const DEMO_NOTE = 'Демонстрация · Без оплаты';

/** Сколько ждать ответа сервера, мс (по часам страницы; отсчёт — в `deps.setTimer`). */
export const ANSWER_MS = 8000;

const NONE = () => ({ cardback: null, table: null, profile: null });
const empty = () => ({ enabled: false, demo: false, owned: [], choice: NONE(), pending: NONE(), shop: null });

/** Подпись режима: демо, тестовая среда, продажи, закрыто. Для строки «Настроек» и витрины. */
export const SHOP_NOTE = {
  test: 'Тестовая среда · звёзды ненастоящие',
  open: 'Оформление за Stars · без игровых преимуществ',
  closed: 'Ваши вещи · покупки пока закрыты',
};
export const noteOf = (snap) => (snap.demo ? DEMO_NOTE : !snap.shop ? '' : snap.shop.test ? SHOP_NOTE.test : snap.shop.open ? SHOP_NOTE.open : SHOP_NOTE.closed);

/** Магазин из `state` (только без демо): открыт ли, цены — числа сервера; всё прочее отбрасывается. */
function normalizeShop(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const offers = {};
  for (const it of ITEMS) {
    const p = raw.offers?.[it.id]?.price;
    offers[it.id] = { price: Number.isInteger(p) && p > 0 ? p : null };
  }
  return { open: raw.open === true, test: raw.open === true && raw.test === true, terms: typeof raw.terms === 'string' ? raw.terms.slice(0, 40) : '', support: raw.support === true, offers };
}

/** Привести пришедшее `state` к безопасной форме; лишнее и неверное отбрасывается. */
export function normalizeState(msg) {
  const out = empty();
  if (!msg || typeof msg !== 'object') return out;
  out.enabled = msg.enabled === true;
  out.demo = msg.enabled === true && msg.demo === true;
  if (Array.isArray(msg.owned)) {
    for (const o of msg.owned) {
      const id = typeof o === 'string' ? o : o?.item;
      const it = itemById(id);
      if (it && it.kind === 'item' && !out.owned.some((x) => x.item === id)) {
        const source = Array.isArray(o?.source) ? o.source.filter((x) => ['purchase', 'staff', 'demo'].includes(x)) : [];
        out.owned.push({ item: id, demo: o?.demo !== false, source });
      }
    }
  }
  if (out.enabled && !out.demo) out.shop = normalizeShop(msg.shop);
  for (const slot of SLOTS) {
    const c = msg.choice?.[slot];
    if (c && typeof c === 'object' && itemById(c.item)?.slot === slot && isColor(c.color)) out.choice[slot] = { item: c.item, color: c.color };
    out.pending[slot] = msg.pending?.[slot] === 'next-deal' ? 'next-deal' : null;
  }
  return out;
}

/** Случайный идентификатор запроса (8–64 символа из [A-Za-z0-9_-]). */
export function makeReq(rand = Math.random) {
  const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = 'r';
  for (let i = 0; i < 20; i++) s += abc[Math.floor(rand() * abc.length) % abc.length];
  return s;
}

/** Совпал ли снимок с тем, чего добивался запрос (ответ `op:'state'` на grant/apply/clear). */
function satisfied(snap, w) {
  if (w.op === 'grant') {
    const ids = itemsOfBundle(w.item).length ? itemsOfBundle(w.item) : [w.item];
    return ids.every((id) => snap.owned.some((o) => o.item === id));
  }
  if (w.op === 'apply') return snap.choice[w.slot]?.item === w.item && snap.choice[w.slot]?.color === w.color;
  if (w.op === 'clear') return snap.choice[w.slot] == null;
  return false;
}

/**
 * @param deps  { send(msg) -> bool, setTimer, clearTimer, genReq }
 */
export function createStore(deps = {}) {
  const d = { send: () => false, setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (t) => clearTimeout(t), genReq: makeReq, ...deps };
  let server = null; // последнее принятое `state`; null — ещё не было
  let connected = true;
  let wait = null; // { op, item?, slot?, color?, req, timer } — единственный запрос в пути
  let error = null; // { text, code?, again }
  let lastWhen = {}; // slot -> 'now'|'next-deal' из последнего ответа apply
  let stateAsked = false;
  let lost = null; // запрос без ответа — можно повторить тем же req
  const subs = new Set();
  const emit = () => subs.forEach((f) => { try { f(); } catch { /* подписчик не ломает ход */ } });

  // Вход: демосреда или магазин (сервер прислал `shop`). Ничего другого не открывает коллекции.
  const visible = () => !!server && server.enabled && (server.demo || !!server.shop);

  function done(err) {
    if (wait) d.clearTimer(wait.timer);
    wait = null;
    error = err || null;
    emit();
  }

  function fire(w0) {
    const w = { op: w0.op, item: w0.item, slot: w0.slot, color: w0.color, req: w0.req };
    const msg = { t: 'col', op: w.op, req: w.req };
    if (w.op === 'grant') msg.item = w.item;
    if (w.op === 'apply') Object.assign(msg, { slot: w.slot, item: w.item, color: w.color });
    if (w.op === 'clear') msg.slot = w.slot;
    if (w.op === 'state') delete msg.req;
    const ok = d.send(msg);
    if (!ok) {
      // Ушло ли — неизвестно: ничего не выдаём, показываем «нет связи» и разрешаем повтор.
      wait = null;
      lost = w;
      error = { text: 'Нет связи с сервером. Ничего не изменилось.', code: 'OFFLINE', again: true };
      emit();
      return false;
    }
    wait = { ...w, timer: d.setTimer(() => {
      // Ответа нет: запрос мог дойти. Сохраняем req — повтор не удвоит выдачу.
      lost = w;
      wait = null;
      error = { text: 'Сервер не ответил. Прежнее оформление сохранено. Повторите.', code: 'TIMEOUT', again: true };
      emit();
    }, ANSWER_MS) };
    lost = null;
    error = null;
    emit();
    return true;
  }

  const api = {
    /** Подписка на любые изменения; возвращает отписку. */
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    attach(over) { Object.assign(d, over); },

    get visible() { return visible(); },

    snapshot() {
      const s = server || empty();
      return {
        link: !connected ? 'offline' : server ? 'ok' : 'loading',
        loaded: !!server,
        enabled: s.enabled,
        demo: s.demo,
        shop: s.shop,
        visible: visible(),
        owned: s.owned.map((o) => o.item),
        sources: Object.fromEntries(s.owned.map((o) => [o.item, o.source || []])),
        choice: s.choice,
        pending: s.pending,
        when: { ...lastWhen },
        busy: wait ? { op: wait.op, item: wait.item ?? null, slot: wait.slot ?? null } : null,
        error: error ? { ...error } : null,
      };
    },

    /** Связь с сервером появилась/пропала (страница знает это из net.connected). */
    connection(on) {
      if (on === connected) return;
      connected = on;
      if (!on) {
        stateAsked = false;
        if (wait) {
          // Ответ мог потеряться по дороге: ничего не выдаём, запрос можно повторить тем же req.
          d.clearTimer(wait.timer);
          const w = wait;
          wait = null;
          if (w.op !== 'state') {
            lost = { op: w.op, item: w.item, slot: w.slot, color: w.color, req: w.req };
            error = { text: 'Связь прервалась до ответа сервера. Прежнее оформление сохранено. Повторите.', code: 'LINK', again: true };
          }
        }
      }
      emit();
    },

    /** Один раз за соединение попросить `state`. */
    ensureState() {
      if (!connected || stateAsked) return;
      stateAsked = true;
      api.refresh();
    },

    refresh() {
      if (wait) return false;
      return fire({ op: 'state', req: null });
    },

    own(item) {
      const ids = itemsOfBundle(item);
      if (ids.length) return ids.every((id) => server?.owned.some((o) => o.item === id));
      return !!server?.owned.some((o) => o.item === item);
    },
    ownedSome(item) {
      const ids = itemsOfBundle(item);
      return ids.some((id) => server?.owned.some((o) => o.item === id));
    },
    missing(item) {
      const have = (server?.owned || []).map((o) => o.item);
      return itemsOfBundle(item).length ? missingForBundle(have) : (have.includes(item) ? [] : [item]);
    },

    /** Демо-получение. Не уйдёт: вне демо, при ожидании, если уже есть, и для неполного комплекта. */
    grant(item) {
      if (!visible() || !server.demo || wait || !connected) return false;
      const it = itemById(item);
      if (!it || api.own(item)) return false;
      if (it.kind === 'bundle' && api.ownedSome(item)) return false; // правило цены дополнения не утверждено
      return fire({ op: 'grant', item, req: d.genReq() });
    },

    apply(slot, item, color) {
      if (!visible() || wait || !connected) return false;
      if (!SLOTS.includes(slot) || itemById(item)?.slot !== slot || !isColor(color)) return false;
      if (!api.own(item)) return false;
      return fire({ op: 'apply', slot, item, color, req: d.genReq() });
    },

    clear(slot) {
      if (!visible() || wait || !connected) return false;
      if (!SLOTS.includes(slot)) return false;
      return fire({ op: 'clear', slot, req: d.genReq() });
    },

    /** «Повторить» после ошибки/нет связи. */
    retry() {
      if (wait || !connected) return false;
      const w = lost;
      if (w) return fire(w);
      error = null;
      if (!server) return api.refresh();
      emit();
      return true;
    },

    dismissError() { if (error) { error = null; lost = null; emit(); } },

    /** Сообщение сервера `{ t:'col', … }`. */
    handle(msg) {
      if (!msg || msg.t !== 'col') return;
      if (msg.error) {
        const code = typeof msg.error.code === 'string' ? msg.error.code : 'COL_OP';
        const text = (typeof msg.error.text === 'string' && msg.error.text) || ERRORS[code] || ERRORS.COL_OP;
        if (msg.op === 'state' && !wait) { error = { text, code, again: true }; lost = { op: 'state', req: null }; emit(); return; }
        // Явный отказ: сервер ответил, ничего не изменив. Повтор — с новым req.
        const w = wait;
        if (w) { d.clearTimer(w.timer); wait = null; }
        lost = w && w.op !== 'state' ? { op: w.op, item: w.item, slot: w.slot, color: w.color, req: d.genReq() } : null;
        error = { text, code, again: !!lost && code !== 'COL_OFF' && code !== 'COL_DEMO_OFF' };
        if (!error.again) lost = null;
        emit();
        return;
      }
      if (msg.op !== 'state' && !['grant', 'apply', 'clear'].includes(msg.op)) return;
      const snap = normalizeState(msg);
      server = snap;
      if (msg.op === 'apply' && wait?.op === 'apply' && (msg.when === 'now' || msg.when === 'next-deal')) lastWhen[wait.slot] = msg.when;
      if (!snap.enabled || (!snap.demo && !snap.shop)) lastWhen = {};
      if (wait && wait.op !== 'state') {
        // Ответ на наш запрос: либо тот же op, либо `state`, в котором виден результат.
        if (msg.op === wait.op || satisfied(snap, wait)) return done(null);
        // Снимок без нашего результата и не наш op — пришёл сам по себе; запрос ещё в пути.
        emit();
        return;
      }
      if (wait && wait.op === 'state') return done(null);
      error = ['OFFLINE', 'TIMEOUT', 'LINK'].includes(error?.code) ? null : error;
      lost = null;
      emit();
    },
  };
  return api;
}

/** Единственный экземпляр страницы. Отправку подключает `collections/index.js` (`store.attach`). */
export const store = createStore();

export { COLORS, DEFAULT_COLOR, ITEMS, SLOTS, isReq };
