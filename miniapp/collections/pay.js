/**
 * Покупка на странице — чистая логика (без DOM; проверяется в Node: bot/payments.client.test.js).
 * Контракт — docs/next-release/payment-design.md, протокол — pay-protocol.js.
 *
 * Правила:
 *  • цену и покупателя страница не задаёт — только `item` и `req`;
 *  • одновременно одна покупка: второе нажатие не уходит;
 *  • статус окна оплаты (`paid`) НЕ делает вещь купленной: «Куплено» — только когда сервер прислал состояние
 *    коллекций, где вещь есть (`sawOwned`). До этого — «ждём подтверждения»;
 *  • отмена и ошибка окна — «звёзды не списаны», можно попробовать снова.
 */
import { itemsOfBundle } from './catalog.js';
import { PAY_ERRORS, CONFIRM_WAIT_MS, PAY_OPS } from './pay-protocol.js';
import { makeReq } from './state.js';

/** Сколько ждать ответа сервера на «Купить», мс. */
export const ASK_MS = 12_000;

export const PAY_TEXT = {
  asking: 'Готовим счёт…',
  invoice: 'Окно оплаты Telegram открыто.',
  confirming: 'Оплата прошла — ждём подтверждения от Telegram…',
  slow: 'Подтверждение задерживается. Проверьте «Мои покупки». Если звёзды списались, а вещь не появилась — обратитесь в поддержку.',
  cancelled: 'Оплата отменена. Звёзды не списаны.',
  failed: 'Оплата не прошла. Звёзды не списаны. Если звёзд не хватает, Telegram предложит их пополнить.',
  noInvoice: 'Окно оплаты здесь не открывается. Обновите Telegram и попробуйте снова.',
  timeout: 'Сервер не ответил. Ничего не списано — попробуйте ещё раз.',
  offline: 'Нет связи с сервером. Ничего не списано.',
};

const idsOf = (item) => (itemsOfBundle(item).length ? itemsOfBundle(item) : [item]);

/**
 * @param deps { send(msg)->bool, openInvoice(url, cb)->bool, setTimer, clearTimer, now, genReq }
 */
export function createPay(deps = {}) {
  const d = {
    send: () => false, openInvoice: () => false, setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (x) => clearTimeout(x),
    now: () => Date.now(), genReq: makeReq, ...deps,
  };
  // name: idle | asking | invoice | confirming | done | cancelled | failed | error
  let phase = { name: 'idle' };
  let timer = null;
  let history = null; // null — не загружали
  let bot = ''; // имя бота — для ссылки «Написать в поддержку» (?start=support)
  let terms = null;
  let support = null; // { ok, text }
  let owned = new Set();
  const subs = new Set();
  const emit = () => subs.forEach((f) => { try { f(); } catch { /* подписчик не ломает ход */ } });
  const stop = () => { if (timer != null) d.clearTimer(timer); timer = null; };
  const busy = () => ['asking', 'invoice', 'confirming'].includes(phase.name);

  function finishIfOwned() {
    if (!['invoice', 'confirming'].includes(phase.name)) return false;
    if (!idsOf(phase.item).every((id) => owned.has(id))) return false;
    stop();
    phase = { name: 'done', item: phase.item, order: phase.order };
    history = null; // в истории появилась покупка — перечитать при следующем открытии
    emit();
    return true;
  }

  function onStatus(item, order, status) {
    if (phase.order !== order) return; // окно старого счёта — уже не наше
    if (status === 'paid' || status === 'pending') {
      if (finishIfOwned()) return;
      // Окно сказало «оплачено» — это ещё не покупка: ждём, пока сервер пришлёт вещь в коллекции.
      phase = { name: 'confirming', item, order, since: d.now() };
      stop();
      timer = d.setTimer(() => { if (phase.name === 'confirming' && phase.order === order) { phase = { ...phase, slow: true }; emit(); } }, CONFIRM_WAIT_MS);
      emit();
      return;
    }
    stop();
    phase = { name: status === 'cancelled' ? 'cancelled' : 'failed', item, order, text: status === 'cancelled' ? PAY_TEXT.cancelled : PAY_TEXT.failed };
    emit();
  }

  const api = {
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    attach(over) { Object.assign(d, over); },
    get phase() { return { ...phase }; },
    get history() { return history; },
    get bot() { return bot; },
    get terms() { return terms; },
    get support() { return support; },
    busy,

    /** «Купить». Не уйдёт, пока идёт другая покупка или вещь уже есть. */
    buy(item) {
      if (busy()) return false;
      if (idsOf(item).every((id) => owned.has(id))) return false;
      const req = d.genReq();
      if (!d.send({ t: 'pay', op: 'buy', item, req })) {
        phase = { name: 'error', item, text: PAY_TEXT.offline };
        emit();
        return false;
      }
      phase = { name: 'asking', item, req };
      stop();
      timer = d.setTimer(() => { if (phase.name === 'asking' && phase.req === req) { phase = { name: 'error', item, text: PAY_TEXT.timeout }; emit(); } }, ASK_MS);
      emit();
      return true;
    },

    /** Сервер прислал состояние коллекций — что у человека есть (единственное доказательство покупки). */
    sawOwned(ids) {
      owned = new Set(ids || []);
      finishIfOwned();
    },

    loadHistory() { return d.send({ t: 'pay', op: 'history' }); },
    loadTerms() { return terms ? true : d.send({ t: 'pay', op: 'terms' }); },
    askSupport() { support = null; emit(); return d.send({ t: 'pay', op: 'support' }); },

    /** Сбросить итог (после «Понятно» или ухода с карточки). Идущая оплата не сбрасывается. */
    reset() { if (!busy()) { stop(); phase = { name: 'idle' }; emit(); } },

    /** Сообщение сервера `{ t:'pay', … }`. */
    handle(msg) {
      if (!msg || msg.t !== 'pay' || !PAY_OPS.includes(msg.op)) return;
      if (msg.op === 'history') {
        if (typeof msg.bot === 'string' && /^[A-Za-z0-9_]{3,64}$/.test(msg.bot)) bot = msg.bot;
        if (Array.isArray(msg.orders)) history = msg.orders.filter((o) => o && typeof o.id === 'string').slice(0, 50);
        emit();
        return;
      }
      if (msg.op === 'terms') {
        if (msg.docs && typeof msg.docs === 'object') terms = msg.docs;
        emit();
        return;
      }
      if (msg.op === 'support') {
        support = { ok: msg.ok === true, text: msg.ok === true ? 'Сведения о покупках отправлены вам в личку с ботом.' : (msg.error?.text || 'Не получилось написать вам в личку. Откройте бота и нажмите «Старт», затем /paysupport.') };
        emit();
        return;
      }
      // buy
      if (phase.name !== 'asking') return; // ответ на старый запрос
      stop();
      if (msg.error) {
        const code = typeof msg.error.code === 'string' ? msg.error.code : 'PAY_OP';
        phase = { name: 'error', item: phase.item, text: (typeof msg.error.text === 'string' && msg.error.text) || PAY_ERRORS[code] || PAY_ERRORS.PAY_OP, code };
        emit();
        return;
      }
      if (typeof msg.link !== 'string' || typeof msg.order !== 'string' || msg.item !== phase.item) {
        phase = { name: 'error', item: phase.item, text: PAY_ERRORS.PAY_OP };
        emit();
        return;
      }
      const item = phase.item;
      const order = msg.order;
      phase = { name: 'invoice', item, order, price: Number.isInteger(msg.price) ? msg.price : null };
      emit();
      const opened = d.openInvoice(msg.link, (status) => onStatus(item, order, status));
      if (!opened) { phase = { name: 'failed', item, order, text: PAY_TEXT.noInvoice }; emit(); }
    },
  };
  return api;
}

/** Экземпляр страницы. Отправку и окно оплаты подключает collections/index.js. */
export const pay = createPay();
