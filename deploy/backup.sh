#!/usr/bin/env bash
# Бэкап базы раз в сутки. В базе — столы, группы, цифры и рассылки; потерять
# её значит потерять всё, что бот знает о людях.
#
# Копия снимается командой sqlite3 `.backup`, а не `cp`: база живёт в режиме
# WAL, и обычное копирование файла посреди записи даёт битую копию.
#
# Ставится в крон скриптом install.sh. Проверить вручную:
#   sudo -u worldcard /opt/worldcard/deploy/backup.sh
set -euo pipefail

APP=/opt/worldcard
DB="$APP/data/bot.db"
OUT="$APP/backups"
KEEP=14 # дней

[ -f "$DB" ] || { echo "базы ещё нет: $DB"; exit 0; }
mkdir -p "$OUT"

STAMP=$(date +%Y-%m-%d)
FILE="$OUT/bot-$STAMP.db"
sqlite3 "$DB" ".backup '$FILE'"
gzip -f "$FILE"

# Старше двух недель — удалить: место на диске не бесконечное, а бэкап
# месячной давности всё равно бесполезен.
find "$OUT" -name 'bot-*.db.gz' -mtime +$KEEP -delete

echo "бэкап готов: $FILE.gz ($(du -h "$FILE.gz" | cut -f1))"
