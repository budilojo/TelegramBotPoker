/** Local temporary mutations, restored in finally. No controller or application launcher. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const mutations = [
  ['sellable whitelist','bot/payments/config.js',"new Set(['graphit-cardback', 'graphit-table', 'graphit-profile', 'graphit-bundle'])","new Set(ITEMS.map((i) => i.id))",'null prices'],
  ['owner role','bot/collections/index.js','if (this.app.isAdmin(u))','if (true)','signed owner'],
  ['signed identity','bot/collections/index.js','String(user.id), op =','String(msg.userId ?? user.id), op =','poker: public stream'],
  ['unowned apply','bot/collections/index.js',"if (!this.owns(uid, it.id)) return fail('COL_NOT_OWNED');",'','poker: public stream'],
  ['item slot','bot/collections/index.js',"if (slotOf(it.id) !== msg.slot) return fail('COL_SLOT');",'','signed owner'],
  ['item color','bot/collections/index.js',"if (!isItemColor(it.id, msg.color)) return fail('COL_COLOR');",'','signed owner'],
  ['bundle full rights','bot/collections/index.js',"if (rows.some((r) => !this.owns(uid, r.item))) return fail('COL_NOT_OWNED');",'','partial bundle'],
  ['atomic SQLite','bot/store.js',"    this.db.exec('BEGIN IMMEDIATE');\n    try { apply(); this.db.exec('COMMIT'); }\n    catch (err) { this.db.exec('ROLLBACK'); throw err; }",'    apply();','partial bundle'],
  ['frozen snapshot','bot/collections/index.js','if (!room.look || room.look.dealNo !== dealNoOf(room)) this.freeze(room);','this.freeze(room);','poker: public stream'],
  ['party number','bot/collections/index.js',"(room.game === 'poker' ? room.handNo : room.gameNo)",'room.handNo','chess: public stream'],
  ['unknown row preservation','bot/collections/index.js',"if (SLOTS.includes(r.slot) && itemById(r.item)?.slot === r.slot && !owned.has(r.item))",'if (!owned.has(r.item))','source revocation'],
  ['public projection','bot/collections/look.js',"const out = { v: l.v,",'const out = { ...l, v: l.v,','poker: public stream'],
  ['old snapshot','bot/collections/index.js','if (!room.look || room.look.dealNo !== dealNoOf(room))','if (!room.look || room.look.v !== 2 || room.look.dealNo !== dealNoOf(room))','old snapshot v1'],
  ['explicit classic','bot/collections/index.js',"['frame', 'badge'].includes(msg.slot) ? [{ slot: msg.slot, item: BASE[msg.slot].id, color: 'classic' }] : [{ slot: msg.slot, clear: true }]","[{ slot: msg.slot, clear: true }]",'Graphit profile'],
  ['clear only requested slot','bot/store.js',"if (r.slot === 'profile' && !r.clear)","if (r.slot === 'profile')",'Graphit profile'],
  ['asset slot','miniapp/collections/look-view.js','const e = publicEntry(raw, slot, game);','const e = raw;','old snapshot v1'],
];
// Extra import only in the temporary price mutation, the on-disk original is restored byte-for-byte.
for (const [label,file,from,to,pattern] of mutations) {
  const original=fs.readFileSync(file,'utf8'); assert.ok(original.includes(from),label);
  try {
    let broken=original.replace(from,to);
    if(label==='sellable whitelist') broken=broken.replace('import { itemById,','import { ITEMS, itemById,');
    fs.writeFileSync(file,broken);
    const r=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--test',`--test-name-pattern=${pattern}`,'bot/cosmetics.v2.test.js'],{encoding:'utf8',env:{...process.env,DRAFT_GAMES:'1'}});
    const out=r.stdout+r.stderr;
    assert.equal(r.status,1,`${label}: expected red test\n${out}`);
    assert.match(out,/AssertionError|ERR_ASSERTION/,`${label}: must fail an assert, not crash\n${out}`);
    assert.doesNotMatch(out,/SyntaxError|ReferenceError|TypeError/,`${label}: wrong failure\n${out}`);
    console.log(`caught: ${label}`);
  } finally { fs.writeFileSync(file,original); }
}
const control=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--test','bot/cosmetics.v2.test.js'],{encoding:'utf8',env:{...process.env,DRAFT_GAMES:'1'}});
assert.equal(control.status,0,control.stdout+control.stderr);
console.log(`${mutations.length}/${mutations.length} caught; restored suite green`);
