# Два расхождения в `server/game.js`

Движок я не трогал. Ниже — то, что нашлось при написании бота: что ожидал,
что получил, почему считаю багом и как воспроизвести. Решение о правке за вами.

Запустить обе проверки:

```bash
node tools/engine-findings.mjs
```

Ни одна из находок **не создаёт и не теряет фишки** — инвариант сохранения
держится в обоих случаях, поэтому существующие 60 тестов их и не ловят.

---

## A. Блайнд считается «уже сходившим», и короткий олл-ин запирает рейз

**Ожидал.** Игрок, который в этом круге торговли ещё не действовал
добровольно, всегда сохраняет право на повышение — даже против олл-ина
меньше полного рейза. Постановка блайнда — вынужденная ставка, а не действие
(правило TDA; так же это описано и в вашем README: «те, кто **уже сходил**,
могут только уравнять или сбросить»).

**Получил.** Малый и большой блайнды запираются наравне с теми, кто реально
сходил.

```
p1 (SB): lastAction = "SB", acted = false, raiseLocked = true, canRaise = false
p2 (BB): lastAction = "BB", acted = false, raiseLocked = true, canRaise = false
```

**Причина.** `applyAction` определяет «уже сходил» как `other.lastAction != null`:

```js
// server/game.js:278
if (!fullRaise) other.raiseLocked = other.raiseLocked || other.lastAction != null;
```

Но `postBlind` выставляет `p.lastAction = label` (`'SB'` / `'BB'`), поэтому
блайнды неотличимы от добровольного действия. Нужное поле в движке уже есть и
заполнено верно — `p.acted`, которое у блайндов `false`.

**Минимальный репродьюсер.**

```js
test('a player who has only posted a blind may still raise', () => {
  const room = mkRoom([70, 5000, 5000], { sb: 25, bb: 50 });
  startHand(room);                       // p0 button, p1 SB, p2 BB
  applyAction(room, 'p0', 'allin');      // 70 всего: прибавка 20 < полного рейза 50

  const p1 = room.players.find((p) => p.id === 'p1');
  assert.equal(p1.acted, false, 'SB ещё не ходил добровольно');
  assert.equal(legalActions(room, 'p1').canRaise, true); // ФАКТИЧЕСКИ false
});
```

**Возможная правка** (одна строка, но `acted` затирается на строку выше —
его надо прочитать до сброса):

```js
for (const other of room.players) {
  if (other.id === p.id || !other.inHand || other.folded || other.allIn) continue;
  const hadActed = other.acted;          // ← прочитать до сброса
  other.acted = false;
  if (!fullRaise) other.raiseLocked = other.raiseLocked || hadActed;
  else other.raiseLocked = false;
}
```

**Масштаб.** Узкий и в безопасную сторону: движок запрещает лишнее, а не
разрешает. Затрагивает только SB/BB, ещё не ходивших, против короткого
олл-ина.

---

## B. `allin` проходит мимо проверки `raiseLocked` — сервер её не держит

**Ожидал.** Запертый игрок может только уравнять или сбросить. Олл-ин на
сумму больше текущей ставки — это повышение, и оно должно отклоняться так же,
как `raise`. README проекта: «Сервер — единственный источник истины. Клиент
**никогда не меняет фишки**».

**Получил.** `raise` отклоняется, `allin` — принимается, и торговля
открывается заново.

```
p3 raiseLocked = true, canRaise = false
applyAction(room,'p3','raise',500) -> { error: 'CANNOT_RAISE' }   ✔
applyAction(room,'p3','allin')     -> { ok: true }                ✘
currentBet: 90 -> 5000
```

**Причина.** В `applyAction` проверки `canBet`/`canRaise` лежат в ветке
`else`, куда `allin` не заходит:

```js
// server/game.js:240
if (action === 'allin') {
  total = legal.maxTotal;               // ← никаких проверок
} else {
  if (action === 'bet'   && !legal.canBet)   return { error: 'CANNOT_BET' };
  if (action === 'raise' && !legal.canRaise) return { error: 'CANNOT_RAISE' };
  …
}
```

В вебе дыра не проявляется: `public/js/screens/table.js:491` прячет кнопку
ALL-IN за `canAggress = legal.canBet || legal.canRaise`. То есть правило
сегодня держится **только видимостью кнопки** — ровно та «дырявая схема»,
которой в проекте нет нигде больше.

**Минимальный репродьюсер.** См. `tools/engine-findings.mjs`, находка B.

**Возможная правка** — не запрещать олл-ин целиком (запертый игрок обязан
иметь возможность уйти ва-банк, когда стека не хватает даже на колл), а
запретить только агрессивный:

```js
if (action === 'allin') {
  total = legal.maxTotal;
  if (total > h.currentBet && !(legal.canBet || legal.canRaise))
    return { error: 'CANNOT_RAISE' };
}
```

**Что сделано в боте.** Пока решение не принято, бот закрывает это у себя:
`bot/room.js` → `act()` отклоняет агрессивный `allin` при `raiseLocked` до
вызова `applyAction`, и кнопка ALL-IN гейтится так же, как в вебе. Тесты —
`bot/app.test.js` → «a hidden ALL-IN is refused by the server, not just left
off the keyboard» и «a typed /allin cannot re-open betting that a short
all-in closed». Если правка приземлится в движке, guard в боте станет
избыточным, но безвредным.

С тех пор как бот принимает текстовые команды, находка стала важнее: у
набранного `/allin` нет кнопки, которую можно спрятать, и без серверной
проверки правило не держалось бы вообще ничем.
