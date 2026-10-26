/**
 * Проверка «на зубы» для вида стола: по очереди ломает защиту и убеждается, что tools/e2e-look.mjs (или тест
 * look.js) падает. Исходники возвращаются в любом случае. Запуск: node tools/look-teeth.mjs
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const CASES = [
  ['рамка у всех, а не только у вас', 'miniapp/profile.js', 'return player?.isMe ? frameOn(av) : av;', 'return frameOn(av);', 'e2e'],
  ['звание у соседей (рамка/звание не по isMe) — звание в руке игнорирует вид', 'miniapp/games/poker.js', "info.append(titleEl());", "info.append(h('div.cos-title', 'Крупье'));", 'e2e'],
  ['эффект игнорирует «Не показывать эффекты»', 'miniapp/cosmetics/apply.js', '|| fxOff() || document.hidden) return false;', '|| document.hidden) return false;', 'e2e'],
  // защита двойная (winFx и spawn в ui.js): ломаем обе, иначе вторая прикрывает первую
  ['эффект игнорирует prefers-reduced-motion', [['miniapp/cosmetics/apply.js', 'if (!it || REDUCED ||', 'if (!it ||'], ['miniapp/ui.js', 'if (REDUCED || !$fx) return null;', 'if (!$fx) return null;']], null, null, 'e2e'],
  ['слой эффектов ловит нажатия', 'miniapp/style.css', '#fx { position: fixed; inset: 0; pointer-events: none;', '#fx { position: fixed; inset: 0; pointer-events: auto;', 'e2e'],
  ['реакция набора уходит на сервер', 'miniapp/reactions.js', 'if (itemById(id)) return tryReaction(id);', 'if (false) return tryReaction(id);', 'e2e'],
  ['рубашка не применяется', 'miniapp/cosmetics/art.js', 'return artSrc(getLook().cardback);', 'return null;', 'e2e'],
  ['сукно не применяется', 'miniapp/cosmetics/apply.js', "root.dataset.cosFelt = it.id;", "root.dataset.cosFeltX = it.id;", 'e2e'],
  ['look.js принимает любой id', 'miniapp/cosmetics/look.js', 'if (it && it.kind === kind) out[slot] = it.id;', 'if (raw[slot]) out[slot] = raw[slot];', 'unit'],
  ['look.js падает без localStorage', 'miniapp/cosmetics/look.js', "try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* приватный режим: до перезагрузки */ }", 'localStorage.setItem(KEY, JSON.stringify(cur));', 'unit'],
];

let bad = 0;
for (const [what, file, from, to, kind] of CASES) {
  const patches = Array.isArray(file) ? file : [[file, from, to]];
  const saved = patches.map(([f]) => [f, fs.readFileSync(f, 'utf8')]);
  if (patches.some(([f, a], i) => !saved[i][1].includes(a))) { console.log(`✗ ${what}: не нашёл место`); bad++; continue; }
  for (const [i, [f, a, b]] of patches.entries()) fs.writeFileSync(f, saved[i][1].replace(a, b));
  try {
    const cmd = kind === 'unit'
      ? ['node', ['--test', '--disable-warning=ExperimentalWarning', 'bot/cosmetics.look.test.js']]
      : ['node', ['--disable-warning=ExperimentalWarning', 'tools/e2e-look.mjs']];
    const r = spawnSync(cmd[0], cmd[1], { encoding: 'utf8', timeout: 240_000, env: { ...process.env, E2E_PORT: '8199' } });
    if (r.status === 0) { console.log(`✗ ${what}: ТЕСТ НЕ УПАЛ`); bad++; } else console.log(`✓ ${what}: тест упал`);
  } finally {
    for (const [f, t] of saved) fs.writeFileSync(f, t);
  }
}
console.log(bad ? `не поймано: ${bad}` : 'все поломки пойманы');
process.exit(bad ? 1 : 0);
