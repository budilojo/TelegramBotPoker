/** The same HTTP route, signed Telegram identity and WebSocket used in the Mini App. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Table, user, initDataFor } from '../bot/harness.js';
import { Store } from '../bot/store.js';
import { startServer } from '../bot/server.js';

const host = user(8001, 'Вера');
const guest = user(8002, 'Илья');
const store = new Store();
const t = new Table({ store, admins: [String(host.id)] });
store.pay.adminGrant(String(host.id), 'sever-talisman', String(host.id), t.clock.now());
store.collApply(String(host.id), [{ slot: 'talisman', item: 'sever-talisman', color: 'default' }], 'talisman-e2e', t.clock.now(), 20);
const web = startServer({ hub: t.hub, port: 0, host: '127.0.0.1', root: new URL('../miniapp', import.meta.url).pathname });
await new Promise(resolve => web.server.once('listening', resolve));
const base = `http://127.0.0.1:${web.server.address().port}`;
const browser = await chromium.launch();
const problems = [];
async function open(who, path = '/', startParam) {
  const p = await browser.newPage({ viewport: { width: 320, height: 700 }, reducedMotion: 'reduce' });
  p.on('pageerror', e => problems.push(e.message));
  const data = initDataFor(who, { clock: t.clock, startParam });
  await p.route('https://telegram.org/**', r => r.fulfill({
    contentType: 'text/javascript',
    body: `window.Telegram={WebApp:{initData:${JSON.stringify(data)},initDataUnsafe:{start_param:${JSON.stringify(startParam)}},ready(){},expand(){},disableVerticalSwipes(){}}}`,
  }));
  const response = await p.goto(base + path);
  assert.equal(response.status(), 200, path);
  return p;
}

const settings = p => p.locator('[data-tab="settings"]').click();
const names = p => p.locator('.tour-player strong').allTextContents();
try {
  const ph = await open(host);
  await settings(ph);
  await ph.getByRole('button', { name: 'Создать турнир' }).click();
  await ph.getByLabel('Название').fill('Осенний кубок');
  await ph.getByLabel('Мест за столом').fill('2');
  await ph.getByLabel('Уровни блайндов').fill('25 50 10\n50 100 20');
  await ph.locator('form').getByRole('button', { name: 'Создать турнир' }).click();
  await ph.getByRole('heading', { name: 'Осенний кубок' }).waitFor();
  const route = new URL(ph.url()).pathname;
  assert.match(route, /^\/tournament\/[a-z2-9]{10}$/);
  const room = t.app.roomByCode(route.split('/').at(-1));
  await ph.getByRole('button', { name: 'Поделиться ссылкой' }).click();
  const share = await ph.getByLabel('Ссылка на турнир').inputValue();
  assert.ok(share.endsWith(`startapp=t_${room.code}`));
  await ph.keyboard.press('Escape');

  const pg = await open(guest, route);
  await pg.getByRole('button', { name: 'Занять место' }).click();
  await ph.locator('.tour-player', { hasText: 'Илья' }).waitFor();
  await pg.locator('.tour-player', { hasText: 'Илья' }).waitFor();
  assert.deepEqual(await names(pg), ['Вера', 'Илья']);
  await ph.getByRole('button', { name: 'Начать турнир' }).click();
  await pg.locator('[data-count]').waitFor();
  await t.clock.advance(10_000);
  await pg.getByText('Уровень 2', { exact: true }).waitFor();
  assert.match(await pg.locator('.tour-level').innerText(), /Текущие блайнды\s+50 \/ 100/);
  assert.equal(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await ph.getByRole('button', { name: 'К столу' }).click();
  const talisman = ph.locator('.table-talisman');
  await talisman.waitFor();
  assert.ok(await talisman.evaluate(async el => {
    await el.decode();
    const tr = el.getBoundingClientRect();
    const overlaps = [...document.querySelectorAll('.hero-cards img,.panel button')].some(node => {
      const r = node.getBoundingClientRect();
      return tr.left < r.right && tr.right > r.left && tr.top < r.bottom && tr.bottom > r.top;
    });
    return tr.width <= innerWidth * .1 && !overlaps && el.naturalWidth > 0;
  }));
  const preference = await open(host);
  await settings(preference);
  const hide = preference.getByRole('button', { name: /Скрывать талисман за столом/ });
  await hide.click();
  await preference.getByText('Талисман скрыт', { exact: true }).waitFor();
  await talisman.waitFor({ state: 'detached' });

  const actorPage = room.hand.actorId === String(host.id) ? ph : pg;
  await actorPage.evaluate(async () => (await import('/net.js')).send({ t: 'act', action: 'fold' }));
  await pg.getByRole('button', { name: 'Добавка', exact: true }).waitFor();
  await pg.getByRole('button', { name: 'Добавка', exact: true }).click();
  await pg.locator('.tour-player', { hasText: 'Илья' }).getByText(/Добавки: 1/).waitFor();
  assert.equal((await names(pg))[0], 'Илья');

  const pa = await open(host, '/?room=admin', 'admin');
  await pa.getByText('активны за 7 дней · WAU', { exact: true }).waitFor();
  await pa.getByText('использовали оформление или сыграли турнир · NSM', { exact: true }).waitFor();
  assert.deepEqual(problems, []);
  console.log('Турнир, ссылка, живая таблица и смена блайндов, добавка, талисман и метрики: OK');
} finally {
  await browser.close();
  await web.close();
  store.close();
}
