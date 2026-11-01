/** D UI guards: temporary single-file regressions, exact restoration even on failed assertion. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const cases = [
 ['stale choice is not owned','miniapp/collections/item.js','if (snap.owned.includes(id) && c?.item === id)','if (c?.item === id)','unit'],
 ['honest owner source','miniapp/collections/shop-model.js',"['owner', 'Доступ владельца · бесплатно']","['owner', 'Покупка']",'unit'],
 ['unowned item has no equip action','miniapp/collections/item.js','const own = store.own(id);','const own = true;','browser'],
 ['fitting sends no state or apply','miniapp/collections/fitting.js',"  if (it.collection) return h('div.col-fit',","  if (!globalThis.__teethPreviewSent) { globalThis.__teethPreviewSent = true; ctx.store.refresh(); }\n  if (it.collection) return h('div.col-fit',",'browser'],
 ['failed preview remembered','miniapp/collections/art.js','if (!src || isFailed(src))','if (!src)','browser'],
 ['failed ornament leaves classic','miniapp/collections.css','.col-sample > .col-art.fallback .col-art-base, .col-sample-avatar .col-art.fallback .col-art-base { display: none; }','.col-sample > .col-art.fallback .col-art-base, .col-sample-avatar .col-art.fallback .col-art-base { display: block; }','browser'],
 ['catalog count is not a timer','miniapp/collections/showcase.js',"'data-result-count': items.length","'data-count': items.length",'browser'],
];
for(const [label,file,from,to,kind] of cases){
 const original=fs.readFileSync(file,'utf8');assert.ok(original.includes(from),label);
 try{
  fs.writeFileSync(file,original.replace(from,to));
  const args=kind==='unit'?['--test','bot/cosmetics.shop.test.js']:['tools/e2e-cosmetics-shop.mjs'];
  const r=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',...args],{encoding:'utf8',env:{...process.env,SHOP_TEETH:'1'},timeout:60000});
  const output=(r.stdout||'')+(r.stderr||'');fs.writeFileSync(`/private/tmp/shop-teeth-${cases.findIndex(c=>c[0]===label)}.log`,output);
  assert.equal(r.status,1,`${label}: expected failed assertion\n${output}`);
  assert.match(output,/AssertionError|ERR_ASSERTION/,`${label}: must fail by assertion\n${output}`);
  assert.doesNotMatch(output,/SyntaxError|ReferenceError|TypeError/,`${label}: wrong failure\n${output}`);
  console.log('caught:',label);
 }finally{fs.writeFileSync(file,original);}
}
const control=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--test','bot/cosmetics.shop.test.js'],{encoding:'utf8'});assert.equal(control.status,0,control.stdout+control.stderr);
console.log('7/7 caught; restored unit green');
