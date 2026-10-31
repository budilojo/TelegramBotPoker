# Codex A — выполнен локально

**Статус: done.** Attempt `83f73a05-e4ee-43ac-81b9-7a012b0335ab`.
Исходный **1781699**, `redesign`, чистое дерево при старте. Итоговый коммит —
коммит, содержащий этот отчёт; точный hash передаётся контроллеру через Git,
исполнитель не делает push. macOS **26.6.2 (25G83), arm64**, Node **24.12.0**,
Chromium **153.0.8010.12**, Playwright **1.63.0**, TelegramStub, локальный HTTP/WS.

## Результат

Выполнено задание 02-audit, не только подготовлен план:

- Фото IMG_4367 просмотрено; источник старых рубашек/кольца/КРУПЬЕ воспроизведён
  как `nc-back-2`, `nc-frame-2`, `nc-title-1` из localStorage `cosmetics-look`.
  Причина — живые hooks сохранились после удаления магазина. Кэш/версия production
  остались гипотезами, их не выдаём за установленную причину.
- Удалено применение nc-* к живой игре/чату/глобальному сукну; базовая колода и
  зелёное сукно сохранены, Графит действует по серверному снимку. Архивный каталог,
  локальное сохранение и изолированный образец не удалены.
- Серверные покупки, источники прав, старые и неизвестные id не менялись.
  Файловая SQLite с синтетическими данными проверена сравнением всех строк после
  чтения/двух restart, schema=5, integrity_check=ok. Цены 75/50/100/175 сохранены.
- Созданы `../audit.md`, `../contracts.md`, `../item-plan.json`: все 54 предмета,
  6 наборов, 9 слотов, manifest/ресурсы, snapshot v1/v2, источники owner отдельно
  от purchase/admin, rollback и запрет новых цен. Каталог v2/семь игр/магазин —
  следующие этапы, их готовность не заявлена. Утверждённые 00-plan/01-design/02-audit
  не переписаны под меньший объём.
- MESSAGES и docs/brain обновлены, решение 197, отдельная сессия A.

Подробное доказательство и путь save → render — [аудит](../audit.md).

## Реальные проверки

| Команда | Итог | Среда |
|---|---|---|
| `SHOT_PREFIX=before node --disable-warning=ExperimentalWarning tools/e2e-look.mjs` на исходных ui/profile/poker | ожидаемый exit 1: **4 !== 0**, два старых изображения рубашек + frame + title; снимок до assert | локальный Chromium/TelegramStub, исходные файлы временно возвращены из 1781699, затем восстановлены |
| `node --disable-warning=ExperimentalWarning --test bot/cosmetics.retirement.test.js` | 3/3, exit 0 | Node, отдельная файловая SQLite в tmp, без Telegram API |
| `node tools/cosmetics-legacy-teeth.mjs --browser` | 7/7 возвратов старого пути пойманы; 4 дополнительно по браузерному assert; после восстановления 3/3 | Node + локальный Chromium/Stub |
| `node --disable-warning=ExperimentalWarning --test bot/cosmetics*.test.js bot/collections*.test.js bot/profile.test.js bot/payments*.test.js bot/admin.shop.test.js` | **204/204**, fail/cancelled/skipped/todo=0, exit 0 | Node/SQLite/TelegramStub, платежи только существующая заглушка |
| `node --disable-warning=ExperimentalWarning tools/e2e-look.mjs` | exit 0, 320×568 и 390×844: два игрока + зритель, исходный и полный локальный выбор, reload, неизменный localStorage, нет nc-* в сети, fallback, Графит и архивный образец | Chromium/TelegramStub, финально повторён после всех поломок |
| `SHOTS=1 node --disable-warning=ExperimentalWarning tools/e2e-collections-look.mjs` | exit 0, покер/дурак, все цвета, snapshot/reconnect, ошибка SVG, вся история приватности | Chromium/TelegramStub |
| `SHOTS=1 node --disable-warning=ExperimentalWarning tools/e2e-collections-flow.mjs` | exit 0, сквозной путь коллекций | Chromium/TelegramStub |
| `SHOTS=1 node --disable-warning=ExperimentalWarning tools/e2e-profile.mjs` | exit 0, профиль/аватары и сосед, 320/390 | Chromium/TelegramStub |
| `SHOTS=1 node --disable-warning=ExperimentalWarning tools/e2e-durak.mjs` | exit 0 | Chromium/TelegramStub |
| `SHOTS=1 node --disable-warning=ExperimentalWarning tools/e2e-reactions.mjs` | exit 0, обычные игровые реакции сохранены | Chromium/TelegramStub |
| `npm run kit` | exit 0 | Node |
| `npm run contrast` | exit 0, прежние документированные исключения | Node |
| `npm run layout` | exit 0 | Chromium/TelegramStub |
| `npm test` | **1580/1580**, fail/cancelled/skipped/todo=0, exit 0, **49,64 с** | Node/macOS, localhost разрешён; полный прогон перед коммитом |
| `git diff --check` | exit 0 | Git |

Дополнительно `node --input-type=module` с assert по item-plan.json: 60 уникальных
id, 54 item/6 bundle, по 9 предметов каждой серии, includes совпадает со списком,
все price=null — exit 0. Это сверка договора, не тест готовой интеграции.

Поломки выполняет сохранённый инструмент, возвращая по одному файлы из baseline:
ui, profile, poker, durak, reactions, cosmetics.css, cosmetics/apply. Он проверяет
exit 1 и нужный assert, а не принимает произвольный crash. Каждый файл восстановлен
через finally. У четырёх браузерных поломок дополнительно было AssertionError;
после них исправленный e2e повторён. Новые защиты не оставлены без проверки «на зубы».

Локальные логи: `/private/tmp/cosmetics-a-{baseline-final,teeth-final,look-final,profile,npm-test,kit,contrast,layout}.log`,
`/private/tmp/cosmetics-a-e2e-*.log`. Эти пути — диагностические файлы текущей машины,
не замена сохранённому отчёту/снимкам.

## Снимки, просмотренные глазами

В git сохранены собственные тестовые сцены:

- [До, 320×568](screens/before-320.png): красно-белая старая рубашка, кольцо и КРУПЬЕ.
- [После, 320×568](screens/after-320.png), [после, 390×844](screens/after-390.png):
  старого декора нет, базовые рубашки/лица/сукно и действия видны.
- [Графит, 320×568](screens/graphit-320.png), [Графит, 390×844](screens/graphit-390.png):
  серверный стол сохраняется при старом сохранении; центр и руки читаемы.
- [Нынешняя базовая рубашка крупно](screens/current-base-back.png): для точного
  сравнения с красно-белой эмблемой. В первом предположении A ошибочно назвал
  эмблему базовой; сравнение и окончательный тест это исправили.

Исходное фото владельца не копировалось в git. Все шесть собственных PNG открыты
инструментом просмотра; снимки игры сделаны после анимаций, не только по DOM.

## Красные промежуточные проверки и исправления стенда

Первый e2e в sandbox упёрся в `listen EPERM 127.0.0.1`; повтор с разрешённым
localhost уже дал ожидаемый regression assert. Это инфраструктурное ограничение
снято, не названо проверкой приложения. Первое сохранение было только с двумя
украшениями; окончательная фикстура включает также nc-back-2 и снова красная
на исходном коде. Исправленный e2e зелёный.

В новом SQLite-тесте сначала ошибся в API фикстуры (`moveOrder` принимает массив
from, таблица называется collection_demo_grant); исправлены вызов и имя таблицы,
ассерты не ослаблялись. Первый запуск инструмента поломок передал URL в chdir;
исправлен путь-строка, поломки затем реально выполнены дважды. Финальных красных
проверок и незаконченного локального кода нет.

## Границы и передача

Без субагентов/запускаторов агентов, SSH/production, .env/секретов, deploy,
реальных счетов/денег/возвратов, открытия продаж/рейтинга, push/PR/main.
`server/`, `public/`, `deploy/`, tools/*run.mjs и тест контроллера не менялись.
Предыдущая чужая работа сохранена; правок в дереве при старте не было.

Живой Telegram, iOS/Android, актуальная версия production и кэш конкретного
телефона **не проверены**. Телефонный шаг описан в ../audit.md; он не блокирует
выполненную локальную задачу A. Новый арт ещё должен сделать B и утвердить
владелец; это не одобрение всех новых коллекций. Список блокеров A пуст.
Далее контроллер проверяет точный коммит → B, затем C → D → E по очереди.
