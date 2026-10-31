/** Deliberately broken temporary copies must fail the real tests/checker.
 * node tools/cosmetics-v2-art-teeth.mjs [--browser]
 * Never changes repository SVG or generator; removes only its own tmp directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {ART_DIR,ROOT,sha} from './build-cosmetics-v2.mjs';
const edit=(file,fn)=>(dir)=>{
  const p=path.join(dir,file); const text=fn(fs.readFileSync(p,'utf8')); fs.writeFileSync(p,text);
  // Refresh hashes so the safety/geometry/budget check itself must catch the defect.
  const mp=path.join(dir,'manifest.json'),m=JSON.parse(fs.readFileSync(mp));
  const f=m.files.find(x=>x.file===file);f.bytes=Buffer.byteLength(text);f.sha256=sha(text);
  fs.writeFileSync(mp,JSON.stringify(m));
};
const changeManifest=(fn)=>(dir)=>{const p=path.join(dir,'manifest.json');const m=JSON.parse(fs.readFileSync(p));fn(m);fs.writeFileSync(p,JSON.stringify(m));};
const first='sever-cardback-game.svg';
const add=(body)=>edit(first,s=>s.replace('</svg>',body+'</svg>'));
const cases=[
  ['скрипт',add('<script>alert(1)</script>'),/SVG_SAFE/],
  ['внешний use',add('<use href="https://example.invalid/a.svg"></use>'),/SVG_SAFE/],
  ['протокол-независимый адрес',add('<use href="//example.invalid/a"></use>'),/SVG_SAFE/],
  ['image даже с data',add('<image href="data:image/png;base64,AAAA"></image>'),/SVG_SAFE/],
  ['foreignObject',add('<foreignObject></foreignObject>'),/SVG_SAFE/],
  ['обработчик события',add('<g onload="alert(1)"></g>'),/SVG_SAFE/],
  ['CSS',add('<style></style>'),/SVG_SAFE/],
  ['градиент',add('<linearGradient id="x"></linearGradient>'),/SVG_SAFE/],
  ['фильтр',add('<g filter="url(#x)"></g>'),/SVG_SAFE/],
  ['текст/шрифт',add('<text>Не статус</text>'),/SVG_SAFE/],
  ['рекурсивный use',add('<defs><g id="cycle"><use href="#cycle"></use></g></defs><use href="#cycle"></use>'),/SVG_SAFE/],
  ['цвет вне серии',edit(first,s=>s.replace('#D4E7EF','#FFFF00')),/SVG_SAFE/],
  ['другой размер',edit(first,s=>s.replace('viewBox="0 0 40 56"','viewBox="0 0 41 56"')),/DIMENSIONS/],
  ['растягивание стола сломано',edit('sever-table-game.svg',s=>s.replace('preserveAspectRatio="none"','preserveAspectRatio="xMidYMid meet"')),/SVG_SAFE/],
  ['раздутый игровой SVG',add('<path d="M0 0" fill="none"></path>'.repeat(300)),/BUDGET/],
  ['пропавший ресурс',dir=>fs.unlinkSync(path.join(dir,first)),/FILES disk/],
  ['лишний ресурс',dir=>fs.writeFileSync(path.join(dir,'extra.svg'),'<svg/>'),/FILES disk/],
  ['неполный manifest',changeManifest(m=>m.files.pop()),/FILES 114/],
  ['hash не совпадает',changeManifest(m=>m.files[0].sha256='0'.repeat(64)),/HASH/],
  ['id переименован',changeManifest(m=>m.items[0].id='changed-id'),/ITEMS/],
  ['слот подменён',changeManifest(m=>m.items[0].slot='badge'),/ITEMS/],
  ['цена назначена',changeManifest(m=>m.items[0].price=1),/ITEMS/],
  ['нет предмета в комплекте',changeManifest(m=>m.items.find(i=>i.kind==='bundle').includes.pop()),/ITEMS/],
  ['чужое утверждение',changeManifest(m=>m.source.approved=true),/MANIFEST approval/],
  ['метаданные прозрачности подменены',changeManifest(m=>m.files.find(f=>f.slot==='frame').protectedRegions=[]),/REGIONS/],
  ['геометрия на диске разошлась с генератором',edit(first,s=>s.replace('M24 82V198M176 82V198','M25 82V198M176 82V198')),/на диске|не то|AssertionError/,'генерация детерминирована'],
];
const browserCases=[
  ['лицо рамки залито','sever-frame-game.svg','<circle cx="24" cy="24" r="10" fill="#203442"></circle>'],
  ['центр стола залит','obsidian-table-game.svg','<rect x="120" y="80" width="240" height="160" fill="#25262C"></rect>'],
  ['клетки шахмат закрыты','chertezh-chess-board-preview.svg','<rect x="30" y="30" width="340" height="340" fill="#1E304F"></rect>'],
  ['пункты нард закрыты','terracotta-nardy-board-game.svg','<rect x="30" y="30" width="180" height="300" fill="#743F36"></rect>'],
  ['корабль нарисован в поле','orbita-battleship-panel-game.svg','<rect x="80" y="80" width="100" height="20" fill="#DED8ED"></rect>'],
];
const digest=()=>sha(fs.readdirSync(ART_DIR).sort().map(f=>fs.readFileSync(path.join(ART_DIR,f))).join(''));
const original=digest(); let caught=0;
for(const [name,breakIt,reason,pattern='54 предмета'] of cases) {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cosmetics-b-teeth-'));
  try {
    fs.cpSync(ART_DIR,tmp,{recursive:true});breakIt(tmp);
    const r=spawnSync(process.execPath,['--test',`--test-name-pattern=${pattern}`,'tools/cosmetics-v2-art.test.js'],{cwd:ROOT,env:{...process.env,COSMETICS_V2_ART_DIR:tmp},encoding:'utf8'});
    assert.equal(r.status,1,`${name}: тест обязан упасть\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout+r.stderr,reason,`${name}: причина падения`);
    console.log(`ПОЙМАНО ${name}`);caught++;
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
}
if(process.argv.includes('--browser')) for(const [name,file,body] of browserCases) {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cosmetics-b-pixels-'));
  try {
    fs.cpSync(ART_DIR,tmp,{recursive:true});edit(file,s=>s.replace('</svg>',body+'</svg>'))(tmp);
    const r=spawnSync(process.execPath,['tools/check-cosmetics-v2.mjs','--dir',tmp],{cwd:ROOT,encoding:'utf8'});
    assert.equal(r.status,1,`${name}: браузер обязан отказать\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout+r.stderr,/PIXELS_CLEAR/,`${name}: именно закрытая игровая область`);
    console.log(`ПОЙМАНО браузером ${name}`);caught++;
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
}
assert.equal(digest(),original,'Репозиторные ресурсы не менялись');
const r=spawnSync(process.execPath,['--test','tools/cosmetics-v2-art.test.js'],{cwd:ROOT,encoding:'utf8'});
assert.equal(r.status,0,r.stdout+r.stderr);
console.log(`${caught}/${cases.length+(process.argv.includes('--browser')?browserCases.length:0)} поломок пойманы; восстановленный пакет 7/7, без изменений`);
