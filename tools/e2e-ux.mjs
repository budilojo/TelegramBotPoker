import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { Table, TEST_TOKEN, user, initDataFor } from '../bot/harness.js';
import { Store } from '../bot/store.js';
import { UX } from '../bot/ux.js';
import { startServer } from '../bot/server.js';
const root = path.resolve(import.meta.dirname, '..');
const store = new Store(); store.setSetting('ux-environment', 'ux-test');
const t = new Table({ store });
const ux = new UX({ app: t.app, botToken: TEST_TOKEN, testers: ['1'], enabled: true }); t.hub.ux = ux;
const web = startServer({ hub: t.hub, ux, port: 0, host: '127.0.0.1', root: path.join(root, 'miniapp') });
await new Promise(r => web.server.once('listening', r));
const url = `http://127.0.0.1:${web.server.address().port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 740 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const initData = initDataFor(user(1, 'Тестер'), { clock: t.clock });
  await page.route('https://telegram.org/**', r => r.fulfill({ contentType: 'text/javascript', body: `window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)}, initDataUnsafe: {}, ready(){}, expand(){}, close(){}, onEvent(){},
    BackButton: { show(){},hide(){},onClick(){} }, HapticFeedback: { impactOccurred(){},notificationOccurred(){},selectionChanged(){} }
  } };` }));
  await page.goto(url);
  await page.locator('#ux-access').click();
  await page.getByRole('button', { name: 'Согласен, начать запись', exact: true }).click();
  await page.getByText('Запись включена', { exact: true }).waitFor();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ux_event').get().n >= 1, true);
  await page.getByRole('button', { name: 'Остановить запись', exact: true }).click();
  await page.getByText('Запись выключена', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Удалить запись этой сессии', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('button[disabled]') !== null);
  await page.evaluate(() => { localStorage.setItem('unrelated', 'keep'); localStorage.setItem('school.done', 'production'); localStorage.setItem('cardgame:ux:school.done', '["lesson"]'); });
  store.putProfile('1', { nickname: 'Старый', avatar: 'av01' });
  await page.reload();
  assert.equal(await page.evaluate(() => localStorage.getItem('cardgame:ux:school.done')), '["lesson"]');
  await page.locator('#ux-access').click();
  page.on('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Сбросить тестовый профиль', exact: true }).click();
  await page.waitForURL(url + '/');
  await page.waitForFunction(() => localStorage.getItem('cardgame:ux:school.done') === null);
  await page.locator('#ux-access').waitFor();
  assert.equal(store.getProfile('1').nickname, null);
  assert.equal(await page.evaluate(() => localStorage.getItem('unrelated')), 'keep');
  assert.equal(await page.evaluate(() => localStorage.getItem('school.done')), 'production');
  await page.locator('#ux-access').click();
  await page.getByRole('button', { name: 'Сбросить тестовый профиль', exact: true }).waitFor();
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  fs.mkdirSync(path.join(root, 'preview'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'preview', 'ux-panel.png') });
  assert.deepEqual(errors, []);
  // Respondent performs the existing group-room flow through actual UI controls.
  await t.cmd(user(1, 'Тестер'), '/game');
  const g = [...t.app.groups.values()][0];
  const signed = initDataFor(user(1, 'Тестер'), { clock: t.clock, startParam: 'g_' + g.code });
  await page.route('https://telegram.org/**', r => r.fulfill({ contentType: 'text/javascript', body: `window.Telegram = { WebApp: {
    initData: ${JSON.stringify(signed)}, initDataUnsafe: {start_param: ${JSON.stringify('g_' + g.code)}}, ready(){},expand(){},onEvent(){},
    BackButton:{show(){},hide(){},onClick(){}},HapticFeedback:{impactOccurred(){},selectionChanged(){},notificationOccurred(){}}
  } };` }));
  await page.reload();
  await page.locator('#ux-access').click();
  await page.getByRole('button', { name: 'Согласен, начать запись', exact: true }).click();
  await page.getByText('Запись включена', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Закрыть окно', exact: true }).click();
  await page.locator('.game-card.g-poker').click();
  await page.getByRole('spinbutton', { name: 'Стартовый стек', exact: true }).fill('5000');
  await page.getByRole('button', { name: 'Создать лобби', exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.screen === 'poker');
  assert.equal([...t.app.rooms.values()].some(r => r.game === 'poker'), true);
  for (const name of ['game_select', 'room_form_open', 'room_settings_change', 'room_created']) {
    await page.waitForFunction(async name => {
      const { initData } = await import('/net.js');
      const r = await fetch('/ux', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({op:'export',initData}) });
      return (await r.json()).events.some(e => e.name === name);
    }, name);
  }
  assert.deepEqual(errors, []);
  const prod = startServer({ hub: t.hub, port: 0, host: '127.0.0.1', root: path.join(root, 'miniapp') });
  await new Promise(r => prod.server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${prod.server.address().port}`;
    assert.equal((await fetch(base + '/ux', { method: 'POST' })).status, 405);
    assert.equal(await (await fetch(base + '/ux-config.js')).text(), '');
  } finally { await prod.close(); }
  console.log('UX e2e: consent, stop, delete, persisted progress, reset, local isolation, 320px, production gate OK');
} finally { await browser.close(); t.app.stop(); await web.close(); store.close(); }
