#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, parseArgs, run } from './codex-release-run.mjs';
import { contextBrief } from './brain-context.mjs';

export const PROFILE = {
  stateDir: '.release-run/cosmetics-v2',
  reports: 'docs/cosmetics-v2/reports',
  materials: ['docs/cosmetics-v2/00-plan.md', 'docs/cosmetics-v2/01-design.md'],
  protected: ['tools/cosmetics-run.mjs', 'tools/codex-release-run.test.js'],
  steps: [
    { id: 'audit', letter: 'A', scope: 'Источник старой косметики, совместимость и контракт', task: 'docs/cosmetics-v2/02-audit.md' },
    { id: 'art', letter: 'B', scope: 'Шесть коллекций и каталог графики', task: 'docs/cosmetics-v2/03-art.md' },
    { id: 'integration', letter: 'C', scope: 'Права, слоты и публичное оформление семи игр', task: 'docs/cosmetics-v2/04-integration.md' },
    { id: 'shop', letter: 'D', scope: 'Магазин в нижней панели, примерка и Мои вещи', task: 'docs/cosmetics-v2/05-shop.md' },
    { id: 'verify', letter: 'E', scope: 'Независимая итоговая проверка', task: 'docs/cosmetics-v2/06-verify.md' },
  ],
  buildPrompt(root, step, attemptId) {
    const route = { audit: 'shop', art: 'art', integration: 'games', shop: 'shop', verify: 'audit' }[step.id] || 'audit';
    return `Ты отдельный исполнитель Codex ${step.letter}: ${step.scope}.
Рабочая копия ${root}, ветка redesign.
${contextBrief(root, route)}
Прочитай docs/brain/00-index.md и последнюю сессию по правилам маршрута; целиком docs/cosmetics-v2/00-plan.md, 01-design.md и ${step.task}. Из docs/cosmetics-v2/reports/ сначала статусы предыдущих этапов, полные отчёты по зависимостям/неопределённостям. Для E всё задание независимой приёмки обязательно; карту использовать для навигации по всем областям, объём приёмки не сокращать.
Реализуй своё задание целиком. Следующий агент начнёт после тебя; общие файлы принадлежат только текущему этапу. Не запускай субагентов или другие запускаторы. Не путай подготовку пакета с выполнением: сейчас нужно реализовать задание.
Сохраняй чужую работу. Сервер/SSH, deploy, реальные деньги, счета, возвраты и открытие продаж/рейтинга запрещены. Не читай секреты, не меняй server/, public/, deploy/, .env и tools/*run.mjs или тест контроллера. Цены Графита 75/50/100/175 сохраняются, новые товары без утверждённых цен не продаются. Видимость оформления другим игрокам не означает выдачу прав всем. Поддержка в боте уже согласована. Утверждение арта Графита относится только к прежним SVG.
При повторной попытке изучи git log/diff и продолжи сохранённое, без reset/clean/stash. Перед каждым коммитом полный npm test; коммит по-русски. Не делай push: контроллер сам проверит точный коммит и отправит только redesign обычным push. main и серверную ветку не менять.
Отчёт: docs/cosmetics-v2/reports/${step.id}.md и .status.json с содержимым
{"id":"${step.id}","attemptId":"${attemptId}","status":"done|partial|blocked","summary":"результат по-русски","tests":[{"command":"...","result":"...","environment":"..."}],"blockers":[{"scope":"external|owner|code","reason":"..."}]}.
Запиши реальные команды, результаты, версию, снимки и ограничения. partial только при завершённой локальной работе и внешних/владельческих препятствиях. Локальная недоделка или красная проверка — blocked, не скрывай её как external. Новую защиту проверь временной поломкой, затем восстанови. Обнови docs/brain/ и сессию. Сохрани отчёты и правки коммитом; дерево чистое. Работа агента не считается проверкой живого Telegram/телефонов.
Не завершай этап одним планом вместо реализации. Если удаляешь старый визуальный слой, докажи сохранность покупок, источников прав и старых идентификаторов. Не редактируй утверждённый дизайн-план под меньший объём ради зелёного статуса.`;
  },
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) console.log('node tools/cosmetics-run.mjs [--status|--check|--dry-run]\nA → B → C → D → E. Повтор продолжает пакет косметики; сервер не обновляется.');
    else process.exitCode = await run(ROOT, opts, { profile: PROFILE });
  } catch (e) { console.error(`Остановка: ${e.message}`); process.exitCode = 1; }
}
