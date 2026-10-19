'use strict';
/**
 * Аудит: покер — раздача, в которой остался один живой игрок, НЕ вложивший
 * в банк ни фишки. Найдено фаззером (tools/fuzz-games.mjs, зерно 2269).
 *
 * Трое за столом, префлоп. Большой блайнд выходит из группы (его карты
 * сброшены), малый блайнд жмёт «Встать» — живым остаётся баттон, который ещё
 * не ходил. Весь банк (блайнды) — «мёртвые» фишки: их положили сбросившие.
 * Движок ставок (`server/game.js`, его не трогаем) не считает претендентом
 * того, кто не вложил ничего, — и раздача закрывалась с ошибкой, оставаясь в
 * фазе «вскрытие» навсегда: стол вставал, ходить было некому.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';

const leaveGroup = (t, u) => t.raw({ message: { message_id: t.tg.nextId++, chat: { id: t.chatId, type: 'supergroup' }, from: u, left_chat_member: u, date: 1 } });

for (const how of ['встал', 'вышел из группы', 'удалён хостом']) {
  test(`АУДИТ D-05: покер — блайнды ушли до хода баттона (малый ${how}): банк баттону, стол не встаёт`, async () => {
    const cast = { a: user(101, 'А'), b: user(102, 'Б'), c: user(103, 'В') };
    const t = new Table();
    await t.begin(cast, { blinds: [1, 2], stack: 1000 });
    const h = t.room.hand;
    const byId = (id) => Object.values(cast).find((u) => String(u.id) === String(id));
    const sb = byId(h.sbId);
    const bb = byId(h.bbId);
    const btn = byId(h.dealerId);
    assert.equal(h.actorId, String(btn.id), 'втроём первым на префлопе ходит баттон');
    const host = cast.a;
    const total = t.room.players.reduce((s, p) => s + p.stack + p.committed, 0);

    await leaveGroup(t, bb); // большой блайнд ушёл — его карты сброшены
    if (how === 'встал') await t.send(sb, { t: 'leave' });
    else if (how === 'вышел из группы') await leaveGroup(t, sb);
    else if (sb !== host) await t.send(host, { t: 'kick', seat: t.room.players.findIndex((p) => p.id === String(sb.id)) });
    else await t.send(sb, { t: 'leave' });

    assert.deepEqual(t.errors.map(String), [], 'без ошибок в логе');
    const room = t.room;
    assert.equal(room.hand.phase, 'complete', 'раздача закрыта, а не застряла во «вскрытии»');
    const btnRow = room.players.find((p) => p.id === String(btn.id));
    assert.equal(btnRow.stack, 1000 + 1 + 2, 'баттон забрал блайнды');
    assert.equal(room.players.reduce((s, p) => s + p.stack, 0), total, 'фишки сошлись');
  });
}

test('АУДИТ D-05: покер — блайнды ушли, ход одного из оставшихся истёк по таймеру: банк оставшемуся, стол не встаёт', async () => {
  // Зерно 1775 фаззера: блайнды выбыли (вышел и удалён), у двоих оставшихся в
  // банке ноль; один молчит — таймер сбрасывает его карты, и движок уходит во
  // «вскрытие» с банком без претендента.
  const cast = { a: user(101, 'А'), b: user(102, 'Б'), c: user(103, 'В'), d: user(104, 'Г') };
  const t = new Table();
  await t.seat(cast, { blinds: [1, 2], stack: 1000 });
  await t.send(cast.a, { t: 'settings', turnSeconds: 15 });
  await t.send(cast.a, { t: 'start' });
  const h = t.room.hand;
  const byId = (id) => Object.values(cast).find((u) => String(u.id) === String(id));
  const total = t.room.players.reduce((s, p) => s + p.stack + p.committed, 0);
  for (const id of [h.sbId, h.bbId]) await leaveGroup(t, byId(id));
  const live = t.room.players.filter((p) => p.inHand && !p.folded);
  assert.equal(live.length, 2, 'в раздаче двое, оба без фишек в банке');
  await t.advance(16_000); // ход первого из них истёк
  assert.deepEqual(t.errors.map(String), [], 'без ошибок в логе');
  assert.equal(t.room.hand.phase, 'complete', 'раздача закрыта');
  const winner = t.room.players.find((p) => p.inHand && !p.folded);
  assert.equal(winner.stack, 1000 + 1 + 2, 'блайнды — оставшемуся');
  assert.equal(t.room.players.reduce((s, p) => s + p.stack, 0), total, 'фишки сошлись');
  const other = Object.values(cast).find((u) => String(u.id) !== winner.id);
  assert.equal(t.state(other).players.find((p) => p.name === winner.name).cards, null, 'карты победителя без вскрытия не показываются');
});
