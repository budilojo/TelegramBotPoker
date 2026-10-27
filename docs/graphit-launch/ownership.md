# Карта ответственности за файлы

Один файл — один владелец. Чужие файлы не править даже «по мелочи»: нужное изменение — раздел «Запросы к контракту» в отчёте.
Машиночитаемая версия — `agents.json` (поля `owns`, `stubs`); тест `tools/graphit-run.test.js` проверяет, что зоны не пересекаются.

| Владелец | Файлы и папки |
|---|---|
| **lead-contracts** (фаза 1, один раз) | `miniapp/collections/catalog.js`, `miniapp/collections/protocol.js`, `bot/collections.catalog.test.js`, `miniapp/settings-rows.js`, `miniapp/nav.js` (только подключение реестра строк «Настроек»), `miniapp/index.html` (ссылки на два новых CSS), раздел 12 в `contracts.md`. **Создаёт и передаёт** пустые заготовки (`stubs`): `miniapp/collections/settings-row.js`, `miniapp/homescreen-row.js`, `miniapp/collections.css`, `miniapp/collections-look.css` |
| **server** | `bot/collections/**`, `bot/collections.test.js`, `bot/collections.privacy.test.js`, `bot/collections.teeth.test.js`, `tools/graphit-server-teeth.mjs`, `bot/store.js`, `bot/hub.js`, `bot/app.js`, `bot/index.js`, `bot/room.js`, `bot/view.js`, `bot/games/poker/index.js`, `bot/games/durak/index.js`, `bot/games/durak/view.js`, `.env.example` |
| **assets** | `tools/build-graphit-art.mjs`, `tools/graphit-art-teeth.mjs`, `miniapp/collections/art/**`, `bot/collections.art.test.js` |
| **client** | `miniapp/collections/index.js`, `state.js`, `art.js`, `showcase.js`, `item.js`, `fitting.js`, `inventory.js`, `receive.js`, `settings-row.js` (после заготовки), `miniapp/collections.css` (после заготовки), `miniapp/net.js`, `miniapp/app.js`, `tools/e2e-collections.mjs`, `tools/graphit-client-teeth.mjs`, `bot/collections.client.test.js` |
| **screens** | `miniapp/games/poker.js`, `miniapp/games/durak.js`, `miniapp/ui.js`, `miniapp/profile.js`, `miniapp/poker.css`, `miniapp/durak.css`, `miniapp/collections-look.css` (после заготовки), `miniapp/collections/look-view.js`, `tools/e2e-collections-look.mjs`, `tools/graphit-screens-teeth.mjs`, `bot/collections.screens.test.js` |
| **homescreen** | `miniapp/homescreen.js`, `miniapp/homescreen-row.js` (после заготовки), `tools/e2e-homescreen.mjs`, `tools/graphit-icon-teeth.mjs`, `bot/homescreen.test.js`, `docs/homescreen.md` |
| **research** | `docs/research/stars-payout.md`, `docs/research/external-site.md` |
| **lead-integration** (фаза 2) | общие файлы: `MESSAGES.md`, `docs/redesign.md`, `docs/brain/**` (кроме решений исполнителей), `package.json`, `package-lock.json`, `AGENTS.md`, `bot/README.md`, `docs/collections-demo.md`, `docs/graphit-launch/reports/FINAL*`, `.gitignore`; правки чужих файлов — только чтобы разрешить конфликт слияния или мелкий дефект (1–3 строки) с записью в `FINAL.md` |
| **каждый** | свои `docs/graphit-launch/reports/<id>.md` и `<id>.status.json`; свои решения `docs/brain/decisions/NNN-*.md` в выделенном диапазоне (`agents.json`) |

**Не трогает никто:** `server/game.js`, `server/`, `public/`, `.env`, `deploy/`, `design/collections/` (материалы только читаются),
`bot/shop.js`, `miniapp/cosmetics/**`, `miniapp/shop*` (спящий набор «Ночной казино-клуб» и счётчик решения 106),
игровые модули шахмат, шашек, нард, морского боя, UNOQ.

**Почему общие файлы у одного человека:** без этого параллельные ветки конфликтуют в одних и тех же строках `MESSAGES.md`, `package.json`
и памяти проекта. Тексты, токены, строки e2e и память исполнители оформляют **фрагментами в отчёте**, `lead-integration` переносит.
Это осознанное отступление от «каждый агент сам обновляет `docs/brain/`»; итоговое обновление памяти (сессия, статус, задачи) делает он.
