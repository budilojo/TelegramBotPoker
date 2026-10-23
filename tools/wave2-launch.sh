#!/usr/bin/env bash
# Запуск агентов волны 2 (Q, R, S, T) одной командой — только на Mac.
#
#   cd ~/TelegramBotPoker && git pull origin redesign && bash tools/wave2-launch.sh
#
# Для каждого агента: своя папка рядом с проектом (git worktree, ветка work-<буква>),
# новое окно Терминала, `npm install`, запуск агента и первое слово «Начинай».
# Агент P уже работает в своей папке — его скрипт не трогает.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ "$(uname)" = "Darwin" ] || { echo "Скрипт только для Mac (открывает окна Терминала)."; exit 1; }

git fetch origin redesign

for pair in "Q:obshchenie" "R:emodzi" "S:navigaciya" "T:profil"; do
  L="${pair%%:*}"
  A="${pair##*:}"
  DIR="$ROOT/../TelegramBotPoker-$L"
  if [ -d "$DIR" ]; then
    echo "· папка агента $L уже есть: $DIR — использую её"
  elif git show-ref --verify --quiet "refs/heads/work-$L"; then
    git worktree add "$DIR" "work-$L"
  else
    git worktree add -b "work-$L" "$DIR" origin/redesign
  fi
  echo "· агент $L: открываю окно Терминала"
  osascript -e "tell application \"Terminal\" to do script \"cd '$DIR' && git pull --rebase origin redesign && npm install && claude --agent $A 'Начинай'\"" >/dev/null
done

echo "Готово: открыто четыре новых окна Терминала (Q, R, S, T). Старые окна этих агентов можно закрыть."
