/** K: реальные страницы и локальный Hub; Telegram/оплата только заглушки. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { Store } from '../bot/store.js';
import { startServer } from '../bot/server.js';
import { TelegramStub, cmdUpdate, dmUpdate, user } from '../bot/tg-stub.js';
import { signInitData } from '../bot/webapp-auth.js';
import { cfgOf } from '../bot/payments/testkit.js';

const port = Number(process.env.E2E_PORT || 8254);
const token = `0:${crypto.randomBytes(16).toString('hex')}`;
const api = new TelegramStub();
const app = new App({ api, store: new Store(':memory:'), sales: cfgOf({ mode: 'test' }), botUsername: 'All_InPoker_bot', webappUrl: `http://localhost:${port}`, miniAppName: 'table', minIntervalMs: 0, runoutStepMs: 0 });
const hub = new Hub(app, { botToken: token }); app.attachHub(hub);
const web = startServer({ hub, port, host: '127.0.0.1', root: new URL('../miniapp', import.meta.url).pathname, log() {} });
await new Promise(r => web.server.once('listening', r));
const browser = await chromium.launch();
const errors = [];
const only = process.env.UX_CASE;
const run = name => !only || only === name;
const until = async (f, label) => { for (let i=0;i<200;i++) { if (await f()) return; await new Promise(r=>setTimeout(r,25)); } throw Error(label); };
async function open(u, start, width, reducedMotion = 'reduce') {
  const p = await browser.newPage({ viewport: { width, height: width === 320 ? 568 : 844 }, reducedMotion });
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const init = signInitData({ auth_date: Math.floor(Date.now()/1000), user: u, start_param: start }, token);
  await p.route('https://telegram.org/**', r => r.fulfill({ contentType:'text/javascript', body: `
    const NativeWS=window.WebSocket;window.WebSocket=class extends NativeWS{constructor(...args){super(...args);(window.__sockets ||= []).push(this)}};window.Telegram={WebApp:{initData:${JSON.stringify(init)},initDataUnsafe:{start_param:${JSON.stringify(start)}},ready(){},expand(){},close(){},disableVerticalSwipes(){},setHeaderColor(){},setBackgroundColor(){},setBottomBarColor(){},onEvent(){},openTelegramLink(u){window.__link=u},BackButton:{show(){window.__backShown=true},hide(){window.__backShown=false},onClick(f){window.__back=f}},HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}}}};` }));
  p.setDefaultTimeout(5000);
  await p.goto(`http://localhost:${port}/`);
  await p.waitForSelector('.nav, .lobby');
  await p.evaluate(async()=>{window.__net=await import('/net.js')});
  return p;
}
const refresh = p => p.evaluate(async () => { const {send}=await import('/net.js'); send({t:'refresh'},{lock:false}); });
async function settings(p) { await p.locator('[data-tab=settings]').click(); await p.waitForSelector('.pf-input'); await p.waitForFunction(()=>document.querySelectorAll('.pf-cell').length===12); }
const back = p => p.evaluate(()=>window.__back());
async function shot(p, name) {
  if (!process.env.SHOTS) return;
  // Сообщение о только что начатой партии живёт 3,2 с: снимок формы делаем после него.
  await p.waitForFunction(() => !document.querySelector('#toast')?.classList.contains('show'));
  fs.mkdirSync('preview/uxtext', { recursive: true });
  await p.screenshot({ path: `preview/uxtext/${name}.png` });
}

try {
 for (const width of [320,390]) {
  const u = user(1000+width,'ОченьДлинноеИмяИгрока'); api.dmOpen.add(String(u.id));
  await app.handleUpdate(dmUpdate(u,'/start'));
  const chat=-100000-width;
  await app.handleUpdate(cmdUpdate(chat,u,'/game')); await app.settle();
  const group=app.groups.get(String(chat));
  const p=await open(u,`g_${group.code}`,width);
  if(run('profile')) {
   await settings(p);
   await p.getByRole('radio',{name:'Без аватара',exact:true}).focus();
   await p.keyboard.press('ArrowRight');
   assert.equal(await p.getByRole('radio',{name:'Аватар 1',exact:true}).getAttribute('aria-checked'),'true','аватар выбирается стрелками');
   assert.equal(await p.getByRole('radio',{name:'Аватар 1',exact:true}).evaluate(e=>document.activeElement===e),true,'фокус следует за выбором');
   await p.locator('.pf-input').fill('Черновик');
   await p.locator('.pf-cell').nth(2).click();
   await refresh(p); await p.evaluate(async()=>{const {send}=await import('/net.js');send({t:'profile'},{lock:false})}); await p.waitForTimeout(250);
   assert.equal(await p.locator('.pf-input').inputValue(),'Черновик','несохранённый ник переживает обновление после выбора аватара');
   await p.locator('[data-tab=games]').click(); await settings(p);
   assert.equal(await p.locator('.pf-input').inputValue(),'Черновик','черновик после возврата');
   assert.equal(app.store.getProfile(String(u.id)).nickname,null,'черновик сам не сохранился');
   await shot(p,`profile-${width}`);
   await p.locator('.pf-input').fill('@boss'); await p.locator('.pf-save').click();
   await p.waitForFunction(()=>document.querySelector('.pf-err')?.textContent.length>0);
   await p.evaluate(async()=>{const {send}=await import('/net.js');send({t:'profile'},{lock:false})}); await p.waitForTimeout(200);
   assert.equal(await p.locator('#toast').innerText()==='Профиль сохранён',false,'после отказа повторный ответ не выдаётся за сохранение');
  }
  if(run('modal')) {
   await p.locator('[data-tab=games]').click();
   const trigger=p.locator('.game-card.g-poker'); await trigger.focus(); await trigger.press('Enter');
   const dlg=p.getByRole('dialog');
   await dlg.waitFor({timeout:2000});
   assert.match(await dlg.getAttribute('aria-label'),/Покер/,'у диалога есть имя');
   assert.equal(await p.getByRole('spinbutton',{name:'Малый блайнд',exact:true}).count(),1,'у числового поля есть доступное имя');
   assert.equal(await p.evaluate(()=>!!document.activeElement?.closest('[role=dialog]')),true,'фокус внутри');
   assert.equal(await p.locator('#app').evaluate(e=>e.inert),true,'фон диалога недоступен для ввода');
   for(let i=0;i<18;i++) { await p.keyboard.press('Tab'); assert.equal(await p.evaluate(()=>!!document.activeElement?.closest('[role=dialog]')),true,'Tab не уходит в фон'); }
   await p.keyboard.press('Shift+Tab');
   assert.equal(await p.evaluate(()=>!!document.activeElement?.closest('[role=dialog]')),true);
   await shot(p,`dialog-${width}`);
   await refresh(p); await p.waitForTimeout(200);
   await p.keyboard.press('Escape'); await dlg.waitFor({state:'detached'});
   assert.equal(await trigger.evaluate(e=>document.activeElement===e),true,'фокус вернулся на карточку');
  }
  if(run('back')) {
   await settings(p);
   assert.equal(await p.evaluate(()=>window.__backShown),true,'Назад доступен в настройках');
   await back(p); await p.waitForSelector('.gc-pager');
   assert.equal(await p.locator('.settings').count(),0,'Назад закрыл настройки');
   await p.locator('[data-tab=shop]').click(); await p.waitForSelector('.col-root');
   assert.equal(await p.locator('#app').evaluate(e=>e.inert),true,'фон коллекций недоступен для ввода');
   await p.locator('[data-item="graphit-table"]').first().click();
   await p.waitForSelector('.col-root[data-route=item]');
   await back(p); await p.waitForSelector('.col-root[data-route=showcase]');
   await back(p); await p.waitForSelector('.col-root',{state:'detached'});
   assert.equal(await p.locator('.gc-pager').count(),1,'после коллекций прежний каталог');
   await p.locator('.game-card.g-poker').click(); await p.waitForSelector('.sheet');
   await back(p); await p.waitForSelector('.sheet',{state:'detached'});
   assert.equal(await p.locator('.gc-pager').count(),1,'Назад закрыл форму создания без смены группы');
   await p.evaluate(async()=>{const {startRun}=await import('/train/screens.js');startRun({track:'preflop',exercise:'w-preflop-open-1',seed:1,level:1});});
   await p.locator('.tr-opt').first().click(); await back(p);
   await p.getByRole('dialog',{name:'Выйти из задания?'}).waitFor();
   await p.getByRole('button',{name:'Остаться',exact:true}).click();
   assert.equal(await p.locator('.tr-opt.on').count(),1,'Back не теряет выбранный ответ без подтверждения');
   await back(p); await p.locator('[data-go=leave]').click();
   await p.waitForSelector('.tr:not(.tr-ex)'); await back(p); await back(p);
   await p.waitForSelector('.gc-pager');
  }
  if(run('copy')) {
   await p.locator('[data-tab=rating]').click();
   assert.equal(await p.getByText('Очки за доигранные партии уже копятся. Таблица игроков пока закрыта.').count(),1,'закрытый рейтинг не выдаёт будущую модель за текущую');
   await p.locator('[data-tab=shop]').click(); await p.locator('[data-act=purchases]').click();
   assert.equal(await p.getByRole('button',{name:'Получить номера заказов',exact:true}).count(),1,'название кнопки соответствует справке, а не ответу оператора');
   await p.locator('.col-purchases [data-act=support]').click();
   await p.getByText('Сведения о покупках отправлены вам в личку с ботом.').waitFor();
   assert.equal(await p.evaluate(()=>!!document.activeElement?.closest('.col-root')),true,'коллекции сохраняют фокус при ответе сервера');
   await shot(p,`purchases-${width}`);
   await p.keyboard.press('Escape'); await p.waitForSelector('.col-root[data-route=showcase]'); await p.keyboard.press('Escape'); await p.waitForSelector('.col-root',{state:'detached'});
  }
  if(run('reduced')) {
   await p.locator('[data-tab=games]').click();
   const behavior=await p.evaluate(async()=>{const t=document.querySelector('.gc-track'); const orig=t.scrollTo.bind(t); window.__behavior=[]; t.scrollTo=o=>{window.__behavior.push(o.behavior);orig(o)};document.querySelector('.gc-next').click();return window.__behavior;});
   assert.ok(!behavior.includes('smooth'),'каталог не анимирует прокрутку при reduced-motion');
  }
  await p.close(); console.log(`K ${width}: ${only || 'все сценарии'} — ok`);
 }
 if(run('settings')) {
  const commands={poker:'/newgame',durak:'/durak',colors:'/unoq',chess:'/chess',checkers:'/checkers',nardy:'/nardy',battleship:'/battleship'};
  let index=0;
  for(const [game,command] of Object.entries(commands).filter(([g])=>!process.env.UX_GAME || process.env.UX_GAME===g)) for(const width of [320,390]) {
   const n=++index; const host=user(3000+n,'ДлинноеИмяХоста'),guest=user(4000+n,'ДлинноеИмяГостя'); const chat=-200000-n;
   await app.handleUpdate(cmdUpdate(chat,host,command)); await app.settle(); const room=app.room(chat);
   const p=await open(host,room.code,width), g=await open(guest,room.code,width);
   await g.getByRole('button',{name:/Сесть за/}).first().click(); await until(()=>room.players.length===2,'оба за столом');
   const before=structuredClone(room.settings);
   const settingsButton=p.locator('.lobby .menu-item').filter({hasText: game==='poker'?'Настройки стола':'Настройки'});
   await settingsButton.click(); await p.waitForSelector('.sheet');
   assert.equal(await g.locator('.lobby .menu-item').filter({hasText:'Настройки'}).count(),0,`${game}: гость не видит настройки`);
   if(game==='poker') await p.locator('.sheet input.num').nth(1).fill('30');
   else await p.locator('.sheet .seg').first().locator('button').last().click();
   await refresh(p); await p.waitForTimeout(120);
   await p.evaluate(()=>{window.__oldSocket=window.__sockets.length;window.__sockets.at(-1).close()});
   if(game!=='colors') {
    await p.getByRole('button',{name:'Сохранить',exact:true}).click();
    assert.equal(await p.locator('.sheet').count(),1,'offline: форма не закрывается при неотправленных настройках');
   }
   await p.waitForFunction(()=> window.__sockets.length>window.__oldSocket && window.__net.isOpen() && window.__net.net.connected);
   await p.waitForTimeout(150);
   if(game==='colors') {
    await until(()=>room.settings.stacking===false,'UNOQ применяет сразу');
    assert.equal(await p.getByText('Изменения применяются сразу.').count(),1);
    const layout=await p.locator('.sheet .field').evaluateAll(es=>es.map(e=>{const l=e.querySelector('label').getBoundingClientRect(),s=e.querySelector('.seg').getBoundingClientRect(),h=e.querySelector('.hint').getBoundingClientRect();return {ordered:l.bottom<=s.top+1 && s.bottom<=h.top+1,buttons:[...e.querySelectorAll('button')].every(b=>b.getBoundingClientRect().width>=44)}}));
    assert.ok(layout.every(r=>r.ordered && r.buttons),'UNOQ: подпись, выбор и пояснение расположены по вертикали, кнопки ≥44');
   } else {
    assert.deepEqual(room.settings,before,`${game}: черновик не применяется до сохранения`);
    await p.keyboard.press('Escape');
    assert.deepEqual(room.settings,before,`${game}: отмена без записи`);
    await settingsButton.click();
    if(game==='poker') await p.locator('.sheet input.num').nth(1).fill('30');
    else await p.locator('.sheet .seg').first().locator('button').last().click();
    await refresh(p); await p.waitForTimeout(120);
   await p.evaluate(()=>{window.__oldSocket=window.__sockets.length;window.__sockets.at(-1).close()});
   await p.waitForFunction(()=> window.__sockets.length>window.__oldSocket && window.__net.isOpen() && window.__net.net.connected);
   await p.waitForTimeout(150);
    await p.getByRole('button',{name:'Сохранить',exact:true}).click();
    await until(()=>JSON.stringify(room.settings)!==JSON.stringify(before),`${game}: сохранено`);
   }
   await p.keyboard.press('Escape');
   await p.getByRole('button',{name:/Начать/}).first().click();
   await until(()=>room.status==='playing',`${game}: началось`);
   await p.getByRole('button',{name:'Меню',exact:true}).click();
   const item=p.locator('.sheet .menu-item').filter({hasText:game==='poker'?'Настройки стола':'Настройки'});
   if(['chess','checkers','nardy','battleship'].includes(game)) {
    assert.equal(await item.count(),0,`${game}: часы/цвет нельзя менять в партии`);
   } else {
    await item.click();
    const live=structuredClone(room.hand || room.deal); const timer=room.settings.turnSeconds;
    const seg=p.locator('.sheet .seg').filter({has:p.getByRole('button',{name:'60 с',exact:true})});
    await seg.getByRole('button',{name:'60 с',exact:true}).click();
    if(game!=='colors') await p.getByRole('button',{name:'Сохранить',exact:true}).click();
    await until(()=>room.settings.turnSeconds===60,`${game}: таймер применён`);
    assert.deepEqual(room.hand || room.deal,live,`${game}: раздача, очередь и банк прежние`);
    assert.notEqual(timer,room.settings.turnSeconds);
   }
   await shot(p,`${game}-settings-live-${width}`);
   await p.keyboard.press('Escape');
   // Серверные пределы/права дополнительно проверяются npm test (settings.live, multiplayer).
   const overflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
   assert.equal(overflow,false,`${game}: не шире экрана`);
   await p.close();await g.close();console.log(`K settings ${game} ${width}: ok`);
  }
 }
 assert.deepEqual(errors,[],'ошибок JS/ресурсов нет');
} catch(e) { console.error(e); process.exitCode=1; } finally { await browser.close(); await web.close(); app.stop?.(); }
