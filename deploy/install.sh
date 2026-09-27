#!/usr/bin/env bash
# Установка бота на чистый сервер с Ubuntu 24.04. Один прогон — и есть всё:
# Node 22, сам бот, автозапуск, HTTPS с автопродлением, файрвол и бэкапы.
#
#   sudo bash install.sh worldcard.ru
#
# Первым аргументом — ваш домен (тот, что уже смотрит A-записью на этот
# сервер). Токен бота скрипт НЕ спрашивает и нигде не печатает: его вы впишете
# сами, в файл .env, последним шагом — он не должен попасть ни в историю
# команд, ни в логи.
#
# Запускать можно повторно: всё, что уже сделано, пропускается.
set -euo pipefail

DOMAIN="${1:-}"
REPO="${REPO:-git@github.com:budilojo/TelegramBotPoker.git}"
BRANCH="${BRANCH:-claude/bold-carson-kjswyx}"
APP=/opt/worldcard
USER=worldcard

say() { echo -e "\n\033[1m· $*\033[0m"; }
die() { echo -e "\n\033[31m$*\033[0m" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запускать от root: sudo bash install.sh ваш-домен.ру"
[ -n "$DOMAIN" ] || die "Нужен домен: sudo bash install.sh ваш-домен.ру"
grep -qi ubuntu /etc/os-release || echo "внимание: скрипт писался под Ubuntu 24.04"

say "Обновляю систему"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git sqlite3 ufw debian-keyring debian-archive-keyring apt-transport-https

# На сервере с 1 ГБ памяти установка зависимостей и тесты упираются в потолок
# и падают без объяснений. Двух гигабайт подкачки хватает, чтобы этого не
# случалось; игре она не нужна — нужна сборке.
MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')
DISK_GB=$(df -BG --output=size / | tail -1 | tr -dc '0-9')
if [ "${MEM_MB:-0}" -lt 1500 ] && [ "${SWAP_MB:-0}" -lt 512 ]; then
  # На диске 10 ГБ два гигабайта подкачки — это пятая часть места. Гигабайта
  # хватает: подкачка нужна сборке, а не игре.
  SWAP_GB=2
  [ "${DISK_GB:-20}" -lt 15 ] && SWAP_GB=1
  say "Памяти ${MEM_MB} МБ — добавляю ${SWAP_GB} ГБ подкачки"
  fallocate -l ${SWAP_GB}G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_GB * 1024)) status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Ставлю Node 22 (в нём встроенная SQLite, которой пользуется бот)"
if ! node -v 2>/dev/null | grep -qE '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

say "Завожу отдельного пользователя $USER — бот не должен ходить под root"
id -u "$USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/$USER --shell /bin/bash "$USER"
mkdir -p "$APP"
chown "$USER:$USER" "$APP"

say "Ключ для доступа к приватному репозиторию"
KEY=/home/$USER/.ssh/id_ed25519
if [ ! -f "$KEY" ]; then
  sudo -u "$USER" mkdir -p /home/$USER/.ssh
  sudo -u "$USER" ssh-keygen -t ed25519 -N '' -f "$KEY" -C "worldcard-server"
  sudo -u "$USER" ssh-keyscan -t ed25519 github.com >> /home/$USER/.ssh/known_hosts 2>/dev/null
fi
if ! sudo -u "$USER" git ls-remote "$REPO" >/dev/null 2>&1; then
  echo
  echo "=============================================================="
  echo " Скопируйте этот ключ в GitHub:"
  echo "   репозиторий → Settings → Deploy keys → Add deploy key"
  echo "   (галочку «Allow write access» НЕ ставьте — серверу хватит чтения)"
  echo
  cat "$KEY.pub"
  echo "=============================================================="
  echo " Добавили — запустите этот же скрипт ещё раз."
  exit 0
fi

say "Забираю код, ветка $BRANCH"
if [ -d "$APP/.git" ]; then
  sudo -u "$USER" git -C "$APP" fetch origin "$BRANCH"
  sudo -u "$USER" git -C "$APP" checkout "$BRANCH"
  sudo -u "$USER" git -C "$APP" reset --hard "origin/$BRANCH"
else
  sudo -u "$USER" git clone --branch "$BRANCH" "$REPO" "$APP"
fi
cd "$APP"
sudo -u "$USER" npm ci
sudo -u "$USER" mkdir -p "$APP/data" "$APP/backups"

say "Файл .env"
if [ ! -f "$APP/.env" ]; then
  sudo -u "$USER" tee "$APP/.env" >/dev/null <<ENV
# Токен от @BotFather. Впишите сюда — и никому не показывайте.
BOT_TOKEN=

# Публичный адрес мини-приложения. Он же должен стоять у @BotFather.
WEBAPP_URL=https://$DOMAIN

# Короткое имя мини-приложения из @BotFather → /newapp
MINIAPP=

# Кто видит пульт: Telegram-id через запятую (узнать — у @userinfobot).
ADMINS=

# Токен второго, админского бота (необязательно).
ADMIN_BOT_TOKEN=

PORT=8080
DB_PATH=$APP/data/bot.db
TZ=Europe/Moscow
ENV
  chmod 600 "$APP/.env"
  chown "$USER:$USER" "$APP/.env"
fi

# Токен спрашиваем здесь, а не просим вписать руками: набранное в командной
# строке остаётся в истории, а редактор на сервере — это лишний шанс всё
# испортить. `read -s` не печатает ввод на экран и в историю не попадает.
if [ -t 0 ] && ! grep -q '^BOT_TOKEN=.\+' "$APP/.env"; then
  echo
  echo "Токен бота от @BotFather. Вставьте и нажмите Enter."
  echo "На экране он НЕ появится — так и задумано. Пропустить — просто Enter."
  printf '  токен: '
  read -rs TOKEN_IN
  echo
  if [ -n "$TOKEN_IN" ]; then
    sudo -u "$USER" sed -i "s|^BOT_TOKEN=.*|BOT_TOKEN=$TOKEN_IN|" "$APP/.env"
    echo "  записал токен бота №$(echo "$TOKEN_IN" | cut -d: -f1)"
  fi
  unset TOKEN_IN

  printf '  ваш Telegram-id (узнать у @userinfobot), пропустить — Enter: '
  read -r ADMIN_IN
  [ -n "$ADMIN_IN" ] && sudo -u "$USER" sed -i "s|^ADMINS=.*|ADMINS=$ADMIN_IN|" "$APP/.env"

  # Короткое имя приложения из @BotFather → /newapp. Без него кнопка в группе
  # ведёт в личку с ботом, и это лишний тап для каждого игрока.
  printf '  короткое имя мини-приложения (@BotFather → /myapps), пропустить — Enter: '
  read -r MINIAPP_IN
  [ -n "$MINIAPP_IN" ] && sudo -u "$USER" sed -i "s|^MINIAPP=.*|MINIAPP=$MINIAPP_IN|" "$APP/.env"

  printf '  токен админ-бота (необязательно), пропустить — Enter: '
  read -rs ADMIN_TOKEN_IN
  echo
  [ -n "$ADMIN_TOKEN_IN" ] && sudo -u "$USER" sed -i "s|^ADMIN_BOT_TOKEN=.*|ADMIN_BOT_TOKEN=$ADMIN_TOKEN_IN|" "$APP/.env"
  unset ADMIN_TOKEN_IN
fi

say "Автозапуск (systemd)"
install -m 644 "$APP/deploy/worldcard.service" /etc/systemd/system/worldcard.service
systemctl daemon-reload
systemctl enable worldcard >/dev/null

say "HTTPS (Caddy сам получает и продлевает сертификат)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
sed "s/ДОМЕН/$DOMAIN/" "$APP/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl restart caddy

say "Файрвол: наружу открыты только SSH и сайт"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | head -8

# Логи systemd по умолчанию растут, пока не займут 10% диска. На диске 10 ГБ
# это гигабайт логов про то, как хорошо всё работало. Двухсот мегабайт хватает
# на несколько недель — ровно на «посмотреть, что случилось позавчера».
say "Ограничиваю журнал 200 МБ"
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/worldcard.conf <<'JRN'
[Journal]
SystemMaxUse=200M
MaxRetentionSec=3week
JRN
systemctl restart systemd-journald

say "Бэкап базы раз в сутки, в 4 утра"
cat > /etc/cron.d/worldcard-backup <<CRON
# Бэкап базы бота. Хранится две недели, дальше удаляется само.
0 4 * * * $USER $APP/deploy/backup.sh >> /var/log/worldcard-backup.log 2>&1
CRON
chmod 644 /etc/cron.d/worldcard-backup

if grep -q '^BOT_TOKEN=.\+' "$APP/.env"; then
  say "Запускаю бота"
  systemctl restart worldcard
  sleep 3
  systemctl is-active --quiet worldcard && echo "бот работает" || echo "бот не поднялся — journalctl -u worldcard -n 30"
fi

cat <<DONE

==============================================================
 Готово. Что осталось:

 1) Если токен не вводили — впишите и запустите:
        sudo -u $USER nano $APP/.env
        sudo systemctl start worldcard

 2) У @BotFather поставьте адрес мини-приложения:
        /myapps → ваше приложение → Edit Web App URL → https://$DOMAIN

 Проверить, что сайт жив:   curl -I https://$DOMAIN
 Логи бота:                 journalctl -u worldcard -f
 Обновиться до новой версии: sudo $APP/deploy/update.sh
==============================================================
DONE
