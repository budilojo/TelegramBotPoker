/**
 * Профиль игрока: ник и аватар — ТОЛЬКО для показа (docs/profile.md).
 *
 * Личность и права определяет Telegram (подписанный initData). Здесь нет ни
 * одной проверки прав: ник «Хост» не делает человека хостом, ник «Вася» не
 * делает его Васей. За столом, в рейтинге и в группе показывается отображаемое
 * имя; настоящее имя из Telegram остаётся в `user.name` для пульта и аудита.
 */
import { cleanName } from './fmt.js';

/**
 * Фиксированный набор аватарок (файлы miniapp/avatars/<id>.png, запас — .svg).
 * Одиннадцать штук: номера как в файлах владельца, `av05` пропущен — такого файла
 * нет. Раньше сохранённый `av05` читается как «без аватара» (см. `avatarId`).
 */
export const AVATARS = Object.freeze(['av01', 'av02', 'av03', 'av04', 'av06', 'av07', 'av08', 'av09', 'av10', 'av11', 'av12']);
const AVATAR_SET = new Set(AVATARS);

/** Id аватара или null. Всё, чего нет в наборе, — null (в вид не попадает). */
export const avatarId = (x) => (typeof x === 'string' && AVATAR_SET.has(x) ? x : null);

/** Длина ника в символах. Верхний предел — тот же, что у имени за столом (cleanName). */
export const NICK_MIN = 2;
export const NICK_MAX = 16;
/** Не чаще раза в 10 секунд и 6 раз в час. */
export const EVERY_MS = 10_000;
export const PER_HOUR = 6;
const HOUR_MS = 3_600_000;

export const PROFILE_ERRORS = {
  NICK_SHORT: `Ник слишком короткий — от ${NICK_MIN} до ${NICK_MAX} символов.`,
  NICK_LONG: `Ник слишком длинный — от ${NICK_MIN} до ${NICK_MAX} символов.`,
  NICK_INVISIBLE: 'В нике есть невидимые или служебные символы — уберите их.',
  NICK_LINK: 'В нике нельзя @, ссылки и адреса — это видно всей группе.',
  NICK_CHARS: 'В нике можно буквы, цифры, пробел и знаки _ - . а также обычные смайлики.',
  NICK_EMPTY: 'В нике должна быть хотя бы одна буква, цифра или смайлик.',
  NICK_TYPE: 'Ник должен быть текстом.',
  BAD_AVATAR: 'Такой аватарки нет — выберите одну из набора.',
  PROFILE_FAST: 'Профиль уже меняли только что — подождите немного.',
  PROFILE_HOUR: 'Профиль меняли слишком часто — попробуйте через час.',
};

const INVISIBLE = /[\p{C}\u2028\u2029\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u3164\uFFA0]/u;
const ALLOWED = /^[\p{L}\p{M}\p{N} _.\-\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F]+$/u;
const HAS_SENSE = /[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const LINK = /:\/\/|www\.|t\.me|telegram\.(me|org|dog)|\.(com|ru|org|net|me|io|su|ua|by|kz|xyz|online|app|site|club|top|info|link|gg)(?![\p{L}\p{N}])/iu;

/**
 * Очистить и проверить ник. Пустая строка — «сбросить к имени из Telegram».
 * @returns {{ok:true, nick:string|null}|{ok:false, code:string}}
 */
export function cleanNick(raw) {
  if (raw == null) return { ok: true, nick: null };
  if (typeof raw !== 'string') return { ok: false, code: 'NICK_TYPE' };
  // Любые пробельные (табы, неразрывные, переводы строк) → один обычный пробел.
  const s = raw.normalize('NFC').replace(/[\s\u00A0]+/gu, ' ').trim();
  if (!s) return { ok: true, nick: null };
  if (INVISIBLE.test(s)) return { ok: false, code: 'NICK_INVISIBLE' };
  if (s.includes('@') || s.includes('＠')) return { ok: false, code: 'NICK_LINK' };
  // Адрес можно разбить пробелами и знаками («t . me») — смотрим и на сжатый вид.
  const packed = s.replace(/[\s_\-]/gu, '');
  if (LINK.test(s) || LINK.test(packed)) return { ok: false, code: 'NICK_LINK' };
  if (!ALLOWED.test(s)) return { ok: false, code: 'NICK_CHARS' };
  if (!HAS_SENSE.test(s)) return { ok: false, code: 'NICK_EMPTY' };
  const len = [...s].length;
  if (len < NICK_MIN) return { ok: false, code: 'NICK_SHORT' };
  if (len > NICK_MAX) return { ok: false, code: 'NICK_LONG' };
  return { ok: true, nick: s };
}

const fold = (s) => String(s).toLocaleLowerCase('ru');

/** Профили: хранение, частота смены, показ. Живёт в приложении (`app.profiles`). */
export class Profiles {
  constructor(app) {
    this.app = app;
    /** userId -> { nickname, avatar } — запись в базу сквозная, чтение с кэша. */
    this.cache = new Map();
    /** userId -> [время каждой смены] */
    this.changes = new Map();
  }

  /** Сырой профиль: ник (или null) и id аватара (или null). */
  raw(userId) {
    const id = String(userId);
    let p = this.cache.get(id);
    if (!p) {
      let r = null;
      try {
        r = this.app.store.getProfile?.(id);
      } catch (err) {
        this.app.log?.(err);
      }
      p = { nickname: cleanNick(r?.nickname).nick ?? null, avatar: avatarId(r?.avatar) };
      this.cache.set(id, p);
    }
    return p;
  }

  /** profileOf из контракта: как человека видят — { name, avatar }. */
  profileOf(userId, tgName = null) {
    const p = this.raw(userId);
    return { name: p.nickname ?? (tgName == null ? null : cleanName(tgName)), avatar: p.avatar };
  }

  /** То, что видит сам игрок на экране настроек. */
  mine(user) {
    const p = this.raw(user.id);
    return {
      nickname: p.nickname,
      avatar: p.avatar,
      telegramName: cleanName(user.name),
      shown: p.nickname ?? cleanName(user.name),
      avatars: AVATARS,
      min: NICK_MIN,
      max: NICK_MAX,
    };
  }

  /** Короткая форма для `me` в состояниях хаба. */
  me(user) {
    const p = this.raw(user.id);
    return { name: p.nickname ?? user.name, avatar: p.avatar };
  }

  /** Имя и аватар в строке рейтинга — на момент показа, не копия из старой строки. */
  shown(userId, fallbackName) {
    const p = this.raw(userId);
    return { name: p.nickname ?? fallbackName, avatar: p.avatar };
  }

  /**
   * Сменить свой профиль. `msg.nickname` и `msg.avatar` необязательны; ничего
   * не прислали — просто вернуть текущий. Чей это профиль — только из `user`
   * (подписанный initData), в теле «чей» нет и быть не может.
   */
  update(user, msg) {
    const uid = String(user.id);
    const cur = this.raw(uid);
    const next = { nickname: cur.nickname, avatar: cur.avatar };
    if (Object.hasOwn(msg, 'nickname')) {
      const r = cleanNick(msg.nickname);
      if (!r.ok) return { error: r.code, text: PROFILE_ERRORS[r.code] };
      next.nickname = r.nick;
    }
    if (Object.hasOwn(msg, 'avatar')) {
      if (msg.avatar === null || msg.avatar === '') next.avatar = null;
      else if (avatarId(msg.avatar)) next.avatar = msg.avatar;
      else return { error: 'BAD_AVATAR', text: PROFILE_ERRORS.BAD_AVATAR };
    }
    if (next.nickname === cur.nickname && next.avatar === cur.avatar) return { ok: true, profile: this.mine(user) };

    const now = this.app.clock.now();
    const log = (this.changes.get(uid) || []).filter((t) => now - t < HOUR_MS);
    if (log.length && now - log[log.length - 1] < EVERY_MS) return { error: 'PROFILE_FAST', text: PROFILE_ERRORS.PROFILE_FAST };
    if (log.length >= PER_HOUR) return { error: 'PROFILE_HOUR', text: PROFILE_ERRORS.PROFILE_HOUR };
    log.push(now);
    this.changes.set(uid, log);

    this.app.store.putProfile?.(uid, next, now);
    this.cache.set(uid, next);
    this.refreshRooms(uid, cleanName(user.name));
    return { ok: true, profile: this.mine(user) };
  }

  /**
   * Подогнать имена и аватарки игроков стола под их профили: ник (с «2», если
   * такое имя за столом уже есть) и аватар. Вызывается при каждой перерисовке
   * стола. Первым остаётся тот, кто сидит дольше; тот, у кого ник не задан,
   * своё имя из Telegram не меняет никогда.
   */
  settleNames(room) {
    const live = room.players.filter((p) => !p.bot && !p.left && !p.kicked);
    const withNick = [];
    const used = new Set();
    for (const p of live) {
      const prof = this.raw(p.id);
      p.avatar = prof.avatar;
      if (prof.nickname) withNick.push([p, prof.nickname]);
      else used.add(fold(p.name));
    }
    // и боты: «Бот 2» тоже занимает имя
    for (const p of room.players) if (p.bot) used.add(fold(p.name));
    withNick.sort((a, b) => (a[0].joinedAt || 0) - (b[0].joinedAt || 0));
    for (const [p, nick] of withNick) {
      let name = nick;
      for (let n = 2; used.has(fold(name)); n++) {
        const tail = ` ${n}`;
        name = [...nick].slice(0, NICK_MAX - tail.length).join('').trimEnd() + tail;
      }
      used.add(fold(name));
      p.name = name;
    }
  }

  /** Профиль сменился: обновить столы человека и перерисовать их. */
  refreshRooms(uid, tgName) {
    const prof = this.raw(uid);
    for (const room of this.app.rooms.values()) {
      if (room.status === 'finished') continue; // итоги уже разосланы под старым именем
      const p = room.players.find((x) => x.id === uid && !x.bot && !x.left && !x.kicked);
      if (!p) continue;
      if (!prof.nickname) p.name = cleanName(tgName);
      this.settleNames(room);
      this.app.draw(room);
    }
  }
}
