# Смайлики «Фишка» — запросы для генератора картинок

Для владельца. Готовые запросы (по-английски) для Midjourney, Ideogram, DALL·E,
Flux и подобных. Нужен **набор из 16 оригинальных смайликов** с одним
талисманом, чтобы они выглядели одной семьёй и не были похожи на чужие стикеры.

## Талисман

**«Фишка»** — круглая покерная фишка с лицом. Тело — зелёный диск, по ободу —
белые прямоугольные «насечки», как у настоящей фишки. Лицо — простое: две точки-
глаза (или формы по настроению), рот. Маленькие ручки-обрубки появляются там, где
нужен жест. Красные щёчки/акценты — точечно. Дружелюбная, с юмором, **не детская
и не «милашная»** — игра для компании друзей.

## Порядок работы (важно, чтобы получилась одна семья)

1. Сначала сгенерируйте **лист персонажа** (запрос «0» ниже) — 4 варианта,
   выберите одного талисмана.
2. Дальше **каждый смайлик — с этой картинкой в качестве образца** (в Midjourney —
   `--cref <ссылка на картинку>`; в Ideogram / DALL·E / Flux — загрузить
   образец и написать «same character as the reference image»). Это держит
   форму, цвета и пропорции.
3. Каждый смайлик: **512×512, PNG, прозрачный фон**, сохранить как
   `assets-incoming/emoji/<имя>.png` (имена в таблице). Если генератор не умеет
   прозрачный фон — сгенерируйте на однотонном фоне #00FF00 и вырежьте (любым
   «удалить фон»), либо скажите Claude Code — он это сделает.
4. Проверка: уменьшите до 48 px — эмоция должна читаться. Если нет — упрощайте:
   крупнее глаза и рот, меньше деталей.
5. Скажите Claude Code: «агент E — подключить смайлики»
   (`docs/next-wave/agent-E-assets-integration.md`).

## Общий стиль (вставлять в каждый запрос)

```
Flat vector sticker-style emoji, a round poker chip character as the mascot: solid
green #137A43 disc body with evenly spaced off-white #F2F4F3 notches around the rim,
simple expressive face in off-white and deep navy #0A1216, tiny stub arms only when
the gesture needs them, small warm-red #C93632 accents (cheeks, flames, sweat) used
sparingly. Strictly flat colors, no gradients, no glow, no gloss, no 3D, no drop
shadows, no outline around the whole figure, no text, no letters. Transparent
background, centered, generous padding, 512x512, instantly readable at 48 px.
Friendly, witty, adult-friendly (not babyish). Same character, same proportions in
every image.
```

## Запрос «0» — лист персонажа (сначала)

```
[общий стиль] + Character reference sheet of the mascot "Chip": front view neutral
smiling face, plus small views of three expressions (happy, surprised, sad) on one
sheet, same size and proportions.
```

## 16 смайликов (имя файла → подпись в игре → запрос)

Каждый запрос — «[общий стиль] + …» и образец талисмана.

| Файл | Подпись | Что нарисовано |
|---|---|---|
| `gg.png` | Хорошая игра | Chip smiling with a small stub arm giving a thumbs up. |
| `wow.png` | Ого! | Chip with huge round eyes and an open round mouth, small flat motion marks beside its head. |
| `haha.png` | Ха-ха | Chip laughing out loud with closed curved eyes, wide open mouth and two flat tears of joy. |
| `sad.png` | Не повезло | Chip with droopy eyes, a small downturned mouth and one flat blue tear, rim notches slightly dimmer. |
| `think.png` | Думаю | Chip with one eyebrow raised, eyes looking up, a stub arm on its chin, a small flat thought bubble with three dots. |
| `fire.png` | Огонь! | Chip with a confident grin and a flat stylized red-orange flame on top of its head like hair. |
| `bluff.png` | Блеф? | Chip with a sly half-smile, one eyebrow raised, a stub arm holding two small face-down playing cards close to its body. |
| `allin.png` | Ва-банк | Chip with a determined face pushing a tall stack of chips forward with both stub arms. |
| `thanks.png` | Спасибо | Chip with warm closed eyes and both stub arms pressed to its center in a thankful gesture, a tiny red heart above. |
| `sorry.png` | Прости | Chip with a sheepish wobbly smile, eyes looking aside, one flat sweat drop, a stub arm scratching its head. |
| `hello.png` | Привет | Chip with a friendly smile waving with one stub arm raised. |
| `angry.png` | Злюсь | Chip with a red-tinted face, frowning angled eyebrows, flat steam puffs on both sides. |
| `facepalm.png` | Ну как так | Chip with a stub arm covering its eyes in a facepalm, mouth in a flat line. |
| `cool.png` | Красавчик | Chip with flat dark sunglasses and a confident smirk, a stub arm making a finger-gun gesture. |
| `wait.png` | Жду | Chip with half-closed bored eyes, a stub arm resting under its cheek, a small flat clock beside it. |
| `cheers.png` | Ура! | Chip with arms raised high and a huge open smile, flat colorful confetti pieces (green, red, off-white) around it. |

## Что делать, если вышло не так

Пишите агенту (или генератору) конкретно: «глаза крупнее», «проще», «меньше
деталей», «без обводки», «персонаж как на образце». **Не принимайте** картинки с
градиентами, блеском и свечением — проект строго плоский (`docs/redesign.md`), и
такие смайлики будут выбиваться из экрана.
