/** Strict validation of the generated, static SVG dialect (no general XML/HTML). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLAN, COLLECTIONS, DIMENSIONS, BUDGET, sha, protectedRegions } from '../build-cosmetics-v2.mjs';
const tags=new Set(['svg','defs','clipPath','g','path','rect','circle','ellipse','use']);
const attrs=new Set(['xmlns','viewBox','preserveAspectRatio','width','height','aria-hidden','focusable','transform','id','d','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','fill-rule','clip-rule','clip-path','x','y','rx','ry','cx','cy','r','href']);
export function validateSvg(text,palette,label='SVG') {
  const bad=(cond,msg)=>assert.ok(cond,`SVG_SAFE ${label}: ${msg}`);
  const stack=[]; const ids=new Map(); const refs=[]; let pos=0; let root=null;
  for(const m of text.matchAll(/<(\/?)([A-Za-z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g)) {
    bad(text.slice(pos,m.index).trim()==='', 'текст/неподдерживаемая разметка'); pos=m.index+m[0].length;
    const [,close,tag,raw,self]=m; bad(tags.has(tag),`тег ${tag}`);
    if(close) { bad(stack.pop()===tag,'порядок закрытия'); continue; }
    const a={};
    for(const v of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) { bad(attrs.has(v[1]),`атрибут ${v[1]}`); bad(!(v[1] in a),'повтор атрибута'); a[v[1]]=v[2]; }
    if(!root) { bad(tag==='svg','корень svg'); root=a; }
    else bad(tag!=='svg' && stack.length>0,'вложенный/второй svg');
    for(const [key,value] of Object.entries(a)) {
      bad(!/[&<>]/.test(value),'XML entities/разметка');
      if(key==='xmlns') bad(value==='http://www.w3.org/2000/svg','namespace');
      else if(key==='preserveAspectRatio') bad(value==='none','aspect ratio');
      else if(['fill','stroke'].includes(key)) bad(value==='none'||Object.values(palette).includes(value),'цвет вне палитры');
      else if(key==='href'||key==='clip-path') {
        const ref=key==='href'?/^#([\w-]+)$/.exec(value):/^url\(#([\w-]+)\)$/.exec(value);
        bad(ref,'только локальная ссылка'); refs.push({id:ref[1],kind:key});
        bad(key!=='href'||tag==='use','href только use');
      } else if(key==='id') { bad(/^[\w-]+$/.test(value)&&!ids.has(value),'уникальный id'); ids.set(value,{tag,hasUse:false}); }
      else if(['width','height','stroke-width','x','y','rx','ry','cx','cy','r'].includes(key)) bad(/^-?\d+(\.\d+)?$/.test(value)&&Number.isFinite(+value),'конечное число');
      else if(key==='transform') bad(/^(?:(?:translate|scale|rotate)\(-?[\d.]+(?: -?[\d.]+)*\)\s*)+$/.test(value),'transform');
      else if(key==='d') bad(/^[MmZzLlHhVvCcSsQqTtAaEe\d., +\-]+$/.test(value),'path');
    }
    // Reusable geometry contains no use: excludes reference cycles and expansion bombs.
    if(tag==='use') for(const id of ids.values()) if(stack.includes('defs')&&id.tag==='g') id.hasUse=true;
    if(!self) stack.push(tag);
  }
  bad(text.slice(pos).trim()===''&&stack.length===0,'конец XML');
  bad(root?.xmlns==='http://www.w3.org/2000/svg'&&root['aria-hidden']==='true'&&root.focusable==='false','декор скрыт от чтения/фокуса');
  for(const r of refs) {
    const target=ids.get(r.id); bad(target,'ссылка существует');
    bad(r.kind==='href'?target.tag==='g'&&!target.hasUse:target.tag==='clipPath','тип ссылки/рекурсия');
  }
  return root;
}
export function validateAssets(dir) {
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  assert.equal(manifest.v,2,'MANIFEST v2');
  assert.equal(manifest.generator,'tools/build-cosmetics-v2.mjs','MANIFEST generator');
  assert.deepEqual(manifest.source,{kind:'project-generated',author:'Codex B',approved:false},'MANIFEST approval');
  assert.deepEqual(manifest.collections,COLLECTIONS,'MANIFEST palettes');
  assert.deepEqual(manifest.budget,BUDGET,'BUDGET manifest');
  assert.equal(manifest.items.length,60,'ITEMS 54 + 6');
  assert.equal(manifest.files.length,114,'FILES 114');
  const expected=PLAN.items.flatMap(i=>Object.values(i.assets).filter(Boolean).map(f=>path.basename(f)));
  assert.deepEqual(fs.readdirSync(dir).filter(f=>f!=='README.md').sort(),[...expected,'manifest.json'].sort(),'FILES disk');
  assert.deepEqual(manifest.files.map(f=>f.file).sort(),expected.sort(),'FILES manifest');
  for(const item of PLAN.items) {
    const got=manifest.items.find(x=>x.id===item.id);
    assert.ok(got,`ITEMS ${item.id}`);
    assert.deepEqual({...got,readiness:'planned',preview:undefined,game:undefined},{...item,preview:undefined,game:undefined},`ITEMS metadata ${item.id}`);
    assert.equal(got.readiness,'art-ready','ITEMS art-ready');
    assert.equal(got.preview,item.assets.preview,'ITEMS preview URL');
    assert.equal(got.game,item.assets.game??null,'ITEMS game URL');
  }
  let total=0;
  for(const f of manifest.files) {
    const item=PLAN.items.find(i=>i.id===f.item); assert.ok(item,`ITEMS ${f.item}`);
    assert.ok(['game','preview'].includes(f.role),'FILES role');
    assert.equal(f.file,path.basename(item.assets[f.role]),'FILES item URL');
    assert.equal(f.slot,item.slot,'FILES slot');
    const text=fs.readFileSync(path.join(dir,f.file),'utf8');
    const palette=COLLECTIONS.find(c=>c.id===item.collection).palette;
    const root=validateSvg(text,palette,f.file);
    const [w,h]=DIMENSIONS[item.slot??'bundle'][f.role];
    assert.deepEqual([f.width,f.height,f.viewBox],[w,h,`0 0 ${w} ${h}`],'DIMENSIONS manifest');
    assert.deepEqual([+root.width,+root.height,root.viewBox],[w,h,f.viewBox],'DIMENSIONS svg');
    assert.equal(root.preserveAspectRatio,['table','nardy-board'].includes(item.slot)?'none':undefined,'DIMENSIONS aspect');
    assert.deepEqual(f.protectedRegions,protectedRegions(item.slot??'bundle',f.role),'REGIONS manifest');
    assert.equal(f.bytes,Buffer.byteLength(text),'HASH bytes');
    assert.equal(f.sha256,sha(text),'HASH sha256');
    assert.ok(f.bytes<=(f.role==='game'?8192:24576),`BUDGET ${f.file} ${f.bytes}`); total+=f.bytes;
  }
  assert.ok(total<=1048576,`BUDGET total ${total}`);
  return {manifest,total};
}
