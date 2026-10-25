/**
 * Реестр тем покерного обучения — ОБЩИЙ для уроков («Обучение») и упражнений
 * («Тренировка»). Тема — это связка между ними: ошибка в упражнении называет
 * тему, по теме открывается урок, из урока ведёт кнопка «Потренироваться».
 *
 * Чистый модуль (никакого DOM, никаких импортов): его читают и клиент, и сервер
 * (проверка id в сообщениях прогресса), и тесты. Владелец файла — агент V.
 * Остальные агенты: id не переименовывать и не удалять (на них ссылается
 * сохранённый прогресс игроков); добавлять новые — только в свой блок ниже
 * и только после `git pull --rebase origin redesign`.
 *
 * Волна 3 (2026-10-25), `docs/next-wave-3/00-plan.md`.
 */

/** Четыре навыка: по ним определяется стартовый уровень и растёт сложность. */
export const SKILLS = [
  { id: 'preflop', title: 'Префлоп' },
  { id: 'ranges', title: 'Диапазоны' },
  { id: 'math', title: 'Математика' },
  { id: 'postflop', title: 'Постфлоп' },
];

/** Названия уровней сложности 1…5 (одинаковые во всех навыках и направлениях). */
export const LEVEL_NAMES = ['Новичок', 'Любитель', 'Уверенный', 'Продвинутый', 'Эксперт'];
export const LEVELS = 5;

/** Восемь направлений тренировки. `skill` — какой навык они растят. */
export const TRACKS = [
  { id: 'preflop', title: 'Префлоп-решения', skill: 'preflop', blurb: 'Что делать с рукой до флопа: открыть, уравнять, повысить, сбросить.' },
  { id: 'ranges', title: 'Тренажёр диапазонов', skill: 'ranges', blurb: 'Соберите диапазон на матрице 13×13 и сверьте с эталоном.' },
  { id: 'outs', title: 'Ауты и вероятности', skill: 'math', blurb: 'Сколько карт вам помогут и каков шанс их поймать.' },
  { id: 'potodds', title: 'Pot Odds и EV', skill: 'math', blurb: 'Выгоден ли колл по шансам банка и ожидаемому выигрышу.' },
  { id: 'postflop', title: 'Постфлоп-стратегия', skill: 'postflop', blurb: 'Ставки, чек, продолжение атаки, размер ставки.' },
  { id: 'readrange', title: 'Чтение диапазонов', skill: 'ranges', blurb: 'Что могло быть у соперника по его действиям.' },
  { id: 'hands', title: 'Разбор сложных раздач', skill: 'postflop', blurb: 'Трудные спорные раздачи по улицам с разбором.' },
  { id: 'advanced', title: 'Продвинутая стратегия', skill: 'postflop', blurb: 'Блокеры, смешанные стратегии, защита диапазона, SPR.' },
];

/**
 * Темы. `lessonSection` — раздел «Обучения», в котором живёт урок (агент U).
 * `skill` — какой навык растит тема. Порядок = порядок «от простого к сложному».
 */
export const TOPICS = [
  // --- Основы (U) ---
  { id: 'rules', title: 'Правила и ход раздачи', skill: 'preflop', lessonSection: 'basics' },
  { id: 'hand-ranks', title: 'Комбинации и их сила', skill: 'preflop', lessonSection: 'basics' },
  { id: 'positions', title: 'Позиции за столом', skill: 'preflop', lessonSection: 'basics' },
  { id: 'betting-actions', title: 'Ставки: чек, бет, колл, рейз', skill: 'preflop', lessonSection: 'basics' },
  // --- Префлоп ---
  { id: 'starting-hands', title: 'Стартовые руки', skill: 'preflop', lessonSection: 'preflop' },
  { id: 'open-raise', title: 'Открытие рейзом', skill: 'preflop', lessonSection: 'preflop' },
  { id: 'defend-vs-raise', title: 'Ответ на рейз: колл, 3-бет, сброс', skill: 'preflop', lessonSection: 'preflop' },
  { id: 'blinds-defence', title: 'Защита блайндов', skill: 'preflop', lessonSection: 'preflop' },
  // --- Диапазоны ---
  { id: 'range-basics', title: 'Что такое диапазон', skill: 'ranges', lessonSection: 'ranges' },
  { id: 'range-by-position', title: 'Диапазоны по позициям', skill: 'ranges', lessonSection: 'ranges' },
  { id: 'range-reading', title: 'Чтение диапазона соперника', skill: 'ranges', lessonSection: 'ranges' },
  { id: 'combos', title: 'Комбинации рук (комбо)', skill: 'ranges', lessonSection: 'ranges' },
  // --- Математика ---
  { id: 'outs', title: 'Ауты', skill: 'math', lessonSection: 'math' },
  { id: 'rule-2-4', title: 'Правило 2 и 4', skill: 'math', lessonSection: 'math' },
  { id: 'pot-odds', title: 'Pot Odds', skill: 'math', lessonSection: 'math' },
  { id: 'implied-odds', title: 'Скрытые шансы (implied odds)', skill: 'math', lessonSection: 'math' },
  { id: 'ev', title: 'Ожидаемый выигрыш (EV)', skill: 'math', lessonSection: 'math' },
  { id: 'fold-equity', title: 'Fold Equity', skill: 'math', lessonSection: 'math' },
  { id: 'equity', title: 'Эквити руки и диапазона', skill: 'math', lessonSection: 'math' },
  // --- Постфлоп ---
  { id: 'cbet', title: 'Continuation bet', skill: 'postflop', lessonSection: 'postflop' },
  { id: 'board-texture', title: 'Текстура борда', skill: 'postflop', lessonSection: 'postflop' },
  { id: 'bet-sizing', title: 'Размер ставки', skill: 'postflop', lessonSection: 'postflop' },
  { id: 'value-bluff', title: 'Вэлью и блеф', skill: 'postflop', lessonSection: 'postflop' },
  { id: 'draws', title: 'Игра с дро', skill: 'postflop', lessonSection: 'postflop' },
  // --- GTO ---
  { id: 'spr', title: 'SPR: стек к банку', skill: 'postflop', lessonSection: 'gto' },
  { id: 'gto-basics', title: 'GTO: основы', skill: 'postflop', lessonSection: 'gto' },
  { id: 'mdf', title: 'Минимальная защита (MDF)', skill: 'postflop', lessonSection: 'gto' },
  { id: 'blockers', title: 'Блокеры', skill: 'ranges', lessonSection: 'gto' },
  { id: 'gto-advanced', title: 'GTO: продвинутое', skill: 'postflop', lessonSection: 'gto' },
  // --- Блок для новых тем, добавленных агентами (каждый — в своей строке-комментарии) ---
  // U:
  // W:
  // X:
  // Y:
];

/** Разделы «Обучения» в порядке «от простого к сложному». */
export const LESSON_SECTIONS = [
  { id: 'basics', title: 'Основы' },
  { id: 'preflop', title: 'Префлоп' },
  { id: 'ranges', title: 'Диапазоны' },
  { id: 'math', title: 'Математика покера' },
  { id: 'postflop', title: 'Постфлоп' },
  { id: 'gto', title: 'GTO' },
];

const BY_ID = new Map(TOPICS.map((t) => [t.id, t]));
export const topicById = (id) => BY_ID.get(id) || null;
export const isTopic = (id) => BY_ID.has(id);
export const trackById = (id) => TRACKS.find((t) => t.id === id) || null;
export const isTrack = (id) => TRACKS.some((t) => t.id === id);
export const isSkill = (id) => SKILLS.some((s) => s.id === id);
export const topicsOfSkill = (skill) => TOPICS.filter((t) => t.skill === skill);
