/** Проверка спроса без платежей. Кто нажал — только из проверенной сессии. */
import { ITEMS, isItem } from '../miniapp/cosmetics/catalog.js';

export const PER_MINUTE = 30;
export const SHOP_ERRORS = {
  SHOP_OP: 'Такого действия в магазине нет.',
  SHOP_ITEM: 'Такой вещи в магазине нет.',
  SHOP_ACTION: 'Можно посмотреть вещь или нажать «Хочу».',
  SHOP_VARIANT: 'Цена изменилась — откройте магазин заново.',
  SHOP_FAST: 'Слишком много нажатий. Подождите минуту.',
  SHOP_CONFIRM: 'Подтвердите сброс своих отметок.',
};

// Telegram id — десятичная строка. Не переводим целиком в Number.
export const variantFor = (uid) => Number(String(uid).slice(-1)) % 2 === 0 ? 'a' : 'b';

export class Shop {
  constructor(app) { this.app = app; this.limits = new Map(); }

  handle(user, msg) {
    const uid = String(user.id);
    const variant = variantFor(uid);
    const store = this.app.store;
    const fail = (code) => ({ t: 'shop', error: { code, text: SHOP_ERRORS[code] } });
    const mine = () => ({ t: 'shop', variant, wanted: store.shopMine(uid), unlocked: this.app.cosmeticsUnlocked(uid) });
    // Лимит общий для всех вкладок человека, включая чтение, сброс и неверные запросы.
    const now = this.app.clock.now();
    for (const [id, times] of this.limits) if (!times.some((at) => now - at < 60_000)) this.limits.delete(id);
    const times = (this.limits.get(uid) || []).filter((at) => now - at < 60_000);
    if (times.length >= PER_MINUTE) return fail('SHOP_FAST');
    times.push(now);
    this.limits.set(uid, times);
    if (msg.op === 'mine') return mine();
    if (msg.op === 'reset') {
      if (msg.confirm !== true) return fail('SHOP_CONFIRM');
      store.shopReset(uid);
      return mine();
    }
    if (msg.op !== 'interest') return fail('SHOP_OP');
    if (!isItem(msg.item)) return fail('SHOP_ITEM');
    if (!['view', 'want'].includes(msg.action)) return fail('SHOP_ACTION');
    if (!['a', 'b'].includes(msg.variant) || msg.variant !== variant) return fail('SHOP_VARIANT');
    // Администраторы и тестеры уже владеют вещами: их нажатия не должны искажать спрос.
    if (this.app.cosmeticsUnlocked(uid)) return mine();
    store.shopInterest(uid, msg.item, variant, msg.action, now);
    return mine();
  }
}

/** Никаких личных строк: только агрегаты и известные id каталога. */
export function shopSummary(store) {
  const rows = store.shopTotals();
  return ITEMS.flatMap((item) => ['a', 'b'].map((variant) => {
    const row = rows.find((r) => r.item === item.id && r.variant === variant);
    const views = row?.views ?? 0;
    const wants = row?.wants ?? 0;
    return { item: item.id, variant, views, wants, percent: views ? Math.round(1000 * wants / views) / 10 : 0 };
  }));
}
