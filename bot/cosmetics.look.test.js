/** «Вид» косметики (miniapp/cosmetics/look.js): только свой телефон, только вещи каталога. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as look from '../miniapp/cosmetics/look.js';

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}
function fresh(storage) {
  look._reset();
  if (storage === 'broken') {
    globalThis.localStorage = { getItem() { throw new Error('нет'); }, setItem() { throw new Error('нет'); } };
  } else globalThis.localStorage = storage ?? fakeStorage();
}

test('неизвестная вещь и вещь не в свою ячейку игнорируются', () => {
  fresh();
  look.setLook({ cardback: 'nc-xxx', felt: 'nc-back-1', frame: '<script>', title: 5, bogus: 'nc-back-1' });
  assert.deepEqual(look.getLook(), { cardback: null, felt: null, frame: null, effect: null, title: null, reactions: [] });
  look.setLook({ cardback: 'nc-back-2', felt: 'nc-felt-1' });
  assert.equal(look.getLook().cardback, 'nc-back-2');
  assert.equal(look.getLook().felt, 'nc-felt-1');
});

test('clearLook снимает всё, onLook зовётся и отписывается', () => {
  fresh();
  let n = 0;
  const off = look.onLook(() => n++);
  look.setLook({ frame: 'nc-frame-1' });
  look.setLook({ frame: 'nc-frame-1' }); // то же самое — не событие
  assert.equal(n, 1);
  look.clearLook();
  assert.equal(n, 2);
  assert.equal(look.getLook().frame, null);
  off();
  look.setLook({ title: 'nc-title-1' });
  assert.equal(n, 2);
});

test('без localStorage не падает и держит вид до перезагрузки', () => {
  fresh('broken');
  assert.doesNotThrow(() => look.setLook({ effect: 'nc-fx-win' }));
  assert.equal(look.getLook().effect, 'nc-fx-win');
  assert.doesNotThrow(() => look.clearLook());
});

test('вид переживает перезагрузку; мусор в хранилище отбрасывается', () => {
  const st = fakeStorage();
  fresh(st);
  look.setLook({ cardback: 'nc-back-1' });
  look._reset();
  assert.equal(look.getLook().cardback, 'nc-back-1');
  st.m.set('cosmetics-look', JSON.stringify({ cardback: 'evil', felt: 'nc-back-1', reactions: ['nc-felt-1', 'nc-react-1'] }));
  look._reset();
  assert.deepEqual(look.getLook(), { cardback: null, felt: null, frame: null, effect: null, title: null, reactions: ['nc-react-1'] });
  st.m.set('cosmetics-look', '{не json');
  look._reset();
  assert.equal(look.getLook().cardback, null);
});

test('набор раскладывается по ячейкам: первая рубашка и рамка, реакции отдельно', () => {
  fresh();
  look.setLook({ bundle: 'nc-bundle' });
  const l = look.getLook();
  assert.equal(l.cardback, 'nc-back-1');
  assert.equal(l.frame, 'nc-frame-1');
  assert.equal(l.felt, 'nc-felt-1');
  assert.equal(l.effect, 'nc-fx-win');
  assert.equal(l.title, 'nc-title-1');
  assert.deepEqual(l.reactions, ['nc-react-1', 'nc-react-2', 'nc-react-3']);
});

test('previewFor возвращает прежний вид по таймеру и не пишет примерку в хранилище', async () => {
  const st = fakeStorage();
  fresh(st);
  look.setLook({ cardback: 'nc-back-1' });
  const stop = look.previewFor('nc-back-2', 30);
  assert.equal(look.getLook().cardback, 'nc-back-2');
  assert.equal(JSON.parse(st.m.get('cosmetics-look')).cardback, 'nc-back-1');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(look.getLook().cardback, 'nc-back-1');
  look.previewFor('nc-frame-1', 5000);
  stop();
  assert.equal(look.getLook().frame, null);
});

test('lookClass называет включённые ячейки', () => {
  fresh();
  assert.equal(look.lookClass(), '');
  look.setLook({ felt: 'nc-felt-1', title: 'nc-title-1' });
  assert.equal(look.lookClass(), 'look-felt look-title');
});
