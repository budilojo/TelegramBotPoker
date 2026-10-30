/**
 * payments: все тексты покупок по-русски (перечислены в MESSAGES.md, раздел «Покупки»).
 * Чистый модуль: его читают и сервер, и клиент (через miniapp/collections/pay-protocol.js).
 */
export { PAY_ERRORS, PRECHECKOUT } from '../../miniapp/collections/pay-protocol.js';

export const DM = {
  paid: (title, order) => `✅ <b>Куплено: ${title}</b>\nЗаказ <code>${order}</code>. Вещь уже в вашей коллекции — наденьте её в «Настройки» → «Коллекции».`,
  review: (order) => `Оплата получена, но в ней есть несоответствие (заказ <code>${order}</code>). Ничего не выдано; владелец проверит и вернёт звёзды. Вопросы — /paysupport.`,
  duplicate: (order) => `Этот заказ (<code>${order}</code>) уже был оплачен. Повторная оплата будет возвращена владельцем. Вопросы — /paysupport.`,
  refunded: (title, order) => `↩️ Возврат по заказу <code>${order}</code> (${title}) выполнен. Вещь убрана из коллекции.`,
  button: '🎨 Открыть коллекцию',
};

/** Ответ на /paysupport. Контакт задаёт владелец (PAY_SUPPORT); без него — честно, что продажи не открыты. */
export function supportText({ contact, orders, esc }) {
  const lines = ['🛟 <b>Поддержка покупок</b>'];
  if (contact) lines.push(`Напишите: ${esc(contact)}`, 'Назовите номер заказа — он ниже.');
  else lines.push('Продажи ещё не открыты, контакт поддержки появится к их открытию.');
  if (orders.length) {
    lines.push('', '<b>Ваши покупки:</b>');
    for (const o of orders.slice(0, 10)) lines.push(`• <code>${o.id}</code> — ${esc(o.title)}, ${o.price} ⭐, ${o.stateText}`);
  } else lines.push('', 'Покупок у вас нет.');
  lines.push('', 'Возврат при ошибке, двойной оплате или если вещь не появилась — полностью, звёздами. Правила возврата и условия — /terms.');
  lines.push('Мы никогда не просим пароли, коды из СМС, данные карты или перевод звёзд «для возврата».');
  return lines.join('\n');
}

export const STATE_TEXT = {
  paid: 'оплачен, вещь выдана',
  refunded: 'возвращён',
  refund_pending: 'возврат в обработке',
  review: 'на проверке у владельца',
};

/** /paysupport и /terms в группе: покупки — личное, ответ только в личке. */
export const PAY_IN_DM = (bot) => `🛟 Поддержка покупок и условия — в личке с ботом: откройте @${bot} и напишите /paysupport или /terms.`;

/** /terms в личке: версии и статус документов. Пока документы — проекты, так и пишем. */
export function termsText({ docs, esc }) {
  const names = { 'terms-of-purchase.md': 'Условия покупки', 'refund-rules.md': 'Правила возврата', 'privacy-policy.md': 'Политика данных' };
  const lines = ['📄 <b>Документы</b>'];
  for (const [f, d] of Object.entries(docs)) {
    const st = d.missing ? 'нет' : d.ok ? `действует, версия ${esc(d.version)}` : 'проект, ещё не действует';
    lines.push(`• ${names[f] ?? f}: ${st}`);
  }
  const ready = Object.values(docs).every((d) => d.ok);
  lines.push('', ready ? 'Полный текст — в приложении: «Настройки» → «Коллекции» → вещь → «Условия покупки».'
    : 'Продажи не открыты: документы ещё готовятся и не опубликованы.');
  return lines.join('\n');
}
