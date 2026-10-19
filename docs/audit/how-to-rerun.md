# Аудит: как прогнать всё заново

Всё — только локально: сервер поднимается на 127.0.0.1, Telegram — заглушка
(`bot/tg-stub.js`), токены поддельные. Наружу ничего не ходит.

## Одной командой

| Команда | Что делает | Сколько |
|---|---|---|
| `npm run audit` | все тесты аудита (`bot/audit.*.test.js`) + фаззер игр по 7 200 шагов на игру + фаззер приватности по 10 партий | ~30 с |
| `npm run audit:long` | то же с большими числами: 20 000 шагов подмены личности на игру, 500 000 раздач оценки рук, 3 млн бросков кубиков, 40 партий приватности в тестах; фаззер игр по 1 000 000 шагов на игру; 1 000 партий приватности на игру; нагрузка на сервер | ~1,5 ч на 10 ядрах (игры лучше гонять параллельно, см. ниже) |

Тесты аудита входят и в обычный `npm test`.

## По частям

```
# тесты аудита
node --test bot/audit.*.test.js

# фаззер игр: игра | all, всего шагов, первое зерно, шагов на стол
node --disable-warning=ExperimentalWarning tools/fuzz-games.mjs poker 1000000 1 400
# параллельно по играм (так шёл длинный прогон):
for g in poker durak colors chess checkers nardy battleship; do
  node --disable-warning=ExperimentalWarning tools/fuzz-games.mjs $g 1000000 1 400 > fuzz-$g.log &
done; wait

# повторить падение один в один (зерно и шаг печатаются при падении);
# FUZZ_DUMP=1 печатает стол перед упавшим шагом
FUZZ_DUMP=1 node --disable-warning=ExperimentalWarning tools/fuzz-games.mjs poker 368 2269 368

# фаззер приватности («невмешательство»): игра | all, партий, первое зерно
node --disable-warning=ExperimentalWarning tools/fuzz-privacy.mjs all 1000 1

# длинные варианты отдельных тестов
AUDIT_STEPS=20000  node --test bot/audit.identity.test.js   # подмена личности
AUDIT_EVAL=1000000 node --test bot/audit.eval.test.js       # оценка рук против эталона
AUDIT_ROLLS=3000000 node --test bot/audit.dice.test.js      # кубики и тасовки
AUDIT_SEEDS=40     node --test bot/audit.privacy.test.js    # приватность в тестах

# нагрузка на настоящий сервер
node --expose-gc --disable-warning=ExperimentalWarning tools/load-ws.mjs 400 10

# экраны: 83 кадра + поиск null/undefined/NaN/[object Object] и ошибок JS
npm run preview
```

## Что в каком файле

| Файл | Пункты чек-листа |
|---|---|
| `bot/audit.transport.test.js` | B (статика, методы, заголовки, кадры, B-01, B-02), I-01 |
| `bot/audit.identity.test.js` | A-4, A-7, A-8 |
| `bot/audit.privacy.test.js`, `tools/fuzz-privacy.mjs` | C, C-01 |
| `tools/fuzz-games.mjs` | D, E (перезапуск после каждого шага), F-3 (в видах) |
| `bot/audit.finish.test.js` | D-01 |
| `bot/audit.poker.test.js` | D-05 |
| `bot/audit.eval.test.js`, `bot/audit.dice.test.js` | D: оценка рук, честность случайности |
| `bot/audit.rating.test.js` | D-02…D-04 (замысел) |
| `bot/audit.engine.test.js` | E-01 |
| `bot/audit.store.test.js` | E-02 |
| `bot/audit.persist.test.js` | E-03 |
| `bot/audit.levels.test.js` | E-04 |
| `bot/audit.race.test.js` | E-05 |
| `bot/audit.html.test.js` | F-1 |
| `bot/audit.cast.test.js` | G-01, G-02, G-03 |
| `tools/preview.mjs` | F-3 на экранах |
| `tools/load-ws.mjs` | I, A-5 |
