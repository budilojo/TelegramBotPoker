# 2026-10-25 · W · матрица 13×13 и направления «Префлоп», «Тренажёр диапазонов», «Чтение диапазонов»

## Сделано
- Логика: `miniapp/train/ranges/{hands,grid,data,tasks,equity169}.js`; сборка эквити `tools/build-range-data.mjs`.
- Виджет `miniapp/train/widgets/range-grid.js` + `miniapp/ranges.css` (edit/readonly/diff/heat/flag, рисование, лупа, «Крупно», клавиатура).
- Упражнения: `content/preflop.js` (10), `ranges.js` (8), `readrange.js` (6); на каждом уровне каждого направления ≥ 12 разных заданий.
- Тесты `bot/train.ranges.test.js` (19), e2e `tools/e2e-ranges.mjs` (320/390 px, мышь и касание).

## Проверено
Полный `npm test`; `npm run kit`, `npm run contrast`; e2e матрицы в Chromium; «на зубы» — сломанный подсчёт комбо, блокеры и diff роняют тесты. Эквити сверено с независимым оценщиком (`bot/eval.js`).

## Не проверено
Телефон и живой Telegram (рисование пальцем, лупа, точность попадания в 20 px, жесты Telegram). Экран Тренировки V с моими видами `range`/`slider`/`table` — не смотрел. `npm run e2e` целиком и `npm run layout` — не прогонялись. Блок W в `topics.js` не нужен: использованы существующие темы.

## Недочёты и следующий шаг
Порядок рук грубоват (AKo ниже 99; UTG без 22–55). Виджет `table` (ставка) — у X/V. Предложение: подключить виджеты в экран V, посмотреть `npm run preview` матрицу глазами на телефоне.
