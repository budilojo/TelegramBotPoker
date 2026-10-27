/**
 * Иконка на рабочий стол — чистая логика состояний (без DOM, проверяется в Node).
 *
 * Факты (core.telegram.org/bots/webapps, Bot API 8.0, сверено 2026-10-27):
 *  - Telegram.WebApp.addToHomeScreen() и checkHomeScreenStatus([callback]) — с Bot API 8.0;
 *    на версии ниже telegram-web-app.js бросает 'WebAppMethodUnsupported';
 *  - статус: 'unsupported' | 'unknown' | 'added' | 'missed' (в callback и в событии homeScreenChecked {status});
 *  - событие homeScreenAdded — «успешно добавлено», но «если устройство не может определить статус, событие может не прийти»;
 *  - события отказа в официальной документации НЕТ (homeScreenFailed — только в чужих обёртках). Мы его слушаем,
 *    но не полагаемся: отказ определяем таймаутом и повторной проверкой статуса.
 *
 * Состояния: unavailable | checking | can | pending | added | failed.
 * Успех — только `homeScreenAdded` или статус 'added' от Telegram. Никогда — «потому что вызов не бросил ошибку».
 */
export const MIN_VERSION = '8.0';
export const CHECK_TIMEOUT_MS = 6000;
export const ADD_TIMEOUT_MS = 30000;

export const STATES = ['unavailable', 'checking', 'can', 'pending', 'added', 'failed'];

export function createHomescreen(tg, { setTimer = setTimeout, clearTimer = clearTimeout, checkMs = CHECK_TIMEOUT_MS, addMs = ADD_TIMEOUT_MS } = {}) {
  let state = 'checking';
  let reason = null; // для 'failed': 'add' | 'check' | 'declined'
  let checkId = 0;
  let timer = null;
  const subs = new Set();
  let listening = false;

  const supported = !!tg && typeof tg.addToHomeScreen === 'function' && typeof tg.checkHomeScreenStatus === 'function'
    && typeof tg.isVersionAtLeast === 'function' && safe(() => tg.isVersionAtLeast(MIN_VERSION)) === true;

  function safe(fn) { try { return fn(); } catch { return undefined; } }
  function set(next, why = null) {
    if (state === next && reason === why) return;
    state = next; reason = why;
    for (const f of [...subs]) safe(() => f(api.get()));
  }
  function stop() { if (timer != null) { clearTimer(timer); timer = null; } }
  function arm(ms, fn) { stop(); timer = setTimer(fn, ms); }

  function applyStatus(status, ctx) {
    stop();
    if (status === 'added') return set('added');
    if (status === 'unsupported') return set('unavailable');
    if (status === 'unknown' || status === 'missed') {
      // после попытки добавления: «не добавлено» — это отказ, а не успех
      return ctx === 'verify' ? set('failed', 'declined') : set('can');
    }
    return set('failed', 'check'); // непонятный ответ — не угадываем
  }

  function onChecked(e) { if (checking) { checking = false; applyStatus(e?.status, ctxNow); } }
  function onAdded() { stop(); checking = false; set('added'); }
  function onFailed() { if (state === 'pending') { stop(); set('failed', 'declined'); } }
  let checking = false;
  let ctxNow = 'init';

  function listen() {
    if (listening) return;
    listening = true;
    safe(() => tg.onEvent?.('homeScreenAdded', onAdded));
    safe(() => tg.onEvent?.('homeScreenChecked', onChecked));
    safe(() => tg.onEvent?.('homeScreenFailed', onFailed)); // в документации нет; слушаем, но не требуем
  }

  function check(ctx) {
    const id = ++checkId;
    checking = true; ctxNow = ctx;
    arm(checkMs, () => {
      if (id !== checkId) return;
      checking = false;
      set('failed', ctx === 'verify' ? 'add' : 'check');
    });
    try {
      tg.checkHomeScreenStatus((status) => { if (id === checkId && checking) { checking = false; applyStatus(status, ctx); } });
    } catch { stop(); checking = false; set('failed', 'check'); }
  }

  const api = {
    get: () => ({ state, reason }),
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    /** Проверка статуса при открытии «Настроек». */
    start() {
      if (!supported) return set('unavailable');
      if (state === 'pending' || state === 'added') return;
      listen(); set('checking'); check('init');
    },
    /** Нажатие кнопки. Повторное нажатие в ожидании игнорируется. */
    add() {
      if (!supported || (state !== 'can' && state !== 'failed')) return false;
      listen();
      set('pending');
      try { tg.addToHomeScreen(); } catch { stop(); set('failed', 'add'); return true; }
      arm(addMs, () => { check('verify'); }); // таймаут: не верим молча — спрашиваем Telegram
      return true;
    },
    /** Повтор после отказа или неудачной проверки. */
    retry() {
      if (state !== 'failed') return false;
      if (reason === 'check') { set('checking'); check('init'); return true; }
      return api.add();
    },
    dispose() {
      stop(); checkId++; subs.clear();
      if (listening) {
        safe(() => tg.offEvent?.('homeScreenAdded', onAdded));
        safe(() => tg.offEvent?.('homeScreenChecked', onChecked));
        safe(() => tg.offEvent?.('homeScreenFailed', onFailed));
        listening = false;
      }
    },
  };
  if (!supported) { state = 'unavailable'; }
  return api;
}

/** Тексты строки: заголовок, пояснение, подпись кнопки (null — кнопки нет). Один источник для строки и тестов. */
export function rowText({ state, reason }) {
  switch (state) {
    case 'unavailable': return { sub: 'Недоступно в этом Telegram. Обновите приложение Telegram, если хотите добавить иконку.', btn: null };
    case 'checking': return { sub: 'Проверяем…', btn: null };
    case 'can': return { sub: 'Иконка откроет это приложение внутри Telegram.', btn: 'Добавить' };
    case 'pending': return { sub: 'Ждём ответа Telegram. Подтвердите добавление в окне Telegram.', btn: null };
    case 'added': return { sub: 'Иконка уже на рабочем столе.', btn: null };
    case 'failed':
      return { sub: reason === 'check' ? 'Не удалось проверить. Попробуйте ещё раз.'
        : 'Telegram не подтвердил добавление. Иконка могла не добавиться — попробуйте ещё раз.', btn: 'Повторить' };
    default: return { sub: '', btn: null };
  }
}
