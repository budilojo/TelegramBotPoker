import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ART_DIR,ROOT,PLAN,COLLECTIONS,DIMENSIONS,buildAll,sha} from './build-cosmetics-v2.mjs';
import {validateAssets,validateSvg} from './lib/cosmetics-v2-validate.mjs';
import {contrast} from './build-graphit-art.mjs';
const dir=process.env.COSMETICS_V2_ART_DIR??ART_DIR;

test('v2: 54 предмета/6 наборов, безопасный SVG, размеры, полный manifest и бюджеты',()=>validateAssets(dir));
test('v2: генерация детерминирована и полностью совпадает с сохранённым пакетом',()=>{
  const a=buildAll(), b=buildAll();
  assert.deepEqual(a,b);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'))),a.manifest);
  for(const [name,text] of a.files) assert.equal(fs.readFileSync(path.join(dir,name),'utf8'),text,name);
});
test('v2: стабильные id, девять разных слотов и точный состав шести комплектов',()=>{
  assert.deepEqual(COLLECTIONS.map(c=>c.id),['sever','obsidian','chertezh','terracotta','orbita','porcelain']);
  assert.equal(new Set(PLAN.items.map(i=>i.id)).size,60);
  for(const c of COLLECTIONS) {
    const items=PLAN.items.filter(i=>i.collection===c.id&&i.kind==='item');
    assert.equal(items.length,9);
    assert.equal(new Set(items.map(i=>i.slot)).size,9);
    assert.deepEqual(PLAN.items.find(i=>i.id===`${c.id}-bundle`).includes,items.map(i=>i.id));
  }
  assert.deepEqual(DIMENSIONS.cardback,{preview:[200,280],game:[40,56]});
  assert.deepEqual(DIMENSIONS.frame,{preview:[160,160],game:[48,48]});
  assert.deepEqual(DIMENSIONS.badge,{preview:[160,160],game:[24,24]});
  assert.deepEqual(DIMENSIONS['nardy-board'],{preview:[480,360],game:[480,360]});
  for(const i of PLAN.items) assert.equal(i.price,null);
});
test('v2: шесть геометрий, самостоятельные игровые предметы, упрощение игровых версий',()=>{
  const {files}=buildAll();
  const skeleton=(text)=>text.replace(/#[A-F\d]{6}/g,'#COLOR');
  for(const slot of Object.keys(DIMENSIONS).filter(x=>x!=='bundle')) {
    const drawings=COLLECTIONS.map(c=>skeleton(files.get(`${c.id}-${slot}-game.svg`)));
    assert.equal(new Set(drawings).size,6,slot);
  }
  for(const c of COLLECTIONS) {
    const items=PLAN.items.filter(i=>i.collection===c.id&&i.kind==='item');
    assert.equal(new Set(items.map(i=>sha(files.get(`${i.id}-game.svg`)))).size,9);
    for(const i of items) {
      const preview=files.get(`${i.id}-preview.svg`),game=files.get(`${i.id}-game.svg`);
      assert.ok(game.length<preview.length,`${i.id}: отдельная упрощённая геометрия`);
    }
  }
});
test('v2: собственная линия/фон ≥4.5, декор не использует зелёный хода',()=>{
  for(const c of COLLECTIONS) {
    assert.ok(contrast(c.palette.bg,c.palette.ink)>=4.5,c.id);
    for(const color of Object.values(c.palette)) assert.notEqual(color.toLowerCase(),'#137a43');
  }
});
test('v2: запись CLI ограничена выбранной папкой, чужие ресурсы и Графит сохранены',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cosmetics-v2-write-'));
  const graphit=()=>fs.readdirSync(path.join(ROOT,'miniapp/collections/art')).sort().map(f=>[f,sha(fs.readFileSync(path.join(ROOT,'miniapp/collections/art',f)))]);
  const before=graphit();
  try {
    const sentinel=path.join(tmp,'foreign.txt'); fs.writeFileSync(sentinel,'чужая работа');
    const out=path.join(tmp,'assets'); fs.mkdirSync(out); fs.writeFileSync(path.join(out,'README.md'),'сохранить');
    for(let i=0;i<2;i++) {
      const r=spawnSync(process.execPath,['tools/build-cosmetics-v2.mjs','--out',out],{cwd:ROOT,encoding:'utf8'});
      assert.equal(r.status,0,r.stderr); validateAssets(out);
    }
    assert.deepEqual(fs.readdirSync(tmp).sort(),['assets','foreign.txt']);
    assert.equal(fs.readFileSync(sentinel,'utf8'),'чужая работа');
    assert.equal(fs.readFileSync(path.join(out,'README.md'),'utf8'),'сохранить');
    assert.deepEqual(graphit(),before);
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
});
test('v2: строгий валидатор запрещает активный SVG, внешние ссылки и рекурсивный use',()=>{
  const palette=COLLECTIONS[0].palette;
  const svg=(body)=>`<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${body}</svg>`;
  for(const body of ['<script></script>','<foreignObject></foreignObject>','<image href="x"></image>','<use href="//host/x"></use>','<g onclick="alert(1)"></g>','<style></style>','<text>текст</text>','<defs><g id="a"><use href="#a"></use></g></defs><use href="#a"></use>']) assert.throws(()=>validateSvg(svg(body),palette),/SVG_SAFE/);
});
