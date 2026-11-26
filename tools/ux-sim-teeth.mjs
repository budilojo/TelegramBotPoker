/**
 * «На зубы» для UX-симуляции: ломаем жест в КОПИИ miniapp (код продукта не
 * трогаем) — соответствующий сценарий обязан покраснеть, а на целой копии
 * быть зелёным.
 *
 *   node tools/ux-sim-teeth.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib/ux-sim.mjs';

const CASES = [
  { what: 'второй тап в Дураке перестал ходить', file: 'games/durak.js', from: "if (act.do === 'attack') return play({ t: 'attack', card: c });", to: '', sim: 'cards', only: 'дурак: атака — tap2' },
  { what: 'второй тап в защите перестал крыть единственную цель', file: 'durak-tap.js', from: "return { do: 'defend', target: targets[0] };", to: "return { do: 'pick' };", sim: 'cards', only: 'дурак: защита (одна цель) — tap2' },
  { what: 'при двух целях второй тап кроет наугад', file: 'durak-tap.js', from: 'if (targets.length > 1 || transfers)', to: 'if (transfers)', sim: 'cards', only: 'дурак: защита (две цели) — tap2' },
  { what: 'тап по карте стола кроет не ту', file: 'games/durak.js', from: "return play({ t: 'defend', card: picked, target: i });", to: "return play({ t: 'defend', card: picked, target: coverTargets(L, picked)[0] });", sim: 'cards', only: 'дурак: защита (две цели) — тап по второй' },
  { what: 'козырь, годный на перевод, кроет сам', file: 'durak-tap.js', from: 'if (targets.length > 1 || transfers)', to: 'if (targets.length > 1)', sim: 'cards', only: 'дурак: перевод — козырь' },
  { what: 'отбой перетаскиванием отключён', file: 'games/durak.js', from: 'if (L?.defend?.[c]?.length) bindDefendDrag(btn, img, c);', to: '', sim: 'cards', only: 'дурак: защита (одна цель) — drag' },
  { what: 'в шахматах пропало перетаскивание', file: 'games/chess.js', from: 'function dragStart(e, board) {', to: 'function dragStart(e, board) { return;', sim: 'boards', only: 'шахматы: ход — перетаскивание' },
  { what: '«Сдаться» без подтверждения', file: 'games/chess.js', from: 'disabled: !s.canResign, onclick: confirmResign }', to: "disabled: !s.canResign, onclick: () => send({ t: 'resign' }) }", sim: 'boards', only: 'шахматы: «Сдаться»' },
];

const run = (c, miniapp) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', `tools/ux-sim-${c.sim}.mjs`, `--only=${c.only}`],
  { cwd: ROOT, env: { ...process.env, UX_SIM_MINIAPP: miniapp }, encoding: 'utf8', timeout: 240_000 });

for (const c of CASES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-sim-teeth-'));
  try {
    const copy = path.join(dir, 'miniapp');
    fs.cpSync(path.join(ROOT, 'miniapp'), copy, { recursive: true });
    const whole = run(c, copy);
    assert.equal(whole.status, 0, `${c.what}: на целой копии должно быть зелено\n${whole.stdout}${whole.stderr}`);
    const file = path.join(copy, c.file);
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(src.includes(c.from), `${c.what}: место для поломки не найдено в ${c.file}`);
    fs.writeFileSync(file, src.replace(c.from, c.to));
    const broken = run(c, copy);
    assert.equal(broken.status, 1, `${c.what}: симуляция НЕ заметила поломку\n${broken.stdout}${broken.stderr}`);
    assert.match(broken.stdout, /✗/, `${c.what}: красным должен быть сценарий, а не запуск`);
    console.log(`✓ ${c.what}: целая копия зелёная, сломанная красная`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`все зубы на месте: ${CASES.length}`);
