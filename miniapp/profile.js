/**
 * Профиль игрока: круг-аватар и экран настроек (ник и аватар из готового набора).
 *
 * Профиль — только то, как человека ВИДНО. Кто он и что ему можно, решает
 * Telegram на сервере; страница лишь просит «покажи меня так» и читает ответ.
 *
 *   avatarEl(player, cls)            круг: картинка из набора или инициал
 *   renderProfileSettings(container) экран «Профиль» (его вызывает вкладка «Настройки»)
 */
import { h, avatar, haptic, toast } from './ui.js';
import { bus, send } from './net.js';
import { frameOn } from './cosmetics/apply.js';

/** Круг игрока: `player` — {name, hue, avatar} из вида стола. Картинку берёт только по шаблону avNN. */
export const avatarEl = (player, cls = '') => {
  const av = avatar(player?.name, player?.hue ?? 0, cls, player?.avatar ?? null);
  return player?.isMe ? frameOn(av) : av; // рамка из примерки — только у вашего круга
};

const NICK_MAX_DEFAULT = 16;

/** Что знаем о своём профиле: ответ сервера, черновик на экране, отказ под полем. */
const st = { profile: null, nick: '', avatar: null, error: null, asked: false, patch: null };

bus.onProfile = (msg) => {
  if (msg.error) {
    st.error = msg.error.text || 'Не получилось сохранить.';
    st.justSaved = false;
    haptic.err?.();
  } else if (msg.profile) {
    const first = !st.profile;
    st.profile = msg.profile;
    st.error = null;
    if (first || st.justSaved) {
      st.nick = msg.profile.nickname ?? '';
      st.avatar = msg.profile.avatar ?? null;
    }
    if (st.justSaved) toast('Профиль сохранён');
    st.justSaved = false;
  }
  st.patch?.();
};

let mounted = null; // { container, root } — уже нарисованный экран

export function renderProfileSettings(container) {
  // Экран перерисовывают на каждое новое состояние; поле ввода при этом терять нельзя
  // (фокус, набранный текст, прокрутка) — если он уже на месте, только обновим.
  if (mounted && mounted.container === container && container.firstChild === mounted.root) return st.patch?.();
  const max = st.profile?.max ?? NICK_MAX_DEFAULT;
  const ask = () => { if (!st.asked) { st.asked = true; send({ t: 'profile' }, { lock: false }); } };
  ask();

  const nickIn = h('input.k-input.pf-input', {
    type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'sentences', spellcheck: 'false',
    maxlength: String(max), 'aria-label': 'Ник', 'aria-describedby': 'pf-err', placeholder: 'Имя из Telegram',
  });
  nickIn.value = st.nick;
  const count = h('div.pf-count');
  const err = h('div.k-error.pf-err', { id: 'pf-err', role: 'alert' });
  const previewAv = h('div.pf-prev-av');
  const previewName = h('div.pf-prev-name');
  const save = h('button.k-btn.k-btn--primary.pf-save', { type: 'button' }, 'Сохранить');
  const reset = h('button.k-btn.k-btn--secondary.pf-reset', { type: 'button' }, 'Сбросить к имени из Telegram');
  const grid = h('div.pf-grid', { role: 'radiogroup', 'aria-label': 'Аватар' });

  const tgName = () => st.profile?.telegramName ?? '';
  const draftName = () => nickIn.value.replace(/\s+/g, ' ').trim() || tgName() || 'Игрок';
  const dirty = () => (nickIn.value.replace(/\s+/g, ' ').trim() || null) !== (st.profile?.nickname ?? null) || st.avatar !== (st.profile?.avatar ?? null);

  const cell = (id, label) => {
    const on = st.avatar === id;
    const face = id
      ? avatar(draftName(), 200, 'pf-cell-av', id)
      : h('div.av.pf-cell-av.pf-none', { style: { '--h': 200 } }, (draftName()[0] || '?').toUpperCase());
    return h(`button.pf-cell${on ? '.on' : ''}`, {
      type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', 'aria-label': label,
      tabindex: on ? '0' : '-1',
      onkeydown: (e) => {
        const ids = [null, ...(st.profile?.avatars ?? [])];
        const at = ids.indexOf(id);
        const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (delta == null && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : (at + delta + ids.length) % ids.length;
        st.avatar = ids[next]; st.error = null; patch();
        grid.children[next]?.focus({ preventScroll: true });
      },
      onclick: () => { st.avatar = id; haptic.soft?.(); st.error = null; patch(); },
    }, face, on ? h('span.pf-check', '✓') : null);
  };

  function patch() {
    count.textContent = `${[...nickIn.value].length} / ${max}`;
    err.textContent = st.error || '';
    nickIn.setAttribute('aria-invalid', st.error ? 'true' : 'false');
    previewAv.replaceChildren(avatar(draftName(), 200, '', st.avatar));
    previewName.textContent = draftName();
    save.disabled = !dirty() || !st.profile;
    reset.disabled = !st.profile?.nickname;
    const ids = st.profile?.avatars ?? [];
    const focused = [...grid.children].indexOf(document.activeElement);
    grid.replaceChildren(cell(null, 'Без аватара'), ...ids.map((id, i) => cell(id, `Аватар ${i + 1}`)));
    if (focused >= 0) grid.children[focused]?.focus({ preventScroll: true });
  }
  st.patch = () => { if (container.isConnected) { if (st.profile && document.activeElement !== nickIn) nickIn.value = st.nick; patch(); } };

  nickIn.addEventListener('input', () => { st.nick = nickIn.value; st.error = null; patch(); });
  nickIn.addEventListener('focus', () => {
    // Клавиатура поднимается и сжимает экран: поле и кнопки должны остаться на виду.
    const keep = () => wrap.scrollIntoView({ block: 'center', behavior: 'auto' });
    keep();
    window.visualViewport?.addEventListener('resize', keep);
    nickIn.addEventListener('blur', () => window.visualViewport?.removeEventListener('resize', keep), { once: true });
  });
  nickIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
  save.addEventListener('click', () => {
    st.justSaved = true;
    st.error = null;
    send({ t: 'profile', nickname: nickIn.value, avatar: st.avatar }, { lock: false });
  });
  reset.addEventListener('click', () => {
    st.justSaved = true;
    nickIn.value = '';
    st.error = null;
    send({ t: 'profile', nickname: '' }, { lock: false });
  });

  const wrap = h('div.pf-edit',
    h('label.pf-label', { for: 'pf-nick' }, 'Ник'),
    h('div.pf-field', nickIn, count),
    err,
    h('div.pf-actions', save, reset));
  nickIn.id = 'pf-nick';

  const root = h('div.pf',
    h('h2.k-section', 'Профиль'),
    h('div.pf-prev', h('div.pf-prev-cap', 'Так вас увидят за столом'), h('div.pf-prev-row', previewAv, previewName)),
    wrap,
    h('div.pf-label', 'Аватар'),
    grid,
    h('div.k-caption.pf-note', 'Ник и аватар видят все игроки за столом и в группе. Они меняют только то, как вас показывают: кто вы и что вам можно, определяет Telegram.'));
  container.replaceChildren(root);
  mounted = { container, root };
  patch();
}
