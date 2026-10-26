#!/usr/bin/env bash
# Запуск Codex с промтом агента (вместо `claude --agent …`) — только на Mac.
#
#   cd ~/TelegramBotPoker && git pull origin redesign
#   bash tools/codex-launch.sh L docs/next-wave-5/agent-L-shop-interest.md
#
# Первый аргумент — буква агента (она даёт папку ../TelegramBotPoker-<буква> и ветку work-<буква>),
# второй — файл с заданием. Codex читает AGENTS.md сам; задание ему передаётся фразой.
# Как устроена команда `codex "…"` в вашей версии — `codex --help`; скрипт её не проверял.
set -euo pipefail

L="${1:?буква агента, например L}"
FILE="${2:?путь к промту, например docs/next-wave-5/agent-L-shop-interest.md}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ "$(uname)" = "Darwin" ] || { echo "Скрипт только для Mac (открывает окно Терминала)."; exit 1; }
command -v codex >/dev/null || { echo "Codex не найден в PATH. Установите его и проверьте: codex --help"; exit 1; }
[ -f "$FILE" ] || { echo "Нет файла $FILE"; exit 1; }

git fetch origin redesign
DIR="$ROOT/../TelegramBotPoker-$L"
if [ -d "$DIR" ]; then
  echo "· папка агента $L уже есть: $DIR — использую её (если там уже кто-то работает, остановитесь)"
elif git show-ref --verify --quiet "refs/heads/work-$L"; then
  git worktree add "$DIR" "work-$L"
else
  git worktree add -b "work-$L" "$DIR" origin/redesign
fi

PLAN="$(dirname "$FILE")/00-plan.md"
PROMPT="Ты — агент $L проекта «игровой хаб в Telegram Mini App». Пользователь проекта не программист: отвечай простым русским языком, сначала итог, потом детали, и прямо говори, что не смог проверить (живой Telegram, телефон). Работай в этой папке (ветка work-$L, проверь git branch --show-current), сначала git pull --rebase origin redesign. Прочитай целиком AGENTS.md, $PLAN, docs/next-wave/00-plan.md (общие правила и память проекта) и своё задание $FILE — выполни его. Работай только в своей зоне. Перед каждым коммитом запускай npm test целиком. Коммиты по-русски, понятным предложением. Пуш только так: git pull --rebase origin redesign && git push origin HEAD:redesign; никогда --force; pull request не создавай; на сервер ничего не выкатывай; платежи не подключай. Других агентов через ListAgents/SendMessage у тебя нет: если твоему заданию нужен файл другого агента, смотри его в git (git pull --rebase) и, если его там нет, напиши в финальном отчёте, что именно ждёшь. В конце обнови docs/brain/ (файл сессии, решения, status.md, tasks.md) и дай финальный отчёт: что сделано, что проверено и как, что не прошло, что осталось, что проверить на телефоне в живом Telegram."

# Фразу кладём в файл вне проекта и читаем оттуда: так кавычки и русские буквы не ломают команду.
PFILE="/tmp/codex-prompt-$L.txt"
printf '%s\n' "$PROMPT" > "$PFILE"
osascript -e "tell application \"Terminal\" to do script \"cd '$DIR' && git pull --rebase origin redesign && npm install && codex \\\"\$(cat $PFILE)\\\"\"" >/dev/null
echo "Окно Терминала открыто: агент $L (Codex)."
