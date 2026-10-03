'use strict';
/**
 * Админ-бот — второй бот, отдельный от игрового.
 *
 * Зачем отдельный. У игрового бота в личке сидят все игроки: там нельзя ни
 * ответить лишнего, ни завести команду, про которую посторонним знать
 * незачем. У админского в личке только владелец. Его юзернейм можно никому
 * не давать, а если и найдут — он отвечает **только** тем, чей id стоит в
 * белом списке, и молчит всем остальным.
 *
 * Живёт в том же процессе, что и игра: ему нужны и цифры из базы, и то, что
 * происходит прямо сейчас в памяти. Отдельным процессом второго он бы не
 * увидел.
 *
 * Что он НЕ показывает даже владельцу: карты. Ни свои, ни чужие, ни сброс.
 * Обещание «никто не видит чужих карт» не знает исключений — иначе это не
 * обещание. Имена игроков тоже не выводятся: для «какая игра зависла»
 * хватает названия группы и кода.
 */
import { esc, num } from './fmt.js';
import { gameOf } from './games/index.js';
import { identify } from './identity.js';
import { parseCommand } from './app.js';

/** Не чаще одного письма об ошибках в минуту — иначе упавший бот завалит личку. */
export const ERROR_QUIET_MS = 60_000;

const HELP = [
  '🛠 <b>Админка</b>',
  '',
  '/stats — цифры: люди, партии, группы',
  '/now — что идёт прямо сейчас',
  '/stop &lt;код&gt; — завершить игру и выложить итоги',
  '/pause &lt;текст&gt; — обслуживание: игра замирает, у всех экран с текстом',
  '/resume — снять обслуживание, часы пойдут с того же места',
  '/stopall да — завершить ВСЕ игры с итогами в группы',
  '/health — как себя чувствует бот',
  '',
  'Кнопка под /stats открывает пульт экраном: сессии, рассылки, обслуживание.',
].join('\n');

export class AdminBot {
  /**
   * @param api        порт Telegram (bot.api или стаб)
   * @param app        игровой App: цифры, живые комнаты, завершение игры
   * @param webappUrl  публичный адрес — для кнопки на экран админки
   */
  constructor({ api, app, webappUrl = '', botUsername = '', onError = null } = {}) {
    this.api = api;
    this.app = app;
    this.botUsername = botUsername;
    this.webappUrl = String(webappUrl || '').replace(/\/+$/, '');
    this.log = onError || ((err) => console.error('[админ]', err?.description || err?.message || err));
    /** Сколько ошибок проглочено с последнего письма и когда оно было. */
    this.errors = { at: 0, held: 0, last: null };
  }

  get admins() {
    return this.app.admins;
  }

  /* ------------------------------------------------------------- отправка */

  async send(userId, text, keyboard = null) {
    try {
      return await this.api.sendMessage(String(userId), text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
    } catch (err) {
      // 403 — владелец не нажал Start у админ-бота. Это не поломка.
      if (err?.error_code !== 403) this.log(err);
      return null;
    }
  }

  /** Написать всем из белого списка. */
  async notify(text) {
    for (const id of this.admins) await this.send(id, text);
  }

  /**
   * Бот споткнулся. Письма склеиваются: подряд идущие ошибки превращаются в
   * одно сообщение с числом, а не в сто одинаковых.
   */
  async onAppError(err) {
    const now = this.app.clock.now();
    const text = String(err?.description ?? err?.message ?? err).slice(0, 300);
    this.errors.last = text;
    if (now - this.errors.at < ERROR_QUIET_MS) {
      this.errors.held += 1;
      return;
    }
    const held = this.errors.held;
    this.errors = { at: now, held: 0, last: text };
    await this.notify(`⚠️ <b>Ошибка</b>\n<code>${esc(text)}</code>` + (held ? `\n\n<i>и ещё ${held} за последнюю минуту</i>` : ''));
  }

  /* --------------------------------------------------------------- приём */

  async handleUpdate(update) {
    try {
      const msg = update.message;
      if (!msg || msg.chat?.type !== 'private' || typeof msg.text !== 'string') return;
      const who = identify(msg.from, msg.sender_chat);
      if (!who.ok) return;

      // Белый список — единственная дверь. Посторонним бот не отвечает
      // вообще: ни «нет доступа», ни справки. Чтобы понять, что он живой,
      // надо уже быть в списке.
      if (!this.app.isAdmin(who.user.id)) {
        console.warn(`[админ] не из списка: id ${who.user.id} (${who.user.name})`);
        return;
      }

      const cmd = parseCommand(msg.text, this.botUsername);
      switch (cmd?.cmd) {
        case 'stats':
        case 'admin':
          return void (await this.send(who.user.tgId, this.statsText(), this.screenButton()));
        case 'now':
        case 'games':
          return void (await this.send(who.user.tgId, this.nowText()));
        case 'stop':
          return void (await this.stop(who.user, cmd.rest));
        case 'pause':
          return void (await this.pause(who.user, cmd.rest));
        case 'resume':
          return void (await this.resume(who.user));
        case 'stopall':
          return void (await this.stopAll(who.user, cmd.rest));
        case 'health':
          return void (await this.send(who.user.tgId, this.healthText()));
        default:
          return void (await this.send(who.user.tgId, HELP));
      }
    } catch (err) {
      this.log(err);
    }
  }

  /** Кнопка на экран с графиками. В личке `web_app` разрешён — регистрировать приложение не нужно. */
  screenButton() {
    if (!this.webappUrl) return null;
    return [[{ text: '📊 Открыть пульт', web_app: { url: `${this.webappUrl}/?room=admin` } }]];
  }

  /* -------------------------------------------------------- обслуживание */

  /**
   * «Всё стоп». Часы замирают: время на ход не тратится, пока идёт
   * обслуживание, — иначе простой съел бы чужой ход.
   */
  async pause(user, rest) {
    const was = this.app.down;
    const m = this.app.setMaintenance(true, rest);
    const live = this.app.liveNow();
    await this.send(
      user.tgId,
      `⏸ <b>${was ? 'Обслуживание продолжается' : 'Обслуживание включено'}</b>\n` +
        `Игры замерли: ${num(live.playing)} идёт, ${num(live.lobbies)} лобби. Время на ход не тратится.\n` +
        `Игрокам: <i>${esc(m.text || this.app.downText)}</i>\n\n` +
        'Снять — /resume. Завершить все игры с итогами — /stopall да.'
    );
  }

  async resume(user) {
    if (!this.app.down) return void (await this.send(user.tgId, 'Обслуживание и так не включено.'));
    this.app.setMaintenance(false);
    await this.send(user.tgId, '▶️ <b>Обслуживание снято</b>\nЧасы пошли с того же места, столы на месте.');
  }

  /**
   * Завершить всё. Требует слова «да» рядом: одна опечатка не должна
   * закрывать чужие игры.
   */
  async stopAll(user, rest) {
    if (String(rest || '').trim().toLowerCase() !== 'да') {
      const live = this.app.liveNow();
      return void (await this.send(
        user.tgId,
        `Это завершит ВСЕ игры (${num(live.playing + live.lobbies)}) и выложит итоги в группы. ` +
          'Отменить будет нельзя. Если правда надо: <code>/stopall да</code>'
      ));
    }
    const n = await this.app.stopAll();
    await this.send(user.tgId, n ? `🏁 Завершено игр: ${num(n)}. Итоги ушли в группы.` : 'Живых игр не было.');
  }

  /* --------------------------------------------------------------- тексты */

  statsText() {
    const s = this.app.store.stats(this.app.clock.now());
    const live = this.app.liveNow();
    return renderStats(s, live);
  }

  nowText() {
    return renderNow(this.app);
  }

  healthText() {
    const up = Math.round(process.uptime());
    const mb = Math.round(process.memoryUsage().rss / 1048576);
    const lines = [
      '💚 <b>Бот жив</b>',
      `Работает: ${hms(up)}`,
      `Память: ${num(mb)} МБ`,
      `Игр в памяти: ${num(this.app.rooms.size)} · групп: ${num(this.app.groups.size)}`,
      `Адрес: ${this.app.webappUrl ? esc(this.app.webappUrl) : '<i>не задан</i>'}`,
    ];
    if (this.app.down) lines.unshift('⏸ <b>Идёт обслуживание</b> — игра стоит. Снять: /resume', '');
    const cast = this.app.casts?.busy ? this.app.casts.store.broadcast(this.app.casts.busy) : null;
    if (cast) lines.push(`Рассылка идёт: ${num(cast.sent)} из ${num(cast.total)}`);
    if (this.errors.last) lines.push('', `Последняя ошибка: <code>${esc(this.errors.last)}</code>`);
    return lines.join('\n');
  }

  /**
   * Завершить игру по коду. Единственное место, где бот делает что-то за
   * хозяина комнаты, — и делает это владелец, у себя в личке, назвав точный
   * код. Игроки увидят обычные итоги, а не пропавший стол.
   */
  async stop(user, rest) {
    const code = String(rest || '').trim();
    if (!code) return void (await this.send(user.tgId, 'Нужен код игры: <code>/stop abc123</code>. Коды — в /now.'));
    const room = this.app.roomByCode(code);
    if (!room) return void (await this.send(user.tgId, 'Такой игры нет. Коды — в /now.'));
    if (room.status === 'finished') return void (await this.send(user.tgId, 'Эта игра уже завершена.'));
    const g = gameOf(room);
    const r = g.endGame(room, room.hostId);
    if (r.error) return void (await this.send(user.tgId, `Не вышло: ${esc(r.error)}`));
    await this.app.finishUp(room);
    await this.send(user.tgId, `${g.icon} Игра <code>${esc(code)}</code> завершена, итоги ушли в группу.`);
  }
}

/* ------------------------------------------------------------- рендеры */

const hms = (sec) => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return [d && `${d} д`, (d || h) && `${h} ч`, `${m} мин`].filter(Boolean).join(' ');
};

/** Строка вида «12 → 18» со стрелкой, когда есть с чем сравнить. */
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

export function renderStats(s, live) {
  const p = s.people;
  const g = s.groups;
  const byGame = Object.entries(s.week.byGame).sort((a, b) => b[1].rounds - a[1].rounds);
  const icon = { poker: '♠️', durak: '🃏' };
  return [
    `📊 <b>Цифры</b> · ${s.day}`,
    '',
    '<b>Сейчас</b>',
    `В приложении: ${num(live.online)} · игр идёт: ${num(live.playing)} · лобби: ${num(live.lobbies)}`,
    '',
    '<b>Люди</b>',
    `Всего: ${num(p.total)} · сегодня: ${num(p.today)} (новых ${num(p.fresh)}) · за неделю: ${num(p.week)}`,
    `Вернулись: ${pct(p.returned, p.yesterday)} — ${num(p.returned)} из ${num(p.yesterday)} вчерашних`,
    '',
    '<b>Партии</b>',
    `Сегодня: ${num(s.today.rounds)} в ${num(s.today.games)} играх`,
    `За неделю: ${num(s.week.rounds)} в ${num(s.week.games)} играх`,
    `Лобби собрано: ${num(s.week.created)} · доиграно до итогов: ${num(s.week.finished)}`,
    ...(byGame.length ? ['', ...byGame.map(([id, v]) => `${icon[id] || '·'} ${id}: ${num(v.rounds)} партий, ${num(v.games)} игр`)] : []),
    '',
    `<b>Группы</b>: ${num(g.total)} всего, ${num(g.week)} активных за неделю`,
  ].join('\n');
}

/**
 * Что идёт прямо сейчас. Без имён игроков и без единой карты: чтобы понять,
 * какую игру снимать, хватает группы и кода.
 */
export function renderNow(app) {
  const head = app.down ? `⏸ <b>Идёт обслуживание</b> — игры замерли. Снять: /resume\n\n` : '';
  const rooms = [...app.rooms.values()].filter((r) => r.status !== 'finished');
  if (!rooms.length) return `${head}💤 Сейчас никто не играет.`;
  const playing = rooms.filter((r) => r.status === 'playing' || r.status === 'paused');
  const lobbies = rooms.filter((r) => !playing.includes(r));
  const line = (r) => {
    const g = gameOf(r);
    const s = g.summary(r);
    const where = r.title ? ` · ${esc(r.title)}` : '';
    return `${g.icon} <b>${g.title}</b>${where} · ${s.seated}/${s.max}${s.detail ? ` · ${esc(s.detail)}` : ''}\n   <code>${esc(r.code)}</code>`;
  };
  const out = [];
  if (head) out.push(head.trim(), '');
  if (playing.length) out.push(`▶️ <b>Идут: ${num(playing.length)}</b>`, ...playing.map(line));
  if (lobbies.length) {
    if (out.length) out.push('');
    out.push(`⏳ <b>Ждут игроков: ${num(lobbies.length)}</b>`, ...lobbies.map(line));
  }
  out.push('', '<i>Завершить: /stop и код.</i>');
  return out.join('\n');
}
