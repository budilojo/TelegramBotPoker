'use strict';
/**
 * Смайлики во время игры — «быстрые реакции».
 *
 * Набор ЗАКРЫТЫЙ: страница присылает только идентификатор из списка ниже, ни
 * текста, ни картинки (`decisions/023`). Подписи и запасные эмодзи — здесь же,
 * один список на сервер и клиент (клиент держит копию в `miniapp/reactions.js`;
 * тест сверяет, что списки совпадают).
 *
 * Реакция — не ход. Её НЕ сохраняем (ни в комнату, ни в базу), по ней не
 * пересобирается состояние стола и не правится карточка в группе: всем
 * страницам стола уходит одно лёгкое сообщение `{t:'react', seat, id, at}`
 * (`decisions/024`). После перезапуска реакций нет — так и задумано.
 *
 * Кто прислал — только из подписи страницы (`session.user`). Адресуем по
 * МЕСТУ за столом (номер в `room.players`), как и все виды игр: чужой
 * Telegram-id наружу не уходит.
 *
 * Лимит — на человека, по часам приложения (`decisions/025`): не чаще раза в
 * 3 секунды и не больше шести в минуту.
 */

/** id → подпись по-русски. Порядок — порядок клеток в шторке 4×4. */
export const REACTIONS = Object.freeze({
  gg: 'Хорошая игра',
  wow: 'Ого!',
  haha: 'Ха-ха',
  sad: 'Не повезло',
  think: 'Думаю',
  fire: 'Огонь!',
  bluff: 'Блеф?',
  allin: 'Ва-банк',
  thanks: 'Спасибо',
  sorry: 'Прости',
  hello: 'Привет',
  angry: 'Злюсь',
  facepalm: 'Ну как так',
  cool: 'Красавчик',
  wait: 'Жду',
  cheers: 'Ура!',
});

export const REACTION_IDS = Object.freeze(Object.keys(REACTIONS));

/** Не чаще одной реакции в столько миллисекунд. */
export const REACT_GAP_MS = 3_000;
/** И не больше стольких за минуту. */
export const REACT_PER_MIN = 6;
const MINUTE = 60_000;

export const ERRORS = {
  REACT_UNKNOWN: 'Такого смайлика нет.',
  REACT_NOT_SEATED: 'Смайлики отправляют те, кто играет за этим столом.',
  REACT_WAIT: 'Не так часто — подождите немного.',
};

export const isReaction = (id) => typeof id === 'string' && Object.hasOwn(REACTIONS, id);

/** «Подождите N с» — словами, N округляется вверх. */
export const waitText = (ms) => `Не так часто — подождите ${Math.max(1, Math.ceil(ms / 1000))} с.`;

/**
 * Счётчик «не чаще» на человека. Живёт в памяти хаба, не в комнате: после
 * перезапуска начинается заново — это реакции, не деньги.
 */
export class ReactLimiter {
  constructor() {
    /** uid → отметки времени реакций за последнюю минуту */
    this.sent = new Map();
  }

  /** Сколько ещё ждать (мс); 0 — можно. */
  waitFor(uid, now) {
    const list = (this.sent.get(uid) || []).filter((at) => now - at < MINUTE);
    if (list.length) this.sent.set(uid, list);
    else this.sent.delete(uid);
    if (!list.length) return 0;
    const gap = list.at(-1) + REACT_GAP_MS - now;
    const full = list.length >= REACT_PER_MIN ? list[list.length - REACT_PER_MIN] + MINUTE - now : 0;
    return Math.max(0, gap, full);
  }

  note(uid, now) {
    const list = this.sent.get(uid) || [];
    list.push(now);
    this.sent.set(uid, list);
  }
}

/** Может ли этот человек слать реакции за этим столом: сидит, не ушёл, не удалён. */
export function reactSeat(room, uid) {
  if (room.solo && room.solo.owner !== uid) return -1;
  const i = room.players.findIndex((p) => p.id === uid);
  const p = room.players[i];
  if (!p || p.bot || p.left || p.kicked || p.seated === false) return -1;
  return i;
}

/**
 * Одна реакция со страницы. `sessions` — все страницы этого стола.
 * Ничего в комнате не меняет. Возвращает то, что разослано, или отказ.
 */
export function react({ room, uid, msg, now, limiter, sessions, refuse }) {
  if (!isReaction(msg.id)) return refuse('REACT_UNKNOWN');
  const seat = reactSeat(room, uid);
  if (seat < 0) return refuse('REACT_NOT_SEATED');
  const wait = limiter.waitFor(uid, now);
  if (wait > 0) return refuse('REACT_WAIT', waitText(wait), wait);
  limiter.note(uid, now);
  const out = { t: 'react', seat, id: msg.id, at: now };
  for (const s of sessions) {
    try {
      s.send(out);
    } catch {
      /* страница уже закрылась */
    }
  }
  return out;
}
