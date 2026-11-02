import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contextBrief, currentSection, ROUTES } from './brain-context.mjs';
import { buildPrompt, STEPS } from './codex-release-run.mjs';
import { PROFILE } from './cosmetics-run.mjs';

test('контекст оставляет актуальное состояние, история остаётся доступна в исходном файле', () => {
  assert.equal(currentSection('# Статус\n\n2026-11-02 — сейчас\nпроверено\n\n2026-11-01 — раньше\nистория'), '# Статус\n\n2026-11-02 — сейчас\nпроверено\n');
  assert.doesNotMatch(currentSection('# Задачи\n\n## Ближайший шаг\nактуально\n\nНиже история\nдавно'), /давно/);
});

test('без Atlas маршрут работает, неизвестная область явно отклоняется', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'bot/collections'), { recursive: true });
  const output = contextBrief(dir, 'shop');
  assert.match(output, /bot\/collections/);
  assert.match(output, /Atlas не установлен/);
  assert.match(output, /Перед правкой прочитай исходный код/);
  assert.throws(() => contextBrief(dir, 'not-a-route'), /Неизвестный маршрут/);
});

test('каждый этап получает свою область, финальная проверка и полный тест сохраняются', () => {
  for (const [step, route] of [['multiplayer', 'games'], ['uxtext', 'ux'], ['perf', 'perf'], ['final', 'audit']]) {
    const prompt = buildPrompt(os.tmpdir(), STEPS.find((s) => s.id === step), 'id');
    assert.match(prompt, new RegExp(`Маршрут: ${route}`));
    assert.doesNotMatch(prompt, /весь пакет docs\/next-release\//);
    assert.match(prompt, /Перед каждым коммитом npm test целиком/);
  }
  const prompt = PROFILE.buildPrompt(os.tmpdir(), PROFILE.steps.find((s) => s.id === 'art'), 'id');
  assert.match(prompt, /Маршрут: art/);
  assert.match(prompt, /01-design.md/);
  assert.match(PROFILE.buildPrompt(os.tmpdir(), PROFILE.steps.at(-1), 'id'), /объём приёмки не сокращать/);
  assert.equal(Object.keys(ROUTES).length, 9);
});
