/**
 * Room controls.
 *
 * Two ideas are kept apart everywhere in here:
 *   ROLE       — player / dealer, what you do in the hand
 *   PERMISSION — isHost, the right to run the room
 * A host is therefore HOST+PLAYER or HOST+DEALER, never "just host".
 */
import { h, icon, fmt, mount as fill, initials, tick, plural } from '../util.js';
import { net, joinUrl } from '../net.js';
import { sheet, confirm, toast, closeOverlay } from './overlay.js';

/* ----------------------------------------------------------- room menu   */

export function openRoomMenu(app) {
  const s = app.state;
  if (!s) return;
  const isHost = s.hostId === s.you;
  const paused = s.status === 'paused';
  const inGame = s.status !== 'lobby' && s.status !== 'finished';
  const me = s.players.find((p) => p.id === s.you);
  const canRunTable = isHost || me?.role === 'dealer';

  sheet((close) => [
    h('div.sheet-title', { text: s.name }),
    h('div.sheet-sub', {
      text: `Код ${s.code} · ${s.players.length} ${plural(
        s.players.length, 'участник', 'участника', 'участников'
      )} · блайнды ${fmt(s.settings.smallBlind)}/${fmt(s.settings.bigBlind)}`,
    }),
    h(
      'div.sheet-body',
      h(
        'div.menu-list',
        item('copy', 'Скопировать код', s.code, async () => {
          try {
            await navigator.clipboard.writeText(s.code);
            toast(`Код ${s.code} скопирован`, 'ok');
          } catch {
            toast(`Код комнаты: ${s.code}`, 'info', 5000);
          }
        }),
        item('share', 'Поделиться ссылкой', null, async () => {
          const url = joinUrl(s.code);
          try {
            if (navigator.share) return void (await navigator.share({ title: 'Chip Table', url }));
            await navigator.clipboard.writeText(url);
            toast('Ссылка скопирована', 'ok');
          } catch {
            toast(url, 'info', 6000);
          }
        }),

        isHost
          ? item('users', 'Участники и роли', 'Player / Dealer, стеки, удаление', () => {
              close();
              openPlayerList(app);
            })
          : null,

        isHost
          ? item(
              'sliders',
              'Настройки игры',
              inGame ? 'Блайнды — со следующей раздачи' : 'Стек и блайнды',
              () => {
                close();
                openSettingsSheet(app);
              }
            )
          : null,

        isHost && inGame && s.blinds?.mode === 'levels'
          ? item(
              'chip',
              'Поднять блайнды сейчас',
              s.blinds.next
                ? `Следующий уровень: ${fmt(s.blinds.next.sb)}/${fmt(s.blinds.next.bb)}`
                : 'Это последний уровень',
              () => {
                close();
                confirm({
                  title: 'Поднять блайнды?',
                  body: s.blinds.next
                    ? `Со следующей раздачи: ${fmt(s.blinds.next.sb)}/${fmt(s.blinds.next.bb)}.`
                    : '',
                  ok: 'Поднять',
                  onOk: () => net.send({ t: 'bumpLevel' }),
                });
              },
              !s.blinds.next
            )
          : null,

        isHost && inGame
          ? item(
              paused ? 'play' : 'pause',
              paused ? 'Продолжить игру' : 'Поставить на паузу',
              paused ? 'Все действия разблокируются' : 'Никто не сможет ходить',
              () => {
                close();
                net.send({ t: 'pause', value: !paused });
              }
            )
          : null,

        canRunTable
          ? item(
              'undo',
              'Отменить последнее действие',
              s.undoLabel ? `Последнее: ${s.undoLabel}` : 'Пока нечего отменять',
              () => {
                close();
                confirm({
                  title: 'Отменить последнее действие?',
                  body: s.undoLabel ? `Будет отменено: ${s.undoLabel}` : '',
                  ok: 'Отменить действие',
                  onOk: () => net.send({ t: 'undo' }),
                });
              },
              !s.canUndo
            )
          : null,

        inGame && me?.role !== 'dealer'
          ? item(
              me?.sittingOut ? 'play' : 'pause',
              me?.sittingOut ? 'Вернуться в игру' : 'Пропустить раздачи',
              me?.sittingOut
                ? 'Вас снова будут раздавать со следующей руки'
                : 'Если нужно отойти — вас не будут ждать',
              () => {
                close();
                net.send({ t: 'sitOut', value: !me?.sittingOut });
              }
            )
          : null,

        h('div.menu-sep'),

        isHost && s.status !== 'finished'
          ? item('trophy', 'Завершить игру', 'Покажет финальные результаты', () => {
              close();
              confirm({
                title: 'Завершить игру?',
                body: 'Раздача остановится, фишки из незакрытого банка вернутся игрокам, и все увидят итоговую таблицу.',
                ok: 'Завершить',
                danger: true,
                onOk: () => net.send({ t: 'endGame' }),
              });
            })
          : null,

        item(
          'exit',
          'Выйти из комнаты',
          'Место и стек сохранятся',
          () => {
            close();
            confirm({
              title: 'Выйти из комнаты?',
              body: 'Вы сможете вернуться по тому же коду с этим же именем — место сохранится.',
              ok: 'Выйти',
              danger: true,
              onOk: () => app.leaveRoom(),
            });
          },
          false,
          true
        )
      )
    ),
  ]);
}

function item(ic, label, sub, onclick, disabled = false, danger = false) {
  return h(
    'button.menu-item',
    { class: danger ? 'danger' : '', disabled, onclick },
    icon(ic, 'ic'),
    h(
      'span.grow',
      h('span', { text: label }),
      sub ? h('span.sub', { style: { display: 'block' }, text: sub }) : null
    )
  );
}

/* -------------------------------------------------------------- settings */

export function openSettingsSheet(app) {
  const s = app.state;
  const inLobby = s.status === 'lobby';
  const b = s.blinds ?? { mode: 'fixed' };
  const model = {
    stack: s.settings.startingStack,
    sb: s.settings.smallBlind,
    bb: s.settings.bigBlind,
    mode: b.mode,
    minutes: b.levelMinutes ?? 20,
  };

  // Once a ladder is running it owns the blinds, so the opening level is only
  // editable before the game starts.
  const blindsLocked = () => !inLobby && model.mode === 'levels';

  const numField = (value, onChange) =>
    h('input.input.input-num', {
      type: 'text',
      inputmode: 'numeric',
      value: String(value),
      oninput: (e) => {
        const v = e.target.value.replace(/\D/g, '');
        e.target.value = v;
        onChange(Number(v) || 0);
      },
    });

  const stackInput = numField(model.stack, (v) => {
    model.stack = v;
    validate();
  });
  const sbInput = numField(model.sb, (v) => {
    model.sb = v;
    validate();
  });
  const bbInput = numField(model.bb, (v) => {
    model.bb = v;
    validate();
  });

  const modeChips = [
    ['fixed', 'Фиксированные'],
    ['levels', 'Растущие'],
  ].map(([value, label]) =>
    h('button.chip-pick', {
      type: 'button',
      text: label,
      onclick: () => {
        if (model.mode === value) return;
        model.mode = value;
        tick();
        validate();
      },
    })
  );

  const minuteChips = [10, 15, 20, 30].map((v) =>
    h('button.chip-pick', {
      type: 'button',
      text: `${v} мин`,
      onclick: () => {
        model.minutes = v;
        tick();
        validate();
      },
    })
  );

  const levelBox = h('div', { style: { marginTop: '16px' } });
  const note = h('p.hint', { style: { marginTop: '10px' } });
  const apply = h('button.btn.btn-primary.btn-lg', { text: 'Сохранить' });

  function ladderPreview() {
    // Mirrors the server's ladder so the host sees what they are signing up for.
    const mult = [1, 2, 3, 4, 6, 8];
    const from = inLobby ? { sb: model.sb, bb: model.bb } : { sb: model.sb, bb: model.bb };
    return mult
      .map((m) => `${fmt(Math.round(from.sb * m))}/${fmt(Math.round(from.bb * m))}`)
      .join(' → ') + ' → …';
  }

  function problem() {
    if (model.sb < 1) return 'Small blind должен быть больше нуля';
    if (model.bb < model.sb) return 'Big blind не может быть меньше small blind';
    if (inLobby && model.stack < model.bb * 5)
      return `Стартовый стек слишком мал — минимум ${fmt(model.bb * 5)}`;
    return null;
  }

  function validate() {
    modeChips.forEach((c, i) =>
      c.setAttribute('aria-pressed', String(model.mode === ['fixed', 'levels'][i]))
    );
    minuteChips.forEach((c, i) =>
      c.setAttribute('aria-pressed', String(model.minutes === [10, 15, 20, 30][i]))
    );

    const locked = blindsLocked();
    for (const el of [sbInput, bbInput]) {
      el.disabled = locked;
      el.style.opacity = locked ? '0.45' : '';
    }

    if (model.mode === 'levels') {
      fill(
        levelBox,
        h('span.label', { style: { display: 'block' }, text: 'Длительность уровня' }),
        h('div.chips-row', minuteChips),
        h('p.hint', {
          style: { marginTop: '10px' },
          text: inLobby
            ? `Лестница: ${ladderPreview()}`
            : `Текущий уровень ${(b.levelIndex ?? 0) + 1} из ${b.levelCount ?? 1}`,
        })
      );
    } else {
      fill(levelBox);
    }

    const p = problem();
    apply.disabled = !!p;
    note.textContent =
      p ||
      (inLobby
        ? `Стек = ${Math.floor(model.stack / model.bb)} больших блайндов. Стеки будут розданы заново.`
        : model.mode === 'levels'
          ? 'Блайнды растут сами и меняются только между раздачами.'
          : 'Новые блайнды вступят в силу со следующей раздачи.');
    note.style.color = p ? 'var(--warn)' : '';
  }

  const { close } = sheet(() => [
    h('div.sheet-title', { text: 'Настройки игры' }),
    h('div.sheet-sub', {
      text: inLobby
        ? 'Игра ещё не началась — можно менять всё'
        : 'Фишки уже в игре — стартовый стек заморожен',
    }),
    h(
      'div.sheet-body',
      h(
        'div.stack-v',
        { style: { gap: '20px' } },
        inLobby ? h('label.field', h('span.label', { text: 'Стартовый стек' }), stackInput) : null,
        h(
          'div.field',
          h('span.label', { text: 'Блайнды' }),
          h(
            'div.row',
            h('div.grow', sbInput),
            h('span', { style: { color: 'var(--muted)', fontWeight: '700' }, text: '/' }),
            h('div.grow', bbInput)
          ),
          h('div.chips-row', { style: { marginTop: '12px' } }, modeChips),
          levelBox,
          note
        )
      ),
      h('div', { style: { height: '14px' } }),
      apply,
      h('button.btn.btn-ghost', { style: { marginTop: '8px' }, text: 'Отмена', onclick: () => close() })
    ),
  ]);

  apply.addEventListener('click', () => {
    if (problem()) return;
    tick();
    close();
    net.send({
      t: 'settings',
      settings: {
        startingStack: model.stack,
        smallBlind: model.sb,
        bigBlind: model.bb,
        blindMode: model.mode,
        levelMinutes: model.minutes,
      },
    });
  });

  validate();
}

/* ------------------------------------------------------------- players   */

export function openPlayerList(app) {
  const s = app.state;
  sheet(() => [
    h('div.sheet-title', { text: 'Участники' }),
    h('div.sheet-sub', { text: 'Нажмите, чтобы изменить роль, стек или удалить' }),
    h(
      'div.sheet-body',
      ...s.players.map((p) =>
        h(
          'button.seat.seat-btn.is-tappable',
          { style: { marginBottom: '8px' }, onclick: () => openPlayerPanel(app, p.id) },
          h('div.avatar', {
            class: `${p.connected ? '' : 'off'} ${p.role === 'dealer' ? 'avatar-dealer' : ''}`,
            text: initials(p.name),
          }),
          h(
            'div.grow',
            h('div.nm', h('span', { text: p.name })),
            h(
              'div.role-line',
              p.isHost ? h('span.role-host', { text: 'HOST' }) : null,
              p.isHost ? h('span.role-dot', { text: '•' }) : null,
              h('span', {
                class: p.role === 'dealer' ? 'role-dealer' : 'role-player',
                text: p.role === 'dealer' ? 'DEALER' : 'PLAYER',
              })
            )
          ),
          h('div.seat-right', h('div.seat-stack.num', { text: fmt(p.stack) }), icon('chev', 'seat-chev'))
        )
      )
    ),
  ]);
}

/**
 * The per-participant sheet. Role first — that is what the host opens it for.
 */
export function openPlayerPanel(app, playerId) {
  const s = app.state;
  const p = s.players.find((x) => x.id === playerId);
  if (!p) return;
  if (s.hostId !== s.you) return;

  const bb = s.settings.bigBlind;
  const isMe = p.id === s.you;
  const currentRole = p.pendingRole || p.role;
  let picked = currentRole;

  const options = [
    ['player', 'Player', 'Играет за столом и делает ставки'],
    ['dealer', 'Dealer', 'Раздаёт карты и отмечает победителя. Не играет.'],
  ].map(([value, title, desc]) =>
    h(
      'button.role-opt',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': String(picked === value),
        onclick: () => {
          if (picked === value) return;
          picked = value;
          tick();
          sync();
        },
      },
      h('span.radio'),
      h('span.grow', h('span.rt', { text: title }), h('span.rd', { text: desc }))
    )
  );

  const applyBtn = h('button.btn.btn-primary.btn-lg', { style: { marginTop: '14px' } });

  function sync() {
    options.forEach((o, i) =>
      o.setAttribute('aria-checked', String(picked === ['player', 'dealer'][i]))
    );
    const changed = picked !== currentRole;
    applyBtn.disabled = !changed;
    applyBtn.textContent = changed ? 'Применить' : 'Роль не изменена';
  }

  /* ---- stack correction (only meaningful once chips are in play) ------ */
  let target = p.stack;
  const stackValue = h('div.bet-amount.num', { style: { fontSize: '38px' } });
  const stackDelta = h('div.bet-meta');
  const stackInput = h('input.input.input-num', {
    type: 'text',
    inputmode: 'numeric',
    value: String(target),
    oninput: (e) => {
      const v = e.target.value.replace(/\D/g, '');
      e.target.value = v;
      setTarget(Number(v) || 0, true);
    },
  });
  const stackApply = h('button.btn.btn-ghost');

  function setTarget(v, fromInput = false) {
    target = Math.max(0, Math.round(v));
    stackValue.textContent = fmt(target);
    if (!fromInput) stackInput.value = String(target);
    const d = target - p.stack;
    stackDelta.textContent =
      d === 0 ? 'Стек без изменений' : `${d > 0 ? '+' : '−'}${fmt(Math.abs(d))} к текущему стеку`;
    stackApply.disabled = d === 0;
    stackApply.textContent = d === 0 ? 'Изменений нет' : `Изменить стек на ${fmt(target)}`;
  }

  const { close } = sheet(() => [
    h('div.sheet-title', { text: p.name }),
    h('div.sheet-sub', {
      text: [
        p.isHost ? 'Хост комнаты' : null,
        p.connected ? null : 'Не в сети',
        `${fmt(p.stack)} фишек`,
      ]
        .filter(Boolean)
        .join(' · '),
    }),
    h(
      'div.sheet-body',
      h('p.eyebrow', { style: { marginBottom: '10px' }, text: 'Роль участника' }),
      h('div.role-options', { role: 'radiogroup' }, options),
      p.pendingRole
        ? h('p.hint', {
            style: { marginTop: '10px', color: 'var(--warn)' },
            text: `Сейчас в раздаче — новая роль применится со следующей.`,
          })
        : null,
      applyBtn,

      h('div.menu-sep'),
      h('p.eyebrow', { style: { margin: '4px 0 10px' }, text: 'Стек' }),
      stackValue,
      stackDelta,
      h(
        'div.quick-grid',
        { style: { gridTemplateColumns: 'repeat(4,1fr)', marginTop: '12px' } },
        ...[-bb * 10, -bb, bb, bb * 10].map((d) =>
          h('button.quick', {
            text: `${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}`,
            onclick: () => {
              tick();
              setTarget(target + d);
            },
          })
        )
      ),
      h('div.bet-manual', h('div.grow', stackInput)),
      stackApply,

      h('div.menu-sep'),
      h(
        'div.menu-list',
        !isMe
          ? item('crown', 'Передать права хоста', `${p.name} сможет управлять комнатой`, () => {
              close();
              confirm({
                title: `Передать права хоста ${p.name}?`,
                body: 'Вы перестанете управлять комнатой — вернуть права сможет только новый хост.',
                ok: 'Передать',
                onOk: () => net.send({ t: 'transferHost', playerId: p.id }),
              });
            })
          : null,
        !isMe
          ? item(
              'x',
              'Удалить из игры',
              'Фишки в текущем банке останутся в банке',
              () => {
                close();
                confirm({
                  title: `Удалить ${p.name}?`,
                  body: `Стек ${fmt(p.stack)} пропадёт со стола, а сделанные ставки останутся в банке.`,
                  ok: 'Удалить участника',
                  danger: true,
                  onOk: () => net.send({ t: 'kick', playerId: p.id }),
                });
              },
              false,
              true
            )
          : null
      )
    ),
  ]);

  applyBtn.addEventListener('click', () => {
    if (picked === currentRole) return;
    tick();
    close();
    net.send({ t: 'setRole', playerId: p.id, role: picked });
  });

  stackApply.addEventListener('click', () => {
    const d = target - p.stack;
    if (!d) return;
    closeOverlay();
    confirm({
      title: 'Изменить стек вручную?',
      body: `${p.name}: ${fmt(p.stack)} → ${fmt(target)}. Это видно всем за столом.`,
      ok: 'Изменить',
      onOk: () => net.send({ t: 'adjustStack', playerId: p.id, delta: d }),
    });
  });

  sync();
  setTarget(p.stack);
}

/** Kept for the table screen, which opens the same menu from its header. */
export const openHostMenu = openRoomMenu;
