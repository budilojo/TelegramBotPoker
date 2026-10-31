/** Каждая поломка временная; исходные файлы возвращаются в finally, без git reset. */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const cases = [
 ['dialog', 'miniapp/ui.js', "role: 'dialog'", "role: 'region'", 'modal', null, /getByRole\('dialog'\)/],
 ['tab', 'miniapp/ui.js', "if (e.key !== 'Tab') return;", "if (true) return;", 'modal', null, /Tab не уходит/],
 ['focus-return', 'miniapp/ui.js', "if (sheetOpener?.isConnected) sheetOpener.focus({ preventScroll: true });", '', 'modal', null, /фокус вернулся/],
 ['inert', 'miniapp/ui.js', '$app.inert = collections || !!shell;', '$app.inert = false;', 'modal', null, /фон диалога/],
 ['label', 'miniapp/hub.js', "'aria-label': label,", '', 'modal', null, /доступное имя/],
 ['profile-draft', 'miniapp/profile.js', 'st.nick = nickIn.value;', '', 'profile', null, /несохранённый ник/],
 ['profile-error', 'miniapp/profile.js', "st.error = msg.error.text || 'Не получилось сохранить.';\n    st.justSaved = false;", "st.error = msg.error.text || 'Не получилось сохранить.';", 'profile', null, /после отказа/],
 ['avatar-keyboard', 'miniapp/profile.js', 'const next = e.key', 'return; const next = e.key', 'profile', null, /аватар выбирается/],
 ['back-shown', 'miniapp/app.js', "(s && nav.activeTab(s) !== 'games')", 'false', 'back', null, /Назад доступен/],
 ['back-nav', 'miniapp/app.js', 'if (nav.back()) return;', '', 'back', null, /gc-pager/],
 ['back-collections', 'miniapp/app.js', 'if (collections.isOpen()) return collections.back();', '', 'back', null, /data-route=showcase/],
 ['back-sheet', 'miniapp/app.js', 'if (currentSheet()) return closeSheet(true);', '', 'back', null, /sheet/],
 ['back-exercise', 'miniapp/train/screens.js', 'if (button) button.click();', 'if (button) closeRoute();', 'back', null, /Выйти из задания/],
 ['collections-focus', 'miniapp/collections/index.js', 'restoreFocus(root.scroll, focus);', '', 'copy', null, /коллекции сохраняют фокус/],
 ['reduced', 'miniapp/catalog.js', "smooth && !REDUCED ? 'smooth'", "smooth ? 'smooth'", 'reduced', null, /не анимирует/],
 ['colors-layout', 'miniapp/colors.css', "body[data-screen='colors'] .sheet .field {\n  flex-direction: column;\n  align-items: stretch;\n  gap: var(--k-s8);\n}", '', 'settings', 'colors', /по вертикали/],
];
for (const game of ['poker','durak','chess','checkers','nardy','battleship']) {
 const file=`miniapp/games/${game}.js`;
 const src=fs.readFileSync(file,'utf8');
 const old=game==='poker' ? 'if (!send(patch)) return;' : src.match(/if \(!send\(\{ t: 'settings'[^\n]+\}\)\) return;/)?.[0];
 assert.ok(old,game);
 const broken=game==='poker' ? 'send(patch);' : old.replace('if (!','').replace(')) return;',');');
 cases.push([`offline-${game}`,file,old,broken,'settings',game,/offline: форма не закрывается/]);
}
let passed=0;
for (const [id,file,from,to,test,game,expected] of cases) {
 const src=fs.readFileSync(file,'utf8'); assert.equal(src.split(from).length,2,`${id}: поломка должна быть однозначной`);
 try {
  fs.writeFileSync(file,src.replace(from,to));
  const run=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','tools/e2e-uxtext.mjs'],{encoding:'utf8',timeout:90000,env:{...process.env,E2E_PORT:'8270',UX_CASE:test,UX_GAME:game||'',SHOTS:''}});
  fs.mkdirSync('/tmp/uxtext-logs',{recursive:true});fs.writeFileSync(`/tmp/uxtext-logs/teeth-${id}.log`,(run.stdout||'')+(run.stderr||''));
  assert.equal(run.status,1,`${id}: нужен красный тест, получено ${run.status}`);
  assert.match((run.stdout||'')+(run.stderr||''),expected,`${id}: падение должно быть нужным утверждением`);
  console.log(`✓ ${++passed}/${cases.length}: ${id}`);
 } finally {fs.writeFileSync(file,src);}
}
console.log(`uxtext: ${passed}/${cases.length} поломок пойманы, файлы восстановлены`);
