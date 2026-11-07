/** C: signed pages, complete message histories, seven games, persisted choices and source isolation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Table, user, initDataFor, FakeClock, TEST_TOKEN } from './harness.js';
import { Store, NullStore } from './store.js';
import { App } from './app.js';
import { Hub } from './hub.js';
import { GAME_LIST, gameOf } from './games/index.js';
import { ITEMS, SLOTS, V2_ITEMS, itemsOfBundle, itemById } from '../miniapp/collections/catalog.js';
import { SELLABLE, priceOf } from './payments/config.js';
import { cfgOf } from './payments/testkit.js';
import { shipCells } from './games/battleship/board.js';
import { BOARD_SLOT } from './collections/index.js';
import { gameAsset, makeHolder, markFailed, resetFailed } from '../miniapp/collections/look-view.js';
import { createStore } from '../miniapp/collections/state.js';
const A = user(700101001, 'Алиса'), B = user(700101002, 'Боб'), S = user(700101003, 'Зритель');
let n = 0;
const req = () => `v2req-${String(++n).padStart(8, '0')}`;
export function page(t, who, code) {
  const p = { who, inbox: [] };
  const r = t.hub.open({ initData: initDataFor(who, { startParam: code, clock: t.clock }) }, (m) => {
    p.inbox.push(structuredClone(m));
    if (m.t !== 'state' || !m.state.game) return;
    const v = m.state, room = t.app.roomByCode(v.room.code);
    assert.doesNotMatch(JSON.stringify(v), /"(?:owned|choice|charge|user_id|hostId|holes|fleets|initData)"/);
    for (const u of [A, B, S]) assert.ok(!JSON.stringify(v).includes(String(u.id)), 'public id absent');
    for (const e of [v.look?.table, v.look?.board, v.look?.deckBack, ...v.players.flatMap((x) => [x.frame, x.badge])].filter(Boolean)) assert.deepEqual(Object.keys(e).sort(), ['color','item']);
    if (['durak', 'colors'].includes(v.game)) {
      assert.deepEqual([...v.me.cards].sort(), [...(!room.deal?.aborted ? room.deal?.hands[String(who.id)] ?? [] : [])].sort());
      for (const x of v.players) assert.equal(x.cards, undefined);
    }
    if (v.game === 'poker' && room.hand?.phase === 'betting') for (const x of v.players) assert.equal(x.cards, null);
    if (['chess','checkers','nardy'].includes(v.game) && v.match && (!v.me.color || v.match.over || v.me.color !== v.match.turn)) assert.deepEqual(v.legal, { myTurn: false });
    if (v.game === 'battleship' && v.match && !v.match.over) for (const b of v.match.boards) if (v.me.side !== b.side) assert.deepEqual(b.ships, []);
  });
  assert.ok(r.session); p.session = r.session;
  p.send = async (m) => { await t.hub.handle(p.session, m); await t.app.settle(); };
  p.state = () => p.inbox.filter((m) => m.t === 'state').at(-1)?.state;
  p.col = async (msg) => { await p.send({ t: 'col', v: 2, req: req(), ...msg }); return p.inbox.filter((m) => m.t === 'col').at(-1); };
  return p;
}
export async function setup(game, ctx, opts = {}) {
  const t = new Table({ admins: [String(A.id)], nardyDice: () => [5,3], battleshipFleetRand: () => .37, ...opts });
  ctx.after(() => t.app.stop());
  await t.cmd(A, '/game');
  const a = page(t, A, `g_${t.group.code}`);
  await a.send({ t: 'create', game, settings: {} });
  const room = t.app.roomByCode(a.session.code), b = page(t, B, room.code), spy = page(t, S, room.code);
  await b.send({ t: 'sit' });
  return { t, a, b, spy, room };
}
const E = (item) => ({ item, color: 'default' });
const pick = (p, id) => p.col({ op: 'apply', item: id, slot: itemById(id).slot, color: 'default' });
for (const g of GAME_LIST) test(`C v2 ${g.id}: public stream, host transfer/leave, frozen choice, restart`, async (ctx) => {
  const store = new Store(':memory:'); ctx.after(() => store.close());
  const { t,a,b,spy,room } = await setup(g.id,ctx,{ store });
  assert.equal((await a.col({ op: 'apply-bundle', item: 'sever-bundle' })).error, undefined);
  assert.deepEqual(t.app.collections.ownedItems(B.id), []);
  assert.deepEqual(t.app.collections.ownedItems(S.id), []);
  const slot = ['poker','durak'].includes(g.id) ? 'table' : g.id === 'colors' ? 'unoq-cardback' : BOARD_SLOT[g.id];
  const key = slot === 'table' ? 'table' : slot === 'unoq-cardback' ? 'deckBack' : 'board';
  assert.deepEqual(spy.state().look[key], E(`sever-${slot}`));
  assert.deepEqual(spy.state().players.find((p) => p.seat === 0).frame, E('sever-frame'));
  assert.deepEqual(spy.state().players.find((p) => p.seat === 1).frame, null);
  const bad = await b.col({ op:'apply', item:`sever-${slot}`,slot,color:'default',userId:A.id,admin:true,hostId:A.id });
  assert.equal(bad.error?.code,'COL_NOT_OWNED');
  assert.equal((await b.col({ op:'apply',item:`sever-${slot}`,slot,color:'default',room:room.code })).error?.code,'COL_OP');
  const request = req();
  await a.send({t:'start'}); assert.equal(room.status,'playing');
  const frozen = structuredClone(room.look), pub = structuredClone(spy.state().look);
  assert.equal(pub.dealNo, g.id === 'poker' ? room.handNo : room.gameNo);
  const answer = await a.col({ op:'apply', item:`orbita-${slot}`,slot,color:'default',req:request });
  assert.equal(answer.when,'next-deal');
  await a.col({ op:'apply', item:`orbita-${slot}`,slot,color:'default',req:request });
  assert.deepEqual(room.look,frozen); assert.deepEqual(spy.state().look,pub);
  if (g.id === 'battleship') for (const p of [a,b]) { await p.send({t:'random'}); await p.send({t:'ready'}); }
  const actor=[a,b].find(p=>g.id==='poker'?!!p.state().legal:g.id==='durak'?!!p.state().legal?.attack?.length:!!p.state().legal?.myTurn);
  assert.ok(actor,'one legal actor');
  if(g.id==='nardy')await actor.send({t:'roll'});
  const s=actor.state();let action;
  if(g.id==='poker')action={t:'act',action:s.legal.canCheck?'check':'call'};
  if(g.id==='durak')action={t:'attack',card:s.legal.attack[0]};
  if(g.id==='colors')action=s.legal.play.length?{t:'play',card:s.legal.play[0],color:'R'}:{t:'draw'};
  if(g.id==='chess'){const [from,tos]=Object.entries(s.legal.to)[0];action={t:'move',from,to:tos[0],ply:s.match.plies};}
  if(g.id==='checkers')action={t:'move',...s.legal.moves[0],ply:s.match.plies};
  if(g.id==='nardy')action={t:'move',...s.legal.next[0],turn:s.match.turns};
  if(g.id==='battleship'){
    const occupied=new Set(room.match.fleets[1-s.me.side].flatMap(shipCells));
    action={t:'fire',cell:Array.from({length:100},(_,i)=>i).find(c=>!occupied.has(c)),shot:s.match.shots};
  }
  const seq=room.seq;await actor.send({...action,seq:s.seq});assert.ok(room.seq>seq,'legal move accepted');
  assert.deepEqual(spy.state().look,pub,'move never changes decoration');
  await a.send({ t:'host',seat:1 }); assert.equal(room.hostId,String(B.id));
  assert.deepEqual(spy.state().look,pub,'host transfer preserves frozen theme');
  t.app.save(room);
  const app = new App({ api:t.tg,store,clock:new FakeClock(),admins:[String(A.id)],minIntervalMs:0 });
  const hub = new Hub(app,{botToken:TEST_TOKEN}); app.attachHub(hub); app.load(); await app.resume(); ctx.after(() => app.stop());
  const restored = app.roomByCode(room.code); assert.deepEqual(restored.look,frozen,'restart preserves snapshot incl original host');
  assert.deepEqual(gameOf(restored).view(restored,String(S.id)).look,pub);
  await b.send({ t:'leave' });
  assert.deepEqual(spy.state().look,pub,'host leave does not repaint live/final snapshot');
  assert.ok(spy.inbox.filter((m) => m.t==='state').length >= 5);
  assert.deepEqual(t.errors,[]);
});

test('C v2: signed owner distinct from testers/admin grants, null prices even in payment test mode', async (ctx) => {
  const {t,a,b} = await setup('chess',ctx);
  t.app.cosmeticsTesters.add(String(B.id));
  for (const it of V2_ITEMS) {
    assert.equal(it.price,null); assert.equal(SELLABLE.has(it.id),false);
    assert.equal(priceOf(cfgOf(),it.id),null);
    if (it.kind==='item') assert.deepEqual([...t.app.collections.sourcesOf(A.id).get(it.id)],['owner']);
  }
  assert.deepEqual(t.app.collections.ownedItems(B.id),[]);
  assert.equal((await b.col({op:'grant',item:'sever-bundle'})).error?.code,'COL_DEMO_OFF');
  assert.equal((await b.col({op:'apply',item:'sever-frame',slot:'frame',color:'default',admin:true,owner:true})).error?.code,'COL_NOT_OWNED');
  assert.equal((await a.col({op:'apply',item:'sever-frame',slot:'table',color:'default'})).error?.code,'COL_SLOT');
  assert.equal((await a.col({op:'apply',item:'sever-frame',slot:'frame',color:'petrol'})).error?.code,'COL_COLOR');
  assert.equal((await a.col({op:'apply',item:'sever-chess-board',slot:'chess-board',color:'default',game:'poker'})).error?.code,'COL_SLOT');
  assert.equal((await a.col({v:1,op:'apply',item:'sever-frame',slot:'frame',color:'default'})).error?.code,'COL_STALE');
});

test('C v2: partial bundle changes nothing; all choices + replay marker rollback on write failure', async () => {
  for (const store of [new Store(':memory:'),new NullStore()]) {
    const t = new Table({store}); t.app.collections.demo=true;
    const c=t.app.collections, u={id:B.id};
    store.collDemoGrant(B.id,'sever-frame',1);
    const before=store.collChoices(B.id);
    const r=c.handle(u,{v:2,op:'apply-bundle',item:'sever-bundle',req:req()});
    assert.equal(r.error?.code,'COL_NOT_OWNED'); assert.deepEqual(store.collChoices(B.id),before);
    for (const id of itemsOfBundle('sever-bundle')) store.collDemoGrant(B.id,id,2);
    const original=store.collChoiceSet.bind(store);let writes=0;
    store.collChoiceSet=(...args)=>{ original(...args); if (++writes===4) throw Error('disk failure'); };
    const id=req(); assert.throws(()=>c.handle(u,{v:2,op:'apply-bundle',item:'sever-bundle',req:id}),/disk failure/);
    assert.deepEqual(store.collChoices(B.id),before);assert.equal(store.collReqSeen(B.id,id),false);
    store.collChoiceSet=original;
    assert.equal(c.handle(u,{v:2,op:'apply-bundle',item:'sever-bundle',req:id}).error,undefined);
    assert.equal(store.collChoices(B.id).length,9);
    c.handle(u,{v:2,op:'clear',slot:'frame',req:req()});
    assert.equal(c.stateOf(B.id).choice.frame,null); assert.ok(c.stateOf(B.id).choice.badge);
    store.close?.(); t.app.stop();
  }
});

test('C v2: source revocation preserves independent right; final loss removes frozen art, unknown rows survive', async (ctx) => {
  const {t,a,room,spy}=await setup('poker',ctx);
  await pick(a,'sever-table'); await a.send({t:'start'});
  t.app.collections.demo=true; t.app.store.collDemoGrant(A.id,'sever-table',1);
  t.app.admins.delete(String(A.id));
  t.app.collections.dropUnowned(A.id);t.app.draw(room);
  assert.deepEqual(spy.state().look.table,E('sever-table'));
  t.app.collections.demo=false;
  t.app.store.collChoiceSet(A.id,'future-slot','future-id','future-color',1);
  t.app.store.collChoiceSet(A.id,'frame','base-frame','classic',1);
  t.app.collections.dropUnowned(A.id);t.app.draw(room);
  assert.equal(spy.state().look.table,null);
  assert.equal(t.app.store.collChoices(A.id).some((r)=>r.item==='future-id'),true);
  assert.equal(t.app.store.collChoices(A.id).some((r)=>r.item==='base-frame'),true);
  const hold=makeHolder();hold.hold('poker:R','playing',{v:2,dealNo:1,table:E('sever-table'),backs:[]});
  assert.equal(hold.hold('poker:R','playing',spy.state().look).table,null);
});

test('C v2: Graphit profile pair retained under overrides; clear means classic, profile restores both', async (ctx) => {
  const store = new Store(':memory:');ctx.after(()=>store.close());
  const {t,a,spy}=await setup('durak',ctx,{store});t.app.collections.demo=true;
  t.app.store.collDemoGrant(A.id,'graphit-profile',1);
  await a.col({op:'apply',slot:'profile',item:'graphit-profile',color:'petrol'});
  await pick(a,'sever-frame');await pick(a,'orbita-badge');
  assert.equal(t.app.collections.choiceOf(A.id).profile.item,'graphit-profile');
  await a.col({op:'clear',slot:'profile'});
  assert.deepEqual(spy.state().players[0].frame,E('sever-frame'),'clearing profile leaves independent frame');
  assert.deepEqual(spy.state().players[0].badge,E('orbita-badge'),'clearing profile leaves independent badge');
  await a.col({op:'apply',slot:'profile',item:'graphit-profile',color:'petrol'});
  await pick(a,'sever-frame');await pick(a,'orbita-badge');
  await a.col({op:'clear',slot:'frame'});assert.equal(spy.state().players[0].frame,null);
  assert.deepEqual(spy.state().players[0].badge,E('orbita-badge'));
  await a.col({op:'apply',slot:'profile',item:'graphit-profile',color:'sapphire'});
  assert.deepEqual(spy.state().players[0].frame,{item:'graphit-profile',color:'sapphire'});
  assert.equal(spy.state().players[0].badge,null);
});

test('C v2: old snapshot v1 not rebuilt until next deal; unknown version and wrong asset fall back', async (ctx) => {
  const {t,a,room,spy}=await setup('chess',ctx);await a.send({t:'start'});
  room.look={v:1,dealNo:room.gameNo,table:null,backs:{},frames:{}};
  t.app.draw(room);assert.equal(spy.state().look.v,1);
  await pick(a,'sever-chess-board');assert.equal(room.look.v,1);
  room.look={v:999,dealNo:room.gameNo,board:E('sever-chess-board')};t.app.draw(room);
  assert.equal(spy.state().look.table,null); assert.equal(spy.state().look.board,undefined);
  room.gameNo++;t.app.draw(room); assert.equal(spy.state().look.v,2);
  assert.deepEqual(spy.state().look.board,E('sever-chess-board'));
  assert.equal(gameAsset(E('sever-chess-board'),'checkers-board','checkers'),null);
  assert.match(gameAsset(E('sever-chess-board'),'chess-board','chess'),/sever-board\.webp/);
  markFailed('/collections/raster/sever-board.webp');
  assert.equal(gameAsset(E('sever-chess-board'),'chess-board','chess'),null);resetFailed();
});

test('C v2: client requires server ack, sends version; old server cannot equip new stuff', () => {
  const sent=[],s=createStore({send:m=>{sent.push(m);return true;},setTimer:()=>1,clearTimer:()=>{}});
  const msg={t:'col',op:'state',v:2,enabled:true,demo:true,owned:itemsOfBundle('sever-bundle').map(item=>({item,source:['owner']})),choice:{},pending:{}};
  s.handle(msg);assert.equal(s.applyBundle('sever-bundle'),true);assert.equal(sent[0].v,2);
  assert.equal(s.snapshot().choice.frame,null);
  s.handle({...msg,op:'apply-bundle',choice:Object.fromEntries(itemsOfBundle('sever-bundle').map(id=>[itemById(id).slot,E(id)]))});
  assert.deepEqual(s.snapshot().choice.frame,E('sever-frame'));
  s.handle({...msg,v:1});assert.equal(s.apply('frame','sever-frame','default'),false);
});

for (const g of GAME_LIST.filter((x)=>x.id!=='poker')) test(`C v2 ${g.id}: next party applies the new host's theme, never grants it to guests`, async(ctx)=>{
  const {t,a,b,spy,room}=await setup(g.id,ctx);
  t.app.collections.demo=true;
  for(const id of itemsOfBundle('orbita-bundle'))t.app.store.collDemoGrant(B.id,id,1);
  await a.col({op:'apply-bundle',item:'sever-bundle'});
  await b.col({op:'apply-bundle',item:'orbita-bundle'});
  const slot=['durak'].includes(g.id)?'table':g.id==='colors'?'unoq-cardback':BOARD_SLOT[g.id];
  const key=slot==='table'?'table':slot==='unoq-cardback'?'deckBack':'board';
  await a.send({t:'start'});const no=room.gameNo;
  await a.send({t:'host',seat:1});assert.deepEqual(spy.state().look[key],E(`sever-${slot}`));
  await b.send({t:'abort'});await b.send({t:'next'});if(g.id==='chess')await a.send({t:'next'});
  assert.equal(room.gameNo,no+1);assert.deepEqual(spy.state().look[key],E(`orbita-${slot}`));
  assert.deepEqual(spy.state().players.find(p=>p.seat===0).frame,E('sever-frame'));
  assert.deepEqual(spy.state().players.find(p=>p.seat===1).frame,E('orbita-frame'));
  assert.deepEqual(t.app.collections.ownedItems(S.id),[]);assert.deepEqual(t.errors,[]);
});

test('C v2: 60 null-price items cannot create invoices or orders even on TelegramStub test gate',async()=>{
  const t=new Table();t.app.payments.cfg=cfgOf();
  assert.equal(t.app.payments.open,true,'test gate is open only in this disposable fixture');
  for(const it of V2_ITEMS){
    t.app.payments.limits.clear();
    const r=await t.app.payments.handle({id:String(B.id)},{op:'buy',item:it.id,req:req()});
    assert.equal(r.error?.code,'PAY_ITEM',it.id);
  }
  assert.equal(t.tg.calls.filter(c=>c.method==='createInvoiceLink').length,0);
  assert.deepEqual(t.app.store.pay.liveOrders(String(B.id),t.clock.now()),[]);t.app.stop();
});

test('C v2: runtime descriptors exactly match B art and approved Graphit prices are unchanged',()=>{
  const manifest=JSON.parse(fs.readFileSync(new URL('../miniapp/collections/v2-art/manifest.json',import.meta.url),'utf8'));
  assert.deepEqual(V2_ITEMS,manifest.items.map(i=>({...i,readiness:'integrated'})));
  assert.equal(manifest.source.approved,false);
  assert.deepEqual(ITEMS.filter(i=>i.collection&&i.kind==='bundle').map(i=>i.includes.length),[9,9,9,9,9,9]);
  const offers=JSON.parse(fs.readFileSync(new URL('./payments/offers.json',import.meta.url),'utf8'));
  assert.deepEqual(offers.items,{'graphit-cardback':75,'graphit-profile':50,'graphit-table':100,'graphit-bundle':175});
});
