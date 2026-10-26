# 068. Виджеты X: ответ — значение, правка на месте

- **Дата:** 2026-10-25
- **Кто решил:** агент (X, волна 3)
- **Статус:** принято

## Что решили

Виджеты cards, slider (odds-bar), bet (bet-slider), table (table-seat) получают {setup,value,onChange,result} и меняют DOM на месте, без перестройки.

## Почему

Контракт V и требование не вызывать «прыжков» экрана.

## Где это в проекте

miniapp/train/widgets/, miniapp/train/math.css, ANSWER_WIDGETS в screens.js
