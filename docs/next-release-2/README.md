# Второй пакет релиза — как запустить

Четыре агента по очереди: **F** шахматы (итог после мата) → **G** поддержка через бота → **H** магазин в админке (выдать/забрать, цены, возвраты) → **I** независимая проверка.
План и решения — `00-plan.md`; задания — `01-chess.md`, `02-support.md`, `03-admin-shop.md`, `04-check.md`.

## Команда (Mac, папка проекта, ветка `redesign`, чистое дерево)

```
cd ~/TelegramBotPoker && git pull origin redesign && node tools/release-run.mjs --pack next-release-2 --continue-partial
```

Проверка без запуска агентов: добавьте `--dry-run`. Состояние: `--status`. Продолжить после остановки (лимит, сбой) — та же команда.
Работает как первый пакет (`docs/next-release/README.md`): отдельная рабочая копия `../TelegramBotPoker-release2` на ветке `release2/run`, после каждого шага `npm test`,
при зелёном — обычный push в `redesign` без `--force`. Выкатки, счетов и платежей нет. Модели: F, G — `sonnet`; H, I — `opus` (`--model` перекрывает).
Итог — отчёты в `reports/` и обновлённый `docs/next-release/release-readiness.md`.
