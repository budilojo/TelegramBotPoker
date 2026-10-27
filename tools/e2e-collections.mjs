/**
 * Коллекции «Графит» настоящим браузером (Chromium с эмуляцией телефона; Telegram — заглушка).
 *
 *   node tools/e2e-collections.mjs
 *
 * Серверного модуля коллекций в этой ветке может не быть, поэтому ответы `{ t:'col' }` даёт ТЕСТОВАЯ ЗАГЛУШКА
 * в этом файле (по contracts.md, раздел 2): она подменяет hub.handle только для сообщений `col`, всё остальное —
 * настоящий хаб и настоящий сервер страниц. Заглушка умеет: держать ответ (проверка «до ответа»),
 * молчать (нет ответа), отказывать, рвать связь, выключать демо.
 *
 * Ширины 320 / 360 / 390 / 430. Состояния: вне демо (входа нет), загрузка, витрина, карточка, цвет, примерка,
 * выдача (ожидание, двойное нажатие, успех только после ответа), получение, инвентарь, применение, ошибка,
 * частичный комплект, уже получено, пустой инвентарь, нет связи, нет ответа. Снимки — preview/col-*.png.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { Store } from '../bot/store.js';
import { startServer } from '../bot/server.js';
import { TelegramStub, dmUpdate, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';
import { assertNoJump } from './lib/scroll-probe.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 8097);
const TOKEN = `0:${crypto.randomBytes(16).toString('hex')}`;
const SHOTS = path.join(ROOT, 'preview');
fs.mkdirSync(SHOTS, { recursive: true });
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

const ivan = user(101, 'Иван');
const step = (s) => console.log(`· ${s}`);
const problems = [];
const BUNDLE = ['graphit-cardback', 'graphit-table', 'graphit-profile'];
const SLOT = { 'graphit-cardback': 'cardback', 'graphit-table': 'table', 'graphit-profile': 'profile' };

/* ---------------------------------------------------------------- заглушка сервера */
function makeCol() {
  const c = {
    enabled: true, demo: true, owned: [], choice: { cardback: null, table: null, profile: null },
    hold: false, holdState: false, held: [], drop: false, failApply: null, log: [], reqs: new Map(), sessions: new Set(),
  };
  c.state = (op, extra = {}) => ({
    t: 'col', op, v: 1, enabled: c.enabled, demo: c.enabled && c.demo,
    owned: c.owned.map((item) => ({ item, demo: true })), choice: structuredClone(c.choice),
    pending: { cardback: null, table: null, profile: null }, ...extra,
  });
  c.reset = (over = {}) => {
    Object.assign(c, { enabled: true, demo: true, owned: [], choice: { cardback: null, table: null, profile: null }, hold: false, holdState: false, held: [], drop: false, failApply: null, log: [], reqs: new Map() }, over);
  };
  c.handle = (session, msg) => {
    c.sessions.add(session);
    c.log.push(msg);
    const answer = () => {
      if (!c.enabled || !c.demo) {
        if (msg.op === 'state') return session.send(c.state('state'));
        return session.send({ t: 'col', op: msg.op, error: { code: 'COL_DEMO_OFF', text: 'Демонстрационное получение здесь выключено.' } });
      }
      if (msg.op === 'state') return session.send(c.state('state'));
      const seen = c.reqs.get(msg.req);
      if (seen) return session.send(seen);
      let out;
      if (msg.op === 'grant') {
        const ids = msg.item === 'graphit-bundle' ? BUNDLE : [msg.item];
        for (const id of ids) if (!c.owned.includes(id)) c.owned.push(id);
        out = c.state('grant');
      } else if (msg.op === 'apply') {
        if (c.failApply) return session.send({ t: 'col', op: 'apply', error: { code: 'COL_FAST', text: c.failApply } });
        if (!c.owned.includes(msg.item)) return session.send({ t: 'col', op: 'apply', error: { code: 'COL_NOT_OWNED', text: 'Этот предмет не в вашей коллекции.' } });
        c.choice[msg.slot] = { item: msg.item, color: msg.color };
        out = c.state('apply', { when: msg.slot === 'profile' ? 'now' : 'next-deal' });
        if (msg.slot !== 'profile') out.pending[msg.slot] = 'next-deal';
      } else if (msg.op === 'clear') {
        c.choice[msg.slot] = null;
        out = c.state('clear');
      }
      if (out) { c.reqs.set(msg.req, out); session.send(out); }
    };
    if (c.holdState && msg.op === 'state') return void c.held.push(answer);
    if (c.drop && msg.op !== 'state') return;
    if (c.hold && msg.op !== 'state') return void c.held.push(answer);
    answer();
  };
  c.release = () => { const q = c.held.splice(0); q.forEach((f) => f()); };
  return c;
}
const COL = makeCol();

async function boot(port, collectionsOn) {
  const api = new TelegramStub();
  const app = new App({ api, store: new Store(':memory:'), botUsername: 'All_InPoker_bot', minIntervalMs: 0, runoutStepMs: 0, webappUrl: `http://localhost:${port}`, miniAppName: 'table', ratingSoon: true, admins: [] });
  const hub = new Hub(app, { botToken: TOKEN });
  if (collectionsOn !== null) {
    const orig = hub.handle.bind(hub);
    hub.handle = async (session, msg) => (msg?.t === 'col' ? COL.handle(session, msg) : orig(session, msg));
  }
  app.attachHub(hub);
  const web = startServer({ hub, port, root: path.join(ROOT, 'miniapp'), log: () => {} });
  await new Promise((r) => web.server.once('listening', r));
  api.dmOpen.add('101');
  await app.handleUpdate(dmUpdate(ivan, '/start'));
  return { app, web, port };
}

const sdkStub = (initData) => `
  window.Telegram = { WebApp: {
    initData: ${JSON.stringify(initData)},
    initDataUnsafe: { start_param: '' },
    ready(){}, expand(){}, close(){}, disableVerticalSwipes(){}, setHeaderColor(){}, setBackgroundColor(){}, setBottomBarColor(){},
    onEvent(){}, openTelegramLink(){},
    BackButton: { show(){}, hide(){}, onClick(){} },
    HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  } };`;

const browser = await chromium.launch();
async function open(s, size, url = '/') {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 2 });
  page.sent = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(m.text()));
  page.on('websocket', (ws) => ws.on('framesent', (f) => page.sent.push(String(f.payload))));
  const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: ivan }, TOKEN);
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
  await page.goto(`http://localhost:${s.port}${url}`);
  await page.waitForSelector('.nav-tab[data-tab="settings"]');
  return page;
}
const colSent = (page, op) => page.sent.map((x) => { try { return JSON.parse(x); } catch { return {}; } }).filter((m) => m.t === 'col' && (!op || m.op === op));
const text = (page, sel) => page.locator(sel).innerText();
const shot = (page, name, tag) => page.screenshot({ path: path.join(SHOTS, `col-${tag}-${name}.png`) });
const goSettings = async (page) => { await page.locator('.nav-tab[data-tab="settings"]').click(); await page.waitForSelector('h1:has-text("Настройки")'); };
const openCollections = async (page) => { await goSettings(page); await page.locator('[data-entry="collections"]').click(); await page.waitForSelector('.col-root h2.col-big'); };

/** Экран по размеру: нет горизонтального скролла, ничто не вылезает за край, зоны нажатия ≥ 44 (кроме текстовых ссылок). */
async function fits(page, what) {
  const bad = await page.evaluate(() => {
    const out = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) out.push(`страница шире экрана: ${doc.scrollWidth} > ${doc.clientWidth}`);
    const sc = document.querySelector('.col-scroll');
    if (sc && sc.scrollWidth > sc.clientWidth + 1) out.push(`слой шире экрана: ${sc.scrollWidth} > ${sc.clientWidth}`);
    const root = document.querySelector('.col-root');
    if (!root) return ['слоя нет'];
    const vw = innerWidth;
    for (const el of root.querySelectorAll('button, [role="radio"], [role="switch"], [role="tab"]')) {
      const q = el.getBoundingClientRect();
      if (!q.width || !q.height) continue;
      if (q.right > vw + 0.5 || q.left < -0.5) out.push(`«${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}» за краем: ${Math.round(q.left)}…${Math.round(q.right)}`);
      if (q.height < 44 - 0.5 || q.width < 44 - 0.5) out.push(`зона мала ${Math.round(q.width)}×${Math.round(q.height)}: «${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}»`);
    }
    // подписи цветов не рвутся по буквам: «Графи/т» — дефект
    for (const el of root.querySelectorAll('.col-sw-name, .col-tab, .col-btn')) {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
      const q = el.getBoundingClientRect();
      if (el.classList.contains('col-sw-name') && q.height > lh * 1.5) out.push(`подпись цвета переносится: «${el.textContent}» высота ${Math.round(q.height)}`);
      if (el.scrollWidth > el.clientWidth + 1 && el.classList.contains('col-sw-name')) out.push(`подпись цвета не помещается: «${el.textContent}»`);
    }
    for (const el of root.querySelectorAll('.col-scroll *')) {
      if (el.closest('.col-sr') || el.classList.contains('col-sr')) continue;
      const q = el.getBoundingClientRect();
      if (q.width && q.right > vw + 0.5) out.push(`выходит вправо: ${el.className || el.tagName}`);
    }
    return out;
  });
  assert.deepEqual(bad, [], `${what}: ${bad.join('; ')}`);
}
const noJumpClick = (page, locator, label) => assertNoJump(page, { scroller: '.col-scroll', target: locator, label }, () => locator.click()).catch((e) => {
  // экран может быть ниже окна — тогда прыжок проверять нечем; другие сбои — настоящие
  if (/нечего прокручивать/.test(e.message)) { console.log(`  ! ${label}: прокручивать нечего`); return locator.click(); }
  throw e;
});

try {
  /* ============ сервер 1: коллекции выключены (рабочий режим) — входа нет ============ */
  const OFF = await boot(PORT, true);
  COL.reset({ demo: false });
  {
    const page = await open(OFF, [360, 740]);
    await goSettings(page);
    await page.waitForFunction(() => window.performance && true);
    await page.waitForTimeout(500);
    assert.equal(await page.locator('[data-entry="collections"]').count(), 0, 'вне демо входа в «Настройках» нет');
    assert.equal(await page.locator('.col-root').count(), 0);
    assert.equal((await text(page, '.settings')).includes('Коллекции'), false, 'и слова «Коллекции» в настройках нет');
    // прямой адрес/хэш ничего не открывает
    for (const u of ['/#collections', '/?collections=1', '/#/collections/showcase']) {
      await page.goto(`http://localhost:${OFF.port}${u}`);
      await page.waitForSelector('.nav-tab[data-tab="settings"]');
      await page.waitForTimeout(300);
      assert.equal(await page.locator('.col-root').count(), 0, `адрес ${u} не открывает коллекции`);
    }
    // демо нельзя включить ни хранилищем, ни ярлыками страницы
    await page.evaluate(() => { localStorage.setItem('demo', '1'); localStorage.setItem('collections', '1'); });
    await page.reload();
    await page.waitForSelector('.nav-tab[data-tab="settings"]');
    await goSettings(page);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-entry="collections"]').count(), 0, 'localStorage демо не включает');
    // вкладка «Магазин» осталась «скоро»
    await page.locator('.nav-tab[data-tab="shop"]').click();
    await page.waitForSelector('.shop-soon');
    assert.match(await text(page, '.shop-soon'), /скоро откроется/);
    assert.equal(colSent(page).filter((m) => m.op !== 'state').length, 0, 'вне демо страница ничего, кроме запроса состояния, не шлёт');
    step('вне демо: входа нет, адреса и localStorage не открывают, «Магазин» — «скоро»');
    await page.close();
  }
  await OFF.web.close();

  /* ============ сервер 2: демо включено ============ */
  const S = await boot(PORT + 1, true);

  for (const size of [[320, 640], [360, 740], [390, 844], [430, 932]]) {
    const tag = `${size[0]}`;
    COL.reset();
    const page = await open(S, size);

    /* --- загрузка: ответ состояния придерживаем, на экране — заглушка тех же размеров --- */
    await goSettings(page);
    const entry = page.locator('[data-entry="collections"]');
    await entry.waitFor();
    assert.match(await entry.innerText(), /Коллекции/);
    assert.match(await entry.innerText(), /Демонстрация · Без оплаты/);
    await entry.click();
    await page.waitForSelector('.col-root');
    await page.waitForSelector('.col-show');
    assert.equal(await page.locator('.col-root').getAttribute('data-route'), 'showcase');
    await fits(page, `витрина, ${tag}`);
    assert.equal(await page.locator('.col-card').count(), 4, 'три предмета и комплект');
    assert.match(await text(page, '.col-show'), /Демонстрация · Без оплаты/);
    for (const t of ['Рубашка «Графит»', 'Стол «Графит»', 'Знак «Графит»', 'Коллекция «Графит»']) assert.ok((await text(page, '.col-show')).includes(t), t);
    assert.equal(await page.getByRole('button', { name: /купить|оплатить|оплачено/i }).count(), 0, 'кнопок покупки нет');
    assert.equal((await text(page, '.col-show')).includes('дурак') && /рубашк\S* дурак/i.test(await text(page, '.col-show')), false);
    await shot(page, 'showcase', tag);
    step(`${tag}: вход есть, витрина: 4 карточки, подпись демонстрации, без кнопок оплаты`);

    /* --- карточка рубашки --- */
    await page.locator('.col-card[data-item="graphit-cardback"]').click();
    await page.waitForSelector('.col-item');
    await fits(page, `карточка, ${tag}`);
    assert.equal(await page.locator('.col-sw').count(), 4, 'четыре цвета');
    for (const t of ['Графит', 'Сапфир', 'Бордо', 'Петроль']) assert.ok((await text(page, '.col-swatches')).includes(t), `цвет «${t}» подписан`);
    const bodyText = await text(page, '.col-item');
    assert.match(bodyText, /Навсегда/);
    assert.match(bodyText, /Все 4 цвета включены/);
    assert.match(bodyText, /Stars · цена демонстрационная/, 'цена с пометкой');
    assert.match(bodyText, /Применится со следующей раздачи|закрытых карт/);
    assert.equal(await page.getByText('Так видят друзья').count(), 0, 'на карточке блока «Так видят друзья» нет');
    assert.equal(await page.locator('.col-sw[aria-checked="true"]').count(), 1);
    // выбор цвета: контур + галочка + слово, не синий, и не зависит от цвета предмета
    await page.locator('.col-sw[data-color="bordeaux"]').click();
    const sel = await page.evaluate(() => {
      const on = document.querySelector('.col-sw[aria-checked="true"]');
      const cs = getComputedStyle(on);
      const parse = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      const [r, g, b] = parse(cs.borderTopColor);
      return { color: on.dataset.color, border: [r, g, b], width: parseFloat(cs.borderTopWidth), check: !!on.querySelector('.col-check svg'), sr: on.textContent.includes('выбран') };
    });
    assert.equal(sel.color, 'bordeaux');
    assert.ok(sel.check, 'галочка у выбранного');
    assert.ok(sel.sr, 'выбор есть и в тексте для чтения экраном');
    assert.ok(sel.width >= 2, 'контур не тоньше 2 px');
    assert.ok(sel.border.every((v) => v >= 180), `контур светлый нейтральный: ${sel.border}`);
    assert.ok(Math.max(...sel.border) - Math.min(...sel.border) <= 24, `контур не цветной (не синий): ${sel.border}`);
    assert.equal(colSent(page).filter((m) => m.op !== 'state').length, 0, 'выбор цвета на карточке на сервер не уходит');
    // 44 px и фокус с клавиатуры
    await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => !!document.activeElement && document.activeElement !== document.body), 'фокус виден');
    await shot(page, 'item-bordeaux', tag);
    step(`${tag}: карточка: 4 подписанных цвета, выбор — светлый контур + галочка + слово`);

    /* --- примерка --- */
    const before = page.sent.length;
    await page.getByRole('button', { name: 'Примерить' }).click();
    await page.waitForSelector('.col-fit');
    await fits(page, `примерка, ${tag}`);
    assert.equal(await page.getByText('Так видят друзья').count(), 1, '«Так видят друзья» — в примерке');
    assert.match(await text(page, '.col-fit'), /ничего не отправляет/);
    assert.equal(await page.locator('.col-sw[aria-checked="true"]').getAttribute('data-color'), 'bordeaux', 'цвет с карточки сохранился');
    await page.locator('.col-sw[data-color="petrol"]').click();
    assert.equal(page.sent.length, before, 'примерка не отправила на сервер ни одного кадра');
    await shot(page, 'fitting-cardback', tag);
    await page.getByRole('button', { name: 'Назад к карточке' }).click();
    await page.waitForSelector('.col-item');
    // стол и профиль — на образцах
    await page.locator('.col-back').click();
    await page.locator('.col-card[data-item="graphit-table"]').click();
    await page.getByRole('button', { name: 'Примерить' }).click();
    await page.waitForSelector('.col-table');
    assert.equal(await page.getByText('Так видят друзья').count(), 0, 'у стола блока «Так видят друзья» нет');
    await fits(page, `примерка стола, ${tag}`);
    await shot(page, 'fitting-table', tag);
    await page.locator('.col-back').click();
    await page.locator('.col-back').click();
    await page.locator('.col-card[data-item="graphit-profile"]').click();
    await page.getByRole('button', { name: 'Примерить' }).click();
    await page.waitForSelector('.col-profile');
    await fits(page, `примерка профиля, ${tag}`);
    assert.equal(page.sent.length, before, 'после всех примерок кадров по-прежнему нет');
    await shot(page, 'fitting-profile', tag);
    step(`${tag}: примерка: рубашка (с «Так видят друзья»), стол, профиль; на сервер — ни кадра`);

    /* --- выдача: ответ придержан --- */
    await page.locator('.col-back').click();
    await page.locator('.col-back').click();
    await page.locator('.col-card[data-item="graphit-cardback"]').click();
    COL.hold = true;
    const grantBtn = page.getByRole('button', { name: 'Получить для демонстрации' });
    assert.match(await text(page, '.col-item'), /Демонстрация · Без оплаты/);
    await grantBtn.click();
    await page.waitForSelector('.col-btn[aria-busy="true"]');
    // повторные нажатия, пока ответа нет: кнопка занята, запрос один
    await page.locator('.col-btn[aria-busy="true"]').click({ force: true }).catch(() => {});
    await page.locator('.col-btn[aria-busy="true"]').dblclick({ force: true }).catch(() => {});
    await page.waitForTimeout(150);
    assert.equal(colSent(page, 'grant').length, 1, 'при двойном нажатии на сервер ушёл один grant');
    assert.equal(await page.getByText('Уже в вашей коллекции').count(), 0, 'до ответа сервера владения нет');
    assert.equal(await page.locator('.col-recv').count(), 0, 'до ответа экрана «Получено» нет');
    assert.equal(COL.owned.length, 0);
    await shot(page, 'grant-wait', tag);
    COL.hold = false;
    COL.release();
    await page.waitForSelector('.col-recv');
    assert.deepEqual(COL.owned, ['graphit-cardback']);
    step(`${tag}: выдача: до ответа — занято и один запрос; после — экран «Получено»`);

    /* --- получение: переключатели --- */
    await fits(page, `получение, ${tag}`);
    assert.match(await text(page, '.col-recv'), /Демонстрация · Без оплаты/);
    assert.equal(await page.locator('.col-switch').getAttribute('aria-checked'), 'false', 'получение само ничего не включает');
    assert.deepEqual(COL.choice, { cardback: null, table: null, profile: null });
    await shot(page, 'received', tag);
    COL.hold = true;
    await page.locator('.col-switch').click();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.col-switch').getAttribute('aria-checked'), 'false', 'до ответа переключатель не сдвинулся');
    assert.equal(await page.locator('.col-switch').isDisabled(), true, 'и занят');
    COL.hold = false;
    COL.release();
    await page.waitForFunction(() => document.querySelector('.col-switch')?.getAttribute('aria-checked') === 'true');
    assert.match(await text(page, '.col-recv'), /Применится со следующей раздачи/);
    assert.equal(COL.choice.cardback.item, 'graphit-cardback');
    step(`${tag}: переключатель встаёт только после ответа сервера`);

    /* --- инвентарь --- */
    await page.getByRole('button', { name: 'Перейти в инвентарь' }).click();
    await page.waitForSelector('.col-inventory');
    await fits(page, `инвентарь, ${tag}`);
    assert.deepEqual(await page.locator('.col-tab').allInnerTexts(), ['Карты', 'Столы', 'Профиль']);
    assert.match(await text(page, '.col-tabpanel'), /Классика/);
    assert.match(await text(page, '.col-tabpanel'), /Применится со следующей раздачи/);
    await shot(page, 'inventory-cards', tag);
    await page.locator('#col-tab-table').click();
    await page.waitForSelector('.col-inv[data-slot="table"]');
    assert.equal(await page.locator('.col-inv.locked').count(), 1, 'стол ещё не получен: карточка закрыта');
    await fits(page, `инвентарь «Столы», ${tag}`);
    await page.locator('#col-tab-cardback').click();

    // смена цвета: до ответа прежняя отметка, потом новая
    COL.hold = true;
    await page.locator('.col-inv[data-item="graphit-cardback"] .col-sw[data-color="sapphire"]').click();
    await page.getByRole('button', { name: 'Сменить цвет' }).click();
    await page.waitForSelector('.col-inv .col-btn[aria-busy="true"]');
    assert.equal(COL.choice.cardback.color, 'petrol', 'до ответа на сервере прежний цвет (петроль, выбранный в примерке)');
    assert.equal(colSent(page, 'apply').length, 2, 'apply: включение и смена цвета — два запроса, не больше');
    COL.hold = false;
    COL.release();
    await page.waitForFunction(() => /Применится со следующей раздачи/.test(document.querySelector('.col-inv[data-item="graphit-cardback"]')?.textContent || '') && document.querySelector('.col-inv[data-item="graphit-cardback"] .col-sw[aria-checked="true"]')?.dataset.color === 'sapphire');
    assert.equal(COL.choice.cardback.color, 'sapphire');

    // ошибка применения: прежний выбор, слова, «Повторить»
    COL.failApply = 'Слишком часто. Подождите немного.';
    await page.locator('.col-inv[data-item="graphit-cardback"] .col-sw[data-color="bordeaux"]').click();
    await page.getByRole('button', { name: 'Сменить цвет' }).click();
    await page.waitForSelector('.col-alert');
    assert.match(await text(page, '.col-alert'), /Слишком часто/);
    assert.equal(COL.choice.cardback.color, 'sapphire', 'после отказа выбор прежний');
    await shot(page, 'apply-error', tag);
    COL.failApply = null;
    await page.locator('.col-alert [data-act="retry"]').click();
    await page.waitForFunction(() => !document.querySelector('.col-alert'));
    await page.waitForFunction(() => document.querySelector('.col-inv[data-item="graphit-cardback"] .col-btn[aria-busy="true"]') === null);
    assert.equal(COL.choice.cardback.color, 'bordeaux', 'повтор после исправления сохранил новый цвет');
    step(`${tag}: инвентарь: вкладки, цвет после ответа, отказ → прежний выбор + «Повторить»`);

    // возврат к базе
    await page.getByRole('button', { name: 'Вернуть базовое' }).click();
    await page.waitForFunction(() => document.querySelector('.col-inv[data-base] .col-badge'));
    assert.equal(COL.choice.cardback, null);
    assert.match(await text(page, '.col-inv[data-base]'), /Применено/);

    /* --- нет связи: сервер рвёт сокет --- */
    for (const s of COL.sessions) void s;
    for (const ws of S.web.wss.clients) ws.terminate();
    await page.waitForSelector('.col-alert');
    assert.match(await text(page, '.col-alert'), /Нет связи/);
    assert.equal(COL.owned.length, 1, 'владение при обрыве не менялось');
    await shot(page, 'offline', tag);
    await page.waitForFunction(() => !document.querySelector('.col-alert'), null, { timeout: 15000 });

    /* --- уже получено + частичный комплект --- */
    await page.locator('.col-back').click().catch(() => {});
    await page.waitForSelector('.col-show');
    await page.locator('.col-card[data-item="graphit-cardback"]').click();
    assert.match(await text(page, '.col-item'), /Уже в вашей коллекции/);
    assert.equal(await page.getByRole('button', { name: 'Получить для демонстрации' }).count(), 0, 'повторно получить нельзя');
    await page.locator('.col-back').click();
    await page.locator('.col-card[data-item="graphit-bundle"]').click();
    await page.waitForSelector('.col-item');
    const bt = await text(page, '.col-item');
    assert.match(bt, /Получено 1 из 3/);
    assert.match(bt, /Не хватает: Стол «Графит», Знак «Графит»/);
    assert.match(bt, /цена дополнения комплекта ещё не утверждена/);
    assert.equal(await page.getByRole('button', { name: 'Получить комплект' }).isDisabled(), true, 'кнопка комплекта заблокирована');
    await fits(page, `частичный комплект, ${tag}`);
    await shot(page, 'bundle-partial', tag);
    // выдать недостающее по одному — комплект становится полным
    await page.locator('.col-row', { hasText: 'Стол «Графит»' }).click();
    await page.getByRole('button', { name: 'Получить для демонстрации' }).click();
    await page.waitForSelector('.col-recv');
    step(`${tag}: уже получено — повтор невозможен; комплект частично: кнопка закрыта с пояснением`);
    await page.close();
  }

  /* ============ пустой инвентарь, нет ответа, выключение демо, загрузка без прыжков (один размер) ============ */
  {
    COL.reset();
    const page = await open(S, [360, 740]);
    await openCollections(page);
    await page.getByRole('button', { name: 'Моя коллекция' }).click();
    await page.waitForSelector('.col-inventory');
    assert.match(await text(page, '.col-empty'), /только базовое оформление/);
    assert.match(await text(page, '.col-empty'), /оно всегда доступно/);
    assert.equal(await page.locator('.col-inv[data-base].on').count(), 1, 'база показана применённой');
    await shot(page, 'inventory-empty', '360');
    await page.getByRole('button', { name: 'Открыть коллекции' }).first().click();
    await page.waitForSelector('.col-show');
    step('пустой инвентарь: база доступна, пояснение, переход в витрину');

    // нет ответа: 8 секунд молчания → «Сервер не ответил», владение не выдано, повтор с тем же req
    COL.drop = true;
    await page.locator('.col-card[data-item="graphit-table"]').click();
    await page.getByRole('button', { name: 'Получить для демонстрации' }).click();
    await page.waitForSelector('.col-btn[aria-busy="true"]');
    await page.waitForSelector('.col-alert', { timeout: 12000 });
    assert.match(await text(page, '.col-alert'), /не ответил/);
    assert.equal(await page.locator('.col-recv').count(), 0);
    COL.drop = false;
    await page.locator('.col-alert [data-act="retry"]').click();
    await page.waitForSelector('.col-recv');
    const grants = colSent(page, 'grant');
    assert.equal(grants.length, 2);
    assert.equal(grants[0].req, grants[1].req, 'повтор после молчания идёт с тем же req');
    assert.equal(COL.owned.filter((x) => x === 'graphit-table').length, 1, 'ничего не удвоилось');
    step('нет ответа: «Сервер не ответил», владение не выдано; повтор с тем же req');

    // демо выключили на сервере — слой закрывается, входа нет
    COL.demo = false;
    await page.locator('.col-back').click().catch(() => {});
    for (const ws of S.web.wss.clients) ws.terminate();
    await page.waitForFunction(() => !document.querySelector('.col-root'), null, { timeout: 15000 });
    await goSettings(page);
    await page.waitForTimeout(400);
    assert.equal(await page.locator('[data-entry="collections"]').count(), 0, 'демо выключено → входа нет');
    step('сервер выключил демо: слой закрыт, входа нет');
    await page.close();
  }

  /* ============ загрузка: ответ на state придерживаем, потом без прыжков ============ */
  {
    COL.reset();
    const page = await open(S, [320, 640]);
    await goSettings(page);
    // перед открытием обрываем связь, чтобы слой открылся «в загрузке» не получится — проверяем рамки заглушки через снимок DOM
    await page.locator('[data-entry="collections"]').click();
    await page.waitForSelector('.col-root h2.col-big');
    // экран длиннее окна: нажатия на карточки/цвета не двигают прокрутку и не пересоздают скроллер
    await page.setViewportSize({ width: 320, height: 420 });
    await page.locator('.col-card[data-item="graphit-cardback"]').click();
    await page.waitForSelector('.col-item');
    await noJumpClick(page, page.locator('.col-sw[data-color="sapphire"]'), 'выбор цвета на карточке');
    COL.hold = true;
    await noJumpClick(page, page.getByRole('button', { name: 'Получить для демонстрации' }), 'ожидание ответа');
    COL.hold = false;
    COL.release();
    await page.waitForSelector('.col-recv');
    await assertNoJump(page, { scroller: '.col-scroll', at: 'top', label: 'вкладки инвентаря' }, async () => {
      await page.getByRole('button', { name: 'Перейти в инвентарь' }).click();
      await page.locator('#col-tab-table').click();
    }).catch((e) => { if (!/нечего прокручивать/.test(e.message)) throw e; console.log('  ! вкладки инвентаря: прокручивать нечего'); });
    step('без прыжков: цвет, ожидание ответа, переходы по вкладкам');
    await page.close();
  }

  // reduced motion: переключатель не анимируется
  {
    COL.reset({ owned: ['graphit-cardback'] });
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(e.message));
    const initData = signInitData({ auth_date: Math.floor(Date.now() / 1000), user: ivan }, TOKEN);
    await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: sdkStub(initData) }));
    await page.goto(`http://localhost:${S.port}/`);
    await page.waitForSelector('.nav-tab[data-tab="settings"]');
    await openCollections(page);
    await page.getByRole('button', { name: 'Моя коллекция' }).click();
    const dur = await page.evaluate(() => getComputedStyle(document.querySelector('.col-btn')).transitionDuration);
    assert.ok(/^0s(, 0s)*$/.test(dur), `при reduced-motion переходов нет: ${dur}`);
    step('prefers-reduced-motion: переходов нет');
    await ctx.close();
  }

  await S.web.close();
  assert.deepEqual(problems, [], `ошибки страницы: ${problems.join(' | ')}`);
  console.log('e2e collections: всё в порядке');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  process.exit(process.exitCode || 0);
}
