/** E: prove the independent real-party checks reject missing shared/personal art.
 * No other test or browser run should overlap these temporary mutations.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const file='miniapp/collections/look-view.js',original=fs.readFileSync(file,'utf8'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cosmetics-e-teeth-'));
const mutations=[
 ['shared board',"const src = gameAsset(look?.board, slot, game);","const src = null;",'shared art present'],
 ['personal frame',"if (f.color === 'v2') {","if (f.color === 'v2') return av;\n    if (f.color === 'v2') {",'sever-frame rendered'],
 ['personal badge',"const b = gameAsset(badge, 'badge');","const b = null;",'sever-badge rendered'],
 ['retired decoration mixed in',"if (f.color === 'v2') {","if (f.color === 'v2') { av.append(make('span', 'cos-title'));",'legacy decorations never mix with v2'],
];
const env={...process.env,VERIFY_GAME:'chess',VERIFY_COLLECTION:'sever',VERIFY_WIDTH:'320',VERIFY_SHOTS:dir};
try{
 for(const [label,from,to,reason] of mutations){
  assert.ok(original.includes(from),label);
  try{
   fs.writeFileSync(file,original.replace(from,to));
   const r=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','tools/verify-cosmetics-v2.mjs'],{encoding:'utf8',env,timeout:45000});
   const log=(r.stdout||'')+(r.stderr||'');assert.equal(r.status,1,log);assert.match(log,/AssertionError/);assert.ok(log.includes(reason),`${label}: wrong failure\n${log}`);assert.doesNotMatch(log,/SyntaxError|TypeError|ReferenceError/);console.log(`caught ${label}: ${reason}`);
  }finally{fs.writeFileSync(file,original);}
 }
 const control=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','tools/verify-cosmetics-v2.mjs'],{encoding:'utf8',env,timeout:45000});assert.equal(control.status,0,control.stdout+control.stderr);
 assert.equal(fs.readFileSync(file,'utf8'),original);console.log(`${mutations.length}/${mutations.length} caught by independent actual-party asserts; restored control green`);
 if(process.argv.includes('--dock')){
  const chat='miniapp/chat.js',saved=fs.readFileSync(chat,'utf8'),guard='if (!fab || $app()?.inert) return;';
  assert.ok(saved.includes(guard));
  const args=['--disable-warning=ExperimentalWarning','tools/e2e-cosmetics-shop.mjs'];
  const dockEnv={...process.env,SHOP_DOCK_TEETH:'1',COSMETICS_SHOP_SHOTS:dir};
  try{
   fs.writeFileSync(chat,saved.replace(guard,'if (!fab) return;'));
   const r=spawnSync(process.execPath,args,{encoding:'utf8',env:dockEnv,timeout:45000});
   const log=(r.stdout||'')+(r.stderr||'');assert.equal(r.status,1,log);assert.match(log,/AssertionError/);assert.match(log,/shop must not reposition chat through inert game content/);assert.doesNotMatch(log,/SyntaxError|TypeError|ReferenceError/);
   console.log('caught chat return overlap: shop must not reposition chat through inert game content');
  }finally{fs.writeFileSync(chat,saved);}
  const green=spawnSync(process.execPath,args,{encoding:'utf8',env:dockEnv,timeout:45000});
  assert.equal(green.status,0,green.stdout+green.stderr);console.log('restored chat return control green');
 }
 if(process.argv.includes('--perf')){
  const index='miniapp/collections/index.js',saved=fs.readFileSync(index,'utf8'),from='export function open(route = null) {';
  assert.ok(saved.includes(from));
  try{
   fs.writeFileSync(index,saved.replace(from,`${from}\n  store.subscribe(() => {}); // deliberate leak for verification`));
   const r=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','tools/perf-cosmetics-v2.mjs'],{encoding:'utf8',env:{...process.env,COSMETICS_PERF_ONLY:'current',COSMETICS_PERF_RUNS:'1',COSMETICS_PERF_OUT:path.join(dir,'perf.json')},timeout:90000});
   const log=(r.stdout||'')+(r.stderr||'');assert.equal(r.status,1,log);assert.match(log,/AssertionError/);assert.match(log,/no accumulating store\/pay subscriptions/);assert.doesNotMatch(log,/SyntaxError|TypeError|ReferenceError/);console.log('caught subscription leak: no accumulating store/pay subscriptions');
  }finally{fs.writeFileSync(index,saved);}
  const art='miniapp/collections/art.js',small=fs.readFileSync(art,'utf8'),branch="if (it?.collection && it.kind === 'bundle' && !detail) {";
  assert.ok(small.includes(branch));
  try{
   fs.writeFileSync(art,small.replace(branch,'if (false) {'));
   const r=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','tools/perf-cosmetics-v2.mjs'],{encoding:'utf8',env:{...process.env,COSMETICS_PERF_ONLY:'current',COSMETICS_PERF_RUNS:'1',COSMETICS_PERF_OUT:path.join(dir,'perf.json')},timeout:90000});
   const log=(r.stdout||'')+(r.stderr||'');assert.equal(r.status,1,log);assert.match(log,/AssertionError/);assert.match(log,/detail previews stay lazy, including bundles/);assert.doesNotMatch(log,/SyntaxError|TypeError|ReferenceError/);console.log('caught eager bundle previews: detail previews stay lazy, including bundles');
  }finally{fs.writeFileSync(art,small);}
 }
}finally{fs.writeFileSync(file,original);fs.rmSync(dir,{recursive:true,force:true});}
