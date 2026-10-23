# Аватарки игроков — запросы для генератора картинок

Для владельца. Готовые запросы (по-английски — генераторы работают лучше) для
Midjourney, Ideogram, DALL·E, Flux и подобных. **12 разных персонажей в одном стиле и
с одинаковой композицией**, чтобы набор выглядел одной семьёй, а каждый аватар
узнавался в маленьком круге (40 px).

## Что получить и куда положить

- Файлы **`av01.png` … `av12.png`** (имена из таблицы ниже — по ним приложение их находит),
  **квадрат 512×512, PNG, сплошной фон во весь квадрат** (углы скруглит приложение:
  в игре аватар виден **кругом**, поэтому лицо должно целиком помещаться в круг,
  вписанный в квадрат, с запасом).
- Класть в папку проекта: `assets-incoming/avatars/` (в git она не попадает). Потом
  скажите агенту: «подключить аватарки» — он перенесёт их в приложение и проверит вес
  (цель — до 20 КБ каждая; если картинка тяжелее, агент сожмёт).
- Пока файлов нет, приложение показывает аккуратные временные значки.

## Единая композиция (держите одинаковой у всех)

- Вид: **голова и плечи, анфас**, персонаж по центру; лицо занимает ~55% высоты
  квадрата; глаза примерно на 42% от верха; плечи обрезаны нижним краем.
- **Безопасные отступы:** всё важное (глаза, нос, рот, уши, рога) внутри круга диаметром
  **70%** от стороны квадрата, по центру. По углам — только фон.
- **Фон:** один сплошной цвет, **у каждого персонажа свой** (таблица). Без узоров,
  рамок, теней, текста и букв.
- Стиль: **плоская векторная иллюстрация**, крупные простые формы, 3–4 плоских цвета,
  глаза — крупные и чёткие, мелких деталей нет; без градиентов, свечения, глянца, 3D,
  объёмных теней и толстых контуров. **Золотого цвета нет.** Должно читаться в
  40 px: уменьшите картинку — персонажа ещё можно узнать по силуэту и главному цвету.
- Персонажи **оригинальные, не похожи на известных**; характер — дружелюбный,
  с лёгким юмором, взрослой компании подходит (не детский рисунок).

## Порядок работы

1. Сначала сгенерируйте **лист из 12 персонажей на одной картинке** (запрос «0») —
   чтобы закрепить стиль; выберите вариант, где стиль нравится.
2. Дальше **каждого персонажа отдельно, с этим листом как образцом** (Midjourney:
   `--sref <ссылка на лист>`; в Ideogram / DALL·E / Flux — загрузить лист и написать
   «same style as the reference image»). Размер 1:1.
3. Проверка: уменьшите до 40 px. Если два персонажа похожи — перегенерируйте
   того, у которого слабее силуэт.

## Общий стиль (вставлять в начало каждого запроса)

```
Flat vector avatar illustration, square 1:1, head-and-shoulders portrait facing
the viewer, character perfectly centered, face about 55% of the canvas height, eyes
at 42% from the top, everything important inside a centered circle covering 70% of
the canvas width, solid single-color background filling the whole square, large
simple shapes, 3-4 flat colors only, big clear eyes, no tiny details, no gradients,
no glow, no gloss, no 3D, no drop shadows, no thick outlines, no text, no letters,
no gold color. Friendly, witty, adult-friendly, original character, readable at 40
pixels. Same style, same proportions and same framing as the other avatars in the set.
```

## Запрос «0» — лист стиля (сначала)

```
[общий стиль] + A character sheet of 12 avatars in a 4x3 grid, each avatar a
different animal in a rounded-square tile with its own solid background color: fox,
owl, bear, cat, wolf, raccoon, frog, penguin, rabbit, tiger, panda, octopus.
```

## 12 персонажей

Каждый запрос — «[общий стиль] + …» и лист как образец.

| Файл | Кто | Фон | Что нарисовано |
|---|---|---|---|
| `av01.png` | Лиса | `#2F5D7C` синий | a sly fox with a half-smile, orange-and-white fur, pointed ears fully inside the circle |
| `av02.png` | Сова | `#6A4C7D` сливовый | a wise owl with huge round eyes and a tiny beak, warm brown and cream feathers, small ear tufts |
| `av03.png` | Медведь | `#8A5A44` терракотовый | a friendly brown bear with round ears and a light muzzle, calm smile |
| `av04.png` | Кот | `#3E7C6E` бирюзовый | a smug grey cat with big green eyes, white muzzle, small pointed ears |
| `av05.png` | Волк | `#3A4A5C` стальной | a confident grey wolf with a slight smirk, light chest fur, ears up |
| `av06.png` | Енот | `#5C6B4A` оливковый | a cheeky raccoon with the dark eye mask, ringed look, pale fur, mischievous grin |
| `av07.png` | Лягушка | `#C0623F` кирпичный | a cheerful green frog with wide round eyes on top of the head and a big smile |
| `av08.png` | Пингвин | `#4B6A9B` васильковый | a dapper penguin with a white belly, small orange beak, calm round eyes |
| `av09.png` | Кролик | `#9C5B7B` пыльная роза | a bright-eyed rabbit with tall ears reaching the top of the safe circle, light fur, pink inner ears |
| `av10.png` | Тигр | `#B0713B` охристый (не золотой) | a bold tiger with dark stripes on orange fur, white muzzle, confident look |
| `av11.png` | Панда | `#3C6B5A` хвойный | a gentle panda with black ears and eye patches, white face, soft smile |
| `av12.png` | Осьминог | `#7B4F9E` фиолетовый | a playful octopus with a round head and big eyes, little tentacles at the bottom edge, teal-purple body |

## Если не нравится

Скажите генератору конкретно: «проще», «глаза крупнее», «меньше деталей», «без контура»,
«в том же стиле, что образец». **Не принимайте** картинки с градиентами, блеском,
золотом и мелкими деталями: проект строго плоский (`docs/redesign.md`), мелкое
в круге 40 px превращается в кашу.
