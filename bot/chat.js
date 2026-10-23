'use strict';
/**
 * Чат за игровым столом — только участникам этого стола (`decisions/036–040`).
 *
 * Сообщение — ВСЕГДА текст. Автора определяет подпись страницы (`session.user`):
 * место, имя и id из тела сообщения ничего не значат. Историю держим в памяти
 * хаба (последние 50 строк на стол): не в базе, не в комнате (`serialize`), не
 * в `view`, не в карточке группы. Перезапуск и удаление стола её стирают.
 *
 * Строка истории — либо сообщение `{k:'m', id, seat, name, text, at}`, либо
 * реакция `{k:'r', id, seat, name, react, at}` (тап по смайлику ложится в
 * историю маленькой строкой — `bot/reactions.js` зовёт `Chats.addReact`).
 *
 * Непрочитанные считает сервер, в памяти, на человека (а не на страницу):
 * растут, пока никто из его страниц не прислал `{t:'chat-read'}`.
 */
import { reactSeat } from './reactions.js';

export const CHAT_MAX_LEN = 300;
export const CHAT_HISTORY = 50;
/** Не чаще одного сообщения в столько миллисекунд. */
export const CHAT_GAP_MS = 1_500;
/** И не больше стольких за минуту. */
export const CHAT_PER_MIN = 12;
/** Одинаковый текст подряд не принимается столько миллисекунд. */
export const CHAT_SAME_MS = 10_000;
const MINUTE = 60_000;

export const ERRORS = {
  CHAT_NOT_SEATED: 'Писать в чат могут игроки, сидящие за этим столом.',
  CHAT_SOLO: 'В партии с ботами чата нет — говорить не с кем.',
  CHAT_EMPTY: 'Напишите хоть слово.',
  CHAT_TOO_LONG: `Слишком длинно: в сообщении не больше ${CHAT_MAX_LEN} символов.`,
  CHAT_WAIT: 'Не так часто — подождите немного.',
  CHAT_SAME: 'Это вы уже писали — подождите немного.',
};

const waitText = (ms) => `Не так часто — подождите ${Math.max(1, Math.ceil(ms / 1000))} с.`;
const sameText = (ms) => `Это вы уже писали — подождите ${Math.max(1, Math.ceil(ms / 1000))} с.`;

/**
 * Невидимое: управляющие (кроме перевода строки), нулевой ширины, разметка
 * направления (RTL-override и его родня), мягкий перенос, «слова-метки».
 * Соединитель ZWJ (U+200D) и выбор начертания (U+FE0F) оставлены — на них
 * держатся составные эмодзи (семья, флаги); сообщение из одних только них пустое.
 */
const INVISIBLE = new RegExp(
  '[' + [
    '\\u0000-\\u0009', '\\u000B-\\u001F', '\\u007F-\\u009F', '\\u00AD', '\\u034F', '\\u061C', '\\u115F\\u1160',
    '\\u17B4\\u17B5', '\\u180B-\\u180E', '\\u200B\\u200C', '\\u200E\\u200F', '\\u2028\\u2029', '\\u202A-\\u202E',
    '\\u2060-\\u206F', '\\u3164', '\\uFE00-\\uFE0E', '\\uFEFF', '\\uFFA0', '\\uFFF9-\\uFFFC', '\\u{E0000}-\\u{E0FFF}',
  ].join('') + ']',
  'gu',
);

/**
 * Очистка текста со страницы. Возвращает { text } или { error }.
 * Длина — в символах (кодовых точках), не в байтах.
 */
export function cleanChatText(raw) {
  if (typeof raw !== 'string') return { error: 'CHAT_EMPTY' };
  let s = raw.normalize('NFC').replace(/\r\n?/g, '\n').replace(INVISIBLE, '');
  s = s.replace(/[ \t ]+\n/g, '\n').replace(/\n[ \t ]+/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  if (!/[^\s‍️]/u.test(s)) return { error: 'CHAT_EMPTY' };
  if ([...s].length > CHAT_MAX_LEN) return { error: 'CHAT_TOO_LONG' };
  return { text: s };
}

/** Счётчик «не чаще» на человека. Только в памяти хаба. */
export class ChatLimiter {
  constructor() {
    /** uid → { at: [отметки за минуту], last: текст, lastAt } */
    this.by = new Map();
  }

  /** { wait } — сколько ждать (мс), { same } — сколько нельзя повторять; иначе {}. */
  check(uid, text, now) {
    const e = this.by.get(uid);
    if (!e) return {};
    e.at = e.at.filter((t) => now - t < MINUTE);
    let wait = 0;
    if (e.at.length) {
      wait = Math.max(0, e.at.at(-1) + CHAT_GAP_MS - now);
      if (e.at.length >= CHAT_PER_MIN) wait = Math.max(wait, e.at[e.at.length - CHAT_PER_MIN] + MINUTE - now);
    }
    if (wait > 0) return { wait };
    if (e.last === text && now - e.lastAt < CHAT_SAME_MS) return { same: e.lastAt + CHAT_SAME_MS - now };
    return {};
  }

  note(uid, text, now) {
    const e = this.by.get(uid) || { at: [], last: null, lastAt: 0 };
    e.at = e.at.filter((t) => now - t < MINUTE);
    e.at.push(now);
    e.last = text;
    e.lastAt = now;
    this.by.set(uid, e);
  }
}

/** Может ли этот человек говорить за этим столом: сидит, не ушёл, не удалён; не партия с ботами. */
export function chatSeat(room, uid) {
  if (room.solo) return -1;
  return reactSeat(room, uid);
}

/** Истории всех столов. Живёт в хабе; ключ — код стола. */
export class Chats {
  constructor() {
    /** код стола → { log: [...], unread: Map(uid → n), n: следующий номер строки } */
    this.rooms = new Map();
  }

  #of(code) {
    let r = this.rooms.get(code);
    if (!r) {
      r = { log: [], unread: new Map(), n: 1 };
      this.rooms.set(code, r);
    }
    return r;
  }

  #push(room, line, members) {
    const r = this.#of(room.code);
    const full = { ...line, n: r.n++ };
    r.log.push(full);
    if (r.log.length > CHAT_HISTORY) r.log.splice(0, r.log.length - CHAT_HISTORY);
    // Непрочитанное — всем участникам, кроме автора.
    for (const uid of members) if (uid !== line.uid) r.unread.set(uid, (r.unread.get(uid) || 0) + 1);
    delete full.uid;
    return full;
  }

  /** Все, кто сейчас вправе читать чат этого стола (id). */
  members(room) {
    if (room.solo) return [];
    return room.players.filter((p) => reactSeat(room, p.id) >= 0).map((p) => p.id);
  }

  unread(room, uid) {
    return this.rooms.get(room.code)?.unread.get(uid) || 0;
  }

  /** Сообщение уже очищено и проверено. Возвращает строку истории (без служебных полей). */
  post(room, uid, text, now) {
    const seat = chatSeat(room, uid);
    return this.#push(room, { k: 'm', uid, seat, name: room.players[seat].name, text, at: now }, this.members(room));
  }

  /** Реакция — маленькая строка в истории. */
  addReact(room, uid, id, now) {
    const seat = reactSeat(room, uid);
    if (seat < 0 || room.solo) return null;
    return this.#push(room, { k: 'r', uid, seat, name: room.players[seat].name, react: id, at: now }, this.members(room));
  }

  read(room, uid) {
    this.rooms.get(room.code)?.unread.delete(uid);
  }

  /** История для участника. Не участнику — null. */
  snapshot(room, uid) {
    if (chatSeat(room, uid) < 0) return null;
    return { log: [...(this.rooms.get(room.code)?.log || [])], unread: this.unread(room, uid) };
  }

  /** Убрать истории столов, которых больше нет (зовёт хаб изредка). */
  prune(alive) {
    for (const code of this.rooms.keys()) if (!alive(code)) this.rooms.delete(code);
  }
}

/**
 * Одно сообщение со страницы. `sessions` — все страницы этого стола.
 * Ничего в комнате не меняет. Возвращает разосланное или null при отказе.
 */
export function chat({ room, uid, msg, now, chats, limiter, sessions, refuse }) {
  if (room.solo) return void refuse('CHAT_SOLO');
  if (chatSeat(room, uid) < 0) return void refuse('CHAT_NOT_SEATED');
  const clean = cleanChatText(msg.text);
  if (clean.error) return void refuse(clean.error);
  const gate = limiter.check(uid, clean.text, now);
  if (gate.wait > 0) return void refuse('CHAT_WAIT', waitText(gate.wait), gate.wait);
  if (gate.same > 0) return void refuse('CHAT_SAME', sameText(gate.same), gate.same);
  limiter.note(uid, clean.text, now);
  const line = chats.post(room, uid, clean.text, now);
  deliver(room, chats, sessions, line);
  return line;
}

/** Строку истории — страницам тех, кто вправе её читать, каждой со своим счётчиком. */
export function deliver(room, chats, sessions, line) {
  for (const s of sessions) {
    const uid = s.user.id;
    if (chatSeat(room, uid) < 0) continue;
    try {
      s.send({ t: 'chat', m: line, unread: chats.unread(room, uid) });
    } catch {
      /* страница уже закрылась */
    }
  }
}

/** Страницам участника — новое значение счётчика (после «прочитал»). */
export function sendUnread(room, chats, sessions, uid) {
  for (const s of sessions) {
    if (s.user.id !== uid) continue;
    try {
      s.send({ t: 'chat-unread', unread: chats.unread(room, uid) });
    } catch {
      /* страница уже закрылась */
    }
  }
}

/** Историю и счётчик — одной странице (вход на стол, переподключение, открытие панели). */
export function sync(room, chats, session) {
  const snap = chats.snapshot(room, session.user.id);
  if (!snap) return;
  session.send({ t: 'chat-sync', ...snap });
}
