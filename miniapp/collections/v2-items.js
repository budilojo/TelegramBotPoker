/** Runtime descriptors from v2-art/manifest.json. Art approval remains separate. */
export const V2_COLLECTIONS = [
  {
    "id": "sever",
    "title": "Север",
    "motif": "Ледяные грани и восьмилучевой кристалл",
    "palette": {
      "bg": "#203442",
      "ink": "#D4E7EF",
      "mid": "#738F9D"
    }
  },
  {
    "id": "obsidian",
    "title": "Обсидиан",
    "motif": "Асимметричные срезы и монолит",
    "palette": {
      "bg": "#25262C",
      "ink": "#D6D7DC",
      "mid": "#777883"
    }
  },
  {
    "id": "chertezh",
    "title": "Чертёж",
    "motif": "Калибровка, координатная сетка и угловые метки",
    "palette": {
      "bg": "#1E304F",
      "ink": "#E5E8DF",
      "mid": "#7C91B0"
    }
  },
  {
    "id": "terracotta",
    "title": "Терракота",
    "motif": "Широкие дуги, плитка и ступени",
    "palette": {
      "bg": "#743F36",
      "ink": "#F3DDC8",
      "mid": "#B77F68"
    }
  },
  {
    "id": "orbita",
    "title": "Орбита",
    "motif": "Смещённые окружности и спутники",
    "palette": {
      "bg": "#403448",
      "ink": "#DED8ED",
      "mid": "#9C8FAE"
    }
  },
  {
    "id": "porcelain",
    "title": "Фарфор",
    "motif": "Парные листья и тонкий растительный бордюр",
    "palette": {
      "bg": "#E0E9EC",
      "ink": "#304553",
      "mid": "#8499A3"
    }
  }
];
export const V2_ITEMS = [
  {
    "id": "sever-cardback",
    "collection": "sever",
    "kind": "item",
    "slot": "cardback",
    "games": [
      "poker"
    ],
    "visibility": "owner-closed-cards",
    "title": "Рубашка покера «Север»",
    "description": "Центральная эмблема и читаемый край закрытой карты.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/sever-cardback-preview.svg",
      "game": "/collections/v2-art/sever-cardback-game.svg"
    },
    "preview": "/collections/v2-art/sever-cardback-preview.svg",
    "game": "/collections/v2-art/sever-cardback-game.svg"
  },
  {
    "id": "sever-table",
    "collection": "sever",
    "kind": "item",
    "slot": "table",
    "games": [
      "poker",
      "durak"
    ],
    "visibility": "room",
    "title": "Стол «Север»",
    "description": "Орнамент по краю; центр для банка и карт свободен.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/sever-table-preview.svg",
      "game": "/collections/v2-art/sever-table-game.svg"
    },
    "preview": "/collections/v2-art/sever-table-preview.svg",
    "game": "/collections/v2-art/sever-table-game.svg"
  },
  {
    "id": "sever-frame",
    "collection": "sever",
    "kind": "item",
    "slot": "frame",
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "public-profile",
    "title": "Рамка «Север»",
    "description": "Контур аватара, сохраняющий лицо и имя.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/sever-frame-preview.svg",
      "game": "/collections/v2-art/sever-frame-game.svg"
    },
    "preview": "/collections/v2-art/sever-frame-preview.svg",
    "game": "/collections/v2-art/sever-frame-game.svg"
  },
  {
    "id": "sever-badge",
    "collection": "sever",
    "kind": "item",
    "slot": "badge",
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "public-profile",
    "title": "Значок «Север»",
    "description": "Украшение рядом с именем, без значения роли или ранга.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/sever-badge-preview.svg",
      "game": "/collections/v2-art/sever-badge-game.svg"
    },
    "preview": "/collections/v2-art/sever-badge-preview.svg",
    "game": "/collections/v2-art/sever-badge-game.svg"
  },
  {
    "id": "sever-chess-board",
    "collection": "sever",
    "kind": "item",
    "slot": "chess-board",
    "games": [
      "chess"
    ],
    "visibility": "room",
    "title": "Шахматная доска «Север»",
    "description": "Рама и безопасная фактура; светлые и тёмные клетки различимы.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/sever-chess-board-preview.svg",
      "game": "/collections/v2-art/sever-chess-board-game.svg"
    },
    "preview": "/collections/v2-art/sever-chess-board-preview.svg",
    "game": "/collections/v2-art/sever-chess-board-game.svg"
  },
  {
    "id": "sever-checkers-board",
    "collection": "sever",
    "kind": "item",
    "slot": "checkers-board",
    "games": [
      "checkers"
    ],
    "visibility": "room",
    "title": "Шашечная доска «Север»",
    "description": "Своя рама и миниатюра; фигуры и обязательное взятие читаются.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/sever-checkers-board-preview.svg",
      "game": "/collections/v2-art/sever-checkers-board-game.svg"
    },
    "preview": "/collections/v2-art/sever-checkers-board-preview.svg",
    "game": "/collections/v2-art/sever-checkers-board-game.svg"
  },
  {
    "id": "sever-nardy-board",
    "collection": "sever",
    "kind": "item",
    "slot": "nardy-board",
    "games": [
      "nardy"
    ],
    "visibility": "room",
    "title": "Доска нард «Север»",
    "description": "Рама, бар и свободные участки; треугольники и кубики прежние.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/sever-nardy-board-preview.svg",
      "game": "/collections/v2-art/sever-nardy-board-game.svg"
    },
    "preview": "/collections/v2-art/sever-nardy-board-preview.svg",
    "game": "/collections/v2-art/sever-nardy-board-game.svg"
  },
  {
    "id": "sever-battleship-panel",
    "collection": "sever",
    "kind": "item",
    "slot": "battleship-panel",
    "games": [
      "battleship"
    ],
    "visibility": "room",
    "title": "Панель морского боя «Север»",
    "description": "Только рама и координатные поля; без содержимого флота.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/sever-battleship-panel-preview.svg",
      "game": "/collections/v2-art/sever-battleship-panel-game.svg"
    },
    "preview": "/collections/v2-art/sever-battleship-panel-preview.svg",
    "game": "/collections/v2-art/sever-battleship-panel-game.svg"
  },
  {
    "id": "sever-unoq-cardback",
    "collection": "sever",
    "kind": "item",
    "slot": "unoq-cardback",
    "games": [
      "colors"
    ],
    "visibility": "room",
    "title": "Рубашка UNOQ «Север»",
    "description": "Закрытая сторона и стопка добора; лица и четыре цвета прежние.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/sever-unoq-cardback-preview.svg",
      "game": "/collections/v2-art/sever-unoq-cardback-game.svg"
    },
    "preview": "/collections/v2-art/sever-unoq-cardback-preview.svg",
    "game": "/collections/v2-art/sever-unoq-cardback-game.svg"
  },
  {
    "id": "sever-bundle",
    "collection": "sever",
    "kind": "bundle",
    "slot": null,
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "inventory-only",
    "title": "Комплект «Север»",
    "description": "Девять самостоятельных предметов коллекции.",
    "includes": [
      "sever-cardback",
      "sever-table",
      "sever-frame",
      "sever-badge",
      "sever-chess-board",
      "sever-checkers-board",
      "sever-nardy-board",
      "sever-battleship-panel",
      "sever-unoq-cardback"
    ],
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/sever-bundle-preview.svg",
      "game": null
    },
    "preview": "/collections/v2-art/sever-bundle-preview.svg",
    "game": null
  },
  {
    "id": "obsidian-cardback",
    "collection": "obsidian",
    "kind": "item",
    "slot": "cardback",
    "games": [
      "poker"
    ],
    "visibility": "owner-closed-cards",
    "title": "Рубашка покера «Обсидиан»",
    "description": "Центральная эмблема и читаемый край закрытой карты.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/obsidian-cardback-preview.svg",
      "game": "/collections/v2-art/obsidian-cardback-game.svg"
    },
    "preview": "/collections/v2-art/obsidian-cardback-preview.svg",
    "game": "/collections/v2-art/obsidian-cardback-game.svg"
  },
  {
    "id": "obsidian-table",
    "collection": "obsidian",
    "kind": "item",
    "slot": "table",
    "games": [
      "poker",
      "durak"
    ],
    "visibility": "room",
    "title": "Стол «Обсидиан»",
    "description": "Орнамент по краю; центр для банка и карт свободен.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/obsidian-table-preview.svg",
      "game": "/collections/v2-art/obsidian-table-game.svg"
    },
    "preview": "/collections/v2-art/obsidian-table-preview.svg",
    "game": "/collections/v2-art/obsidian-table-game.svg"
  },
  {
    "id": "obsidian-frame",
    "collection": "obsidian",
    "kind": "item",
    "slot": "frame",
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "public-profile",
    "title": "Рамка «Обсидиан»",
    "description": "Контур аватара, сохраняющий лицо и имя.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/obsidian-frame-preview.svg",
      "game": "/collections/v2-art/obsidian-frame-game.svg"
    },
    "preview": "/collections/v2-art/obsidian-frame-preview.svg",
    "game": "/collections/v2-art/obsidian-frame-game.svg"
  },
  {
    "id": "obsidian-badge",
    "collection": "obsidian",
    "kind": "item",
    "slot": "badge",
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "public-profile",
    "title": "Значок «Обсидиан»",
    "description": "Украшение рядом с именем, без значения роли или ранга.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/obsidian-badge-preview.svg",
      "game": "/collections/v2-art/obsidian-badge-game.svg"
    },
    "preview": "/collections/v2-art/obsidian-badge-preview.svg",
    "game": "/collections/v2-art/obsidian-badge-game.svg"
  },
  {
    "id": "obsidian-chess-board",
    "collection": "obsidian",
    "kind": "item",
    "slot": "chess-board",
    "games": [
      "chess"
    ],
    "visibility": "room",
    "title": "Шахматная доска «Обсидиан»",
    "description": "Рама и безопасная фактура; светлые и тёмные клетки различимы.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/obsidian-chess-board-preview.svg",
      "game": "/collections/v2-art/obsidian-chess-board-game.svg"
    },
    "preview": "/collections/v2-art/obsidian-chess-board-preview.svg",
    "game": "/collections/v2-art/obsidian-chess-board-game.svg"
  },
  {
    "id": "obsidian-checkers-board",
    "collection": "obsidian",
    "kind": "item",
    "slot": "checkers-board",
    "games": [
      "checkers"
    ],
    "visibility": "room",
    "title": "Шашечная доска «Обсидиан»",
    "description": "Своя рама и миниатюра; фигуры и обязательное взятие читаются.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/obsidian-checkers-board-preview.svg",
      "game": "/collections/v2-art/obsidian-checkers-board-game.svg"
    },
    "preview": "/collections/v2-art/obsidian-checkers-board-preview.svg",
    "game": "/collections/v2-art/obsidian-checkers-board-game.svg"
  },
  {
    "id": "obsidian-nardy-board",
    "collection": "obsidian",
    "kind": "item",
    "slot": "nardy-board",
    "games": [
      "nardy"
    ],
    "visibility": "room",
    "title": "Доска нард «Обсидиан»",
    "description": "Рама, бар и свободные участки; треугольники и кубики прежние.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/obsidian-nardy-board-preview.svg",
      "game": "/collections/v2-art/obsidian-nardy-board-game.svg"
    },
    "preview": "/collections/v2-art/obsidian-nardy-board-preview.svg",
    "game": "/collections/v2-art/obsidian-nardy-board-game.svg"
  },
  {
    "id": "obsidian-battleship-panel",
    "collection": "obsidian",
    "kind": "item",
    "slot": "battleship-panel",
    "games": [
      "battleship"
    ],
    "visibility": "room",
    "title": "Панель морского боя «Обсидиан»",
    "description": "Только рама и координатные поля; без содержимого флота.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/obsidian-battleship-panel-preview.svg",
      "game": "/collections/v2-art/obsidian-battleship-panel-game.svg"
    },
    "preview": "/collections/v2-art/obsidian-battleship-panel-preview.svg",
    "game": "/collections/v2-art/obsidian-battleship-panel-game.svg"
  },
  {
    "id": "obsidian-unoq-cardback",
    "collection": "obsidian",
    "kind": "item",
    "slot": "unoq-cardback",
    "games": [
      "colors"
    ],
    "visibility": "room",
    "title": "Рубашка UNOQ «Обсидиан»",
    "description": "Закрытая сторона и стопка добора; лица и четыре цвета прежние.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/obsidian-unoq-cardback-preview.svg",
      "game": "/collections/v2-art/obsidian-unoq-cardback-game.svg"
    },
    "preview": "/collections/v2-art/obsidian-unoq-cardback-preview.svg",
    "game": "/collections/v2-art/obsidian-unoq-cardback-game.svg"
  },
  {
    "id": "obsidian-bundle",
    "collection": "obsidian",
    "kind": "bundle",
    "slot": null,
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "inventory-only",
    "title": "Комплект «Обсидиан»",
    "description": "Девять самостоятельных предметов коллекции.",
    "includes": [
      "obsidian-cardback",
      "obsidian-table",
      "obsidian-frame",
      "obsidian-badge",
      "obsidian-chess-board",
      "obsidian-checkers-board",
      "obsidian-nardy-board",
      "obsidian-battleship-panel",
      "obsidian-unoq-cardback"
    ],
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/obsidian-bundle-preview.svg",
      "game": null
    },
    "preview": "/collections/v2-art/obsidian-bundle-preview.svg",
    "game": null
  },
  {
    "id": "chertezh-cardback",
    "collection": "chertezh",
    "kind": "item",
    "slot": "cardback",
    "games": [
      "poker"
    ],
    "visibility": "owner-closed-cards",
    "title": "Рубашка покера «Чертёж»",
    "description": "Центральная эмблема и читаемый край закрытой карты.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/chertezh-cardback-preview.svg",
      "game": "/collections/v2-art/chertezh-cardback-game.svg"
    },
    "preview": "/collections/v2-art/chertezh-cardback-preview.svg",
    "game": "/collections/v2-art/chertezh-cardback-game.svg"
  },
  {
    "id": "chertezh-table",
    "collection": "chertezh",
    "kind": "item",
    "slot": "table",
    "games": [
      "poker",
      "durak"
    ],
    "visibility": "room",
    "title": "Стол «Чертёж»",
    "description": "Орнамент по краю; центр для банка и карт свободен.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/chertezh-table-preview.svg",
      "game": "/collections/v2-art/chertezh-table-game.svg"
    },
    "preview": "/collections/v2-art/chertezh-table-preview.svg",
    "game": "/collections/v2-art/chertezh-table-game.svg"
  },
  {
    "id": "chertezh-frame",
    "collection": "chertezh",
    "kind": "item",
    "slot": "frame",
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "public-profile",
    "title": "Рамка «Чертёж»",
    "description": "Контур аватара, сохраняющий лицо и имя.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/chertezh-frame-preview.svg",
      "game": "/collections/v2-art/chertezh-frame-game.svg"
    },
    "preview": "/collections/v2-art/chertezh-frame-preview.svg",
    "game": "/collections/v2-art/chertezh-frame-game.svg"
  },
  {
    "id": "chertezh-badge",
    "collection": "chertezh",
    "kind": "item",
    "slot": "badge",
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "public-profile",
    "title": "Значок «Чертёж»",
    "description": "Украшение рядом с именем, без значения роли или ранга.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/chertezh-badge-preview.svg",
      "game": "/collections/v2-art/chertezh-badge-game.svg"
    },
    "preview": "/collections/v2-art/chertezh-badge-preview.svg",
    "game": "/collections/v2-art/chertezh-badge-game.svg"
  },
  {
    "id": "chertezh-chess-board",
    "collection": "chertezh",
    "kind": "item",
    "slot": "chess-board",
    "games": [
      "chess"
    ],
    "visibility": "room",
    "title": "Шахматная доска «Чертёж»",
    "description": "Рама и безопасная фактура; светлые и тёмные клетки различимы.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/chertezh-chess-board-preview.svg",
      "game": "/collections/v2-art/chertezh-chess-board-game.svg"
    },
    "preview": "/collections/v2-art/chertezh-chess-board-preview.svg",
    "game": "/collections/v2-art/chertezh-chess-board-game.svg"
  },
  {
    "id": "chertezh-checkers-board",
    "collection": "chertezh",
    "kind": "item",
    "slot": "checkers-board",
    "games": [
      "checkers"
    ],
    "visibility": "room",
    "title": "Шашечная доска «Чертёж»",
    "description": "Своя рама и миниатюра; фигуры и обязательное взятие читаются.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/chertezh-checkers-board-preview.svg",
      "game": "/collections/v2-art/chertezh-checkers-board-game.svg"
    },
    "preview": "/collections/v2-art/chertezh-checkers-board-preview.svg",
    "game": "/collections/v2-art/chertezh-checkers-board-game.svg"
  },
  {
    "id": "chertezh-nardy-board",
    "collection": "chertezh",
    "kind": "item",
    "slot": "nardy-board",
    "games": [
      "nardy"
    ],
    "visibility": "room",
    "title": "Доска нард «Чертёж»",
    "description": "Рама, бар и свободные участки; треугольники и кубики прежние.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/chertezh-nardy-board-preview.svg",
      "game": "/collections/v2-art/chertezh-nardy-board-game.svg"
    },
    "preview": "/collections/v2-art/chertezh-nardy-board-preview.svg",
    "game": "/collections/v2-art/chertezh-nardy-board-game.svg"
  },
  {
    "id": "chertezh-battleship-panel",
    "collection": "chertezh",
    "kind": "item",
    "slot": "battleship-panel",
    "games": [
      "battleship"
    ],
    "visibility": "room",
    "title": "Панель морского боя «Чертёж»",
    "description": "Только рама и координатные поля; без содержимого флота.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/chertezh-battleship-panel-preview.svg",
      "game": "/collections/v2-art/chertezh-battleship-panel-game.svg"
    },
    "preview": "/collections/v2-art/chertezh-battleship-panel-preview.svg",
    "game": "/collections/v2-art/chertezh-battleship-panel-game.svg"
  },
  {
    "id": "chertezh-unoq-cardback",
    "collection": "chertezh",
    "kind": "item",
    "slot": "unoq-cardback",
    "games": [
      "colors"
    ],
    "visibility": "room",
    "title": "Рубашка UNOQ «Чертёж»",
    "description": "Закрытая сторона и стопка добора; лица и четыре цвета прежние.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/chertezh-unoq-cardback-preview.svg",
      "game": "/collections/v2-art/chertezh-unoq-cardback-game.svg"
    },
    "preview": "/collections/v2-art/chertezh-unoq-cardback-preview.svg",
    "game": "/collections/v2-art/chertezh-unoq-cardback-game.svg"
  },
  {
    "id": "chertezh-bundle",
    "collection": "chertezh",
    "kind": "bundle",
    "slot": null,
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "inventory-only",
    "title": "Комплект «Чертёж»",
    "description": "Девять самостоятельных предметов коллекции.",
    "includes": [
      "chertezh-cardback",
      "chertezh-table",
      "chertezh-frame",
      "chertezh-badge",
      "chertezh-chess-board",
      "chertezh-checkers-board",
      "chertezh-nardy-board",
      "chertezh-battleship-panel",
      "chertezh-unoq-cardback"
    ],
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/chertezh-bundle-preview.svg",
      "game": null
    },
    "preview": "/collections/v2-art/chertezh-bundle-preview.svg",
    "game": null
  },
  {
    "id": "terracotta-cardback",
    "collection": "terracotta",
    "kind": "item",
    "slot": "cardback",
    "games": [
      "poker"
    ],
    "visibility": "owner-closed-cards",
    "title": "Рубашка покера «Терракота»",
    "description": "Центральная эмблема и читаемый край закрытой карты.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/terracotta-cardback-preview.svg",
      "game": "/collections/v2-art/terracotta-cardback-game.svg"
    },
    "preview": "/collections/v2-art/terracotta-cardback-preview.svg",
    "game": "/collections/v2-art/terracotta-cardback-game.svg"
  },
  {
    "id": "terracotta-table",
    "collection": "terracotta",
    "kind": "item",
    "slot": "table",
    "games": [
      "poker",
      "durak"
    ],
    "visibility": "room",
    "title": "Стол «Терракота»",
    "description": "Орнамент по краю; центр для банка и карт свободен.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/terracotta-table-preview.svg",
      "game": "/collections/v2-art/terracotta-table-game.svg"
    },
    "preview": "/collections/v2-art/terracotta-table-preview.svg",
    "game": "/collections/v2-art/terracotta-table-game.svg"
  },
  {
    "id": "terracotta-frame",
    "collection": "terracotta",
    "kind": "item",
    "slot": "frame",
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "public-profile",
    "title": "Рамка «Терракота»",
    "description": "Контур аватара, сохраняющий лицо и имя.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/terracotta-frame-preview.svg",
      "game": "/collections/v2-art/terracotta-frame-game.svg"
    },
    "preview": "/collections/v2-art/terracotta-frame-preview.svg",
    "game": "/collections/v2-art/terracotta-frame-game.svg"
  },
  {
    "id": "terracotta-badge",
    "collection": "terracotta",
    "kind": "item",
    "slot": "badge",
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "public-profile",
    "title": "Значок «Терракота»",
    "description": "Украшение рядом с именем, без значения роли или ранга.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/terracotta-badge-preview.svg",
      "game": "/collections/v2-art/terracotta-badge-game.svg"
    },
    "preview": "/collections/v2-art/terracotta-badge-preview.svg",
    "game": "/collections/v2-art/terracotta-badge-game.svg"
  },
  {
    "id": "terracotta-chess-board",
    "collection": "terracotta",
    "kind": "item",
    "slot": "chess-board",
    "games": [
      "chess"
    ],
    "visibility": "room",
    "title": "Шахматная доска «Терракота»",
    "description": "Рама и безопасная фактура; светлые и тёмные клетки различимы.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/terracotta-chess-board-preview.svg",
      "game": "/collections/v2-art/terracotta-chess-board-game.svg"
    },
    "preview": "/collections/v2-art/terracotta-chess-board-preview.svg",
    "game": "/collections/v2-art/terracotta-chess-board-game.svg"
  },
  {
    "id": "terracotta-checkers-board",
    "collection": "terracotta",
    "kind": "item",
    "slot": "checkers-board",
    "games": [
      "checkers"
    ],
    "visibility": "room",
    "title": "Шашечная доска «Терракота»",
    "description": "Своя рама и миниатюра; фигуры и обязательное взятие читаются.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/terracotta-checkers-board-preview.svg",
      "game": "/collections/v2-art/terracotta-checkers-board-game.svg"
    },
    "preview": "/collections/v2-art/terracotta-checkers-board-preview.svg",
    "game": "/collections/v2-art/terracotta-checkers-board-game.svg"
  },
  {
    "id": "terracotta-nardy-board",
    "collection": "terracotta",
    "kind": "item",
    "slot": "nardy-board",
    "games": [
      "nardy"
    ],
    "visibility": "room",
    "title": "Доска нард «Терракота»",
    "description": "Рама, бар и свободные участки; треугольники и кубики прежние.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/terracotta-nardy-board-preview.svg",
      "game": "/collections/v2-art/terracotta-nardy-board-game.svg"
    },
    "preview": "/collections/v2-art/terracotta-nardy-board-preview.svg",
    "game": "/collections/v2-art/terracotta-nardy-board-game.svg"
  },
  {
    "id": "terracotta-battleship-panel",
    "collection": "terracotta",
    "kind": "item",
    "slot": "battleship-panel",
    "games": [
      "battleship"
    ],
    "visibility": "room",
    "title": "Панель морского боя «Терракота»",
    "description": "Только рама и координатные поля; без содержимого флота.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/terracotta-battleship-panel-preview.svg",
      "game": "/collections/v2-art/terracotta-battleship-panel-game.svg"
    },
    "preview": "/collections/v2-art/terracotta-battleship-panel-preview.svg",
    "game": "/collections/v2-art/terracotta-battleship-panel-game.svg"
  },
  {
    "id": "terracotta-unoq-cardback",
    "collection": "terracotta",
    "kind": "item",
    "slot": "unoq-cardback",
    "games": [
      "colors"
    ],
    "visibility": "room",
    "title": "Рубашка UNOQ «Терракота»",
    "description": "Закрытая сторона и стопка добора; лица и четыре цвета прежние.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/terracotta-unoq-cardback-preview.svg",
      "game": "/collections/v2-art/terracotta-unoq-cardback-game.svg"
    },
    "preview": "/collections/v2-art/terracotta-unoq-cardback-preview.svg",
    "game": "/collections/v2-art/terracotta-unoq-cardback-game.svg"
  },
  {
    "id": "terracotta-bundle",
    "collection": "terracotta",
    "kind": "bundle",
    "slot": null,
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "inventory-only",
    "title": "Комплект «Терракота»",
    "description": "Девять самостоятельных предметов коллекции.",
    "includes": [
      "terracotta-cardback",
      "terracotta-table",
      "terracotta-frame",
      "terracotta-badge",
      "terracotta-chess-board",
      "terracotta-checkers-board",
      "terracotta-nardy-board",
      "terracotta-battleship-panel",
      "terracotta-unoq-cardback"
    ],
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/terracotta-bundle-preview.svg",
      "game": null
    },
    "preview": "/collections/v2-art/terracotta-bundle-preview.svg",
    "game": null
  },
  {
    "id": "orbita-cardback",
    "collection": "orbita",
    "kind": "item",
    "slot": "cardback",
    "games": [
      "poker"
    ],
    "visibility": "owner-closed-cards",
    "title": "Рубашка покера «Орбита»",
    "description": "Центральная эмблема и читаемый край закрытой карты.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/orbita-cardback-preview.svg",
      "game": "/collections/v2-art/orbita-cardback-game.svg"
    },
    "preview": "/collections/v2-art/orbita-cardback-preview.svg",
    "game": "/collections/v2-art/orbita-cardback-game.svg"
  },
  {
    "id": "orbita-table",
    "collection": "orbita",
    "kind": "item",
    "slot": "table",
    "games": [
      "poker",
      "durak"
    ],
    "visibility": "room",
    "title": "Стол «Орбита»",
    "description": "Орнамент по краю; центр для банка и карт свободен.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/orbita-table-preview.svg",
      "game": "/collections/v2-art/orbita-table-game.svg"
    },
    "preview": "/collections/v2-art/orbita-table-preview.svg",
    "game": "/collections/v2-art/orbita-table-game.svg"
  },
  {
    "id": "orbita-frame",
    "collection": "orbita",
    "kind": "item",
    "slot": "frame",
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "public-profile",
    "title": "Рамка «Орбита»",
    "description": "Контур аватара, сохраняющий лицо и имя.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/orbita-frame-preview.svg",
      "game": "/collections/v2-art/orbita-frame-game.svg"
    },
    "preview": "/collections/v2-art/orbita-frame-preview.svg",
    "game": "/collections/v2-art/orbita-frame-game.svg"
  },
  {
    "id": "orbita-badge",
    "collection": "orbita",
    "kind": "item",
    "slot": "badge",
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "public-profile",
    "title": "Значок «Орбита»",
    "description": "Украшение рядом с именем, без значения роли или ранга.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/orbita-badge-preview.svg",
      "game": "/collections/v2-art/orbita-badge-game.svg"
    },
    "preview": "/collections/v2-art/orbita-badge-preview.svg",
    "game": "/collections/v2-art/orbita-badge-game.svg"
  },
  {
    "id": "orbita-chess-board",
    "collection": "orbita",
    "kind": "item",
    "slot": "chess-board",
    "games": [
      "chess"
    ],
    "visibility": "room",
    "title": "Шахматная доска «Орбита»",
    "description": "Рама и безопасная фактура; светлые и тёмные клетки различимы.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/orbita-chess-board-preview.svg",
      "game": "/collections/v2-art/orbita-chess-board-game.svg"
    },
    "preview": "/collections/v2-art/orbita-chess-board-preview.svg",
    "game": "/collections/v2-art/orbita-chess-board-game.svg"
  },
  {
    "id": "orbita-checkers-board",
    "collection": "orbita",
    "kind": "item",
    "slot": "checkers-board",
    "games": [
      "checkers"
    ],
    "visibility": "room",
    "title": "Шашечная доска «Орбита»",
    "description": "Своя рама и миниатюра; фигуры и обязательное взятие читаются.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/orbita-checkers-board-preview.svg",
      "game": "/collections/v2-art/orbita-checkers-board-game.svg"
    },
    "preview": "/collections/v2-art/orbita-checkers-board-preview.svg",
    "game": "/collections/v2-art/orbita-checkers-board-game.svg"
  },
  {
    "id": "orbita-nardy-board",
    "collection": "orbita",
    "kind": "item",
    "slot": "nardy-board",
    "games": [
      "nardy"
    ],
    "visibility": "room",
    "title": "Доска нард «Орбита»",
    "description": "Рама, бар и свободные участки; треугольники и кубики прежние.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/orbita-nardy-board-preview.svg",
      "game": "/collections/v2-art/orbita-nardy-board-game.svg"
    },
    "preview": "/collections/v2-art/orbita-nardy-board-preview.svg",
    "game": "/collections/v2-art/orbita-nardy-board-game.svg"
  },
  {
    "id": "orbita-battleship-panel",
    "collection": "orbita",
    "kind": "item",
    "slot": "battleship-panel",
    "games": [
      "battleship"
    ],
    "visibility": "room",
    "title": "Панель морского боя «Орбита»",
    "description": "Только рама и координатные поля; без содержимого флота.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/orbita-battleship-panel-preview.svg",
      "game": "/collections/v2-art/orbita-battleship-panel-game.svg"
    },
    "preview": "/collections/v2-art/orbita-battleship-panel-preview.svg",
    "game": "/collections/v2-art/orbita-battleship-panel-game.svg"
  },
  {
    "id": "orbita-unoq-cardback",
    "collection": "orbita",
    "kind": "item",
    "slot": "unoq-cardback",
    "games": [
      "colors"
    ],
    "visibility": "room",
    "title": "Рубашка UNOQ «Орбита»",
    "description": "Закрытая сторона и стопка добора; лица и четыре цвета прежние.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/orbita-unoq-cardback-preview.svg",
      "game": "/collections/v2-art/orbita-unoq-cardback-game.svg"
    },
    "preview": "/collections/v2-art/orbita-unoq-cardback-preview.svg",
    "game": "/collections/v2-art/orbita-unoq-cardback-game.svg"
  },
  {
    "id": "orbita-bundle",
    "collection": "orbita",
    "kind": "bundle",
    "slot": null,
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "inventory-only",
    "title": "Комплект «Орбита»",
    "description": "Девять самостоятельных предметов коллекции.",
    "includes": [
      "orbita-cardback",
      "orbita-table",
      "orbita-frame",
      "orbita-badge",
      "orbita-chess-board",
      "orbita-checkers-board",
      "orbita-nardy-board",
      "orbita-battleship-panel",
      "orbita-unoq-cardback"
    ],
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/orbita-bundle-preview.svg",
      "game": null
    },
    "preview": "/collections/v2-art/orbita-bundle-preview.svg",
    "game": null
  },
  {
    "id": "porcelain-cardback",
    "collection": "porcelain",
    "kind": "item",
    "slot": "cardback",
    "games": [
      "poker"
    ],
    "visibility": "owner-closed-cards",
    "title": "Рубашка покера «Фарфор»",
    "description": "Центральная эмблема и читаемый край закрытой карты.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/porcelain-cardback-preview.svg",
      "game": "/collections/v2-art/porcelain-cardback-game.svg"
    },
    "preview": "/collections/v2-art/porcelain-cardback-preview.svg",
    "game": "/collections/v2-art/porcelain-cardback-game.svg"
  },
  {
    "id": "porcelain-table",
    "collection": "porcelain",
    "kind": "item",
    "slot": "table",
    "games": [
      "poker",
      "durak"
    ],
    "visibility": "room",
    "title": "Стол «Фарфор»",
    "description": "Орнамент по краю; центр для банка и карт свободен.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/porcelain-table-preview.svg",
      "game": "/collections/v2-art/porcelain-table-game.svg"
    },
    "preview": "/collections/v2-art/porcelain-table-preview.svg",
    "game": "/collections/v2-art/porcelain-table-game.svg"
  },
  {
    "id": "porcelain-frame",
    "collection": "porcelain",
    "kind": "item",
    "slot": "frame",
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "public-profile",
    "title": "Рамка «Фарфор»",
    "description": "Контур аватара, сохраняющий лицо и имя.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/porcelain-frame-preview.svg",
      "game": "/collections/v2-art/porcelain-frame-game.svg"
    },
    "preview": "/collections/v2-art/porcelain-frame-preview.svg",
    "game": "/collections/v2-art/porcelain-frame-game.svg"
  },
  {
    "id": "porcelain-badge",
    "collection": "porcelain",
    "kind": "item",
    "slot": "badge",
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "public-profile",
    "title": "Значок «Фарфор»",
    "description": "Украшение рядом с именем, без значения роли или ранга.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/porcelain-badge-preview.svg",
      "game": "/collections/v2-art/porcelain-badge-game.svg"
    },
    "preview": "/collections/v2-art/porcelain-badge-preview.svg",
    "game": "/collections/v2-art/porcelain-badge-game.svg"
  },
  {
    "id": "porcelain-chess-board",
    "collection": "porcelain",
    "kind": "item",
    "slot": "chess-board",
    "games": [
      "chess"
    ],
    "visibility": "room",
    "title": "Шахматная доска «Фарфор»",
    "description": "Рама и безопасная фактура; светлые и тёмные клетки различимы.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/porcelain-chess-board-preview.svg",
      "game": "/collections/v2-art/porcelain-chess-board-game.svg"
    },
    "preview": "/collections/v2-art/porcelain-chess-board-preview.svg",
    "game": "/collections/v2-art/porcelain-chess-board-game.svg"
  },
  {
    "id": "porcelain-checkers-board",
    "collection": "porcelain",
    "kind": "item",
    "slot": "checkers-board",
    "games": [
      "checkers"
    ],
    "visibility": "room",
    "title": "Шашечная доска «Фарфор»",
    "description": "Своя рама и миниатюра; фигуры и обязательное взятие читаются.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/porcelain-checkers-board-preview.svg",
      "game": "/collections/v2-art/porcelain-checkers-board-game.svg"
    },
    "preview": "/collections/v2-art/porcelain-checkers-board-preview.svg",
    "game": "/collections/v2-art/porcelain-checkers-board-game.svg"
  },
  {
    "id": "porcelain-nardy-board",
    "collection": "porcelain",
    "kind": "item",
    "slot": "nardy-board",
    "games": [
      "nardy"
    ],
    "visibility": "room",
    "title": "Доска нард «Фарфор»",
    "description": "Рама, бар и свободные участки; треугольники и кубики прежние.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/porcelain-nardy-board-preview.svg",
      "game": "/collections/v2-art/porcelain-nardy-board-game.svg"
    },
    "preview": "/collections/v2-art/porcelain-nardy-board-preview.svg",
    "game": "/collections/v2-art/porcelain-nardy-board-game.svg"
  },
  {
    "id": "porcelain-battleship-panel",
    "collection": "porcelain",
    "kind": "item",
    "slot": "battleship-panel",
    "games": [
      "battleship"
    ],
    "visibility": "room",
    "title": "Панель морского боя «Фарфор»",
    "description": "Только рама и координатные поля; без содержимого флота.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/porcelain-battleship-panel-preview.svg",
      "game": "/collections/v2-art/porcelain-battleship-panel-game.svg"
    },
    "preview": "/collections/v2-art/porcelain-battleship-panel-preview.svg",
    "game": "/collections/v2-art/porcelain-battleship-panel-game.svg"
  },
  {
    "id": "porcelain-unoq-cardback",
    "collection": "porcelain",
    "kind": "item",
    "slot": "unoq-cardback",
    "games": [
      "colors"
    ],
    "visibility": "room",
    "title": "Рубашка UNOQ «Фарфор»",
    "description": "Закрытая сторона и стопка добора; лица и четыре цвета прежние.",
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/porcelain-unoq-cardback-preview.svg",
      "game": "/collections/v2-art/porcelain-unoq-cardback-game.svg"
    },
    "preview": "/collections/v2-art/porcelain-unoq-cardback-preview.svg",
    "game": "/collections/v2-art/porcelain-unoq-cardback-game.svg"
  },
  {
    "id": "porcelain-bundle",
    "collection": "porcelain",
    "kind": "bundle",
    "slot": null,
    "games": [
      "poker",
      "durak",
      "colors",
      "chess",
      "checkers",
      "nardy",
      "battleship"
    ],
    "visibility": "inventory-only",
    "title": "Комплект «Фарфор»",
    "description": "Девять самостоятельных предметов коллекции.",
    "includes": [
      "porcelain-cardback",
      "porcelain-table",
      "porcelain-frame",
      "porcelain-badge",
      "porcelain-chess-board",
      "porcelain-checkers-board",
      "porcelain-nardy-board",
      "porcelain-battleship-panel",
      "porcelain-unoq-cardback"
    ],
    "price": null,
    "readiness": "integrated",
    "artSource": "tools/build-cosmetics-v2.mjs",
    "assets": {
      "preview": "/collections/v2-art/porcelain-bundle-preview.svg",
      "game": null
    },
    "preview": "/collections/v2-art/porcelain-bundle-preview.svg",
    "game": null
  }
];
