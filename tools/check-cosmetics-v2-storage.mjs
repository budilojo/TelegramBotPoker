/** File fixture -> SQLite .backup -> old App/Hub -> new App. No real database or payment API. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Store } from '../bot/store.js';
import { App } from '../bot/app.js';
import { Hub } from '../bot/hub.js';
import { Table, user, initDataFor, FakeClock, TEST_TOKEN } from '../bot/harness.js';
const dir=fs.mkdtempSync('/private/tmp/cosmetics-c-storage-');
const file=path.join(dir,'fixture.db'),backup=path.join(dir,'backup.db'),oldDir=path.join(dir,'old');
const run=(cmd,args,opts={})=>{const r=spawnSync(cmd,args,{encoding:'utf8',...opts});assert.equal(r.status,0,r.stderr);return r.stdout;};
const tables=['pay_order','pay_payment','pay_entitlement','shop_grant','collection_demo_grant','collection_choice','collection_req','shop_offer','pay_refund','shop_admin_log','shop_admin_req','pay_log'];
const dump=(s)=>Object.fromEntries(tables.filter((name)=>s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)).map(name=>[name,s.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map(r=>({...r}))]));
let store;
try {
  store=new Store(file);const uid='700101001',a=user(Number(uid),'Алиса'),b=user(700101002,'Боб');
  const t=new Table({store,admins:[uid]});
  const items=['graphit-table','nc-frame-2','future-id'];
  store.pay.addOrder({id:'fixture-paid',userId:uid,item:'graphit-table',items,price:100,terms:'fixture',mode:'test',at:1,expiresAt:2});
  store.pay.moveOrder('fixture-paid',['created'],'paid',2);
  store.pay.addPayment({chargeId:'fixture-charge',orderId:'fixture-paid',userId:uid,amount:100,currency:'XTR',payload:'fixture',kind:'order',source:'fixture',at:2});
  store.pay.grant('fixture-paid',items,uid,2);store.pay.adminGrant(uid,'graphit-table','9000',3);
  store.pay.adminGrant(uid,'sever-frame','9000',3);store.pay.setOfferPrice('graphit-profile',42,'9000',3);store.collDemoGrant(uid,'graphit-profile',4);
  for(const [slot,item,color] of [['table','graphit-table','petrol'],['profile','graphit-profile','sapphire'],['frame','base-frame','classic'],['badge','sever-badge','default'],['archive','nc-frame-2','graphite'],['future','future-id','future-color']]) store.collChoiceSet(uid,slot,item,color,5);
  await t.seat({ALICE:a,BOB:b});await t.send(a,{t:'start'});
  assert.equal(t.room.look.v,2);t.app.save(t.room);
  const second=structuredClone(t.room);second.code='V1FIXT';second.chatId='-999999';second.look={v:1,table:{item:'graphit-table',color:'petrol'},backs:{},frames:{},dealNo:second.handNo};
  t.app.rooms.set(second.code, second); t.app.save(second);
  const before=dump(store);t.app.stop();
  // macOS sqlite3 read-only cannot create the first WAL sidecars after node:sqlite closes.
  // Checkpoint this disposable fixture to DELETE before opening it read-only.
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');store.close();store=null;
  assert.ok(fs.existsSync(file), file);
  run('/usr/bin/sqlite3',['-readonly',file,`.backup '${backup}'`]);
  fs.mkdirSync(oldDir);const archive=spawnSync('git',['archive','1781699'],{maxBuffer:100*1024*1024});assert.equal(archive.status,0);
  run('tar',['-x','-C',oldDir],{input:archive.stdout});
  const {Store:OldStore}=await import(pathToFileURL(path.join(oldDir,'bot/store.js')));
  const {App:OldApp}=await import(pathToFileURL(path.join(oldDir,'bot/app.js')));
  const {Hub:OldHub}=await import(pathToFileURL(path.join(oldDir,'bot/hub.js')));
  const old=new OldStore(backup),app=new OldApp({api:t.tg,store:old,clock:new FakeClock(),minIntervalMs:0});
  const hub=new OldHub(app,{botToken:TEST_TOKEN});app.attachHub(hub);app.load();
  const frames=[];hub.open({initData:initDataFor(a,{startParam:t.room.code,clock:app.clock})},m=>frames.push(m));
  assert.equal(frames.find(m=>m.t==='state').state.look.table,null,'old runtime displays classic for v2 snapshot');
  assert.deepEqual(dump(old),before,'old code does not delete unknown choices or purchases on open');
  app.stop();old.close();
  store=new Store(backup);const next=new App({api:t.tg,store,clock:new FakeClock(),admins:[uid]});next.load();
  next.collections.dropUnowned(uid); // Only known revoked choices may be removed: badge has owner access, profile demo is inactive.
  const expected=structuredClone(before);expected.collection_choice=expected.collection_choice.filter(r=>r.slot!=='profile');
  assert.deepEqual(dump(store),expected);
  assert.deepEqual([...next.collections.sourcesOf(uid).get('graphit-table')].sort(),['admin','purchase']);
  assert.equal(next.collections.choiceOf(uid).frame.item,'base-frame');
  assert.equal(next.collections.choiceOf(uid).badge.item,'sever-badge');
  assert.equal(next.roomByCode(t.room.code).look.v,2);assert.equal(next.roomByCode('V1FIXT').look.v,1);
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='schema'").get().value,'5');
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  next.stop();console.log('SQLite .backup -> 1781699 App/Hub -> new App: sources/orders/old+new+unknown ids retained; schema=5, integrity=ok');
} finally {store?.close();fs.rmSync(dir,{recursive:true,force:true});}
