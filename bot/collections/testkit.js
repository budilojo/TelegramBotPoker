/** collections: помощники тестов (не тест сам по себе — в `npm test` не попадает). */
import { Table, user } from '../harness.js';

export { Table, user };
let n = 0;
/** Уникальный `req` допустимого вида. */
export const req = (tag = 'r') => `${tag}-${String(++n).padStart(6, '0')}`;

export const ALICE = user(700001001, 'Алиса');
export const BOB = user(700001002, 'Боб');
export const CAROL = user(700001003, 'Катя');

/** Включить демосреду в готовом столе (в рабочем процессе это делает только bot/index.js). */
export const demoOn = (t) => {
  t.app.collections.demo = true;
  return t;
};

export const col = (t, u) => t.page(u).inbox.filter((m) => m.t === 'col');
export const lastCol = (t, u) => col(t, u).at(-1) ?? null;
export const send = async (t, u, msg) => {
  await t.send(u, { t: 'col', ...msg });
  return lastCol(t, u);
};
export const grant = (t, u, item, r = req('g')) => send(t, u, { op: 'grant', item, req: r });
export const apply = (t, u, slot, item, color, r = req('a')) => send(t, u, { op: 'apply', slot, item, color, req: r });
export const clear = (t, u, slot, r = req('c')) => send(t, u, { op: 'clear', slot, req: r });

/** Покер: ALICE — хост, все сели; игра НЕ начата. */
export async function seatPoker(t, cast = { ALICE, BOB, CAROL }) {
  await t.seat(cast);
  return t.room;
}
/** Дурак: ALICE — хост, остальные сели; партия не начата. */
export async function seatDurak(t, cast = [ALICE, BOB, CAROL]) {
  for (const u of cast) await t.start(u);
  await t.cmd(cast[0], '/play');
  t.openHub(cast[0]);
  await t.send(cast[0], { t: 'create', game: 'durak', settings: {} });
  const room = t.durak;
  for (const u of cast.slice(1)) {
    t.openRoom(u, room);
    await t.send(u, { t: 'sit' });
  }
  return room;
}
/** Доиграть раздачу покера до конца (колл/чек) и сдать следующую. */
export async function nextPokerHand(t, cast = { ALICE, BOB, CAROL }) {
  await t.runToShowdown(cast);
  await t.send(ALICE, { t: 'next' });
}
