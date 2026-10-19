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
