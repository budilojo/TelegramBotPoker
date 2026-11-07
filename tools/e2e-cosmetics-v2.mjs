/** C: real seven clients, 320/390, six collections. Local HTTP/WS, TelegramStub only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { Table,user,initDataFor,TEST_TOKEN } from '../bot/harness.js';
import { GAME_LIST } from '../bot/games/index.js';
import { startServer } from '../bot/server.js';
import { BOARD_SLOT } from '../bot/collections/index.js';
import { V2_ITEMS,itemById } from '../miniapp/collections/catalog.js';
const root=path.resolve(import.meta.dirname,'..'),out=process.env.COSMETICS_V2_SHOTS || path.join(root,'docs/cosmetics-v2/reports/integration-screens');fs.mkdirSync(out,{recursive:true});
const H=user(700101001,'Алиса'),B=user(700101002,'Боб'),S=user(700101003,'Зритель');
const t=new Table({admins:[String(H.id)],nardyDice:()=>[5,3],battleshipFleetRand:()=>.37});
const web=startServer({hub:t.hub,port:0,host:'127.0.0.1',root:path.join(root,'miniapp'),log:()=>{}});await new Promise(r=>web.server.once('listening',r));
const url=`http://127.0.0.1:${web.server.address().port}`,browser=await chromium.launch();
console.log('Chromium',browser.version());
const problems=[],rendered=new Set();let n=0;
const sdk=data=>`window.Telegram={WebApp:{initData:${JSON.stringify(data)},initDataUnsafe:{start_param:new URLSearchParams(${JSON.stringify(data)}).get('start_param')},ready(){},expand(){},close(){},disableVerticalSwipes(){},setHeaderColor(){},setBackgroundColor(){},setBottomBarColor(){},onEvent(){},openTelegramLink(){},BackButton:{show(){},hide(){},onClick(f){window.__back=f}},HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}}}};`;
async function open(who,code,width){
 const context=await browser.newContext({viewport:{width,height:width===320?568:844}}),page=await context.newPage(),frames=[];
 page.setDefaultTimeout(6000);
 const data=initDataFor(who,{startParam:code,clock:t.clock,token:TEST_TOKEN});
 await page.route('https://telegram.org/**',r=>r.fulfill({contentType:'text/javascript',body:sdk(data)}));
 page.on('pageerror',e=>problems.push(e.message));
 page.on('websocket',ws=>ws.on('framereceived',({payload})=>frames.push(JSON.parse(String(payload)))));
 await page.goto(url);await page.waitForSelector('.lobby,.game-card');
 return {page,context,frames,who};
}
const send=(p,m)=>p.page.evaluate(async m=>(await import('/net.js')).send(m,{lock:false}),m);
const last=p=>p.frames.filter(m=>m.t==='state'&&m.state.game).at(-1)?.state;
async function until(f,label){const end=Date.now()+6000;while(!await f()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,20));}}
const slotOf=g=>['poker','durak'].includes(g)?'table':g==='colors'?'unoq-cardback':BOARD_SLOT[g];
const surfaceSelector=g=>['poker','durak','colors'].includes(g)?'.surface-felt':g==='nardy'?'.nd-wrap':g==='battleship'?'.bs-frame':'.ch-frame';
const fieldSelector=g=>['poker','durak','colors'].includes(g)?'.surface-felt':g==='nardy'?'.nd-board':g==='battleship'?'.bs-grid':'.ch-board';
async function checkSurface(p, game, series, decode = true) {
  const themed = p.page.locator(`${surfaceSelector(game)}[data-surface="${series}"]`);
  await themed.first().waitFor();
  if (game === 'battleship') assert.equal(await themed.count(), 2, 'both boards are themed');
  const field = p.page.locator(fieldSelector(game)).first();
  const paint = await field.evaluate(async (el, { series, decode }) => {
    const css = getComputedStyle(el), image = css.backgroundImage;
    if (decode) {
      const texture = new Image();
      texture.src = image.match(/^url\("(.*)"\)$/)?.[1] ?? '';
      await texture.decode();
    }
    return { image, base: css.backgroundColor,
      light: el.querySelector('.ch-sq:not(.dark)') && getComputedStyle(el.querySelector('.ch-sq:not(.dark)')).backgroundColor,
      dark: el.querySelector('.ch-sq.dark') && getComputedStyle(el.querySelector('.ch-sq.dark')).backgroundColor,
      point: el.querySelector('.nd-pt') && getComputedStyle(el.querySelector('.nd-pt'),'::before').backgroundImage,
      expected: '/collections/surfaces/' + series + '.svg' };
  }, { series, decode });
  assert.ok(paint.image.includes(paint.expected), 'the full playing area has the material');
  assert.notEqual(paint.base, 'rgba(0, 0, 0, 0)');
  if (['chess','checkers'].includes(game)) {
    assert.ok(paint.light.startsWith('color(srgb') && paint.dark.startsWith('color(srgb'));
    assert.notEqual(paint.light, paint.dark);
  }
  if (game === 'nardy') assert.ok(paint.point.includes(paint.expected), 'inlaid points carry the theme');
  if (game === 'colors') {
    const back = p.page.locator('.cv2-deck-back').first();
    await back.waitFor();
    assert.equal(await back.evaluate(async el=>{await el.decode();return el.getAttribute('src');}),itemById(series+'-unoq-cardback').assets.game);
  }
  assert.equal(await p.page.locator('.cv2-board-art, .gr-v2 .gr-orn').count(), 0, 'no overlay on boards or collection cloth');
  return paint.base;
}
try {
 for(const width of [320,390]) for(const g of GAME_LIST){
  t.chatId=-93000-(++n);await t.cmd(H,'/game');t.openHub(H);await t.send(H,{t:'create',game:g.id,settings:{}});
  const room=t.app.roomByCode(t.page(H).session.code);t.openRoom(B,room);await t.send(B,{t:'sit'});
  const pages=[];
  try {
   for(const who of [H,B,S])pages.push(await open(who,room.code,width));
   const [h,b,spy]=pages,slot=slotOf(g.id);
   const apply=async collection=>{
    t.app.collections.limits.clear();
    const r=t.app.collections.handle({id:String(H.id)},{t:'col',v:2,op:'apply-bundle',item:`${collection}-bundle`,req:`browser-${++n}`});assert.equal(r.error,undefined);await t.app.settle();
    for(const p of pages)await p.page.waitForSelector(`[data-v2-frame="${collection}-frame"]`);
   };
   // All 54 actual game assets are exercised in the real screens, not just manifest entries.
   for(const collection of ['sever','obsidian','chertezh','terracotta','orbita','porcelain']){
    await apply(collection);
    // Lobby has personal art; shared art appears when game is started, new room per collection would be redundant.
    // Render the supported game asset through the same game's existing renderer against a saved public start snapshot below.
   }
   await apply('sever');await send(h,{t:'start'});await until(()=>last(spy)?.room.status==='playing','start');
   if(g.id==='battleship') for(const p of [h,b]) { await send(p,{t:'random'}); await until(()=>last(p)?.match?.boards?.some(x=>x.ships.length>0),'placement'); await send(p,{t:'ready'}); }
   if(g.id==='battleship') await until(()=>last(spy)?.match?.phase==='battle','battle');
   const base = await checkSurface(h, g.id, 'sever');
   for (const p of [b,spy]) assert.equal(await checkSurface(p,g.id,'sever'),base);
   const frozen=structuredClone(last(spy).look),turn=structuredClone(room.turn);
   t.app.collections.limits.clear();await send(h,{t:'col',v:2,op:'apply',item:`orbita-${slot}`,slot,color:'default',req:`browser-${++n}`});
   await until(()=>h.frames.some(m=>m.t==='col'&&m.op==='apply'&&m.when==='next-deal'),'pending ack');
   assert.deepEqual(last(spy).look,frozen);assert.deepEqual(room.turn,turn);
   // Preview uses the very same catalog/game URL resolver; sample all six current-party variants locally.
   for(const collection of ['sever','obsidian','chertezh','terracotta','orbita','porcelain']){
    for(const p of pages)await p.page.evaluate(async({collection,slot,game})=>{
      const net=await import('/net.js'),registry=await import('/games/index.js');
      const s=structuredClone(net.net.state),entry=item=>({item,color:'default'});
      s.look.dealNo+=100+['sever','obsidian','chertezh','terracotta','orbita','porcelain'].indexOf(collection);
      s.look.table=slot==='table'?entry(`${collection}-${slot}`):null;s.look.board=slot.endsWith('board')||slot==='battleship-panel'?entry(`${collection}-${slot}`):null;
      s.look.deckBack=slot==='unoq-cardback'?entry(`${collection}-${slot}`):null;
      s.look.backs=game==='poker'?[{seat:0,...entry(`${collection}-cardback`)}]:[];
      for(const p of s.players){p.frame=p.seat===0?entry(`${collection}-frame`):null;p.badge=p.seat===0?entry(`${collection}-badge`):null;}
      const mod=await import(`/games/${game}.js`);mod.onState(s,net.net.state,{wasConnected:true});
      const ui=await import('/ui.js');ui.$app.replaceChildren();mod.render();ui.flushAnimations({still:true});
    },{collection,slot,game:g.id});
    for (const p of pages) await checkSurface(p,g.id,collection);
    rendered.add(`${collection}-${slot}`);rendered.add(`${collection}-frame`);rendered.add(`${collection}-badge`);if(g.id==='poker')rendered.add(`${collection}-cardback`);
    if(collection==='sever'||(width===320&&g.id==='chess')){
     await spy.page.waitForFunction(()=>!document.querySelector('#toast.show'));
     await spy.page.waitForTimeout(450);await spy.page.screenshot({path:path.join(out,`${g.id}-${collection}-${width}.png`)});
    }
    for(const p of pages)assert.ok(await p.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${g.id} ${collection} ${width}: sideways`);
   }
   // Return from local fixture to authoritative server state; reconnect reload uses frozen server snapshot.
   await h.page.reload();
   assert.equal(await checkSurface(h,g.id,'sever'),base);
   assert.deepEqual(room.turn,turn);
   // A missing texture leaves the full field usable in its solid collection color.
   await spy.page.route('**/collections/surfaces/sever.svg',r=>r.fulfill({status:404,body:''}));
   await spy.page.reload();
   assert.equal(await checkSurface(spy,g.id,'sever',false),base);
   assert.ok(await spy.page.locator('.top,.ch-head').count());
   for(const p of pages)for(const m of p.frames.filter(m=>m.t==='state'&&m.state.game)){
    assert.doesNotMatch(JSON.stringify(m),/"(?:holes|fleets|initData|tgId|telegram_payment_charge_id|pay_order|user_id)"/);
    if(p.who===S){if(m.state.me.cards)assert.deepEqual(m.state.me.cards,[]);if(g.maxPlayers===2)assert.deepEqual(m.state.legal,{myTurn:false});if(m.state.match?.boards)for(const b of m.state.match.boards)assert.deepEqual(b.ships,[]);}
   }
   console.log(`${g.id} ${width}: six art series, public owner, frozen/reload/fallback, three streams OK`);
  }finally{for(const p of pages)await p.context.close();await t.app.dropGame(room);}
 }
 for(const width of [320,390]) {
  t.chatId=-99000-width;await t.cmd(H,'/game');const group=t.group;
  const h=await open(H,`g_${group.code}`,width),b=await open(B,`g_${group.code}`,width);
  try {
   await h.page.locator('.nav-tab[data-tab="settings"]').click();await h.page.waitForSelector('.pf');
   t.app.collections.limits.clear();
   for(const [slot,item] of [['frame','porcelain-frame'],['badge','orbita-badge']]){
    const ok=await h.page.evaluate(async({slot,item})=>(await import('/collections/state.js')).store.apply(slot,item,'default'),{slot,item});assert.equal(ok,true);
    await until(()=>h.page.locator(slot==='frame'?'.pf-prev-av [data-v2-frame="porcelain-frame"]':'.pf-prev-name [data-gr-mark="orbita-badge"]').count().then(n=>n===1),'profile live ack');
   }
   await h.page.screenshot({path:path.join(out,`profile-${width}.png`)});
   assert.equal(await h.page.evaluate(async()=>(await import('/collections/state.js')).store.clear('frame')),true);
   await until(()=>h.page.locator('.pf-prev-av [data-v2-frame]').count().then(n=>n===0),'profile clear classic');
   assert.equal(await h.page.locator('.pf-prev-name [data-gr-mark="orbita-badge"]').count(),1);
   // Public off storefront and fitting never mutate choice/room or grant ownership.
   const before=t.app.store.collChoices(B.id);
   await b.page.evaluate(async()=>(await import('/collections/index.js')).open());
   await b.page.waitForSelector('.col-show');await b.page.locator('.col-card[data-item="sever-chess-board"]').click();
   await b.page.getByRole('button',{name:'Примерить',exact:true}).click();await b.page.waitForSelector('.col-fit');
   assert.equal(await b.page.locator('.col-fit .col-sample[data-art="sever-chess-board"]').getAttribute('data-surface'),'sever');
   assert.equal(await b.page.locator('.col-fit .col-sample-grid img').count(),32);
   assert.deepEqual(t.app.store.collChoices(B.id),before);assert.deepEqual(t.app.collections.ownedItems(B.id),[]);
   await b.page.screenshot({path:path.join(out,`fitting-off-${width}.png`)});
   assert.ok(await b.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }finally{await h.context.close();await b.context.close();}
 }
 assert.equal(rendered.size,54);assert.deepEqual(t.errors,[]);assert.deepEqual(problems,[]);
 console.log(`54/54 game assets in seven real renderers; screenshots ${out}`);
}finally{t.app.stop();await browser.close();await web.close();}
