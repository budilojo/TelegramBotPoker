/**
 * Экраны «Определить уровень» (агент Y): три способа начать, короткая
 * диагностика, итог с ручной правкой, «по истории игр» и настройка журнала
 * решений. Логика — в `placement-core.js` (чистая, под тестами); здесь DOM.
 *
 *   showPlacement(root, ctx)         три карточки → диагностика / история → «Ваш уровень»
 *   renderDecisionSettings(el, ctx)  строка про журнал и «Удалить историю решений»
 *
 * ctx = {
 *   request(msg) → Promise<ответ>   отправить {t:'train', …} и дождаться ответа (по умолчанию — через net.js),
 *   bank { exercisesOf, instantiate } упражнения (engine.js V),
 *   runTask?(box, job, done)         показать задание не-`pick` вида (экран V); без него такие виды в диагностику не берутся,
 *   onDone(progress)                 уровни сохранены — идти в «Тренировку»,
 *   onExit?()                        выйти, ничего не меняя,
 * }
 *
 * Правила: экран не перестраивается от нажатия внутри (− / + правят текст на месте),
 * подсказок во время партии здесь нет — это отдельный режим, не стол (решение 016).
 */
import { h, haptic } from '../ui.js';
import { SKILLS, LEVELS } from './topics.js';
import * as Q from './placement-core.js';

// Свои стили подключаем сами: общий index.html — не в моей зоне.
(function addCss() {
  try {
    if (typeof document === 'undefined' || document.querySelector('link[data-placement-css]')) return;
    document.head.append(h('link', { rel: 'stylesheet', href: new URL('./placement.css', import.meta.url).href, 'data-placement-css': '1' }));
  } catch { /* без стилей экран остаётся рабочим */ }
})();

const skillTitle = (id) => SKILLS.find((s) => s.id === id)?.title || id;

async function defaultRequest(msg) {
  const { bus, send } = await import('../net.js');
  return new Promise((resolve) => {
    const prev = bus.onTrain;
    bus.onTrain = (m) => {
      prev?.(m);
      if (m.history || m.cleared != null || m.error || m.progress) {
        bus.onTrain = prev;
        resolve(m);
      }
    };
    send(msg, { lock: false });
  });
}

/** Шкала из пяти делений: заполнены до `level`. Правится на месте. */
function scale(level) {
  const el = h('div.pl-scale', { role: 'img' }, Array.from({ length: LEVELS }, () => h('span.pl-seg')));
  const set = (n) => {
    el.setAttribute('aria-label', n ? `Уровень ${n} из ${LEVELS}` : 'Не оценён');
    [...el.children].forEach((c, i) => c.classList.toggle('on', i < (n || 0)));
  };
  set(level);
  el.set = set;
  return el;
}

export function showPlacement(root, ctx) {
  const request = ctx.request || defaultRequest;
  const supported = (ex) => ex.kind === 'pick' || !!ctx.runTask;
  const bank = { exercisesOf: (q) => ctx.bank.exercisesOf(q).filter(supported) };
  const st = { quiz: null, history: null, busy: false };

  const view = (...kids) => {
    root.replaceChildren(h('div.pl', ...kids));
    root.scrollTop = 0;
  };

  /* ---------------------------------------------------- три карточки */
  function choose() {
    const histBtn = h('button.pl-card', { type: 'button', 'aria-disabled': 'true', 'data-pl': 'history' },
      h('div.pl-card-t', 'По истории игр'),
      h('div.pl-card-s', 'Оценим решения за столом — не победы и не фишки.'),
      h('div.pl-card-n', 'Проверяем…'));
    const note = histBtn.querySelector('.pl-card-n');
    view(
      h('h2.pl-h', 'Как определим ваш уровень?'),
      h('div.pl-sub', 'Это только стартовая сложность. Потом её можно поменять в любой момент.'),
      h('div.pl-cards',
        h('button.pl-card', { type: 'button', 'data-pl': 'zero', onclick: () => zero() },
          h('div.pl-card-t', 'Начать с нуля'), h('div.pl-card-s', 'Все навыки с первого уровня.')),
        h('button.pl-card', { type: 'button', 'data-pl': 'quiz', onclick: () => startQuiz() },
          h('div.pl-card-t', 'Определить мой уровень'), h('div.pl-card-s', 'Короткая проверка: около 3 минут.')),
        histBtn),
      ctx.onExit ? h('button.k-btn.k-btn--ghost.pl-exit', { type: 'button', onclick: () => ctx.onExit() }, 'Позже') : null);
    request({ t: 'train', op: 'history' }).then((m) => {
      st.history = m.history || null;
      if (!histBtn.isConnected) return;
      if (st.history?.available) {
        histBtn.removeAttribute('aria-disabled');
        histBtn.onclick = () => historyScreen();
        note.textContent = `Решений в журнале: ${st.history.total}.`;
      } else {
        note.textContent = st.history?.summary || 'Пока мало решений: сыграйте ещё или пройдите диагностику.';
      }
    }).catch(() => { note.textContent = 'Не удалось проверить журнал решений.'; });
  }

  async function save(levels, via) {
    if (st.busy) return;
    st.busy = true;
    const m = await request(Q.placementMessage(levels, via)).catch(() => ({ error: { text: 'Нет связи. Попробуйте ещё раз.' } }));
    st.busy = false;
    const err = m.error ? (m.error.text || m.text || 'Не получилось сохранить.') : null;
    const box = root.querySelector('.pl-err');
    if (err) { if (box) box.textContent = err; haptic.err?.(); return; }
    ctx.onDone?.(m.progress);
  }

  const zero = () => save(Q.zeroLevels(), 'zero');

  /* ------------------------------------------------------ диагностика */
  function startQuiz() {
    st.quiz = Q.startQuiz();
    nextQuestion();
  }

  function nextQuestion() {
    const q = st.quiz;
    const job = Q.nextTask(q, bank);
    if (!job) return result(Q.quizResult(q), 'quiz', { note: 'по вашим ответам', quiz: true });
    const { ex, seed } = job;
    let inst;
    try { inst = ctx.bank.instantiate(ex.id, seed); } catch { Q.answer(q, job, false, true); return nextQuestion(); }
    const done = (ok, skipped = false) => { Q.answer(q, job, ok, skipped); nextQuestion(); };
    const total = Math.min(Q.MAX_TASKS, Math.max(8, Q.totalAnswers(q) + 1));
    const n = Q.totalAnswers(q) + 1;
    const box = h('div.pl-task');
    view(
      h('div.pl-top',
        h('div.pl-count', `Задание ${n} из ~${total}`),
        h('button.k-btn.k-btn--ghost.pl-mini', { type: 'button', onclick: () => choose() }, 'Выйти')),
      h('div.pl-bar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(n - 1) },
        h('div.pl-bar-in', { style: { width: `${Math.round(((n - 1) / total) * 100)}%` } })),
      h('div.pl-tag', skillTitle(job.skill)),
      h('div.pl-prompt', inst.task.prompt),
      box,
      h('button.k-btn.k-btn--secondary.pl-skip', { type: 'button', onclick: () => done(false, true) }, 'Не знаю'));
    if (ex.kind === 'pick' && inst.task.setup?.options) {
      box.append(...inst.task.setup.options.map((o) => h('button.k-btn.k-btn--secondary.pl-opt', { type: 'button', 'data-opt': o.id, onclick: () => {
        const r = inst.task.check(o.id);
        done(!!r?.ok);
      } }, o.label)));
    } else {
      ctx.runTask?.(box, inst, (review) => done(!!review?.ok));
    }
  }

  /* ------------------------------------------------------------ итог */
  function result(levels, via, { note, quiz = false, only = null, extra = null } = {}) {
    const cur = {};
    for (const s of SKILLS) cur[s.id] = levels[s.id];
    const rows = SKILLS.map((s) => {
      const known = cur[s.id] != null;
      if (!known && only) return null; // «по истории»: навык без данных в итог не идёт
      if (!known) cur[s.id] = 1;
      const sc = scale(known ? cur[s.id] : 0);
      const word = h('div.pl-word', known ? Q.levelWord(cur[s.id]) : 'Не оценивали — начнём с первого');
      const lvl = h('div.pl-lvl', String(cur[s.id]));
      const bump = (d) => {
        cur[s.id] = Q.adjust(cur[s.id], d);
        sc.set(cur[s.id]); lvl.textContent = String(cur[s.id]); word.textContent = Q.levelWord(cur[s.id]);
        minus.disabled = cur[s.id] <= 1; plus.disabled = cur[s.id] >= LEVELS;
      };
      const minus = h('button.k-btn.k-btn--secondary.pl-pm', { type: 'button', 'aria-label': `${s.title}: ниже`, 'data-pm': `${s.id}-`, onclick: () => bump(-1) }, '−');
      const plus = h('button.k-btn.k-btn--secondary.pl-pm', { type: 'button', 'aria-label': `${s.title}: выше`, 'data-pm': `${s.id}+`, onclick: () => bump(1) }, '+');
      minus.disabled = cur[s.id] <= 1; plus.disabled = cur[s.id] >= LEVELS;
      return h('div.pl-row', { 'data-skill': s.id },
        h('div.pl-row-t', h('span.pl-name', s.title), h('span.pl-lvl-wrap', 'уровень ', lvl)),
        sc, word,
        h('div.pl-pms', minus, plus));
    }).filter(Boolean);
    const missing = only ? SKILLS.filter((s) => levels[s.id] == null) : [];
    view(
      h('h2.pl-h', 'Ваш уровень'),
      h('div.pl-sub', quiz ? 'Предложенный старт по вашим ответам. Любой навык можно поменять − и +.' : (note || '')),
      extra,
      h('div.pl-rows', ...rows),
      missing.length ? h('div.pl-sub', `Мало данных: ${missing.map((s) => s.title).join(', ')}. Их можно оценить диагностикой.`) : null,
      h('div.pl-err.k-error', { role: 'alert' }),
      h('div.pl-actions',
        h('button.k-btn.k-btn--primary.pl-go', { type: 'button', 'data-pl': 'confirm', onclick: () => save(Object.fromEntries(rows.map((r) => [r.dataset.skill, cur[r.dataset.skill]])), via) }, 'Начать с этих уровней'),
        missing.length ? h('button.k-btn.k-btn--secondary', { type: 'button', onclick: () => startQuiz() }, 'Пройти диагностику') : null,
        h('button.k-btn.k-btn--ghost', { type: 'button', onclick: () => choose() }, 'Назад')));
  }

  /* ------------------------------------------------- «по истории игр» */
  function historyScreen() {
    const a = st.history;
    if (!a?.available) return choose();
    const errs = (a.mistakes || []).slice(0, 4).map((m) => h('li', `${m.text} — ${m.count}`));
    result(Q.levelsFromHistory(a), 'history', {
      only: true,
      note: 'На чём основана оценка — ниже.',
      extra: h('div.pl-why',
        h('div.pl-why-t', a.summary),
        errs.length ? h('ul.pl-why-l', ...errs) : null,
        h('div.pl-why-n', 'Это грубая оценка по правилам, а не разбор солвера. Выиграли вы или проиграли — не учитывается.')),
    });
  }

  choose();
  return { destroy() { root.replaceChildren(); } };
}

/* ------------------------------------------------ настройка журнала решений */

/** Строка про журнал и «Удалить историю решений» (для «Настроек тренировки»). */
export function renderDecisionSettings(el, ctx) {
  const request = ctx.request || defaultRequest;
  const msg = h('div.pl-sub', 'Игра запоминает ваши решения в покере, чтобы подобрать уровень. Видите их только вы. Хранятся последние 300.');
  const status = h('div.pl-sub', { role: 'status' });
  let armed = null;
  const btn = h('button.k-btn.k-btn--secondary.pl-del', { type: 'button', 'data-pl': 'delete-history' }, 'Удалить историю решений');
  btn.onclick = async () => {
    if (!armed) {
      btn.textContent = 'Точно удалить? Нажмите ещё раз';
      armed = setTimeout(() => { armed = null; btn.textContent = 'Удалить историю решений'; }, 4000);
      return;
    }
    clearTimeout(armed); armed = null;
    btn.textContent = 'Удалить историю решений';
    const m = await request({ t: 'train', op: 'decisions-clear' }).catch(() => null);
    status.textContent = m && m.cleared != null ? (m.cleared ? `Удалено решений: ${m.cleared}.` : 'История уже пуста.') : 'Не получилось удалить. Попробуйте ещё раз.';
  };
  el.append(h('div.pl-set', msg, btn, status));
  return el;
}
