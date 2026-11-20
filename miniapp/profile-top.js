/**
 * Верх вкладки «Профиль»: аватар и имя, свой ID с «Скопировать», заметная «Поддержка».
 * ID — только свой, из ответа сервера на `profile` (подписанный initData); чужого здесь взять неоткуда.
 */
import { h, avatar, haptic, toast, tg } from './ui.js';
import { onProfile } from './profile.js';

/** Кладёт текст в буфер; вернёт true, если получилось. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* запасной путь ниже */ }
  try {
    const ta = h('textarea', { 'aria-hidden': 'true', readonly: '', style: { position: 'fixed', opacity: '0', left: '-999px' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.('copy');
    ta.remove();
    return !!ok;
  } catch { return false; }
}

/** Открыть личку бота по `?start=support`; без метода Telegram — обычная ссылка. */
export function openSupport(bot) {
  const url = `https://t.me/${bot}?start=support`;
  if (typeof tg?.openTelegramLink === 'function') tg.openTelegramLink(url);
  else window.open(url, '_blank', 'noopener');
}

export function profileTop(s) {
  const idEl = h('span.pt-id');
  const copy = h('button.btn.sm.pt-copy', { type: 'button', 'data-act': 'copy-id', 'aria-label': 'Скопировать свой ID' }, 'Скопировать');
  const who = h('div.set-title.pt-name');
  const ava = h('div.pt-av');
  const root = h('section.set-block.pt',
    h('div.set-row.pt-card', ava, h('div.set-body', who, h('div.pt-idrow', 'Ваш ID ', idEl)), copy),
    s.bot ? h('div.set-row.col.pt-support',
      h('div.set-body',
        h('div.set-title', 'Поддержка'),
        h('div.set-sub', 'Вопрос или проблема — напишите боту, ответ придёт туда же. Пароли и коды не присылайте.')),
      h('button.btn.primary.pt-support-btn', { type: 'button', 'data-act': 'support', onclick: () => { haptic.tap?.(); openSupport(s.bot); } }, 'Написать в поддержку'),
      h('div.set-sub.pt-fallback', `Не открылось? Откройте бота @${s.bot}, нажмите «Старт» и отправьте /support.`)) : null);
  let id = '';
  copy.addEventListener('click', async () => {
    if (!id) return;
    haptic.tap?.();
    toast(await copyText(id) ? 'ID скопирован' : 'Не удалось скопировать. Ваш ID виден рядом — перепишите его.');
  });
  const paint = (p) => {
    id = p?.id ? String(p.id) : '';
    idEl.textContent = id || '…';
    copy.disabled = !id;
    const name = p?.shown || s.me?.name || 'Игрок';
    who.textContent = name;
    ava.replaceChildren(avatar(name, 200, 'pt-av-c', p?.avatar ?? s.me?.avatar ?? null));
  };
  paint(null);
  onProfile(paint);
  return root;
}
