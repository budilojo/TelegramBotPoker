'use strict';
/**
 * Вкладка «Профиль» (пакет 4, Q): свой ID приходит только сам себе, поддержка и «Скопировать» на месте,
 * прежние блоки «Настроек» не потеряны. Клиентские файлы читаются как текст (браузера здесь нет — его закрывает e2e-profile).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Table, user } from './harness.js';

const read = (p) => fs.readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');
const ALICE = user(7770011, 'Алиса');
const BOB = user(7770022, 'Боб');

test('профиль: свой ID приходит игроку, чужой номер в его ответе не встречается', async () => {
  const t = new Table();
  for (const u of [ALICE, BOB]) await t.start(u);
  const a = t.app.profiles.mine({ id: String(ALICE.id), name: ALICE.name });
  const b = t.app.profiles.mine({ id: String(BOB.id), name: BOB.name });
  assert.equal(a.id, String(ALICE.id));
  assert.equal(b.id, String(BOB.id));
  assert.ok(!JSON.stringify(a).includes(String(BOB.id)), 'в ответе Алисе нет номера Боба');
  assert.ok(!JSON.stringify(b).includes(String(ALICE.id)), 'в ответе Бобу нет номера Алисы');
});

test('профиль: чужие игроки за столом не получают поля id профиля (только «мой» ответ)', async () => {
  const t = new Table();
  for (const u of [ALICE, BOB]) await t.start(u);
  const shown = t.app.profiles.shown(String(ALICE.id), 'Алиса');
  assert.ok(!('id' in shown), 'короткая форма для чужих без id');
  assert.ok(!('id' in t.app.profiles.me({ id: String(ALICE.id), name: 'Алиса' })), '`me` в состояниях хаба без id');
});

test('вкладка названа «Профиль», экран держит поддержку, «Скопировать» и прежние блоки', () => {
  const nav = read('miniapp/nav.js');
  assert.match(nav, /\['settings', 'Профиль'\]/, 'вкладка называется «Профиль»');
  assert.ok(!/\['settings', 'Настройки'\]/.test(nav), 'старого названия вкладки нет');
  assert.match(nav, /h1', 'Профиль'/, 'заголовок экрана');
  for (const keep of ['Уведомления бота', 'tournamentEntry', 'О приложении', 'extraRows(s)', 'renderProfileSettings']) {
    assert.ok(nav.includes(keep), `прежний блок «${keep}» на месте`);
  }
  const top = read('miniapp/profile-top.js');
  assert.match(top, /data-act': 'support'/);
  assert.match(top, /start=support/);
  assert.match(top, /copy-id/);
  assert.match(top, /\/support/, 'есть запасной путь словами');
  assert.ok(!/token|roomCode|s\.code|initDataUnsafe/i.test(top), 'служебного на экране нет');
});
