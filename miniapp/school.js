/**
 * «Школа покера» на телефоне (режим «Обучение» в форме покера с ботами): азбука (что за игра, как идёт раздача, что
 * можно делать, комбинации и маленький тест) и список уроков с отметками.
 *
 * Азбука живёт только на странице — серверу о ней знать нечего. Уроки идут
 * за настоящим столом против наставника (`{t:'play', game:'poker',
 * settings:{learn:true, lesson}}`), подсказки к ним присылает сервер.
 * Какие уроки пройдены — помнит телефон (localStorage): это удобство, а не
 * учёт; пропало — ничего страшного.
 */
import { h, haptic, showSheet, closeSheet, refreshSheet, cardImg } from './ui.js';
import { send } from './net.js';

const KEY = 'school.done';

export function doneLessons() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function markDone(lesson) {
  try {
    const done = new Set(doneLessons());
    done.add(lesson);
    localStorage.setItem(KEY, JSON.stringify([...done]));
  } catch {
    /* приватный режим — просто не запомним */
  }
}

const play = (lesson) => {
  haptic.tap();
  send({ t: 'play', game: 'poker', settings: { learn: true, lesson } });
  closeSheet();
};

/**
 * Список уроков — режим «Обучение» в форме «Покер — с ботами»: азбука,
 * уроки по порядку, свободная игра. `back` возвращает в эту форму (им
 * пользуется азбука на кнопках «← К урокам» и «К списку уроков»).
 */
export function schoolItems(lessons, back) {
  const done = new Set(doneLessons());
  return [
    h('div.sub', 'Против наставника: уроки по порядку и свободная игра. После раздачи — разбор. В рейтинг не идёт.'),
    h('div.menu-list.school-list',
      h('button.menu-item', { type: 'button', onclick: () => openAbc(0, lessons, back) }, '📖 Азбука покера', h('small', 'цель, ход раздачи, действия, комбинации, тест')),
      lessons.map((l, i) => h('button.menu-item', { type: 'button', onclick: () => play(i) },
        `${done.has(i) ? '✓' : `${i + 1}.`} ${l.title}`, h('small', l.goal))),
      h('button.menu-item', { type: 'button', onclick: () => play(lessons.length) }, '♠ Свободная игра', h('small', 'обычные раздачи один на один с наставником'))),
  ];
}

/* ------------------------------------------------------------- азбука */

const row = (codes) => h('div.abc-cards', codes.split(' ').map((c) => cardImg(c)));

const COMBOS = [
  ['Флеш-рояль', 'A–K–Q–J–10 одной масти', 'AS KS QS JS 10S'],
  ['Стрит-флеш', 'пять подряд одной масти', '9H 8H 7H 6H 5H'],
  ['Каре', 'четыре одинаковых', 'QC QD QH QS 3D'],
  ['Фулл-хаус', 'тройка + пара', 'KH KD KS 7C 7H'],
  ['Флеш', 'пять одной масти', 'AD JD 8D 6D 2D'],
  ['Стрит', 'пять подряд', '10C 9D 8S 7H 6C'],
  ['Тройка', 'три одинаковых', '8S 8H 8D KC 4S'],
  ['Две пары', 'две разные пары', 'JH JC 5S 5D AH'],
  ['Пара', 'две одинаковых', '10S 10D AC 7H 3S'],
  ['Старшая карта', 'ничего не собрано — решает старшая', 'AH QC 9S 6D 3C'],
];

const QUIZ = [
  { a: ['Флеш', 'AD JD 8D 6D 2D'], b: ['Стрит', '10C 9D 8S 7H 6C'], right: 'a', why: 'Флеш сильнее стрита: пять одной масти собрать труднее.' },
  { a: ['Две пары', 'JH JC 5S 5D AH'], b: ['Тройка', '8S 8H 8D KC 4S'], right: 'b', why: 'Тройка сильнее двух пар — даже маленькая.' },
  { a: ['Фулл-хаус', 'KH KD KS 7C 7H'], b: ['Флеш', 'AD JD 8D 6D 2D'], right: 'a', why: 'Фулл-хаус (тройка + пара) сильнее флеша.' },
];

const STEPS = [
  () => h('div',
    h('h3', '1. Цель игры'),
    h('p.abc-p', 'У каждого две свои карты — их видите только вы.'),
    row('AH KH'),
    h('p.abc-p', 'На стол по очереди выкладывают пять общих карт.'),
    row('QH JH 2C 7S 10H'),
    h('p.abc-p', 'Побеждает лучшая комбинация из пяти карт — своих и общих в любом сочетании. Или тот, кто остался один, когда остальные сбросили карты.')),
  () => h('div',
    h('h3', '2. Как идёт раздача'),
    h('ol.abc-list',
      h('li', h('b', 'Блайнды. '), 'Двое слева от кнопки ставят обязательные ставки — малый и большой блайнд, чтобы было за что играть.'),
      h('li', h('b', 'Префлоп. '), 'Всем раздают по две карты. Первый круг ставок.'),
      h('li', h('b', 'Флоп. '), 'На стол — три общие карты. Круг ставок.'),
      h('li', h('b', 'Тёрн. '), 'Четвёртая карта. Круг ставок.'),
      h('li', h('b', 'Ривер. '), 'Пятая карта. Последний круг.'),
      h('li', h('b', 'Вскрытие. '), 'Кто дошёл до конца, открывает карты. Лучшая комбинация забирает банк.'))),
  () => h('div',
    h('h3', '3. Что можно делать'),
    h('ul.abc-list',
      h('li', h('b', 'Check — '), 'пропустить, если ставок ещё не было.'),
      h('li', h('b', 'Bet — '), 'поставить первым.'),
      h('li', h('b', 'Call — '), 'поставить столько же, сколько соперник.'),
      h('li', h('b', 'Raise — '), 'поставить больше, чем соперник.'),
      h('li', h('b', 'Fold — '), 'выйти из раздачи; поставленное остаётся в банке.'),
      h('li', h('b', 'All-in — '), 'поставить все свои фишки.')),
    h('p.abc-p', 'На кнопках стола — те же английские слова, как в любом покерном приложении. Круг ставок кончается, когда все сделали Call или Fold.')),
  () => h('div',
    h('h3', '4. Комбинации — от сильной к слабой'),
    h('div.abc-combos', COMBOS.map(([name, what, codes]) => h('div.abc-combo',
      h('div.abc-name', h('b', name), h('small', what)),
      row(codes))))),
];

function openAbc(step, lessons, back, quiz = { i: 0, picked: null, right: 0 }) {
  haptic.soft();
  showSheet('abc', () => {
    const last = STEPS.length; // после азбуки — тест
    if (step < last) {
      return h('div.abc',
        STEPS[step](),
        h('div.grid2.abc-nav',
          h('button.btn', { type: 'button', onclick: () => (step ? openAbc(step - 1, lessons, back) : back()) }, step ? '← Назад' : '← К урокам'),
          h('button.btn.primary', { type: 'button', onclick: () => openAbc(step + 1, lessons, back) }, step + 1 < last ? 'Дальше →' : 'Проверить себя →')));
    }
    if (quiz.i >= QUIZ.length) {
      return h('div.abc',
        h('h3', 'Готово!'),
        h('p.abc-p', `Правильных ответов: ${quiz.right} из ${QUIZ.length}. Теперь — за стол: первый урок против наставника, после раздачи — разбор.`),
        h('button.btn.primary.wide.lg', { type: 'button', style: { width: '100%' }, onclick: () => play(0) }, '▶ Первый урок'),
        h('button.btn', { type: 'button', style: { width: '100%', marginTop: '8px' }, onclick: () => back() }, 'К списку уроков'));
    }
    const q = QUIZ[quiz.i];
    const option = (key) => {
      const [name, codes] = q[key];
      const state = quiz.picked == null ? '' : key === q.right ? '.right' : quiz.picked === key ? '.wrong' : '';
      return h(`button.abc-option${state}`, {
        type: 'button',
        disabled: quiz.picked != null,
        onclick: () => {
          quiz.picked = key;
          if (key === q.right) quiz.right += 1;
          haptic.tap();
          refreshSheet();
        },
      }, row(codes), h('span', name));
    };
    return h('div.abc',
      h('h3', `Что сильнее? (${quiz.i + 1} из ${QUIZ.length})`),
      option('a'),
      option('b'),
      quiz.picked != null ? h('p.abc-p', quiz.picked === q.right ? `✓ Верно. ${q.why}` : `✗ Нет. ${q.why}`) : h('p.abc-p', 'Нажмите на более сильную руку.'),
      quiz.picked != null
        ? h('button.btn.primary.wide.lg', { type: 'button', style: { width: '100%' }, onclick: () => openAbc(step, lessons, back, { i: quiz.i + 1, picked: null, right: quiz.right }) }, 'Дальше →')
        : null);
  });
}
