# Сессия 2026-10-29 — исполнитель B (payments): покупки косметики за Stars

Запуск скриптом `tools/release-run.mjs`, ветка `release/run`, без человека. Реальных счетов, оплат и возвратов не было;
платёжный API — только заглушка в тестах. На сервер не ходил, ничего не выкатывал.

## Сделано

- Контракт и состояния — `docs/next-release/payment-design.md` (заказ, pre_checkout, выдача, права, возврат, сверка,
  журнал, совместимость и откат, резервная копия, решения B-1…B-8).
- Сервер: `bot/payments/` (config — выключатель и цены; store — таблицы `pay_*` без смены версии схемы; index — заказ,
  pre_checkout, выдача одной транзакцией, возврат, сверка, история, команды владельца; texts). Подключено в `app.js`
  (обновления Telegram, `/paysupport`, `/terms`, команды владельца), `hub.js` (`{t:'pay'}`, досылка состояния),
  `index.js` (`SALES_MODE`, `TG_TEST_ENV`, `PAY_SUPPORT`, `pre_checkout_query` в `allowed_updates`, сверка при запуске),
  `admin-bot.js` (те же команды). Коллекции: права из покупки + тестер (только при включённом режиме) + демо.
- Клиент: `miniapp/collections/pay.js` (логика), `purchase.js` (блок покупки, «Мои покупки», документы), правки
  витрины, карточки, «Получено/Куплено», строки «Настроек».
- Тесты: `bot/payments.test.js` (41), `bot/payments.client.test.js` (10), `tools/e2e-payments.mjs`, «на зубы»
  `tools/payments-teeth.mjs` (35 поломок). Обновлены места поломок в `tools/graphit-*-teeth.mjs` (код сдвинулся).

## Как проверено

[запуск 2026-10-29] `npm test` 1406/1406; `payments-teeth` 35/35 упали; `graphit-server-teeth` 9/9, `graphit-client-teeth`
12/12; e2e: payments, collections, collections-flow, collections-look, shop, look, nav — зелёные; `layout`, `kit`,
`contrast` — зелёные; снимки `preview/pay-*.png` просмотрены глазами (320 и 390 px).

## Не проверено

Тестовая среда Telegram, телефон, настоящее окно оплаты и события Telegram, старая версия на новой базе.

## Следующий шаг

C (`04-navigation.md`). Владелец: `owner-inputs.md` №4, №5, №15–18.
