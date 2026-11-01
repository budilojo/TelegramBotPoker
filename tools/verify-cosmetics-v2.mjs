/** E: every collection starts a real server party, with two signed players and a spectator.
 * No synthetic view injection, real Telegram, secrets or payment operations.
 * VERIFY_GAME / VERIFY_COLLECTION / VERIFY_WIDTH restrict a mutation control only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { Table, user, initDataFor } from '../bot/harness.js';
import { startServer } from '../bot/server.js';
import { GAME_LIST } from '../bot/games/index.js';
import { BOARD_SLOT } from '../bot/collections/index.js';
import { V2_ITEMS, itemById } from '../miniapp/collections/catalog.js';
const H=user(710101001,'Алиса'), B=user(710101002,'Боб'), S=user(710101003,'Зритель');
const t=new Table({admins:[String(H.id)],nardyDice:()=>[5,3],battleshipFleetRand:()=>.37});
const out=path.resolve(process.env.VERIFY_SHOTS || 'docs/cosmetics-v2/reports/verify-screens');
fs.mkdirSync(out,{recursive:true});
const web=startServer({hub:t.hub,port:0,host:'127.0.0.1',root:path.resolve('miniapp'),log:()=>{}});
await new Promise(r=>web.server.once('listening',r));
const url=`http://127.0.0.1:${web.server.address().port}`,browser=await chromium.launch();
const seen=new Set(), scenes=[], errors=[], legacyRequests=[];let seq=0;
const legacy={cardback:'nc-back-2',felt:'nc-felt-1',frame:'nc-frame-2',title:'nc-title-1',effect:'nc-fx-win',reactions:['nc-react-1']};
const sdk=data=>`window.Telegram={WebApp:{initData:${JSON.stringify(data)},initDataUnsafe:{},ready(){},expand(){},disableVerticalSwipes(){},setHeaderColor(){},setBackgroundColor(){},setBottomBarColor(){},onEvent(){},BackButton:{show(){},hide(){},onClick(){}},HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}}}};`;
const send=(p,m)=>p.page.evaluate(async m=>(await import('/net.js')).send(m,{lock:false}),m);
async function until(f,label){const end=Date.now()+8000;while(!await f()){assert.ok(Date.now()<end,label);await new Promise(r=>setTimeout(r,20));}}
async function open(who,room,width){
 const context=await browser.newContext({viewport:{width,height:width===320?568:844},reducedMotion:'reduce'}),page=await context.newPage(),frames=[];
 page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(look=>localStorage.setItem('cosmetics-look',JSON.stringify(look)),legacy);
 page.on('request',r=>{if(r.url().includes('/cosmetics/placeholder/'))legacyRequests.push(r.url());});
 page.on('websocket',ws=>ws.on('framereceived',({payload})=>frames.push(JSON.parse(String(payload)))));
 await page.route('https://telegram.org/**',r=>r.fulfill({contentType:'text/javascript',body:sdk(initDataFor(who,{startParam:room.code,clock:t.clock}))}));
 await page.goto(url);await page.waitForSelector('.lobby');return {context,page,frames};
}
const last=p=>p.frames.filter(m=>m.t==='state'&&m.state.game).at(-1)?.state;
try{
 console.log('Chromium',browser.version());
 for(const width of process.env.VERIFY_WIDTH?[+process.env.VERIFY_WIDTH]:[320,390])
 for(const g of GAME_LIST.filter(g=>!process.env.VERIFY_GAME||g.id===process.env.VERIFY_GAME))
 for(const collection of ['sever','obsidian','chertezh','terracotta','orbita','porcelain'].filter(c=>!process.env.VERIFY_COLLECTION||c===process.env.VERIFY_COLLECTION)){
  const room=t.app.createGame(g.id,{chatId:String(-971000-(++seq)),title:'Независимая проверка',host:{id:String(H.id),tgId:H.id,name:H.first_name},settings:{}});
  assert.ok(!room.error);
  const pages=[];
  try{
   for(const who of [H,B,S])pages.push(await open(who,room,width));
   const [h,b,spy]=pages;await send(b,{t:'sit'});await until(()=>room.players.length===2,'two seated');
   t.app.collections.limits.clear();
   await send(h,{t:'col',v:2,op:'apply-bundle',item:`${collection}-bundle`,req:`verify-bundle-${seq}`});
   await until(()=>h.frames.some(m=>m.t==='col'&&m.op==='apply-bundle'),'bundle ack');
   const ack=h.frames.filter(m=>m.t==='col'&&m.op==='apply-bundle').at(-1);assert.equal(ack.error,undefined);
   assert.deepEqual(t.app.collections.ownedItems(B.id),[]);assert.deepEqual(t.app.collections.ownedItems(S.id),[]);
   await send(h,{t:'start'});await until(()=>last(spy)?.room.status==='playing','started');
   if(g.id==='battleship')for(const p of [h,b]){await send(p,{t:'random'});await until(()=>last(p)?.match?.boards?.some(b=>b.ships.length),'fleet');await send(p,{t:'ready'});}
   if(g.id==='battleship')await until(()=>last(spy)?.match?.phase==='battle','battle');
   const slot=['poker','durak'].includes(g.id)?'table':g.id==='colors'?'unoq-cardback':BOARD_SLOT[g.id];
   const selector=slot==='table'?'.gr-orn':slot==='unoq-cardback'?'.cv2-deck-back':'.cv2-board-art';
   const expected=[`${collection}-${slot}`,`${collection}-frame`,`${collection}-badge`];if(g.id==='poker')expected.push(`${collection}-cardback`);
   for(const p of pages){
    await p.page.waitForSelector('.game,.ch-board,.dk,.cl,.bs,.ny,.ck,.table,.top,.ch-head');
    await until(()=>p.page.locator(selector).count(),'shared art present');
    // Card games put our face-up hand in the hero area; battleship labels our own field.
    // These existing layouts don't repeat our own avatar/back.
    // The opponent and spectator must both see every personal decoration.
    for(const id of expected.filter(id=>p!==h||!['poker','durak','colors','battleship'].includes(g.id)||id===`${collection}-${slot}`)){
     const src=itemById(id).assets.game;
     await until(()=>p.page.locator('img').evaluateAll((imgs,src)=>imgs.some(e=>e.getAttribute('src')===src&&e.complete&&e.naturalWidth>0),src),`${g.id}/${collection}: ${id} rendered`);
     const hit=await p.page.locator(`img[src="${src}"]`).first().evaluate(e=>getComputedStyle(e).pointerEvents);assert.equal(hit,'none');seen.add(id);
    }
    assert.ok(await p.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
    assert.equal(await p.page.locator('.cos-frame,.cos-title,.cos-back,.cos-fx,img[src*="/cosmetics/placeholder/"]').count(),0,'legacy decorations never mix with v2');
    assert.deepEqual(await p.page.evaluate(()=>JSON.parse(localStorage.getItem('cosmetics-look'))),legacy,'old selection is retained');
   }
   const frozen=structuredClone(last(spy).look),turn=structuredClone(room.turn);
   t.app.collections.limits.clear();
   await send(h,{t:'col',v:2,op:'clear',slot,req:`verify-clear-${seq}`});
   await until(()=>h.frames.some(m=>m.t==='col'&&m.op==='clear'),'clear ack');
   assert.deepEqual(last(spy).look,frozen);assert.deepEqual(room.turn,turn);
   await h.page.reload();await h.page.waitForSelector(selector);assert.deepEqual(last(h).look,frozen);assert.deepEqual(room.turn,turn);
   if(width===320||collection==='sever'){
    await spy.page.waitForFunction(()=>!document.querySelector('#toast.show'));await spy.page.waitForTimeout(150);
    await spy.page.screenshot({path:path.join(out,`${g.id}-${collection}-${width}.png`)});
   }
   for(const [i,p] of pages.entries())for(const m of p.frames.filter(m=>m.t==='state'&&m.state.game)){
    assert.doesNotMatch(JSON.stringify(m),/"(?:owned|source|hostId|holes|fleets|initData|tgId|telegram_payment_charge_id|pay_order|user_id)"/);
    for(const u of [H,B,S])assert.ok(!JSON.stringify(m).includes(String(u.id)),'no public identity');
    if(i===2){assert.deepEqual(m.state.me.cards||[],[]);if(g.maxPlayers===2)assert.deepEqual(m.state.legal,{myTurn:false});}
    if(g.id==='battleship'&&m.state.match&&!m.state.match.over)for(const board of m.state.match.boards)if(m.state.me.side!==board.side)assert.deepEqual(board.ships,[]);
   }
   scenes.push({game:g.id,collection,width,messages:pages.map(p=>p.frames.length)});console.log(`${g.id}/${collection}/${width}: server bundle, three actual screens, freeze/reload, all streams OK`);
  }finally{for(const p of pages)await p.context.close();await t.app.dropGame(room);}
 }
 assert.deepEqual(errors,[]);assert.deepEqual(t.errors,[]);assert.deepEqual(legacyRequests,[]);
 if(!process.env.VERIFY_GAME&&!process.env.VERIFY_COLLECTION)assert.deepEqual([...seen].sort(),V2_ITEMS.filter(it=>it.kind==='item').map(it=>it.id).sort());
 fs.writeFileSync(path.join(out,'matrix.json'),JSON.stringify({chromium:browser.version(),scenes,rendered:[...seen].sort()},null,2)+'\n');
 console.log(`${seen.size} distinct items, ${scenes.length} real server parties OK`);
}finally{t.app.stop();await browser.close();await web.close();}
