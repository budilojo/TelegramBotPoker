import test from 'node:test';
import assert from 'node:assert/strict';
import { play, seeds, auditView } from './unoq-research/simulator.mjs';
import { Lobby, assignmentFor } from './unoq-research/lobby.mjs';
import { agent, decide, rng } from './unoq-research/strategies.mjs';
import { wilson, metrics } from './unoq-research/stats.mjs';
import * as C from '../bot/games/colors/rules.js';
import { shuffled } from '../bot/games/colors/cards.js';
import game from '../bot/games/colors/index.js';
import { Store, NullStore } from '../bot/store.js';
import { apply, fingerprint, points } from '../bot/rating.js';
import { Table } from '../bot/harness.js';

function lobby() {
  let now = 0, starts = 0, assigned = 0;
  const l = new Lobby({ now: () => now, assign: (n, level) => {
    assigned++; return assignmentFor('test-only-key', 'human', '2026-11-03', n).map(p => ({ ...p, level }));
  }, start: () => { starts++; } });
  return { l, time: n => { now = n; }, starts: () => starts, assigned: () => assigned };
}

test('исследование: отсчёт начинается первым человеком, ровно 30 секунд и однократный запуск', () => {
  const t = lobby(); t.l.tick(); assert.equal(t.starts(), 0);
  t.time(100); t.l.join('one'); assert.equal(t.l.deadline, 30100);
  t.time(30099); t.l.tick(); assert.equal(t.starts(), 0);
  t.time(30100); t.l.tick(); assert.equal(t.starts(), 1);
  assert.equal(t.l.snapshot.bots.length, 3);
  t.l.tick(); t.l.launch(); t.l.ready('one'); assert.equal(t.starts(), 1); assert.equal(t.assigned(), 1);
});
test('исследование: пропуск ожидания и готовность нескольких людей', () => {
  const t = lobby(); t.l.join('one'); t.time(4000); t.l.join('two');
  assert.equal(t.l.deadline, 30000, 'второй человек не сбрасывает ожидание');
  t.l.skip('one'); assert.equal(t.starts(), 0);
  t.l.ready('two'); assert.equal(t.starts(), 1);
  assert.deepEqual(t.l.snapshot.people, ['one','two']); assert.equal(t.l.snapshot.bots.length, 2);
  assert.equal(t.l.skip('one').error, 'NOT_WAITING');
  const solo = lobby(); solo.l.join('one'); solo.l.skip('one'); assert.equal(solo.starts(), 1);
});
test('исследование: человек на границе старта, оба порядка событий', () => {
  for (const tickFirst of [false,true]) {
    const t = lobby(); t.l.join('one'); t.time(30000); if (tickFirst) t.l.tick();
    assert.equal(t.l.join('late').error, 'STARTED'); t.l.tick();
    assert.equal(t.starts(), 1); assert.deepEqual(t.l.snapshot.people, ['one']);
  }
  const t = lobby(); t.l.join('one'); t.time(29999); t.l.join('in-time');
  t.time(30000); t.l.tick(); assert.equal(t.l.snapshot.people.length, 2);
});
test('исследование: сложность до старта фиксируется, после старта не меняется', () => {
  const t = lobby(); t.l.join('one'); t.l.difficulty(0); t.l.difficulty(1); t.l.difficulty(0);
  t.time(30000); assert.equal(t.l.difficulty(1).error, 'STARTED');
  assert.equal(t.l.snapshot.level, 0); assert.equal(t.l.snapshot.eligibleHypothesis, false);
  assert.ok(t.l.snapshot.bots.every(b => b.level === 0));
  assert.equal(t.l.difficulty(1).error, 'STARTED'); assert.equal(t.l.snapshot.level, 0);
});
test('исследование: состав назначен сервером, пересоздание и сложность не дают перебор', () => {
  const a = assignmentFor('test-only-key','one','day',3);
  for (let i = 0; i < 30; i++) {
    assert.deepEqual(assignmentFor('test-only-key','one','day',3), a);
    assert.deepEqual(assignmentFor('test-only-key','one','day',2), a.slice(0,2));
  }
  assert.ok(a.every(p => p.computer)); assert.equal(new Set(a.map(p => p.style)).size, 3);
});
test('исследование: все готовы, полный стол, повторный и реентерабельный старт', () => {
  const t = lobby(); for (const id of ['a','b','c','d']) t.l.join(id);
  assert.equal(t.l.join('e').error, 'FULL');
  for (const id of ['a','b','c','d']) t.l.ready(id);
  assert.equal(t.starts(), 1); assert.equal(t.l.snapshot.bots.length, 0);
  let starts = 0;
  const l = new Lobby({ assign: () => [], start: () => { starts++; l.launch(); } });
  l.join('a'); l.skip('a'); assert.equal(starts,1);
});

test('исследование: полный цикл, повторяемость и равномерные места', async () => {
  const opts = { scenario: 7, index: 3, model: 'baseline', lineup: 'C' };
  const a = await play(opts), b = await play(opts);
  assert.equal(a.status, 'completed', a.error); assert.deepEqual(a,b);
  assert.equal(a.order.length, 4); assert.ok(a.views > a.actions * 4);
  assert.deepEqual([0,1,2,3].map(i => seeds('main',0,i).deal), [10000000,10000001,10000002,10000003]);
  assert.notEqual(seeds('main',0,0).deal, seeds('holdout',0,0).deal);
});
test('исследование: предел ходов сохраняет незавершённую партию и причину', async () => {
  const r = await play({ maxActions: 1 });
  assert.equal(r.status,'limit'); assert.equal(r.actions,1); assert.ok(r.error); assert.ok(r.snapshot); assert.ok(r.trace.length);
});
test('исследование: раздача не потребляет случайность стратегии', () => {
  const a = rng(17), b = rng(17), choices = rng(29);
  for (let i = 0; i < 400; i++) choices();
  assert.deepEqual(shuffled(n => Math.floor(a()*n)), shuffled(n => Math.floor(b()*n)));
});
function room4() {
  const r = C.createRoom({ code:'test-room', chatId:'test', host:{id:'0',name:'Первый'} });
  for (let i = 1; i < 4; i++) C.addPlayer(r,{id:String(i),name:`Модель ${i}`});
  const random = rng(9), randInt = n => Math.floor(random()*n);
  C.startGame(r,'0',{deck:()=>shuffled(randInt),randInt}); return r;
}
test('исследование: чужие карты и будущая колода не влияют на решения; имена и id ботов не стиль', () => {
  const r = room4(), uid = r.deal.turn;
  for (const type of ['A','B','C','simple','baseline','adaptive']) {
    const v = game.view(r,uid,{now:1000});
    const before = decide(agent(type,4), v);
    const changed = structuredClone(r), others = changed.deal.order.filter(id => id !== uid);
    [changed.deal.hands[others[0]],changed.deal.hands[others[1]]] = [changed.deal.hands[others[1]],changed.deal.hands[others[0]]];
    changed.deal.deck.reverse(); for (const p of changed.players) p.name = 'Новое имя';
    const after = decide(agent(type,4),game.view(changed,uid,{now:1000}));
    assert.deepEqual(before,after,type);
  }
});
test('исследование: приватность отклоняет чужую руку и порядок колоды в любом сообщении', () => {
  const r = room4(), uid = r.deal.turn, v = game.view(r,uid,{now:1000});
  auditView(v,r,uid);
  const corrupt = structuredClone(v); corrupt.deal.deck = r.deal.deck;
  assert.throws(()=>auditView(corrupt,r,uid));
  const corrupt2 = structuredClone(v); corrupt2.players[1].cards = ['WF'];
  assert.throws(()=>auditView(corrupt2,r,uid));
});
test('исследование: интервал побед и средних проверен на известных значениях', () => {
  const ci = wilson(500,1000); assert.ok(Math.abs(ci[0]-0.469069)<0.00001);
  assert.deepEqual(metrics([20,12,6,-10]).mean,7);
  assert.deepEqual([0,1,2,3].map(i=>points(i,4)),[20,12,6,-10]);
});

for (const StoreClass of [Store,NullStore]) test(`исследование рейтинг ${StoreClass.name}: имена, id, столы, повтор и персональный лимит`, () => {
  const s = StoreClass === Store ? new Store(':memory:') : new NullStore();
  const at = 1800000000000;
  const make = (n,rotate=false) => ({game:'colors',round:`table${n}#1`, at,
    places:[{id:'human',name:`Имя ${n}`},...['b','c','d'].map(id=>({id:rotate?`${id}${n}`:id,name:`Бот ${n}`}))],loserId:rotate?`d${n}`:'d'});
  assert.equal(fingerprint('colors',['b','human','c','d']), fingerprint('colors',['d','c','human','b']));
  assert.ok(apply(s,make(0)).ok); const before=s.ratingOf('human','colors').points;
  assert.equal(apply(s,make(0)).skipped,'ALREADY'); assert.equal(s.ratingOf('human','colors').points,before);
  for(let i=1;i<10;i++) assert.ok(apply(s,make(i)).ok);
  assert.equal(apply(s,make(10)).skipped,'FARMED','новый стол и новые имена не сбрасывают состав');
  assert.equal(apply(s,make(11,true)).skipped,'GAINED','новые bot-id не обходят персональный лимит');
  assert.equal(s.ratingOf('human','colors').points,200); s.close?.();
});
test('исследование: действующий App исключает всех solo независимо от сложности и числа людей', () => {
  const t = new Table(), room = room4();
  room.history = [{ no:1,out:['0','1','2','3'],loser:'3',quit:[] }];
  for(const level of [0,1]) for(const humans of [1,2,3,4]) {
    room.solo={owner:'0',raw:{level}};
    room.players.forEach((p,i)=>{ if(i<humans) delete p.bot; else p.bot={level}; });
    assert.deepEqual(t.app.rate(room),[]);
  }
  delete room.solo; assert.equal(t.app.rate(room)[0].ok,true);
});
test('исследование: выход из проигрываемой партии даёт последнее место, leave во время игры запрещён', () => {
  const room=room4(); assert.equal(C.leave(room,'1').error,'IN_DEAL');
  C.markLeft(room,'1'); C.markLeft(room,'2'); C.markLeft(room,'3');
  const round=game.rounds(room)[0]; assert.ok(round); assert.equal(round.loserId,'1');
  const r=apply(new NullStore(),{...round,round:round.id,game:'colors'});
  assert.ok(r.ok); assert.equal(r.rows.find(x=>x.userId==='1').delta,-10);
});
test('исследование: изменение числа участников меняет средние очки; бот не распознаётся apply', () => {
  for (const n of [2,3,4]) {
    const places=Array.from({length:n},(_,i)=>({id:i?'bot'+i:'human',bot:i>0}));
    const r=apply(new NullStore(),{game:'colors',round:`n${n}`,places,loserId:places.at(-1).id});
    assert.ok(r.ok); assert.equal(r.rows.length,n);
    assert.equal(r.rows.reduce((s,x)=>s+x.delta,0)/n,({2:5,3:22/3,4:7})[n]);
  }
});
test('исследование: насыщенный лимит соперника отменяет минус; это граница нынешней формулы', () => {
  const s=new NullStore(),at=1800000000000;
  for(let i=0;i<10;i++) assert.ok(apply(s,{game:'colors',round:`gain${i}`,at,
    places:[{id:'bot'}, {id:`loser${i}`}],loserId:`loser${i}`}).ok);
  const res=apply(s,{game:'colors',round:'losing-human',at,places:[{id:'bot'},{id:'human'}],loserId:'human'});
  assert.equal(res.skipped,'GAINED'); assert.equal(s.ratingOf('human','colors'),null);
});
