/**
 * UX-симуляция общего пути: вход, главная, лобби, приглашение, профиль,
 * поддержка, рейтинг, магазин, меню в партии, «Вернуться к столу».
 *
 *   node tools/ux-sim-common.mjs [--update] [--only=главная]
 */
import {
  runSim, observe, user, cmdUpdate, text, count, sheetTitle, buttonsOf, until, sleep,
} from './lib/ux-sim.mjs';

const ivan = user(1000, 'Иван');
const GAMES = ['poker', 'durak', 'colors', 'chess', 'checkers', 'nardy', 'battleship'];

async function hubPage(s, opts) {
  const chat = s.nextChat();
  await s.app.handleUpdate(cmdUpdate(Number(chat), ivan, '/game', { message_id: 1 }));
  await s.app.settle();
  const group = s.app.groups.get(String(chat));
  const page = await s.page(ivan, `g_${group.code}`, opts);
  await page.waitForSelector('.game-card');
  return { page, chat, group, start: `g_${group.code}` };
}
const screen = async (p) => ({ заголовок: await text(p, '#app h1'), окно: await sheetTitle(p) });
const nav = (p, tab) => p.locator(`.nav-tab[data-tab="${tab}"]`).click();

const scenarios = [
  ['вход: открыто не из Telegram', async (s) => {
    const p = await s.page(ivan, '');
    await p.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.__sent=[];' }));
    await p.reload();
    await sleep(800);
    return { экран: await text(p, '.fatal') };
  }],
  ['главная: что на первом экране', async (s) => {
    const { page } = await hubPage(s);
    return {
      заголовок: await text(page, '#app h1'),
      подсказка: await text(page, '.hub-pick'),
      игр: await count(page, '.game-card'),
      вкладки: await buttonsOf(page, '.nav-tab'),
      системная_назад: await page.evaluate(() => !!window.__back),
    };
  }],
  ['главная: создать лобби — число касаний и окно настроек', async (s) => {
    const { page } = await hubPage(s);
    const формы = {};
    for (const g of GAMES) {
      await page.locator(`.game-card.g-${g}`).click();
      await page.waitForSelector('.sheet');
      формы[g] = { окно: await sheetTitle(page), разделы: await text(page, '#sheet-root .section-label, #sheet-root .field label') };
      await page.locator('#sheet-root .sheet-dismiss').click();
      await sleep(150);
    }
    await page.locator('.game-card.g-durak').click();
    const создать = await observe(page, () => page.locator('#sheet-root button', { hasText: 'Создать лобби' }).click(), screen);
    return { касаний_до_лобби: 2, формы, создать };
  }],
  ['лобби: пустые места, приглашение, кнопки хоста — по играм', async (s) => {
    const out = {};
    for (const g of GAMES) {
      const t = await s.table(g, { names: ['Иван'], start: false });
      const [p] = t.pages;
      const пригласить = p.locator('.lseat.invite');
      const row = {
        приглашений: await пригласить.count(),
        пункты: await buttonsOf(p, '.lobby .menu-item'),
        низ: await buttonsOf(p, '.panel button'),
        назад_на_экране: await text(p, '.back-link'),
      };
      if (row.приглашений) {
        const r = await observe(p, () => пригласить.first().click());
        await sleep(400);
        row.нажали = { ...r, поделиться_открылось: await p.evaluate(() => window.__shared.length + window.__opened.length) };
      }
      out[g] = row;
    }
    return out;
  }],
  ['лобби: кнопка «Хост» — есть ли в окне то, что она обещает', async (s) => {
    const out = {};
    for (const g of GAMES) {
      const t = await s.table(g, { start: false });
      const [p] = t.pages;
      const кнопка = p.locator('.lobby .menu-item', { hasText: 'Хост' }).first();
      const обещает = await кнопка.locator('small').textContent();
      await кнопка.click();
      await sleep(300);
      const пункты = await buttonsOf(p, '#sheet-root .menu-item');
      out[g] = { обещает, окно: await sheetTitle(p), удалить: пункты.some((x) => /Удалить игрока/.test(x)), передать: пункты.some((x) => /Передать права/.test(x)) };
      await s.closeAll();
    }
    return out;
  }],
  ['лобби: «Встать» и «Начать» без соперника', async (s) => {
    const t = await s.table('chess', { names: ['Иван'], start: false });
    const [p] = t.pages;
    const начать = { кнопка: await buttonsOf(p, '.panel button'), причина: await text(p, '.panel small') };
    const встать = await observe(p, () => p.locator('.panel button', { hasText: 'Встать' }).click(), async (q) => ({ окно: await sheetTitle(q), низ: await buttonsOf(q, '.panel button') }));
    return { начать, встать };
  }],
  ['вернуться к столу: из главной после выхода из партии', async (s) => {
    const { page, chat, start } = await hubPage(s);
    await page.locator('.game-card.g-chess').click();
    await page.locator('#sheet-root button', { hasText: 'Создать лобби' }).click();
    await until(() => s.app.roomsOf(chat).length === 1, 'лобби создано');
    await page.waitForSelector('h1:has-text("Шахматы")');
    const назад = await observe(page, () => page.locator('.back-link').first().click(), screen);
    await page.waitForSelector('.back-to-table');
    const кнопка = await text(page, '.back-to-table');
    const вернулся = await observe(page, () => page.locator('.back-to-table').click(), screen);
    await sleep(300);
    await page.evaluate(() => window.__backClick?.());
    await sleep(600);
    const системная = await screen(page);
    return { назад, кнопка, вернулся, системная_назад: системная, повторный_вход: await (async () => {
      const p2 = await s.page(ivan, start);
      await p2.waitForSelector('.game-card');
      return text(p2, '.back-to-table');
    })() };
  }],
  ['профиль: что на вкладке и поддержка', async (s) => {
    const { page } = await hubPage(s);
    await nav(page, 'settings');
    await page.waitForSelector('.pt-support-btn');
    await sleep(500);
    const кнопки = await buttonsOf(page, '.settings button.btn');
    const id = await observe(page, () => page.locator('[data-act="copy-id"]').click());
    await page.locator('.pt-support-btn').click();
    await sleep(300);
    return {
      разделы: await text(page, '.section-label'),
      кнопки,
      скопировать: id,
      поддержка_открыла: await page.evaluate(() => window.__opened.map((u) => u.replace(/^https:\/\/t\.me\/[^?]+/, 'бот'))),
      касаний_до_поддержки: 2,
    };
  }],
  ['рейтинг: что видно на вкладке и с главной', async (s) => {
    const { page } = await hubPage(s);
    const с_главной = await buttonsOf(page, '.hub button.k-btn');
    await nav(page, 'rating');
    await sleep(700);
    return { с_главной, заголовок: await text(page, '#app h1, #app h2'), кнопки: await buttonsOf(page, '#app button:not(.nav-tab)') };
  }],
  ['магазин: вкладка при закрытых продажах', async (s) => {
    const { page } = await hubPage(s);
    const есть = await count(page, '.nav-tab[data-tab="shop"]');
    if (!есть) return { вкладка: false };
    await nav(page, 'shop');
    await page.getByText('Мои вещи').first().waitFor();
    await sleep(900);
    const слова = await page.evaluate(() => document.body.innerText.split('\n').map((x) => x.trim()).filter((x) => /Магазин|Каталог|Мои вещи|покупки|Найдено|^Игра$|Цена/.test(x)));
    const списков = await page.locator('select:visible').count();
    const назад = await page.evaluate(() => { const was = !!window.__back; window.__backClick?.(); return was; });
    await sleep(500);
    return { вкладка: true, слова: [...new Set(слова)].map((x) => x.replace(/\d+/g, 'N')), выпадающих_списков: списков, системная_назад_есть: назад, после_назад: await text(page, '#app h1') };
  }],
  ['меню в партии: пункты по играм и закрытие', async (s) => {
    const out = {};
    for (const g of GAMES) {
      const t = await s.table(g);
      const [p] = t.pages;
      await p.locator('[aria-label="Меню"]').first().click();
      await sleep(300);
      const пункты = await buttonsOf(p, '#sheet-root .menu-item');
      const низ = await buttonsOf(p, '#sheet-root button:not(.menu-item)');
      out[g] = { пункты, низ };
      await s.closeAll();
    }
    return out;
  }],
  ['меню хоста: «Удалить игрока» посреди партии — есть ли подтверждение', async (s) => {
    const out = {};
    for (const g of ['durak', 'chess', 'poker']) {
      const t = await s.table(g);
      const [p] = t.pages;
      await p.locator('[aria-label="Меню"]').first().click();
      await p.locator('#sheet-root .menu-item', { hasText: 'Удалить игрока' }).click();
      await sleep(300);
      const список = await sheetTitle(p);
      const тап_по_имени = await observe(p, () => p.locator('#sheet-root .menu-item', { hasText: 'Макс' }).click(), async (q) => ({ ещё_одно_окно: await sheetTitle(q) }));
      out[g] = { список, тап_по_имени };
      await s.closeAll();
    }
    return out;
  }],
  ['меню хоста: «Завершить игру» и «Удалить игру» спрашивают', async (s) => {
    const out = {};
    for (const g of GAMES) {
      const t = await s.table(g);
      const [p] = t.pages;
      const row = {};
      for (const name of ['Завершить игру', 'Удалить игру', 'Прервать партию', 'Сдаться']) {
        await p.locator('[aria-label="Меню"]').first().click();
        await sleep(200);
        const item = p.locator('#sheet-root .menu-item', { hasText: name });
        if (await item.count()) {
          row[name] = await observe(p, () => item.first().click(), async (q) => ({ окно: await sheetTitle(q), кнопки: await buttonsOf(q, '#sheet-root button:not(.sheet-dismiss)') }));
        }
        await p.locator('#sheet-root .sheet-dismiss').click().catch(() => {});
        await sleep(150);
      }
      out[g] = row;
      await s.closeAll();
    }
    return out;
  }],
  ['игры с ботами: вход и «Продолжить»', async (s) => {
    const p = await s.page(user(2000, 'Новичок'), 'solo');
    await p.waitForSelector('.game-card');
    const вход = { заголовок: await text(p, '#app h1'), игр: await count(p, '.game-card') };
    await p.locator('.game-card.g-durak').click();
    await p.waitForSelector('.sheet');
    const форма = { окно: await sheetTitle(p), разделы: await text(p, '#sheet-root .section-label'), кнопки: await buttonsOf(p, '#sheet-root .btn.primary') };
    await p.locator('#sheet-root .btn.primary').click();
    await sleep(900);
    return { вход, форма, за_столом: !!(await p.locator('.dk-hand').count()) };
  }],
];

await runSim('общее', scenarios);
