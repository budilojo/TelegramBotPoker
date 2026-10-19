'use strict';
/**
 * Рассылка: одно объявление всем, кто нажал Start у игрового бота, — или во
 * все группы, где есть бот.
 *
 * Три вещи, из-за которых это не просто «цикл по пользователям»:
 *
 *   1. ТЕМП. Telegram позволяет боту около 30 сообщений в секунду, но за
 *      приближение к лимиту ограничивает бота целиком — вместе с «ваш ход» за
 *      живыми столами. Рассылка идёт впятеро медленнее потолка; игра при этом
 *      продолжается, потому что между письмами бот свободен.
 *   2. ОТПИСКА. Под каждым письмом кнопка «не присылать такое». Без неё
 *      рассылка — спам, из которого один выход: заблокировать бота.
 *   3. ПЕРЕЗАПУСК. Отложенная рассылка живёт в базе вместе с курсором — id
 *      последнего, кому письмо ушло. Бот поднялся и продолжил с того же
 *      места: никто не получил письмо дважды.
 *
 * Получателей «всех пользователей Telegram» ни у кого нет и быть не может:
 * бот пишет только тем, кто открыл с ним личку сам.
 *
 * ГРУППЫ — отдельная аудитория, со своими правилами:
 *   - кнопки «не присылать» нет: группе, которой надоело, достаточно удалить
 *     бота — и рассылка туда больше не пойдёт;
 *   - темп — одна группа в три секунды: у Telegram свои, более строгие лимиты
 *     на сообщения в группы, и ограничение задело бы игру во всех чатах;
 *   - список групп — те, о которых бот знает: куда его добавили, где играли.
 *     Список своих чатов Telegram боту не даёт. Бота в группе уже нет —
 *     группа забывается, письмо считается недошедшим.
 */
import { ADS_OFF } from './app.js';
import { esc, num } from './fmt.js';

/** Восемь писем в секунду — впятеро ниже потолка Telegram. */
export const SEND_GAP_MS = 125;
/** В группы — одно сообщение в три секунды: двадцать в минуту, с запасом от лимитов. */
export const GROUP_GAP_MS = 3_000;
/** Пропущенная из-за простоя рассылка старше суток не уходит: новость скисла. */
export const STALE_MS = 24 * 60 * 60_000;
/** Дальше Telegram всё равно обрежет, а читать такое письмо никто не станет. */
export const MAX_TEXT = 3000;
export const AUDIENCES = {
  all: 'все, кто нажимал Start',
  week: 'заходили за 7 дней',
  sleep: 'не заходили больше 7 дней',
  groups: 'все группы, где есть бот',
};
const isGroups = (audience) => audience === 'groups';
/**
 * Бота в группе нет (удалили, группы больше нет) — это не сбой, а ответ.
 *
 * «Нет прав писать» сюда НЕ входит: бот в группе остаётся, ему лишь
 * временно запретили сообщения («писать могут только админы»). Раньше такой
 * отказ на рассылку сносил все игры группы вместе с идущими партиями
 * (аудит, G-01). Настоящее удаление бота приходит отдельным my_chat_member.
 */
const NOT_THERE = /kicked|not a member|chat not found|group chat was deactivated|bot is not a member|Forbidden/i;

/**
 * Чего в рассылке не будет. Обещание из docs/prod.md: запрет стоит в самой
 * админке, а не в договорённости с собой. Рядом с покером казино и ставки
 * юридически опасны — особенно в России.
 */
export const BANNED = [
  'казино', 'casino', 'ставки на спорт', 'букмекер', 'бетт', 'bet365', '1xbet', '1хбет',
  'слоты', 'рулетк', 'фрибет', 'бонус на депозит', 'прогнозы на матч',
];

export const ERRORS = {
  EMPTY: 'Пустое письмо отправить нельзя.',
  LONG: `Слишком длинно: не больше ${MAX_TEXT} знаков.`,
  BAD_URL: 'Ссылка должна начинаться с https://',
  BAD_BUTTON: 'У кнопки есть текст, но нет ссылки (или наоборот).',
  BAD_TIME: 'Время отправки уже прошло.',
  BAD_AUDIENCE: 'Такой аудитории нет.',
  NO_ONE: 'Некому отправлять: в этой аудитории никого нет.',
  BUSY: 'Одна рассылка уже идёт — дождитесь её конца.',
  NO_CAST: 'Такой рассылки нет.',
  DONE: 'Эта рассылка уже ушла — вернуть её нельзя.',
};

/** Найти запрещённое слово. Возвращает само слово — чтобы отказ был понятен. */
export function bannedWord(text) {
  const low = String(text).toLowerCase();
  return BANNED.find((w) => low.includes(w)) || null;
}

/** Проверить письмо до того, как оно уйдёт тысяче человек. */
export function checkCast({ text, btnText = '', btnUrl = '', audience = 'all', at = 0, now = 0 } = {}) {
  const body = String(text || '').trim();
  if (!body) return { error: 'EMPTY' };
  if (body.length > MAX_TEXT) return { error: 'LONG' };
  const word = bannedWord(body);
  if (word) {
    return {
      error: 'BANNED',
      text: `Про это рассылать нельзя: «${word}». Казино, ставки и букмекеры рядом с карточными играми юридически опасны — ` +
        'запрет вшит в админку, снять его можно только правкой кода.',
    };
  }
  if (!AUDIENCES[audience]) return { error: 'BAD_AUDIENCE' };
  const t = String(btnText || '').trim();
  const u = String(btnUrl || '').trim();
  if (!!t !== !!u) return { error: 'BAD_BUTTON' };
  if (u && !/^https:\/\/\S+$/i.test(u)) return { error: 'BAD_URL' };
  // Минута назад — это «сейчас» (пока дошло нажатие), а вот вчера — уже нет.
  if (at && now && at < now - 60_000) return { error: 'BAD_TIME' };
  return { ok: true, text: body, btnText: t || null, btnUrl: u || null, audience, at: at || now };
}

export class Broadcaster {
  /**
   * @param app     игровой App: его личка, его часы, его база
   * @param onDone  куда сообщить, что рассылка кончилась (админ-бот)
   */
  constructor({ app, onDone = null } = {}) {
    this.app = app;
    this.onDone = onDone;
    /** id рассылки, которая идёт прямо сейчас, — одна за раз. */
    this.busy = null;
    /**
     * Группы, переехавшие в супергруппу посреди рассылки: письмо по новому id
     * уже ушло, а новый id может стоять в списке дальше курсора — второй раз
     * туда не писать. (Живёт в памяти: перезапуск ровно в эту минуту — самое
     * большее одно повторное письмо в одну группу.)
     */
    this.moved = new Map();
  }

  get store() {
    return this.app.store;
  }

  /* --------------------------------------------------------------- планы */

  /**
   * Запланировать рассылку. Возвращает строку из базы или отказ — ни одного
   * письма к этому моменту ещё не ушло.
   */
  plan(input = {}) {
    const now = this.app.clock.now();
    const ok = checkCast({ ...input, now });
    if (ok.error) return ok;
    const people = this.recipients(ok.audience, { now });
    if (!people.length) return { error: 'NO_ONE' };
    const row = this.store.addBroadcast({
      at: ok.at, text: ok.text, btnText: ok.btnText, btnUrl: ok.btnUrl,
      audience: ok.audience, total: people.length, createdAt: now,
    });
    this.arm(row);
    return row;
  }

  /** Таймер на назначенное время. Уже пора — уходит сразу. */
  arm(row) {
    const wait = Math.max(0, Number(row.at) - this.app.clock.now());
    this.app.after(`cast:${row.id}`, String(row.at), wait, () => this.run(row.id));
  }

  /**
   * Отмена. Ушедшие письма не вернуть — говорим честно, сколько успело уйти.
   */
  cancel(id) {
    const row = this.store.broadcast(id);
    if (!row) return { error: 'NO_CAST' };
    if (row.status === 'done' || row.status === 'canceled') return { error: 'DONE' };
    const out = this.store.patchBroadcast(id, { status: 'canceled', done_at: this.app.clock.now() });
    this.app.hub?.pushAdmins();
    return out;
  }

  /**
   * Что накопилось, пока бот лежал. Свежее уходит, скисшее отменяется с
   * объяснением: рассылать вчерашнюю новость хуже, чем не рассылать.
   */
  resume() {
    const now = this.app.clock.now();
    const out = { sending: 0, stale: 0 };
    for (const row of this.store.pendingBroadcasts()) {
      if (now - row.at > STALE_MS) {
        this.store.patchBroadcast(row.id, { status: 'canceled', done_at: now, note: 'не ушла: бот был выключен больше суток' });
        out.stale += 1;
        continue;
      }
      this.arm(row);
      out.sending += 1;
    }
    return out;
  }

  /* ------------------------------------------------------------ отправка */

  /**
   * Кому: людям из аудитории — или группам. Группы — все, о которых бот знает
   * (куда его добавили, где играли), по порядку id: курсор рассылки — id
   * последней группы, как у людей.
   */
  recipients(audience, { now = this.app.clock.now(), after = null, limit = 0 } = {}) {
    if (!isGroups(audience)) return this.store.audience(audience, { now, after, limit });
    const ids = new Set([...this.app.groups.keys(), ...this.store.roomChats(), ...[...this.app.rooms.values()].map((r) => r.chatId)]);
    const all = [...ids].filter((id) => /^-\d+$/.test(id) && (after == null || id > String(after))).sort();
    return limit ? all.slice(0, limit) : all;
  }

  keyboard(row) {
    const rows = [];
    if (row.btn_url) rows.push([{ text: row.btn_text || 'Открыть', url: row.btn_url }]);
    // Отписка — в каждом письме в личку, всегда последней строкой. В группах
    // её нет: надоело — группа удаляет бота.
    if (!isGroups(row.audience)) rows.push([{ text: '🔕 Не присылать такое', callback_data: ADS_OFF }]);
    return rows;
  }

  /** Одно письмо. Заблокировал бота — отмечаем и больше не пробуем. */
  async one(userId, row) {
    if (isGroups(row.audience)) return this.toGroup(userId, row);
    const r = await this.app.outbox.dm(userId, row.text, this.keyboard(row));
    if (r.ok) return true;
    if (r.forbidden) this.app.setDm(userId, 'fail', { redraw: false });
    return false;
  }

  /**
   * Одно сообщение в группу. Группа стала супергруппой — у неё новый id:
   * переезжаем вслед за ней и пробуем ещё раз. Бота там уже нет — забываем
   * группу, чтобы следующая рассылка туда не стучалась.
   */
  async toGroup(chatId, row, retried = false) {
    try {
      const m = await this.app.outbox.post(chatId, row.text, this.keyboard(row));
      // Сообщение легло поверх карточки стола: пусть ядро знает, что она «закопана».
      this.app.seenInChat(chatId, m?.message_id);
      return true;
    } catch (err) {
      const to = err?.parameters?.migrate_to_chat_id;
      if (to && !retried) {
        await this.app.migrate(String(chatId), String(to));
        if (row.id != null) {
          if (!this.moved.has(row.id)) this.moved.set(row.id, new Set());
          this.moved.get(row.id).add(String(to));
        }
        return this.toGroup(String(to), row, true);
      }
      if (NOT_THERE.test(String(err?.description ?? err?.message ?? '')) || err?.error_code === 403) {
        this.app.leftChat(String(chatId));
        return false;
      }
      throw err;
    }
  }

  /** Письмо только себе — посмотреть, как оно выглядит, прежде чем его увидят все. */
  async test(userId, input = {}) {
    const ok = checkCast({ ...input, now: this.app.clock.now() });
    if (ok.error) return ok;
    // Себе — в личку, но с теми же кнопками, что увидят получатели.
    const r = await this.app.outbox.dm(userId, ok.text, this.keyboard({ btn_text: ok.btnText, btn_url: ok.btnUrl, audience: ok.audience }));
    return r.ok ? { ok: true } : { error: 'NO_DM', text: 'Не дошло: нажмите Start у игрового бота.' };
  }

  /**
   * Рассылка идёт шагами по одному письму, каждый — на таймере приложения.
   *
   * Не циклом со сном внутри: между письмами бот должен быть свободен —
   * вести столы, отвечать на кнопки, принимать ходы. Шаг на таймере это и
   * даёт, а заодно делает темп видимым: один шаг — одно письмо, пауза между
   * шагами — единственное, что стоит между рассылкой и лимитом Telegram.
   */
  async run(id) {
    const row = this.store.broadcast(id);
    if (!row || (row.status !== 'scheduled' && row.status !== 'sending')) return;
    if (this.busy && this.busy !== Number(id)) {
      // Вторая рассылка ждёт своей очереди, а не гонится с первой за лимитом.
      return void this.later(id, 5_000, `queue:${this.app.clock.now()}`);
    }
    this.busy = Number(id);
    this.store.patchBroadcast(id, { status: 'sending', started_at: row.started_at || this.app.clock.now() });
    this.app.hub?.pushAdmins();
    return this.step(id);
  }

  /**
   * Следующий шаг рассылки — после паузы. Шаг дожидается отправки одного
   * письма и ставит следующий таймер, и только: цепочка не держит внутри себя
   * все письма сразу, а часы (в тестах — поддельные) могут её прокрутить.
   */
  later(id, ms, key) {
    this.app.after(`cast:${id}`, key, ms, () => this.step(id));
  }

  /** Одно письмо и заявка на следующее. Конец — когда получателей больше нет. */
  async step(id) {
    const row = this.store.broadcast(id);
    if (!row) return;
    if (row.status === 'canceled') return this.finish(id, true);
    if (row.status !== 'sending') return;
    this.busy = Number(id);

    const [uid] = this.recipients(row.audience, { now: this.app.clock.now(), after: row.cursor, limit: 1 });
    if (!uid) return this.finish(id, false);
    if (this.moved.get(row.id)?.has(uid)) {
      // Уже получила — под старым id, до переезда.
      this.store.patchBroadcast(id, { cursor: uid });
      return this.step(id);
    }

    let { sent = 0, failed = 0 } = row;
    try {
      if (await this.one(uid, row)) sent += 1;
      else failed += 1;
    } catch (err) {
      this.app.log(err);
      failed += 1;
    }
    this.store.patchBroadcast(id, { sent, failed, cursor: uid });
    this.app.hub?.pushAdmins();
    this.later(id, isGroups(row.audience) ? GROUP_GAP_MS : SEND_GAP_MS, `next:${uid}`);
  }

  async finish(id, canceled) {
    const out = this.store.patchBroadcast(id, {
      status: canceled ? 'canceled' : 'done',
      done_at: this.app.clock.now(),
    });
    if (this.busy === Number(id)) this.busy = null;
    this.moved.delete(out?.id ?? Number(id));
    this.app.hub?.pushAdmins();
    if (this.onDone) await this.onDone(out);
    return out;
  }

  /* -------------------------------------------------------------- отчёты */

  list(limit = 10) {
    return this.store.broadcasts(limit).map((r) => castView(r));
  }

  /** Сколько человек в каждой аудитории — видно ещё до того, как писать текст. */
  sizes() {
    const now = this.app.clock.now();
    const out = {};
    for (const kind of Object.keys(AUDIENCES)) out[kind] = this.recipients(kind, { now }).length;
    return out;
  }
}

/** Строка рассылки в том виде, в каком её показывает админка. */
export function castView(r) {
  return {
    id: r.id,
    at: r.at,
    text: r.text,
    btnText: r.btn_text || null,
    btnUrl: r.btn_url || null,
    audience: r.audience,
    status: r.status,
    total: r.total || 0,
    sent: r.sent || 0,
    failed: r.failed || 0,
    note: r.note || null,
  };
}

/** Итог рассылки словами — для письма владельцу. */
export function castReport(r) {
  const v = castView(r);
  const head = v.status === 'canceled' ? '⏹ <b>Рассылка остановлена</b>' : '📣 <b>Рассылка ушла</b>';
  return [
    head,
    `Дошло: ${num(v.sent)} из ${num(v.total)}` + (v.failed
      ? ` · не дошло: ${num(v.failed)} (${v.audience === 'groups' ? 'бота уже нет в группе' : 'заблокировали бота'})`
      : ''),
    '',
    `<i>${esc(v.text.slice(0, 200))}${v.text.length > 200 ? '…' : ''}</i>`,
  ].join('\n');
}
