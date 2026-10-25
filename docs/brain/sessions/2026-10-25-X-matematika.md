# 2026-10-25 · агент X · математика и постфлоп (не закончено: упёрся в лимит)

Сделано: `miniapp/train/poker-math.js` (свой оценщик, ауты, эквити, pot odds, EV, MDF; сверка с `bot/eval.js` на 60 000 рук, 6 поломок формул пойманы), `bot/train.math.test.js`; виджеты `miniapp/train/widgets/{cards,board,odds-bar,bet-slider,table-seat,pot,card-el,dom}.js`, `miniapp/train/math.css`; 50 упражнений в `content/{outs,potodds,postflop,hands,advanced}.js` (по 2 на уровень, генератор с seed; каждое проходит `check(solution)` в моём прогоне).
Не сделано: тесты упражнений (`make` детерминирован, числа в `why`), e2e `tools/e2e-train-math.mjs`, `npm run layout/kit/contrast/preview`, решения 067–070, строки в status/tasks, docs/poker-training.md, MESSAGES.md. На телефоне и в браузере виджеты НЕ проверялись.
Раздачи — 2–3 решения (флоп-тёрн-ривер), не 4–6: префлоп-эталонов нет (контракт 9).
Дубль: был второй запуск агента X (x-60), договорились — веду я.
