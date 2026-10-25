#!/usr/bin/env bash
# Запуск агентов волны 3 (U, V, W, X, Y, Z) — только на Mac.
#
#   cd ~/TelegramBotPoker && git pull origin redesign && bash tools/wave3-launch.sh
#   bash tools/wave3-launch.sh Z V          # только выбранные буквы
#
# Для каждого агента: своя папка рядом с проектом (git worktree, ветка work-<буква>),
# новое окно Терминала, `npm install`, запуск агента и первое слово «Начинай».
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ "$(uname)" = "Darwin" ] || { echo "Скрипт только для Mac (открывает окна Терминала)."; exit 1; }

git fetch origin redesign

ALL="U:uroki V:trenirovka W:diapazony X:matematika Y:uroven Z:ekran"
WANT="${*:-U V W X Y Z}"

for pair in $ALL; do
  L="${pair%%:*}"
  A="${pair##*:}"
  case " $WANT " in *" $L "*) ;; *) continue ;; esac
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

echo "Готово: окна Терминала открыты для: $WANT."
