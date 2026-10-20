# Проект

Метки достоверности — в [00-index.md](00-index.md). Правила — в [AGENTS.md](../../AGENTS.md).

## Цель

Игровой хаб для компании друзей в Telegram Mini App. В группе `/game` → в
приложении выбираешь игру → в группе появляется карточка лобби → друзья
присоединяются → партия идёт в приложении → итоги приходят в группу. Фишки и
очки виртуальные, денег нет. Можно играть и с ботами из лички, без группы.
[код: AGENTS.md; bot/README.md]

Рядом лежит **отдельный старый продукт** «Chip Table» (веб-приложение для
покера настоящими картами): `public/`, `server/`. `npm start` и `npm run dev`
запускают его, а не Mini App. [код: AGENTS.md; package.json]

## Игры (7)

Покер, дурак, UNOQ, шахматы, шашки (русские), нарды (длинные), морской бой.
Модуль каждой — `bot/games/<игра>/`, экран — `miniapp/games/<игра>.js`.
[код: ls bot/games, miniapp/games; запуск 2026-10-20: `npm test` включает
правила и хаб всех семи]

- Против бота есть у покера (+ «Школа покера»), дурака, UNOQ, шахмат, шашек,
  нард. **У морского боя бота пока нет** — в модуле нет `bot.js`.
  [код: ls bot/games/*; docs/next-deploy-prompt.md]
- Игры на двоих (шахматы, шашки, нарды, морской бой): `maxPlayers: 2`, часы,
  несколько лобби у хоста. [код: docs/duels.md]
- Рейтинг считается, но для игроков закрыт кнопкой «скоро» (`RATING_SOON`).
  [код: AGENTS.md]

## Стек

- Node.js ≥ 22.5, ES-модули, **без сборки**. [код: package.json `engines`, `type: module`]
- Telegram: grammY ^1.46. Сервер Mini App — свой, на `node:http` + `ws` ^8
  (`bot/server.js`). [код: package.json; bot/server.js]
- База: SQLite через встроенный `node:sqlite`, схема v5, версия — строка
  `schema` в таблице `meta`. Файл — `data/bot.db`. [код: bot/store.js; AGENTS.md]
- Клиент: чистый JS без фреймворка, `miniapp/`. Токены дизайна —
  `miniapp/tokens.css`. [код: AGENTS.md; ls miniapp]
- `express` и `qrcode` нужны старому веб-приложению (`server/index.js`);
  Mini App их не использует. [код: grep по `bot/` и `server/`]
- Тесты: `node --test`; браузерные проверки — Playwright (devDependency).
  [код: package.json]
- Сервер: systemd-юнит `worldcard` (пользователь `worldcard`, `MemoryMax=600M`),
  Caddy как обратный прокси на `127.0.0.1:8080`, скрипты `deploy/`.
  [код: deploy/worldcard.service, deploy/Caddyfile]

## Структура папок

| Папка | Что |
|---|---|
| `bot/` | бот и сервер Mini App: `app.js` (ядро), `hub.js` (WebSocket-хаб), `store.js` (база), `rating.js`, `outbox.js`, `broadcast.js`, `games/<игра>/` и `games/index.js` (реестр) |
| `miniapp/` | клиент: `app.js`, `hub.js`, `solo.js`, `school.js`, `admin.js`, `games/<игра>.js`, `games/index.js` (реестр клиента), стили |
| `server/`, `public/` | старое веб-приложение «Chip Table»; `server/game.js` — **общий движок ставок, не трогать** |
| `tools/` | e2e (Playwright), `preview`, фаззеры (`fuzz-*.mjs`), проверки (`layout`, `kit`, `contrast`), генераторы картинок |
| `deploy/` | `install.sh`, `update.sh`, `backup.sh`, юнит systemd, Caddyfile |
| `docs/` | документы; `docs/audit/` — отчёт аудита; `docs/brain/` — эта память |
| `data/`, `backups/` | база и копии (в git не попадают) |

[код: ls; .gitignore; AGENTS.md]

## Как запускается

- Локально, одной командой: `npm run go` — поднимает туннель cloudflared,
  вписывает адрес в `.env`, проверяет, что стол виден снаружи, запускает бота.
  Адрес туннеля меняется при каждом запуске — его надо вписать у @BotFather.
  [код: bot/README.md]
- Бот отдельно: `npm run bot`. Переменные окружения, которые читает код
  (имена, значения не смотрел): `BOT_TOKEN`, `ADMIN_BOT_TOKEN`, `ADMINS`,
  `WEBAPP_URL`, `MINIAPP`, `DB_PATH`, `PORT`, `BIND_HOST`, `HOST_URL`,
  `BOT_DELAY`, `TZ`. Что каждая значит — см. `bot/README.md`; полностью
  **не проверено**. [код: grep process.env]
- Боевой сервер: ставится `deploy/install.sh`, обновляется
  `deploy/update.sh <ветка>`, сервер ездит по ветке `claude/bold-carson-kjswyx`.
  [код: AGENTS.md; deploy/*]

## Основные модули ядра

- `bot/app.js` — команды, карточки в группе, часы (`syncClocks`), рейтинг,
  обслуживание, партии с ботами (`createSolo`, `botAct`).
- `bot/hub.js` — WebSocket-сессии, проверка `initData`, хаб группы, «Игры с ботами».
- Ядро **не знает правил игр**: игра объявляет свои команды, раздачу, форму
  партии с ботами сама; ядро берёт это из реестра. [код: AGENTS.md; docs/game-hub.md]
- Приватность: каждому игроку уходит только его `view(room, viewerId)`.
  [код: AGENTS.md; тесты `bot/audit.privacy.test.js`, `tools/fuzz-privacy.mjs`]

## Известные расхождения в документах

- `bot/README.md` описывает четыре игры (покер, дурак, UNOQ, шахматы) —
  устарел. [код: прочитано 2026-10-20]
- В `AGENTS.md` «Что это» перечислено шесть игр (нет морского боя), числа
  тестов («около 860») устарели — сейчас 994. [запуск 2026-10-20]
- Для морского боя нет `docs/battleship.md` (есть только план
  `docs/plan-battleship.md`). [код: ls docs]
