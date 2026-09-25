'use strict';
/**
 * WHO is acting. This is the entire security model of the bot.
 *
 * Telegram signs the sender of every update: `from.id` inside a
 * `callback_query` is the real account that pressed the button and a client
 * cannot forge it. So there are no tokens, no passwords and no confirmation
 * codes anywhere in this bot — there is only `from.id`, checked on the server
 * against whoever is allowed to act.
 *
 * The one case Telegram cannot identify is an anonymous administrator: their
 * updates arrive either from the shared `GroupAnonymousBot` account or with
 * `sender_chat` set instead of a real user. Two different people posting
 * anonymously are indistinguishable, so they are refused a seat outright
 * rather than handed a stack somebody else can spend.
 */

/** Every anonymous admin in every group shares this account. */
export const GROUP_ANONYMOUS_BOT_ID = 1087968824;
/** Posts made on behalf of a channel. */
export const CHANNEL_BOT_ID = 136817688;

const ANON_TEXT =
  'Анонимные админы играть не могут: бот не отличит вас от другого админа. ' +
  'Отключите анонимность в настройках группы.';
const BOT_TEXT = 'Боты за стол не садятся.';

/**
 * @param from        update.*.from
 * @param senderChat  update.*.sender_chat
 * @returns {{ok:true, user:{id:string, tgId:number, name:string}}
 *          |{ok:false, reason:'ANON'|'BOT'|'NONE', text:string}}
 */
export function identify(from, senderChat) {
  // Anonymous admins and channel posts: `sender_chat` replaces the user.
  if (senderChat) return { ok: false, reason: 'ANON', text: ANON_TEXT };
  if (!from || typeof from.id !== 'number') {
    return { ok: false, reason: 'NONE', text: ANON_TEXT };
  }
  if (from.id === GROUP_ANONYMOUS_BOT_ID || from.id === CHANNEL_BOT_ID) {
    return { ok: false, reason: 'ANON', text: ANON_TEXT };
  }
  if (from.is_bot) return { ok: false, reason: 'BOT', text: BOT_TEXT };

  return {
    ok: true,
    user: {
      // The player id used by the engine IS the Telegram id. One account,
      // one seat — a second /join finds the same row instead of creating one.
      id: String(from.id),
      tgId: from.id,
      name: displayName(from),
    },
  };
}

/** `first_name` is the only field guaranteed to exist; @username is not. */
function displayName(from) {
  const first = String(from?.first_name ?? '').trim();
  if (first) return first;
  const uname = String(from?.username ?? '').trim();
  if (uname) return uname;
  return `Игрок ${from?.id ?? '?'}`;
}
