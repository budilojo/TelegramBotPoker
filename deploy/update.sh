#!/usr/bin/env bash
# Обновить бота до свежей версии из GitHub.
#
#   sudo /opt/worldcard/deploy/update.sh
#
# Перед обновлением снимается бэкап базы: если новая версия чем-то не угодит,
# откатиться будет куда. Тесты гоняются на отдельной копии ДО того, как
# тронута рабочая папка, — сломанное на людей не выкатываем.
set -euo pipefail

# Этот скрипт лежит в том же репозитории, который сам же и обновляет. Bash
# читает файл по мере выполнения — по смещению в байтах, — а `git reset
# --hard` переписывает его на ходу. Если новая версия скрипта другой длины,
# дальше можно уехать в середину чужой строки и выполнить мусор. Поэтому
# первым делом копируем себя во временный файл и работаем уже оттуда.
if [ "${UPDATE_FROM_COPY:-}" != "1" ]; then
  COPY="$(mktemp /tmp/worldcard-update.XXXXXX.sh)"
  cat "$0" > "$COPY"
  UPDATE_FROM_COPY=1 exec bash "$COPY" "$@"
fi
trap 'rm -f "$0"' EXIT

APP=/opt/worldcard
USER=worldcard
BRANCH="${1:-claude/bold-carson-kjswyx}"

[ "$(id -u)" -eq 0 ] || { echo "запускать через sudo: sudo $0"; exit 1; }
cd "$APP"

# Бэкап обязателен: обновление может менять схему базы, и откатываться
# без копии некуда. Своего «базы ещё нет» скрипт бэкапа не считает ошибкой,
# так что падение здесь — это настоящее падение, и дальше идти нельзя.
if ! sudo -u "$USER" ./deploy/backup.sh; then
  echo "бэкап не снялся — обновление отменено. Разберитесь и запустите снова."
  exit 1
fi

echo "· забираю ветку $BRANCH"
sudo -u "$USER" git fetch origin "$BRANCH"

# Сначала тесты — на ОТДЕЛЬНОЙ копии новой версии (аудит H-02). Пока они не
# зелёные, рабочая папка не тронута: страницы получают прежний miniapp/, а
# движки — прежний engine-worker.js. Упали — обновление отменено, бот как был.
NEXT="$APP/.update-check"
sudo -u "$USER" git worktree remove --force "$NEXT" 2>/dev/null || rm -rf "$NEXT"
sudo -u "$USER" git worktree prune
sudo -u "$USER" git worktree add --detach "$NEXT" "origin/$BRANCH"
cleanup_next() { sudo -u "$USER" git -C "$APP" worktree remove --force "$NEXT" 2>/dev/null || rm -rf "$NEXT"; }
echo "· проверяю новую версию на отдельной копии: зависимости и тесты"
# --omit=dev: на сервере не нужен браузер для e2e и картинок
if ! (cd "$NEXT" && sudo -u "$USER" npm ci --omit=dev && sudo -u "$USER" npm test); then
  cleanup_next
  echo "тесты новой версии упали — обновление отменено, бот работает на прежней."
  exit 1
fi
cleanup_next

echo "· переключаю рабочую папку на новую версию"
sudo -u "$USER" git checkout "$BRANCH"
sudo -u "$USER" git reset --hard "origin/$BRANCH"
sudo -u "$USER" npm ci --omit=dev

# База и бэкапы — только самому боту (аудит H-01). Ставится каждый раз, так
# что сервер, поставленный до аудита, исправится сам при первом обновлении.
chmod 700 "$APP/data" "$APP/backups" 2>/dev/null || true

# Юнит systemd мог поменяться вместе с кодом — поставить новый.
if ! cmp -s "$APP/deploy/worldcard.service" /etc/systemd/system/worldcard.service; then
  echo "· обновляю юнит systemd"
  cp "$APP/deploy/worldcard.service" /etc/systemd/system/worldcard.service
  systemctl daemon-reload
fi

echo "· перезапускаю"
systemctl restart worldcard
sleep 3
if systemctl is-active --quiet worldcard; then
  echo "готово: бот работает"
else
  echo "бот не поднялся — смотрите: journalctl -u worldcard -n 50"
  exit 1
fi
