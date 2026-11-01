/** E: reproducible pre-package/current browser costs, 3 cold contexts per revision.
 * Git-tracked bot/miniapp + their unchanged engine dependency copied to tmp;
 * TelegramStub and loopback, no .env. Workspace server/game.js is never edited.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
const root=path.resolve(import.meta.dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cosmetics-e-perf-'));
const output=path.resolve(process.env.COSMETICS_PERF_OUT||'docs/cosmetics-v2/reports/performance.json');
const old=path.join(tmp,'before');fs.mkdirSync(old);
const tar=execFileSync('git',['archive','1781699','bot','miniapp','server/game.js','package.json'],{cwd:root,maxBuffer:100*1024*1024});
execFileSync('tar',['-x','-C',old],{input:tar});fs.symlinkSync(path.join(root,'node_modules'),path.join(old,'node_modules'),'dir');
const browser=await chromium.launch(),results=[];
const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(d=>d.isDirectory()?files(path.join(dir,d.name)):[path.join(dir,d.name)]);
const bytes=ps=>({files:ps.length,bytes:ps.reduce((n,p)=>n+fs.statSync(p).size,0),gzipBytes:ps.reduce((n,p)=>n+gzipSync(fs.readFileSync(p)).length,0)});
const sdk=data=>`window.Telegram={WebApp:{initData:${JSON.stringify(data)},initDataUnsafe:{},ready(){},expand(){},onEvent(){},BackButton:{show(){},hide(){},onClick(){}},HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}}}};`;
const resources=p=>p.evaluate(()=>performance.getEntriesByType('resource').filter(e=>new URL(e.name).origin===location.origin).map(e=>({path:new URL(e.name).pathname,bytes:e.transferSize,decoded:e.decodedBodySize,ms:e.duration})));
try{
 for(const [label,repo] of [['before-1781699',old],['after-working-tree',root]].filter(([label])=>process.env.COSMETICS_PERF_ONLY!=='current'||label.startsWith('after'))){
  const {Table,user,initDataFor}=await import(pathToFileURL(path.join(repo,'bot/harness.js')));
  const {startServer}=await import(pathToFileURL(path.join(repo,'bot/server.js')));
  const who=user(710201001,'Замер'),t=new Table({admins:[String(who.id)]});
  // Common pre-existing entry is available in both revisions. No real shop gate is opened.
  t.app.collections.demo=true;await t.cmd(who,'/game');
  const web=startServer({hub:t.hub,port:0,host:'127.0.0.1',root:path.join(repo,'miniapp'),log:()=>{}});await new Promise(r=>web.server.once('listening',r));
  const url=`http://127.0.0.1:${web.server.address().port}`;
  try{
   for(let run=1;run<=Number(process.env.COSMETICS_PERF_RUNS||3);run++){
    const context=await browser.newContext({viewport:{width:320,height:568},reducedMotion:'reduce'}),page=await context.newPage(),wire={frames:0,bytes:0};page.setDefaultTimeout(8000);
    page.on('websocket',ws=>ws.on('framereceived',({payload})=>{wire.frames++;wire.bytes+=Buffer.byteLength(payload);}));
    await page.addInitScript(()=>{
     const active=new Map(),listeners=new Map();let serial=0;
     const si=window.setInterval,ci=window.clearInterval;
     window.setInterval=(f,ms,...args)=>{const id=si(f,ms,...args);active.set(id,ms);return id;};window.clearInterval=id=>{active.delete(id);ci(id);};
     const add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener;
     EventTarget.prototype.addEventListener=function(type,f,opts){if(this===window||this===document){const capture=typeof opts==='boolean'?opts:!!opts?.capture;if(![...listeners.values()].some(x=>x.target===this&&x.type===type&&x.f===f&&x.capture===capture))listeners.set(++serial,{target:this,type,f,capture});}return add.call(this,type,f,opts);};
     EventTarget.prototype.removeEventListener=function(type,f,opts){const capture=typeof opts==='boolean'?opts:!!opts?.capture;for(const [id,x] of listeners)if(x.target===this&&x.type===type&&x.f===f&&x.capture===capture)listeners.delete(id);return remove.call(this,type,f,opts);};
     window.__perfCounts=()=>({intervals:[...active.values()].sort(),globalListeners:listeners.size,roots:document.querySelectorAll('.col-root').length});
    });
    await page.route('https://telegram.org/**',r=>r.fulfill({contentType:'text/javascript',body:sdk(initDataFor(who,{startParam:`g_${t.group.code}`,clock:t.clock}))}));
    const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
    const began=performance.now();await page.goto(url);await page.waitForSelector('.game-card');
    const firstHubMs=performance.now()-began,initial=await resources(page);
    await page.waitForFunction(async()=>(await import('/collections/state.js')).store.visible);
    const firstShopReadyMs=performance.now()-began,initialWire={...wire};
    assert.equal(initial.filter(e=>e.path.includes('/v2-art/')).length,0,'no v2 SVG loaded before shop/choice');
    const firstCatalogMs=await page.evaluate(async()=>{const c=await import('/collections/index.js'),start=performance.now();c.open();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return performance.now()-start;});
    await page.waitForSelector('.col-show');await page.waitForTimeout(200);
    const catalog=await resources(page),cardCount=await page.locator('.col-card').count(),catalogWire={...wire};
    if(run===1){fs.mkdirSync(path.dirname(output),{recursive:true});await page.screenshot({path:path.join(path.dirname(output),`performance-${label}.png`)});}
    if(label.startsWith('after'))assert.equal(catalog.filter(e=>/v2-art\/.*-preview.svg$/.test(e.path)).length,0,'detail previews stay lazy, including bundles');
    const switchMs=[];
    for(let i=0;i<3;i++){
     await page.locator('.col-card[data-item="graphit-cardback"]').click();await page.waitForSelector('.col-item');
     switchMs.push(await page.evaluate(async()=>{const c=await import('/collections/index.js'),start=performance.now();c.back();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return performance.now()-start;}));
    }
    let filterMs=[];
    if(label.startsWith('after')){
     for(const collection of ['sever','orbita','porcelain']){
      const start=performance.now();await page.locator('[data-filter="collection"]').selectOption(collection);await page.waitForFunction(()=>document.querySelectorAll('.col-card').length===10);filterMs.push(performance.now()-start);
     }
     await page.locator('[data-filter="collection"]').selectOption('');
     // Detail must load when explicitly requested, rather than just declaring lazy in DOM.
     await page.locator('.col-card[data-item="sever-chess-board"]').click();await page.waitForFunction(()=>[...document.images].some(e=>e.getAttribute('src')==='/collections/v2-art/sever-chess-board-preview.svg'&&e.complete&&e.naturalWidth));
     await page.evaluate(async()=>(await import('/collections/index.js')).back());
    }
    const afterDetail=await resources(page);
    await page.evaluate(async()=>(await import('/collections/index.js')).close());await page.waitForTimeout(200);
    const countsBefore=await page.evaluate(()=>window.__perfCounts());const sessionsBefore=t.hub.sessions;
    await page.evaluate(async()=>{
     const {store}=await import('/collections/state.js'),{pay}=await import('/collections/pay.js');
     window.__subCount=0;for(const obj of [store,pay]){const original=obj.subscribe.bind(obj);obj.subscribe=f=>{window.__subCount++;const off=original(f);return()=>{window.__subCount--;off();};};}
     const c=await import('/collections/index.js');for(let i=0;i<60;i++){c.open();c.close();}await new Promise(r=>setTimeout(r,1500));
    });
    const countsAfter=await page.evaluate(()=>({...window.__perfCounts(),newSubscriptions:window.__subCount}));
    assert.equal(countsAfter.newSubscriptions,0,'no accumulating store/pay subscriptions');
    assert.deepEqual({intervals:countsAfter.intervals,globalListeners:countsAfter.globalListeners,roots:countsAfter.roots},countsBefore,'no accumulating global listeners, intervals or roots');
    assert.equal(t.hub.sessions,sessionsBefore,'shop never creates another WebSocket session');
    const idleStart=wire.frames;await page.waitForTimeout(750);assert.equal(wire.frames,idleStart,'closed shop does not poll or emit recurring server state');
    results.push({label,run,firstHubMs,firstShopReadyMs,firstCatalogMs,switchMs,filterMs,cardCount,initial,catalog,afterDetail,initialWire,catalogWire,countsBefore,countsAfter,sessionsBefore,idleFrames:wire.frames-idleStart});
    await context.close();await new Promise(r=>setTimeout(r,100));assert.equal(t.hub.sessions,0);
    console.log(`${label} ${run}: hub ${firstHubMs.toFixed(1)}ms, catalog ${firstCatalogMs.toFixed(1)}ms, ${cardCount} cards, cleanup stable`);
   }
   assert.deepEqual(t.errors,[]);
  }finally{await web.close();t.app.stop();}
 }
 const sizes={};for(const [label,repo] of [['before',old],['after',root]])sizes[label]={miniapp:bytes(files(path.join(repo,'miniapp'))),graphitSvg:bytes(files(path.join(repo,'miniapp/collections/art')).filter(p=>p.endsWith('.svg'))),v2Svg:fs.existsSync(path.join(repo,'miniapp/collections/v2-art'))?bytes(files(path.join(repo,'miniapp/collections/v2-art')).filter(p=>p.endsWith('.svg'))):bytes([])};
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({node:process.version,os:`${os.platform()} ${os.release()} ${os.arch()}`,chromium:browser.version(),cpuRate:4,viewport:'320x568',workload:'three cold contexts/revision, common programmatic catalog entry in isolated demo fixture; three returns and three v2 filters/run; 60 shop open/close/run',limitations:'loopback, OS file cache warm, no network throttling; CPU x4 is not a phone; firstCatalogMs covers two frames without offscreen SVG; size gzip is sum of per-file gzip',sizes,results},null,2)+'\n');
 console.log(output);
}finally{await browser.close();fs.rmSync(tmp,{recursive:true,force:true});}
