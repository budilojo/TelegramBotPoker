#!/usr/bin/env bash
# Запуск агентов волны 5 (L, M) — только на Mac.
#
#   cd ~/TelegramBotPoker && git pull origin redesign && bash tools/wave5-launch.sh
#   bash tools/wave5-launch.sh L            # только выбранные буквы
#
# Для каждого агента: своя папка рядом с проектом (git worktree, ветка work-<буква>),
# новое окно Терминала, `npm install`, запуск агента и первое слово «Начинай».
# Если агент этой буквы уже запущен — второе окно НЕ открывается (в волне 3 дубли
# затирали файлы друг друга).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ "$(uname)" = "Darwin" ] || { echo "Скрипт только для Mac (открывает окна Терминала)."; exit 1; }

git fetch origin redesign

ALL="L:vitrina M:vid-stola"
WANT="${*:-L M}"

for pair in $ALL; do
  L="${pair%%:*}"
  A="${pair##*:}"
  case " $WANT " in *" $L "*) ;; *) continue ;; esac
  if pgrep -f "claude --agent $A" >/dev/null 2>&1; then
    echo "· агент $L ($A) уже запущен — второе окно не открываю. Закройте старое окно, если нужно начать заново."
    continue
  fi
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

echo "Готово: обработаны буквы: $WANT."
