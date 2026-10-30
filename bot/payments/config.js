/**
 * payments: настройки продаж — что продаётся, почём и открыты ли продажи. Чистые функции, без сети.
 * Читается один раз при запуске (bot/index.js). Контракт — docs/next-release/payment-design.md, раздел 2.
 *
 * Главное правило: по умолчанию ЗАКРЫТО. Открыть настоящие продажи можно только `SALES_MODE=live`
 * и только когда выполнены все проверки `gate()`; иначе режим ведёт себя как `off` и называет причины.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ITEMS, itemById, itemsOfBundle } from '../../miniapp/collections/catalog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OFFERS_FILE = path.join(HERE, 'offers.json');
export const LEGAL_DIR = path.join(HERE, '..', '..', 'docs', 'next-release', 'legal');
/** Публичные документы, без которых продавать нельзя (У-1, У-2). */
export const LEGAL_DOCS = ['terms-of-purchase.md', 'refund-rules.md', 'privacy-policy.md'];

/** Цена в Stars: целое 1…10000. */
export const MAX_PRICE = 10_000;
export const isPrice = (x) => Number.isInteger(x) && x >= 1 && x <= MAX_PRICE;
/** В тестовой среде Telegram звёзды ненастоящие; цена без утверждения — 1 Star. */
export const TEST_PRICE = 1;

/** Что вообще можно продавать: только предметы и комплект «Графита» (О-1, О-13). */
export const SELLABLE = new Set(ITEMS.map((x) => x.id));

/** Прочитать offers.json как есть; повреждённый файл — пустые предложения (закрыто). */
export function readOffers(file = OFFERS_FILE) {
  try {
    return normalizeOffers(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return normalizeOffers(null);
  }
}

/** Только известные id каталога; цена — число или null. Ничего лишнего. */
export function normalizeOffers(raw) {
  const out = { approved: raw?.approved === true, terms: typeof raw?.terms === 'string' ? raw.terms : '', items: {}, hidden: [] };
  for (const id of SELLABLE) {
    const v = raw?.items?.[id];
    out.items[id] = isPrice(v) ? v : null;
  }
  // Скрытые владельцем в админке вещи (поверх файла, из базы): не продаются ни в каком режиме.
  if (Array.isArray(raw?.hidden)) out.hidden = raw.hidden.filter((id) => SELLABLE.has(id));
  return out;
}

/** Шапка документа: версия и статус. */
export function readDoc(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, missing: true, version: '', status: '', blanks: 0, text: '' }; }
  const version = /\*\*Версия:\*\*\s*([^\n,]+)/.exec(text)?.[1]?.trim() || '';
  const status = /\*\*Статус:\*\*\s*([^\n]+)/.exec(text)?.[1]?.trim() || '';
  const blanks = (text.match(/\[НЕ ЗАПОЛНЕНО/g) || []).length;
  return { ok: /^Действует(?![А-Яа-яЁё])/.test(status) && blanks === 0 && !!version, missing: false, version, status, blanks, text };
}

/**
 * Собрать настройки продаж из окружения процесса.
 * @param env  process.env (или подмена в тестах)
 */
export function salesConfig(env = {}, { offers = readOffers(), legalDir = LEGAL_DIR } = {}) {
  const raw = String(env.SALES_MODE ?? '');
  const testEnv = env.TG_TEST_ENV === '1';
  const mode = raw === 'live' ? 'live' : raw === 'test' ? 'test' : 'off';
  const support = String(env.PAY_SUPPORT ?? '').trim().slice(0, 200);
  const docs = Object.fromEntries(LEGAL_DOCS.map((f) => [f, readDoc(path.join(legalDir, f))]));
  const terms = docs['terms-of-purchase.md'].version || offers.terms || '';
  return { mode, testEnv, support, offers, docs, terms };
}

/**
 * Можно ли выставлять новые счета: `{ open, mode, reasons[] }`. Причины — по-русски, для владельца.
 * `stopped` — владелец остановил новые продажи (`/salesstop`), `down` — идёт обслуживание.
 */
export function gate(cfg, { stopped = false, down = false } = {}) {
  const reasons = [];
  if (cfg.mode === 'off') reasons.push('Режим продаж выключен (SALES_MODE не задан).');
  if (cfg.mode === 'test' && !cfg.testEnv) reasons.push('Тестовый режим разрешён только в тестовой среде Telegram (TG_TEST_ENV=1).');
  if (cfg.mode === 'live') {
    if (cfg.testEnv) reasons.push('Настоящие продажи нельзя открыть в тестовой среде Telegram.');
    if (!cfg.offers.approved) reasons.push('Цены не утверждены владельцем (offers.json: approved=false).');
    // Вещь без цены просто не продаётся (скрыта); закрыто всё — только если цены нет ни у одной.
    if (![...SELLABLE].some((id) => isPrice(cfg.offers.items[id]) && !isHidden(cfg, id))) reasons.push('Нет ни одной цены (или все вещи скрыты).');
    if (!cfg.support) reasons.push('Не задан публичный контакт поддержки (PAY_SUPPORT).');
    for (const [f, d] of Object.entries(cfg.docs)) {
      if (d.missing) reasons.push(`Нет документа ${f}.`);
      else if (!d.ok) reasons.push(`Документ ${f} не готов: ${d.blanks ? `${d.blanks} незаполненных полей` : `статус «${d.status || 'нет'}»`}.`);
    }
    if (cfg.offers.terms !== cfg.terms) reasons.push('Версия условий в offers.json не совпадает с документом.');
  }
  if (stopped) reasons.push('Новые продажи остановлены владельцем (/salesstop).');
  if (down) reasons.push('Идёт обслуживание.');
  return { open: reasons.length === 0, mode: cfg.mode, reasons };
}

/** Скрыл ли владелец вещь в админке. */
export const isHidden = (cfg, id) => !!cfg.offers.hidden?.includes(id);

/** Цена вещи для нового заказа в текущем режиме или null (не продаётся). */
export function priceOf(cfg, id) {
  if (!SELLABLE.has(id) || isHidden(cfg, id)) return null;
  const p = cfg.offers.items[id];
  if (cfg.mode === 'test') return isPrice(p) ? p : TEST_PRICE;
  if (cfg.mode === 'live') return cfg.offers.approved && isPrice(p) ? p : null;
  return null;
}

/** Состав заказа: предмет — он сам, комплект — его предметы. */
export const itemsOf = (id) => (itemById(id)?.kind === 'bundle' ? itemsOfBundle(id) : itemById(id) ? [id] : []);
