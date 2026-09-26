#!/usr/bin/env bash
# Обновить бота до свежей версии из GitHub.
#
#   sudo /opt/worldcard/deploy/update.sh
#
# Перед обновлением снимается бэкап базы: если новая версия чем-то не угодит,
# откатиться будет куда. Тесты гоняются до перезапуска — сломанное на людей
# не выкатываем.
set -euo pipefail

APP=/opt/worldcard
USER=worldcard
BRANCH="${1:-claude/bold-carson-kjswyx}"

[ "$(id -u)" -eq 0 ] || { echo "запускать через sudo: sudo $0"; exit 1; }
cd "$APP"

sudo -u "$USER" ./deploy/backup.sh || true

echo "· забираю ветку $BRANCH"
sudo -u "$USER" git fetch origin "$BRANCH"
sudo -u "$USER" git checkout "$BRANCH"
sudo -u "$USER" git reset --hard "origin/$BRANCH"

echo "· ставлю зависимости"
sudo -u "$USER" npm ci

echo "· прогоняю тесты"
sudo -u "$USER" npm test

echo "· перезапускаю"
systemctl restart worldcard
sleep 3
if systemctl is-active --quiet worldcard; then
  echo "готово: бот работает"
else
  echo "бот не поднялся — смотрите: journalctl -u worldcard -n 50"
  exit 1
fi
