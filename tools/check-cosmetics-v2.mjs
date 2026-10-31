/** Raster checks and review sheets. Static composition of actual project assets;
 * this is not the v2 runtime/store integration (stages C/D).
 * node tools/check-cosmetics-v2.mjs [--dir directory] [--sheet directory]
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {ART_DIR,ROOT,COLLECTIONS,PLAN} from './build-cosmetics-v2.mjs';
import {validateAssets} from './lib/cosmetics-v2-validate.mjs';
const data=(s)=>`data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;
const asset=(rel)=>data(fs.readFileSync(path.join(ROOT,'miniapp',rel),'utf8'));
export async function checkPixels(page,dir,manifest) {
  const inputs=manifest.files.map(f=>({...f,src:data(fs.readFileSync(path.join(dir,f.file),'utf8'))}));
  const result=await page.evaluate(async(files)=>{
    let clear=0,protectedPixels=0,painted=0;
    for(const f of files) {
      const doc=new DOMParser().parseFromString(atob(f.src.split(',')[1]),'image/svg+xml');
      if(doc.querySelector('parsererror')) throw new Error(`XML_PARSE ${f.file}`);
      const im=new Image(); im.src=f.src; await im.decode();
      const cv=document.createElement('canvas');cv.width=f.width;cv.height=f.height;
      const ctx=cv.getContext('2d',{willReadFrequently:true});ctx.drawImage(im,0,0);
      const pixels=ctx.getImageData(0,0,cv.width,cv.height).data;
      let ownPaint=0; const safe=new Uint8Array(cv.width*cv.height);
      for(let y=0;y<cv.height;y++) for(let x=0;x<cv.width;x++) {
        const alpha=pixels[(y*cv.width+x)*4+3]; if(alpha) ownPaint++;
        const px=x+0.5,py=y+0.5;
        const inside=f.protectedRegions.some(r=>r.shape==='rect'?px>=r.x+1&&py>=r.y+1&&px<r.x+r.width-1&&py<r.y+r.height-1:r.shape==='circle'?(px-r.cx)**2+(py-r.cy)**2<(r.r-1)**2:((px-r.cx)/(r.rx-1))**2+((py-r.cy)/(r.ry-1))**2<1);
        if(inside) { safe[y*cv.width+x]=1; protectedPixels++; if(alpha!==0) throw new Error(`PIXELS_CLEAR ${f.file}: ${x},${y} alpha=${alpha}`); }
      }
      if(!ownPaint) throw new Error(`PIXELS_EMPTY ${f.file}`);
      if(f.protectedRegions.length) clear++;
      painted+=ownPaint;
      // Second independent render: compositing over a deterministic multicolour
      // game plane must preserve every protected pixel byte-for-byte, including alpha.
      const baseline=new Uint8ClampedArray(pixels.length);
      for(let i=0;i<baseline.length;i+=4) {baseline[i]=(i/4)%251;baseline[i+1]=(i/12)%241;baseline[i+2]=91;baseline[i+3]=255;}
      ctx.putImageData(new ImageData(baseline,cv.width,cv.height),0,0);ctx.drawImage(im,0,0);
      const composed=ctx.getImageData(0,0,cv.width,cv.height).data;
      for(let i=0;i<pixels.length;i+=4) if(safe[i/4]) for(let j=0;j<4;j++) if(composed[i+j]!==baseline[i+j]) throw new Error(`COMPOSITE ${f.file}`);
    }
    return {files:files.length,clear,protectedPixels,painted};
  },inputs);
  assert.equal(result.files,114); assert.equal(result.clear,72);
  return result;
}
function sheetHtml(dir) {
  const url=(id,role='game')=>data(fs.readFileSync(path.join(dir,`${id}-${role}.svg`),'utf8'));
  const img=(id,role,w,h)=>`<img src="${url(id,role)}" width="${w}" height="${h}">`;
  const caption=(text)=>`<small>${text}</small>`;
  const main=COLLECTIONS.map(c=>`<section><h2>${c.title}</h2><div class="nine">${PLAN.items.filter(i=>i.collection===c.id&&i.kind==='item').map(i=>`<div class="item">${img(i.id,'preview',i.slot==='cardback'||i.slot==='unoq-cardback'?72:124,i.slot==='cardback'||i.slot==='unoq-cardback'?101:124)}${caption(i.title)}</div>`).join('')}</div></section>`).join('');
  const small=COLLECTIONS.map(c=>`<section><h2>${c.title}</h2><div class="sizes">${[18,24,32,40].map(w=>`<div>${img(`${c.id}-cardback`,'game',w,w*1.4)}${caption(`Покер ${w} px`)}</div><div>${img(`${c.id}-unoq-cardback`,'game',w,w*1.4)}${caption(`UNOQ ${w} px`)}</div>`).join('')}${[24,32,48].map(w=>`<div><span class="avatar" style="width:${w}px;height:${w}px"><b>И</b>${img(`${c.id}-frame`,'game',w,w)}</span>${caption(`Рамка ${w} px`)}</div>`).join('')}${[24,32,48].map(w=>`<div>${img(`${c.id}-badge`,'game',w,w)}${caption(`Значок ${w} px`)}</div>`).join('')}<span class="turn">Ваш ход</span></div></section>`).join('');
  const boards=(c,checkers=false)=>`<div class="boardgame"><div class="squares">${Array.from({length:64},(_,i)=>`<span class="square ${(i+Math.floor(i/8))%2?'dark':'light'}">${(i<16||i>47)?`<img src="${asset(checkers?`checkers/${i<16?(i===9?'bK':'b'):(i===54?'wK':'w')}.svg`:`chess/${i<16?'b':'w'}${i<8||i>55?'K':'P'}.svg`)}">`:''}${i===27?'<i class="move"></i>':''}</span>`).join('')}</div>${img(`${c.id}-${checkers?'checkers':'chess'}-board`,'game',400,400)}</div>`;
  const nardy=(c)=>`<div class="nardy"><div class="nardy-inner">${Array.from({length:24},(_,i)=>`<div class="point ${i%2?'darkpt':''} ${i>=12?'down':''}" style="left:${24+(i%12)*34.67+(i%12>=6?16:0)}px;top:${i<12?24:188}px"><span>${i+1}</span>${[0,5,12,17].includes(i)?`<img src="${asset(`checkers/${i<12?'w':'b'}.svg`)}">`:''}</div>`).join('')}${img(`${c.id}-nardy-board`,'game',480,360)}<b class="dice">⚄ ⚁</b></div></div>`;
  const battle=(c)=>`<div class="battle"><div class="sea">${Array.from({length:100},(_,i)=>`<span class="water ${[11,12,13].includes(i)?'ship':i===42?'hit':i===43?'sunk':''}">${i===45?'●':i===42||i===43?'×':''}</span>`).join('')}</div>${img(`${c.id}-battleship-panel`,'game',400,400)}<div class="letters">А Б В Г Д Е Ж З И К</div></div>`;
  const colors=(c)=>`<div class="color-sample">${img(`${c.id}-unoq-cardback`,'game',40,56)}${['R5','Y5','G5','B5','WC','WF'].map(code=>`<img src="${asset(`colors/${code}.svg`)}" width="40" height="56">`).join('')}</div>`;
  const table=(c,durak=false)=>`<div class="table">${img(`${c.id}-table`,'game',480,320)}<div class="hand">${(durak?['AS','KH']:['AS','KH','QD','JC','10S']).map(code=>`<img src="${asset(`cards/${code}.svg`)}" width="40" height="56">`).join('')}</div><b class="bank">${durak?'Покрыть или взять':'Банк 1.000'}</b></div>`;
  const readable=COLLECTIONS.map(c=>`<section><h2>${c.title} — игровое содержание (композиция, не интеграция)</h2><div class="samples"><div>${boards(c)}${caption('Шахматы: фигуры и метка хода')}</div><div>${boards(c,true)}${caption('Шашки: простые, дамки и метка')}</div><div>${nardy(c)}${caption('Нарды: два цвета, пункты, кубики')}</div><div>${battle(c)}${caption('Морской бой: корабль, мимо, ранил, убит')}</div><div>${table(c)}${caption('Покер: лица и банк')}</div><div>${table(c,true)}${caption('Дурак: лица и действие')}</div><div>${colors(c)}${caption('UNOQ: четыре цвета, фигуры, цифры и действия')}</div></div></section>`).join('');
  const bundles=COLLECTIONS.map(c=>`<div class="item">${img(`${c.id}-bundle`,'preview',480,320)}${caption(`Комплект «${c.title}»: девять предметов`)}</div>`).join('');
  const css=`${fs.readFileSync(path.join(ROOT,'miniapp/tokens.css'),'utf8')}
  *{box-sizing:border-box}body{margin:0;background:var(--bg-main);color:var(--text-primary);font:14px var(--k-font)}h1{font-size:24px;margin:16px}h2{font-size:20px;margin:8px 0 12px}section{padding:16px;border-bottom:1px solid var(--border-color)}.nine{display:grid;grid-template-columns:repeat(9,1fr);gap:8px}.item{background:var(--bg-surface);padding:12px;text-align:center;min-width:0}.item>img{display:block;object-fit:contain;margin:auto}.sizes,.samples{display:flex;gap:16px;flex-wrap:wrap;align-items:center}.sizes>div{text-align:center}.sizes small{font-size:12px}.turn{background:var(--color-success);padding:8px;border-radius:6px}small{display:block;margin:8px 0;color:var(--text-secondary);font-size:12px}.avatar{display:inline-flex;position:relative;align-items:center;justify-content:center}.avatar b{width:75%;height:75%;background:var(--bg-elevated);border-radius:50%;display:grid;place-items:center;font-size:12px}.avatar img{position:absolute;inset:0}.boardgame,.battle{position:relative;width:280px;height:280px}.boardgame>img,.battle>img,.nardy-inner>img,.table>img{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.squares,.sea{position:absolute;inset:6%;display:grid;grid-template-columns:repeat(8,1fr);grid-template-rows:repeat(8,1fr)}.square{position:relative;display:grid;place-items:center}.square.light{background:#D9E1DB}.square.dark{background:#5F7F76}.square img{width:90%;height:90%}.move{width:26%;height:26%;background:var(--text-primary);border:2px solid var(--bg-main);border-radius:50%}.nardy{position:relative;width:336px;height:252px;background:#2A221C}.nardy-inner{position:absolute;width:480px;height:360px;transform:scale(.7);transform-origin:top left}.nardy .point{position:absolute;width:34.67px;height:148px}.point:before{content:'';position:absolute;inset:14px 0 0;background:#C9B28F;clip-path:polygon(0 0,100% 0,50% 88%)}.point.darkpt:before{background:#6A5038}.point.down:before{clip-path:polygon(50% 12%,100% 100%,0 100%)}.point img{position:absolute;width:28px;height:28px;top:32px;left:3px}.point span{position:relative;font-size:12px}.dice{position:absolute;top:45%;left:39%;background:var(--card-face);color:var(--bg-main)}.sea{grid-template-columns:repeat(10,1fr);grid-template-rows:repeat(10,1fr);background:#173048}.water{border:1px solid #5A7F9E;display:grid;place-items:center}.water.ship,.water.hit{background:#C9D3D6}.water.hit{color:var(--color-danger)}.water.sunk{background:#7D8B91}.letters{position:absolute;top:0;left:8%;width:84%;font-size:10px;word-spacing:6px}.table{position:relative;width:336px;height:224px;background:var(--table-felt);border-radius:50%}.hand{position:absolute;inset:32% 0 auto;display:flex;justify-content:center;gap:4px}.bank{position:absolute;top:68%;width:100%;text-align:center;background:var(--bg-surface);border:1px solid var(--on-felt-line)}.color-sample{display:flex;gap:4px}#bundles{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}`;
  return {css,pages:{contact:main,small,readability:readable,bundles:`<div id="bundles">${bundles}</div>`}};
}
export async function run({dir=ART_DIR,out=null}={}) {
  const {manifest,total}=validateAssets(dir);
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
    const pixels=await checkPixels(page,dir,manifest);
    if(out) {
      fs.mkdirSync(out,{recursive:true}); const {css,pages}=sheetHtml(dir);
      for(const [name,body] of Object.entries(pages)) {
        await page.setContent(`<meta charset="utf-8"><style>${css}</style><h1>Косметика v2 · ${name} · арт требует утверждения</h1>${body}`);
        await page.evaluate(()=>Promise.all([...document.images].map(im=>im.decode())));
        await page.screenshot({path:path.join(out,`${name}.png`),fullPage:true});
      }
    }
    const version=browser.version(); console.log(JSON.stringify({chromium:version,total,...pixels})); return pixels;
  } finally {await browser.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const opt=(s)=>{const i=process.argv.indexOf(s);return i<0?null:path.resolve(process.argv[i+1]);};
  await run({dir:opt('--dir')??ART_DIR,out:opt('--sheet')});
}
