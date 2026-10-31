/** Авторская геометрия Codex B. Без сети, растра, шрифтов и случайности.
 * node tools/build-cosmetics-v2.mjs [--out /absolute/directory]
 * Импорт не пишет файлы. Контракт: docs/cosmetics-v2/contracts.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ART_DIR = path.join(ROOT, 'miniapp/collections/v2-art');
export const PLAN = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cosmetics-v2/item-plan.json'), 'utf8'));
export const BUDGET = { detailBytes: 24576, smallBytes: 8192, totalBytes: 1048576 };
export const COLLECTIONS = [
  { id: 'sever', title: 'Север', motif: 'Ледяные грани и восьмилучевой кристалл', palette: { bg: '#203442', ink: '#D4E7EF', mid: '#738F9D' } },
  { id: 'obsidian', title: 'Обсидиан', motif: 'Асимметричные срезы и монолит', palette: { bg: '#25262C', ink: '#D6D7DC', mid: '#777883' } },
  { id: 'chertezh', title: 'Чертёж', motif: 'Калибровка, координатная сетка и угловые метки', palette: { bg: '#1E304F', ink: '#E5E8DF', mid: '#7C91B0' } },
  { id: 'terracotta', title: 'Терракота', motif: 'Широкие дуги, плитка и ступени', palette: { bg: '#743F36', ink: '#F3DDC8', mid: '#B77F68' } },
  { id: 'orbita', title: 'Орбита', motif: 'Смещённые окружности и спутники', palette: { bg: '#403448', ink: '#DED8ED', mid: '#9C8FAE' } },
  { id: 'porcelain', title: 'Фарфор', motif: 'Парные листья и тонкий растительный бордюр', palette: { bg: '#E0E9EC', ink: '#304553', mid: '#8499A3' } },
];
export const DIMENSIONS = {
  cardback: { preview: [200, 280], game: [40, 56] },
  'unoq-cardback': { preview: [200, 280], game: [40, 56] },
  table: { preview: [480, 320], game: [480, 320] },
  frame: { preview: [160, 160], game: [48, 48] },
  badge: { preview: [160, 160], game: [24, 24] },
  'chess-board': { preview: [400, 400], game: [400, 400] },
  'checkers-board': { preview: [400, 400], game: [400, 400] },
  'nardy-board': { preview: [480, 360], game: [480, 360] },
  'battleship-panel': { preview: [400, 400], game: [400, 400] },
  bundle: { preview: [480, 320] },
};
const n = (v) => +v.toFixed(3);
const el = (tag, attrs = {}, children = '') => `<${tag}${Object.entries(attrs).map(([k,v]) => ` ${k}="${v}"`).join('')}>${children}</${tag}>`;
const p = (d, attrs = {}) => el('path', { d, ...attrs });
const rect = (x,y,w,h,attrs={}) => el('rect',{x:n(x),y:n(y),width:n(w),height:n(h),...attrs});
const circle = (x,y,r,attrs={}) => el('circle',{cx:n(x),cy:n(y),r:n(r),...attrs});
const group = (transform, kids, attrs={}) => el('g',{transform,...attrs},kids);
const line = (d, ink, sw=2, attrs={}) => p(d,{fill:'none',stroke:ink,'stroke-width':sw,'stroke-linecap':'round','stroke-linejoin':'round',...attrs});
const poly = (d, ink) => p(d,{fill:ink});
const ellipseD = (x,y,rx,ry) => `M${n(x-rx)} ${y}a${rx} ${ry} 0 1 0 ${rx*2} 0a${rx} ${ry} 0 1 0 ${-rx*2} 0Z`;
const rectD = (x,y,w,h) => `M${x} ${y}h${w}v${h}h${-w}Z`;
/** Local emblem within [-1,1]². Each collection has independent topology. */
function emblem(id, ink, detail) {
  switch(id) {
    case 'sever': return line('M0 -0.92V0.92M-0.92 0H0.92M-0.66 -0.66L0.66 0.66M-0.66 0.66L0.66 -0.66M-0.27 -0.62L0 -0.4L0.27 -0.62M-0.27 0.62L0 0.4L0.27 0.62',ink,0.11) + (detail ? line('M-0.62 -0.27L-0.4 0L-0.62 0.27M0.62 -0.27L0.4 0L0.62 0.27',ink,0.06) : '');
    case 'obsidian': return poly('M-0.74 0.78L-0.9 -0.2L-0.22 -0.96L0.68 -0.7L0.9 0.34L0.22 0.92Z',ink) + line('M-0.71 -0.15L-0.16 -0.68L0.12 0.02L0.64 0.26M0.12 0.02L0.16 0.68', '#25262C',detail?0.05:0.09);
    case 'chertezh': return line('M-0.9 -0.35V-0.9H-0.35M0.35 -0.9H0.9V-0.35M0.9 0.35V0.9H0.35M-0.35 0.9H-0.9V0.35M-0.6 0H0.6M0 -0.6V0.6',ink,0.11) + circle(0,0,0.3,{fill:'none',stroke:ink,'stroke-width':0.07});
    case 'terracotta': return line('M-0.88 0.74V0.06A0.88 0.88 0 0 1 0.88 0.06V0.74M-0.46 0.74V0.06A0.46 0.46 0 0 1 0.46 0.06V0.74M-0.88 0.8H0.88',ink,0.13) + (detail?line('M-0.12 0.7V0.3H0.12V0.7',ink,0.05):'');
    case 'orbita': return el('ellipse',{cx:0,cy:0,rx:0.94,ry:0.4,transform:'rotate(-32)',fill:'none',stroke:ink,'stroke-width':0.09}) + circle(0.12,-0.06,0.52,{fill:'none',stroke:ink,'stroke-width':0.08}) + circle(-0.73,0.41,0.17,{fill:ink}) + circle(0.52,-0.68,detail?0.1:0.14,{fill:ink});
    case 'porcelain': return line('M-0.52 0.88Q0.25 0.22 0.2 -0.88',ink,0.09) + poly('M0.12 -0.58Q-0.85 -0.96 -0.5 -0.22Q-0.12 0.03 0.12 -0.58ZM0.14 -0.23Q0.98 -0.74 0.75 -0.02Q0.53 0.33 0.14 -0.23ZM-0.08 0.25Q-0.92 -0.01 -0.59 0.62Q-0.32 0.79 -0.08 0.25Z',ink);
    default: throw new Error(`Неизвестная коллекция ${id}`);
  }
}
const mark = (c,x,y,r,detail) => group(`translate(${n(x)} ${n(y)}) scale(${n(r)})`,emblem(c.id,c.palette.ink,detail));
/** Border tile. These are not scaled copies of the central emblems. */
function tile(c, detail) {
  const {ink,mid}=c.palette;
  switch(c.id) {
    case 'sever': return line('M-12 3L-7 -4L-2 2L4 -5L12 3M-9 6L-4 0L2 5L7 0',ink,detail?1:2);
    case 'obsidian': return poly('M-12 -4L-2 -6L5 0L-5 5Z',mid)+line('M-2 -6L1 0L-5 5M5 0L12 -5V4L5 0',ink,1.5);
    case 'chertezh': return line('M-12 4H12M-10 4V-4M-5 4V1M0 4V-2M5 4V1M10 4V-4',ink,detail?1:1.8);
    case 'terracotta': return line('M-12 5V-3H-4V1H4V-3H12V5M-10 -3A10 8 0 0 1 10 -3',ink,2);
    case 'orbita': return line('M-12 4A14 9 0 0 1 10 -3M-7 6A12 9 0 0 1 12 -1',ink,1.5)+circle(-9,0,2.2,{fill:ink});
    case 'porcelain': return line('M-12 2Q0 -2 12 2',ink,1)+poly('M-6 1Q-9 -7 -1 -3Q0 1 -6 1ZM2 1Q5 7 9 2Q7 -2 2 1Z',ink);
  }
}
function borderTiles(c,w,h,detail,variant=0) {
  let body='';
  const step=detail?36:56;
  for(let x=40+variant*6;x<w-28;x+=step) {
    body+=group(`translate(${x} 12)`,el('use',{href:'#tile'}));
    body+=group(`translate(${w-x} ${h-12}) rotate(180)`,el('use',{href:'#tile'}));
  }
  if(detail || variant!==0) for(let y=44;y<h-28;y+=step) {
    body+=group(`translate(12 ${y}) rotate(-90)`,el('use',{href:'#tile'}));
    body+=group(`translate(${w-12} ${h-y}) rotate(90)`,el('use',{href:'#tile'}));
  }
  return body;
}
function clipped(id,d,body,bg) {
  return el('defs',{},el('clipPath',{id},p(d,{'clip-rule':'evenodd'}))) + p(d,{fill:bg,'fill-rule':'evenodd'}) + el('g',{'clip-path':`url(#${id})`},body);
}
function card(c,detail,uno) {
  const {bg,ink,mid}=c.palette;
  let b=rect(0,0,200,280,{rx:12,fill:bg})+rect(8,8,184,264,{rx:8,fill:'none',stroke:ink,'stroke-width':detail?2:5});
  // Poker: one bold emblem, fine edge facets. UNOQ: paired emblems, divided rail.
  if(uno) {
    if(detail) b+=rect(16,16,168,248,{rx:6,fill:'none',stroke:mid,'stroke-width':1})+line('M32 140H48M152 140H168M100 24V36M100 244V256',ink,1);
    b+=line('M22 202L178 78M22 218L178 94',mid,detail?2:5);
    b+=mark(c,100,78,38,detail)+group('translate(100 202) rotate(180) scale(38)',emblem(c.id,ink,detail));
    b+=line('M26 32H64M136 248H174',ink,detail?3:6);
  } else {
    b+=mark(c,100,140,58,detail);
    b+=mark(c,30,34,12,false)+group('translate(170 246) rotate(180) scale(12)',emblem(c.id,ink,false));
    if(detail) b+=borderTiles(c,200,280,true);
    else b+=line('M24 82V198M176 82V198',mid,4);
  }
  return b;
}
function art(c,slot,detail) {
  return el('defs',{},el('g',{id:'tile'},tile(c,detail)))+innerArt(c,slot,detail);
}
function innerArt(c,slot,detail) {
  const {bg,ink,mid}=c.palette;
  if(slot==='cardback'||slot==='unoq-cardback') return card(c,detail,slot==='unoq-cardback');
  if(slot==='badge') return circle(80,80,74,{fill:bg,stroke:ink,'stroke-width':detail?2:6})+(detail?circle(80,80,65,{fill:'none',stroke:ink,'stroke-width':1}):'')+mark(c,80,80,54,detail);
  if(slot==='frame') {
    const polygon=(radii)=>radii.map((r,i)=>`${i?'L':'M'}${n(80+r*Math.sin(i*2*Math.PI/radii.length))} ${n(80-r*Math.cos(i*2*Math.PI/radii.length))}`).join('')+'Z';
    const outer={
      sever:polygon(Array.from({length:16},(_,i)=>i%2?72:78)),
      obsidian:'M48 4L112 8L154 48L150 118L108 156L36 146L4 100L12 40Z',
      chertezh:'M18 2H142L158 18V142L142 158H18L2 142V18Z',
      terracotta:'M46 2H114V10H138V22H150V46H158V114H150V138H138V150H114V158H46V150H22V138H10V114H2V46H10V22H22V10H46Z',
      orbita:ellipseD(80,80,78,72),
      porcelain:ellipseD(80,80,78,78),
    }[c.id];
    const d=outer+ellipseD(80,80,60,60);
    let b=p(outer,{fill:'none',stroke:ink,'stroke-width':detail?2:5})+circle(80,80,62,{fill:'none',stroke:ink,'stroke-width':detail?1:3});
    if(c.id==='orbita') b+=el('ellipse',{cx:84,cy:80,rx:69,ry:74,fill:'none',stroke:ink,'stroke-width':detail?1:3});
    for(let i=0;i<(detail?12:6);i++) b+=group(`translate(80 80) rotate(${i*(detail?30:60)}) translate(0 -69) scale(0.6)`,el('use',{href:'#tile'}));
    return clipped('rim',d,b,bg);
  }
  if(slot==='table') {
    const d=ellipseD(240,160,238,158)+ellipseD(240,160,218,138);
    let b=el('ellipse',{cx:240,cy:160,rx:235,ry:155,fill:'none',stroke:ink,'stroke-width':detail?1.5:2});
    for(let i=0;i<(detail?32:20);i++) {
      const a=i*2*Math.PI/(detail?32:20);
      b+=group(`translate(${n(240+228*Math.cos(a))} ${n(160+148*Math.sin(a))}) rotate(${n(a*180/Math.PI+90)}) scale(0.65)`,el('use',{href:'#tile'}));
    }
    return clipped('rail',d,b,bg);
  }
  const [w,h]=DIMENSIONS[slot].preview;
  let d=rectD(2,2,w-4,h-4)+rectD(24,24,w-48,h-48);
  let b=rect(5,5,w-10,h-10,{rx:slot==='checkers-board'?0:6,fill:'none',stroke:ink,'stroke-width':detail?1.5:2});
  if(slot==='checkers-board') {
    // Broad alternating inlays make the draughts miniature distinct from chess.
    for(let x=32;x<w-24;x+=48) {
      b+=rect(x,8,22,12,{fill:mid})+rect(w-x-22,h-20,22,12,{fill:mid});
      b+=group(`translate(12 ${x+12}) rotate(-90) scale(0.7)`,el('use',{href:'#tile'}));
      b+=group(`translate(${w-12} ${w-x-12}) rotate(90) scale(0.7)`,el('use',{href:'#tile'}));
    }
    if(detail) b+=rect(21,21,w-42,h-42,{fill:'none',stroke:ink,'stroke-width':1});
  } else if(slot==='battleship-panel') {
    // Quiet coordinate rails, corner emblems; no checker-like border or target.
    for(let x=48;x<w-32;x+=detail?30:60) {
      b+=line(`M${x} 4V9M${x} ${h-4}V${h-9}M4 ${x}H9M${w-4} ${x}H${w-9}`,ink,detail?1:2);
    }
    for(const [x,y,a] of [[w/2,12,0],[w/2,h-12,180],[12,h/2,-90],[w-12,h/2,90]]) b+=group(`translate(${x} ${y}) rotate(${a})`,el('use',{href:'#tile'}));
  } else b+=borderTiles(c,w,h,detail,slot==='chess-board'?0:1);
  if(slot==='chess-board') b+=line(`M20 60V20H60M${w-60} ${h-20}H${w-20}V${h-60}`,ink,2);
  if(slot==='checkers-board') b+=line(`M4 28H12V20H20V12H28M${w-28} ${h-4}V${h-12}H${w-20}V${h-20}H${w-12}V${h-28}`,ink,3);
  if(slot==='nardy-board') {
    // Two play windows; central bar 16/480 wide. No triangles/dice/checkers baked in.
    d=rectD(2,2,w-4,h-4)+rectD(24,24,208,312)+rectD(248,24,208,312);
    b+=rect(235,8,10,344,{rx:2,fill:'none',stroke:ink,'stroke-width':1.5});
    for(const y of [66,180,294]) b+=group(`translate(240 ${y}) rotate(90) scale(0.5)`,el('use',{href:'#tile'}));
  }
  if(slot==='battleship-panel') {
    // Corner plates distinct from boards. No coordinates/ships/shot symbols in SVG.
    for(const [x,y] of [[12,12],[388,12],[12,388],[388,388]]) b+=mark(c,x,y,8,false);
  }
  return clipped('edge',d,b,bg);
}
export function protectedRegions(slot,role) {
  const [w,h]=DIMENSIONS[slot][role];
  if(slot==='frame') return [{shape:'circle',cx:w/2,cy:h/2,r:w*60/160}];
  if(slot==='table') return [{shape:'ellipse',cx:240,cy:160,rx:218,ry:138}];
  if(slot==='nardy-board') return [{shape:'rect',x:24,y:24,width:208,height:312},{shape:'rect',x:248,y:24,width:208,height:312}];
  if(['chess-board','checkers-board','battleship-panel'].includes(slot)) return [{shape:'rect',x:24,y:24,width:352,height:352}];
  return [];
}
function bundle(c) {
  // All nine objects, not a tenth independent product. Local vector geometry only; each tile reference stays within its own group.
  const slots=['cardback','table','frame','badge','chess-board','checkers-board','nardy-board','battleship-panel','unoq-cardback'];
  return slots.map((s,i)=>{
    const [w,h]=DIMENSIONS[s].preview;
    const k=Math.min(136/w,92/h);
    return group(`translate(${n(i%3*160+(160-w*k)/2)} ${n(Math.floor(i/3)*106+(106-h*k)/2)}) scale(${n(k)})`,art(c,s,false).replaceAll('id="','id="'+i+'-').replaceAll('url(#',`url(#${i}-`).replaceAll('href="#',`href="#${i}-`));
  }).join('');
}
export function svgFor(item,role) {
  const c=COLLECTIONS.find(x=>x.id===item.collection);
  const slot=item.kind==='bundle'?'bundle':item.slot;
  const [w,h]=DIMENSIONS[slot][role];
  const [cw,ch]=DIMENSIONS[slot].preview;
  const body=slot==='bundle'?bundle(c):art(c,slot,role==='preview');
  return el('svg',{xmlns:'http://www.w3.org/2000/svg',viewBox:`0 0 ${w} ${h}`,width:w,height:h,...(['table','nardy-board'].includes(slot)?{preserveAspectRatio:'none'}:{}),'aria-hidden':'true',focusable:'false'},group(`scale(${n(w/cw)} ${n(h/ch)})`,body))+'\n';
}
export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export function buildAll() {
  const files=new Map();
  const records=[];
  const items=[];
  for(const item of PLAN.items) {
    const assets={};
    for(const role of ['preview','game']) {
      if(!item.assets[role]) { assets[role]=null; continue; }
      const file=path.basename(item.assets[role]);
      const svg=svgFor(item,role);
      const [width,height]=DIMENSIONS[item.slot??'bundle'][role];
      files.set(file,svg);
      assets[role]=item.assets[role];
      records.push({file,item:item.id,role,slot:item.slot,viewBox:`0 0 ${width} ${height}`,width,height,bytes:Buffer.byteLength(svg),sha256:sha(svg),protectedRegions:protectedRegions(item.slot??'bundle',role)});
    }
    items.push({...item,readiness:'art-ready',preview:assets.preview,game:assets.game,assets});
  }
  return {files,manifest:{v:2,generator:'tools/build-cosmetics-v2.mjs',source:{kind:'project-generated',author:'Codex B',approved:false},collections:COLLECTIONS,budget:BUDGET,items,files:records}};
}
export function writeAll(outDir=ART_DIR) {
  const {files,manifest}=buildAll();
  fs.mkdirSync(outDir,{recursive:true});
  for(const [name,body] of files) fs.writeFileSync(path.join(outDir,name),body);
  fs.writeFileSync(path.join(outDir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return {files,manifest};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const i=process.argv.indexOf('--out');
  const {files}=writeAll(i>=0?path.resolve(process.argv[i+1]):ART_DIR);
  console.log(`${files.size} SVG; ${[...files.values()].reduce((a,b)=>a+Buffer.byteLength(b),0)} байт; manifest.json`);
}
