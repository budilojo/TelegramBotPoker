# Набор «Ночной казино-клуб» — запросы для генератора картинок

Для владельца. Запросы по-английски (генераторы работают лучше): Midjourney, Ideogram, DALL·E, Flux. **Все вещи в
одном стиле — одна «семья»**: ночной казино-клуб, тёмный бархат, неон (малиновый и бирюзовый), латунные и золотые
акценты, красное и чёрное рулетки. Здесь допустимы градиенты, свечение и золото (решение 096) — но без текста на
картинках (текст приложение пишет само) и без чужих брендов, логотипов и узнаваемых персонажей.

## Что получить и куда положить

Папка проекта: **`assets-incoming/night-casino/`** (в git не попадает). Потом скажите агенту L или M: «подключить
косметику» — он перенесёт файлы в приложение, проверит размеры и вес.

| Файл | Что | Размер, формат | Вес (после сжатия) |
|---|---|---|---|
| `back-1.png` | рубашка карт «Чёрный бархат» | **200×280**, PNG, непрозрачная, углы закруглит приложение | до 30 КБ |
| `back-2.png` | рубашка карт «Рулетка» | 200×280, PNG | до 30 КБ |
| `felt-1.png` | текстура сукна «Бордовый бархат» | **512×512 бесшовная** (тайл), PNG | до 60 КБ |
| `frame-1.png` | рамка «Неоновая вывеска» | **512×512, прозрачная середина** (кольцо), PNG | до 40 КБ |
| `frame-2.png` | рамка «Венок из фишек» | 512×512, прозрачная середина, PNG | до 40 КБ |
| `react-1.png` | реакция «Джекпот» | **256×256**, прозрачный фон, PNG | до 20 КБ |
| `react-2.png` | реакция «Покер-фейс» | 256×256, прозрачный | до 20 КБ |
| `react-3.png` | реакция «Тильт» | 256×256, прозрачный | до 20 КБ |
| `fx-chip.png` | фишка для «дождя» | 128×128, прозрачный | до 12 КБ |
| `fx-star.png` | неоновая звезда для «дождя» | 128×128, прозрачный | до 12 КБ |

Звание «Крупье» — только текст, картинки не нужно. Если генератор отдаёт больше размеров — это нормально, агент
уменьшит.

## Сначала — лист стиля (запрос «0»)

Сгенерируйте **один лист со всеми вещами**, выберите вариант, где стиль нравится, дальше делайте каждую вещь отдельно
с этим листом как образцом (Midjourney: `--sref`; Ideogram/DALL·E/Flux: загрузить лист и «same style as the
reference image»).

```
[общий стиль] + A concept sheet of a casino-club cosmetic set on a dark background: two playing-card backs
(black velvet with a thin neon magenta border and tiny spade/heart/club/diamond pattern; roulette wheel in red
and black), a deep burgundy velvet texture swatch, two circular avatar frames (neon sign tubes in magenta and
teal; ring of poker chips), three round emoji faces (jackpot triple sevens, poker face in dark sunglasses,
tilt with steam), a poker chip and a neon star. Consistent style across all items.
```

## Общий стиль (вставлять в начало каждого запроса)

```
Night casino club cosmetic asset, luxurious dark velvet, neon magenta and teal accents, brass and gold details,
red and black roulette colors, clean illustrated look with soft glow and subtle gradients, rich but readable,
high contrast, centered composition, no text, no letters, no logos, no brand marks, no real people.
```

## Запросы по вещам

**`back-1` — рубашка «Чёрный бархат»**
```
[общий стиль] + Playing card back design, portrait ratio 5:7, black velvet background, thin glowing neon magenta
border inset from the edge, symmetrical center emblem made of four small card suits around a diamond, subtle
repeating suit pattern in dark grey, flat front view, no text. Card corners square (will be rounded later).
```

**`back-2` — рубашка «Рулетка»**
```
[общий стиль] + Playing card back design, portrait ratio 5:7, a roulette wheel seen from above as the central
motif in red and black with brass ring, small neon teal glow around it, dark green-black velvet around,
symmetrical, no numbers, no text.
```

**`felt-1` — сукно «Бордовый бархат»** (бесшовное)
```
[общий стиль] + Seamless tileable texture, square 1:1, deep burgundy casino velvet felt, very subtle fabric grain,
very low contrast, evenly lit, no vignette, no objects, no pattern that breaks when repeated, edge to edge.
```

**`frame-1` — рамка «Неоновая вывеска»**
```
[общий стиль] + Circular avatar frame, ring only, the center is fully transparent, neon tube ring in magenta with
a thinner teal inner ring, soft glow, small bracket clamps at four points, ring thickness about 12% of the canvas
width, transparent background, square 1:1, the ring touches the canvas edge by 4%.
```

**`frame-2` — рамка «Венок из фишек»**
```
[общий стиль] + Circular avatar frame, ring only, the center is fully transparent, a ring of overlapping poker
chips (red, black, teal, white edge stripes) seen from above, ring thickness about 14% of the canvas width,
transparent background, square 1:1.
```

**`react-1` — «Джекпот»**
```
[общий стиль] + Round emoji-style icon on a transparent background: a casino slot machine display showing three
glowing red sevens with neon sparks around, bold simple shapes, readable at 40 pixels, square 1:1.
```

**`react-2` — «Покер-фейс»**
```
[общий стиль] + Round emoji-style icon on a transparent background: a calm yellow face with dark sunglasses and
a flat mouth, a single playing card tucked in the corner, bold simple shapes, readable at 40 pixels, square 1:1.
```

**`react-3` — «Тильт»**
```
[общий стиль] + Round emoji-style icon on a transparent background: an angry red-faced emoji with steam coming from
the ears, one crumpled playing card, bold simple shapes, readable at 40 pixels, square 1:1.
```

**`fx-chip` и `fx-star` (для эффекта «Дождь из фишек»)**
```
[общий стиль] + Single poker chip seen slightly from above, red with white edge stripes and a thin brass rim, centered,
transparent background, square 1:1.
```
```
[общий стиль] + Single neon five-pointed star in magenta with teal inner glow, centered, transparent background,
square 1:1.
```

## Проверка

- Уменьшите каждую реакцию и рамку до **40 px** — читаются? Если нет, упростите (меньше деталей).
- Рубашка — вся важная часть внутри, края пустые (приложение скруглит углы).
- Сукно — положите картинку рядом с собой 2×2 и проверьте, что швов не видно.
