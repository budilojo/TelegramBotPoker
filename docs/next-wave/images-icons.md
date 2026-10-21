# Иконки игр — запросы для генератора картинок

Для владельца. Это **готовые запросы** (по-английски — генераторы картинок на нём
работают лучше) для Midjourney, Ideogram, DALL·E, Flux и подобных. Каждый запрос =
«общий стиль» + «что нарисовано». **Всегда вставляйте обе части.** Если генератор
даёт перекос в цвете — приписывайте в конец «flat design, no gradients, no glow».

## Что получить и куда положить

- По **4 варианта** на каждую игру → выбрать лучший → сохранить как
  `assets-incoming/icons/<имя>.png` (имена ниже), **квадрат 1024×1024**, PNG,
  фон сплошной (во весь квадрат, без скруглений — углы скруглит приложение).
- Главный рисунок — в центре, занимает ~60% (по краям запас: приложение
  обрежет углы). Без текста и надписей.
- Проверка: уменьшите картинку до 96 px. Если игру всё ещё видно с первого
  взгляда — подходит. Если нет — упростить: меньше деталей, крупнее форма.
- Потом скажите Claude Code: «агент E — подключить иконки» (файл
  `docs/next-wave/agent-E-assets-integration.md`).

## Общий стиль (вставлять в начало каждого запроса)

```
Flat vector app icon, square 1:1, solid deep teal-navy background color #13212A
filling the whole canvas, one bold central emblem about 60% of the canvas, clean
geometric shapes, soft rounded corners on shapes, strictly flat colors: off-white
#F2F4F3, signal green #137A43, warm red #C93632 (only where the object is naturally
red), slate #2A3D47 and mid-grey #8FA3AD for secondary shapes. No gradients, no
glow, no drop shadows, no glossy highlights, no 3D, no texture, no text, no
letters or numbers unless they are part of a playing card or die. Minimal detail,
instantly readable at 96 px. Consistent family of game icons, same line weight and
corner radius. Centered composition with generous padding.
```

## Игры

**`poker.png` — Покер**
```
[общий стиль] + Two playing cards fanned out, an Ace of spades (off-white card, big
black-slate spade) and an Ace of hearts (off-white card, big red heart), with a
small stack of three poker chips (green, red, off-white) in front at the bottom
right.
```

**`durak.png` — Дурак**
```
[общий стиль] + A fan of three playing cards (six of diamonds, king of clubs, ace of
spades) with a small flat jester's cap with two bells resting on the top corner of
the fan, one card turned sideways underneath like a trump card.
```

**`unoq.png` — UNOQ (цветные карты)**
```
[общий стиль] + A fan of four bold colorful game cards (red, blue, yellow, green,
flat saturated colors) with large rounded numbers 5, 3, 7, 2 on them and a white
rounded oval in the middle of each card; no logos, no words, no resemblance to any
existing brand card game.
```

**`chess.png` — Шахматы**
```
[общий стиль] + A flat chess knight silhouette in off-white in the center, behind it a
slate crown of a king piece partially visible, a corner fragment of a chessboard
(alternating off-white and slate squares) at the bottom.
```

**`checkers.png` — Шашки**
```
[общий стиль] + A stack of two checkers discs: a solid off-white disc with a ring
engraving and, on top of it, a dark slate disc with a small flat crown (a king),
standing on a diagonal fragment of a checkered board.
```

**`nardy.png` — Нарды (длинные)**
```
[общий стиль] + A fragment of a long-backgammon board: alternating tall triangles in
two tones (off-white and slate) pointing toward the center, two round checkers
(one off-white, one dark) sitting on the triangles, and two flat white dice
showing 5 and 3 in front.
```

**`battleship.png` — Морской бой**
```
[общий стиль] + A top-down radar-like grid corner of 6×6 squares in thin slate lines,
a flat off-white ship silhouette (long rounded hull) lying on the grid, a red X hit
marker on one square and a small off-white dot (miss) on another.
```

## Дополнительно (если хотите единый комплект)

**`school.png` — Обучение / Школа покера**
```
[общий стиль] + A flat graduation cap (mortarboard) in off-white with a green tassel
resting on top of a large slate spade symbol.
```

**`bots.png` — Игры с ботами**
```
[общий стиль] + A friendly flat robot head (rounded square, two round eyes, a small
antenna with a green tip) holding one playing card in front of its face-plate.
```

**`app.png` — Аватарка бота (профиль в Telegram, круг)**
```
[общий стиль] + Four small emblems arranged in a 2×2 pattern inside a circle: a spade,
a heart, a chess knight, a die showing 5 — one big cheerful composition for a
circular avatar, centered, with a wide safe margin.
```

## Если не нравится

Скажите агенту (или напишите генератору) конкретно: «проще», «крупнее фигура»,
«больше контраста», «убрать мелкие детали» — и повторите. **Не принимайте картинки с
градиентами, свечением и блеском** — у проекта строго плоский стиль
(`docs/redesign.md`).
